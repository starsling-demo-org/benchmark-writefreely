import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDefaultProfiles } from '../src/config.ts'
import { mirrorTagsToRemote } from '../src/history-tags.ts'
import { prepareExperiment } from '../src/prepared.ts'
import type { BenchmarkConfig } from '../src/types.ts'
import { pinnedRunnerMapping } from './fixtures/pinned-runner-mapping.ts'

const root = mkdtempSync(join(tmpdir(), 'bench-upstream-tags-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()

/** Upstream with tags before, at and after the pin, plus a tag on a branch the pin does not contain. */
function fixture() {
  const source = join(root, `source-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(source, '.github/workflows'), { recursive: true })
  run(source, 'init', '-q', '-b', 'main')
  writeFileSync(
    join(source, '.github/workflows/ci.yml'),
    'on: push\njobs:\n  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: git describe --tags\n',
  )
  const commit = (content: string) => {
    writeFileSync(join(source, 'code.txt'), content)
    run(source, 'add', '.')
    run(source, 'commit', '-qm', content)
    return run(source, 'rev-parse', 'HEAD')
  }
  commit('old-1')
  run(source, 'tag', 'v0.1.0') // lightweight
  commit('old-2')
  run(source, 'tag', '-a', 'v0.2.0', '-m', 'release 0.2.0') // annotated
  const before = commit('before')
  run(source, 'tag', '-a', 'v0.3.0', '-m', 'release 0.3.0')
  const after = commit('after')
  run(source, 'tag', '-a', 'v1.0.0', '-m', 'release 1.0.0') // at the pin
  commit('later')
  run(source, 'tag', '-a', 'v2.0.0', '-m', 'release 2.0.0') // after the pin
  run(source, 'checkout', '-q', '-b', 'side', before)
  commit('side-only')
  run(source, 'tag', 'v-side') // not an ancestor of the pin
  run(source, 'checkout', '-q', '--detach', after)
  return { source, before, after }
}
const configFor = (before: string, after: string, extra: Partial<BenchmarkConfig['benchmarkRepository']> = {}) =>
  ({
    schemaVersion: 1,
    upstream: { repository: 'fixture/source', commitSha: after, defaultBranch: 'main' },
    benchmarkRepository: {
      repository: 'fixture/replay',
      defaultBranch: 'main',
      controlBranch: 'bench/control',
      replayHistory: 'upstream',
      ...extra,
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
  }) satisfies BenchmarkConfig
const bare = (name: string) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  run(dir, 'init', '-q', '--bare')
  return dir
}
const remoteTags = (remote: string) =>
  Object.fromEntries(
    run(remote, 'for-each-ref', '--format=%(refname:short) %(objecttype)', 'refs/tags')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ') as [string, string]),
  )

describe('upstream tag mirroring', () => {
  it('records exactly the tags at or before the pin, annotated ones as tag objects', () => {
    const { source, before, after } = fixture()
    const prepared = prepareExperiment({
      source,
      workDir: join(root, `p-${before.slice(0, 6)}`),
      config: configFor(before, after),
      patches: [],
    })
    const payload = prepared.variants.main?.['starsling-baseline']
    expect(payload?.historyTags?.map((t) => t.name).sort()).toEqual(['v0.1.0', 'v0.2.0', 'v0.3.0', 'v1.0.0'])
    // Annotated tags are recorded by tag-object id, not by the commit they peel to.
    const v2 = payload?.historyTags?.find((t) => t.name === 'v0.2.0')
    expect(run(source, 'cat-file', '-t', v2?.objectSha ?? '')).toBe('tag')
  })

  it('mirrors them to the remote as refs/tags, none after the pin, and git describe works on replay commits', () => {
    const { source, before, after } = fixture()
    const prepared = prepareExperiment({
      source,
      workDir: join(root, `p2-${before.slice(0, 6)}`),
      config: configFor(before, after),
      patches: [],
    })
    const payload = prepared.variants.main?.['starsling-baseline']
    if (!payload?.historyTags) throw new Error('no tags recorded')
    const remote = bare('remote-a')
    mirrorTagsToRemote({ gitDir: payload.gitDir, remoteUrl: remote, tags: payload.historyTags })
    expect(remoteTags(remote)).toEqual({ 'v0.1.0': 'commit', 'v0.2.0': 'tag', 'v0.3.0': 'tag', 'v1.0.0': 'tag' })
    expect(run(remote, 'rev-parse', 'refs/tags/v0.2.0^{commit}')).toBe(run(source, 'rev-parse', 'v0.2.0^{commit}'))
    // The replay commits sit on the real `before`, so describe finds the tag there: base +1, head +1.
    run(payload.gitDir, 'push', '-q', remote, `${payload.headSha}:refs/heads/main`)
    const clone = join(root, 'clone-a')
    run(root, 'clone', '-q', remote, clone)
    expect(run(clone, 'describe', '--tags')).toMatch(/^v0\.3\.0-2-g[0-9a-f]+$/)
  })

  it('is idempotent, and refuses to overwrite a different existing tag', () => {
    const { source, before, after } = fixture()
    const prepared = prepareExperiment({
      source,
      workDir: join(root, `p3-${before.slice(0, 6)}`),
      config: configFor(before, after),
      patches: [],
    })
    const payload = prepared.variants.main?.['starsling-baseline']
    if (!payload?.historyTags) throw new Error('no tags recorded')
    const remote = bare('remote-b')
    const args = { gitDir: payload.gitDir, remoteUrl: remote, tags: payload.historyTags }
    mirrorTagsToRemote(args)
    const first = run(remote, 'for-each-ref', 'refs/tags')
    expect(() => mirrorTagsToRemote(args)).not.toThrow()
    expect(run(remote, 'for-each-ref', 'refs/tags')).toBe(first)

    const other = bare('remote-c')
    run(payload.gitDir, 'push', '-q', other, `${payload.headSha}:refs/tags/v0.1.0`)
    expect(() => mirrorTagsToRemote({ ...args, remoteUrl: other })).toThrow(/v0\.1\.0.*different/)
    expect(run(other, 'rev-parse', 'refs/tags/v0.1.0')).toBe(payload.headSha) // untouched
    expect(remoteTags(other)).toEqual({ 'v0.1.0': 'commit' }) // nothing else was pushed either
  })

  it('can be switched off with mirrorTags: false', () => {
    const { source, before, after } = fixture()
    const prepared = prepareExperiment({
      source,
      workDir: join(root, `p4-${before.slice(0, 6)}`),
      config: configFor(before, after, { mirrorTags: false }),
      patches: [],
    })
    expect(prepared.variants.main?.['starsling-baseline']?.historyTags).toBeUndefined()
  })
})
