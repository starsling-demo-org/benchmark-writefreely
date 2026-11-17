import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type GitHubReplayBackend,
  ReplayStagingController,
  StagingInterruptionError,
  type StagingStep,
  type TokenAuthKind,
} from '../src/staging.ts'
import type { ScenarioConfig, VariantTreeLock } from '../src/types.ts'

class MockReplayBackend implements GitHubReplayBackend {
  tokenKind: TokenAuthKind = 'github_app'
  refs: Record<string, string> = {
    'refs/heads/main': 'orig-main-sha',
    'refs/heads/bench/control': 'control-sha-immutable',
    'refs/heads/unrelated-feature': 'unrelated-sha-immutable',
  }
  placeholdersRegistered: string[] = []
  disabledWorkflows = new Set<string>()
  enabledWorkflows = new Set<string>()
  dispatches: { idempotencyKey: string; event: string; targetRef: string }[] = []

  async getCurrentRefs(): Promise<Record<string, string>> {
    return { ...this.refs }
  }

  async updateRef(ref: string, sha: string | null): Promise<void> {
    if (sha === null) {
      delete this.refs[ref]
    } else {
      this.refs[ref] = sha
    }
  }

  placeholderBranches: string[] = []
  async registerInactiveWorkflowPlaceholder(defaultBranch: string, workflowFile: string): Promise<void> {
    this.placeholderBranches.push(defaultBranch)
    this.placeholdersRegistered.push(workflowFile)
    this.disabledWorkflows.add(workflowFile)
  }

  async disableWorkflow(workflowFile: string): Promise<void> {
    this.disabledWorkflows.add(workflowFile)
    this.enabledWorkflows.delete(workflowFile)
  }

  async enableWorkflow(workflowFile: string): Promise<void> {
    this.enabledWorkflows.add(workflowFile)
    this.disabledWorkflows.delete(workflowFile)
  }

  async preparePullRequestMetadata(): Promise<{ prNumber: number }> {
    return { prNumber: 101 }
  }

  async installTreeToRef(params: {
    ref: string
    treeHash: string
    expectedCombinedHash: string
  }): Promise<{ commitSha: string; verifiedHash: string }> {
    this.refs[params.ref] = `installed-${params.treeHash}`
    return {
      commitSha: `installed-${params.treeHash}`,
      verifiedHash: params.treeHash,
    }
  }

  async triggerNativeEvent(params: {
    idempotencyKey: string
    event: string
    activityType?: string
    prNumber?: number
    targetRef: string
  }): Promise<{ headSha: string; dispatchedAt: string }> {
    this.dispatches.push({
      idempotencyKey: params.idempotencyKey,
      event: params.event,
      targetRef: params.targetRef,
    })
    return {
      headSha: this.refs[params.targetRef] ?? 'head-sha',
      dispatchedAt: '2026-11-06T12:00:00Z',
    }
  }
}

const sampleScenario: ScenarioConfig = {
  name: 'pr-sync',
  description: 'PR scenario',
  event: 'pull_request',
  pr: {
    prNumber: 101,
    baseRef: 'main',
    headRef: 'bench/pr-head',
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    mergeSha: '3'.repeat(40),
    activityType: 'synchronize',
    changedPaths: ['src/index.ts'],
    labels: ['ci'],
  },
  referenceRuns: [],
}

const sampleVariantLock: VariantTreeLock = {
  variant: 'starsling-patched',
  sourceTreeHash: 'src-hash-123',
  workflowTreeHash: 'wf-hash-456',
  combinedHash: 'combined-hash-789',
  mixedRunner: false,
  movedJobs: ['.github/workflows/ci.yml#test'],
  retainedJobs: [],
}

