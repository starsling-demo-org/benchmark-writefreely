import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import type { PreparedExperiment, PreparedVariant } from '../src/prepared.ts'
import { createExperimentManifest } from '../src/manifest.ts'
import { runNativeExperiment, type ExperimentRecord } from '../src/runtime.ts'
import type { PersistedStagingState, ReplayStagingController } from '../src/staging.ts'
import type { TriggerCorrelationQuery } from '../src/collector.ts'

const observed = vi.hoisted(() => ({
  calls: [] as string[],
  active: false,
  afterWaitError: '',
  pendingPersisted: false,
  failSeeds: 0,
}))
vi.mock('../src/prepared.ts', () => ({ verifyPrepared: vi.fn() }))
vi.mock('../src/github.ts', () => ({
  object: (value: unknown) => value,
  GitHubClient: class {
    async request() {
      return { default_branch: 'main' }
    }
    async all() {
      return []
    }
  },
  GitHubActionsApi: class {},
}))
vi.mock('../src/native-backend.ts', () => ({
  NativeReplayBackend: class {
    async ensureNoActiveRuns() {
      observed.calls.push('preflight')
      if (observed.active) throw new Error('Active runs remain')
    }
    async acquireLease() {
      observed.calls.push('acquire')
    }
    async finishExperiment() {
      observed.calls.push('finish')
    }
    async settleRuns(runIds: number[]) {
      observed.calls.push(`settle:${runIds.join(',')}`)
    }
  },
}))
vi.mock('../src/collector.ts', () => ({
  collectSampleExecution: async ({ query }: { query: TriggerCorrelationQuery }) => {
    const fail = query.sampleId.includes('-seed') && observed.failSeeds > 0
    if (fail) observed.failSeeds--
    return {
      ...query,
      complete: !fail,
      incompleteReasons: fail ? ['Failed jobs: pnpm-cache.yml#create-cache'] : [],
      missingWorkflows: [],
      missingJobs: [],
      cancelledJobs: [],
      failedJobs: fail ? ['pnpm-cache.yml#create-cache'] : [],
      partialTimestampJobs: [],
      timestampResolution: '1s',
      metrics: {
        repoMinutes: 1,
        rawRunnerSeconds: 60,
        wallClockSeconds: 60,
        prWallClockSeconds: null,
        mainWallClockSeconds: 60,
        triggerLatencySeconds: 0,
        harnessOverheadSeconds: 0,
      },
      workflows: [{ runId: fail ? 41 : 42 }],
      artifacts: [],
    }
  },
}))
vi.mock('../src/staging.ts', () => ({
  ReplayStagingController: class {
    private path: string
    constructor(path: string) {
      this.path = path
    }
    loadState() {
      return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as PersistedStagingState) : null
    }
    supersede(reason: string) {
      observed.calls.push(`supersede:${reason}`)
      writeFileSync(this.path, JSON.stringify({ ...this.loadState(), currentStep: 'superseded' }))
    }
    async executeSampleStaging(params: Parameters<ReplayStagingController['executeSampleStaging']>[0]) {
      observed.calls.push(`stage:${params.sampleId}`)
      const state = this.loadState()
      if (state?.currentStep === 'completed') return state
      const dispatch = {
        event: 'push',
        headSha: 'head',
        dispatchedAt: '2026-01-01T00:00:00Z',
        targetRef: 'refs/heads/main',
        idempotencyKey: params.sampleId,
      }
      writeFileSync(
        this.path,
        JSON.stringify({ currentStep: '7_await_downstream_completion', dispatchRecord: dispatch }),
      )
      await params.awaitCompletionFn?.(dispatch)
      const record = JSON.parse(readFileSync(join(dirname(this.path), 'experiment.json'), 'utf8')) as ExperimentRecord
      observed.pendingPersisted = record.samples.some(
        (sample) => !sample.complete && sample.incompleteReasons.includes('Staging integrity validation is pending'),
      )
      if (observed.afterWaitError) {
        writeFileSync(this.path, JSON.stringify({ currentStep: 'invalidated', dispatchRecord: dispatch }))
        throw new Error(observed.afterWaitError)
      }
      writeFileSync(this.path, JSON.stringify({ currentStep: 'completed', dispatchRecord: dispatch }))
      return this.loadState()
    }
  },
}))
let directory: string
const config = structuredClone(fixtureConfig)
config.benchmarkRepository.defaultBranch = 'main'
config.execution.repetitions = 2
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
const parameters = () => ({
  config,
  prepared,
  directory,
  experimentId: 'resume',
  scenarioNames: ['main-push'],
  profileNames: ['cold'],
  variants: ['github-baseline'] as const,
})
const invoke = (collectOnly = false) =>
  runNativeExperiment({ ...parameters(), variants: ['github-baseline'], collectOnly })
