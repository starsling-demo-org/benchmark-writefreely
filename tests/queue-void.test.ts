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

const run: GitHubWorkflowRunRecord = {
  id: 700,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'push',
  head_branch: 'main',
  head_sha: 'sha-q',
  run_number: 1,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-06T12:00:05Z',
  run_started_at: '2026-11-06T12:00:10Z',
  updated_at: '2026-11-06T12:05:00Z',
  html_url: 'https://github.com/org/repo/actions/runs/700',
}

function jobQueued(name: string, id: number, queuedSeconds: number, label: string): GitHubJobRecord {
  const created = Date.parse('2026-11-06T12:00:10Z')
  return {
    id,
    run_id: 700,
    run_attempt: 1,
    name,
    status: 'completed',
    conclusion: 'success',
    created_at: new Date(created).toISOString(),
    started_at: new Date(created + queuedSeconds * 1000).toISOString(),
    completed_at: new Date(created + queuedSeconds * 1000 + 60_000).toISOString(),
    labels: [label],
    runner_name: 'r',
    steps: [],
  }
}

const inventory: ScenarioInventory = {
  scenarioName: 'main-push',
  triggeredWorkflows: ['.github/workflows/ci.yml'],
  excludedWorkflows: [],
  downstreamWorkflowRuns: [],
  jobExpectations: ['build', 'test'].map((jobId) => ({
    workflowFile: '.github/workflows/ci.yml',
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

function apiWith(jobs: GitHubJobRecord[]): PaginatedGitHubActionsApi {
  return {
    listWorkflowRunsPage: async () => ({ runs: [run], hasNextPage: false }),
    listJobsForRunAttemptPage: async () => ({ jobs, hasNextPage: false }),
    listRunArtifactsPage: async () => ({ artifacts: [], hasNextPage: false }),
  }
}

const query = {
  sampleId: 's-queue',
  repetition: 1,
  scenarioName: 'main-push',
  variant: 'github-baseline' as const,
  profileName: 'cold',
  event: 'push',
  dispatchedAt: '2026-11-06T12:00:00Z',
  headSha: 'sha-q',
  targetBranch: 'main',
  defaultBranch: 'main',
}

describe('queue-time void rule', () => {
  it('voids a sample whose job queued 45 s for a runner, naming the label', async () => {
    const result = await collectSampleExecution({
      api: apiWith([jobQueued('build', 1, 2, 'ubuntu-24.04'), jobQueued('test', 2, 45, 'ubuntu-24.04-large')]),
      query,
      scenarioInventory: inventory,
    })
    expect(result.complete).toBe(false)
    expect(result.incompleteReasons).toContain('queued 45 s for a runner (label ubuntu-24.04-large)')
    expect(result.metrics.maxJobQueueSeconds).toBe(45)
    expect(result.metrics.maxJobQueueLabel).toBe('ubuntu-24.04-large')
  })

  it('keeps a sample whose slowest queue was 20 s, and still records it', async () => {
    const result = await collectSampleExecution({
      api: apiWith([jobQueued('build', 1, 20, 'ubuntu-24.04'), jobQueued('test', 2, 3, 'ubuntu-24.04')]),
      query,
      scenarioInventory: inventory,
    })
    expect(result.complete).toBe(true)
    expect(result.incompleteReasons).toEqual([])
    expect(result.metrics.maxJobQueueSeconds).toBe(20)
    expect(result.metrics.maxJobQueueLabel).toBe('ubuntu-24.04')
  })

  it('takes the threshold from the caller: 45 s passes under a 60 s limit, 20 s fails under a 10 s limit', async () => {
    const lenient = await collectSampleExecution({
      api: apiWith([jobQueued('build', 1, 45, 'ubuntu-24.04'), jobQueued('test', 2, 1, 'ubuntu-24.04')]),
      query,
      scenarioInventory: inventory,
      maxJobQueueSeconds: 60,
    })
    expect(lenient.complete).toBe(true)
    const strict = await collectSampleExecution({
      api: apiWith([jobQueued('build', 1, 20, 'ubuntu-24.04'), jobQueued('test', 2, 1, 'ubuntu-24.04')]),
      query,
      scenarioInventory: inventory,
      maxJobQueueSeconds: 10,
    })
    expect(strict.complete).toBe(false)
    expect(strict.incompleteReasons.join()).toContain('queued 20 s for a runner (label ubuntu-24.04)')
  })

  it('accepts execution.maxJobQueueSeconds in config and rejects a negative value', () => {
    const ok = { ...fixtureConfig, execution: { ...fixtureConfig.execution, maxJobQueueSeconds: 45 } }
    expect(validateBenchmarkConfig(ok).some((b) => b.id === 'invalid-execution-limits')).toBe(false)
    const bad = { ...fixtureConfig, execution: { ...fixtureConfig.execution, maxJobQueueSeconds: -1 } }
    expect(validateBenchmarkConfig(bad).some((b) => b.id === 'invalid-execution-limits')).toBe(true)
  })
})
