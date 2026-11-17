import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import extract, { dangerOutcome } from '../collectors/definitelytyped.ts'
import { parseUnitCoverage, unitCoverage } from '../src/collectors.ts'
import {
  cacheConsumerRefs,
  cleanLog,
  type EvidenceJob,
  findInterference,
  observeCacheEvents,
  parseCacheLog,
} from '../src/evidence-collect.ts'
import { prepareReplayVariants } from '../src/generator.ts'
import { inspectRepository } from '../src/inventory.ts'
import { compareCoverageSummaries } from '../src/parity.ts'
import fixtureConfig from './fixtures/definitelytyped.config.ts'

const RESTORE_FALLBACK = `##[group]Run actions/cache/restore@abc
with:
  path: /home/runner/setup-pnpm/store
  key: Linux-pnpm-store-cache-
  restore-keys: Linux-pnpm-store-cache-
##[endgroup]
Cache hit for restore-key: Linux-pnpm-store-cache-2026-11-06
Cache restored successfully
Cache restored from key: Linux-pnpm-store-cache-2026-11-06`
const RESTORE_EXACT = `##[group]Run actions/cache@abc
with:
  key: Linux-dprint-h-2026-11-06
  path: ~/.cache/dprint
  restore-keys: Linux-dprint-h
Linux-dprint-
##[endgroup]
Cache hit for: Linux-dprint-h-2026-11-06
Cache restored from key: Linux-dprint-h-2026-11-06`
const MISS_AND_SAVE = `##[group]Run actions/cache@abc
with:
  key: Linux-dprint-h-2026-11-06
  restore-keys: Linux-dprint-h
Linux-dprint-
##[endgroup]
Cache not found for input keys: Linux-dprint-h-2026-11-06, Linux-dprint-h, Linux-dprint-
##[group]Run pnpm dprint fmt
Post job cleanup.
Cache saved with key: Linux-dprint-h-2026-11-06`

const job = (name: string, log: string, steps: [string, string][] = []): EvidenceJob => ({
  workflowPath: '.github/workflows/CI.yml',
  jobName: name,
  logicalJobId: name.split(' (')[0] ?? name,
  runId: 7,
  jobId: 70,
  conclusion: 'success',
  steps: steps.map(([stepName, conclusion]) => ({ name: stepName, conclusion })),
  log,
})

describe('cache events from job logs', () => {
  it('distinguishes exact hits, restore-key fallbacks, misses and saves', () => {
    const fallback = parseCacheLog(RESTORE_FALLBACK).restores[0]
    expect(fallback).toMatchObject({ cacheKey: 'Linux-pnpm-store-cache-', exact: false })
    expect(fallback?.matchedKey).toBe('Linux-pnpm-store-cache-2026-11-06')
    const exact = parseCacheLog(RESTORE_EXACT).restores[0]
    expect(exact).toMatchObject({ exact: true, restoreKeys: ['Linux-dprint-h', 'Linux-dprint-'] })
    const missed = parseCacheLog(MISS_AND_SAVE)
    expect(missed.restores).toEqual([
      {
        cacheKey: 'Linux-dprint-h-2026-11-06',
        restoreKeys: ['Linux-dprint-h', 'Linux-dprint-'],
        matchedKey: null,
        exact: false,
        action: 'actions/cache@abc',
      },
    ])
    expect(missed.saves).toEqual(['Linux-dprint-h-2026-11-06'])
    expect(cleanLog('2026-11-06T01:02:03.4567890Z \u001b[36;1mpnpm ls\u001b[0m')).toBe('pnpm ls')
  })

  it('binds hits to the producing ref and to the sample when the sample produced them', () => {
    const sample = {
      sampleId: 's1',
      workflows: [{ startedAt: '2026-11-06T10:00:00Z' }],
    } as unknown as Parameters<typeof observeCacheEvents>[0]['sample']
    const events = observeCacheEvents({
      sample,
      jobs: [job('test (1, 1)', RESTORE_FALLBACK), job('dprint-fmt', RESTORE_EXACT)],
      caches: [
        { key: 'Linux-pnpm-store-cache-2026-11-06', ref: 'refs/heads/master', created_at: '2026-11-06T09:00:00Z' },
        { key: 'Linux-dprint-h-2026-11-06', ref: 'refs/heads/master', created_at: '2026-11-06T10:01:00Z' },
      ],
    })
    expect(events.map((e) => [e.hitKind, e.sourceRef, e.producerSampleId ?? null])).toEqual([
      ['restore-key-fallback', 'refs/heads/master', null],
      ['exact', 'refs/heads/master', 's1'],
    ])
  })
})

