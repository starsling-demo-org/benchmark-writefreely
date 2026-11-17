import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import { resolvePatchStack, validateBenchmarkConfig } from '../src/config.ts'
import { GitHubClient } from '../src/github.ts'
import { NativeReplayBackend } from '../src/native-backend.ts'
import { githubPatchResolver } from '../src/patch-resolver.ts'
import type { PreparedVariant } from '../src/prepared.ts'
import { protectedBranchesOf } from '../src/protected-branches.ts'
import { type GitHubReplayBackend, ReplayStagingController, type TokenAuthKind } from '../src/staging.ts'
import type { PatchSpec, ScenarioConfig, VariantTreeLock } from '../src/types.ts'

// `gh api` is scripted by endpoint and Accept header: key is `${endpoint}|json|patch|diff`.
const gh = vi.hoisted(() => ({ responses: {} as Record<string, unknown>, calls: [] as string[] }))
vi.mock('node:child_process', () => ({
  execFileSync: (command: string, args: string[]) => {
    if (command !== 'gh') throw new Error(`Unexpected command ${command}`)
    const accept = args.includes('-H') ? (args[args.indexOf('-H') + 1] ?? '') : ''
    const kind = accept.includes('patch') ? 'patch' : accept.includes('diff') ? 'diff' : 'json'
    const key = `${args[1]}|${kind}`
    gh.calls.push(key)
    if (!(key in gh.responses)) throw new Error(`Unscripted gh api ${key}`)
    const value = gh.responses[key]
    return typeof value === 'string' ? value : JSON.stringify(value)
  },
}))

const REPO = 'bench-org/benchmark-x'
const sha = (c: string) => c.repeat(40)
const [BASE, HEAD, MERGE, MERGE2] = [sha('b'), sha('a'), sha('c'), sha('d')]
const PATCH = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n'

function scriptPr(
  number: number,
  overrides: { merged?: boolean; commits?: number; parents?: string[]; diff?: string } = {},
) {
  const merge = number === 7 ? MERGE : MERGE2
  const merged = overrides.merged ?? true
  gh.responses[`repos/${REPO}/pulls/${number}|json`] = {
    state: merged ? 'closed' : 'open',
    merged,
    merge_commit_sha: merged ? merge : sha('e'),
    commits: overrides.commits ?? 1,
    base: { ref: 'bench/fixes', sha: BASE },
    head: { ref: 'agent/fix', sha: HEAD },
  }
  gh.responses[`repos/${REPO}/commits/${merge}|json`] = {
    sha: merge,
    parents: (overrides.parents ?? [BASE]).map((p) => ({ sha: p })),
  }
  gh.responses[`repos/${REPO}/commits/${merge}|patch`] = PATCH
  gh.responses[`repos/${REPO}/commits/${merge}|diff`] = overrides.diff ?? PATCH
  gh.responses[`repos/${REPO}/compare/${BASE}...${HEAD}|diff`] = PATCH
}

const spec = (number = 7, extra: Partial<PatchSpec> = {}): PatchSpec => ({
  id: `fix-${number}`,
  source: 'merged-pr',
  pathOrUrl: `https://github.com/${REPO}/pull/${number}`,
  baseBranch: 'bench/fixes',
  ...extra,
})

beforeEach(() => {
  gh.responses = {}
  gh.calls = []
})

