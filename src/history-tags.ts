import { execFileSync } from 'node:child_process'
import type { BenchmarkConfig } from './types.ts'
import { git } from './git.ts'

/** One upstream tag: its ref name and the id of the object the ref points at (a tag object when annotated). */
export interface HistoryTag {
  name: string
  objectSha: string
}

/** `mirrorTags` defaults to true for upstream-history replays and is meaningless otherwise. */
export function mirrorTagsEnabled(config: BenchmarkConfig): boolean {
  const { replayHistory, mirrorTags } = config.benchmarkRepository
  if (mirrorTags && replayHistory !== 'upstream')
    throw new Error('benchmarkRepository.mirrorTags needs replayHistory: "upstream"')
  return replayHistory === 'upstream' && mirrorTags !== false
}

function isAncestor(source: string, commit: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, descendant], { cwd: source, stdio: 'pipe' })
    return true
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false
    throw error
  }
}

/**
 * Upstream tags whose target commit is the pin or one of its ancestors, sorted by name. Later tags, tags on
 * other branches, and tags that do not peel to a commit are left out.
 */
export function listTagsAtOrBefore(source: string, pinSha: string): HistoryTag[] {
  const out = git(source, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/tags'])
  const tags: HistoryTag[] = []
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref = '', objectSha = ''] = line.split('\t')
    let commit: string
    try {
      commit = git(source, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    } catch {
      continue
    }
    if (isAncestor(source, commit, pinSha)) tags.push({ name: ref.slice('refs/tags/'.length), objectSha })
  }
  return tags.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Push the tags to `remoteUrl` as refs/tags/<name>, keeping annotated tags annotated. Existing identical tags are
 * skipped (re-runs are no-ops); an existing tag with a different target throws before anything is pushed. One push
 * carries them all: GitHub starts no workflow for tag pushes of more than three tags.
 */
export function mirrorTagsToRemote(params: { gitDir: string; remoteUrl: string; tags: HistoryTag[] }): void {
  const { gitDir, remoteUrl, tags } = params
  if (!tags.length) return
  const remote = new Map<string, string>()
  for (const line of git(gitDir, ['ls-remote', '--tags', remoteUrl]).split('\n').filter(Boolean)) {
    const [sha = '', ref = ''] = line.split(/\s+/)
    if (!ref.endsWith('^{}')) remote.set(ref, sha)
  }
  const missing: HistoryTag[] = []
  for (const tag of tags) {
    const actual = remote.get(`refs/tags/${tag.name}`)
    if (actual === undefined) missing.push(tag)
    else if (actual !== tag.objectSha)
      throw new Error(`Tag ${tag.name} already exists in the benchmark repository with a different target (${actual})`)
  }
  if (!missing.length) return
  git(gitDir, [
    'push',
    '--quiet',
    ...missing.map((t) => `--force-with-lease=refs/tags/${t.name}:`),
    remoteUrl,
    ...missing.map((t) => `${t.objectSha}:refs/tags/${t.name}`),
  ])
}
