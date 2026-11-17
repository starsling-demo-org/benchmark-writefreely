/**
 * Publish the showcase to the benchmark repository's default branch.
 *
 * At rest, the default branch holds only the showcase: README, patch stack and machine-readable results.
 * Replays temporarily replace it and restore it afterwards. Publishing takes the same repository lease
 * as the replay controller, so it can never race an experiment, and pushes with an expected-value guard.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitHubClient } from './github.ts'
import { COMMIT_TREE, git } from './git.ts'
import { NativeReplayBackend } from './native-backend.ts'
import type { PreparedVariant } from './prepared.ts'

/** A file in the showcase tree, or a submodule pinned to a commit (`gitlink`, with its `.gitmodules` entry). */
export type ShowcaseFile = { path: string; content: string | Buffer } | { path: string; gitlink: string }

export interface PublishResult {
  ref: string
  previousSha: string | null
  commitSha: string
  unchanged: boolean
  files: string[]
}

export async function publishShowcase(params: {
  client: GitHubClient
  defaultBranch: string
  files: ShowcaseFile[]
  message: string
  /** Directory for the publish journal and object store; a crash is resumed by publishing again. */
  stateDir: string
  owner: string
  /** Merged-PR patch base/head branches; publishing to one of them is refused. */
  protectedBranches?: readonly string[]
}): Promise<PublishResult> {
  const { client, stateDir } = params
  for (const file of params.files)
    if (!/^[\w./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..'))
      throw new Error(`Invalid showcase path: ${file.path}`)
  if (params.files.some((f) => f.path.startsWith('.github/')))
    throw new Error('The showcase tree must not contain workflows')
  const gitDir = join(stateDir, 'publish.git')
  if (!existsSync(gitDir)) {
    mkdirSync(stateDir, { recursive: true })
    git(stateDir, ['init', '--quiet', '--bare', gitDir])
  }
  // The backend supplies the lease and guarded ref update; publishing installs no replay payload.
  const payload = { gitDir } as PreparedVariant
  const backend = new NativeReplayBackend(
    client,
    payload,
    join(stateDir, 'publish.journal.json'),
    params.owner,
    false,
    params.protectedBranches,
  )
  await backend.acquireLease()
  const ref = `refs/heads/${params.defaultBranch}`
  const refs = await backend.getCurrentRefs()
  const previousSha = refs[ref] ?? null
  const temporary = mkdtempSync(join(tmpdir(), 'bench-publish-'))
  try {
    const indexFile = join(temporary, 'index')
    git(gitDir, ['read-tree', '--empty'], { indexFile })
    for (const file of [...params.files].sort((a, b) => a.path.localeCompare(b.path))) {
      if ('gitlink' in file) {
        if (!/^[0-9a-f]{40}$/.test(file.gitlink)) throw new Error(`Invalid submodule commit for ${file.path}`)
        git(gitDir, ['update-index', '--add', '--cacheinfo', '160000', file.gitlink, file.path], { indexFile })
        continue
      }
      const blob = git(gitDir, ['hash-object', '-w', '--stdin'], { input: file.content })
      git(gitDir, ['update-index', '--add', '--cacheinfo', '100644', blob, file.path], { indexFile })
    }
    const tree = git(gitDir, ['write-tree'], { indexFile })
    if (previousSha) {
      try {
        git(gitDir, ['cat-file', '-e', `${previousSha}^{commit}`])
      } catch {
        git(gitDir, ['fetch', '--quiet', '--no-tags', backend.remoteUrl(), previousSha])
      }
      if (git(gitDir, ['rev-parse', `${previousSha}^{tree}`]) === tree) {
        await backend.releaseLease()
        return { ref, previousSha, commitSha: previousSha, unchanged: true, files: params.files.map((f) => f.path) }
      }
    }
    const commitSha = git(gitDir, [
      ...COMMIT_TREE,
      tree,
      ...(previousSha ? ['-p', previousSha] : []),
      '-m',
      `[skip ci] ${params.message}`,
    ])
    await backend.updateRef(ref, commitSha)
    await backend.releaseLease()
    return { ref, previousSha, commitSha, unchanged: false, files: params.files.map((f) => f.path) }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Remove publish state after a successful publish so the next one starts a fresh journal. */
export function clearPublishState(stateDir: string): void {
  rmSync(join(stateDir, 'publish.git'), { recursive: true, force: true })
  rmSync(join(stateDir, 'publish.journal.json'), { force: true })
}