describe('merged-PR patch source', () => {
  it('uses the merge commit diff against its first parent and locks the PR facts', async () => {
    scriptPr(7)
    const resolved = await githubPatchResolver.resolveRemotePatch?.(spec())
    expect(resolved?.content).toBe(PATCH)
    expect(resolved?.resolvedRevision).toBe(MERGE)
    expect(resolved?.mergedPr).toEqual({
      repository: REPO,
      number: 7,
      mergeCommitSha: MERGE,
      firstParentSha: BASE,
      baseRef: 'bench/fixes',
      baseSha: BASE,
      headRef: 'agent/fix',
      headSha: HEAD,
    })
  })

  it('refuses a PR that is not merged', async () => {
    scriptPr(7, { merged: false })
    await expect(githubPatchResolver.resolveRemotePatch?.(spec())).rejects.toThrow(/not merged/)
  })

  it('refuses when the declared base branch is not the PR base', async () => {
    scriptPr(7)
    await expect(githubPatchResolver.resolveRemotePatch?.(spec(7, { baseBranch: 'other' }))).rejects.toThrow(
      /base branch/,
    )
  })

  it('refuses when what landed differs from the reviewed base...head diff (base unmoved)', async () => {
    scriptPr(7, { diff: `${PATCH}+extra\n` })
    await expect(githubPatchResolver.resolveRemotePatch?.(spec())).rejects.toThrow(/differs from the reviewed/)
  })

  it('refuses a multi-commit PR whose single-parent merge commit cannot be told from a rebase merge', async () => {
    scriptPr(7, { commits: 3, parents: [sha('9')] })
    await expect(githubPatchResolver.resolveRemotePatch?.(spec())).rejects.toThrow(/multi-commit/)
  })

  it('refuses a moved lock revision', async () => {
    scriptPr(7)
    await expect(githubPatchResolver.resolveRemotePatch?.(spec(7, { resolvedRevision: sha('f') }))).rejects.toThrow(
      /moved/,
    )
  })

  it('writes the PR facts into the locked patch record', async () => {
    scriptPr(7)
    const [locked] = await resolvePatchStack([spec()], '/nonexistent', githubPatchResolver)
    expect(locked?.mergedPr?.number).toBe(7)
    expect(locked?.mergedPr?.mergeCommitSha).toBe(MERGE)
    expect(locked?.resolvedRevision).toBe(MERGE)
  })

  it('checks stack order: patch N must land on top of patch N-1', async () => {
    scriptPr(7)
    scriptPr(8)
    const specs = [spec(7), spec(8)]
    const ancestry = (ok: boolean) => ({ ...githubPatchResolver, isAncestor: async () => ok })
    await expect(resolvePatchStack(specs, '/x', ancestry(false))).rejects.toThrow(/order/)
    await expect(resolvePatchStack(specs, '/x', ancestry(true))).resolves.toHaveLength(2)
  })
})

describe('merged-PR patches flagged inBaseline', () => {
  const ancestry = { ...githubPatchResolver, isAncestor: async () => true }

  it('locks the flag next to the PR facts, so the lock shows which merged PRs the baseline contains', async () => {
    scriptPr(7)
    scriptPr(8)
    const locked = await resolvePatchStack([spec(7, { inBaseline: true }), spec(8)], '/x', ancestry)
    expect(locked[0]).toMatchObject({ inBaseline: true, mergedPr: { number: 7 } })
    expect(locked[1]).not.toHaveProperty('inBaseline')
    expect(locked[1]?.mergedPr?.number).toBe(8)
  })

  it('refuses a flagged PR listed after an unflagged one', async () => {
    scriptPr(7)
    scriptPr(8)
    await expect(resolvePatchStack([spec(7), spec(8, { inBaseline: true })], '/x', ancestry)).rejects.toThrow(
      /inBaseline/,
    )
  })
})

describe('protected branches', () => {
  type Config = typeof fixtureConfig
  const withPatch = (mutate: (c: Config) => void) => {
    const c = structuredClone(fixtureConfig)
    c.patches = [spec()]
    mutate(c)
    return c
  }
  const ids = (c: Config) => validateBenchmarkConfig(c).map((b) => b.id)

  it('lists base and head branches of merged-PR patches only', () => {
    const c = withPatch(() => {})
    c.patches.push(spec(8, { headBranch: 'agent/fix' }), { id: 'l', source: 'local', pathOrUrl: 'a.patch' })
    expect(protectedBranchesOf(c)).toEqual(['agent/fix', 'bench/fixes'])
  })

  it('accepts a dedicated base branch', () => {
    expect(ids(withPatch(() => {})).filter((i) => i.startsWith('protected-branch'))).toEqual([])
  })

  it.each([
    [
      'replay',
      (c: Config) => {
        c.benchmarkRepository.replayBranch = 'bench/fixes'
      },
    ],
    [
      'control',
      (c: Config) => {
        c.benchmarkRepository.controlBranch = 'bench/fixes'
      },
    ],
    [
      'default',
      (c: Config) => {
        c.benchmarkRepository.defaultBranch = 'bench/fixes'
      },
    ],
  ])('refuses a %s branch equal to a protected base', (_name, mutate) => {
    expect(ids(withPatch(mutate)).some((i) => i.startsWith('protected-branch'))).toBe(true)
  })

  it('refuses a merged-pr patch without a base branch', () => {
    const c = withPatch((x) => {
      x.patches = [{ id: 'p', source: 'merged-pr', pathOrUrl: `https://github.com/${REPO}/pull/7` }]
    })
    expect(ids(c)).toContain('merged-pr-missing-base-p')
  })
})