const readRecord = () => JSON.parse(readFileSync(join(directory, 'experiment.json'), 'utf8')) as ExperimentRecord
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bench-runtime-resume-'))
  observed.calls = []
  observed.active = false
  observed.afterWaitError = ''
  observed.pendingPersisted = false
  observed.failSeeds = 0
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('collects dispatched samples without finalizing pending manifest samples, then resumes and finalizes', async () => {
  const manifest = createExperimentManifest({
    ...parameters(),
    variants: ['github-baseline'],
    inputFingerprint: prepared.inputFingerprint,
  })
  const first = manifest.samples[0]
  if (!first) throw new Error('Missing fixture request')
  writeFileSync(
    join(directory, 'experiment.json'),
    JSON.stringify({ schemaVersion: 1, manifest, config, samples: [], seedSamples: [], cacheSnapshots: {} }),
  )
  writeFileSync(
    join(directory, `${first.sampleId}.staging.json`),
    JSON.stringify({ currentStep: '7_await_downstream_completion', dispatchRecord: { headSha: 'head' } }),
  )
  observed.active = true // Resume/collect must be allowed to observe its existing active workload.
  const collected = await invoke(true)
  expect(collected.samples).toHaveLength(1)
  expect(collected.samples[0]?.complete).toBe(true)
  expect(observed.calls).not.toContain('finish')
  expect(observed.calls).not.toContain('preflight')
  expect(observed.pendingPersisted).toBe(true)
  const finished = await invoke()
  expect(finished.samples).toHaveLength(2)
  expect(finished.samples.every((sample) => sample.complete)).toBe(true)
  expect(observed.calls.filter((call) => call === 'finish')).toHaveLength(1)
})

it('preserves measured timings while invalidating a post-collection staging failure', async () => {
  observed.afterWaitError = 'Unexpected concurrent ref mutation'
  await expect(invoke()).rejects.toThrow('Unexpected concurrent ref mutation')
  const sample = readRecord().samples[0]
  expect(sample?.complete).toBe(false)
  expect(sample?.metrics.wallClockSeconds).toBe(60)
  expect(sample?.incompleteReasons).toContain('Staging failed: Unexpected concurrent ref mutation')
  expect(observed.calls).not.toContain('finish')
  observed.afterWaitError = ''
  await expect(invoke()).rejects.toThrow('was invalidated')
  expect(readRecord().samples[0]?.complete).toBe(false)
})

it('rejects active pre-existing runs before acquiring a lease or staging a new experiment', async () => {
  observed.active = true
  await expect(invoke()).rejects.toThrow('Active runs remain')
  expect(observed.calls).toEqual(['preflight'])
  expect(existsSync(join(directory, 'experiment.json'))).toBe(false)
})

it.each(['empty inventory', 'unsupported event', 'missing seed', 'unresolved seed'] as const)(
  'rejects %s before acquiring ownership or making mutations',
  async (problem) => {
    const selectedConfig = structuredClone(config)
    const selectedPrepared = structuredClone(prepared)
    const scenario = selectedConfig.scenarios['main-push']
    const variant = selectedPrepared.variants['main-push']?.['github-baseline']
    const profile = selectedConfig.profiles.cold
    if (!scenario || !variant || !profile) throw new Error('Missing preflight fixture')
    if (problem === 'empty inventory') variant.inventory.triggeredWorkflows = []
    else if (problem === 'unsupported event') scenario.event = 'merge_group'
    else {
      profile.actionsCache = 'warm'
      if (problem === 'missing seed') delete profile.seedScenario
      else profile.seedScenario = 'nonexistent-seed'
    }
    await expect(
      runNativeExperiment({
        ...parameters(),
        config: selectedConfig,
        prepared: selectedPrepared,
        variants: ['github-baseline'],
      }),
    ).rejects.toThrow()
    expect(observed.calls).toEqual([])
    expect(existsSync(join(directory, 'experiment.json'))).toBe(false)
  },
)

it('retries a warm seed whose workflows failed, keeping every attempt in the record', async () => {
  observed.failSeeds = 1
  await runNativeExperiment({ ...parameters(), profileNames: ['warm'], variants: ['github-baseline'] })
  const record = readRecord()
  const [first] = record.manifest.samples
  if (!first) throw new Error('Missing sample')
  expect(
    record.seedSamples
      .filter((s) => s.sampleId.startsWith(`${first.sampleId}-seed`))
      .map((s) => [s.sampleId.replace(first.sampleId, ''), s.complete]),
  ).toEqual([
    ['-seed', false],
    ['-seed-r2', true],
  ])
  expect(record.samples.every((sample) => sample.complete)).toBe(true)
  // The failed attempt's runs are settled and its journal closed before the retry stages.
  expect(observed.calls.filter((call) => /^(stage|settle|supersede):/.test(call)).slice(0, 4)).toEqual([
    `stage:${first.sampleId}-seed`,
    'settle:41',
    `supersede:Seed attempt failed; retried as ${first.sampleId}-seed-r2`,
    `stage:${first.sampleId}-seed-r2`,
  ])
  expect(JSON.parse(readFileSync(join(directory, `${first.sampleId}-seed.staging.json`), 'utf8')).currentStep).toBe(
    'superseded',
  )
  expect(observed.calls.filter((call) => call.startsWith('stage:'))).toEqual([
    `stage:${first.sampleId}-seed`,
    `stage:${first.sampleId}-seed-r2`,
    `stage:${first.sampleId}`,
    `stage:${record.manifest.samples[1]?.sampleId}-seed`,
    `stage:${record.manifest.samples[1]?.sampleId}`,
  ])
  observed.failSeeds = 3
  directory = mkdtempSync(join(tmpdir(), 'bench-runtime-seedless-'))
  await expect(
    runNativeExperiment({
      ...parameters(),
      experimentId: 'seedless',
      profileNames: ['warm'],
      variants: ['github-baseline'],
    }),
  ).rejects.toThrow('Incomplete sample')
})