describe('cache scope of a replay', () => {
  it('scopes a PR sample to the replay PR and the upstream base branch, not the upstream PR number', () => {
    const pr = Object.values(fixtureConfig.scenarios).find((s) => s.pr)
    const push = Object.values(fixtureConfig.scenarios).find((s) => !s.pr)
    if (!pr?.pr || !push) throw new Error('fixture needs a PR and a branch scenario')
    expect(cacheConsumerRefs({ scenario: pr, replayBranch: 'main', replayPrNumber: 3 })).toEqual({
      consumerRef: 'refs/pull/3/merge',
      consumerBaseRef: `refs/heads/${pr.pr.baseRef}`,
    })
    expect(cacheConsumerRefs({ scenario: push, replayBranch: 'develop', replayPrNumber: undefined })).toEqual({
      consumerRef: 'refs/heads/develop',
    })
    expect(() => cacheConsumerRefs({ scenario: pr, replayBranch: 'main', replayPrNumber: undefined })).toThrow(
      'No replay PR',
    )
  })
})

describe('check coverage', () => {
  it('pins the unit scope so dropped units cannot keep 100%', () => {
    const baseline = unitCoverage({ scope: ['package:a', 'scripts:tsc'], covered: ['package:a', 'scripts:tsc'] })
    expect(baseline.lines).toEqual({ total: 2, covered: 2, percentage: 100 })
    const dropped = unitCoverage({ scope: ['package:a'], covered: ['package:a'] })
    expect(compareCoverageSummaries(baseline, dropped).passed).toBe(false)
    expect(
      compareCoverageSummaries(
        baseline,
        parseUnitCoverage(
          JSON.stringify({ scope: ['scripts:tsc', 'package:a'], covered: ['package:a', 'scripts:tsc'] }),
        ),
      ).passed,
    ).toBe(true)
    expect(() => parseUnitCoverage('{"scope":[],"covered":[]}')).toThrow('non-empty')
  })
})

describe('DefinitelyTyped extractor', () => {
  const testLog = `##[group]Run pnpm run test-all --diffBase HEAD^1 --shardCount 1 --shardId 1
Testing 1 changed packages: Set(1) { 'wordpress__block-editor' }
Testing 1 dependent packages: Set(1) { 'wordpress__editor' }
Testing 0 packages from attw.json changes: Set(0) {}
1> wordpress__block-editor START
1> wordpress__block-editor OK
2> wordpress__editor OK`
  const dangerLog = `DANGER_GITHUB_API_TOKEN=$TOKEN pnpm danger ci || $( exit 0 )
POST /repos/o/r/statuses/${'a'.repeat(40)} - 403 with id 1 in 10ms`
  const scenario = fixtureConfig.scenarios['pr-single-package']
  if (!scenario) throw new Error('missing scenario')

  it('derives identical verdicts and coverage from the upstream and folded job graphs', () => {
    const upstream = extract({
      scenario,
      sample: {} as never,
      jobs: [
        job('test (1, 1)', testLog),
        job('scripts', '##[group]Run pnpm tsc -p ./scripts', [['Run pnpm tsc -p ./scripts', 'success']]),
        job('dangerbot', dangerLog, [['Run Danger', 'success']]),
      ],
    })
    const folded = extract({
      scenario,
      sample: {} as never,
      jobs: [
        job('test', `${testLog}\n${dangerLog}`, [
          ['Run Danger', 'success'],
          ['Type-check scripts (tsc -p ./scripts)', 'success'],
        ]),
      ],
    })
    expect(folded.tests).toEqual(upstream.tests)
    expect(folded.coverage).toEqual(upstream.coverage)
    expect(upstream.coverage?.scope).toEqual([
      'danger',
      'package:wordpress__block-editor',
      'package:wordpress__editor',
      'scripts:tsc',
    ])
    expect(upstream.obligations).toEqual(['danger-pr-check', 'test-changed-packages', 'typecheck-scripts'])
  })

  it('fails units that did not pass and classifies Danger outcomes', () => {
    const failing = extract({
      scenario,
      sample: {} as never,
      jobs: [
        job('test', testLog.replace('2> wordpress__editor OK', '2> wordpress__editor FAIL'), [
          ['Type-check scripts (tsc -p ./scripts)', 'failure'],
        ]),
      ],
    })
    expect(failing.coverage?.covered).toEqual(['package:wordpress__block-editor'])
    expect(failing.obligations).toEqual([])
    expect(dangerOutcome('POST /repos/o/r/statuses/'.concat('b'.repeat(40), ' - 404 with id'))).toBe('status-404')
    expect(dangerOutcome('HttpError: Not Found')).toBe('error:Not Found')
  })
})

describe('workflow adaptations and dispatch scenarios', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('sets workflow YAML paths and checks per-variant match counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-adapt-'))
    dirs.push(root)
    const source = join(root, 'source')
    mkdirSync(join(source, '.github/workflows'), { recursive: true })
    writeFileSync(
      join(source, '.github/workflows/ci.yml'),
      'on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: TOKEN=x pnpm danger ci\n',
    )
    const patch = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -6,3 +6,4 @@ jobs:
     runs-on: ubuntu-24.04
     steps:
       - run: TOKEN=x pnpm danger ci
