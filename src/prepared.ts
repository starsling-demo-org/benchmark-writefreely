import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { computeSha256 } from './config.ts'
import { prepareReplayVariants } from './generator.ts'
import { git } from './git.ts'
import { type HistoryTag, listTagsAtOrBefore, mirrorTagsEnabled } from './history-tags.ts'
import { constructReplayAncestry, computeDirectoryHash, parsePatchTouchedPaths } from './patcher.ts'
import type { BenchmarkConfig, LockedPatchRecord, ScenarioInventory, VariantId, VariantTreeLock } from './types.ts'
import { VARIANTS } from './manifest.ts'

export interface PreparedVariant {
  lock: VariantTreeLock
  treeDir: string
  gitDir: string
  baseSha: string
  headSha: string
  mergeSha: string
  inventory: ScenarioInventory
  workflowFiles: string[]
  /** Upstream commit the replay base descends from (upstream-history replays). */
  historyBaseSha?: string
  /** Upstream tags (at or before the pin) pushed with the history; part of the prepared identity. */
  historyTags?: HistoryTag[]
}
export interface PreparedExperiment {
  schemaVersion: 1
  harnessHash: string
  configHash: string
  inputFingerprint: string
  patchIdentities: Omit<LockedPatchRecord, 'patchContent'>[]
  variants: Record<string, Record<VariantId, PreparedVariant>>
}
/** One identity recipe is shared by preparation and verification; local paths are relocatable. */
function preparedFingerprint(prepared: Omit<PreparedExperiment, 'inputFingerprint'>): string {
  const payload = Object.fromEntries(
    Object.entries(prepared.variants).map(([name, map]) => [
      name,
      Object.fromEntries(
        Object.entries(map).map(([variant, { treeDir: _treeDir, gitDir: _gitDir, ...identity }]) => [
          variant,
          identity,
        ]),
      ),
    ]),
  )
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      )
    return value
  }
  return computeSha256(
    JSON.stringify(
      canonical({
        schemaVersion: prepared.schemaVersion,
        configHash: prepared.configHash,
        harnessHash: prepared.harnessHash,
        patches: prepared.patchIdentities,
        payload,
      }),
    ),
  )
}
/** Content hash of the harness source; any change requires a fresh preparation. */
export function currentHarnessHash(): string {
  return computeDirectoryHash(new URL('.', import.meta.url).pathname)
}
export function materializeCommit(source: string, sha: string, destination: string): void {
  if (!/^[a-f0-9]{40}$/i.test(sha) || git(source, ['rev-parse', `${sha}^{commit}`]) !== sha)
    throw new Error(`Invalid commit: ${sha}`)
  const entries = git(source, ['ls-tree', '-r', sha])
  if (/^160000 /m.test(entries)) throw new Error('Submodules require a resolved gitlink adapter')
  // Archive attributes can silently omit or rewrite committed inputs, including nested attributes.
  for (const path of git(source, ['ls-tree', '-r', '--name-only', '-z', sha]).split('\0')) {
    if (path === '.gitattributes' || path.endsWith('/.gitattributes')) {
      const attributes = git(source, ['show', `${sha}:${path}`])
      if (/\bexport-(?:ignore|subst)\b/.test(attributes))
        throw new Error(`Archive export attributes require an exact-tree adapter: ${path}`)
      if (/filter\s*=\s*lfs/.test(attributes)) throw new Error('Git LFS requires a resolved object adapter')
    }
  }
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  const archiveDir = mkdtempSync(join(tmpdir(), 'bench-source-'))
  try {
    const archive = join(archiveDir, 'source.tar')
    git(source, ['archive', '--format=tar', `--output=${archive}`, sha])
    execFileSync('tar', ['-xf', archive, '-C', destination], { stdio: 'pipe' })
  } finally {
    rmSync(archiveDir, { recursive: true, force: true })
  }
  if (
    existsSync(join(destination, '.gitattributes')) &&
    /filter=lfs/.test(readFileSync(join(destination, '.gitattributes'), 'utf8'))
  )
    throw new Error('Git LFS requires a resolved object adapter')
  rmSync(join(destination, '.git'), { recursive: true, force: true })
}
/**
 * Every path tracked in the upstream commit must exist in the staged replay commit, unless a patch touches it.
 * Catches files dropped silently by staging (ignore rules, attributes) before anything is published.
 */
