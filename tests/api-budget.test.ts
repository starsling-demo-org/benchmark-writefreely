import { beforeEach, expect, it, vi } from 'vitest'
import { AdaptiveInterval, ApiBudget, emptyUsage, renderApiUsageMarkdown } from '../src/api-budget.ts'
import { GitHubClient } from '../src/github.ts'
import { NativeReplayBackend } from '../src/native-backend.ts'
import type { PreparedVariant } from '../src/prepared.ts'

// gh is scripted: each call takes the next outcome and its arguments are recorded.
const gh = vi.hoisted(() => ({
  outcomes: [] as ({ ok: string } | { stdout: string })[],
  calls: [] as string[][],
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync: (command: string, args: string[], options: Parameters<typeof actual.execFileSync>[2]) => {
      if (command !== 'gh') return actual.execFileSync(command, args, options)
      gh.calls.push(args)
      const next = gh.outcomes.shift()
      if (next && 'ok' in next) return next.ok
      throw Object.assign(new Error('Command failed: gh api'), { stdout: next?.stdout ?? '' })
    },
  }
})
beforeEach(() => {
  gh.calls = []
  gh.outcomes = []
})

const http = (status: string, headers: Record<string, string>, body = '') =>
  `HTTP/2.0 ${status}\r\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')}\r\n\r\n${body}`

/** A budget on a fake clock whose sleeps are recorded instead of waited. */
function fakeBudget(perHour = 300) {
  const state = { now: 1_000_000_000_000, sleeps: [] as number[], logs: [] as string[] }
  const budget = new ApiBudget({
    perHour,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms)
      state.now += ms
    },
    log: (line: string) => state.logs.push(line),
  })
  return { budget, state }
}
const client = (budget: ApiBudget) =>
  Object.assign(new GitHubClient('fixture/repo', undefined, budget), { retryDelayMs: 1 })

it('counts every REST call, including retried attempts, by category', async () => {
  const { budget } = fakeBudget()
  gh.outcomes = [
    { ok: '{"workflow_runs":[]}' },
    { stdout: JSON.stringify({ message: 'Server Error', status: '502' }) },
    { ok: '{"jobs":[]}' },
    { ok: '{"artifacts":[]}' },
    { ok: 'null' },
  ]
  const api = client(budget)
  await api.request('actions/runs?per_page=50&page=1')
  await api.request('actions/runs/7/attempts/1/jobs?per_page=50&page=1')
  await api.request('actions/runs/7/artifacts?per_page=50&page=1')
  await api.request('actions/runs/7/cancel', 'POST')
  const usage = budget.snapshot()
  expect(usage.calls).toBe(5) // four requests plus the one 502 that was retried
  expect(usage.notModified).toBe(0)
  expect(usage.byCategory).toEqual({ 'run-list': 1, jobs: 2, artifacts: 1, 'run-write': 1 })
})

it('measures the calls of one stretch of work with since()', async () => {
  const { budget } = fakeBudget()
  gh.outcomes = [{ ok: '{}' }, { ok: '{}' }, { ok: '{}' }]
  const api = client(budget)
  await api.request('')
  const before = budget.snapshot()
  await api.request('actions/workflows')
  await api.request('actions/caches')
  expect(budget.since(before).calls).toBe(2)
  expect(budget.since(before).byCategory).toEqual({ workflows: 1, caches: 1 })
  expect(budget.snapshot().calls).toBe(3)
})

