import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/commands.ts'
import { GitHubClient } from '../src/github.ts'
import { NativeReplayBackend } from '../src/native-backend.ts'
import { constructReplayAncestry } from '../src/patcher.ts'
import type { PreparedVariant } from '../src/prepared.ts'
import { publishShowcase } from '../src/publish.ts'

// Only the remote address is replaced; every commit is made by real Git in isolated repositories.
const transport = vi.hoisted(() => ({ remote: '' }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync(command: string, args: string[], options: ExecFileSyncOptions) {
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
class OfflineGitHub extends GitHubClient {
  override async all(): Promise<unknown[]> {
    return []
  }
  override async request(): Promise<unknown> {
    throw new Error('Harness commits must use Git, not REST writes')
  }
}

const CONFIGURED = { name: 'Configured Operator', email: 'configured@example.test' }
const ENVIRONMENT = { name: 'Env Operator', email: 'env@example.test' }
const GIT_CONFIG = { name: 'Gitconfig Operator', email: 'gitconfig@example.test' }
const BUILT_IN = { name: 'StarSling Bench', email: 'bench@starsling.dev' }

let directory: string
let source: string
let original: string
const git = (args: string[], cwd = source) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** Author and committer of a commit, as "name <email>" pairs. */
const identities = (sha: string, cwd = source) => {
  const [author, committer] = git(['show', '-s', '--format=%an <%ae>%n%cn <%ce>', sha], cwd).split('\n')
  return { author, committer }
}
const who = (identity: { name: string; email: string }) => `${identity.name} <${identity.email}>`

async function configure(commitIdentity?: { name: string; email: string }) {
  const path = join(directory, 'benchmark.config.json')
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      upstream: { repository: 'fixture/source', commitSha: 'a'.repeat(40), defaultBranch: 'main' },
      scenarios: {},
      profiles: {},
      patches: [],
      execution: {
        repetitions: 1,
        timeoutMinutes: 1,
        maxConcurrentExperiments: 1,
        pollIntervalSeconds: 1,
        publicRepoGitHubFree: true,
        ...(commitIdentity ? { commitIdentity } : {}),
      },
    }),
  )
  await loadConfig(path)
}

