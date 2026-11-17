/**
 * Renders docs/SHOWCASE-EXAMPLE.md: the README showcase for a qualified experiment (five complete rounds of every
 * runner configuration, upstream parity, verified evidence), from fixture data. The test fails when showcase.ts
 * renders something else, so format changes show up as a diff of that file; `pnpm test -u` regenerates it.
 */
import { expect, it } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import type { SampleMeasurementResult } from '../src/collector.ts'
import { type BoundAssessment, observationHash } from '../src/evidence.ts'
import { createExperimentManifest } from '../src/manifest.ts'
import type { ScenarioReference } from '../src/reference.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import { renderShowcase } from '../src/showcase.ts'
import type { VariantId } from '../src/types.ts'

const config = structuredClone(fixtureConfig)
type Manifest = ReturnType<typeof createExperimentManifest>
const experiment = (variants?: VariantId[]): Manifest =>
  createExperimentManifest({
    config,
    experimentId: 'example',
    profileNames: ['cold'],
    ...(variants ? { variants } : {}),
  })
const at = (offset: number) => new Date(Date.UTC(2026, 10, 6) + offset * 1000).toISOString()

// Job seconds per scenario and runner configuration; each round varies a little, as real runs do.
const seconds: Record<string, Record<VariantId, { build: number; test: number }>> = {
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
const jitter = (repetition: number) => ((repetition * 7) % 5) - 2

function sample(manifest: Manifest, request: Manifest['samples'][number]): SampleMeasurementResult {
  const base = seconds[request.scenarioName]?.[request.variant]
  if (!base) throw new Error(`No timing for ${request.sampleId}`)
  const build = base.build + 3 * jitter(request.repetition)
  const test = base.test + 2 * jitter(request.repetition + 1)
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

function reference(scenarioName: string): ScenarioReference {
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

// What `bench verify` binds to each sample when the same checks ran with the same verdicts and coverage.
function verified(manifest: Manifest, s: SampleMeasurementResult): BoundAssessment {
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
      profileName: 'cold',
      mode: 'cold',
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

/** A report whose every sample completed, matched upstream and has verified evidence. */
function qualifiedReport(manifest: Manifest) {
  const samples = manifest.samples.map((request) => sample(manifest, request))
  return generateExperimentReport({
    experimentId: 'example',
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

it('renders the showcase of a qualified experiment as docs/SHOWCASE-EXAMPLE.md', async () => {
  const report = qualifiedReport(experiment())
  expect(report.comparisons.every((c) => c.publishableHeadlineAllowed)).toBe(true)
  const readme = renderShowcase({
    report,
    config,
    narrative: {
      title: 'DefinitelyTyped',
      stars: '51.5k',
      same: 'Every sample ran the same packages through dtslint with the same verdicts, and check coverage stayed 3/3.',
      notes: ['Example notes from showcase.json appear here, for method facts a reader would ask about.'],
      agentPullRequests: ['https://github.com/starsling-agent/example/pull/1'],
    },
  })
  const example = [
    '> [!CAUTION]',
    '> **Example rendering, not a measurement.** This is the README showcase `src/showcase.ts` renders for a qualified experiment, from the test fixture in `tests/showcase-example.test.ts`. Every number is made up, and links to `upstream/`, `patches/` and `benchmark/` resolve only inside a benchmark repository. Regenerate with `pnpm test -u` after changing the showcase.',
    '',
    readme,
  ].join('\n')
  await expect(example).toMatchFileSnapshot('../docs/SHOWCASE-EXAMPLE.md')
})

it('judges cost neutrality on the StarSling pair when the headline configurations leave GitHub-hosted self-improving CI out', () => {
  const headline = experiment(['github-baseline', 'starsling-baseline', 'starsling-patched'])
  const report = qualifiedReport(headline)
  const readme = renderShowcase({ report, config })
  expect(readme).toContain('- [x] **Cost neutral:**')
  // A configuration the manifest did not request has nothing outstanding, and reports leave it out.
  expect(report.comparisons.map((c) => c.variants['github-patched'].requestedSamples)).toEqual([0, 0])
  expect(report.comparisons.map((c) => c.variants['starsling-patched'].requestedSamples)).toEqual([5, 5])
  expect(report.markdownSummary).not.toMatch(/^\| `github-patched` \|/m)
})
