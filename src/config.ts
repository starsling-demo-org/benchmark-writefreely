import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  githubTargetPlaceholder,
  isLatestLabel,
  isVisibilityDependentLabel,
  VISIBILITY_DEPENDENT_MESSAGE,
} from './runner-labels.ts'
import type {
  BenchmarkConfig,
  BenchmarkLockfile,
  CacheArtifactProfile,
  LockedPatchRecord,
  ParityCertificateRecord,
  ReferencedActionLock,
  RepositoryInventory,
  RunnerMappingConfig,
  SetupBlocker,
  VariantId,
  VariantTreeLock,
} from './types.ts'
import { baselineOrderMessage, misorderedBaselinePatch } from './patch-stack.ts'
import { controllerWrittenBranches, protectedBranchesOf } from './protected-branches.ts'

export { type PatchResolver, resolvePatchStack } from './patch-stack.ts'

const HEX_40_RE = /^[0-9a-f]{40}$/i

export function defineBenchmarkConfig(config: BenchmarkConfig): BenchmarkConfig {
  return config
}

export const isPullRequestEvent = (event: string): boolean =>
  event === 'pull_request' || event === 'pull_request_target'

/** Events whose context is a branch commit (`scenario.main`). */
export const isBranchEvent = (event: string): boolean =>
  event === 'push' || event === 'merge_group' || event === 'workflow_dispatch'

/** The branch replays push to: `replayBranch` when set, otherwise the default branch. */
export const replayBranchOf = (config: BenchmarkConfig): string =>
  config.benchmarkRepository.replayBranch ?? config.benchmarkRepository.defaultBranch

export function computeSha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function createDefaultProfiles(): Record<string, CacheArtifactProfile> {
  return {
    cold: {
      name: 'cold',
      actionsCache: 'cold',
      crossRunArtifacts: 'none',
      restoreExpectations: {},
      testResultReuseAllowed: false,
    },
    warm: {
      name: 'warm',
      actionsCache: 'warm',
      crossRunArtifacts: 'seeded',
      seedScenario: 'main-push',
      restoreExpectations: {},
      testResultReuseAllowed: true,
      amortizationHorizonRuns: 10,
    },
  }
}

export function createDefaultRunnerMapping(): RunnerMappingConfig {
  return {
    defaultMap: {
      // -latest is never a GitHub target: the owner supplies the pinned larger-runner label.
      'ubuntu-latest': {
        github: githubTargetPlaceholder('ubuntu-latest'),
        starsling: 'starsling-ubuntu-24.04',
      },
      'ubuntu-24.04': {
        github: githubTargetPlaceholder('ubuntu-24.04'),
        starsling: 'starsling-ubuntu-24.04',
      },
      'ubuntu-26.04': {
        github: githubTargetPlaceholder('ubuntu-26.04'),
        starsling: 'starsling-ubuntu-26.04',
      },
      'ubuntu-slim': {
        github: 'ubuntu-slim',
        starsling: 'starsling-ubuntu-24.04-2',
      },
    },
    runnerSpecs: {
      // GitHub's standard runners for public repositories; bench init records smaller ones for other repositories.
      'ubuntu-latest': {
        label: 'ubuntu-latest',
        provider: 'github',
        os: 'linux',
        arch: 'x64',
        vcpu: 4,
        ramGiB: 16,
        billingPerMinuteUsd: 0.016,
      },
      'ubuntu-24.04': {
        label: 'ubuntu-24.04',
        provider: 'github',
        os: 'linux',
        arch: 'x64',
        vcpu: 4,
        ramGiB: 16,
        billingPerMinuteUsd: 0.016,
      },
      'ubuntu-26.04': {
        label: 'ubuntu-26.04',
        provider: 'github',
        os: 'linux',
        arch: 'x64',
        vcpu: 4,
        ramGiB: 16,
        billingPerMinuteUsd: 0.016,
      },
      'ubuntu-slim': {
        label: 'ubuntu-slim',
        provider: 'github',
        os: 'linux',
        arch: 'x64',
        vcpu: 1,
        ramGiB: 5,
        billingPerMinuteUsd: 0.004,
      },
      'starsling-ubuntu-24.04-2': {
        label: 'starsling-ubuntu-24.04-2',
        provider: 'starsling',
        os: 'linux',
        arch: 'x64',
        vcpu: 2,
        ramGiB: 8,
        billingPerMinuteUsd: 0.004,
      },
      'starsling-ubuntu-24.04': {
        label: 'starsling-ubuntu-24.04',
        provider: 'starsling',
        os: 'linux',
        arch: 'x64',
        vcpu: 4,
        ramGiB: 16,
        billingPerMinuteUsd: 0.008,
      },
      'starsling-ubuntu-26.04': {
        label: 'starsling-ubuntu-26.04',
        provider: 'starsling',
        os: 'linux',
        arch: 'x64',
        vcpu: 4,
        ramGiB: 16,
        billingPerMinuteUsd: 0.008,
      },
      'macos-latest': {
        label: 'macos-latest',
        provider: 'github',
        os: 'macos',
        arch: 'arm64',
        vcpu: 3,
        ramGiB: 7,
        billingPerMinuteUsd: 0.08,
      },
      'windows-latest': {
        label: 'windows-latest',
        provider: 'github',
        os: 'windows',
        arch: 'x64',
        vcpu: 4,
        ramGiB: 16,
        billingPerMinuteUsd: 0.032,
      },
    },
  }
}

