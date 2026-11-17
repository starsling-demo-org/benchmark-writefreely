import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LockedPatchRecord, MergedPrLock, PatchSpec } from './types.ts'

const HEX_40_RE = /^[0-9a-f]{40}$/i

const sha256Of = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

export interface PatchResolver {
  resolveRemotePatch?: (spec: PatchSpec) => Promise<{
    content: string
    resolvedRevision: string
    immutableOrigin: string
    mergedPr?: MergedPrLock
  }>
  /** True when `ancestor` is `descendant` or reachable from it. Used to check merged-PR stack order. */
  isAncestor?: (repository: string, ancestor: string, descendant: string) => Promise<boolean>
}

/**
 * The first `inBaseline` patch that follows a patch that is not in the baseline, or undefined when the order is
 * valid (every baseline patch before every other patch).
 */
export function misorderedBaselinePatch<T extends { id: string; inBaseline?: boolean | undefined }>(
  patches: T[],
): { id: string; after: string } | undefined {
  let firstOther: string | undefined
  for (const patch of patches) {
    if (!patch.inBaseline) firstOther ??= patch.id
    else if (firstOther !== undefined) return { id: patch.id, after: firstOther }
  }
  return undefined
}

export function baselineOrderMessage(bad: { id: string; after: string }): string {
  return `Patch "${bad.id}" is inBaseline but comes after "${bad.after}", which is not; list every inBaseline patch before the other patches`
}

export async function resolvePatchStack(
  patches: PatchSpec[],
  baseDir: string,
  resolver?: PatchResolver,
): Promise<LockedPatchRecord[]> {
  const locked: LockedPatchRecord[] = []
  const misordered = misorderedBaselinePatch(patches)
  if (misordered) throw new Error(baselineOrderMessage(misordered))

  for (const spec of patches) {
    if (spec.source === 'local') {
      const absPath = resolve(baseDir, spec.pathOrUrl)
      if (!existsSync(absPath)) {
        throw new Error(`Local patch "${spec.id}" not found at "${absPath}"`)
      }
      const rawBytes = readFileSync(absPath)
      const content = rawBytes.toString('utf8')
      const sha256 = sha256Of(rawBytes)
      if (spec.sha256 && spec.sha256 !== sha256) {
        throw new Error(`Patch "${spec.id}" SHA-256 mismatch: expected ${spec.sha256}, got ${sha256}`)
      }
      locked.push({
        id: spec.id,
        source: spec.source,
        originalPathOrUrl: spec.pathOrUrl,
        immutableOrigin: `file://${spec.pathOrUrl}#sha256=${sha256}`,
        resolvedRevision: spec.resolvedRevision ?? sha256,
        sha256,
        byteLength: rawBytes.byteLength,
        patchContent: content,
        ...(spec.inBaseline ? { inBaseline: true as const } : {}),
      })
    } else {
      if (!resolver?.resolveRemotePatch) {
        throw new Error(
          `Remote patch "${spec.id}" (${spec.pathOrUrl}) cannot be resolved without a PatchResolver or local lock.`,
        )
      }
      const resolved = await resolver.resolveRemotePatch(spec)
      const rawBytes = Buffer.from(resolved.content, 'utf8')
      const sha256 = sha256Of(rawBytes)
      if (spec.sha256 && spec.sha256 !== sha256) {
        throw new Error(`Remote patch "${spec.id}" SHA-256 mismatch: expected ${spec.sha256}, got ${sha256}`)
      }
      if (!HEX_40_RE.test(resolved.resolvedRevision)) {
        throw new Error(
          `Remote patch "${spec.id}" resolvedRevision "${resolved.resolvedRevision}" is not an immutable 40-char SHA`,
        )
      }
      locked.push({
        id: spec.id,
        source: spec.source,
        originalPathOrUrl: spec.pathOrUrl,
        immutableOrigin: resolved.immutableOrigin,
        resolvedRevision: resolved.resolvedRevision,
        sha256,
        byteLength: rawBytes.byteLength,
        patchContent: resolved.content,
        ...(resolved.mergedPr ? { mergedPr: resolved.mergedPr } : {}),
        ...(spec.inBaseline ? { inBaseline: true as const } : {}),
      })
    }
  }

  // Patch N must apply on top of 1..N-1. `git apply --check` enforces that when applying; for merged PRs the
  // lock also proves it from history: each PR's merge must sit on top of the previous merged PR's merge.
  let previous: MergedPrLock | undefined
  for (const record of locked) {
    const current = record.mergedPr
    if (!current) continue
    if (previous) {
      if (previous.repository !== current.repository)
        throw new Error(`Patch stack order: "${record.id}" is from another repository than the previous merged PR`)
      if (!resolver?.isAncestor)
        throw new Error('Patch stack order cannot be checked: the resolver cannot compare commits')
      if (!(await resolver.isAncestor(current.repository, previous.mergeCommitSha, current.firstParentSha)))
        throw new Error(
          `Patch stack order: PR #${current.number} ("${record.id}") did not land on top of PR #${previous.number}; list merged PRs in the order they merged`,
        )
    }
    previous = current
  }

  return locked
}
