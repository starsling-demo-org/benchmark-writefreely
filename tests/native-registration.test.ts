import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitHubClient } from '../src/github.ts'
import { NativeReplayBackend } from '../src/native-backend.ts'
import type { PreparedVariant } from '../src/prepared.ts'

// Only replace the remote address: all lease, index, tree, commit and push
// operations execute real Git against the isolated local repositories.
const transport = vi.hoisted(() => ({
  remote: '',
  indexes: [] as string[],
  pushes: [] as string[][],
  failWriteTree: false,
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync(command: string, args: string[], options: ExecFileSyncOptions) {
      if (options?.env?.GIT_INDEX_FILE) transport.indexes.push(options.env.GIT_INDEX_FILE)
      if (args[0] === 'push') transport.pushes.push(args)
      if (transport.failWriteTree && args[0] === 'write-tree') throw new Error('Injected write-tree interruption')
      return actual.execFileSync(
        command,
        args.map((arg) =>
          arg === 'https://github.com/fixture/repo.git' || arg === 'git@github.com:fixture/repo.git'
            ? transport.remote
            : arg,
        ),
        options,
      )
    },
  }
})
class ActionsOnlyGitHub extends GitHubClient {
  override async all(): Promise<unknown[]> {
    return []
  }
  override async request(): Promise<unknown> {
    throw new Error('Registration must not use Git Data REST writes')
  }
}
let directory: string
let source: string
let original: string
let backend: NativeReplayBackend
const git = (args: string[], cwd = source) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'bench-native-registration-test-'))
  source = join(directory, 'source')
  transport.remote = join(directory, 'remote.git')
  transport.indexes = []
  transport.failWriteTree = false
  git(['init', '--bare', transport.remote], directory)
  git(['init', '-b', 'main', source], directory)
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.test'])
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(source, 'README.md'), 'original upstream contents\n')
  git(['add', '.'])
  git(['commit', '-m', 'Initial'])
  original = git(['rev-parse', 'HEAD'])
  git(['push', transport.remote, 'main'])
  // An unrelated staged change proves registration does not borrow the real index.
  writeFileSync(join(source, 'README.md'), 'local staged change\n')
  git(['add', 'README.md'])
  backend = new NativeReplayBackend(
    new ActionsOnlyGitHub('fixture/repo'),
    { gitDir: source, baseSha: original } as PreparedVariant,
    join(directory, 'controller.json'),
    'experiment',
  )
  await backend.acquireLease()
  await backend.getCurrentRefs()
  const lease = git(['rev-parse', 'refs/tags/bench-controller-lease'], transport.remote)
  expect(git(['ls-tree', '-r', lease])).toBe('')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('registers with real Git transport while preserving source index, worktree and original ancestry', async () => {
  const indexBefore = readFileSync(join(source, '.git/index'))
  const statusBefore = git(['status', '--porcelain'])
  await backend.registerInactiveWorkflowPlaceholder('main', '.github/workflows/new.yml')
  const registered = git(['rev-parse', 'refs/heads/main'], transport.remote)
  expect(registered).not.toBe(original)
  expect(git(['show', '-s', '--format=%P', registered])).toBe(original)
  expect(git(['show', '-s', '--format=%s', registered])).toBe('[skip ci] Register .github/workflows/new.yml')
  expect(git(['show', `${registered}:README.md`])).toBe('original upstream contents')
  expect(git(['show', `${registered}:.github/workflows/new.yml`])).toContain('on: workflow_dispatch')
  expect(git(['show', `${registered}:.github/workflows/new.yml`])).toContain('if: false')
  expect(readFileSync(join(source, '.git/index'))).toEqual(indexBefore)
  expect(git(['status', '--porcelain'])).toBe(statusBefore)
  expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('local staged change\n')
  expect(transport.indexes.length).toBeGreaterThan(0)
  expect(transport.indexes.every((path) => !existsSync(dirname(path)))).toBe(true)
  await backend.recoverExperiment()
  expect(git(['rev-parse', 'refs/heads/main'], transport.remote)).toBe(original)
  expect(git(['ls-remote', transport.remote, 'refs/tags/bench-controller-lease'])).toBe('')
})

