import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createDefaultProfiles } from '../src/config.ts'
import { pinnedRunnerMapping } from './fixtures/pinned-runner-mapping.ts'
import { prepareExperiment, verifyPrepared } from '../src/prepared.ts'
import type { BenchmarkConfig } from '../src/types.ts'

const root = mkdtempSync(join(tmpdir(), 'bench-upstream-history-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()

it('parents replay base commits on the real upstream history, without copying it per variant', () => {
  const source = join(root, 'source')
  mkdirSync(join(source, '.github/workflows'), { recursive: true })
  run(source, 'init', '-q', '-b', 'main')
  writeFileSync(
    join(source, '.github/workflows/ci.yml'),
    'on: push\njobs:\n  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: git log\n',
  )
  const commit = (content: string) => {
    writeFileSync(join(source, 'code.txt'), content)
    run(source, 'add', '.')
    run(source, 'commit', '-qm', content)
    return run(source, 'rev-parse', 'HEAD')
  }
  commit('old-1')
  commit('old-2')
  const before = commit('before')
  const after = commit('after')
  const config: BenchmarkConfig = {
    schemaVersion: 1,
    upstream: { repository: 'fixture/source', commitSha: after, defaultBranch: 'main' },
    benchmarkRepository: {
      repository: 'fixture/replay',
      defaultBranch: 'main',
      controlBranch: 'bench/control',
      replayHistory: 'upstream',
    },
    scenarios: {
      main: {
        name: 'main',
        description: 'history',
        event: 'push',
        main: { branch: 'main', beforeSha: before, afterSha: after, changedPaths: ['code.txt'] },
        referenceRuns: [],
      },
    },
    patches: [],
    adaptations: [],
    collectors: [],
    runnerMapping: pinnedRunnerMapping(),
    profiles: createDefaultProfiles(),
    execution: {
      repetitions: 1,
      timeoutMinutes: 1,
      pollIntervalSeconds: 1,
      maxConcurrentExperiments: 1,
      publicRepoGitHubFree: true,
    },
  }
  const prepared = prepareExperiment({ source, workDir: join(root, 'prepared'), config, patches: [] })
  const payload = prepared.variants.main?.['starsling-baseline']
  if (!payload) throw new Error('missing payload')
  expect(payload.historyBaseSha).toBe(before)
  expect(run(payload.gitDir, 'rev-parse', `${payload.baseSha}^1`)).toBe(before)
  expect(run(payload.gitDir, 'rev-parse', `${payload.headSha}^1`)).toBe(payload.baseSha)
  // The full upstream history is reachable, and HEAD^1 still diffs only the scenario's change.
  expect(Number(run(payload.gitDir, 'rev-list', '--count', payload.headSha))).toBe(5)
  expect(run(payload.gitDir, 'diff', '--name-only', `${payload.headSha}^1`, payload.headSha)).toBe('code.txt')
  expect(run(payload.gitDir, 'count-objects', '-v')).toMatch(/^count: \d+/)
  expect(() => verifyPrepared(prepared, config)).not.toThrow()

  const shallow = join(root, 'shallow')
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${source}`, shallow])
  expect(() => prepareExperiment({ source: shallow, workDir: join(root, 'p2'), config, patches: [] })).toThrow(
    'needs a full clone',
  )
})