function makeBackend(gitDir: string) {
  return new NativeReplayBackend(
    new OfflineGitHub('fixture/repo'),
    { gitDir, baseSha: original } as PreparedVariant,
    join(directory, 'controller.json'),
    'experiment',
  )
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'bench-commit-identity-test-'))
  source = join(directory, 'source')
  transport.remote = join(directory, 'remote.git')
  // No machine-level identity leaks in: the global config is an empty file unless a test fills it.
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(directory, 'global.gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'])
    vi.stubEnv(name, '')
  writeFileSync(join(directory, 'global.gitconfig'), '')
  git(['init', '--bare', transport.remote], directory)
  git(['init', '-b', 'main', source], directory)
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(source, 'README.md'), 'upstream\n')
  git(['add', '.'])
  execFileSync('git', ['commit', '-qm', 'Initial'], {
    cwd: source,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Seed',
      GIT_AUTHOR_EMAIL: 'seed@example.test',
      GIT_COMMITTER_NAME: 'Seed',
      GIT_COMMITTER_EMAIL: 'seed@example.test',
    },
  })
  original = git(['rev-parse', 'HEAD'])
  git(['push', transport.remote, 'main'])
  await configure()
})
afterEach(async () => {
  await configure()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

/** Every place the harness makes a commit, each returning the commit it made. */
const commitPaths: Record<string, () => Promise<{ sha: string; cwd: string }[]>> = {
  'showcase publish commit': async () => {
    const stateDir = join(directory, 'publish-state')
    const result = await publishShowcase({
      client: new OfflineGitHub('fixture/repo'),
      defaultBranch: 'main',
      files: [{ path: 'showcase/index.md', content: 'hello\n' }],
      message: 'showcase: test',
      stateDir,
      owner: 'experiment',
    })
    return [{ sha: result.commitSha, cwd: join(stateDir, 'publish.git') }]
  },
  'workflow placeholder registration and lease commits': async () => {
    const backend = makeBackend(source)
    await backend.acquireLease()
    await backend.getCurrentRefs()
    await backend.registerInactiveWorkflowPlaceholder('main', '.github/workflows/new.yml')
    return [
      { sha: git(['rev-parse', 'refs/heads/main'], transport.remote), cwd: transport.remote },
      { sha: git(['rev-parse', 'refs/tags/bench-controller-lease'], transport.remote), cwd: transport.remote },
    ]
  },
  'replay base, head and merge commits': async () => {
    const baseDir = join(directory, 'base')
    const headDir = join(directory, 'head')
    for (const dir of [baseDir, headDir]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(baseDir, 'a.txt'), '1\n')
    writeFileSync(join(headDir, 'a.txt'), '2\n')
    const replayGitDir = join(directory, 'replay')
    const { blockers } = constructReplayAncestry({
      baseTreeDir: baseDir,
      headTreeDir: headDir,
      replayGitDir,
      scenario: {
        name: 'pr',
        description: 'identity',
        event: 'pull_request',
        pr: {
          prNumber: 1,
          baseRef: 'main',
          headRef: 'feat/x',
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          mergeSha: 'c'.repeat(40),
          activityType: 'synchronize',
          changedPaths: ['a.txt'],
          labels: [],
        },
        referenceRuns: [],
      },
      patches: [],
      applyPatches: false,
    })
    expect(blockers).toEqual([])
    return [
      { sha: git(['rev-parse', 'HEAD'], replayGitDir), cwd: replayGitDir },
      { sha: git(['rev-parse', 'HEAD^1'], replayGitDir), cwd: replayGitDir },
      { sha: git(['rev-parse', 'HEAD^2'], replayGitDir), cwd: replayGitDir },
    ]
  },
}

for (const [pathName, run] of Object.entries(commitPaths)) {
  it(`${pathName}: author and committer are the configured identity`, async () => {
    await configure(CONFIGURED)
    for (const { sha, cwd } of await run())
      expect(identities(sha, cwd)).toEqual({ author: who(CONFIGURED), committer: who(CONFIGURED) })
  })

  it(`${pathName}: configured identity beats environment variables and git config`, async () => {
    await configure(CONFIGURED)
    vi.stubEnv('GIT_AUTHOR_NAME', ENVIRONMENT.name)
    vi.stubEnv('GIT_AUTHOR_EMAIL', ENVIRONMENT.email)
    writeFileSync(
      join(directory, 'global.gitconfig'),
      `[user]\n\tname = ${GIT_CONFIG.name}\n\temail = ${GIT_CONFIG.email}\n`,
    )
    for (const { sha, cwd } of await run())
      expect(identities(sha, cwd)).toEqual({ author: who(CONFIGURED), committer: who(CONFIGURED) })
  })

  it(`${pathName}: falls back to the standard git environment variables`, async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', ENVIRONMENT.name)
    vi.stubEnv('GIT_AUTHOR_EMAIL', ENVIRONMENT.email)
    writeFileSync(
      join(directory, 'global.gitconfig'),
      `[user]\n\tname = ${GIT_CONFIG.name}\n\temail = ${GIT_CONFIG.email}\n`,
    )
    for (const { sha, cwd } of await run())
      expect(identities(sha, cwd)).toEqual({ author: who(ENVIRONMENT), committer: who(ENVIRONMENT) })
  })

  it(`${pathName}: falls back to the operator's git config`, async () => {
    writeFileSync(
      join(directory, 'global.gitconfig'),
      `[user]\n\tname = ${GIT_CONFIG.name}\n\temail = ${GIT_CONFIG.email}\n`,
    )
    for (const { sha, cwd } of await run())
      expect(identities(sha, cwd)).toEqual({ author: who(GIT_CONFIG), committer: who(GIT_CONFIG) })
  })

  it(`${pathName}: uses the built-in identity last, with a visible warning`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const { sha, cwd } of await run())
      expect(identities(sha, cwd)).toEqual({ author: who(BUILT_IN), committer: who(BUILT_IN) })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('commit identity'))
  })
}

it('does not warn when a real identity is available', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await configure(CONFIGURED)
  await commitPaths['showcase publish commit']?.()
  expect(warn).not.toHaveBeenCalled()
})

it('rejects a configured identity without a name or an email', async () => {
  await expect(configure({ name: '', email: 'x@example.test' })).rejects.toThrow('commitIdentity')
  await expect(configure({ name: 'X', email: '' })).rejects.toThrow('commitIdentity')
})
