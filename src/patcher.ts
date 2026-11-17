import { execFileSync } from 'node:child_process'
import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, posix, relative } from 'node:path'
import { computeSha256 } from './config.ts'
import type { LockedPatchRecord, ScenarioConfig, SetupBlocker } from './types.ts'
import { changedPaths, commitIdentityEnv } from './git.ts'
import { baselineOrderMessage, misorderedBaselinePatch } from './patch-stack.ts'

export interface MaterializedTree {
  dir: string
  treeHash: string
  workflowTreeHash: string
  appliedPatchIds: string[]
  modifiedPaths: string[]
}

export interface ReplayAncestryCommitMap {
  upstreamBaseSha: string
  upstreamHeadSha: string
  upstreamMergeSha: string
  replayBaseSha: string
  replayHeadSha: string
  replayMergeSha: string
  preservedChangedPaths: string[]
}

function collectFilesRecursive(rootDir: string, currentDir = rootDir): string[] {
  const results: string[] = []
  if (!existsSync(currentDir)) return results
  const entries = readdirSync(currentDir).sort()
  for (const entry of entries) {
    if (entry === '.git') continue
    const full = join(currentDir, entry)
    const rel = relative(rootDir, full).split('\\').join('/')
    const st = lstatSync(full)
    if (st.isDirectory() && !st.isSymbolicLink()) {
      results.push(...collectFilesRecursive(rootDir, full))
    } else {
      results.push(rel)
    }
  }
  return results
}

export function computeDirectoryHash(rootDir: string, filterPrefix?: string): string {
  const files = collectFilesRecursive(rootDir).filter((rel) => (filterPrefix ? rel.startsWith(filterPrefix) : true))
  const parts: string[] = []
  for (const rel of files) {
    const full = join(rootDir, rel)
    const st = lstatSync(full)
    const mode = st.isSymbolicLink() ? '120000' : (st.mode & 0o111) !== 0 ? '100755' : '100644'
    const bytes = st.isSymbolicLink() ? Buffer.from(readlinkSync(full), 'utf8') : readFileSync(full)
    parts.push(`${mode} ${rel} ${computeSha256(bytes)}`)
  }
  return computeSha256(parts.join('\n'))
}

export function parsePatchTouchedPaths(patchContent: string): string[] {
  const touched = new Set<string>()
  for (const line of patchContent.split('\n')) {
    const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trim())
    if (diffMatch) {
      if (diffMatch[1] && diffMatch[1] !== '/dev/null') touched.add(diffMatch[1])
      if (diffMatch[2] && diffMatch[2] !== '/dev/null') touched.add(diffMatch[2])
    }
  }
  return [...touched].sort()
}

export function applyPatchStackToDirectory(
  targetDir: string,
  patches: LockedPatchRecord[],
  tempWorkDir: string,
): { appliedPatchIds: string[]; modifiedPaths: string[] } {
  const appliedPatchIds: string[] = []
  const allModified = new Set<string>()

  // Ensure targetDir is initialized as a temporary git worktree if not already a git repo so git apply preserves modes & binary diffs
  const dotGit = join(targetDir, '.git')
  const createdGit = !existsSync(dotGit)
  if (createdGit) {
    execFileSync('git', ['init', '-q'], { cwd: targetDir })
  }

  try {
    for (const patch of patches) {
      if (!/^[a-zA-Z0-9_-]+$/.test(patch.id)) throw new Error('Patch ID must use letters, digits, underscore or dash')
      if (!patch.patchContent.trim()) {
        throw new Error(`Unexpected empty patch "${patch.id}"`)
      }
      const touched = parsePatchTouchedPaths(patch.patchContent)
      if (touched.length === 0) {
        throw new Error(`Unexpected empty or malformed patch "${patch.id}": no diff headers found`)
      }

      mkdirSync(tempWorkDir, { recursive: true })
      const patchFile = join(tempWorkDir, `${patch.id}.patch`)
      writeFileSync(patchFile, patch.patchContent, 'utf8')

      // Check cleanly first — reject partial or conflicting applications
      try {
        execFileSync('git', ['apply', '--check', '--binary', patchFile], {
          cwd: targetDir,
          stdio: 'pipe',
        })
      } catch (err) {
        const stderr =
          err && typeof err === 'object' && 'stderr' in err && Buffer.isBuffer(err.stderr)
            ? err.stderr.toString('utf8')
            : String(err)
        throw new Error(`Patch "${patch.id}" failed clean check (conflict or partial application): ${stderr.trim()}`)
      }

      execFileSync('git', ['apply', '--binary', patchFile], {
        cwd: targetDir,
        stdio: 'pipe',
      })

      appliedPatchIds.push(patch.id)
      for (const p of touched) allModified.add(p)
    }
  } finally {
    if (createdGit) {
      rmSync(dotGit, { recursive: true, force: true })
    }
  }

  return {
    appliedPatchIds,
    modifiedPaths: [...allModified].sort(),
  }
}