const WORKFLOW = '.github/workflows/new.yml'
const countCommits = () => Number(git(['rev-list', '--count', 'refs/heads/main'], transport.remote))
const commitOnMain = (path: string, content: string) => {
  const work = join(directory, 'work')
  git(['clone', '--quiet', transport.remote, work], directory)
  git(['config', 'user.name', 'Fixture'], work)
  git(['config', 'user.email', 'fixture@example.test'], work)
  git(['config', 'commit.gpgsign', 'false'], work)
  mkdirSync(dirname(join(work, path)), { recursive: true })
  writeFileSync(join(work, path), content)
  git(['add', path], work)
  git(['commit', '-m', 'Seed'], work)
  git(['push', 'origin', 'main'], work)
  rmSync(work, { recursive: true, force: true })
}

it('skips the commit and push when the default branch already has the identical placeholder', async () => {
  await backend.registerInactiveWorkflowPlaceholder('main', WORKFLOW)
  const head = git(['rev-parse', 'refs/heads/main'], transport.remote)
  const commits = countCommits()
  transport.pushes = []
  await backend.registerInactiveWorkflowPlaceholder('main', WORKFLOW)
  expect(git(['rev-parse', 'refs/heads/main'], transport.remote)).toBe(head)
  expect(countCommits()).toBe(commits)
  expect(transport.pushes).toEqual([])
})

it('commits as before when the placeholder is missing', async () => {
  const commits = countCommits()
  transport.pushes = []
  await backend.registerInactiveWorkflowPlaceholder('main', WORKFLOW)
  expect(countCommits()).toBe(commits + 1)
  expect(transport.pushes.length).toBe(1)
})

it('commits as before when the workflow exists with different content', async () => {
  commitOnMain(WORKFLOW, 'name: real\non: push\njobs: {}\n')
  const commits = countCommits()
  await backend.registerInactiveWorkflowPlaceholder('main', WORKFLOW)
  expect(countCommits()).toBe(commits + 1)
  const head = git(['rev-parse', 'refs/heads/main'], transport.remote)
  expect(git(['show', `${head}:${WORKFLOW}`])).toContain('if: false')
})

it('still disables the workflow when the placeholder is already registered', async () => {
  await backend.registerInactiveWorkflowPlaceholder('main', WORKFLOW)
  let state = 'active'
  const puts: string[] = []
  class ActiveWorkflowGitHub extends GitHubClient {
    override async all(): Promise<unknown[]> {
      return [{ id: 7, path: WORKFLOW, state }]
    }
    override async request(path: string, method?: string): Promise<unknown> {
      if (method === 'PUT') {
        puts.push(path)
        state = 'disabled_manually'
        return {}
      }
      throw new Error('unexpected request')
    }
  }
  const second = new NativeReplayBackend(
    new ActiveWorkflowGitHub('fixture/repo'),
    { gitDir: source, baseSha: original } as PreparedVariant,
    join(directory, 'controller.json'),
    'experiment',
  )
  const commits = countCommits()
  await second.registerInactiveWorkflowPlaceholder('main', WORKFLOW)
  expect(countCommits()).toBe(commits)
  expect(puts).toEqual(['actions/workflows/7/disable'])
}, 30_000)

it('cleans the isolated index after interruption without publishing a partial commit', async () => {
  transport.failWriteTree = true
  await expect(backend.registerInactiveWorkflowPlaceholder('main', '.github/workflows/new.yml')).rejects.toThrow(
    'Injected write-tree interruption',
  )
  expect(git(['rev-parse', 'refs/heads/main'], transport.remote)).toBe(original)
  expect(transport.indexes.every((path) => !existsSync(dirname(path)))).toBe(true)
  expect(existsSync(join(source, '.github/workflows/new.yml'))).toBe(false)
})