describe('Stage 2: Single-repo 7-step staging, interruption at every boundary, duplicate dispatch prevention, and idempotent recovery', () => {
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

  const allBoundaries: StagingStep[] = [
    '1_acquire_lease',
    '2_register_placeholders',
    '3_disable_workflows_and_reset_refs',
    '4_install_and_verify_trees',
    '5_enable_scenario_workflows',
    '6_trigger_event',
    '7_await_downstream_completion',
  ]

  it.each(allBoundaries)(
    'interrupts at boundary %s and idempotently recovers without modifying unrelated refs',
    async (boundaryStep) => {
      const dir = createTempDir(`stage-${boundaryStep}`)
      const stateFile = join(dir, 'staging-state.json')
      const backend = new MockReplayBackend()
      const controller = new ReplayStagingController(stateFile, backend)

      await expect(
        controller.executeSampleStaging({
          experimentId: 'exp-1',
          sampleId: `sample-${boundaryStep}`,
          scenario: sampleScenario,
          variant: 'starsling-patched',
          profileName: 'cold',
          controlBranch: 'bench/control',
          defaultBranch: 'main',
          allRepoWorkflows: ['.github/workflows/ci.yml'],
          newlyIntroducedWorkflows: ['.github/workflows/new-opt.yml'],
          scenarioWorkflows: ['.github/workflows/ci.yml', '.github/workflows/new-opt.yml'],
          variantLock: sampleVariantLock,
          failAtStep: boundaryStep,
        }),
      ).rejects.toThrow(StagingInterruptionError)

      // While lease is active, another sample cannot acquire lease
      await expect(
        controller.executeSampleStaging({
          experimentId: 'exp-1',
          sampleId: 'other-concurrent-sample',
          scenario: sampleScenario,
          variant: 'github-baseline',
          profileName: 'cold',
          controlBranch: 'bench/control',
          defaultBranch: 'main',
          allRepoWorkflows: ['.github/workflows/ci.yml'],
          newlyIntroducedWorkflows: [],
          scenarioWorkflows: ['.github/workflows/ci.yml'],
          variantLock: sampleVariantLock,
        }),
      ).rejects.toThrow(/Repository-wide experiment lease already held/)

      // Recover idempotently (calling recover twice produces the same clean state)
      const firstRecovery = await controller.recover()
      const secondRecovery = await controller.recover()
      expect(firstRecovery.recovered).toBe(true)
      expect(secondRecovery.recovered).toBe(true)

      // Benchmark-owned refs are restored to their original states
      expect(backend.refs['refs/heads/main']).toBe('orig-main-sha')
      expect(backend.refs['refs/heads/bench/pr/pr-sync/base']).toBeUndefined()
      expect(backend.refs['refs/heads/bench/pr/pr-sync/head']).toBeUndefined()

      // Unrelated refs were never touched
      expect(backend.refs['refs/heads/bench/control']).toBe('control-sha-immutable')
      expect(backend.refs['refs/heads/unrelated-feature']).toBe('unrelated-sha-immutable')
    },
  )

  it('prevents duplicate event dispatch when resuming after step 6 and rejects GITHUB_TOKEN', async () => {
    const dir = createTempDir('dup-dispatch')
    const stateFile = join(dir, 'staging-state.json')
    const backend = new MockReplayBackend()
    const controller = new ReplayStagingController(stateFile, backend)

    // 1. Rejects GITHUB_TOKEN
    backend.tokenKind = 'github_token'
    await expect(
      controller.executeSampleStaging({
        experimentId: 'exp-token',
        sampleId: 's1',
        scenario: sampleScenario,
        variant: 'starsling-patched',
        profileName: 'cold',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
        allRepoWorkflows: ['.github/workflows/ci.yml'],
        newlyIntroducedWorkflows: [],
        scenarioWorkflows: ['.github/workflows/ci.yml'],
        variantLock: sampleVariantLock,
      }),
    ).rejects.toThrow(/GITHUB_TOKEN/)

    // 2. Switch to GitHub App token and fail at step 7 (after step 6 already dispatched)
    backend.tokenKind = 'github_app'
    await expect(
      controller.executeSampleStaging({
        experimentId: 'exp-resume',
        sampleId: 's-resume',
        scenario: sampleScenario,
        variant: 'starsling-patched',
        profileName: 'cold',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
        allRepoWorkflows: ['.github/workflows/ci.yml'],
        newlyIntroducedWorkflows: [],
        scenarioWorkflows: ['.github/workflows/ci.yml'],
        variantLock: sampleVariantLock,
        failAtStep: '7_await_downstream_completion',
      }),
    ).rejects.toThrow(StagingInterruptionError)

    expect(backend.dispatches.length).toBe(1)

    // Resume the same sample without failAtStep -> completes step 7 WITHOUT re-dispatching step 6!
    const finalState = await controller.executeSampleStaging({
      awaitCompletionFn: async () => {},
      experimentId: 'exp-resume',
      sampleId: 's-resume',
      scenario: sampleScenario,
      variant: 'starsling-patched',
      profileName: 'cold',
      controlBranch: 'bench/control',
      defaultBranch: 'main',
      allRepoWorkflows: ['.github/workflows/ci.yml'],
      newlyIntroducedWorkflows: [],
      scenarioWorkflows: ['.github/workflows/ci.yml'],
      variantLock: sampleVariantLock,
    })

    expect(finalState.currentStep).toBe('completed')
    expect(backend.dispatches.length).toBe(1)
  })

  it('invalidates the sample if an unexpected concurrent ref mutation occurs during step 7', async () => {
    const dir = createTempDir('concurrent-mutation')
    const stateFile = join(dir, 'staging-state.json')
    const backend = new MockReplayBackend()
    const controller = new ReplayStagingController(stateFile, backend)

    await expect(
      controller.executeSampleStaging({
        experimentId: 'exp-mut',
        sampleId: 's-mut',
        scenario: sampleScenario,
        variant: 'starsling-patched',
        profileName: 'cold',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
        allRepoWorkflows: ['.github/workflows/ci.yml'],
        newlyIntroducedWorkflows: [],
        scenarioWorkflows: ['.github/workflows/ci.yml'],
        variantLock: sampleVariantLock,
        awaitCompletionFn: async () => {
          // Simulate an external push mutating refs/heads/main mid-run
          await backend.updateRef('refs/heads/main', 'unexpected-external-commit-sha')
        },
      }),
    ).rejects.toThrow(/Unexpected concurrent mutation detected/)

    const loaded = controller.loadState()
    expect(loaded?.currentStep).toBe('invalidated')
  })
})