export function materializeVariantSourceTrees(params: {
  upstreamSourceDir: string
  workRootDir: string
  patches: LockedPatchRecord[]
}): {
  baseline: MaterializedTree
  patched: MaterializedTree
} {
  const { upstreamSourceDir, workRootDir, patches } = params
  const misordered = misorderedBaselinePatch(patches)
  if (misordered) throw new Error(baselineOrderMessage(misordered))
  const baselineDir = join(workRootDir, 'trees', 'baseline')
  const patchedDir = join(workRootDir, 'trees', 'patched')
  const patchTempDir = join(workRootDir, 'tmp-patches')

  rmSync(baselineDir, { recursive: true, force: true })
  rmSync(patchedDir, { recursive: true, force: true })
  mkdirSync(baselineDir, { recursive: true })
  mkdirSync(patchedDir, { recursive: true })

  cpSync(upstreamSourceDir, baselineDir, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (src) => posix.basename(src.split('\\').join('/')) !== '.git',
  })
  // Patches flagged `inBaseline` belong to both trees: the baseline is upstream plus those patches. They come first
  // in the list, so the patched tree is the baseline tree plus the rest, applied in the same order.
  const baselinePatches = patches.filter((p) => p.inBaseline)
  const appliedToBaseline = applyPatchStackToDirectory(
    baselineDir,
    baselinePatches,
    join(workRootDir, 'tmp-baseline-patches'),
  )
  cpSync(baselineDir, patchedDir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })

  const applied = applyPatchStackToDirectory(
    patchedDir,
    patches.filter((p) => !p.inBaseline),
    patchTempDir,
  )

  return {
    baseline: {
      dir: baselineDir,
      treeHash: computeDirectoryHash(baselineDir),
      workflowTreeHash: computeDirectoryHash(baselineDir, '.github/workflows/'),
      appliedPatchIds: appliedToBaseline.appliedPatchIds,
      modifiedPaths: appliedToBaseline.modifiedPaths,
    },
    patched: {
      dir: patchedDir,
      treeHash: computeDirectoryHash(patchedDir),
      workflowTreeHash: computeDirectoryHash(patchedDir, '.github/workflows/'),
      appliedPatchIds: [...appliedToBaseline.appliedPatchIds, ...applied.appliedPatchIds],
      modifiedPaths: [...new Set([...appliedToBaseline.modifiedPaths, ...applied.modifiedPaths])].sort(),
    },
  }
}

export function verifyCleanWorktree(gitRepoDir: string): boolean {
  const out = execFileSync('git', ['status', '--porcelain'], {
    cwd: gitRepoDir,
    encoding: 'utf8',
  })
  return out.trim().length === 0
}

/**
 * Stage every file of the materialized tree. The trees are exact copies of tracked upstream content, so ignore rules
 * must not apply: upstream force-tracks files that its own .gitignore matches (writefreely's static/css/.gitignore
 * ignores *.css, yet two vendored stylesheets are tracked), and a plain `git add -A` silently drops them.
 */
