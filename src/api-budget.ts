import { setTimeout as sleepFor } from 'node:timers/promises'

/**
 * One controller's share of the GitHub API. Many controllers can run on one machine under one GitHub account, and
 * the account has a single hourly allowance (5,000 REST calls), so each controller counts what it spends and paces
 * itself. Pacing only ever lengthens a wait between observations; no check is skipped.
 */
export interface ApiUsage {
  /** Requests that reached GitHub and were charged (a 304 Not Modified is counted separately: it is free). */
  calls: number
  notModified: number
  graphql: number
  byCategory: Record<string, number>
  /** Time spent waiting beyond the plain interval to stay within `apiBudgetPerHour`. */
  throttledMs: number
  /** Time spent waiting for the account's rate limit to reset. */
  rateLimitWaitMs: number
}
export interface ExperimentApiUsage {
  budgetPerHour: number
  /** Everything the controller called during the experiment, setup and recovery included. */
  experiment: ApiUsage
  samples: Record<string, ApiUsage>
}

export const DEFAULT_API_BUDGET_PER_HOUR = 300
/** Below this share of the account's hourly allowance, every controller on the account waits for the reset. */
export const ACCOUNT_RESERVE_FRACTION = 0.15
/** Slowest adaptive poll: a queued or running workflow is looked at least this often (unless configured slower). */
export const POLL_BACKOFF_CAP_MS = 120_000
const HOUR_MS = 3_600_000

export const emptyUsage = (): ApiUsage => ({
  calls: 0,
  notModified: 0,
  graphql: 0,
  byCategory: {},
  throttledMs: 0,
  rateLimitWaitMs: 0,
})
export function addUsage(target: ApiUsage, delta: ApiUsage): ApiUsage {
  target.calls += delta.calls
  target.notModified += delta.notModified
  target.graphql += delta.graphql
  target.throttledMs += delta.throttledMs
  target.rateLimitWaitMs += delta.rateLimitWaitMs
  for (const [category, count] of Object.entries(delta.byCategory))
    target.byCategory[category] = (target.byCategory[category] ?? 0) + count
  return target
}

/** The kind of request an endpoint is, for the "biggest callers" breakdown. */
export function categorize(endpoint: string, method = 'GET'): string {
  const path = endpoint.replace(/^repos\/[^/]+\/[^/]+\/?/, '').split('?')[0] ?? ''
  if (path.includes('/logs')) return 'job-logs'
  if (/^actions\/runs\/\d+\/(attempts\/\d+\/)?jobs$/.test(path)) return 'jobs'
  if (/^actions\/runs\/\d+\/artifacts$/.test(path)) return 'artifacts'
  if (path === 'actions/runs') return 'run-list'
  if (/^actions\/runs\/\d+/.test(path)) return method === 'GET' ? 'run-read' : 'run-write'
  if (/^actions\/workflows\/\d+\/(enable|disable|dispatches)$/.test(path)) return 'workflow-write'
  if (path.startsWith('actions/workflows')) return 'workflows'
  if (path.startsWith('actions/caches')) return method === 'GET' ? 'caches' : 'cache-delete'
  return method === 'GET' ? 'other-read' : 'other-write'
}

/**
 * Poll interval that grows while nothing changes (15 s, 30 s, 60 s, 120 s) and returns to the base when something
 * does. A base above the cap is honored as configured.
 */
export class AdaptiveInterval {
  private readonly baseMs: number
  private readonly capMs: number
  private current = 0
  constructor(baseMs: number, capMs = POLL_BACKOFF_CAP_MS) {
    this.baseMs = baseMs
    this.capMs = Math.max(baseMs, capMs)
  }
  next(changed: boolean): number {
    this.current = changed || this.current === 0 ? this.baseMs : Math.min(this.capMs, this.current * 2)
    return this.current
  }
}