export function assertStagedTreeMatchesUpstream(params: {
  source: string
  upstreamSha: string
  replayGitDir: string
  replayCommit: string
  patches: Pick<LockedPatchRecord, 'patchContent'>[]
}): void {
  const names = (dir: string, rev: string) =>
    git(dir, ['ls-tree', '-r', '--name-only', '-z', rev]).split('\0').filter(Boolean)
  const staged = new Set(names(params.replayGitDir, params.replayCommit))
  const patched = new Set(params.patches.flatMap((p) => parsePatchTouchedPaths(p.patchContent)))
  const missing = names(params.source, params.upstreamSha).filter((path) => !staged.has(path) && !patched.has(path))
  if (missing.length)
    throw new Error(
      `Staged tree for ${params.upstreamSha} is missing ${missing.length} tracked upstream path(s) no patch touches: ${missing.slice(0, 10).join(', ')}`,
    )
}
export function prepareExperiment(params: {
  source: string
  workDir: string
  config: BenchmarkConfig
  patches: LockedPatchRecord[]
}): PreparedExperiment {
  const { source, workDir, config, patches } = params
  const rel = relative(resolve(source), resolve(workDir))
  if (!rel || (!rel.startsWith('..') && !rel.startsWith('/')))
    throw new Error('Work directory must be outside the upstream checkout')
  if (git(source, ['rev-parse', 'HEAD']) !== config.upstream.commitSha)
    throw new Error('Upstream checkout does not match pinned SHA')
  if (git(source, ['status', '--porcelain', '--untracked-files=all']))
    throw new Error('Upstream checkout must be clean, including untracked files')
  if (existsSync(join(workDir, 'prepared.json')))
    throw new Error('Prepared directory already exists; use a new directory to preserve experiment provenance')
  mkdirSync(workDir, { recursive: true })
  const resolvedConfig = {
    ...config,
    patches: config.patches.map((patch) => ({
      ...patch,
      resolvedRevision: patches.find((p) => p.id === patch.id)?.resolvedRevision ?? patch.resolvedRevision ?? '',
    })),
  }
  let history: string | undefined
  let historyTags: HistoryTag[] | undefined
  const mirrorTags = mirrorTagsEnabled(config)
  if (config.benchmarkRepository.replayHistory === 'upstream') {
    if (git(source, ['rev-parse', '--is-shallow-repository']) !== 'false')
      throw new Error('Upstream-history replay needs a full clone of the upstream repository (git fetch --unshallow)')
    history = join(git(source, ['rev-parse', '--absolute-git-dir']), 'objects')
    if (mirrorTags) historyTags = listTagsAtOrBefore(source, config.upstream.commitSha)
  }
  const variants: PreparedExperiment['variants'] = {}
  for (const [name, scenario] of Object.entries(config.scenarios)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid scenario name: ${name}`)
    const base = scenario.pr?.baseSha ?? scenario.main?.beforeSha
    const head = scenario.pr?.headSha ?? scenario.main?.afterSha
    if (!base || !head || base === head)
      throw new Error(`Scenario ${name} requires distinct locked base and head commits`)
    const root = join(workDir, name)
    mkdirSync(root, { recursive: true })
    const baseSource = join(root, 'base-source')
    const headSource = join(root, 'head-source')
    materializeCommit(source, base, baseSource)
    materializeCommit(source, head, headSource)
    const baseBundle = prepareReplayVariants({
      upstreamSourceDir: baseSource,
      workRootDir: join(root, 'base'),
      config: resolvedConfig,
      patches,
    })
    const headBundle = prepareReplayVariants({
      upstreamSourceDir: headSource,
      workRootDir: join(root, 'head'),
      config: resolvedConfig,
      patches,
    })
    const map = {} as Record<VariantId, PreparedVariant>
    for (const variant of VARIANTS) {
      const b = baseBundle.variants[variant]
      const h = headBundle.variants[variant]
      const gitDir = join(root, 'git', variant)
      const ancestry = constructReplayAncestry({
        baseTreeDir: b.treeDir,
        headTreeDir: h.treeDir,
        replayGitDir: gitDir,
        scenario,
        patches: [],
        applyPatches: false,
        ...(history ? { upstreamHistory: { objectsDir: history, parentSha: base } } : {}),
      })
      if (ancestry.blockers.length) throw new Error(ancestry.blockers.map((x) => x.evidence).join('; '))
      assertStagedTreeMatchesUpstream({
        source,
        upstreamSha: base,
        replayGitDir: gitDir,
        replayCommit: ancestry.commitMap.replayBaseSha,
        patches,
      })
      assertStagedTreeMatchesUpstream({
        source,
        upstreamSha: head,
        replayGitDir: gitDir,
        replayCommit: ancestry.commitMap.replayHeadSha,
        patches,
      })
      const inventory = h.inventory.scenarios[name]
      if (!inventory) throw new Error(`Missing inventory: ${name}`)
      map[variant] = {
        lock: h.lock,
        treeDir: h.treeDir,
        gitDir,
        baseSha: ancestry.commitMap.replayBaseSha,
        headSha: ancestry.commitMap.replayHeadSha,
        mergeSha: ancestry.commitMap.replayMergeSha,
        inventory,
        workflowFiles: Object.keys(h.inventory.workflows),
        ...(history ? { historyBaseSha: base } : {}),
        ...(historyTags ? { historyTags } : {}),
      }
    }
    variants[name] = map
  }
  const configHash = computeSha256(JSON.stringify(config))
  const harnessHash = currentHarnessHash()
  const identity = {
    schemaVersion: 1 as const,
    harnessHash,
    configHash,
    patchIdentities: patches.map(({ patchContent: _content, ...patch }) => patch),
    variants,
  }
  const prepared: PreparedExperiment = { ...identity, inputFingerprint: preparedFingerprint(identity) }
  writeFileSync(join(workDir, 'prepared.json'), `${JSON.stringify(prepared, null, 2)}\n`)
  return prepared
}
export function verifyPrepared(
  prepared: PreparedExperiment,
  config: BenchmarkConfig,
  /** `recovery` accepts older harnesses; `metadataOnly` skips re-hashing payload trees the caller never reads. */
  options: { recovery?: boolean; metadataOnly?: boolean } = {},
): void {
  if (prepared.schemaVersion !== 1 || prepared.configHash !== computeSha256(JSON.stringify(config)))
    throw new Error('Prepared configuration fingerprint mismatch; prepare again')
  // Old pilot journals remain recoverable, but cannot start new samples without re-preparation.
  if (!prepared.patchIdentities) {
    if (!options.recovery) throw new Error('Prepared identity is obsolete; prepare again')
  } else if (prepared.inputFingerprint !== preparedFingerprint(prepared)) {
    throw new Error('Prepared metadata fingerprint mismatch; prepare again')
  }
  const scenarioNames = Object.keys(config.scenarios).sort()
  if (JSON.stringify(Object.keys(prepared.variants).sort()) !== JSON.stringify(scenarioNames))
    throw new Error('Prepared scenarios differ from configuration')
  for (const map of Object.values(prepared.variants)) {
    if (JSON.stringify(Object.keys(map).sort()) !== JSON.stringify([...VARIANTS].sort()))
      throw new Error('Prepared variant set is incomplete')
  }
  if (!options.recovery && prepared.harnessHash !== currentHarnessHash())
    throw new Error('Harness changed; prepare again')
  if (options.metadataOnly) return
  for (const map of Object.values(prepared.variants))
    for (const v of Object.values(map)) {
      if (computeDirectoryHash(v.treeDir) !== v.lock.sourceTreeHash)
        throw new Error(`Prepared payload changed: ${v.treeDir}`)
      git(v.gitDir, [`--work-tree=${v.treeDir}`, 'diff', '--exit-code', v.headSha, '--', '.'])
      for (const sha of [v.baseSha, v.headSha, v.mergeSha])
        if (!/^[a-f0-9]{40}$/.test(sha) || git(v.gitDir, ['rev-parse', `${sha}^{commit}`]) !== sha)
          throw new Error('Missing replay commit')
    }
}
