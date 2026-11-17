import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDefaultProfiles } from '../src/config.ts'
import { pinnedRunnerMapping } from './fixtures/pinned-runner-mapping.ts'
import { materializeCommit, prepareExperiment, type PreparedExperiment, verifyPrepared } from '../src/prepared.ts'
import type { BenchmarkConfig } from '../src/types.ts'

const root = mkdtempSync(join(tmpdir(), 'bench-prepared-identity-'))
const source = join(root, 'source')
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd: source, encoding: 'utf8', stdio: 'pipe' },
  ).trim()
let prepared: PreparedExperiment
let config: BenchmarkConfig
beforeAll(() => {
  mkdirSync(join(source, '.github/workflows'), { recursive: true })
  git('init', '-q', '-b', 'main')
  writeFileSync(
    join(source, '.github/workflows/ci.yml'),
    'on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo test\n',
  )
  writeFileSync(join(source, 'code.txt'), 'before')
  git('add', '.')
  git('commit', '-qm', 'before')
  const beforeSha = git('rev-parse', 'HEAD')
  writeFileSync(join(source, 'code.txt'), 'after')
  git('add', '.')
  git('commit', '-qm', 'after')
  const afterSha = git('rev-parse', 'HEAD')
  config = {
    schemaVersion: 1,
    upstream: { repository: 'fixture/source', commitSha: afterSha, defaultBranch: 'main' },
    benchmarkRepository: { repository: 'fixture/replay', defaultBranch: 'main', controlBranch: 'bench/control' },
    scenarios: {
      main: {
        name: 'main',
        description: 'Identity fixture',
        event: 'push',
        main: { branch: 'main', beforeSha, afterSha, changedPaths: ['code.txt'] },
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
  prepared = prepareExperiment({ source, workDir: join(root, 'prepared'), config, patches: [] })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('prepared experiment identity', () => {
  it('verifies a serialized identity independent of object property order', () => {
    const reversed = JSON.parse(JSON.stringify(prepared), (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).reverse())
      return value
    }) as PreparedExperiment
    expect(() => verifyPrepared(reversed, config)).not.toThrow()
  })
  it.each(['inventory', 'baseSha', 'mergeSha', 'workflowFiles', 'patchIdentities'] as const)(
    'rejects modified %s before trusting local payloads',
    (field) => {
      const changed = structuredClone(prepared)
      const payload = changed.variants.main?.['github-baseline']
      if (!payload) throw new Error('Missing fixture payload')
      if (field === 'inventory') payload.inventory.triggeredWorkflows = []
      else if (field === 'baseSha' || field === 'mergeSha') payload[field] = 'a'.repeat(40)
      else if (field === 'workflowFiles') payload.workflowFiles = []
      else
        changed.patchIdentities.push({
          id: 'injected',
          source: 'local',
          originalPathOrUrl: 'a.patch',
          immutableOrigin: 'a.patch',
          resolvedRevision: '',
          sha256: 'a'.repeat(64),
          byteLength: 1,
        })
      expect(() => verifyPrepared(changed, config)).toThrow('metadata fingerprint')
      expect(() => verifyPrepared(changed, config, { recovery: true })).toThrow('metadata fingerprint')
    },
  )
  it.each(['export-ignore', 'export-subst'])(
    'rejects nested %s rather than silently changing committed source',
    (attribute) => {
      mkdirSync(join(source, 'nested'), { recursive: true })
      writeFileSync(join(source, 'nested/.gitattributes'), `* ${attribute}\n`)
      writeFileSync(join(source, 'nested/input.txt'), '$Format:%H$\n')
      git('add', '.')
      git('commit', '-qm', attribute)
      expect(() => materializeCommit(source, git('rev-parse', 'HEAD'), join(root, attribute))).toThrow(
        'exact-tree adapter',
      )
    },
  )
})
