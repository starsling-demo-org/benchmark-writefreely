import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import { createExperimentManifest, reconcileSamples } from '../src/manifest.ts'
import { collectSampleExecution, type PaginatedGitHubActionsApi } from '../src/collector.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import { evaluateJobIfCondition, matchesPathFilter } from '../src/inventory-helpers.ts'
import { computeDirectoryHash } from '../src/patcher.ts'
import { prepareReplayVariants } from '../src/generator.ts'
import { parseWorkflowYaml } from '../src/inventory.ts'
import { prepareExperiment, verifyPrepared } from '../src/prepared.ts'
import { validateCacheAndArtifactLifecycle } from '../src/cache-lifecycle.ts'
import { createDefaultProfiles } from '../src/config.ts'

const temps: string[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-hardening-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const api: PaginatedGitHubActionsApi = {
  listWorkflowRunsPage: async () => ({ runs: [], hasNextPage: false }),
  listJobsForRunAttemptPage: async () => ({ jobs: [], hasNextPage: false }),
  listRunArtifactsPage: async () => ({ artifacts: [], hasNextPage: false }),
}
describe('adversarial release gates', () => {
  it('rejects empty selection and accounts for every requested sample', () => {
    expect(() => createExperimentManifest({ experimentId: 'x', config: fixtureConfig, scenarioNames: [] })).toThrow()
    const manifest = createExperimentManifest({ experimentId: 'x', config: fixtureConfig })
    expect(reconcileSamples(manifest, []).filter((x) => x.startsWith('Missing sample'))).toHaveLength(
      manifest.samples.length,
    )
    const report = generateExperimentReport({ experimentId: 'x', config: fixtureConfig, samples: [], manifest })
    expect(report.comparisons.length).toBe(
      Object.keys(fixtureConfig.scenarios).length * Object.keys(fixtureConfig.profiles).length,
    )
    expect(report.comparisons.every((c) => !c.publishableHeadlineAllowed && !c.parityPassed)).toBe(true)
  })
  it('does not mark empty collection complete', async () => {
    const result = await collectSampleExecution({
      api,
      query: {
        sampleId: 'empty',
        repetition: 1,
        scenarioName: 'main-push',
        variant: 'github-baseline',
        profileName: 'cold',
        event: 'push',
        dispatchedAt: '2026-01-01T00:00:00Z',
        headSha: 'a'.repeat(40),
        targetBranch: 'main',
        defaultBranch: 'main',
      },
      scenarioInventory: {
        scenarioName: 'main-push',
        triggeredWorkflows: [],
        excludedWorkflows: [],
        downstreamWorkflowRuns: [],
        jobExpectations: [],
        mixedRunnerOnStarSling: false,
        movedJobs: [],
        retainedJobs: [],
        blockers: [],
      },
    })
    expect(result.complete).toBe(false)
    expect(result.metrics.wallClockSeconds).toBeNull()
  })
  it('rejects duplicate tuples and stale evidence fingerprints', () => {
    const manifest = createExperimentManifest({ experimentId: 'x', config: fixtureConfig })
    const requested = manifest.samples[0]
    if (!requested) throw new Error('Missing fixture sample')
    const sample = {
      ...requested,
      inputFingerprint: 'stale',
      workflows: [],
      metrics: { wallClockSeconds: 1, repoMinutes: 1 },
    } as unknown as Parameters<typeof reconcileSamples>[1][number]
    expect(reconcileSamples(manifest, [sample, sample]).some((x) => x.startsWith('Duplicate sample'))).toBe(true)
    expect(reconcileSamples(manifest, [sample]).some((x) => x.startsWith('Input fingerprint mismatch'))).toBe(true)
  })
  it('includes symlink targets and final payload bytes in hashes', () => {
    const root = temporary()
    const source = join(root, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'a'), 'a')
    writeFileSync(join(source, 'b'), 'b')
    symlinkSync('a', join(source, 'link'))
    const first = computeDirectoryHash(source)
    unlinkSync(join(source, 'link'))
    symlinkSync('b', join(source, 'link'))
    expect(computeDirectoryHash(source)).not.toBe(first)
    const config = { ...fixtureConfig, adaptations: [] }
    const result = prepareReplayVariants({
      upstreamSourceDir: source,
      workRootDir: join(root, 'work'),
      config,
      patches: [],
    })
    for (const variant of Object.values(result.variants))
      expect(computeDirectoryHash(variant.treeDir)).toBe(variant.lock.sourceTreeHash)
  })
  it('preserves per-event filters, ordered negation, boolean logic and matrix expansion', () => {
    expect(matchesPathFilter(['src/generated/a.ts'], ['src/**', '!src/generated/**'])).toBe(false)
    expect(matchesPathFilter(['src/generated/a.ts'], ['src/**', '!src/generated/**', 'src/generated/a.ts'])).toBe(true)
    const scenario = fixtureConfig.scenarios['pr-single-package']
    if (!scenario) throw new Error('Missing scenario')
    expect(
      evaluateJobIfCondition("github.event_name == 'push' || true", scenario, 'org/repo', [], {}).shouldExecute,
    ).toBe(true)
    expect(
      evaluateJobIfCondition("github.event_name != 'pull_request'", scenario, 'org/repo', [], {}).shouldExecute,
    ).toBe(false)
    expect(
      evaluateJobIfCondition("contains(needs.test.outputs.result, 'x')", scenario, 'org/repo', [], {}).unresolved,
    ).toBe(true)
    const inventory = parseWorkflowYaml(
      'ci.yml',
      'on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [release]\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    strategy:\n      matrix:\n        os: [a, b]\n        version: [1, 2]\n        exclude:\n          - os: a\n            version: 2\n        include:\n          - os: c\n            version: 3\n    steps: []\n',
    )
    expect(inventory.triggers.eventFilters?.pull_request?.branches).toEqual(['main'])
    expect(inventory.triggers.eventFilters?.push?.branches).toEqual(['release'])
    expect(inventory.jobs.test?.matrixConfig?.staticRows).toHaveLength(4)
  })
  it('cold allows only proven same-sample cache reuse; missing warm evidence fails', () => {
    const profile = createDefaultProfiles().cold
    const warm = createDefaultProfiles().warm
    if (!profile || !warm) throw new Error('Missing profile')
    const common = {
      expectedSourceSha: 'a'.repeat(40),
      consumerRef: 'refs/heads/main',
      defaultBranch: 'main',
      sampleId: 'current',
    }
    const event = {
      cacheKey: 'deps',
      matchedKey: 'deps',
      hitKind: 'exact' as const,
      sourceRef: 'refs/heads/main',
      producerSampleId: 'current',
      producerRunId: 1,
    }
    expect(validateCacheAndArtifactLifecycle({ ...common, profile, cacheEvents: [event] }).valid).toBe(true)
    expect(
      validateCacheAndArtifactLifecycle({ ...common, profile, cacheEvents: [{ ...event, producerSampleId: 'other' }] })
        .valid,
    ).toBe(false)
    expect(validateCacheAndArtifactLifecycle({ ...common, profile: warm, cacheEvents: [] }).valid).toBe(false)
  })
  it('CLI unknown commands and incomplete run arguments cannot exit successfully', () => {
    for (const args of [['typo'], ['run', '--config', resolve('tests/fixtures/definitelytyped.config.ts')]]) {
      const result = spawnSync(process.execPath, [resolve('src/cli.ts'), ...args], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).ok).toBe(false)
    }
  })
  it('prepares real scenario ancestry and rejects dirty/mismatched sources and modified payloads', () => {
    const root = temporary()
    const source = join(root, 'source')
    mkdirSync(join(source, '.github/workflows'), { recursive: true })
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
        { cwd: source, encoding: 'utf8' },
      ).trim()
    git('init', '-q', '-b', 'main')
    writeFileSync(
      join(source, '.github/workflows/ci.yml'),
      'on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo test\n',
    )
    writeFileSync(join(source, 'code.txt'), 'before')
    git('add', '.')
    git('commit', '-qm', 'base')
    const before = git('rev-parse', 'HEAD')
    writeFileSync(join(source, 'code.txt'), 'after')
    git('add', '.')
    git('commit', '-qm', 'head')
    const after = git('rev-parse', 'HEAD')
    const config = structuredClone(fixtureConfig)
    config.upstream.commitSha = after
    config.adaptations = []
    config.patches = []
    config.scenarios = {
      main: {
        name: 'main',
        description: 'test',
        event: 'push',
        main: { branch: 'main', beforeSha: before, afterSha: after, changedPaths: ['code.txt'] },
        referenceRuns: [],
      },
    }
    const prepared = prepareExperiment({ source, workDir: join(root, 'work'), config, patches: [] })
    verifyPrepared(prepared, config)
    const payload = prepared.variants.main?.['github-baseline']
    if (!payload) throw new Error('Missing payload')
    expect(
      execFileSync('git', ['diff', '--name-only', `${payload.headSha}^1`, payload.headSha], {
        cwd: payload.gitDir,
        encoding: 'utf8',
      }).trim(),
    ).toBe('code.txt')
    expect(
      execFileSync('git', ['show', '-s', '--format=%B', payload.baseSha], { cwd: payload.gitDir, encoding: 'utf8' }),
    ).toContain('[skip ci]')
    expect(
      execFileSync('git', ['show', '-s', '--format=%B', payload.headSha], { cwd: payload.gitDir, encoding: 'utf8' }),
    ).not.toContain('[skip ci]')
    expect(() => prepareExperiment({ source, workDir: join(root, 'work'), config, patches: [] })).toThrow(
      'already exists',
    )
    expect(readFileSync(join(payload.treeDir, 'code.txt'), 'utf8')).toBe('after')
    writeFileSync(join(payload.treeDir, 'code.txt'), 'tampered')
    expect(() => verifyPrepared(prepared, config)).toThrow('changed')
    writeFileSync(join(source, 'dirty.txt'), 'untracked')
    expect(() => prepareExperiment({ source, workDir: join(root, 'other'), config, patches: [] })).toThrow('clean')
  })
})