it('sends the stored ETag and serves a 304 from memory without charging the budget', async () => {
  const { budget } = fakeBudget()
  gh.outcomes = [
    { ok: http('200 OK', { ETag: '"abc"', 'X-RateLimit-Remaining': '4000' }, '{"workflow_runs":[{"id":1}]}') },
    { stdout: http('304 Not Modified', { ETag: '"abc"' }) },
    { ok: http('200 OK', { ETag: '"def"' }, '{"workflow_runs":[{"id":1},{"id":2}]}') },
  ]
  const api = client(budget)
  const path = 'actions/runs?status=queued&per_page=100&page=1'
  expect(await api.request(path)).toEqual({ workflow_runs: [{ id: 1 }] })
  expect(gh.calls[0]).not.toContain('If-None-Match: "abc"')
  expect(await api.request(path)).toEqual({ workflow_runs: [{ id: 1 }] })
  expect(gh.calls[1]).toContain('If-None-Match: "abc"')
  expect(budget.snapshot().calls).toBe(1)
  expect(budget.snapshot().notModified).toBe(1)
  // A changed answer replaces the stored one and the new tag is used next.
  expect(await api.request(path)).toEqual({ workflow_runs: [{ id: 1 }, { id: 2 }] })
  expect(gh.calls[2]).toContain('If-None-Match: "abc"')
  expect(budget.snapshot().calls).toBe(2)
})

it('never sends conditional headers on writes', async () => {
  const { budget } = fakeBudget()
  gh.outcomes = [{ ok: http('200 OK', { ETag: '"x"' }, '{}') }, { ok: 'null' }]
  const api = client(budget)
  await api.request('actions/workflows/1')
  await api.request('actions/workflows/1', 'PUT')
  expect(gh.calls[1]?.some((arg) => arg.startsWith('If-None-Match'))).toBe(false)
})

it('stretches a wait so the observed calls fit the hourly budget, and never shortens it', async () => {
  const { budget, state } = fakeBudget(300) // 300 an hour is one call per 12 s
  expect(await budget.pause(15_000)).toBe(15_000) // nothing was spent: the plain interval
  for (let i = 0; i < 10; i++) budget.record({ endpoint: 'actions/runs' })
  expect(budget.stretchedMs(15_000)).toBe(120_000) // ten calls this cycle need 120 s to stay at 300 an hour
  expect(await budget.pause(15_000)).toBe(120_000)
  expect(state.sleeps).toEqual([15_000, 120_000])
  expect(state.logs.some((line) => line.includes('api-budget') && line.includes('120'))).toBe(true)
  // The next cycle starts a fresh count: one call needs 12 s, below the 15 s interval.
  budget.record({ endpoint: 'actions/runs' })
  expect(await budget.pause(15_000)).toBe(15_000)
  expect(budget.snapshot().throttledMs).toBe(105_000)
})

it('holds back once the last hour is already spent, until the oldest call ages out', () => {
  const { budget, state } = fakeBudget(10)
  for (let i = 0; i < 10; i++) {
    budget.record({ endpoint: 'actions/runs' })
    state.now += 1_000
  }
  // Ten calls in the window with a limit of ten: wait for the first (10 s ago) to leave the hour.
  expect(budget.stretchedMs(1_000)).toBeGreaterThanOrEqual(3_600_000 - 10_000)
})

it('waits for the reset when the account is below 15% of its hourly allowance', async () => {
  const { budget, state } = fakeBudget()
  const resetIn = 600
  budget.observeRateLimit({ limit: 5000, remaining: 1000, resetEpochSeconds: state.now / 1000 + resetIn })
  await budget.waitForAccountHeadroom() // 20% left: carry on
  expect(state.sleeps).toEqual([])
  budget.observeRateLimit({ limit: 5000, remaining: 700, resetEpochSeconds: state.now / 1000 + resetIn })
  await budget.waitForAccountHeadroom() // 14% left: wait for the reset
  expect(state.sleeps).toHaveLength(1)
  expect(state.sleeps[0]).toBeGreaterThanOrEqual(resetIn * 1000)
  expect(state.sleeps[0]).toBeLessThan((resetIn + 5) * 1000)
  expect(state.logs.some((line) => line.includes('rate limit') && line.includes('700/5000'))).toBe(true)
  expect(budget.snapshot().rateLimitWaitMs).toBe(state.sleeps[0])
  await budget.waitForAccountHeadroom() // the window has reset: no second wait
  expect(state.sleeps).toHaveLength(1)
})