export function validateBenchmarkConfig(config: BenchmarkConfig): SetupBlocker[] {
  const blockers: SetupBlocker[] = []
  if (!Object.keys(config.scenarios).length)
    blockers.push({
      id: 'missing-scenarios',
      category: 'unresolvable_event_context',
      severity: 'blocker',
      sourceLocation: { file: 'benchmark.config.json' },
      evidence: 'No locked workload scenarios',
      nextAction: 'Discover and review a real upstream main or PR scenario.',
    })
  if (
    !Number.isSafeInteger(config.execution.repetitions) ||
    config.execution.repetitions < 1 ||
    config.execution.timeoutMinutes <= 0 ||
    config.execution.pollIntervalSeconds <= 0 ||
    (config.execution.apiBudgetPerHour !== undefined &&
      (!Number.isFinite(config.execution.apiBudgetPerHour) || config.execution.apiBudgetPerHour <= 0)) ||
    (config.execution.maxJobQueueSeconds !== undefined &&
      !(Number.isFinite(config.execution.maxJobQueueSeconds) && config.execution.maxJobQueueSeconds >= 0)) ||
    (config.execution.excludedJobs !== undefined &&
      !(
        Array.isArray(config.execution.excludedJobs) &&
        config.execution.excludedJobs.every(
          (j) =>
            typeof j?.workflowFile === 'string' &&
            j.workflowFile !== '' &&
            typeof j.jobId === 'string' &&
            j.jobId !== '' &&
            typeof j.reason === 'string' &&
            j.reason.trim() !== '',
        )
      )) ||
    (config.execution.maxReplacementsPerSetup !== undefined &&
      !(
        Number.isSafeInteger(config.execution.maxReplacementsPerSetup) && config.execution.maxReplacementsPerSetup >= 0
      ))
  )
    blockers.push({
      id: 'invalid-execution-limits',
      category: 'unresolvable_event_context',
      severity: 'blocker',
      sourceLocation: { file: 'benchmark.config.json' },
      evidence: 'Execution limits must be positive',
      nextAction: 'Set positive repetitions, timeout and polling interval.',
    })

  const githubTargets: [string, string][] = [
    ...Object.entries(config.runnerMapping?.defaultMap ?? {}).map(([from, t]): [string, string] => [
      `runnerMapping.defaultMap["${from}"]`,
      t.github,
    ]),
    ...Object.entries(config.runnerMapping?.jobOverrides ?? {}).map(([from, t]): [string, string] => [
      `runnerMapping.jobOverrides["${from}"]`,
      t.github,
    ]),
  ]
  for (const [where, target] of githubTargets) {
    if (isVisibilityDependentLabel(target))
      blockers.push({
        id: `github-target-visibility-${where}`,
        category: 'unpinned_github_runner',
        severity: 'blocker',
        sourceLocation: { file: 'benchmark.config.json' },
        evidence: `${where}.github is "${target}", a standard hosted label: ${VISIBILITY_DEPENDENT_MESSAGE}. It is 4 vCPU in a public repository and 2 vCPU in an internal one.`,
        nextAction: 'Use a GitHub larger-runner label of the size upstream gets in its public repository.',
      })
    if (isLatestLabel(target))
      blockers.push({
        id: `github-target-latest-${where}`,
        category: 'unpinned_github_runner',
        severity: 'blocker',
        sourceLocation: { file: 'benchmark.config.json' },
        evidence: `${where}.github is "${target}", a -latest label. GitHub moves -latest aliases, so the GitHub-hosted arm would drift.`,
        nextAction: 'Use an explicit GitHub label with a pinned OS version and size (for example a larger runner).',
      })
  }

  if (!HEX_40_RE.test(config.upstream.commitSha)) {
    blockers.push({
      id: 'invalid-upstream-commit-sha',
      category: 'invalid_commit_pin',
      severity: 'blocker',
      sourceLocation: { file: 'benchmark.config.json' },
      evidence: `upstream.commitSha "${config.upstream.commitSha}" is not an immutable 40-character hex commit SHA.`,
      nextAction: 'Pin upstream.commitSha to an exact 40-character Git commit SHA; never use branch or tag names.',
    })
  }

  for (const [scenarioName, scenario] of Object.entries(config.scenarios)) {
    if (isPullRequestEvent(scenario.event)) {
      if (!scenario.pr) {
        blockers.push({
          id: `missing-pr-metadata-${scenarioName}`,
          category: 'unresolvable_event_context',
          severity: 'blocker',
          sourceLocation: { file: 'benchmark.config.json' },
          evidence: `Scenario "${scenarioName}" uses event "${scenario.event}" without locking PR base/head/merge metadata.`,
          nextAction: `Populate scenarios.${scenarioName}.pr with baseSha, headSha, mergeSha, activityType, changedPaths, and labels.`,
        })
      } else {
        for (const field of ['baseSha', 'headSha', 'mergeSha'] as const) {
          const val = scenario.pr[field]
          if (!HEX_40_RE.test(val)) {
            blockers.push({
              id: `invalid-pr-${field}-${scenarioName}`,
              category: 'invalid_commit_pin',
              severity: 'blocker',
              sourceLocation: { file: 'benchmark.config.json' },
              evidence: `Scenario "${scenarioName}" pr.${field} "${val}" is not a full 40-character SHA.`,
              nextAction: `Lock scenarios.${scenarioName}.pr.${field} to an immutable 40-character commit SHA.`,
            })
          }
        }
      }
    } else if (scenario.event === 'workflow_dispatch' && !scenario.dispatch?.workflows.length) {
      blockers.push({
        id: `missing-dispatch-workflows-${scenarioName}`,
        category: 'unresolvable_event_context',
        severity: 'blocker',
        sourceLocation: { file: 'benchmark.config.json' },
        evidence: `Scenario "${scenarioName}" dispatches no workflows.`,
        nextAction: `List the workflow files to dispatch in scenarios.${scenarioName}.dispatch.workflows.`,
      })
    }
    if (isBranchEvent(scenario.event)) {
      if (!scenario.main) {
        blockers.push({
          id: `missing-main-metadata-${scenarioName}`,
          category: 'unresolvable_event_context',
          severity: 'blocker',
          sourceLocation: { file: 'benchmark.config.json' },
          evidence: `Scenario "${scenarioName}" uses event "${scenario.event}" without locking main before/after metadata.`,
          nextAction: `Populate scenarios.${scenarioName}.main with branch, beforeSha, afterSha, and changedPaths.`,
        })
      } else {
        for (const field of ['beforeSha', 'afterSha'] as const) {
          const val = scenario.main[field]
          if (!HEX_40_RE.test(val)) {
            blockers.push({
              id: `invalid-main-${field}-${scenarioName}`,
              category: 'invalid_commit_pin',
              severity: 'blocker',
              sourceLocation: { file: 'benchmark.config.json' },
              evidence: `Scenario "${scenarioName}" main.${field} "${val}" is not a full 40-character SHA.`,
              nextAction: `Lock scenarios.${scenarioName}.main.${field} to an immutable 40-character commit SHA.`,
            })
          }
        }
      }
    }
  }

  for (const patch of config.patches) {
    if ((patch.source === 'github-pr' || patch.source === 'github-commit') && !patch.resolvedRevision) {
      if (!HEX_40_RE.test(patch.pathOrUrl) && !/\/commit\/[0-9a-f]{40}/i.test(patch.pathOrUrl)) {
        blockers.push({
          id: `moving-patch-url-${patch.id}`,
          category: 'unresolved_moving_url',
          severity: 'blocker',
          sourceLocation: { file: 'benchmark.config.json' },
          evidence: `Patch "${patch.id}" points to a moving URL "${patch.pathOrUrl}" without resolvedRevision or sha256.`,
          nextAction: `Run "bench prepare" with a patch resolver or specify resolvedRevision and sha256 on patch "${patch.id}".`,
        })
      }
    }
  }

  for (const patch of config.patches) {
    if (patch.source === 'merged-pr' && !patch.baseBranch)
      blockers.push({
        id: `merged-pr-missing-base-${patch.id}`,
        category: 'invalid_commit_pin',
        severity: 'blocker',
        sourceLocation: { file: 'benchmark.config.json' },
        evidence: `Merged-PR patch "${patch.id}" does not declare baseBranch, so the controller cannot be kept off it.`,
        nextAction: `Set patches[${patch.id}].baseBranch to the branch the PR merged into (a dedicated branch the controller never writes).`,
      })
  }
  const misorderedPatch = misorderedBaselinePatch(config.patches)
  if (misorderedPatch)
    blockers.push({
      id: `inbaseline-patch-order-${misorderedPatch.id}`,
      category: 'inconsistent_base_head_patch',
      severity: 'blocker',
      sourceLocation: { file: 'benchmark.config.json' },
      evidence: baselineOrderMessage(misorderedPatch),
      nextAction: `Move patches[${misorderedPatch.id}] (and every other inBaseline patch) above the patches that are not in the baseline.`,
    })
  const protectedBranches = protectedBranchesOf(config)
  for (const { branch, why } of controllerWrittenBranches(config))
    if (protectedBranches.includes(branch))
      blockers.push({
        id: `protected-branch-${branch}`,
        category: 'inconsistent_base_head_patch',
        severity: 'blocker',
        sourceLocation: { file: 'benchmark.config.json' },
        evidence: `Branch "${branch}" is the base or head branch of a merged-PR patch, but the controller writes it: ${why}.`,
        nextAction: `Merge agent PRs into a dedicated branch that is not the default, control or replay branch, and set baseBranch to it.`,
      })

  const replayBranch = replayBranchOf(config)
  if (replayBranch !== config.benchmarkRepository.defaultBranch)
    for (const [scenarioName, scenario] of Object.entries(config.scenarios)) {
      if (scenario.event === 'workflow_dispatch')
        blockers.push({
          id: `dispatch-needs-default-branch-${scenarioName}`,
          category: 'unresolvable_event_context',
          severity: 'blocker',
          sourceLocation: { file: 'benchmark.config.json' },
          evidence: `Scenario "${scenarioName}" dispatches workflows, which GitHub runs only from the default branch, but replays push to "${replayBranch}".`,
          nextAction:
            'Remove benchmarkRepository.replayBranch (replay on the default branch), or seed with a push scenario.',
        })
      if (scenario.main && scenario.main.branch !== replayBranch)
        blockers.push({
          id: `replay-branch-mismatch-${scenarioName}`,
          category: 'unresolvable_event_context',
          severity: 'blocker',
          sourceLocation: { file: 'benchmark.config.json' },
          evidence: `Scenario "${scenarioName}" is a push to "${scenario.main.branch}", but replays push to "${replayBranch}", so upstream's branch filters would see another branch.`,
          nextAction: `Set benchmarkRepository.replayBranch to "${scenario.main.branch}".`,
        })
    }

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    if (profile.actionsCache === 'warm' || profile.crossRunArtifacts === 'seeded') {
      if (!profile.seedScenario || !config.scenarios[profile.seedScenario]) {
        blockers.push({
          id: `missing-seed-scenario-${profileName}`,
          category: 'unresolvable_event_context',
          severity: 'blocker',
          sourceLocation: { file: 'benchmark.config.json' },
          evidence: `Warm profile "${profileName}" requires a valid seedScenario in config.scenarios (got "${profile.seedScenario ?? 'undefined'}").`,
          nextAction: `Configure profiles.${profileName}.seedScenario to point to a locked producer scenario in config.scenarios.`,
        })
      }
    }
  }

  return blockers
}

