import { createExperimentManifest } from '../src/manifest.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runReportingAction } from '../src/action/index.ts'
import { deterministicShuffleOrder } from '../src/cache-lifecycle.ts'
import {
  collectSampleExecution,
  type GitHubArtifactRecord,
  type GitHubJobRecord,
  type GitHubWorkflowRunRecord,
  type PaginatedGitHubActionsApi,
  type SampleMeasurementResult,
} from '../src/collector.ts'
import { createDefaultProfiles, createDefaultRunnerMapping, defineBenchmarkConfig } from '../src/config.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import type { ScenarioInventory, VariantId } from '../src/types.ts'

function createMockPaginatedApi(data: {
  runs: GitHubWorkflowRunRecord[]
  jobsByRunAttempt: Record<string, GitHubJobRecord[]>
  artifactsByRun: Record<number, GitHubArtifactRecord[]>
  pageSize?: number
}): PaginatedGitHubActionsApi {
  const pageSize = data.pageSize ?? 1
  return {
    async listWorkflowRunsPage({ page }) {
      const start = (page - 1) * pageSize
      return { runs: data.runs.slice(start, start + pageSize), hasNextPage: start + pageSize < data.runs.length }
    },
    async listJobsForRunAttemptPage({ runId, attempt, page }) {
      const all = data.jobsByRunAttempt[`${runId}:${attempt}`] ?? []
      const start = (page - 1) * pageSize
      return { jobs: all.slice(start, start + pageSize), hasNextPage: start + pageSize < all.length }
    },
    async listRunArtifactsPage({ runId, page }) {
      const all = data.artifactsByRun[runId] ?? []
      const start = (page - 1) * pageSize
      return { artifacts: all.slice(start, start + pageSize), hasNextPage: start + pageSize < all.length }
    },
  }
}

function makeRun(
  overrides: Partial<GitHubWorkflowRunRecord> & Pick<GitHubWorkflowRunRecord, 'id' | 'name' | 'path'>,
): GitHubWorkflowRunRecord {
  return {
    event: 'pull_request',
    head_branch: 'bench/pr-head',
    head_sha: 'sha-target-123',
    run_number: 1,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-11-06T12:00:05Z',
    run_started_at: '2026-11-06T12:00:10Z',
    updated_at: '2026-11-06T12:01:10Z',
    html_url: `https://github.com/org/repo/actions/runs/${overrides.id}`,
    ...overrides,
  }
}

function makeJob(
  overrides: Partial<GitHubJobRecord> & Pick<GitHubJobRecord, 'id' | 'run_id' | 'name'>,
): GitHubJobRecord {
  return {
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-11-06T12:00:10Z',
    started_at: '2026-11-06T12:00:12Z',
    completed_at: '2026-11-06T12:00:32Z',
    labels: ['starsling-ubuntu-24.04'],
    runner_name: 'ss-1',
    steps: [],
    ...overrides,
  }
}

const multiWfScenarioInv: ScenarioInventory = {
  scenarioName: 'pr-full',
  triggeredWorkflows: ['.github/workflows/ci.yml', '.github/workflows/downstream-verify.yml'],
  excludedWorkflows: [],
  downstreamWorkflowRuns: [
    { upstreamWorkflowName: 'CI', downstreamFilePath: '.github/workflows/downstream-verify.yml' },
  ],
  jobExpectations: [
    {
      workflowFile: '.github/workflows/ci.yml',
      workflowName: 'CI',
      jobId: 'setup',
      triggeredBy: 'direct',
      expectedStatus: 'executed',
      isDynamicMatrix: false,
      mappedRunsOn: { github: 'ubuntu-24.04', starsling: 'starsling-ubuntu-24.04', retainedOnGitHub: false },
    },
    {
      workflowFile: '.github/workflows/ci.yml',
      workflowName: 'CI',
      jobId: 'test',
      triggeredBy: 'direct',
      expectedStatus: 'executed',
      isDynamicMatrix: true,
      mappedRunsOn: { github: 'ubuntu-24.04', starsling: 'starsling-ubuntu-24.04', retainedOnGitHub: false },
    },
    {
      workflowFile: '.github/workflows/downstream-verify.yml',
      workflowName: 'Downstream Verify',
      jobId: 'verify-artifacts',
      triggeredBy: 'workflow_run',
      upstreamWorkflowTrigger: 'CI',
      expectedStatus: 'executed',
      isDynamicMatrix: false,
      mappedRunsOn: { github: 'ubuntu-24.04', starsling: 'starsling-ubuntu-24.04', retainedOnGitHub: false },
    },
  ],
  mixedRunnerOnStarSling: false,
  movedJobs: [
    '.github/workflows/ci.yml#setup',
    '.github/workflows/ci.yml#test',
    '.github/workflows/downstream-verify.yml#verify-artifacts',
  ],
  retainedJobs: [],
  blockers: [],
}

