import { execFileSync } from 'node:child_process'
import type { PatchResolver } from './config.ts'
import type { PatchSpec } from './types.ts'

const gh = (endpoint: string, accept?: string): string =>
  execFileSync('gh', ['api', endpoint, ...(accept ? ['-H', `Accept: ${accept}`] : [])], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const ghJson = <T>(endpoint: string): T => JSON.parse(gh(endpoint)) as T

/**
 * A patch from a MERGED pull request in the benchmark repository. The content is what landed: the merge
 * commit's diff against its first parent (merge, squash, or a rebase of one commit). A multi-commit rebase
 * merge leaves one commit per PR commit and no marker, so it cannot be told from a squash and is refused
 * unless the landed diff provably equals the reviewed base...head diff.
 */
function resolveMergedPr(spec: PatchSpec, owner: string, repo: string, number: string) {
  const repoPath = `repos/${owner}/${repo}`
  const pr = ghJson<{
    merged?: boolean
    state?: string
    merge_commit_sha?: string | null
    commits?: number
    base: { ref: string; sha: string }
    head: { ref: string; sha: string }
  }>(`${repoPath}/pulls/${number}`)
  if (!pr.merged || !pr.merge_commit_sha)
    throw new Error(`Patch "${spec.id}": PR #${number} is not merged (state: ${pr.state ?? 'unknown'})`)
  if (!spec.baseBranch) throw new Error(`Patch "${spec.id}": merged-pr patches must declare baseBranch`)
  if (spec.baseBranch !== pr.base.ref)
    throw new Error(
      `Patch "${spec.id}": declared base branch "${spec.baseBranch}" is not PR #${number}'s base "${pr.base.ref}"`,
    )
  if (spec.headBranch && spec.headBranch !== pr.head.ref)
    throw new Error(
      `Patch "${spec.id}": declared head branch "${spec.headBranch}" is not PR #${number}'s head "${pr.head.ref}"`,
    )
  const mergeSha = pr.merge_commit_sha
  if (spec.resolvedRevision && spec.resolvedRevision !== mergeSha)
    throw new Error(`Patch "${spec.id}": merge commit moved since the configured revision`)
  const commit = ghJson<{ parents: { sha: string }[] }>(`${repoPath}/commits/${mergeSha}`)
  const firstParent = commit.parents[0]?.sha
  if (!firstParent) throw new Error(`Patch "${spec.id}": merge commit ${mergeSha} has no parent`)
  const landed = gh(`${repoPath}/commits/${mergeSha}`, 'application/vnd.github.diff')
  const baseUnmoved = firstParent === pr.base.sha
  if (baseUnmoved) {
    const reviewed = gh(`${repoPath}/compare/${pr.base.sha}...${pr.head.sha}`, 'application/vnd.github.diff')
    if (reviewed !== landed)
      throw new Error(
        `Patch "${spec.id}": what landed in ${mergeSha} differs from the reviewed base...head diff of PR #${number}`,
      )
  } else if ((pr.commits ?? 1) > 1 && commit.parents.length === 1) {
    throw new Error(
      `Patch "${spec.id}": PR #${number} has ${pr.commits} commits and a single-parent merge commit on a moved base; a squash cannot be told from a multi-commit rebase merge, so it is refused`,
    )
  }
  // Content is the commit's own mbox patch; GitHub renders a merge commit against its first parent.
  const content = gh(`${repoPath}/commits/${mergeSha}`, 'application/vnd.github.patch')
  return {
    content,
    resolvedRevision: mergeSha,
    immutableOrigin: `https://github.com/${owner}/${repo}/commit/${mergeSha}.patch`,
    mergedPr: {
      repository: `${owner}/${repo}`,
      number: Number(number),
      mergeCommitSha: mergeSha,
      firstParentSha: firstParent,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
    },
  }
}

/** Resolve GitHub patch URLs once; lock the exact returned bytes before preparation. */
export const githubPatchResolver: PatchResolver = {
  async isAncestor(repository: string, ancestor: string, descendant: string) {
    const { status } = ghJson<{ status: string }>(`repos/${repository}/compare/${ancestor}...${descendant}`)
    return status === 'ahead' || status === 'identical'
  },
  async resolveRemotePatch(spec: PatchSpec) {
    const url = new URL(spec.pathOrUrl)
    if (url.hostname !== 'github.com' || url.protocol !== 'https:')
      throw new Error('Remote patches must use HTTPS github.com URLs')
    if (spec.source === 'merged-pr') {
      const [owner, repo, kind, number] = url.pathname.split('/').filter(Boolean)
      if (!owner || !repo || kind !== 'pull' || !number || !/^\d+$/.test(number))
        throw new Error(`Patch "${spec.id}": merged-pr needs a https://github.com/OWNER/REPO/pull/N URL`)
      return resolveMergedPr(spec, owner, repo, number)
    }
    const parts = url.pathname
      .replace(/\.(patch|diff)$/, '')
      .split('/')
      .filter(Boolean)
    const [owner, repo, kind, revision] = parts
    if (!owner || !repo || !revision || !['pull', 'commit'].includes(kind ?? ''))
      throw new Error('Expected a GitHub pull or commit patch URL')
    const endpoint = `repos/${owner}/${repo}/${kind === 'pull' ? 'pulls' : 'commits'}/${revision}`
    const metadata = JSON.parse(
      execFileSync('gh', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    ) as { sha?: string; head?: { sha: string }; base?: { sha: string } }
    const resolvedRevision = metadata.head?.sha ?? metadata.sha
    if (!resolvedRevision || !/^[a-f0-9]{40}$/.test(resolvedRevision))
      throw new Error('Patch revision did not resolve to a full SHA')
    if (spec.resolvedRevision && spec.resolvedRevision !== resolvedRevision)
      throw new Error('Remote patch moved since the configured revision')
    const patchEndpoint =
      kind === 'pull' && metadata.base
        ? `repos/${owner}/${repo}/compare/${metadata.base.sha}...${resolvedRevision}`
        : `repos/${owner}/${repo}/commits/${resolvedRevision}`
    const content = execFileSync('gh', ['api', patchEndpoint, '-H', 'Accept: application/vnd.github.patch'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      content,
      resolvedRevision,
      immutableOrigin: `https://github.com/${owner}/${repo}/${kind === 'pull' && metadata.base ? `compare/${metadata.base.sha}...${resolvedRevision}` : `commit/${resolvedRevision}`}.patch`,
    }
  },
}
