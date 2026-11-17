import { describe, expect, it } from 'vitest'
import {
  collectSampleExecution,
  type GitHubJobRecord,
  type GitHubWorkflowRunRecord,
  type PaginatedGitHubActionsApi,
} from '../src/collector.ts'
import { validateBenchmarkConfig } from '../src/config.ts'
import type { ScenarioInventory } from '../src/types.ts'
import fixtureConfig from './fixtures/definitelytyped.config.ts'

const WF = '.github/workflows/ci.yml'
const baseRun: GitHubWorkflowRunRecord = {
  id: 800,
  name: 'CI',
  path: WF,
  event: 'push',
  head_branch: 'main',
  head_sha: 'sha-x',
  run_number: 1,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-06T12:00:05Z',
  run_started_at: '2026-11-06T12:00:10Z',
  updated_at: '2026-11-06T12:30:00Z',
  html_url: 'https://github.com/org/repo/actions/runs/800',
}
const start = Date.parse('2026-11-06T12:00:10Z')
function job(name: string, id: number, endSeconds: number, conclusion: GitHubJobRecord['conclusion']): GitHubJobRecord {
  return {
    id,
    run_id: 800,
    run_attempt: 1,
    name,
    status: 'completed',
    conclusion,
    created_at: new Date(start).toISOString(),
    started_at: new Date(start + 1000).toISOString(),
    completed_at: new Date(start + endSeconds * 1000).toISOString(),
    labels: ['ubuntu-24.04'],
    runner_name: 'r',
    steps: [],
  }
}
const inventory: ScenarioInventory = {
  scenarioName: 'main-push',
  triggeredWorkflows: [WF],
  excludedWorkflows: [],
  downstreamWorkflowRuns: [],
  jobExpectations: ['build', 'lychee'].map((jobId) => ({
    workflowFile: WF,
    workflowName: 'CI',
    jobId,
    triggeredBy: 'direct' as const,
    expectedStatus: 'executed' as const,
    isDynamicMatrix: false,
    mappedRunsOn: { github: 'ubuntu-24.04', starsling: 'starsling-ubuntu-24.04', retainedOnGitHub: false },
  })),
  mixedRunnerOnStarSling: false,
  movedJobs: [],
  retainedJobs: [],
  blockers: [],
}
const api = (
  jobs: GitHubJobRecord[],
  conclusion: GitHubWorkflowRunRecord['conclusion'],
): PaginatedGitHubActionsApi => ({
  listWorkflowRunsPage: async () => ({ runs: [{ ...baseRun, conclusion }], hasNextPage: false }),
  listJobsForRunAttemptPage: async () => ({ jobs, hasNextPage: false }),
  listRunArtifactsPage: async () => ({ artifacts: [], hasNextPage: false }),
})
const query = {
  sampleId: 's-ex',
  repetition: 1,
  scenarioName: 'main-push',
  variant: 'github-baseline' as const,
  profileName: 'cold',
  event: 'push',
  dispatchedAt: '2026-11-06T12:00:00Z',
  headSha: 'sha-x',
  targetBranch: 'main',
  defaultBranch: 'main',
}
const excludedJobs = [{ workflowFile: WF, jobId: 'lychee', reason: 'red on every branch upstream' }]

describe('excluded jobs run but do not gate or time a sample', () => {
  it('without the setting, a failing job makes the sample incomplete (control)', async () => {
    const r = await collectSampleExecution({
      api: api([job('build', 1, 60, 'success'), job('lychee', 2, 600, 'failure')], 'failure'),
      query,
      scenarioInventory: inventory,
    })
    expect(r.complete).toBe(false)
    expect(r.failedJobs).toEqual([`${WF}#lychee`])
  })

  it('a failing excluded job leaves the sample complete, with no failed job and no unsuccessful workflow', async () => {
    const r = await collectSampleExecution({
      api: api([job('build', 1, 60, 'success'), job('lychee', 2, 600, 'failure')], 'failure'),
      query,
      scenarioInventory: inventory,
      excludedJobs,
    })
    expect(r.incompleteReasons).toEqual([])
    expect(r.complete).toBe(true)
    expect(r.failedJobs).toEqual([])
  })

  it('records the excluded job, marked, with its real conclusion and duration', async () => {
    const r = await collectSampleExecution({
      api: api([job('build', 1, 60, 'success'), job('lychee', 2, 600, 'failure')], 'failure'),
      query,
      scenarioInventory: inventory,
      excludedJobs,
    })
    const jobs = r.workflows[0]?.jobs ?? []
    const lychee = jobs.find((j) => j.logicalJobId === 'lychee')
    expect(lychee?.excluded).toBe(true)
    expect(lychee?.conclusion).toBe('failure')
    expect(lychee?.durationSeconds).toBe(599)
    expect(jobs.find((j) => j.logicalJobId === 'build')?.excluded).toBeUndefined()
    expect(r.excludedJobs).toEqual([{ job: `${WF}#lychee`, conclusion: 'failure', reason: excludedJobs[0]?.reason }])
  })

  it('keeps the excluded job out of the wall clock (ends 540 s after the last timed job)', async () => {
    const r = await collectSampleExecution({
      api: api([job('build', 1, 60, 'success'), job('lychee', 2, 600, 'failure')], 'failure'),
      query,
      scenarioInventory: inventory,
      excludedJobs,
    })
    expect(r.metrics.wallClockSeconds).toBe(60)
    expect(r.workflows[0]?.durationSeconds).toBe(60)
  })

  it('still fails a sample when a job that is not excluded fails', async () => {
    const r = await collectSampleExecution({
      api: api([job('build', 1, 60, 'failure'), job('lychee', 2, 600, 'failure')], 'failure'),
      query,
      scenarioInventory: inventory,
      excludedJobs,
    })
    expect(r.complete).toBe(false)
    expect(r.failedJobs).toEqual([`${WF}#build`])
  })

  it('still waits for an excluded job that has not finished, and still requires it to run', async () => {
    const running = { ...job('lychee', 2, 600, null), status: 'in_progress' as const, completed_at: null }
    const waiting = await collectSampleExecution({
      api: api([job('build', 1, 60, 'success'), running], 'success'),
      query,
      scenarioInventory: inventory,
      excludedJobs,
    })
    expect(waiting.complete).toBe(false)
    const absent = await collectSampleExecution({
      api: api([job('build', 1, 60, 'success')], 'success'),
      query,
      scenarioInventory: inventory,
      excludedJobs,
    })
    expect(absent.missingJobs).toEqual([`${WF}#lychee`])
  })

  it('accepts execution.excludedJobs in config and rejects an entry without a reason', () => {
    const ok = { ...fixtureConfig, execution: { ...fixtureConfig.execution, excludedJobs } }
    expect(validateBenchmarkConfig(ok).some((b) => b.id === 'invalid-execution-limits')).toBe(false)
    const bad = {
      ...fixtureConfig,
      execution: { ...fixtureConfig.execution, excludedJobs: [{ workflowFile: WF, jobId: 'lychee', reason: '' }] },
    }
    expect(validateBenchmarkConfig(bad).some((b) => b.id === 'invalid-execution-limits')).toBe(true)
  })
})
