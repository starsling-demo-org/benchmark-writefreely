import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ApiBudget } from './api-budget.ts'
import type {
  GitHubArtifactRecord,
  GitHubJobRecord,
  GitHubWorkflowRunRecord,
  PaginatedGitHubActionsApi,
} from './collector.ts'

export type JsonObject = Record<string, unknown>
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
  return value as JsonObject
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected JSON array')
  return value
}
interface HttpResponse {
  status: number | undefined
  headers: Map<string, string>
  body: string
}
/** Split `gh api -i` output into status, lower-cased headers and body. Output without a status line is all body. */
export function splitHttpResponse(raw: string): HttpResponse {
  const headers = new Map<string, string>()
  if (!/^HTTP\/\d/.test(raw)) return { status: undefined, headers, body: raw }
  const split = /\r?\n\r?\n/.exec(raw)
  const head = split ? raw.slice(0, split.index) : raw
  const body = split ? raw.slice(split.index + split[0].length) : ''
  const [statusLine = '', ...lines] = head.split(/\r?\n/)
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1])
  return { status: Number.isFinite(status) && status > 0 ? status : undefined, headers, body }
}
function rateLimitOf(headers: Map<string, string>): { limit?: number; remaining?: number; resetEpochSeconds?: number } {
  const limit = headers.get('x-ratelimit-limit')
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  return {
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(remaining !== undefined ? { remaining: Number(remaining) } : {}),
    ...(reset !== undefined ? { resetEpochSeconds: Number(reset) } : {}),
  }
}
export class GitHubClient {
  readonly repository: string
  readonly evidenceDir: string | undefined
  private sequence = 0
  private token: string | undefined
  /** Attempts for a read that fails transiently (no response, 5xx, 429, rate limit), with doubling delays. */
  retryAttempts = 5
  retryDelayMs = 2_000
  readonly budget: ApiBudget
  constructor(repository: string, evidenceDir?: string, budget: ApiBudget = new ApiBudget()) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Expected owner/repository')
    this.repository = repository
    this.evidenceDir = evidenceDir
    this.budget = budget
  }
  /** Wait `ms`, stretched so this controller stays within its hourly call budget. */
  async pause(ms: number): Promise<void> {
    await this.budget.pause(ms)
  }
  /** Stored answers by endpoint, to ask GitHub "has this changed?" (a 304 is free) instead of fetching it again. */
  private readonly etags = new Map<string, { etag: string; data: unknown }>()
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    // gh owns credential retrieval; credentials never enter report files or workload environments.
    const endpoint = path.startsWith('/') ? path.slice(1) : `repos/${this.repository}${path ? `/${path}` : ''}`
    // -i puts the response headers (ETag, rate limit) in front of the body.
    const args = [
      'api',
      endpoint,
      '-i',
      '--method',
      method,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
    ]
    const stored = method === 'GET' ? this.etags.get(endpoint) : undefined
    if (stored) args.push('-H', `If-None-Match: ${stored.etag}`)
    if (body !== undefined) args.push('--input', '-')
    let response: HttpResponse
    let data: unknown
    for (let attempt = 1; ; attempt++) {
      await this.budget.waitForAccountHeadroom()
      let recorded = false
      try {
        const raw = execFileSync('gh', args, {
          encoding: 'utf8',
          input: body === undefined ? undefined : JSON.stringify(body),
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
          timeout: 60_000,
        })
        response = splitHttpResponse(raw)
        this.budget.record({ endpoint, method })
        recorded = true
        this.budget.observeRateLimit(rateLimitOf(response.headers))
        data = response.body.trim() ? JSON.parse(response.body) : null
        break
      } catch (error) {
        const failed = splitHttpResponse(String((error as { stdout?: unknown }).stdout ?? ''))
        if (failed.status === 304 && stored) {
          this.budget.record({ endpoint, method, notModified: true })
          this.budget.observeRateLimit(rateLimitOf(failed.headers))
          response = failed
          data = stored.data
          break
        }
        // A request that never got a response (or whose answer could not be read) may still have been charged.
        if (!recorded) this.budget.record({ endpoint, method })
        this.budget.observeRateLimit(rateLimitOf(failed.headers))
        let detail = 'request failed'
        let status: number | undefined
        try {
          const parsed = object(JSON.parse(failed.body))
          if (typeof parsed.message === 'string') detail = parsed.message
          if (parsed.status) {
            status = Number(parsed.status)
            detail += ` (HTTP ${String(parsed.status)})`
          }
        } catch {
          if (error instanceof Error) detail = error.message.split('\n')[0] ?? detail
        }
        // A read is safe to repeat. A write whose response was lost may have happened (a dispatch, a PR), so it is
        // never retried; its caller's journal decides. 4xx answers are real answers, not transient failures.
        const transient = status === undefined || status >= 500 || status === 429 || /rate limit/i.test(detail)
        if (method !== 'GET' || !transient || attempt >= this.retryAttempts)
          throw new Error(`GitHub ${method} ${endpoint} failed: ${detail}`)
        await delay(this.retryDelayMs * 2 ** (attempt - 1))
      }
    }
    const etag = response.headers.get('etag')
    if (method === 'GET' && etag && response.status !== 304) {
      this.etags.delete(endpoint)
      this.etags.set(endpoint, { etag, data })
      if (this.etags.size > 500) this.etags.delete(this.etags.keys().next().value as string)
    }
    if (this.evidenceDir) {
      mkdirSync(this.evidenceDir, { recursive: true })
      writeFileSync(
        join(this.evidenceDir, `${Date.now()}-${this.sequence++}.json`),
        JSON.stringify({ retrievedAt: new Date().toISOString(), method, endpoint, data }, null, 2),
      )
    }
    return data
  }
  async text(path: string): Promise<string> {
    await this.budget.waitForAccountHeadroom()
    this.budget.record({ endpoint: `repos/${this.repository}${path ? `/${path}` : ''}` })
    return execFileSync(
      'gh',
      ['api', '--allow-escape-sequences', `repos/${this.repository}${path ? `/${path}` : ''}`],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  }
  /**
   * Download a job log. The API answers with a redirect to blob storage; fetch drops the Authorization header
   * on that cross-origin hop, so the token never reaches the storage host.
   */
  async downloadJobLog(jobId: number): Promise<string> {
    this.token ??=
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const token = this.token
    for (let attempt = 1; ; attempt++) {
      await this.budget.waitForAccountHeadroom()
      this.budget.record({ endpoint: `repos/${this.repository}/actions/jobs/${jobId}/logs` })
      const response = await fetch(`https://api.github.com/repos/${this.repository}/actions/jobs/${jobId}/logs`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      })
      if (response.ok) return response.text()
      if (attempt >= 4 || response.status === 404) throw new Error(`Job log ${jobId}: HTTP ${response.status}`)
      await delay(attempt * 5000)
    }
  }
  /**
   * Workflow runs created on or after `since` (ISO date or timestamp; '' for all). Lists newest first without a
   * filter and stops past `since`: GitHub caps filtered run searches, `created` included, at 1,000 results.
   */
  async runsCreatedSince(since: string): Promise<JsonObject[]> {
    const runs = new Map<number, JsonObject>()
    for (let page = 1; ; page++) {
      const items = array(object(await this.request(`actions/runs?per_page=100&page=${page}`)).workflow_runs).map(
        object,
      )
      // New runs shift pages while listing; the map drops the duplicates that causes.
      for (const run of items) if (String(run.created_at) >= since) runs.set(Number(run.id), run)
      if (items.length < 100 || items.some((run) => String(run.created_at) < since)) return [...runs.values()]
    }
  }
  async all(path: string, field?: string): Promise<unknown[]> {
    const result: unknown[] = []
    for (let page = 1; ; page++) {
      const data = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      const items = array(field ? object(data)[field] : data)
      result.push(...items)
      if (items.length < 100) return result
      if (page >= 1000) throw new Error('Pagination limit exceeded; collection incomplete')
    }
  }
}
export const nullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
/** The read-only slice of the client that discovery and reference fetching need (tests pass fakes). */
export type GitHubReader = Pick<GitHubClient, 'request' | 'all'>
export class GitHubActionsApi implements PaginatedGitHubActionsApi {
  readonly client: GitHubClient
  readonly parentRunIds: Record<string, number>
  readonly logicalJobIds: Record<string, string>
  readonly createdAfter: string | undefined
  private readonly jobContexts = new Map<number, { parentRunId?: number; logicalJobId?: string }>()

