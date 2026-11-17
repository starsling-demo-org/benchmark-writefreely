import type {
  GitHubArtifactRecord,
  GitHubJobRecord,
  GitHubWorkflowRunRecord,
  PaginatedGitHubActionsApi,
} from './collector.ts'

export async function fetchAllPaginatedRuns(
  api: PaginatedGitHubActionsApi,
  perPage = 50,
): Promise<GitHubWorkflowRunRecord[]> {
  const all: GitHubWorkflowRunRecord[] = []
  let page = 1
  while (true) {
    const res = await api.listWorkflowRunsPage({ page, perPage })
    all.push(...res.runs)
    if (!res.hasNextPage || res.runs.length === 0) break
    page += 1
  }
  return all
}

export async function fetchAllPaginatedJobs(
  api: PaginatedGitHubActionsApi,
  runId: number,
  attempt: number,
  perPage = 50,
): Promise<GitHubJobRecord[]> {
  const all: GitHubJobRecord[] = []
  let page = 1
  while (true) {
    const res = await api.listJobsForRunAttemptPage({ runId, attempt, page, perPage })
    all.push(...res.jobs)
    if (!res.hasNextPage || res.jobs.length === 0) break
    page += 1
  }
  return all
}

export async function fetchAllPaginatedArtifacts(
  api: PaginatedGitHubActionsApi,
  runId: number,
  perPage = 50,
): Promise<GitHubArtifactRecord[]> {
  const all: GitHubArtifactRecord[] = []
  let page = 1
  while (true) {
    const res = await api.listRunArtifactsPage({ runId, page, perPage })
    all.push(...res.artifacts)
    if (!res.hasNextPage || res.artifacts.length === 0) break
    page += 1
  }
  return all
}