export function computeParityInputFingerprint(params: {
  config: BenchmarkConfig
  scenarioName: string
  profileName: string
  lockedPatches: LockedPatchRecord[]
}): string {
  const { config, scenarioName, profileName, lockedPatches } = params
  const scenario = config.scenarios[scenarioName]
  const profile = config.profiles[profileName]
  const payload = JSON.stringify({
    upstream: config.upstream,
    scenario,
    profile,
    patches: lockedPatches.map((p) => ({ id: p.id, sha256: p.sha256, rev: p.resolvedRevision })),
    runnerMapping: config.runnerMapping,
    adaptations: config.adaptations,
    collectors: config.collectors,
  })
  return computeSha256(payload)
}

export function buildLockfile(params: {
  config: BenchmarkConfig
  lockedPatches: LockedPatchRecord[]
  inventory: RepositoryInventory
  variantTrees: Record<string, Record<VariantId, VariantTreeLock>>
  existingCertificates?: Record<string, ParityCertificateRecord>
  generatedAt?: string
}): BenchmarkLockfile {
  const { config, lockedPatches, inventory, variantTrees, existingCertificates, generatedAt } = params
  const configHash = computeSha256(JSON.stringify(config))

  const scenariosLock: BenchmarkLockfile['scenarios'] = {}
  for (const [name, sc] of Object.entries(config.scenarios)) {
    if (sc.pr) {
      scenariosLock[name] = {
        event: sc.event,
        baseSha: sc.pr.baseSha,
        headSha: sc.pr.headSha,
        mergeSha: sc.pr.mergeSha,
        changedPaths: [...sc.pr.changedPaths],
        activityType: sc.pr.activityType,
        labels: [...sc.pr.labels],
      }
    } else if (sc.main) {
      scenariosLock[name] = {
        event: sc.event,
        baseSha: sc.main.beforeSha,
        headSha: sc.main.afterSha,
        mergeSha: sc.main.afterSha,
        changedPaths: [...sc.main.changedPaths],
        labels: [],
      }
    }
  }

  const referencedActions: ReferencedActionLock[] = []
  for (const wf of Object.values(inventory.workflows)) {
    for (const job of Object.values(wf.jobs)) {
      if (job.usesReusableWorkflow) {
        const isLocal = job.usesReusableWorkflow.startsWith('./')
        const rev = isLocal ? config.upstream.commitSha : (job.usesReusableWorkflow.split('@')[1] ?? 'unpinned')
        referencedActions.push({
          workflowFile: wf.filePath,
          jobId: job.jobId,
          uses: job.usesReusableWorkflow,
          resolvedRevision: rev,
          isLocal,
        })
      }
      for (const step of job.steps) {
        if (step.uses) {
          const isLocal = step.uses.startsWith('./')
          const rev = isLocal ? config.upstream.commitSha : (step.uses.split('@')[1] ?? 'unpinned')
          referencedActions.push({
            workflowFile: wf.filePath,
            jobId: job.jobId,
            uses: step.uses,
            resolvedRevision: rev,
            isLocal,
          })
        }
      }
    }
  }

  // Keep only certificates whose inputFingerprint still matches the current config/patches/profile/scenario
  const validCertificates: Record<string, ParityCertificateRecord> = {}
  if (existingCertificates) {
    for (const [key, cert] of Object.entries(existingCertificates)) {
      const expectedFp = computeParityInputFingerprint({
        config,
        scenarioName: cert.scenario,
        profileName: cert.profile,
        lockedPatches,
      })
      if (cert.inputFingerprint === expectedFp) {
        validCertificates[key] = cert
      }
    }
  }

  const adapterVersions: Record<string, string> = {}
  for (const adaptation of config.adaptations) {
    adapterVersions[adaptation.id] = computeSha256(JSON.stringify(adaptation)).slice(0, 16)
  }

  return {
    schemaVersion: 1,
    generatedAt: generatedAt ?? new Date().toISOString(),
    configHash,
    upstream: { ...config.upstream },
    scenarios: scenariosLock,
    patches: lockedPatches,
    referencedActions,
    variantTrees,
    adapterVersions,
    runnerSpecs: { ...config.runnerMapping.runnerSpecs },
    parityCertificates: validCertificates,
  }
}

export function writeLockfile(lockfilePath: string, lockfile: BenchmarkLockfile): void {
  writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`, 'utf8')
}

export function readLockfile(lockfilePath: string): BenchmarkLockfile | null {
  if (!existsSync(lockfilePath)) {
    return null
  }
  return JSON.parse(readFileSync(lockfilePath, 'utf8')) as BenchmarkLockfile
}