export interface ApiBudgetOptions {
  perHour?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export class ApiBudget {
  readonly perHour: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (line: string) => void
  private readonly usage = emptyUsage()
  /** Times of the charged calls within the last hour. */
  private window: number[] = []
  private cycleStart = 0
  private rateLimit: { limit: number; remaining: number; resetMs: number } | undefined
  constructor(options: ApiBudgetOptions = {}) {
    this.perHour = options.perHour ?? DEFAULT_API_BUDGET_PER_HOUR
    if (!Number.isFinite(this.perHour) || this.perHour <= 0) throw new Error('apiBudgetPerHour must be positive')
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => sleepFor(ms))
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
  }
  record(call: { endpoint: string; method?: string; notModified?: boolean; graphql?: boolean }): void {
    if (call.notModified) {
      this.usage.notModified++
      return
    }
    this.usage.calls++
    if (call.graphql) this.usage.graphql++
    const category = call.graphql ? 'graphql' : categorize(call.endpoint, call.method)
    this.usage.byCategory[category] = (this.usage.byCategory[category] ?? 0) + 1
    this.window.push(this.now())
  }
  /** Remember the account-wide allowance GitHub reported on the latest response (shared by every controller). */
  observeRateLimit(headers: { limit?: number; remaining?: number; resetEpochSeconds?: number }): void {
    const { limit, remaining, resetEpochSeconds } = headers
    if (limit === undefined || remaining === undefined || resetEpochSeconds === undefined) return
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(resetEpochSeconds)) return
    this.rateLimit = { limit, remaining, resetMs: resetEpochSeconds * 1000 }
  }
  /** Before a request: when the whole account is nearly spent, wait for its reset instead of exhausting it. */
  async waitForAccountHeadroom(): Promise<void> {
    const state = this.rateLimit
    if (!state || state.limit <= 0 || state.remaining / state.limit >= ACCOUNT_RESERVE_FRACTION) return
    const waitMs = state.resetMs - this.now() + 1_000
    this.rateLimit = undefined // the next response says what the new window holds
    if (waitMs <= 0) return
    this.log(
      `[api-budget] account rate limit low (${state.remaining}/${state.limit} left, under ${Math.round(ACCOUNT_RESERVE_FRACTION * 100)}%); waiting ${Math.ceil(waitMs / 1000)} s for the reset`,
    )
    this.usage.rateLimitWaitMs += waitMs
    await this.sleep(waitMs)
  }
  private prune(): void {
    const cutoff = this.now() - HOUR_MS
    while (this.window.length && (this.window[0] ?? 0) <= cutoff) this.window.shift()
  }
  /**
   * The wait to use instead of `baseMs`: long enough that the calls spent since the last wait, repeated every cycle,
   * stay within the hourly budget, and long enough for the oldest call to leave the hour once it is spent.
   */
  stretchedMs(baseMs: number): number {
    this.prune()
    const cycleCalls = this.usage.calls - this.cycleStart
    let waitMs = Math.max(baseMs, Math.ceil((cycleCalls * HOUR_MS) / this.perHour))
    const oldest = this.window[0]
    if (this.window.length >= this.perHour && oldest !== undefined)
      waitMs = Math.max(waitMs, oldest + HOUR_MS - this.now())
    return waitMs
  }
  /** Wait `baseMs`, stretched to the budget. Returns the time actually waited. */
  async pause(baseMs: number): Promise<number> {
    const waitMs = this.stretchedMs(baseMs)
    if (waitMs > baseMs) {
      this.usage.throttledMs += waitMs - baseMs
      this.log(
        `[api-budget] ${this.usage.calls - this.cycleStart} calls this cycle against ${this.perHour}/hour; stretching the ${Math.round(baseMs / 1000)} s wait to ${Math.round(waitMs / 1000)} s`,
      )
    }
    await this.sleep(waitMs)
    this.cycleStart = this.usage.calls
    return waitMs
  }
  snapshot(): ApiUsage {
    return { ...this.usage, byCategory: { ...this.usage.byCategory } }
  }
  /** Usage since an earlier snapshot. */
  since(previous: ApiUsage): ApiUsage {
    const byCategory: Record<string, number> = {}
    for (const [category, count] of Object.entries(this.usage.byCategory)) {
      const delta = count - (previous.byCategory[category] ?? 0)
      if (delta) byCategory[category] = delta
    }
    return {
      calls: this.usage.calls - previous.calls,
      notModified: this.usage.notModified - previous.notModified,
      graphql: this.usage.graphql - previous.graphql,
      byCategory,
      throttledMs: this.usage.throttledMs - previous.throttledMs,
      rateLimitWaitMs: this.usage.rateLimitWaitMs - previous.rateLimitWaitMs,
    }
  }
}

/** Markdown lines for the experiment report: calls per sample and per experiment, with the biggest callers. */
export function renderApiUsageMarkdown(usage: ExperimentApiUsage): string[] {
  const breakdown = (u: ApiUsage) =>
    Object.entries(u.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `${category} ${count}`)
      .join(', ') || '—'
  const lines = [
    '## GitHub API calls',
    '',
    `Budget: ${usage.budgetPerHour} calls per hour for this controller. Free \`304 Not Modified\` answers are listed separately and do not count against the account.`,
    '',
    `- **Experiment:** ${usage.experiment.calls} calls (${usage.experiment.notModified} free 304s); ${breakdown(usage.experiment)}`,
  ]
  if (usage.experiment.throttledMs || usage.experiment.rateLimitWaitMs)
    lines.push(
      `- **Waiting:** ${Math.round(usage.experiment.throttledMs / 1000)} s stretched to fit the budget, ${Math.round(usage.experiment.rateLimitWaitMs / 1000)} s waiting for an account reset`,
    )
  const samples = Object.entries(usage.samples)
  if (samples.length) {
    lines.push('', '| Sample | Calls | Free 304s | Biggest callers |', '| --- | ---: | ---: | --- |')
    for (const [id, u] of samples) lines.push(`| \`${id}\` | ${u.calls} | ${u.notModified} | ${breakdown(u)} |`)
  }
  return [...lines, '']
}