describe('Stage 3: Paginated run collection, reruns, partial timestamps, downstream correlation, and reporting contract', () => {
  const tempDirs: string[] = []

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `bench-${prefix}-`))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0, tempDirs.length)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('collects across paginated APIs, selects latest rerun attempt, handles repeated matrix job names, separates dependency wait from runner queue time, and computes whole-pipeline wall clock', async () => {
    const api = createMockPaginatedApi({
      pageSize: 1,
      runs: [
        makeRun({ id: 99, name: 'CI', path: '.github/workflows/ci.yml', pr_numbers: [999], conclusion: 'failure' }),
        makeRun({
          id: 100,
          name: 'CI',
          path: '.github/workflows/ci.yml',
          pr_numbers: [42],
          run_attempt: 1,
          conclusion: 'failure',
        }),
        makeRun({ id: 100, name: 'CI', path: '.github/workflows/ci.yml', pr_numbers: [42], run_attempt: 2 }),
        makeRun({
          id: 101,
          name: 'Downstream Verify',
          path: '.github/workflows/downstream-verify.yml',
          event: 'workflow_run',
          head_branch: 'main',
          head_sha: 'default-branch-sha',
          triggering_run_id: 100,
          created_at: '2026-11-06T12:01:12Z',
          run_started_at: '2026-11-06T12:01:15Z',
          updated_at: '2026-11-06T12:01:40Z',
        }),
      ],
      jobsByRunAttempt: {
        '100:2': [
          makeJob({
            id: 1001,
            run_id: 100,
            run_attempt: 2,
            name: 'setup',
            steps: [
              {
                number: 1,
                name: 'Runner fingerprint (bench parity)',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-11-06T12:00:12Z',
                completed_at: '2026-11-06T12:00:13Z',
              },
              {
                number: 2,
                name: 'Compute matrix',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-11-06T12:00:13Z',
                completed_at: '2026-11-06T12:00:32Z',
              },
            ],
          }),
          makeJob({
            id: 1002,
            run_id: 100,
            run_attempt: 2,
            name: 'test (1, 2)',
            workflow_job_id: 'test',
            started_at: '2026-11-06T12:00:35Z',
            completed_at: '2026-11-06T12:01:05Z',
          }),
          makeJob({
            id: 1003,
            run_id: 100,
            run_attempt: 2,
            name: 'test (2, 2)',
            workflow_job_id: 'test',
            started_at: '2026-11-06T12:00:36Z',
            completed_at: '2026-11-06T12:01:10Z',
          }),
        ],
        '101:1': [
          makeJob({
            id: 2001,
            run_id: 101,
            name: 'verify-artifacts',
            created_at: '2026-11-06T12:01:15Z',
            started_at: '2026-11-06T12:01:16Z',
            completed_at: '2026-11-06T12:01:40Z',
          }),
        ],
      },
      artifactsByRun: {
        100: [
          {
            id: 501,
            run_id: 100,
            name: 'suggestions_1_2',
            size_in_bytes: 1024,
            sha256: 'art-sha-1',
            created_at: '2026-11-06T12:01:04Z',
            expired: false,
          },
          {
            id: 502,
            run_id: 100,
            name: 'suggestions_2_2',
            size_in_bytes: 1024,
            sha256: 'art-sha-2',
            created_at: '2026-11-06T12:01:09Z',
            expired: false,
          },
        ],
      },
    })

    const result = await collectSampleExecution({
      api,
      query: {
        sampleId: 's1',
        repetition: 1,
        scenarioName: 'pr-full',
        variant: 'starsling-patched',
        profileName: 'cold',
        event: 'pull_request',
        dispatchedAt: '2026-11-06T12:00:00Z',
        headSha: 'sha-target-123',
        targetBranch: 'bench/pr-head',
        defaultBranch: 'main',
        prNumber: 42,
        controllerStagingOverheadSeconds: 4,
      },
      scenarioInventory: multiWfScenarioInv,
      jobDependenciesByWorkflow: { '.github/workflows/ci.yml': { test: ['setup'] } },
    })

    expect(result.complete).toBe(false)
    expect(result.incompleteReasons.join()).toContain('Rerun requires')
    expect(result.workflows.length).toBe(2)
    expect(result.artifacts.length).toBe(2)

    const ciWf = result.workflows.find((w) => w.workflowPath === '.github/workflows/ci.yml')
    expect(ciWf?.runAttempt).toBe(2)
    expect(ciWf?.priorAttemptsCount).toBe(1)

    const shard1 = ciWf?.jobs.find((j) => j.jobName === 'test (1, 2)')
    expect(shard1?.dependencyWaitSeconds).toBe(22)
    expect(shard1?.runnerQueueSeconds).toBe(3)

    expect(result.metrics.wallClockSeconds).toBe(90)
    expect(result.metrics.prWallClockSeconds).toBe(90)
    expect(result.metrics.rawRunnerSeconds).toBe(108)
    expect(result.metrics.repoMinutes).toBeCloseTo(1.8)
    expect(result.metrics.triggerLatencySeconds).toBe(10)
    expect(result.metrics.harnessOverheadSeconds).toBe(5)
  })

  it('marks sample incomplete on missing late downstream workflow_run, cancelled jobs, or partial timestamps', async () => {
    const api = createMockPaginatedApi({
      runs: [
        makeRun({
          id: 200,
          name: 'CI',
          path: '.github/workflows/ci.yml',
          head_sha: 'sha-200',
          pr_numbers: [42],
          conclusion: 'cancelled',
        }),
      ],
      jobsByRunAttempt: {
        '200:1': [
          makeJob({
            id: 3001,
            run_id: 200,
            name: 'setup',
            conclusion: 'cancelled',
            completed_at: null,
          }),
        ],
      },
      artifactsByRun: {},
    })

    const res = await collectSampleExecution({
      api,
      query: {
        sampleId: 's-incomplete',
        repetition: 1,
        scenarioName: 'pr-full',
        variant: 'github-baseline',
        profileName: 'cold',
        event: 'pull_request',
        dispatchedAt: '2026-11-06T12:00:00Z',
        headSha: 'sha-200',
        targetBranch: 'bench/pr-head',
        defaultBranch: 'main',
        prNumber: 42,
      },
      scenarioInventory: multiWfScenarioInv,
    })

    expect(res.complete).toBe(false)
    expect(res.missingWorkflows).toContain('.github/workflows/downstream-verify.yml')
    expect(res.missingJobs).toContain('.github/workflows/ci.yml#test')
    expect(res.cancelledJobs).toEqual(['.github/workflows/ci.yml#setup'])
    expect(res.partialTimestampJobs).toEqual(['.github/workflows/ci.yml#setup'])
    expect(res.workflows[0]?.jobs[0]?.durationSeconds).toBeNull()
    expect(res.metrics.repoMinutes).toBeNull()
  })

  it('produces publishable 5-repetition four-way comparison reports, enforces cost neutrality, and runs the @actions/core reporting action', async () => {
    const config = defineBenchmarkConfig({
      schemaVersion: 1,
      upstream: { repository: 'org/app', commitSha: 'a'.repeat(40), defaultBranch: 'main' },
      benchmarkRepository: { repository: 'starsling-bench/app', controlBranch: 'bench/control', defaultBranch: 'main' },
      scenarios: {
        pr: {
          name: 'pr',
          description: 'PR',
          event: 'pull_request',
          pr: {
            prNumber: 1,
            baseRef: 'main',
            headRef: 'feat/x',
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            mergeSha: 'c'.repeat(40),
            activityType: 'synchronize',
            changedPaths: ['src/index.ts'],
            labels: [],
          },
          referenceRuns: [],
        },
      },
      patches: [],
      runnerMapping: createDefaultRunnerMapping(),
      profiles: createDefaultProfiles(),
      adaptations: [],
      collectors: [],
      execution: {
        repetitions: 5,
        timeoutMinutes: 30,
        maxConcurrentExperiments: 1,
        pollIntervalSeconds: 10,
        publicRepoGitHubFree: true,
      },
    })

    const manifest = createExperimentManifest({
      experimentId: 'exp-five-reps',
      config,
      scenarioNames: ['pr'],
      profileNames: ['cold'],
    })
    const variants: VariantId[] = ['github-baseline', 'github-patched', 'starsling-baseline', 'starsling-patched']
    expect(deterministicShuffleOrder(variants, 'exp-100:rep1')).toEqual(
      deterministicShuffleOrder(variants, 'exp-100:rep1'),
    )

    const makeSample = (
      rep: number,
      variant: VariantId,
      wallClockSeconds: number,
      jobDurationsSec: number[],
    ): SampleMeasurementResult => {
      const rawSec = jobDurationsSec.reduce((a, b) => a + b, 0)
      const label = variant.startsWith('starsling-') ? 'starsling-ubuntu-24.04' : 'ubuntu-24.04'
      return {
        sampleId: `exp-five-reps-pr-cold-rep${rep}-${variant}`,
        inputFingerprint: manifest.inputFingerprint,
        repetition: rep,
        scenarioName: 'pr',
        variant,
        profileName: 'cold',
        complete: true,
        incompleteReasons: [],
        missingWorkflows: [],
        missingJobs: [],
        cancelledJobs: [],
        failedJobs: [],
        partialTimestampJobs: [],
        timestampResolution: '1s',
        metrics: {
          repoMinutes: Number((rawSec / 60).toFixed(4)),
          rawRunnerSeconds: rawSec,
          wallClockSeconds,
          prWallClockSeconds: wallClockSeconds,
          mainWallClockSeconds: null,
          triggerLatencySeconds: 3,
          harnessOverheadSeconds: 1,
        },
        workflows: [
          {
            runId: 1000 + rep,
            runAttempt: 1,
            priorAttemptsCount: 0,
            workflowPath: '.github/workflows/ci.yml',
            workflowName: 'CI',
            event: 'pull_request',
            conclusion: 'success',
            durationSeconds: wallClockSeconds,
            startedAt: '2026-11-06T12:00:00Z',
            completedAt: '2026-11-06T12:02:00Z',
            htmlUrl: `https://github.com/starsling-bench/app/actions/runs/${1000 + rep}`,
            jobs: jobDurationsSec.map((dur, idx) => ({
              jobRecordId: idx + 1,
              runId: 1000 + rep,
              runAttempt: 1,
              workflowPath: '.github/workflows/ci.yml',
              jobName: `test-${idx + 1}`,
              logicalJobId: 'test',
              conclusion: 'success',
              durationSeconds: dur,
              dependencyWaitSeconds: 0,
              runnerQueueSeconds: 1,
              resolution: '1s',
              labels: [label],
              steps: [
                {
                  number: 1,
                  name: 'Run tests',
                  conclusion: 'success',
                  durationSeconds: dur,
                  resolution: '1s',
                  isHarnessInstrumentation: false,
                },
              ],
            })),
            artifacts: [],
          },
        ],
        artifacts: [],
      }
    }

    const samples: SampleMeasurementResult[] = []
    for (let rep = 1; rep <= 5; rep++) {
      samples.push(makeSample(rep, 'github-baseline', 120, [120]))
      samples.push(makeSample(rep, 'github-patched', 60, [60]))
      samples.push(makeSample(rep, 'starsling-baseline', 80, [80]))
      samples.push(makeSample(rep, 'starsling-patched', 40, [40]))
    }

    const dir = createTempDir('report-action')
    const jsonOut = join(dir, 'benchmark-report.v1.json')
    const csvOut = join(dir, 'benchmark-samples.v1.csv')

    const report = await runReportingAction({
      experimentId: 'exp-five-reps',
      manifest,
      config,
      samples,
      outputJsonPath: jsonOut,
      outputCsvPath: csvOut,
      failOnIncompleteOrParityError: false,
    })

    const comp = report.comparisons[0]
    expect(comp?.publishableHeadlineAllowed).toBe(false)
    expect(comp?.parityPassed).toBe(false)
    expect(comp?.completePairedRepetitions).toBe(5)
    expect(comp?.ratios.githubSameRunnerOptimizationRatio).toBe(2)
    expect(comp?.ratios.starslingSameRunnerOptimizationRatio).toBe(2)
    expect(comp?.ratios.baselineCrossRunnerRatio).toBe(1.5)
    expect(comp?.ratios.combinedOptimizationRatio).toBe(3)
    expect(comp?.costNeutrality.github.qualifiesAsCostNeutralAgentOptimization).toBe(false)
    expect(comp?.costNeutrality.starsling.qualifiesAsCostNeutralAgentOptimization).toBe(false)
    expect(comp?.variants['github-baseline'].billedUsd.median).toBe(0)
    expect(comp?.variants['github-patched'].billedUsd.median).toBe(0)
    expect(comp?.variants['starsling-patched'].billedUsd.median).toBeGreaterThan(0)
    expect(readFileSync(jsonOut, 'utf8')).toContain('"benchmark-report.v1"')
    expect(readFileSync(csvOut, 'utf8')).toContain('sample_id,repetition,scenario,profile,variant')

    const shardedSamples = samples.map((s) =>
      s.variant === 'github-patched' ? makeSample(s.repetition, 'github-patched', 40, [40, 40, 40, 40]) : s,
    )
    const shardedReport = generateExperimentReport({
      experimentId: 'exp-sharded',
      config,
      samples: shardedSamples,
    })
    const shardedComp = shardedReport.comparisons[0]
    expect(shardedComp?.costNeutrality.github.qualifiesAsCostNeutralAgentOptimization).toBe(false)
    expect(shardedComp?.costNeutrality.github.additionalShardsSpentSavings).toBe(true)
  })
})
