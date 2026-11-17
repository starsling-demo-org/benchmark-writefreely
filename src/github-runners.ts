import { resolveJobRunnerMapping } from './inventory-helpers.ts'
import { findMatrixCollision, matrixRunsOnKey } from './matrix-runners.ts'
import {
  isGitHubTargetPlaceholder,
  isLatestLabel,
  isVisibilityDependentLabel,
  VISIBILITY_DEPENDENT_MESSAGE,
} from './runner-labels.ts'
import type {
  MatrixRunsOnPlan,
  RunnerMappingConfig,
  SetupBlocker,
  WorkflowFileInventory,
  WorkflowJobInventory,
} from './types.ts'

export interface GitHubRunnerResolution {
  /** The `runs-on` label the GitHub variants use for this job. */
  target?: string
  /** For a `${{ matrix.<key> }}` runs-on: the pinned label for each literal matrix value (original value -> label). */
  matrixTargets?: Record<string, string>
  /** Why the job cannot run on an explicit, pinned GitHub label; names the workflow and job. */
  problem?: string
}

/** Why a mapped GitHub target is not acceptable, or undefined when it is an explicit label with a recorded size. */
export function githubTargetProblem(
  label: string,
  mapping: RunnerMappingConfig,
  requireSpec = true,
): string | undefined {
  if (isGitHubTargetPlaceholder(label))
    return `the GitHub target "${label}" is a placeholder; replace it with the GitHub larger-runner label that matches upstream's public runner, and record its size in runnerMapping.runnerSpecs`
  if (isLatestLabel(label))
    return `the GitHub target "${label}" is a -latest label; GitHub moves those, so pin an explicit OS version and size`
  if (isVisibilityDependentLabel(label))
    return `the GitHub target "${label}" is a standard hosted label: ${VISIBILITY_DEPENDENT_MESSAGE}`
  const spec = mapping.runnerSpecs[label]
  if (requireSpec && spec?.provider !== 'github')
    return `the GitHub target "${label}" has no GitHub entry in runnerMapping.runnerSpecs; add its vCPU and RAM so the README can report the size`
  return undefined
}

/**
 * The GitHub-side runner for one job, decided by the same mapping rules StarSling variants use. A job either gets
 * an explicit pinned label or a problem naming it; nothing falls through to an upstream label unchecked.
 */
export function resolveGitHubRunner(
  workflowFile: string,
  jobId: string,
  runsOn: WorkflowJobInventory['runsOn'],
  mapping: RunnerMappingConfig,
  matrix?: MatrixRunsOnPlan,
): GitHubRunnerResolution {
  const at = `${workflowFile}#${jobId}`
  const label = typeof runsOn === 'string' ? runsOn : JSON.stringify(runsOn)
  const fail = (why: string): GitHubRunnerResolution => ({ problem: `${at} (runs-on ${label}): ${why}` })
  const resolved = resolveJobRunnerMapping(workflowFile, jobId, runsOn, mapping)
  if (resolved.kind === 'override') {
    const problem = githubTargetProblem(resolved.github, mapping, !resolved.retainedOnGitHub)
    return problem ? fail(problem) : { target: resolved.github }
  }
  const addOverride = `add runnerMapping.jobOverrides["${at}"] = { "github": "<pinned label>", "starsling": "<label>" }`
  if (typeof runsOn !== 'string')
    return fail(`a label array, group or object cannot be mapped automatically; ${addOverride}`)
  if (matrixRunsOnKey(runsOn) !== undefined && matrix !== undefined) {
    if ('problem' in matrix) return fail(matrix.problem)
    const targets: Record<string, string> = {}
    const problems: string[] = []
    for (const value of matrix.values) {
      const { target, problem } = resolveGitHubRunner(workflowFile, jobId, value, mapping)
      if (problem) problems.push(problem)
      else if (target !== undefined) targets[value] = target
    }
    if (problems.length > 0) return { problem: problems.join(' | ') }
    const clash = findMatrixCollision(targets)
    if (clash) return fail(clash)
    return { matrixTargets: targets }
  }
  if (runsOn.includes('${{'))
    return fail(`an expression or matrix value cannot be mapped automatically; ${addOverride}`)
  if (resolved.kind === 'unsupported') {
    // macOS, Windows and Arm stay on the label upstream uses, so that label must already be pinned and the same
    // size in public and private repositories (macOS only).
    if (isLatestLabel(runsOn))
      return fail(`a -latest label is never allowed on the GitHub side; ${addOverride} with a pinned OS version`)
    if (isVisibilityDependentLabel(runsOn))
      return fail(`a standard hosted label: ${VISIBILITY_DEPENDENT_MESSAGE}; ${addOverride}`)
    return { target: runsOn }
  }
  if (resolved.kind === 'unmapped')
    return fail(
      `the label has no entry in runnerMapping.defaultMap; map it, or ${addOverride} (use the same label on both sides to keep the job on GitHub)`,
    )
  const problem = githubTargetProblem(resolved.github, mapping)
  return problem ? fail(problem) : { target: resolved.github }
}

/** One blocker per job (reusable-workflow callers have no `runs-on`) that cannot run on an explicit GitHub label. */
export function findGitHubRunnerBlockers(
  workflows: Record<string, WorkflowFileInventory>,
  mapping: RunnerMappingConfig,
): SetupBlocker[] {
  const blockers: SetupBlocker[] = []
  for (const workflow of Object.values(workflows))
    for (const job of Object.values(workflow.jobs)) {
      if (job.usesReusableWorkflow) continue
      const { problem } = resolveGitHubRunner(workflow.filePath, job.jobId, job.runsOn, mapping, job.matrixRunsOn)
      if (problem)
        blockers.push({
          id: `github-runner-${workflow.filePath}#${job.jobId}`,
          category: 'unpinned_github_runner',
          severity: 'blocker',
          sourceLocation: { file: workflow.filePath, jobId: job.jobId },
          evidence: `GitHub-side runner for ${problem}`,
          nextAction:
            'Set an explicit pinned GitHub label for this job in runnerMapping (see skills/setup-parity RECIPES).',
        })
    }
  return blockers
}