  // A completed job record is immutable. Both correlation paths share its observation,
  // including an empty context, so polling never repeatedly downloads the same log.
  private async jobContext(jobId: number): Promise<{ parentRunId?: number; logicalJobId?: string }> {
    const cached = this.jobContexts.get(jobId)
    if (cached) return cached
    const logs = await this.client.text(`actions/jobs/${jobId}/logs`)
    const parent = /BENCH_PARENT_RUN_ID=(\d+)/.exec(logs)?.[1]
    const logical = /BENCH_JOB_ID=([a-zA-Z0-9_-]+)/.exec(logs)?.[1]
    const context = {
      ...(parent ? { parentRunId: Number(parent) } : {}),
      ...(logical ? { logicalJobId: logical } : {}),
    }
    this.jobContexts.set(jobId, context)
    if (logical) this.logicalJobIds[String(jobId)] = logical
    return context
  }
  constructor(
    client: GitHubClient,
    enrichment: {
      createdAfter?: string
      parentRunIds?: Record<string, number>
      logicalJobIds?: Record<string, string>
    } = {},
  ) {
    this.client = client
    this.createdAfter = enrichment.createdAfter
    this.parentRunIds = enrichment.parentRunIds ?? {}
    this.logicalJobIds = enrichment.logicalJobIds ?? {}
  }
  async listWorkflowRunsPage({
    page,
    perPage,
  }: {
    page: number
    perPage: number
  }): Promise<{ runs: GitHubWorkflowRunRecord[]; hasNextPage: boolean }> {
    const data = object(
      await this.client.request(
        `actions/runs?per_page=${perPage}&page=${page}${this.createdAfter ? `&created=${encodeURIComponent(`>=${this.createdAfter}`)}` : ''}`,
      ),
    )
    const runs = array(data.workflow_runs).map((raw) => {
      const r = object(raw)
      return {
        id: Number(r.id),
        name: String(r.name),
        path: String(r.path).split('@')[0] ?? '',
        event: String(r.event),
        head_branch: String(r.head_branch),
        head_sha: String(r.head_sha),
        pr_numbers: array(r.pull_requests ?? []).map((pr) => Number(object(pr).number)),
        run_number: Number(r.run_number),
        run_attempt: Number(r.run_attempt),
        status: r.status as GitHubWorkflowRunRecord['status'],
        conclusion: r.conclusion as GitHubWorkflowRunRecord['conclusion'],
        created_at: String(r.created_at),
        run_started_at: nullableString(r.run_started_at),
        updated_at: String(r.updated_at),
        html_url: String(r.html_url),
        ...(this.parentRunIds[String(r.id)] !== undefined
          ? { triggering_run_id: this.parentRunIds[String(r.id)] ?? 0 }
          : {}),
      }
    })
    for (const run of runs) {
      if (run.event !== 'workflow_run' || run.triggering_run_id !== undefined || run.status !== 'completed') continue
      const jobs = await this.client.all(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs')
      for (const raw of jobs) {
        const job = object(raw)
        if (job.status !== 'completed' || job.conclusion === 'skipped') continue
        const { parentRunId } = await this.jobContext(Number(job.id))
        if (parentRunId !== undefined) {
          run.triggering_run_id = parentRunId
          this.parentRunIds[String(run.id)] = parentRunId
          break
        }
      }
    }
    return { runs, hasNextPage: runs.length === perPage }
  }
  async listJobsForRunAttemptPage({
    runId,
    attempt,
    page,
    perPage,
  }: {
    runId: number
    attempt: number
    page: number
    perPage: number
  }): Promise<{ jobs: GitHubJobRecord[]; hasNextPage: boolean }> {
    const data = object(
      await this.client.request(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${perPage}&page=${page}`),
    )
    const jobs = array(data.jobs).map((raw) => {
      const j = object(raw)
      return {
        id: Number(j.id),
        run_id: runId,
        run_attempt: attempt,
        name: String(j.name),
        status: j.status as GitHubJobRecord['status'],
        conclusion: j.conclusion as GitHubJobRecord['conclusion'],
        created_at: nullableString(j.created_at),
        started_at: nullableString(j.started_at),
        completed_at: nullableString(j.completed_at),
        labels: array(j.labels).map(String),
        runner_name: nullableString(j.runner_name),
        ...(this.logicalJobIds[String(j.id)] ? { workflow_job_id: this.logicalJobIds[String(j.id)] ?? '' } : {}),
        steps: array(j.steps ?? []).map((rawStep) => {
          const s = object(rawStep)
          return {
            number: Number(s.number),
            name: String(s.name),
            status: s.status as GitHubJobRecord['steps'][number]['status'],
            conclusion: s.conclusion as GitHubJobRecord['steps'][number]['conclusion'],
            started_at: nullableString(s.started_at),
            completed_at: nullableString(s.completed_at),
          }
        }),
      }
    })
    for (const job of jobs) {
      if (job.workflow_job_id || job.status !== 'completed' || job.conclusion === 'skipped') continue
      const { logicalJobId } = await this.jobContext(job.id)
      if (logicalJobId) job.workflow_job_id = logicalJobId
    }
    return { jobs, hasNextPage: jobs.length === perPage }
  }
  async listRunArtifactsPage({
    runId,
    page,
    perPage,
  }: {
    runId: number
    page: number
    perPage: number
  }): Promise<{ artifacts: GitHubArtifactRecord[]; hasNextPage: boolean }> {
    const data = object(await this.client.request(`actions/runs/${runId}/artifacts?per_page=${perPage}&page=${page}`))
    const artifacts = array(data.artifacts).map((raw) => {
      const a = object(raw)
      return {
        id: Number(a.id),
        run_id: runId,
        name: String(a.name),
        size_in_bytes: Number(a.size_in_bytes),
        sha256: typeof a.digest === 'string' ? a.digest.replace(/^sha256:/, '') : '',
        created_at: String(a.created_at),
        expired: a.expired === true,
      }
    })
    return { artifacts, hasNextPage: artifacts.length === perPage }
  }
}