it('reads the rate-limit headers of a response and backs off before the next request', async () => {
  const { budget, state } = fakeBudget()
  const reset = String(state.now / 1000 + 300)
  gh.outcomes = [
    {
      ok: http(
        '200 OK',
        { 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': '600', 'X-RateLimit-Reset': reset },
        '{}',
      ),
    },
    { ok: '{}' },
  ]
  const api = client(budget)
  await api.request('actions/workflows')
  expect(state.sleeps).toEqual([]) // the first request had no information yet
  await api.request('actions/caches')
  expect(state.sleeps).toHaveLength(1)
  expect(state.sleeps[0]).toBeGreaterThanOrEqual(300_000)
  expect(gh.calls).toHaveLength(2) // it waited, it did not skip the call
})

it('backs off 15 s, 30 s, 60 s, 120 s while nothing changes, and resets on change', () => {
  const poll = new AdaptiveInterval(15_000)
  expect([false, false, false, false, false].map((changed) => poll.next(changed))).toEqual([
    15_000, 30_000, 60_000, 120_000, 120_000,
  ])
  expect(poll.next(true)).toBe(15_000)
  expect(poll.next(false)).toBe(30_000)
  // A configured interval above the cap is honored, not shortened.
  const slow = new AdaptiveInterval(300_000)
  expect(slow.next(false)).toBe(300_000)
  expect(slow.next(false)).toBe(300_000)
})

it('collects with the adaptive interval, resetting when a run changes state', async () => {
  vi.resetModules()
  const scripted = [
    ['Job "ci.yml#a" is still queued'],
    ['Job "ci.yml#a" is still queued'],
    ['Job "ci.yml#a" is still queued'],
    ['Job "ci.yml#a" is still in_progress'],
    [],
  ]
  vi.doMock('../src/collector.ts', () => ({
    collectSampleExecution: async () => {
      const reasons = scripted.shift() ?? []
      return {
        complete: reasons.length === 0,
        incompleteReasons: reasons,
        failedJobs: [],
        cancelledJobs: [],
        workflows: [],
      }
    },
  }))
  const { collectUntilComplete } = await import('../src/runtime.ts')
  const { budget, state } = fakeBudget(100_000)
  await collectUntilComplete({
    api: {} as never,
    query: {} as never,
    payload: { inventory: {} } as never,
    timeoutMinutes: 600,
    pollIntervalSeconds: 15,
    budget,
  })
  expect(state.sleeps).toEqual([15_000, 30_000, 60_000, 15_000])
  vi.doUnmock('../src/collector.ts')
})

it('polls for managed runs every 15 s by default, not every 5 s, through the budget-aware pause', async () => {
  const pauses: number[] = []
  class QuietApi extends GitHubClient {
    override async all(): Promise<unknown[]> {
      return []
    }
    override async pause(ms: number): Promise<void> {
      pauses.push(ms)
    }
  }
  const backend = new NativeReplayBackend(
    new QuietApi('fixture/repo'),
    {} as PreparedVariant,
    '/nonexistent/journal.json',
    'exp',
  )
  vi.spyOn(backend as unknown as { assertLease(): void }, 'assertLease').mockImplementation(() => {})
  await backend.cancelManagedRuns()
  expect(pauses).toEqual([15_000])
}, 30_000)

it('renders the per-sample call counts for the report', () => {
  const usage = { ...emptyUsage(), calls: 90, notModified: 40, byCategory: { 'run-list': 60, jobs: 30 } }
  const lines = renderApiUsageMarkdown({
    budgetPerHour: 300,
    experiment: { ...usage, calls: 100 },
    samples: { 'sample-1': usage },
  }).join('\n')
  expect(lines).toContain('GitHub API calls')
  expect(lines).toContain('300')
  expect(lines).toContain('sample-1')
  expect(lines).toContain('90')
  expect(lines).toContain('run-list')
})