+      - run: TOKEN=x pnpm danger ci
`
    const config = structuredClone(fixtureConfig)
    config.adaptations = [
      {
        id: 'perm',
        kind: 'workflow-setting',
        workflowFile: '.github/workflows/ci.yml',
        setPath: ['permissions'],
        setValue: 'read-all',
        fromPattern: '',
        toReplacement: '',
        reason: 'read-only token like upstream',
      },
      {
        id: 'token',
        kind: 'external-dependency-stub',
        workflowFile: '.github/workflows/ci.yml',
        fromPattern: 'TOKEN=x',
        toReplacement: 'TOKEN=y',
        expectedMatches: 1,
        expectedMatchesPatched: 2,
        reason: 'token',
      },
    ]
    const patches = [
      {
        id: 'p',
        source: 'local' as const,
        originalPathOrUrl: 'p',
        immutableOrigin: 'p',
        resolvedRevision: 'p',
        sha256: 'p',
        byteLength: patch.length,
        patchContent: patch,
      },
    ]
    const bundle = prepareReplayVariants({
      upstreamSourceDir: source,
      workRootDir: join(root, 'work'),
      config,
      patches,
    })
    const read = (variant: 'github-baseline' | 'github-patched') =>
      inspectRepository(bundle.variants[variant].treeDir, config).workflows['.github/workflows/ci.yml']
    expect(read('github-baseline')?.permissions).toBe('read-all')
    expect(read('github-patched')?.jobs.a?.steps.map((s) => s.run)).toEqual([
      'TOKEN=y pnpm danger ci',
      'TOKEN=y pnpm danger ci',
    ])
    const wrong = structuredClone(config)
    const rule = wrong.adaptations[1]
    if (rule) delete rule.expectedMatchesPatched
    expect(() =>
      prepareReplayVariants({ upstreamSourceDir: source, workRootDir: join(root, 'work2'), config: wrong, patches }),
    ).toThrow('expected 1 match(es) in patched .github/workflows/ci.yml, found 2')
  })

  it('triggers exactly the dispatched workflows in a workflow_dispatch scenario', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-dispatch-'))
    dirs.push(root)
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    const write = (name: string, on: string) =>
      writeFileSync(
        join(root, '.github/workflows', name),
        `name: ${name}\non: ${on}\njobs:\n  j:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n`,
      )
    write('pnpm-cache.yml', '[workflow_dispatch, schedule]')
    write('ci.yml', '[push, workflow_dispatch]')
    write('fmt.yml', '[push, workflow_dispatch]')
    const config = structuredClone(fixtureConfig)
    config.scenarios = {
      'cache-seed': {
        name: 'cache-seed',
        description: 'seed',
        event: 'workflow_dispatch',
        main: { branch: 'master', beforeSha: 'a'.repeat(40), afterSha: 'b'.repeat(40), changedPaths: [] },
        dispatch: { workflows: ['.github/workflows/pnpm-cache.yml', '.github/workflows/fmt.yml'] },
        referenceRuns: [],
      },
    }
    const inventory = inspectRepository(root, config).scenarios['cache-seed']
    expect(inventory?.triggeredWorkflows.sort()).toEqual([
      '.github/workflows/fmt.yml',
      '.github/workflows/pnpm-cache.yml',
    ])
    expect(inventory?.excludedWorkflows.map((w) => w.filePath)).toEqual(['.github/workflows/ci.yml'])
  })
})

describe('interference', () => {
  it('flags runs outside a sample that overlapped its execution window', () => {
    const sample = {
      sampleId: 's1',
      workflows: [{ runId: 1, startedAt: '2026-11-07T10:00:00Z', completedAt: '2026-11-07T10:05:00Z' }],
    } as unknown as Parameters<typeof findInterference>[0][number]
    const run = (id: number, start: string, end: string, path = '.github/workflows/CI.yml', event = 'schedule') => ({
      id,
      path,
      event,
      run_started_at: start,
      updated_at: end,
    })
    expect(
      findInterference(
        [sample],
        [
          run(1, '2026-11-07T10:00:00Z', '2026-11-07T10:05:00Z', '.github/workflows/CI.yml', 'push'),
          run(2, '2026-11-07T10:04:00Z', '2026-11-07T10:40:00Z'),
          run(3, '2026-11-07T09:00:00Z', '2026-11-07T09:59:00Z'),
          {
            ...run(5, '2026-11-07T10:02:00Z', '2026-11-07T10:02:10Z', '.github/workflows/support-window.yml', 'push'),
            conclusion: 'skipped',
          },
          run(4, '2026-11-07T10:01:00Z', '2026-11-07T10:01:30Z', 'dynamic/dependabot/dependabot-updates', 'dynamic'),
          // Cancelled by staging just before the event; the cancellation landed after the sample started.
          {
            ...run(
              6,
              '2026-11-07T09:58:00Z',
              '2026-11-07T10:00:08Z',
              'dynamic/dependabot/dependabot-updates',
              'dynamic',
            ),
            conclusion: 'cancelled',
          },
        ],
      ),
    ).toEqual({
      s1: ['.github/workflows/CI.yml (schedule, run 2)', 'dynamic/dependabot/dependabot-updates (dynamic, run 4)'],
    })
  })
})
