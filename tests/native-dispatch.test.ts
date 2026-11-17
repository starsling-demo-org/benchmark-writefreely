import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitHubClient } from '../src/github.ts'
import { NativeReplayBackend } from '../src/native-backend.ts'
import type { PreparedVariant } from '../src/prepared.ts'

// Real Git against a local bare remote; only the remote address and the Actions API are replaced.
const transport = vi.hoisted(() => ({ remote: '', dropPush: null as 'lost' | 'landed' | null, pushes: 0 }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync(command: string, args: string[], options: ExecFileSyncOptions) {
      const mapped = args.map((arg) => (arg === 'https://github.com/fixture/repo.git' ? transport.remote : arg))
      if (command === 'git' && args[0] === 'push') {
        transport.pushes++
        const drop = transport.dropPush
        if (drop) {
          transport.dropPush = null
          if (drop === 'landed') actual.execFileSync(command, mapped, options)
          throw new Error('Command failed: git push\nerror: RPC failed; curl 55 Recv failure: Connection reset by peer')
        }
      }
      return actual.execFileSync(command, mapped, options)
    },
  }
})
class DispatchApi extends GitHubClient {
  readonly posts: { path: string; body: unknown }[] = []
  override async all(): Promise<unknown[]> {
    return [
      { id: 11, path: '.github/workflows/pnpm-cache.yml', state: 'active' },
      { id: 12, path: '.github/workflows/fmt.yml', state: 'active' },
    ]
  }
  override async request(path: string, _method = 'GET', body?: unknown): Promise<unknown> {
    this.posts.push({ path, body })
    if (this.posts.length === 2) throw new Error('Injected interruption after the first dispatch')
    return null
  }
}
let directory: string
let source: string
const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bench-native-dispatch-'))
  source = join(directory, 'source')
  transport.remote = join(directory, 'remote.git')
  git(['init', '-q', '--bare', transport.remote], directory)
  git(['init', '-q', '-b', 'master', source], directory)
  writeFileSync(join(source, 'README.md'), 'x\n')
  git(['add', '.'], source)
  git(['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-qm', 'base'], source)
  git(['push', '-q', transport.remote, 'master'], source)
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('dispatches each workflow once on the installed head and resumes without repeating a dispatch', async () => {
  const head = git(['rev-parse', 'HEAD'], source)
  const api = new DispatchApi('fixture/repo')
  const make = () =>
    new NativeReplayBackend(api, { gitDir: source } as PreparedVariant, join(directory, 'controller.json'), 'exp')
  await make().acquireLease()
  const params = {
    idempotencyKey: 'k',
    event: 'workflow_dispatch',
    targetRef: 'refs/heads/master',
    workflows: ['.github/workflows/pnpm-cache.yml', '.github/workflows/fmt.yml'],
  }
  await expect(make().triggerNativeEvent(params)).rejects.toThrow('Injected interruption')
  const resumed = await make().triggerNativeEvent(params)
  expect(resumed.headSha).toBe(head)
  expect(api.posts.map((p) => [p.path, p.body])).toEqual([
    ['actions/workflows/11/dispatches', { ref: 'master' }],
    ['actions/workflows/12/dispatches', { ref: 'master' }],
    ['actions/workflows/12/dispatches', { ref: 'master' }],
  ])
  // The dispatch never moved the branch: push-triggered workflows cannot start.
  expect(git(['rev-parse', 'refs/heads/master'], transport.remote)).toBe(head)
})