it('replays on a separate replay branch and leaves the default branch as the benchmark page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench-replay-branch-'))
  try {
    const backend = new MockReplayBackend()
    const controller = new ReplayStagingController(join(directory, 'state.json'), backend)
    const push: ScenarioConfig = {
      name: 'main-push',
      description: 'push',
      event: 'push',
      main: { branch: 'develop', beforeSha: '1'.repeat(40), afterSha: '2'.repeat(40), changedPaths: [] },
      referenceRuns: [],
    }
    const state = await controller.executeSampleStaging({
      experimentId: 'exp-1',
      sampleId: 'hybrid',
      scenario: push,
      variant: 'starsling-patched',
      profileName: 'cold',
      controlBranch: 'bench/control',
      defaultBranch: 'main',
      replayBranch: 'develop',
      allRepoWorkflows: ['.github/workflows/ci.yml'],
      newlyIntroducedWorkflows: ['.github/workflows/new-opt.yml'],
      scenarioWorkflows: ['.github/workflows/ci.yml'],
      variantLock: sampleVariantLock,
      awaitCompletionFn: async () => {},
    })
    expect(state.currentStep).toBe('completed')
    // The tree and the event go to the replay branch; workflow registration still happens on the default branch.
    expect(backend.refs['refs/heads/develop']).toBe(`installed-${sampleVariantLock.combinedHash}`)
    expect(backend.dispatches.map((d) => d.targetRef)).toEqual(['refs/heads/develop'])
    expect(backend.placeholderBranches).toEqual(['main'])
    expect(backend.refs['refs/heads/main']).toBe('orig-main-sha')
    expect(state.benchmarkOwnedRefs).toEqual([
      'refs/heads/develop',
      'refs/heads/main',
      'refs/heads/bench/pr/main-push/head',
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