function stageWholeTree(gitDir: string, env: NodeJS.ProcessEnv): void {
  execFileSync('git', ['add', '-A', '--force'], { cwd: gitDir, env })
}

/**
 * Constructs replay git ancestry in `replayGitDir` from `baseTreeDir` and `headTreeDir`,
 * applying patch stack and workflow adaptations consistently across both base (`HEAD^1`)
 * and head (`HEAD^2`) commits so that `git diff --name-only HEAD^1` in the replay merge commit
 * matches the upstream scenario's `changedPaths` without leaking setup commits or optimization plumbing.
 */
export function constructReplayAncestry(params: {
  baseTreeDir: string
  headTreeDir: string
  replayGitDir: string
  scenario: ScenarioConfig
  patches: LockedPatchRecord[]
  applyPatches: boolean
  workflowOverlayDir?: string
  /** Upstream history: the replay base commit's parent, with the object store that contains it. */
  upstreamHistory?: { objectsDir: string; parentSha: string }
}): { commitMap: ReplayAncestryCommitMap; blockers: SetupBlocker[] } {
  const { baseTreeDir, headTreeDir, replayGitDir, scenario, patches, applyPatches, workflowOverlayDir } = params
  const history = params.upstreamHistory
  const blockers: SetupBlocker[] = []

  const expectedChangedPaths = [...(scenario.pr?.changedPaths ?? scenario.main?.changedPaths ?? [])].sort()
  const upstreamBaseSha = scenario.pr?.baseSha ?? scenario.main?.beforeSha ?? '0'.repeat(40)
  const upstreamHeadSha = scenario.pr?.headSha ?? scenario.main?.afterSha ?? '0'.repeat(40)
  const upstreamMergeSha = scenario.pr?.mergeSha ?? scenario.main?.afterSha ?? '0'.repeat(40)

  rmSync(replayGitDir, { recursive: true, force: true })
  mkdirSync(replayGitDir, { recursive: true })

  const gitEnv = {
    ...process.env,
    ...commitIdentityEnv(replayGitDir),
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  }

  const baseBranchName = scenario.pr?.baseRef ?? scenario.main?.branch ?? 'main'
  execFileSync('git', ['init', '-q', '-b', baseBranchName], {
    cwd: replayGitDir,
    env: gitEnv,
  })
  // Borrow upstream objects instead of copying history into every variant's replay repository.
  if (history) writeFileSync(join(replayGitDir, '.git', 'objects', 'info', 'alternates'), `${history.objectsDir}\n`)

  const tempPatchDir = join(replayGitDir, '.git', 'bench-tmp-patches')

  // 1. Materialize base tree into replayGitDir
  cpSync(baseTreeDir, replayGitDir, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (src) => posix.basename(src.split('\\').join('/')) !== '.git',
  })

  if (applyPatches && patches.length > 0) {
    const shouldApplyToBase = scenario.scenarioAdaptation?.applyPatchToBaseCommit ?? true
    if (shouldApplyToBase) {
      try {
        applyPatchStackToDirectory(replayGitDir, patches, tempPatchDir)
      } catch (err) {
        if (!scenario.scenarioAdaptation) {
          blockers.push({
            id: `inconsistent-base-head-patch-${scenario.name}`,
            category: 'inconsistent_base_head_patch',
            severity: 'blocker',
            sourceLocation: { file: 'benchmark.config.json' },
            evidence: `Patch stack cannot be applied consistently to scenario "${scenario.name}" base commit (${upstreamBaseSha}): ${err instanceof Error ? err.message : String(err)}`,
            nextAction: `Record an explicit scenarios.${scenario.name}.scenarioAdaptation or adjust the patch so base/head diff selection is preserved.`,
          })
          throw err
        }
      }
    }
  }

  if (workflowOverlayDir && existsSync(workflowOverlayDir)) {
    cpSync(workflowOverlayDir, join(replayGitDir, '.github', 'workflows'), { recursive: true })
  }

  stageWholeTree(replayGitDir, gitEnv)
  if (history) {
    const tree = execFileSync('git', ['write-tree'], { cwd: replayGitDir, env: gitEnv, encoding: 'utf8' }).trim()
    const commit = execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        tree,
        '-p',
        history.parentSha,
        '-m',
        `[skip ci] replay-base:${upstreamBaseSha}`,
      ],
      { cwd: replayGitDir, env: gitEnv, encoding: 'utf8' },
    ).trim()
    execFileSync('git', ['update-ref', `refs/heads/${baseBranchName}`, commit], { cwd: replayGitDir, env: gitEnv })
  } else
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `[skip ci] replay-base:${upstreamBaseSha}`],
      {
        cwd: replayGitDir,
        env: gitEnv,
      },
    )
  const replayBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: replayGitDir,
    encoding: 'utf8',
  }).trim()

  // 2. Create head branch from base and materialize head changes
  const headBranch = scenario.pr?.headRef ?? 'bench/head'
  execFileSync('git', ['checkout', '-q', '-b', headBranch], { cwd: replayGitDir, env: gitEnv })

  // Clear working files (except .git) and copy headTreeDir
  for (const entry of readdirSync(replayGitDir)) {
    if (entry === '.git') continue
    rmSync(join(replayGitDir, entry), { recursive: true, force: true })
  }
  cpSync(headTreeDir, replayGitDir, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (src) => posix.basename(src.split('\\').join('/')) !== '.git',
  })

  if (applyPatches && patches.length > 0) {
    applyPatchStackToDirectory(replayGitDir, patches, tempPatchDir)
  }

  if (workflowOverlayDir && existsSync(workflowOverlayDir)) {
    cpSync(workflowOverlayDir, join(replayGitDir, '.github', 'workflows'), { recursive: true })
  }

  stageWholeTree(replayGitDir, gitEnv)
  execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `replay-head:${upstreamHeadSha}`],
    {
      cwd: replayGitDir,
      env: gitEnv,
    },
  )
  const replayHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: replayGitDir,
    encoding: 'utf8',
  }).trim()

  // 3. If PR scenario, create merge commit with base as first parent (HEAD^1) and head as second parent (HEAD^2)
  let replayMergeSha = replayHeadSha
  if (scenario.event === 'pull_request' || scenario.event === 'pull_request_target') {
    const baseBranch = scenario.pr?.baseRef ?? 'main'
    execFileSync('git', ['checkout', '-q', baseBranch], { cwd: replayGitDir, env: gitEnv })
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        '-q',
        headBranch,
        '-m',
        `Merge ${headBranch} into ${baseBranch} (${upstreamMergeSha})`,
      ],
      { cwd: replayGitDir, env: gitEnv },
    )
    replayMergeSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: replayGitDir,
      encoding: 'utf8',
    }).trim()
  }

  const actualChangedPaths = changedPaths(replayGitDir, 'HEAD^1', 'HEAD')

  // Verify that HEAD^1 changed paths match expectedChangedPaths unless an explicit scenarioAdaptation allows it
  if (expectedChangedPaths.length > 0 && JSON.stringify(actualChangedPaths) !== JSON.stringify(expectedChangedPaths)) {
    if (!scenario.scenarioAdaptation) {
      blockers.push({
        id: `changed-paths-drift-${scenario.name}`,
        category: 'inconsistent_base_head_patch',
        severity: 'blocker',
        sourceLocation: { file: 'benchmark.config.json' },
        evidence: `Replay HEAD^1 diff [${actualChangedPaths.join(', ')}] differs from upstream scenario changedPaths [${expectedChangedPaths.join(', ')}].`,
        nextAction: `Ensure patch applies cleanly to both base and head commits or record scenarios.${scenario.name}.scenarioAdaptation.`,
      })
    }
  }

  return {
    commitMap: {
      upstreamBaseSha,
      upstreamHeadSha,
      upstreamMergeSha,
      replayBaseSha,
      replayHeadSha,
      replayMergeSha,
      preservedChangedPaths: actualChangedPaths,
    },
    blockers,
  }
}
