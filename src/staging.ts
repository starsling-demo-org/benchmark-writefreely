import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertRefNotProtected } from './protected-branches.ts'
import type { ScenarioConfig, VariantId, VariantTreeLock } from './types.ts'

export type StagingStep =
  | 'idle'
  | '1_acquire_lease'
  | '2_register_placeholders'
  | '3_disable_workflows_and_reset_refs'
  | '4_install_and_verify_trees'
  | '5_enable_scenario_workflows'
  | '6_trigger_event'
  | '7_await_downstream_completion'
  | 'completed'
  | 'recovered'
  | 'invalidated'
  /** A failed seed attempt that a later attempt replaced; its runs were settled before the retry. */
  | 'superseded'

export type TokenAuthKind = 'github_app' | 'github_token' | 'pat'

export interface PersistedStagingState {
  experimentId: string
  sampleId: string
  scenarioName: string
  variant: VariantId
  profileName: string
  currentStep: StagingStep
  completedSteps: StagingStep[]
  leaseAcquiredAt?: string
  leaseHolder?: string
  controlBranch: string
  defaultBranch: string
  benchmarkOwnedRefs: string[]
  previousBenchmarkRefs: Record<string, string | null>
  observedUnrelatedRefs: Record<string, string>
  registeredPlaceholderWorkflows: string[]
  disabledWorkflows: string[]
  enabledWorkflows: string[]
  replayPrNumber?: number
  installedTreeHash?: string
  dispatchRecord?: {
    idempotencyKey: string
    dispatchedAt: string
    event: string
    activityType?: string
    prNumber?: number
    targetRef: string
    headSha: string
  }
  invalidationReason?: string
  supersededReason?: string
  updatedAt: string
}

export interface ExperimentRecovery {
  restoredRefs: Record<string, string | null>
  disabledWorkflows: string[]
}

export interface GitHubReplayBackend {
  recoverExperiment?(): Promise<ExperimentRecovery>
  acquireLease?(): Promise<void>
  releaseLease?(): Promise<void>
  restoreWorkflowStates?(): Promise<void>
  ensureNoActiveRuns?(): Promise<void>
  cancelManagedRuns?(): Promise<string[]>
  tokenKind: TokenAuthKind
  getCurrentRefs(): Promise<Record<string, string>>
  updateRef(ref: string, sha: string | null): Promise<void>
  registerInactiveWorkflowPlaceholder(defaultBranch: string, workflowFile: string): Promise<void>
  disableWorkflow(workflowFile: string): Promise<void>
  enableWorkflow(workflowFile: string): Promise<void>
  preparePullRequestMetadata(params: {
    baseRef: string
    headRef: string
    labels: string[]
  }): Promise<{ prNumber: number }>
  installTreeToRef(params: {
    ref: string
    treeHash: string
    expectedCombinedHash: string
    role?: 'base' | 'head'
  }): Promise<{ commitSha: string; verifiedHash: string }>
  triggerNativeEvent(params: {
    idempotencyKey: string
    event: string
    activityType?: string
    prNumber?: number
    targetRef: string
    /** workflow_dispatch: workflow files to dispatch on `targetRef`. */
    workflows?: string[]
  }): Promise<{ headSha: string; dispatchedAt: string }>
}

export class StagingInterruptionError extends Error {
  readonly step: StagingStep
  constructor(step: StagingStep, message?: string) {
    super(message ?? `Simulated controller interruption at boundary ${step}`)
    this.name = 'StagingInterruptionError'
    this.step = step
  }
}

export class ReplayStagingController {
  private readonly stateFilePath: string
  private readonly backend: GitHubReplayBackend
  /** Base/head branches of merged-PR patches: never installed, reset or restored. */
  private readonly protectedBranches: readonly string[]

  constructor(stateFilePath: string, backend: GitHubReplayBackend, protectedBranches: readonly string[] = []) {
    this.stateFilePath = stateFilePath
    this.backend = backend
    this.protectedBranches = protectedBranches
  }

  loadState(): PersistedStagingState | null {
    if (!existsSync(this.stateFilePath)) return null
    return JSON.parse(readFileSync(this.stateFilePath, 'utf8')) as PersistedStagingState
  }

