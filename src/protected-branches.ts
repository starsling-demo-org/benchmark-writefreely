import type { BenchmarkConfig } from './types.ts'

const HEADS = 'refs/heads/'
const branchName = (ref: string): string => (ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref)

/**
 * Branches the controller must never write: the base (and, when it still exists, the head) branch of every
 * merged-PR patch. The patch is what landed on that branch; resetting it would erase the measured fix.
 */
export function protectedBranchesOf(config: Pick<BenchmarkConfig, 'patches'>): string[] {
  const names = new Set<string>()
  for (const patch of config.patches) {
    if (patch.source !== 'merged-pr') continue
    if (patch.baseBranch) names.add(branchName(patch.baseBranch))
    if (patch.headBranch) names.add(branchName(patch.headBranch))
  }
  return [...names].sort()
}

/**
 * Every branch the controller writes, with the reason. The default branch is included because workflow
 * registration and `bench publish` commit to it and recovery restores it.
 */
export function controllerWrittenBranches(config: BenchmarkConfig): { branch: string; why: string }[] {
  const { controlBranch, defaultBranch, replayBranch } = config.benchmarkRepository
  const written = [
    { branch: replayBranch ?? defaultBranch, why: 'replay branch (replay trees are force-pushed and restored)' },
    { branch: defaultBranch, why: 'default branch (workflow placeholders, showcase publish, recovery)' },
    { branch: controlBranch, why: 'control branch (harness)' },
  ]
  for (const [name, scenario] of Object.entries(config.scenarios)) {
    if (scenario.pr) {
      written.push({ branch: branchName(scenario.pr.baseRef), why: `PR base branch of scenario "${name}"` })
      written.push({ branch: `bench/pr/${name}/head`, why: `PR head branch of scenario "${name}"` })
    }
  }
  return written
}

/** Throws when a ref the controller is about to write names a protected branch. */
export function assertRefNotProtected(ref: string, protectedBranches: readonly string[]): void {
  if (ref.startsWith(HEADS) && protectedBranches.includes(branchName(ref)))
    throw new Error(
      `Refusing to write "${ref}": it is the base or head branch of a merged-PR patch and must never be reset`,
    )
}
