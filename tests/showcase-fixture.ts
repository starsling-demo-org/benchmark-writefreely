/** Shared fixture for the showcase layout tests: a synthetic two-lane, cold and warm experiment. Every number is made up. */
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import type { SampleMeasurementResult } from '../src/collector.ts'
import { type BoundAssessment, observationHash } from '../src/evidence.ts'
import { createExperimentManifest } from '../src/manifest.ts'
import type { ScenarioReference } from '../src/reference.ts'
import { type BenchmarkExperimentReport, generateExperimentReport } from '../src/reporter.ts'
import { renderShowcase } from '../src/showcase.ts'
import type { ShowcaseNarrative } from '../src/showcase-model.ts'
import type { VariantId } from '../src/types.ts'

export const config = structuredClone(fixtureConfig)
export type Manifest = ReturnType<typeof createExperimentManifest>
export type Timing = Record<VariantId, { build: number; test: number }>
export const at = (offset: number) => new Date(Date.UTC(2026, 10, 6) + offset * 1000).toISOString()

export const seconds: Record<string, Timing> = {
  'main-push': {
    'github-baseline': { build: 540, test: 300 },
    'github-patched': { build: 150, test: 300 },
    'starsling-baseline': { build: 230, test: 130 },
    'starsling-patched': { build: 60, test: 130 },
  },
  'pr-single-package': {
    'github-baseline': { build: 420, test: 240 },
    'github-patched': { build: 120, test: 240 },
    'starsling-baseline': { build: 180, test: 100 },
    'starsling-patched': { build: 45, test: 100 },
  },
}
export const jitter = (repetition: number) => ((repetition * 7) % 5) - 2

export function sample(
  manifest: Manifest,
  request: Manifest['samples'][number],
  timing?: Timing,
): SampleMeasurementResult {
  const base = (timing ?? seconds[request.scenarioName])?.[request.variant]
  if (!base) throw new Error(`No timing for ${request.sampleId}`)
  const scale = request.profileName === 'warm' ? 0.8 : 1
  const build = Math.round(base.build * scale) + 3 * jitter(request.repetition)
  const test = Math.round(base.test * scale) + 2 * jitter(request.repetition + 1)
  const pr = request.scenarioName.startsWith('pr-')
  const label = request.variant.startsWith('github') ? 'ubuntu-24.04' : 'starsling-ubuntu-24.04'
  const runId = 1000 + manifest.samples.indexOf(request)
  const job = (id: number, name: string, duration: number, offset: number) => ({
    jobRecordId: runId * 10 + id,
    runId,
    runAttempt: 1,
    workflowPath: '.github/workflows/CI.yml',
    jobName: name,
    logicalJobId: name,
    conclusion: 'success' as const,
    durationSeconds: duration,
    dependencyWaitSeconds: 0,
    runnerQueueSeconds: 0,
    resolution: '1s' as const,
    labels: [label],
    startedAt: at(offset),
    completedAt: at(offset + duration),
    steps: [
      {
        number: 1,
        name: `Run ${name}`,
        conclusion: 'success' as const,
        durationSeconds: duration,
        resolution: '1s' as const,
        isHarnessInstrumentation: false,
      },
    ],
  })
  const wall = build + test
  return {
    ...request,
    inputFingerprint: manifest.inputFingerprint,
    complete: true,
    incompleteReasons: [],
    missingWorkflows: [],
    missingJobs: [],
    cancelledJobs: [],
    failedJobs: [],
    partialTimestampJobs: [],
    timestampResolution: '1s',
    artifacts: [],
    metrics: {
      rawRunnerSeconds: wall,
      repoMinutes: wall / 60,
      wallClockSeconds: wall,
      prWallClockSeconds: pr ? wall : null,
      mainWallClockSeconds: pr ? null : wall,
      triggerLatencySeconds: 2,
      harnessOverheadSeconds: 0,
    },
    workflows: [
      {
        runId,
        runAttempt: 1,
        priorAttemptsCount: 0,
        workflowPath: '.github/workflows/CI.yml',
        workflowName: 'CI',
        event: pr ? 'pull_request' : 'push',
        conclusion: 'success',
        durationSeconds: wall,
        startedAt: at(0),
        completedAt: at(wall),
        htmlUrl: `https://github.com/starsling-agent/example-ci-speedup/actions/runs/${runId}`,
        artifacts: [],
        jobs: [job(1, 'build', build, 0), job(2, 'test', test, build)],
      },
    ],
  }
}

export function reference(scenarioName: string): ScenarioReference {
  const scenario = config.scenarios[scenarioName]
  const pr = Boolean(scenario?.pr)
  return {
    schemaVersion: 1,
    scenarioName,
    upstreamRepository: config.upstream.repository,
    event: pr ? 'pull_request' : 'push',
    headSha: scenario?.pr?.headSha ?? config.upstream.commitSha,
    retrievedAt: at(0),
    metrics: { wallClockSeconds: pr ? 702 : 897, runnerSeconds: pr ? 702 : 897 },
    runs: [
      {
        runId: pr ? 41506146212 : 41515783490,
        attempt: 1,
        workflowPath: '.github/workflows/CI.yml',
        workflowName: 'CI',
        event: pr ? 'pull_request' : 'push',
        status: 'completed',
        conclusion: 'success',
        htmlUrl: `https://github.com/${config.upstream.repository}/actions/runs/${pr ? 41506146212 : 41515783490}`,
        createdAt: at(0),
        startedAt: at(0),
        jobs: ['build', 'test'].map((name, id) => ({
          id,
          name,
          status: 'completed',
          conclusion: 'success',
          startedAt: at(0),
          completedAt: at(60),
          durationSeconds: 60,
          labels: ['ubuntu-24.04'],
          steps: [{ number: 1, name: `Run ${name}`, conclusion: 'success', durationSeconds: 60 }],
        })),
      },
    ],
  }
}