class RecordingBackend implements GitHubReplayBackend {
  tokenKind: TokenAuthKind = 'github_app'
  refs: Record<string, string> = {
    'refs/heads/main': 'm',
    'refs/heads/develop': 'd',
    'refs/heads/bench/control': 'c',
    'refs/heads/bench/fixes': 'fixes-tip',
  }
  writes: string[] = []
  async getCurrentRefs() {
    return { ...this.refs }
  }
  async updateRef(ref: string, value: string | null) {
    this.writes.push(ref)
    if (value === null) delete this.refs[ref]
    else this.refs[ref] = value
  }
  async registerInactiveWorkflowPlaceholder(branch: string) {
    this.writes.push(`refs/heads/${branch}`)
  }
  async disableWorkflow() {}
  async enableWorkflow() {}
  async preparePullRequestMetadata() {
    return { prNumber: 1 }
  }
  async installTreeToRef(p: { ref: string; treeHash: string }) {
    this.writes.push(p.ref)
    this.refs[p.ref] = 'installed'
    return { commitSha: 'installed', verifiedHash: p.treeHash }
  }
  async triggerNativeEvent(p: { targetRef: string }) {
    return { headSha: this.refs[p.targetRef] ?? 'h', dispatchedAt: '2026-11-06T12:00:00Z' }
  }
}

const scenario: ScenarioConfig = {
  name: 'pr',
  description: 'pr',
  event: 'pull_request',
  pr: {
    baseRef: 'develop',
    headRef: 'h',
    baseSha: sha('1'),
    headSha: sha('2'),
    mergeSha: sha('3'),
    activityType: 'synchronize',
    changedPaths: [],
    labels: [],
  },
  referenceRuns: [],
}
const lock: VariantTreeLock = {
  variant: 'starsling-patched',
  sourceTreeHash: 's',
  workflowTreeHash: 'w',
  combinedHash: 'combo',
  mixedRunner: false,
  movedJobs: [],
  retainedJobs: [],
}

describe('controller ref writes', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-merged-pr-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const params = (replayBranch: string) => ({
    experimentId: 'e',
    sampleId: 's',
    scenario,
    variant: 'starsling-patched' as const,
    profileName: 'cold',
    controlBranch: 'bench/control',
    defaultBranch: 'main',
    replayBranch,
    allRepoWorkflows: [],
    newlyIntroducedWorkflows: ['.github/workflows/new.yml'],
    scenarioWorkflows: [],
    variantLock: lock,
    failAtStep: '6_trigger_event' as const,
  })

  it('never installs, resets or restores the protected base branch', async () => {
    const backend = new RecordingBackend()
    const controller = new ReplayStagingController(join(dir, 's.json'), backend, ['bench/fixes'])
    await expect(controller.executeSampleStaging(params('develop'))).rejects.toThrow()
    await controller.recover()
    expect(backend.writes.length).toBeGreaterThan(0)
    expect(backend.writes).not.toContain('refs/heads/bench/fixes')
    expect(backend.refs['refs/heads/bench/fixes']).toBe('fixes-tip')
  })

  it('refuses to start when the replay branch is a protected branch, before any write', async () => {
    const backend = new RecordingBackend()
    const controller = new ReplayStagingController(join(dir, 's.json'), backend, ['bench/fixes'])
    await expect(controller.executeSampleStaging(params('bench/fixes'))).rejects.toThrow(/merged-PR patch/)
    expect(backend.writes).toEqual([])
  })

  it('native backend refuses to write a protected ref', async () => {
    const backend = new NativeReplayBackend(
      new GitHubClient(REPO),
      {} as PreparedVariant,
      join(dir, 'controller.json'),
      'owner',
      false,
      ['bench/fixes'],
    )
    await expect(backend.updateRef('refs/heads/bench/fixes', sha('1'))).rejects.toThrow(/merged-PR patch/)
  })
})