  /** Close a failed seed attempt that a new attempt replaces, so recovery no longer treats it as unfinished. */
  supersede(reason: string): void {
    const state = this.loadState()
    if (!state || state.currentStep === 'superseded') return
    state.currentStep = 'superseded'
    state.supersededReason = reason
    this.saveState(state)
  }

  saveState(state: PersistedStagingState): void {
    mkdirSync(dirname(this.stateFilePath), { recursive: true })
    state.updatedAt = new Date().toISOString()
    writeFileSync(`${this.stateFilePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(`${this.stateFilePath}.tmp`, this.stateFilePath)
  }

  async executeSampleStaging(params: {
    experimentId: string
    sampleId: string
    scenario: ScenarioConfig
    variant: VariantId
    profileName: string
    controlBranch: string
    defaultBranch: string
    /** Where the replay tree and event go; defaults to `defaultBranch`. Placeholders still register on the default branch. */
    replayBranch?: string
    allRepoWorkflows: string[]
    newlyIntroducedWorkflows: string[]
    scenarioWorkflows: string[]
    variantLock: VariantTreeLock
    failAtStep?: StagingStep
    awaitCompletionFn?: (dispatch: NonNullable<PersistedStagingState['dispatchRecord']>) => Promise<void>
  }): Promise<PersistedStagingState> {
    const {
      experimentId,
      sampleId,
      scenario,
      variant,
      profileName,
      controlBranch,
      defaultBranch,
      replayBranch = defaultBranch,
      allRepoWorkflows,
      newlyIntroducedWorkflows,
      scenarioWorkflows,
      variantLock,
      failAtStep,
      awaitCompletionFn,
    } = params

    // Reject GITHUB_TOKEN before dispatch since GITHUB_TOKEN will not trigger native event chains
    if (this.backend.tokenKind === 'github_token') {
      throw new Error(
        'Refusing to stage replay with GITHUB_TOKEN: GitHub App token is required to produce an unattended native event chain.',
      )
    }

    const existing = this.loadState()
    if (
      existing &&
      existing.currentStep !== 'completed' &&
      existing.currentStep !== 'recovered' &&
      existing.currentStep !== 'idle' &&
      existing.sampleId !== sampleId
    ) {
      throw new Error(
        `Repository-wide experiment lease already held by sample "${existing.sampleId}" at step "${existing.currentStep}". Run "bench recover" first.`,
      )
    }

    const baseTopicRef = `refs/heads/${scenario.pr?.baseRef ?? replayBranch}`
    const headTopicRef = `refs/heads/bench/pr/${scenario.name}/head`
    const replayRef = `refs/heads/${replayBranch}`
    // The default branch is owned too: workflow registration commits placeholders to it.
    const benchmarkOwnedRefs = [...new Set([replayRef, `refs/heads/${defaultBranch}`, baseTopicRef, headTopicRef])]

    // Refuse before any write: every owned ref is installed over and later restored.
    for (const ref of benchmarkOwnedRefs) assertRefNotProtected(ref, this.protectedBranches)

    const currentRefs = await this.backend.getCurrentRefs()
    const previousBenchmarkRefs: Record<string, string | null> = {}
    const observedUnrelatedRefs: Record<string, string> = {}

    for (const ref of benchmarkOwnedRefs) {
      previousBenchmarkRefs[ref] = currentRefs[ref] ?? null
    }
    for (const [ref, sha] of Object.entries(currentRefs)) {
      if (!benchmarkOwnedRefs.includes(ref)) {
        observedUnrelatedRefs[ref] = sha
      }
    }

    const state: PersistedStagingState =
      existing && existing.sampleId === sampleId
        ? existing
        : {
            experimentId,
            sampleId,
            scenarioName: scenario.name,
            variant,
            profileName,
            currentStep: 'idle',
            completedSteps: [],
            controlBranch,
            defaultBranch,
            benchmarkOwnedRefs,
            previousBenchmarkRefs,
            observedUnrelatedRefs,
            registeredPlaceholderWorkflows: [],
            disabledWorkflows: [],
            enabledWorkflows: [],
            updatedAt: new Date().toISOString(),
          }

    const transition = (step: StagingStep) => {
      state.currentStep = step
      this.saveState(state)
      if (failAtStep === step) {
        throw new StagingInterruptionError(step)
      }
    }

    const completeStep = (step: StagingStep) => {
      if (!state.completedSteps.includes(step)) {
        state.completedSteps.push(step)
      }
      this.saveState(state)
    }

    // Step 1: Acquire repository-wide experiment lease
    if (!state.completedSteps.includes('1_acquire_lease')) {
      await this.backend.acquireLease?.()
      transition('1_acquire_lease')
      state.leaseAcquiredAt = new Date().toISOString()
      state.leaseHolder = `${experimentId}:${sampleId}`
      completeStep('1_acquire_lease')
    }

    // Step 2: Register newly introduced workflows as inactive placeholders
    if (!state.completedSteps.includes('2_register_placeholders')) {
      transition('2_register_placeholders')
      for (const wf of newlyIntroducedWorkflows) {
        if (!state.registeredPlaceholderWorkflows.includes(wf)) {
          await this.backend.registerInactiveWorkflowPlaceholder(defaultBranch, wf)
          state.registeredPlaceholderWorkflows.push(wf)
          this.saveState(state)
        }
      }
      completeStep('2_register_placeholders')
    }

    // Step 3: Disable replay workflows while resetting benchmark-owned refs and preparing PR metadata
    let prNumber = state.replayPrNumber
    if (!state.completedSteps.includes('3_disable_workflows_and_reset_refs')) {
      transition('3_disable_workflows_and_reset_refs')
      const workflowsToDisable = [...new Set([...allRepoWorkflows, ...newlyIntroducedWorkflows])]
      for (const wf of workflowsToDisable) {
        if (!state.disabledWorkflows.includes(wf)) {
          await this.backend.disableWorkflow(wf)
          state.disabledWorkflows.push(wf)
          this.saveState(state)
        }
      }
      completeStep('3_disable_workflows_and_reset_refs')
    }

    // Step 4: Install the generated workflow/source trees and verify their hashes
    if (!state.completedSteps.includes('4_install_and_verify_trees')) {
      transition('4_install_and_verify_trees')
      const install = (ref: string, role?: 'head') =>
        this.backend.installTreeToRef({
          ref,
          ...(role ? { role } : {}),
          treeHash: variantLock.combinedHash,
          expectedCombinedHash: variantLock.combinedHash,
        })
      const installDefault = await install(replayRef)
      if (installDefault.verifiedHash !== variantLock.combinedHash) {
        throw new Error(
          `Installed tree hash mismatch on "${replayRef}": expected ${variantLock.combinedHash}, got ${installDefault.verifiedHash}`,
        )
      }
      if (scenario.pr) {
        await install(baseTopicRef)
        await install(headTopicRef, 'head')
      }
      // Dispatch scenarios run on the head tree; a [skip ci] commit keeps push workflows from starting.
      if (scenario.event === 'workflow_dispatch') await install(replayRef, 'head')
      if (scenario.pr) {
        const prMeta = await this.backend.preparePullRequestMetadata({
          baseRef: baseTopicRef,
          headRef: headTopicRef,
          labels: scenario.pr.labels,
        })
        prNumber = prMeta.prNumber
        state.replayPrNumber = prNumber
        this.saveState(state)
      }
      state.installedTreeHash = installDefault.verifiedHash
      completeStep('4_install_and_verify_trees')
    }

    // Step 5: Enable the scenario's workflow set
    if (!state.completedSteps.includes('5_enable_scenario_workflows')) {
      transition('5_enable_scenario_workflows')
      for (const wf of scenarioWorkflows) {
        if (!state.enabledWorkflows.includes(wf)) {
          await this.backend.enableWorkflow(wf)
          state.enabledWorkflows.push(wf)
          this.saveState(state)
        }
      }
      // Managed runs (Dependabot) start seconds after the tree lands; cancel them and let them end before the event.
      await this.backend.cancelManagedRuns?.()
      completeStep('5_enable_scenario_workflows')
    }

    // Step 6: Trigger the actual PR activity or merge/push using a GitHub App token (prevent duplicate dispatch!)
    if (!state.completedSteps.includes('6_trigger_event')) {
      transition('6_trigger_event')
      if (!state.dispatchRecord) {
        const idempotencyKey = `${experimentId}:${sampleId}:${scenario.name}:${variant}`
        const targetRef = scenario.pr ? headTopicRef : replayRef
        const triggered = await this.backend.triggerNativeEvent({
          idempotencyKey,
          event: scenario.event,
          ...(scenario.pr?.activityType ? { activityType: scenario.pr.activityType } : {}),
          ...(prNumber !== undefined ? { prNumber } : {}),
          targetRef,
          ...(scenario.event === 'workflow_dispatch' ? { workflows: scenarioWorkflows } : {}),
        })
        state.dispatchRecord = {
          idempotencyKey,
          dispatchedAt: triggered.dispatchedAt,
          event: scenario.event,
          ...(scenario.pr?.activityType ? { activityType: scenario.pr.activityType } : {}),
          ...(prNumber !== undefined ? { prNumber } : {}),
          targetRef,
          headSha: triggered.headSha,
        }
        this.saveState(state)
      }
      completeStep('6_trigger_event')
    }

    // Step 7: Keep the replay/default tree fixed until all downstream runs finish
    if (!state.completedSteps.includes('7_await_downstream_completion')) {
      transition('7_await_downstream_completion')
      const refsBeforeWait = await this.backend.getCurrentRefs()

      if (!awaitCompletionFn) throw new Error('Completion waiter is required; replay tree remains leased')
      if (state.dispatchRecord) {
        await awaitCompletionFn(state.dispatchRecord)
      }

      const refsAfterWait = await this.backend.getCurrentRefs()
      for (const ownedRef of state.benchmarkOwnedRefs) {
        if (refsBeforeWait[ownedRef] !== refsAfterWait[ownedRef]) {
          state.currentStep = 'invalidated'
          state.invalidationReason = `Unexpected concurrent mutation detected on benchmark-owned ref "${ownedRef}" (${refsBeforeWait[ownedRef]} -> ${refsAfterWait[ownedRef]}) while awaiting downstream runs.`
          this.saveState(state)
          throw new Error(state.invalidationReason)
        }
      }

      completeStep('7_await_downstream_completion')
    }

    await this.backend.releaseLease?.()
    state.currentStep = 'completed'
    this.saveState(state)
    return state
  }

  /**
   * Idempotently recovers from an interrupted staging operation at any boundary (steps 1-7).
   * Native adapters restore the entire experiment journal; generic adapters restore
   * the sample snapshot. Both preserve unrelated refs and release their lease.
   */
  async recover(): Promise<{
    recovered: boolean
    restoredRefs: Record<string, string | null>
    disabledWorkflows: string[]
    alreadyDispatched: boolean
  }> {
    const state = this.loadState()
    // Native experiments share one lease and journal across samples. Their adapter
    // owns the original snapshot; a sample snapshot may already contain another variant.
    if (this.backend.recoverExperiment) {
      const recovery = await this.backend.recoverExperiment()
      if (state) {
        state.currentStep = 'recovered'
        this.saveState(state)
      }
      return { recovered: true, ...recovery, alreadyDispatched: Boolean(state?.dispatchRecord) }
    }
    if (!state) {
      return {
        recovered: false,
        restoredRefs: {},
        disabledWorkflows: [],
        alreadyDispatched: false,
      }
    }

    if (state.currentStep === 'recovered') {
      return {
        recovered: true,
        restoredRefs: { ...state.previousBenchmarkRefs },
        disabledWorkflows: [...state.disabledWorkflows],
        alreadyDispatched: Boolean(state.dispatchRecord),
      }
    }

    await this.backend.acquireLease?.()
    await this.backend.ensureNoActiveRuns?.()
    const workflowsToDisable = [
      ...new Set([...state.enabledWorkflows, ...state.disabledWorkflows, ...state.registeredPlaceholderWorkflows]),
    ]
    const disabled: string[] = []
    for (const wf of workflowsToDisable) {
      await this.backend.disableWorkflow(wf)
      disabled.push(wf)
    }

    const restoredRefs: Record<string, string | null> = {}
    for (const [ref, prevSha] of Object.entries(state.previousBenchmarkRefs)) {
      if (state.benchmarkOwnedRefs.includes(ref)) {
        assertRefNotProtected(ref, this.protectedBranches)
        await this.backend.updateRef(ref, prevSha)
        restoredRefs[ref] = prevSha
      }
    }

    await this.backend.restoreWorkflowStates?.()
    await this.backend.releaseLease?.()
    state.currentStep = 'recovered'
    this.saveState(state)

    return {
      recovered: true,
      restoredRefs,
      disabledWorkflows: disabled,
      alreadyDispatched: Boolean(state.dispatchRecord),
    }
  }
}