it('compound runner selectors stay intact without an explicit job mapping', async () => {
  const { resolveJobRunnerMapping } = await import('../src/inventory-helpers.ts')
  const { createDefaultRunnerMapping } = await import('../src/config.ts')
  for (const selector of [['ubuntu-latest', 'gpu'], { group: 'private', labels: 'ubuntu-latest' }]) {
    expect(resolveJobRunnerMapping('ci.yml', 'test', selector, createDefaultRunnerMapping()).retainedOnGitHub).toBe(
      true,
    )
  }
})

it('only a scoped text adaptation clears the upstream reusable-workflow blocker', async () => {
  const { scanJobBlockers } = await import('../src/inventory-helpers.ts')
  const uses = 'Org/Repo/.github/workflows/shared.yml@main'
  const workflow = { filePath: '.github/workflows/ci.yml' } as Parameters<typeof scanJobBlockers>[0]['workflow']
  const job = {
    jobId: 'build',
    runsOn: 'ubuntu-24.04',
    usesReusableWorkflow: uses,
    needs: [],
    steps: [],
    referencedSecrets: [],
    cachesUsed: [],
    artifactsProduced: [],
    artifactsConsumed: [],
  } as Parameters<typeof scanJobBlockers>[0]['job']
  const rule = (overrides: object) => ({
    id: 'r',
    kind: 'repository-identity-remap' as const,
    fromPattern: 'Org/Repo/.github/workflows/',
    toReplacement: './.github/workflows/',
    reason: 'local',
    ...overrides,
  })
  const blocked = (adaptations: ReturnType<typeof rule>[]) =>
    scanJobBlockers({ workflow, job, upstreamRepo: 'Org/Repo', adaptations }).some(
      (b) => b.category === 'inaccessible_external_workflow',
    )
  expect(blocked([])).toBe(true)
  expect(blocked([rule({ kind: 'workflow-setting', fromPattern: '' })])).toBe(true)
  expect(blocked([rule({ fromPattern: '' })])).toBe(true)
  expect(blocked([rule({ workflowFile: '.github/workflows/other.yml' })])).toBe(true)
  expect(blocked([rule({ jobId: 'other' })])).toBe(true)
  expect(blocked([rule({ workflowFile: '.github/workflows/ci.yml', jobId: 'build' })])).toBe(false)
})

