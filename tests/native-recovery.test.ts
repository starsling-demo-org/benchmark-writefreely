import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitHubClient } from '../src/github.ts'
import { NativeReplayBackend } from '../src/native-backend.ts'
import type { PreparedVariant } from '../src/prepared.ts'
import { executeBenchRecover } from '../src/commands.ts'

const git = vi.hoisted(() => ({ refs: new Map<string, string>(), pushes: [] as string[], failAfterRelease: false }))
vi.mock('node:child_process', () => ({
  execFileSync: (command: string, args: string[]) => {
    if (command !== 'git') throw new Error(`Unexpected command ${command}`)
    if (args[0] === 'ls-remote') {
      const ref = args.at(-1) ?? ''
      const sha = git.refs.get(ref)
      return sha ? `${sha}\t${ref}\n` : ''
    }
    if (args[0] === 'fetch' || args[0] === 'cat-file') return ''
    if (args[0] === 'push') {
      const lease = args[1]?.replace('--force-with-lease=', '').split(':') ?? []
      const [ref, expected] = lease
      if (!ref || (git.refs.get(ref) ?? '') !== expected) throw new Error('Compare-and-swap failed')
      const sha = args.at(-1)?.split(':')[0]
      git.pushes.push(ref)
      if (sha) git.refs.set(ref, sha)
      else git.refs.delete(ref)
      if (ref === 'refs/tags/bench-controller-lease' && !sha && git.failAfterRelease) {
        git.failAfterRelease = false
        throw new Error('Interrupted after remote lease deletion')
      }
      return ''
    }
    throw new Error(`Unexpected git ${args.join(' ')}`)
  },
}))
class RecordedGitHub extends GitHubClient {
  override async all(_path: string): Promise<unknown[]> {
    return []
  }
}
let directory: string
const leaseRef = 'refs/tags/bench-controller-lease'
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bench-native-recovery-'))
  git.refs = new Map([
    [leaseRef, 'lease'],
    ['refs/heads/main', 'second-variant'],
    ['refs/heads/bench/topic', 'topic'],
    ['refs/heads/unrelated', 'untouched'],
  ])
  git.pushes = []
  git.failAfterRelease = false
  writeFileSync(
    join(directory, 'controller.json'),
    JSON.stringify({
      owner: 'experiment',
      leaseSha: 'lease',
      initialRefs: { 'refs/heads/main': 'original', 'refs/heads/unrelated': 'untouched' },
      expectedRefs: { 'refs/heads/main': 'second-variant', 'refs/heads/bench/topic': 'topic' },
      workflowStates: {},
      dispatches: {},
    }),
  )
  writeFileSync(
    join(directory, 'sample.staging.json'),
    JSON.stringify({
      currentStep: '7_await_downstream_completion',
      previousBenchmarkRefs: { 'refs/heads/main': 'first-variant' },
      dispatchRecord: { headSha: 'second-variant' },
    }),
  )
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
const backend = () =>
  new NativeReplayBackend(
    new RecordedGitHub('fixture/repo'),
    { gitDir: directory, baseSha: 'base' } as PreparedVariant,
    join(directory, 'controller.json'),
    'experiment',
  )

it('CLI recovery restores the experiment snapshot, not the previous sample, and is idempotent', async () => {
  const result = await executeBenchRecover({
    stagingStateFilePath: join(directory, 'sample.staging.json'),
    replayBackend: backend(),
  })
  expect(result.data.restoredRefs).toEqual({ 'refs/heads/main': 'original', 'refs/heads/bench/topic': null })
  expect(git.refs.get('refs/heads/main')).toBe('original')
  expect(git.refs.get('refs/heads/unrelated')).toBe('untouched')
  expect(git.refs.has(leaseRef)).toBe(false)
  const pushes = [...git.pushes]
  await executeBenchRecover({ stagingStateFilePath: join(directory, 'sample.staging.json'), replayBackend: backend() })
  expect(git.pushes).toEqual(pushes)
  await expect(backend().acquireLease()).rejects.toThrow('Experiment is finalized')
  expect(git.refs.has(leaseRef)).toBe(false)
})

it('resumes after remote release without acquiring another lease or replaying restoration', async () => {
  git.failAfterRelease = true
  await expect(backend().recoverExperiment()).rejects.toThrow('Interrupted after remote lease deletion')
  const journal = JSON.parse(readFileSync(join(directory, 'controller.json'), 'utf8'))
  expect(journal.recovery.phase).toBe('restored')
  const pushes = [...git.pushes]
  await backend().recoverExperiment()
  expect(git.pushes).toEqual(pushes)
  expect(JSON.parse(readFileSync(join(directory, 'controller.json'), 'utf8')).recovery.phase).toBe('completed')
})

it('preserves a concurrent ref mutation and keeps the lease for investigation', async () => {
  git.refs.set('refs/heads/main', 'external-edit')
  await expect(backend().recoverExperiment()).rejects.toThrow('Concurrent ref mutation')
  expect(git.refs.get('refs/heads/main')).toBe('external-edit')
  expect(git.refs.get(leaseRef)).toBe('lease')
})

it('recovers a journal created before a sample staging file exists', async () => {
  rmSync(join(directory, 'sample.staging.json'))
  const result = await executeBenchRecover({
    stagingStateFilePath: join(directory, 'sample.staging.json'),
    replayBackend: backend(),
  })
  expect(result.data.recovered).toBe(true)
  expect(git.refs.get('refs/heads/main')).toBe('original')
  expect(git.refs.has(leaseRef)).toBe(false)
})

it('does not create a lease when no recovery journal exists', async () => {
  rmSync(join(directory, 'controller.json'))
  await backend().recoverExperiment()
  expect(git.pushes).toEqual([])
})

it('restores refs without mutating GitHub-managed dynamic workflows', async () => {
  class DynamicGitHub extends RecordedGitHub {
    override async all(path: string): Promise<unknown[]> {
      return path === 'actions/workflows'
        ? [{ id: 42, path: 'dynamic/dependabot/dependabot-updates', state: 'active' }]
        : []
    }
    override async request(): Promise<unknown> {
      throw new Error('Dynamic workflows cannot be enabled or disabled')
    }
  }
  const replay = new NativeReplayBackend(
    new DynamicGitHub('fixture/repo'),
    { gitDir: directory, baseSha: 'base' } as PreparedVariant,
    join(directory, 'controller.json'),
    'experiment',
  )
  await replay.disableWorkflow('dynamic/dependabot/dependabot-updates')
  await replay.enableWorkflow('dynamic/dependabot/dependabot-updates')
  await replay.recoverExperiment()
  expect(git.refs.get('refs/heads/main')).toBe('original')
  expect(git.refs.has(leaseRef)).toBe(false)
})

it('tolerates stale workflow metadata removed when the original tree is restored', async () => {
  const path = join(directory, 'controller.json')
  const journal = JSON.parse(readFileSync(path, 'utf8'))
  journal.workflowStates = { '.github/workflows/removed.yml': 'active' }
  writeFileSync(path, JSON.stringify(journal))
  await backend().recoverExperiment()
  expect(git.refs.get('refs/heads/main')).toBe('original')
  expect(git.refs.has(leaseRef)).toBe(false)
})
