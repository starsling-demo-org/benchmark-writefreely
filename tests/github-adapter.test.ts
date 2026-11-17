import { describe, expect, it } from 'vitest'
import { GitHubActionsApi, GitHubClient } from '../src/github.ts'

class RecordedGitHub extends GitHubClient {
  readonly requests: string[] = []
  constructor() {
    super('fixture/repo')
  }
  override async request(path: string): Promise<unknown> {
    this.requests.push(path)
    if (path.startsWith('actions/runs?'))
      return {
        workflow_runs: [
          {
            id: 12,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            event: 'push',
            head_branch: 'main',
            head_sha: 'a'.repeat(40),
            pull_requests: [],
            run_number: 1,
            run_attempt: 1,
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-11-06T00:00:00Z',
            run_started_at: null,
            updated_at: '2026-11-06T00:01:00Z',
            html_url: 'https://github.com/fixture/repo/actions/runs/12',
          },
        ],
      }
    if (path.includes('/jobs'))
      return {
        jobs: [
          {
            id: 23,
            name: 'Custom display name',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-11-06T00:00:00Z',
            completed_at: '2026-11-06T00:01:00Z',
            labels: ['ubuntu-24.04'],
            runner_name: 'GitHub Actions 1',
            steps: [],
          },
        ],
      }
    return { artifacts: [] }
  }
  override async text(): Promise<string> {
    return '2026-11-06T00:00:01Z BENCH_JOB_ID=test\n'
  }
}
describe('documented GitHub payload normalization', () => {
  it('keeps absent timestamps unknown and enriches job IDs from captured context', async () => {
    const client = new RecordedGitHub()
    const api = new GitHubActionsApi(client)
    const runs = await api.listWorkflowRunsPage({ page: 1, perPage: 100 })
    expect(runs.runs[0]?.run_started_at).toBeNull()
    expect(runs.runs[0]?.triggering_run_id).toBeUndefined()
    const jobs = await api.listJobsForRunAttemptPage({ runId: 12, attempt: 1, page: 1, perPage: 100 })
    expect(jobs.jobs[0]?.workflow_job_id).toBe('test')
    expect(jobs.jobs[0]?.created_at).toBeNull()
    expect(client.requests).toContain('actions/runs/12/attempts/1/jobs?per_page=100&page=1')
  })
})

class CascadingGitHub extends GitHubClient {
  readonly logReads: number[] = []
  readonly requests: string[] = []
  constructor() {
    super('fixture/repo')
  }
  override async request(path: string): Promise<unknown> {
    this.requests.push(path)
    if (path.startsWith('actions/runs?'))
      return { workflow_runs: [{ id: 12, event: 'workflow_run', status: 'completed', run_attempt: 1 }] }
    if (path.includes('/jobs?')) {
      const page = new URLSearchParams(path.split('?')[1]).get('page')
      const ids = page === '1' ? Array.from({ length: 100 }, (_, index) => index + 1) : [101, 102]
      return {
        jobs: ids.map((id) => ({
          id,
          name: `job ${id}`,
          status: 'completed',
          conclusion: id <= 100 ? 'skipped' : 'success',
          labels: ['ubuntu-24.04'],
        })),
      }
    }
    throw new Error(`Unexpected request ${path}`)
  }
  override async text(path: string): Promise<string> {
    const id = Number(path.split('/')[2])
    this.logReads.push(id)
    return id === 101 ? 'BENCH_PARENT_RUN_ID=11\nBENCH_JOB_ID=verify\n' : 'No harness context'
  }
}

it('shares immutable job context across downstream discovery, job collection and repeated polling', async () => {
  const client = new CascadingGitHub()
  const api = new GitHubActionsApi(client)
  const runs = await api.listWorkflowRunsPage({ page: 1, perPage: 100 })
  expect(runs.runs[0]?.triggering_run_id).toBe(11)
  expect(client.requests).toContain('actions/runs/12/attempts/1/jobs?per_page=100&page=2')
  const jobs = await api.listJobsForRunAttemptPage({ runId: 12, attempt: 1, page: 2, perPage: 100 })
  expect(jobs.jobs[0]?.workflow_job_id).toBe('verify')
  expect(jobs.jobs[1]?.workflow_job_id).toBeUndefined()
  await api.listWorkflowRunsPage({ page: 1, perPage: 100 })
  await api.listJobsForRunAttemptPage({ runId: 12, attempt: 1, page: 2, perPage: 100 })
  expect(client.logReads).toEqual([101, 102])
  expect(client.requests.filter((path) => path.endsWith('jobs?per_page=100&page=1'))).toHaveLength(1)
})