export function verified(manifest: Manifest, s: SampleMeasurementResult): BoundAssessment {
  const mode = s.profileName === 'warm' ? 'warm' : 'cold'
  return {
    sampleId: s.sampleId,
    inputFingerprint: manifest.inputFingerprint,
    observationHash: observationHash(s),
    sourceHashes: ['0'.repeat(64)],
    parity: {
      passed: true,
      evidenceLevel: 'coverage-qualified',
      satisfies01PpCoverageRequirement: true,
      structural: { passed: true, issues: [] },
      observed: { passed: true, issues: [] },
      semantic: {
        passed: true,
        issues: [],
        testInventory: { executed: ['build', 'test'], reused: [], skipped: [], missing: [] },
      },
    },
    cache: {
      profileName: s.profileName,
      mode,
      valid: true,
      contaminated: false,
      violations: [],
      cacheEvents: [],
      artifactEvents: [],
      costBreakdown: {
        coldPopulationSeconds: 0,
        coldSaveSeconds: 0,
        warmConsumerSeconds: 0,
        amortizationHorizonRuns: null,
        amortizedTotalSeconds: null,
      },
    },
  }
}

export function buildReport(
  manifest: Manifest,
  options: { timing?: Timing; mutate?: (s: SampleMeasurementResult) => SampleMeasurementResult } = {},
): BenchmarkExperimentReport {
  const samples = manifest.samples.map((request) => {
    const s = sample(manifest, request, options.timing)
    return options.mutate ? options.mutate(s) : s
  })
  return generateExperimentReport({
    experimentId: manifest.experimentId,
    config,
    manifest,
    samples,
    references: Object.fromEntries(
      Object.keys(config.scenarios)
        .filter((name) => config.scenarios[name]?.role !== 'seed')
        .map((name) => [name, reference(name)]),
    ),
    assessments: Object.fromEntries(samples.map((s) => [s.sampleId, verified(manifest, s)])),
    generatedAt: at(0),
  })
}

export const headlineManifest = () =>
  createExperimentManifest({ config, experimentId: 'headline', profileNames: ['cold', 'warm'] })
export const headline = (mutate?: (s: SampleMeasurementResult) => SampleMeasurementResult) =>
  buildReport(headlineManifest(), mutate ? { mutate } : {})

/** Merge-lane StarSling wait (build + test) after each agent PR lands, starting from the unchanged CI (360 s). */
export const CUMULATIVE = [360, 300, 250, 210, 190]
export function leverReport(k: number, cumulative: number[] = CUMULATIVE): BenchmarkExperimentReport {
  const timing: Timing = {
    ...seconds['main-push'],
    'starsling-baseline': { build: (cumulative[k - 1] ?? 0) - 130, test: 130 },
    'starsling-patched': { build: (cumulative[k] ?? 0) - 130, test: 130 },
  } as Timing
  return buildReport(
    createExperimentManifest({
      config,
      experimentId: `lever-${k}`,
      scenarioNames: ['main-push'],
      profileNames: ['cold'],
      variants: ['starsling-baseline', 'starsling-patched'],
    }),
    { timing },
  )
}
export const levers = (cumulative: number[] = CUMULATIVE): Record<string, BenchmarkExperimentReport> => {
  const result: Record<string, BenchmarkExperimentReport> = {}
  for (const k of [1, 2, 3, 4]) result[`lever-${k}`] = leverReport(k, cumulative)
  return result
}

export const agentPrs = [1, 2, 3, 4].map((k) => ({
  url: `https://github.com/starsling-agent/example-ci-speedup/pull/${k}`,
  summary: [
    'Sparse checkout of changed packages',
    'Shard count from git',
    'Narrowed pnpm workspace',
    'Fold scripts check into test',
  ][k - 1] as string,
  experiment: { id: `lever-${k}`, before: 'starsling-baseline' as const, after: 'starsling-patched' as const },
}))

export const narrative = (extra: Partial<ShowcaseNarrative> = {}): ShowcaseNarrative => ({
  layout: 'showcase',
  title: 'DefinitelyTyped',
  stars: '51.5k',
  whatWasSlow: 'Every push starts with a full-history checkout, then installs the whole workspace.',
  whatWeChanged: 'Four small agent PRs, each measured on its own below.',
  same: 'Every sample ran the same packages through dtslint with the same verdicts.',
  pushesPerMonth: { value: 600, source: 'upstream push count for the last 30 days' },
  prUpdatesPerMonth: { value: 900, source: 'upstream PR synchronize events for the last 30 days' },
  agentPrs,
  notes: ['Example method note from showcase.json.'],
  ...extra,
})

export const render = (n: ShowcaseNarrative = narrative(), report = headline(), leverReports = levers()) =>
  renderShowcase({ report, config, narrative: n, leverReports })