it('rejects a --repetitions value that is not a positive integer before doing any work', () => {
  for (const value of ['0', '5x', '2.5']) {
    const out = spawnSync(
      process.execPath,
      [join(import.meta.dirname, '../src/cli.ts'), 'run', '--repetitions', value],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
      },
    )
    expect(JSON.parse(out.stdout).errors).toEqual([`--repetitions must be a positive integer, got "${value}"`])
    expect(out.status).toBe(1)
  }
})

it('lists every run since a date without the 1,000-result cap of filtered run searches', async () => {
  const { GitHubClient } = await import('../src/github.ts')
  const client = new GitHubClient('bench/replay')
  const requested: string[] = []
  const at = (n: number) =>
    `2026-11-07T${String(23 - Math.floor(n / 60)).padStart(2, '0')}:${String(59 - (n % 60)).padStart(2, '0')}:00Z`
  // 250 runs newest first, all on 2026-11-07, then older runs; page 2 repeats one run shifted by a new arrival.
  const runs = [...Array.from({ length: 250 }, (_, i) => ({ id: 1000 - i, created_at: at(i) }))]
  const pages: Record<number, object[]> = {
    1: runs.slice(0, 100),
    2: [runs[99] as object, ...runs.slice(100, 199)],
    3: [
      ...runs.slice(199, 250),
      ...Array.from({ length: 49 }, (_, i) => ({ id: 10 - i, created_at: '2026-11-06T12:00:00Z' })),
    ],
  }
  client.request = async (path: string) => {
    requested.push(path)
    expect(path).not.toContain('created=')
    return { workflow_runs: pages[Number(/[?&]page=(\d+)/.exec(path)?.[1])] ?? [] }
  }
  const listed = await client.runsCreatedSince('2026-11-07')
  expect(listed).toHaveLength(250)
  expect(new Set(listed.map((r) => r.id)).size).toBe(250)
  expect(requested).toHaveLength(3)
})
