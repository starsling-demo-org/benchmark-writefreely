import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PreparedExperiment, PreparedVariant } from '../src/prepared.ts'
import { runNativeExperiment } from '../src/runtime.ts'
import fixtureConfig from './fixtures/definitelytyped.config.ts'

/**
 * Characterization tests (BuildKit cache evidence, step 1): the cold reset deletes every Actions cache on a
 * benchmark-owned ref whatever its key, so BuildKit `type=gha` entries (`buildkit-blob-*`, `index-buildx-*`)
 * are already reset. These pin existing behaviour; they are not red proof for any fix.
 */
const state = vi.hoisted(() => ({
  caches: [] as { id: number; key: string; ref: string }[],
  deleted: [] as number[],
}))
vi.mock('../src/prepared.ts', () => ({ verifyPrepared: vi.fn() }))
vi.mock('../src/github.ts', () => ({
  object: (value: unknown) => value,
  GitHubClient: class {
    async request(path: string, method?: string) {
      if (method === 'DELETE') {
        const id = Number(path.replace('actions/caches/', ''))
        state.deleted.push(id)
        state.caches = state.caches.filter((c) => c.id !== id)
        return {}
      }
      return { default_branch: 'main' }
    }
    async all(path: string) {
      return path === 'actions/caches' ? [...state.caches] : []
    }
  },
  GitHubActionsApi: class {},
}))
vi.mock('../src/native-backend.ts', () => ({
  NativeReplayBackend: class {
    async ensureNoActiveRuns() {}
    async acquireLease() {}
    async finishExperiment() {}
    async settleRuns() {}
  },
}))
vi.mock('../src/staging.ts', () => ({
  ReplayStagingController: class {
    loadState() {
      return null
    }
    async executeSampleStaging() {
      // The cache reset runs before staging; stopping here is enough to observe it.
      throw new Error('staging reached')
    }
  },
}))

const config = structuredClone(fixtureConfig)
config.benchmarkRepository.defaultBranch = 'main'
const payload: PreparedVariant = {
  treeDir: 'unused',
  gitDir: 'unused',
  baseSha: 'base',
  headSha: 'head',
  mergeSha: 'head',
  workflowFiles: ['ci.yml'],
  lock: {
    variant: 'github-baseline',
    sourceTreeHash: '',
    workflowTreeHash: '',
    combinedHash: '',
    mixedRunner: false,
    movedJobs: [],
    retainedJobs: [],
  },
  inventory: {
    scenarioName: 'main-push',
    triggeredWorkflows: ['ci.yml'],
    excludedWorkflows: [],
    downstreamWorkflowRuns: [],
    jobExpectations: [],
    mixedRunnerOnStarSling: false,
    movedJobs: [],
    retainedJobs: [],
    blockers: [],
  },
}
const prepared: PreparedExperiment = {
  schemaVersion: 1,
  harnessHash: '',
  configHash: '',
  inputFingerprint: 'fingerprint',
  patchIdentities: [],
  variants: {
    'main-push': {
      'github-baseline': payload,
      'github-patched': payload,
      'starsling-baseline': payload,
      'starsling-patched': payload,
    },
  },
}
let directory: string
const run = () =>
  runNativeExperiment({
    config,
    prepared,
    directory,
    experimentId: 'reset',
    scenarioNames: ['main-push'],
    profileNames: ['cold'],
    variants: ['github-baseline'],
  })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bench-cache-reset-'))
  state.caches = []
  state.deleted = []
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('characterization: cold reset deletes BuildKit gha entries on every benchmark-owned ref', async () => {
  state.caches = [
    { id: 1, key: 'buildkit-blob-1-sha256:abc', ref: 'refs/heads/main' },
    { id: 2, key: 'index-buildx-buildkit', ref: 'refs/heads/main' },
    { id: 3, key: 'index-buildx-buildkit', ref: 'refs/pull/7/merge' },
    { id: 4, key: 'buildkit-blob-1-sha256:def', ref: 'refs/heads/bench/pr/7/head' },
    { id: 5, key: 'Linux-pnpm-store-1', ref: 'refs/heads/main' },
  ]
  await expect(run()).rejects.toThrow('staging reached')
  expect([...state.deleted].sort()).toEqual([1, 2, 3, 4, 5])
  expect(state.caches).toEqual([])
})

it('characterization: cold reset refuses, not skips, a BuildKit entry on an unowned ref', async () => {
  state.caches = [{ id: 9, key: 'index-buildx-buildkit', ref: 'refs/heads/someone-elses-branch' }]
  await expect(run()).rejects.toThrow('Unowned cache scope refs/heads/someone-elses-branch')
  expect(state.deleted).toEqual([])
})
