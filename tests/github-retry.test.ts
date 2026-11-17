import { beforeEach, expect, it, vi } from 'vitest'
import { GitHubClient } from '../src/github.ts'

// Each call takes the next scripted outcome: a response body, or a failure with gh's stdout (JSON or nothing).
const script = vi.hoisted(() => ({ outcomes: [] as ({ ok: string } | { stdout: string })[], calls: 0 }))
vi.mock('node:child_process', () => ({
  execFileSync: () => {
    script.calls++
    const next = script.outcomes.shift()
    if (next && 'ok' in next) return next.ok
    throw Object.assign(new Error('Command failed: gh api'), { stdout: next?.stdout ?? '' })
  },
}))
beforeEach(() => {
  script.calls = 0
})

const client = () => Object.assign(new GitHubClient('fixture/repo'), { retryDelayMs: 1 })

it('retries a read through transient failures: no response, 5xx and rate limits', async () => {
  script.outcomes = [
    { stdout: '' },
    { stdout: JSON.stringify({ message: 'Server Error', status: '502' }) },
    { stdout: JSON.stringify({ message: 'API rate limit exceeded', status: '403' }) },
    { ok: '{"total_count":0}' },
  ]
  await expect(client().request('actions/runs')).resolves.toEqual({ total_count: 0 })
  expect(script.calls).toBe(4)
})

it('never retries a real answer, a write, or past the attempt limit', async () => {
  script.outcomes = [{ stdout: JSON.stringify({ message: 'Not Found', status: '404' }) }]
  await expect(client().request('actions/runs/1')).rejects.toThrow('Not Found (HTTP 404)')
  expect(script.calls).toBe(1)
  // A dispatch whose response was lost may have happened; repeating it could start a second run.
  script.calls = 0
  script.outcomes = [{ stdout: '' }, { ok: 'null' }]
  await expect(client().request('actions/workflows/1/dispatches', 'POST', {})).rejects.toThrow('failed')
  expect(script.calls).toBe(1)
  script.calls = 0
  script.outcomes = Array.from({ length: 6 }, () => ({ stdout: '' }))
  await expect(client().request('actions/runs')).rejects.toThrow('failed')
  expect(script.calls).toBe(5)
})
