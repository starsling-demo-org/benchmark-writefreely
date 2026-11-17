import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createDefaultProfiles } from '../src/config.ts'
import { assertStagedTreeMatchesUpstream, prepareExperiment } from '../src/prepared.ts'
import type { BenchmarkConfig, LockedPatchRecord } from '../src/types.ts'
import { pinnedRunnerMapping } from './fixtures/pinned-runner-mapping.ts'

const root = mkdtempSync(join(tmpdir(), 'bench-staged-tracked-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()

/** Mirrors writefreely: a nested .gitignore ignores `*.css`, yet two vendored stylesheets are force-tracked. */
function ignoredButTrackedSource(dir: string): { before: string; after: string } {
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  mkdirSync(join(dir, 'static/css/lib'), { recursive: true })
  run(dir, 'init', '-q', '-b', 'main')
  writeFileSync(
    join(dir, '.github/workflows/ci.yml'),
    'on: push\njobs:\n  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n',
  )
  writeFileSync(join(dir, 'static/css/.gitignore'), '*.css\n')
  writeFileSync(join(dir, 'static/css/lib/vendored.min.css'), 'a{}')
  writeFileSync(join(dir, 'code.txt'), 'before')
  run(dir, 'add', '.')
  run(dir, 'add', '-f', 'static/css/lib/vendored.min.css')
  run(dir, 'commit', '-qm', 'before')
  const before = run(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'code.txt'), 'after')
  run(dir, 'add', 'code.txt')
  run(dir, 'commit', '-qm', 'after')
  return { before, after: run(dir, 'rev-parse', 'HEAD') }
}

function configFor(before: string, after: string): BenchmarkConfig {
  return {
    schemaVersion: 1,
    upstream: { repository: 'fixture/source', commitSha: after, defaultBranch: 'main' },
    benchmarkRepository: { repository: 'fixture/replay', defaultBranch: 'main', controlBranch: 'bench/control' },
    scenarios: {
      main: {
        name: 'main',
        description: 'ignored-but-tracked',
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
}

it('stages tracked files that a .gitignore pattern matches', () => {
  const source = join(root, 'source')
  const { before, after } = ignoredButTrackedSource(source)
  const prepared = prepareExperiment({
    source,
    workDir: join(root, 'prepared'),
    config: configFor(before, after),
    patches: [],
  })
  for (const payload of Object.values(prepared.variants.main ?? {})) {
    for (const sha of [payload.baseSha, payload.headSha])
      expect(run(payload.gitDir, 'ls-tree', '-r', '--name-only', sha).split('\n')).toContain(
        'static/css/lib/vendored.min.css',
      )
  }
})

it('fails when a tracked upstream path is missing from the staged tree and no patch touches it', () => {
  const source = join(root, 'source2')
  const { after } = ignoredButTrackedSource(source)
  const replay = join(root, 'replay2')
  mkdirSync(replay)
  run(replay, 'init', '-q', '-b', 'main')
  const archive = join(root, 'source2.tar')
  run(source, 'archive', '--format=tar', `--output=${archive}`, after)
  execFileSync('tar', ['-xf', archive, '-C', replay])
  rmSync(join(replay, 'static/css/lib/vendored.min.css'))
  run(replay, 'add', '-A')
  run(replay, 'commit', '-qm', 'staged')
  const staged = run(replay, 'rev-parse', 'HEAD')
  expect(() =>
    assertStagedTreeMatchesUpstream({
      source,
      upstreamSha: after,
      replayGitDir: replay,
      replayCommit: staged,
      patches: [],
    }),
  ).toThrow(/static\/css\/lib\/vendored\.min\.css/)
  const deletingPatch = {
    patchContent:
      'diff --git a/static/css/lib/vendored.min.css b/static/css/lib/vendored.min.css\ndeleted file mode 100644\n',
  } as LockedPatchRecord
  expect(() =>
    assertStagedTreeMatchesUpstream({
      source,
      upstreamSha: after,
      replayGitDir: replay,
      replayCommit: staged,
      patches: [deletingPatch],
    }),
  ).not.toThrow()
})
