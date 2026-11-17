import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import type { PreparedExperiment, PreparedVariant } from '../src/prepared.ts'
import { createExperimentManifest, reconcileSamples, unfilledSlots } from '../src/manifest.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import { runNativeExperiment } from '../src/runtime.ts'
import type { PersistedStagingState, ReplayStagingController } from '../src/staging.ts'
import type { SampleMeasurementResult, TriggerCorrelationQuery } from '../src/collector.ts'

const observed = vi.hoisted(() => ({
  calls: [] as string[],
  /** How many measured (non-seed) samples still end incomplete, and why. */
  failMeasured: 0,
  failKind: 'workflow' as 'workflow' | 'queue',
  failSeeds: 0,
  /** Fail every original attempt (ids without -retry), pass every replacement. */
  failOriginals: false,
  runCounter: 100,
  excludedSeen: [] as unknown[],
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
  collectSampleExecution: async ({
    query,
    excludedJobs,
  }: {
    query: TriggerCorrelationQuery
    excludedJobs?: unknown
  }) => {
    observed.excludedSeen.push(excludedJobs)
    const seed = query.sampleId.includes('-seed')
    const failOriginal = !seed && observed.failOriginals && !query.sampleId.includes('-retry')
    const fail = failOriginal || (seed ? observed.failSeeds > 0 : observed.failMeasured > 0)
    if (fail && !failOriginal) {
      if (seed) observed.failSeeds--
      else observed.failMeasured--
    }
    const queue = fail && !seed && observed.failKind === 'queue'
    const reasons = !fail
      ? []
      : queue
        ? ['queued 45 s for a runner (label ubuntu-24.04)']
        : ['Workflow not successful: CI: failure']
    return {
      ...query,
      complete: !fail,
      incompleteReasons: reasons,
      missingWorkflows: [],
      missingJobs: [],
      cancelledJobs: [],
      failedJobs: fail && !queue ? ['ci.yml#test'] : [],
      queueVoid: queue,
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
      workflows: [{ runId: observed.runCounter++ }],
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
const invoke = (selected = config, profileNames = ['cold']) =>
  runNativeExperiment({
    config: selected,
    prepared,
    directory,
    experimentId: 'replace',
    scenarioNames: ['main-push'],
    profileNames,
    variants: ['github-baseline'],
  })
const withCap = (cap: number) => {
  const copy = structuredClone(config)
  copy.execution.maxReplacementsPerSetup = cap
  return copy
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bench-replace-'))
  observed.calls = []
  observed.failMeasured = 0
  observed.failKind = 'workflow'
  observed.failSeeds = 0
  observed.failOriginals = false
  observed.runCounter = 100
  observed.excludedSeen = []
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('a failed or voided sample is excluded and replaced', () => {
  it('replaces a sample whose workflow failed, finishes the experiment, and keeps the slot identity', async () => {
    observed.failMeasured = 1
    const record = await invoke()
    const [first, second] = record.manifest.samples
    if (!first || !second) throw new Error('Missing sample')
    // Three attempts for two slots: the failed one stays in the record, excluded.
    expect(record.samples).toHaveLength(3)
    const failed = record.samples.find((s) => s.sampleId === first.sampleId)
    expect(failed?.complete).toBe(false)
    expect(failed?.incompleteReasons).toContain('Workflow not successful: CI: failure')
    const replacement = record.samples.find((s) => s.sampleId !== first.sampleId && s.repetition === first.repetition)
    expect(replacement?.complete).toBe(true)
    expect(replacement).toMatchObject({
      scenarioName: first.scenarioName,
      profileName: first.profileName,
      variant: first.variant,
      repetition: first.repetition,
    })
    // The failed attempt's runs are settled and its journal closed before the replacement stages.
    const staged = observed.calls.filter((c) => /^(stage|settle|supersede):/.test(c))
    expect(staged[0]).toBe(`stage:${first.sampleId}`)
    expect(staged[1]).toMatch(/^settle:/)
    expect(staged[2]).toMatch(/^supersede:/)
    expect(staged[3]).toBe(`stage:${replacement?.sampleId}`)
    expect(observed.calls.filter((c) => c === 'finish')).toHaveLength(1)
    // Every slot has one complete sample, so the record reconciles cleanly.
    expect(
      reconcileSamples(
        record.manifest,
        record.samples.map((s) => ({
          ...s,
          inputFingerprint: record.manifest.inputFingerprint,
          workflows: [{ jobs: [{ conclusion: 'success' }] }],
          metrics: { ...s.metrics },
        })) as never,
      ),
    ).toEqual([])
  })

  it('replaces a sample voided on queue time', async () => {
    observed.failMeasured = 1
    observed.failKind = 'queue'
    const record = await invoke()
    expect(record.samples).toHaveLength(3)
    expect(record.samples.filter((s) => !s.complete)).toHaveLength(1)
    expect(record.samples.find((s) => !s.complete)?.incompleteReasons[0]).toContain('queued 45 s')
    expect(observed.calls).toContain('finish')
  })

  it('stops with the current error once a setup has used its replacements (default 3)', async () => {
    observed.failMeasured = 10
    await expect(invoke()).rejects.toThrow('Incomplete sample')
    // The original and three replacements, then it stops.
    expect(observed.calls.filter((c) => c.startsWith('stage:'))).toHaveLength(4)
    expect(observed.calls).not.toContain('finish')
  })

  it('takes the cap from execution.maxReplacementsPerSetup', async () => {
    observed.failMeasured = 10
    await expect(invoke(withCap(1))).rejects.toThrow('Incomplete sample')
    expect(observed.calls.filter((c) => c.startsWith('stage:'))).toHaveLength(2)
  })

  it('counts the cap per setup across slots, so two flaky slots share one budget', async () => {
    observed.failOriginals = true // both slots fail once and are fixed by one replacement each
    await expect(invoke(withCap(1))).rejects.toThrow('Incomplete sample')
    observed.calls = []
    directory = mkdtempSync(join(tmpdir(), 'bench-replace-cap2-'))
    const record = await invoke(withCap(2))
    expect(record.samples.filter((s) => !s.complete)).toHaveLength(2)
    expect(record.samples.filter((s) => s.complete)).toHaveLength(2)
  })

  it('gives a replaced warm sample its own seed', async () => {
    observed.failMeasured = 1
    const record = await invoke(config, ['warm'])
    const [first] = record.manifest.samples
    if (!first) throw new Error('Missing sample')
    const replacement = record.samples.find((s) => s.sampleId !== first.sampleId && s.repetition === first.repetition)
    expect(replacement?.complete).toBe(true)
    expect(record.seedSamples.some((s) => s.sampleId.startsWith(`${replacement?.sampleId}-seed`))).toBe(true)
  })

  it('still aborts on a controller-side error (not a failed sample)', async () => {
    const copy = structuredClone(config)
    copy.profiles.cold = undefined as never
    await expect(invoke(copy)).rejects.toThrow()
  })
})

describe('reporting a record with replacements', () => {
  const manifest = createExperimentManifest({
    config,
    experimentId: 'rep',
    scenarioNames: ['main-push'],
    profileNames: ['cold'],
    variants: ['github-baseline'],
    repetitions: 2,
  })
  const [slot1, slot2] = manifest.samples
  if (!slot1 || !slot2) throw new Error('Missing slots')
  const make = (slot: typeof slot1, sampleId: string, complete: boolean, seconds: number): SampleMeasurementResult =>
    ({
      ...slot,
      sampleId,
      inputFingerprint: manifest.inputFingerprint,
      complete,
      incompleteReasons: complete ? [] : ['Workflow not successful: CI: failure'],
      missingWorkflows: [],
      missingJobs: [],
      cancelledJobs: [],
      failedJobs: complete ? [] : ['ci.yml#test'],
      partialTimestampJobs: [],
      timestampResolution: '1s',
      artifacts: [],
      metrics: {
        rawRunnerSeconds: seconds,
        repoMinutes: seconds / 60,
        wallClockSeconds: seconds,
        prWallClockSeconds: null,
        mainWallClockSeconds: seconds,
        triggerLatencySeconds: 1,
        harnessOverheadSeconds: 0,
      },
      workflows: [
        {
          runId: 1,
          runAttempt: 1,
          priorAttemptsCount: 0,
          workflowPath: 'ci.yml',
          workflowName: 'CI',
          event: 'push',
          conclusion: complete ? 'success' : 'failure',
          durationSeconds: seconds,
          startedAt: '2026-11-06T00:00:00Z',
          completedAt: '2026-11-06T00:01:00Z',
          htmlUrl: 'https://github.com/example/repo/actions/runs/1',
          artifacts: [],
          jobs: [
            {
              jobRecordId: 1,
              runId: 1,
              runAttempt: 1,
              workflowPath: 'ci.yml',
              jobName: 'test',
              logicalJobId: 'test',
              conclusion: complete ? 'success' : 'failure',
              durationSeconds: seconds,
              dependencyWaitSeconds: null,
              runnerQueueSeconds: null,
              resolution: '1s',
              labels: ['ubuntu-24.04'],
              steps: [],
            },
          ],
        },
      ],
    }) as unknown as SampleMeasurementResult
  const samples = [
    make(slot1, slot1.sampleId, false, 900),
    make(slot1, `${slot1.sampleId}-retry1`, true, 60),
    make(slot2, slot2.sampleId, true, 80),
  ]

  it('reconciles with no issues when every slot has one complete sample', () => {
    expect(reconcileSamples(manifest, samples)).toEqual([])
  })

  it('treats a slot with only failed samples as unfilled', () => {
    const onlyFailed = [make(slot1, slot1.sampleId, false, 900), samples[2] as SampleMeasurementResult]
    expect(unfilledSlots(manifest, onlyFailed).map((r) => r.sampleId)).toEqual([slot1.sampleId])
    expect(unfilledSlots(manifest, samples)).toEqual([])
  })

  it('rejects two complete samples for one slot', () => {
    const two = [...samples, make(slot1, `${slot1.sampleId}-retry2`, true, 61)]
    expect(reconcileSamples(manifest, two).join()).toContain('Duplicate')
  })

  it('computes medians from complete samples only and counts the failed one', () => {
    const report = generateExperimentReport({
      experimentId: 'rep',
      config,
      samples,
      manifest,
      generatedAt: '2026-11-06T00:00:00Z',
    })
    expect(report.manifestIssues.filter((i) => !i.includes('claims'))).toEqual([])
    const summary = report.comparisons[0]?.variants['github-baseline']
    expect(summary?.completeSamples).toBe(2)
    expect(summary?.requestedSamples).toBe(2)
    expect(summary?.wallClockSec.median).toBe(70)
    expect(report.comparisons[0]?.samples.filter((s) => !s.complete)).toHaveLength(1)
  })
})

describe('execution.excludedJobs reaches the collector', () => {
  it('passes the configured list on every measurement', async () => {
    const list = [{ workflowFile: 'ci.yml', jobId: 'lychee', reason: 'red upstream' }]
    const copy = structuredClone(config)
    copy.execution.excludedJobs = list
    await invoke(copy)
    expect(observed.excludedSeen.length).toBeGreaterThan(0)
    expect(observed.excludedSeen.every((seen) => JSON.stringify(seen) === JSON.stringify(list))).toBe(true)
  })
})
