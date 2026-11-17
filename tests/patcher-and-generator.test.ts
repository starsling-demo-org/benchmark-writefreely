import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeSha256, createDefaultProfiles, defineBenchmarkConfig } from '../src/config.ts'
import { pinnedRunnerMapping } from './fixtures/pinned-runner-mapping.ts'
import { prepareReplayVariants, verifyDeterministicRegeneration } from '../src/generator.ts'
import {
  applyPatchStackToDirectory,
  constructReplayAncestry,
  materializeVariantSourceTrees,
  verifyCleanWorktree,
} from '../src/patcher.ts'
import type { LockedPatchRecord } from '../src/types.ts'

function makeLockedPatch(id: string, content: string): LockedPatchRecord {
  const sha = computeSha256(content)
  return {
    id,
    source: 'local',
    originalPathOrUrl: `${id}.patch`,
    immutableOrigin: `file://${id}.patch#sha256=${sha}`,
    resolvedRevision: 'a'.repeat(40),
    sha256: sha,
    byteLength: Buffer.byteLength(content, 'utf8'),
    patchContent: content,
  }
}

describe('Stage 1: Patch materialization, ordering, binary changes, workflow add/remove, and deterministic generation', () => {
  const tempDirs: string[] = []

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `bench-${prefix}-`))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0, tempDirs.length)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('applies ordered patches, preserves executable bits, handles workflow additions/removals, and verifies deterministic regeneration', () => {
    const root = createTempDir('regen')
    const upstreamDir = join(root, 'upstream')
    mkdirSync(join(upstreamDir, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(upstreamDir, 'src'), { recursive: true })

    writeFileSync(
      join(upstreamDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on: [pull_request, push]',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm test',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(upstreamDir, '.github', 'workflows', 'legacy.yml'),
      [
        'name: Legacy',
        'on: [push]',
        'jobs:',
        '  old:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo old',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(join(upstreamDir, 'src', 'app.ts'), 'export const value = 1\n', 'utf8')

    // Patch 1: modifies src/app.ts and removes .github/workflows/legacy.yml
    const patch1 = [
      'diff --git a/.github/workflows/legacy.yml b/.github/workflows/legacy.yml',
      'deleted file mode 100644',
      '--- a/.github/workflows/legacy.yml',
      '+++ /dev/null',
      '@@ -1,7 +0,0 @@',
      '-name: Legacy',
      '-on: [push]',
      '-jobs:',
      '-  old:',
      '-    runs-on: ubuntu-latest',
      '-    steps:',
      '-      - run: echo old',
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-export const value = 1',
      '+export const value = 2',
      '',
    ].join('\n')

    // Patch 2 (depends on Patch 1 order!): updates value 2 -> 3, adds executable script, and adds new workflow
    const patch2 = [
      'diff --git a/.github/workflows/fast-Verify.yml b/.github/workflows/fast-Verify.yml',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/.github/workflows/fast-Verify.yml',
      '@@ -0,0 +1,8 @@',
      '+name: Fast Verify',
      '+on: [pull_request]',
      '+jobs:',
      '+  verify:',
      '+    runs-on: ubuntu-latest',
      '+    steps:',
      '+      - uses: actions/checkout@v4',
      '+      - run: ./scripts/fast.sh',
      'diff --git a/scripts/fast.sh b/scripts/fast.sh',
      'new file mode 100755',
      '--- /dev/null',
      '+++ b/scripts/fast.sh',
      '@@ -0,0 +1,2 @@',
      '+#!/bin/sh',
      '+echo "fast"',
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-export const value = 2',
      '+export const value = 3',
      '',
    ].join('\n')

    const patches = [makeLockedPatch('01-base-opt', patch1), makeLockedPatch('02-fast-wf', patch2)]
    const config = defineBenchmarkConfig({
      schemaVersion: 1,
      upstream: {
        repository: 'org/demo',
        commitSha: '1'.repeat(40),
        defaultBranch: 'main',
      },
      benchmarkRepository: {
        repository: 'starsling-bench/demo',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
      },
      scenarios: {
        pr: {
          name: 'pr',
          description: 'PR scenario',
          event: 'pull_request',
          pr: {
            prNumber: 10,
            baseRef: 'main',
            headRef: 'feat/x',
            baseSha: '1'.repeat(40),
            headSha: '2'.repeat(40),
            mergeSha: '3'.repeat(40),
            activityType: 'synchronize',
            changedPaths: ['src/app.ts'],
            labels: [],
          },
          referenceRuns: [],
        },
      },
      patches: [],
      runnerMapping: pinnedRunnerMapping(),
      profiles: createDefaultProfiles(),
      adaptations: [],
      collectors: [],
      execution: {
        repetitions: 5,
        timeoutMinutes: 30,
        maxConcurrentExperiments: 1,
        pollIntervalSeconds: 10,
        publicRepoGitHubFree: true,
      },
    })

    const workDir = join(root, 'work')
    const prepared = prepareReplayVariants({
      upstreamSourceDir: upstreamDir,
      workRootDir: workDir,
      config,
      patches,
    })

    // Baseline still has legacy.yml and not fast-Verify.yml
    expect(Object.keys(prepared.baselineInventory.workflows)).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/legacy.yml',
    ])
    // Patched removed legacy.yml and added fast-Verify.yml before workflow discovery!
    expect(Object.keys(prepared.patchedInventory.workflows)).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/fast-Verify.yml',
    ])

    // Executable bit 100755 preserved on scripts/fast.sh
    const scriptStat = lstatSync(join(prepared.variants['starsling-patched'].treeDir, 'scripts', 'fast.sh'))
    expect((scriptStat.mode & 0o111) !== 0).toBe(true)

    // Deterministic regeneration check passes
    const regen = verifyDeterministicRegeneration({
      upstreamSourceDir: upstreamDir,
      workRootDir: workDir,
      config,
      patches,
      expectedVariantLocks: {
        'github-baseline': prepared.variants['github-baseline'].lock,
        'github-patched': prepared.variants['github-patched'].lock,
        'starsling-baseline': prepared.variants['starsling-baseline'].lock,
        'starsling-patched': prepared.variants['starsling-patched'].lock,
      },
    })
    expect(regen.verified).toBe(true)
    expect(regen.mismatches).toEqual([])

    const p1 = patches[0]
    const p2 = patches[1]
    if (!p1 || !p2) throw new Error('Expected 2 patches')

    // Reversing patch order fails because patch 2 expects value = 2
    expect(() =>
      materializeVariantSourceTrees({
        upstreamSourceDir: upstreamDir,
        workRootDir: join(root, 'reversed'),
        patches: [p2, p1],
      }),
    ).toThrow(/failed clean check/)
  })

  it('rejects conflicts, partial patches, and empty patches, and supports binary patches and clean-tree checks', () => {
    const root = createTempDir('binary-and-errors')
    const targetDir = join(root, 'repo')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'readme.txt'), 'line 1\nline 2\n', 'utf8')

    // Empty patch rejected
    expect(() => applyPatchStackToDirectory(targetDir, [makeLockedPatch('empty', '   \n')], join(root, 'tmp'))).toThrow(
      /Unexpected empty patch/,
    )

    // Partial / conflicting patch rejected without mutating targetDir
    const partialPatch = [
      'diff --git a/readme.txt b/readme.txt',
      '--- a/readme.txt',
      '+++ b/readme.txt',
      '@@ -1,2 +1,2 @@',
      '-line 1',
      '+line 1 updated',
      'diff --git a/nonexistent.txt b/nonexistent.txt',
      '--- a/nonexistent.txt',
      '+++ b/nonexistent.txt',
      '@@ -1 +1 @@',
      '-missing',
      '+present',
      '',
    ].join('\n')

    expect(() =>
      applyPatchStackToDirectory(targetDir, [makeLockedPatch('partial', partialPatch)], join(root, 'tmp')),
    ).toThrow(/failed clean check/)
    expect(readFileSync(join(targetDir, 'readme.txt'), 'utf8')).toBe('line 1\nline 2\n')

    // Create a real GIT binary patch using git diff --binary
    const binGenDir = join(root, 'bin-gen')
    mkdirSync(binGenDir, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: binGenDir })
    const binaryBytes = Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff])
    writeFileSync(join(binGenDir, 'asset.bin'), binaryBytes)
    execFileSync('git', ['add', 'asset.bin'], { cwd: binGenDir })
    const binaryPatchText = execFileSync('git', ['diff', '--cached', '--binary'], {
      cwd: binGenDir,
      encoding: 'utf8',
    })

    const res = applyPatchStackToDirectory(
      targetDir,
      [makeLockedPatch('add-binary', binaryPatchText)],
      join(root, 'tmp2'),
    )
    expect(res.modifiedPaths).toEqual(['asset.bin'])
    expect(existsSync(join(targetDir, 'asset.bin'))).toBe(true)
    expect(readFileSync(join(targetDir, 'asset.bin')).equals(binaryBytes)).toBe(true)
  })

  it('constructs replay git ancestry preserving HEAD^1 changed files without leaking setup or patch commits', () => {
    const root = createTempDir('ancestry')
    const baseDir = join(root, 'base')
    const headDir = join(root, 'head')
    mkdirSync(join(baseDir, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(baseDir, 'src'), { recursive: true })

    writeFileSync(join(baseDir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: [pull_request]\n', 'utf8')
    writeFileSync(join(baseDir, 'src', 'feature.ts'), 'export const x = 1\n', 'utf8')
    writeFileSync(join(baseDir, 'src', 'untouched.ts'), 'export const u = true\n', 'utf8')

    mkdirSync(join(headDir, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(headDir, 'src'), { recursive: true })
    writeFileSync(join(headDir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: [pull_request]\n', 'utf8')
    writeFileSync(join(headDir, 'src', 'feature.ts'), 'export const x = 2\n', 'utf8')
    writeFileSync(join(headDir, 'src', 'untouched.ts'), 'export const u = true\n', 'utf8')

    // Optimization patch touches .github/workflows/ci.yml and adds scripts/opt.sh
    const optPatch = [
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
      '--- a/.github/workflows/ci.yml',
      '+++ b/.github/workflows/ci.yml',
      '@@ -1,2 +1,3 @@',
      ' name: CI',
      ' on: [pull_request]',
      '+# optimized workflow',
      '',
    ].join('\n')

    const replayGitDir = join(root, 'replay-git')
    const { commitMap, blockers } = constructReplayAncestry({
      baseTreeDir: baseDir,
      headTreeDir: headDir,
      replayGitDir,
      scenario: {
        name: 'pr-diff',
        description: 'PR diff test',
        event: 'pull_request',
        pr: {
          prNumber: 42,
          baseRef: 'main',
          headRef: 'feat/test',
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          mergeSha: 'c'.repeat(40),
          activityType: 'synchronize',
          changedPaths: ['src/feature.ts'],
          labels: [],
        },
        referenceRuns: [],
      },
      patches: [makeLockedPatch('opt-ci', optPatch)],
      applyPatches: true,
    })

    expect(blockers).toEqual([])
    expect(commitMap.preservedChangedPaths).toEqual(['src/feature.ts'])
    expect(verifyCleanWorktree(replayGitDir)).toBe(true)
  })

  it('checks changed paths the way bench init records them: renames as both paths, names unquoted', () => {
    const root = createTempDir('changed-paths')
    const baseDir = join(root, 'base')
    const headDir = join(root, 'head')
    for (const dir of [baseDir, headDir]) mkdirSync(dir, { recursive: true })
    const body = 'a file long enough for git to detect the rename\n'.repeat(5)
    writeFileSync(join(baseDir, 'old-name.txt'), body)
    writeFileSync(join(headDir, 'new-name.txt'), body)
    writeFileSync(join(headDir, 'résumé.txt'), 'non-ASCII path\n')
    const { blockers } = constructReplayAncestry({
      baseTreeDir: baseDir,
      headTreeDir: headDir,
      replayGitDir: join(root, 'replay-git'),
      scenario: {
        name: 'main-push',
        description: 'rename',
        event: 'push',
        main: {
          branch: 'main',
          beforeSha: 'a'.repeat(40),
          afterSha: 'b'.repeat(40),
          changedPaths: ['new-name.txt', 'old-name.txt', 'résumé.txt'],
        },
        referenceRuns: [],
      },
      patches: [],
      applyPatches: false,
    })
    expect(blockers.filter((b) => b.id.startsWith('changed-paths-drift'))).toEqual([])
  })
})