it('settles a failed attempt: cancels its active runs and waits only on non-managed runs', async () => {
  const runs: Record<number, string> = { 1: 'completed', 2: 'in_progress', 3: 'in_progress' }
  const calls: string[] = []
  class SettleApi extends GitHubClient {
    override async all(path: string): Promise<unknown[]> {
      // A Dependabot run stays active; managed runs are cancelled by staging and never block the retry.
      return path.endsWith('status=in_progress') ? [{ id: 9, path: 'dynamic/dependabot/dependabot-updates' }] : []
    }
    override async request(path: string, method = 'GET'): Promise<unknown> {
      calls.push(`${method} ${path}`)
      const id = Number(/runs\/(\d+)/.exec(path)?.[1])
      if (method === 'POST') {
        // Run 3 finishes between the read and the cancel; GitHub then refuses the cancel.
        if (id === 3) {
          runs[3] = 'completed'
          throw new Error('GitHub POST cancel failed: Cannot cancel a workflow run that is completed. (HTTP 409)')
        }
        runs[id] = 'completed'
        return null
      }
      return { status: runs[id] }
    }
  }
  const backend = new NativeReplayBackend(
    new SettleApi('fixture/repo'),
    { gitDir: source } as PreparedVariant,
    join(directory, 'controller.json'),
    'exp',
  )
  await backend.settleRuns([1, 2, 3], 1)
  expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
    'POST actions/runs/2/cancel',
    'POST actions/runs/3/cancel',
  ])
  expect(runs).toEqual({ 1: 'completed', 2: 'completed', 3: 'completed' })
})

it('cancels managed runs in every active status and waits until they stay gone before the event', async () => {
  // A Dependabot run seconds old is `requested`; it ends (as failure) after the cancel, and a second one appears late.
  const runs: { id: number; path: string; status: string }[] = [
    { id: 1, path: 'dynamic/dependabot/dependabot-updates', status: 'requested' },
    { id: 2, path: '.github/workflows/ci.yml', status: 'in_progress' },
  ]
  let polls = 0
  const cancels: number[] = []
  class ManagedApi extends GitHubClient {
    override async all(path: string): Promise<unknown[]> {
      const status = /status=(\w+)/.exec(path)?.[1]
      if (status === 'requested' && ++polls === 2)
        runs.push({ id: 3, path: 'dynamic/dependabot/dependabot-updates', status: 'pending' })
      return runs.filter((r) => r.status === status)
    }
    override async request(path: string, method = 'GET'): Promise<unknown> {
      const id = Number(/runs\/(\d+)/.exec(path)?.[1])
      const run = runs.find((r) => r.id === id)
      if (method === 'POST' && run) {
        cancels.push(id)
        run.status = 'completed'
      }
      return { status: run?.status }
    }
  }
  const backend = new NativeReplayBackend(
    new ManagedApi('fixture/repo'),
    { gitDir: source } as PreparedVariant,
    join(directory, 'controller.json'),
    'exp',
  )
  await backend.acquireLease()
  const cancelled = await backend.cancelManagedRuns({ pollMs: 1 })
  // Both managed runs are cancelled, including the one that appeared after the first poll; workflow runs are untouched.
  expect(cancels).toEqual([1, 3])
  expect(cancelled).toEqual(['dynamic/dependabot/dependabot-updates', 'dynamic/dependabot/dependabot-updates'])
  expect(runs.find((r) => r.id === 2)?.status).toBe('in_progress')
})

it('retries a ref push the network dropped, and detects one that landed before the drop', async () => {
  const head = git(['rev-parse', 'HEAD'], source)
  const backend = new NativeReplayBackend(
    new GitHubClient('fixture/repo'),
    { gitDir: source } as PreparedVariant,
    join(directory, 'controller.json'),
    'exp',
  )
  await backend.acquireLease()
  for (const [drop, ref, pushes] of [
    ['lost', 'refs/heads/retry-lost', 2],
    ['landed', 'refs/heads/retry-landed', 1],
  ] as const) {
    transport.pushes = 0
    transport.dropPush = drop
    await backend.updateRef(ref, head)
    expect(git(['rev-parse', ref], transport.remote)).toBe(head)
    // A push that landed is not repeated; a lost one is pushed again under the same lease guard.
    expect(transport.pushes).toBe(pushes)
  }
}, 20_000)
