import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import benchmarkConfig from './fixtures/definitelytyped.config.ts'
import { executeBenchInspect, executeBenchVerify } from '../src/commands.ts'
import { buildLockfile, createDefaultProfiles, defineBenchmarkConfig, resolvePatchStack } from '../src/config.ts'
import { pinnedRunnerMapping } from './fixtures/pinned-runner-mapping.ts'
import { prepareReplayVariants } from '../src/generator.ts'
import { evaluateParityGates } from '../src/parity.ts'
import { constructReplayAncestry } from '../src/patcher.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import type { SampleMeasurementResult } from '../src/collector.ts'
import type { VariantId } from '../src/types.ts'

describe('Stage 6: A/A experiments, DefinitelyTyped dt-combined.patch regression fixture, and multi-pipeline acceptance', () => {
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

  it('runs an A/A experiment that preserves identical workflow graphs, tree hashes, verdicts, and 1.00x measurement boundaries', async () => {
    const root = createTempDir('aa-experiment')
    const upstreamDir = join(root, 'upstream')
    mkdirSync(join(upstreamDir, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      join(upstreamDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on: [pull_request, push]',
        'jobs:',
        '  build-and-test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm test',
        '',
      ].join('\n'),
      'utf8',
    )

    const aaConfig = defineBenchmarkConfig({
      schemaVersion: 1,
      upstream: {
        repository: 'org/aa-repo',
        commitSha: 'a'.repeat(40),
        defaultBranch: 'main',
      },
      benchmarkRepository: {
        repository: 'starsling-bench/aa-repo',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
      },
      scenarios: {
        pr: {
          name: 'pr',
          description: 'A/A PR scenario',
          event: 'pull_request',
          pr: {
            prNumber: 1,
            baseRef: 'main',
            headRef: 'feat/aa',
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            mergeSha: 'c'.repeat(40),
            activityType: 'synchronize',
            changedPaths: ['src/index.ts'],
            labels: [],
          },
          referenceRuns: [],
        },
      },
      patches: [], // A/A experiment: baseline and patched are identical
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

    const prepared = prepareReplayVariants({
      upstreamSourceDir: upstreamDir,
      workRootDir: join(root, 'work'),
      config: aaConfig,
      patches: [],
    })

    // In A/A mode, github-baseline and github-patched have byte-for-byte identical tree hashes and job graphs
    expect(prepared.variants['github-baseline'].lock.combinedHash).toBe(
      prepared.variants['github-patched'].lock.combinedHash,
    )
    expect(prepared.variants['starsling-baseline'].lock.combinedHash).toBe(
      prepared.variants['starsling-patched'].lock.combinedHash,
    )

    const makeAaSample = (rep: number, variant: VariantId): SampleMeasurementResult => ({
      sampleId: `aa-${rep}-${variant}`,
      repetition: rep,
      scenarioName: 'pr',
      variant,
      profileName: 'cold',
      complete: true,
      incompleteReasons: [],
      missingWorkflows: [],
      missingJobs: [],
      cancelledJobs: [],
      failedJobs: [],
      partialTimestampJobs: [],
      timestampResolution: '1s',
      metrics: {
        repoMinutes: 1.0,
        rawRunnerSeconds: 60,
        wallClockSeconds: 60,
        prWallClockSeconds: 60,
        mainWallClockSeconds: null,
        triggerLatencySeconds: 2,
        harnessOverheadSeconds: 1,
      },
      workflows: [],
      artifacts: [],
    })

    const samples: SampleMeasurementResult[] = []
    for (let rep = 1; rep <= 5; rep++) {
      for (const v of ['github-baseline', 'github-patched', 'starsling-baseline', 'starsling-patched'] as const) {
        samples.push(makeAaSample(rep, v))
      }
    }

    const report = generateExperimentReport({
      experimentId: 'exp-aa',
      config: aaConfig,
      samples,
    })
    const comp = report.comparisons[0]
    expect(comp?.ratios.githubSameRunnerOptimizationRatio).toBe(1)
    expect(comp?.ratios.starslingSameRunnerOptimizationRatio).toBe(1)
  })

  it('validates DefinitelyTyped dt-combined.patch regression fixture: changed job graphs, YAML anchors, sparse checkout, and HEAD^1 diff-selected tests', async () => {
    const root = createTempDir('dt-regression')
    const dtBaselineDir = resolve('tests/fixtures/definitelytyped-baseline')
    const repoRoot = resolve('.')

    const lockedPatches = await resolvePatchStack(benchmarkConfig.patches, repoRoot)
    expect(lockedPatches.length).toBe(1)
    expect(lockedPatches[0]?.id).toBe('dt-combined')

    const prepared = prepareReplayVariants({
      upstreamSourceDir: dtBaselineDir,
      workRootDir: join(root, 'work'),
      config: benchmarkConfig,
      patches: lockedPatches,
    })

    const baseCi = prepared.baselineInventory.workflows['.github/workflows/CI.yml']
    const patCi = prepared.patchedInventory.workflows['.github/workflows/CI.yml']
    if (!baseCi || !patCi) throw new Error('Expected CI.yml in baseline and patched inventories')

    // 1. Baseline CI.yml job graph: setup-matrix, test (needs: setup-matrix), dangerbot (needs: test), scripts
    expect(Object.keys(baseCi.jobs)).toEqual(['setup-matrix', 'test', 'dangerbot', 'scripts'])
    expect(baseCi.jobs.test?.needs).toEqual(['setup-matrix'])
    expect(baseCi.jobs.test?.matrixConfig?.isDynamic).toBe(true)

    // 2. Patched CI.yml job graph after applying dt-combined.patch BEFORE reading workflows:
    // - `scripts` job is removed (folded into `test` shard 1)
    // - `test` has NO `needs` (shard 1 starts immediately off the critical path!)
    // - `test-rest` is added with `needs: ['setup-matrix']`, dynamic matrix `fromJson(needs.setup-matrix.outputs.rest)`, and YAML anchor `*test-steps` expanded!
    // - `dangerbot` now `needs: ['setup-matrix', 'test', 'test-rest']`
    expect(Object.keys(patCi.jobs)).toEqual(['setup-matrix', 'test', 'test-rest', 'dangerbot'])
    expect(patCi.jobs.test?.needs).toEqual([])
    expect(patCi.jobs['test-rest']?.needs).toEqual(['setup-matrix'])
    expect(patCi.jobs['test-rest']?.matrixConfig?.isDynamic).toBe(true)
    expect(patCi.jobs['test-rest']?.steps.length).toBe(patCi.jobs.test?.steps.length)
    expect(patCi.jobs.dangerbot?.needs).toEqual(['setup-matrix', 'test', 'test-rest'])

    // 3. Sparse checkout and executable helper scripts created by dt-combined.patch
    const patTreeDir = prepared.variants['starsling-patched'].treeDir
    const matrixCountScript = join(patTreeDir, 'scripts', 'ci-matrix-count.sh')
    const narrowWsScript = join(patTreeDir, 'scripts', 'narrow-workspace.sh')
    expect(existsSync(matrixCountScript)).toBe(true)
    expect(existsSync(narrowWsScript)).toBe(true)
    expect((lstatSync(matrixCountScript).mode & 0o111) !== 0).toBe(true)
    expect((lstatSync(narrowWsScript).mode & 0o111) !== 0).toBe(true)

    const checkoutStep = patCi.jobs.test?.steps[0]
    expect(checkoutStep?.withInputs?.['fetch-depth']).toBe(2)
    expect(checkoutStep?.withInputs?.['sparse-checkout-cone-mode']).toBe(false)
    expect(String(checkoutStep?.withInputs?.['sparse-checkout'])).toContain('/types/**/package.json')

    // 4. Repository identity guard remapped cleanly in generated workflows
    const generatedCiText = readFileSync(join(patTreeDir, '.github', 'workflows', 'CI.yml'), 'utf8')
    expect(generatedCiText).toContain("github.repository == 'starsling-bench/definitelytyped-replay'")
    expect(generatedCiText).not.toContain("github.repository == 'DefinitelyTyped/DefinitelyTyped'")

    // 5. Replay ancestry preserves HEAD^1 diff-selected tests (types/node/index.d.ts) without leaking dt-combined.patch files into git diff HEAD^1
    const baseTree = join(root, 'dt-base')
    const headTree = join(root, 'dt-head')
    mkdirSync(join(baseTree, 'types', 'node'), { recursive: true })
    mkdirSync(join(headTree, 'types', 'node'), { recursive: true })
    // Copy baseline files to both baseTree and headTree, and change only types/node/index.d.ts in headTree
    for (const target of [baseTree, headTree]) {
      mkdirSync(join(target, '.github', 'workflows'), { recursive: true })
      mkdirSync(join(target, 'scripts'), { recursive: true })
      writeFileSync(
        join(target, '.github', 'workflows', 'CI.yml'),
        readFileSync(join(dtBaselineDir, '.github', 'workflows', 'CI.yml')),
      )
      writeFileSync(
        join(target, 'scripts', 'package.json'),
        readFileSync(join(dtBaselineDir, 'scripts', 'package.json')),
      )
      writeFileSync(
        join(target, 'scripts', 'pnpm-install.sh'),
        readFileSync(join(dtBaselineDir, 'scripts', 'pnpm-install.sh')),
        { mode: 0o755 },
      )
    }
    writeFileSync(join(baseTree, 'types', 'node', 'index.d.ts'), '// Node v24 baseline\n', 'utf8')
    writeFileSync(join(headTree, 'types', 'node', 'index.d.ts'), '// Node v24 PR change\n', 'utf8')

    const dtPrScenario = benchmarkConfig.scenarios['pr-single-package']
    const baseDtInv = prepared.baselineInventory.scenarios['pr-single-package']
    const patDtInv = prepared.patchedInventory.scenarios['pr-single-package']
    if (!dtPrScenario || !baseDtInv || !patDtInv) throw new Error('Expected pr-single-package scenario')

    const ancestry = constructReplayAncestry({
      baseTreeDir: baseTree,
      headTreeDir: headTree,
      replayGitDir: join(root, 'dt-replay-git'),
      scenario: dtPrScenario,
      patches: lockedPatches,
      applyPatches: true,
    })
    expect(ancestry.blockers).toEqual([])
    expect(ancestry.commitMap.preservedChangedPaths).toEqual(['types/node/index.d.ts'])

    // 6. Structural & semantic parity succeeds across the reorganized job graph using semanticObligations
    const parityEval = evaluateParityGates({
      baseline: {
        inventory: baseDtInv,
        semanticObligationsFulfilled: ['typecheck-scripts', 'test-changed-packages', 'danger-pr-check'],
        executedWorkflows: ['.github/workflows/CI.yml'],
        executedMatrixRowCounts: {},
        observedCommands: ['pnpm run test-all', 'pnpm tsc -p ./scripts', 'pnpm danger ci'],
        jobOutputs: {},
        tests: [{ testId: '@types/node', verdict: 'passed', mode: 'executed' }],
      },
      candidate: {
        inventory: patDtInv,
        semanticObligationsFulfilled: ['typecheck-scripts', 'test-changed-packages', 'danger-pr-check'],
        executedWorkflows: ['.github/workflows/CI.yml'],
        executedMatrixRowCounts: {},
        observedCommands: ['pnpm run test-all', 'pnpm exec tsc -p .', 'pnpm danger ci'],
        jobOutputs: {},
        tests: [{ testId: '@types/node', verdict: 'passed', mode: 'executed' }],
      },
      allowTestResultReuse: false,
    })
    // Shard-dependent jobs read needs.*.outputs, so GitHub decides them natively; they are recorded,
    // not turned into blockers, and upstream reference parity checks what actually ran.
    expect(patDtInv.nativeConditions?.map((c) => c.jobId).sort()).toEqual(['dangerbot', 'test-rest'])
    expect(patDtInv.jobExpectations.filter((j) => j.expectedStatus === 'conditional').length).toBeGreaterThan(0)
    expect(parityEval.structural.issues).toEqual([])
    expect(parityEval.passed).toBe(true)
  })

  it('executes full setup skill loop on a small public pipeline and a larger multi-workflow pipeline, withholding speedup headline on parity failure', async () => {
    const root = createTempDir('acceptance-loop')
    const smallRepo = join(root, 'small-pipeline')
    mkdirSync(join(smallRepo, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      join(smallRepo, '.github', 'workflows', 'test.yml'),
      [
        'name: Small Pipeline',
        'on: [pull_request, push]',
        'jobs:',
        '  unit:',
        '    runs-on: ubuntu-latest',
        "    if: github.repository == 'upstream/small-lib'",
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm test',
        '',
      ].join('\n'),
      'utf8',
    )

    const smallConfigUnresolved = defineBenchmarkConfig({
      schemaVersion: 1,
      upstream: {
        repository: 'upstream/small-lib',
        commitSha: '1'.repeat(40),
        defaultBranch: 'main',
      },
      benchmarkRepository: {
        repository: 'starsling-bench/small-lib',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
      },
      scenarios: {
        pr: {
          name: 'pr',
          description: 'Small PR',
          event: 'pull_request',
          pr: {
            prNumber: 1,
            baseRef: 'main',
            headRef: 'feat/small',
            baseSha: '1'.repeat(40),
            headSha: '2'.repeat(40),
            mergeSha: '3'.repeat(40),
            activityType: 'synchronize',
            changedPaths: ['index.ts'],
            labels: [],
          },
          referenceRuns: [],
        },
        'main-push': {
          name: 'main-push',
          description: 'Main push',
          event: 'push',
          main: {
            branch: 'main',
            beforeSha: '1'.repeat(40),
            afterSha: '2'.repeat(40),
            changedPaths: ['index.ts'],
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
        timeoutMinutes: 20,
        maxConcurrentExperiments: 1,
        pollIntervalSeconds: 5,
        publicRepoGitHubFree: true,
      },
    })

    // Step 1 of setup loop: inspect -> detects repository_identity_guard blocker
    const inspect1 = executeBenchInspect({
      upstreamSourceDir: smallRepo,
      config: smallConfigUnresolved,
    })
    expect(inspect1.ok).toBe(false)
    expect(inspect1.data.blockers[0]?.category).toBe('repository_identity_guard')

    // Step 2: resolve blocker by adding narrowly scoped adaptation
    const smallConfigResolved = {
      ...smallConfigUnresolved,
      adaptations: [
        {
          id: 'remap-small-lib',
          kind: 'repository-identity-remap' as const,
          workflowFile: '.github/workflows/test.yml',
          fromPattern: "github.repository == 'upstream/small-lib'",
          toReplacement: "github.repository == 'starsling-bench/small-lib'",
          reason: 'Replay in benchmark repo',
        },
      ],
    }

    const inspect2 = executeBenchInspect({
      upstreamSourceDir: smallRepo,
      config: smallConfigResolved,
    })
    expect(inspect2.ok).toBe(true)

    // This is a directory fixture, not a live pinned Git checkout: use the generator directly.
    const fixturePrepared = prepareReplayVariants({
      upstreamSourceDir: smallRepo,
      workRootDir: join(root, 'small-work'),
      config: smallConfigResolved,
      patches: [],
    })
    const fixtureLocks = Object.fromEntries(
      Object.entries(fixturePrepared.variants).map(([id, value]) => [id, value.lock]),
    ) as Record<VariantId, (typeof fixturePrepared.variants)['github-baseline']['lock']>
    const prep = {
      data: {
        lockfile: buildLockfile({
          config: smallConfigResolved,
          lockedPatches: [],
          inventory: fixturePrepared.patchedInventory,
          variantTrees: { pr: fixtureLocks },
        }),
      },
    }

    const prInv = inspect2.data.scenarios.pr
    if (!prInv) throw new Error('Expected pr scenario inventory')

    // Step 4 & 5: verify with deliberate semantic parity failure (dropped test) -> produces diagnostics and withholds speedup headline!
    const failedParityVerify = executeBenchVerify({
      upstreamSourceDir: smallRepo,
      workRootDir: join(root, 'small-work'),
      config: smallConfigResolved,
      lockfile: prep.data.lockfile,
      scenarioName: 'pr',
      profileName: 'cold',
      parityEvidence: {
        baseline: {
          inventory: prInv,
          semanticObligationsFulfilled: ['.github/workflows/test.yml#unit'],
          executedWorkflows: ['.github/workflows/test.yml'],
          executedMatrixRowCounts: {},
          observedCommands: ['npm test'],
          jobOutputs: {},
          tests: [
            { testId: 'core.test.ts', verdict: 'passed', mode: 'executed' },
            { testId: 'edge-case.test.ts', verdict: 'passed', mode: 'executed' },
          ],
        },
        candidate: {
          inventory: prInv,
          semanticObligationsFulfilled: ['.github/workflows/test.yml#unit'],
          executedWorkflows: ['.github/workflows/test.yml'],
          executedMatrixRowCounts: {},
          observedCommands: ['npm test'],
          jobOutputs: {},
          tests: [
            { testId: 'core.test.ts', verdict: 'passed', mode: 'executed' },
            // edge-case.test.ts was accidentally dropped by candidate!
          ],
        },
      },
    })

    expect(failedParityVerify.ok).toBe(false)
    expect(failedParityVerify.errors?.some((e) => e.includes('edge-case.test.ts'))).toBe(true)
    const parityEvalOut = failedParityVerify.data.parityEvaluation
    if (!parityEvalOut) throw new Error('Expected parityEvaluation')

    // Generate report with this failed parity evaluation -> headline speedup claim MUST be withheld!
    const reportWithFailedParity = generateExperimentReport({
      experimentId: 'exp-parity-fail',
      config: smallConfigResolved,
      samples: [
        {
          sampleId: 's1',
          repetition: 1,
          scenarioName: 'pr',
          variant: 'starsling-patched',
          profileName: 'cold',
          complete: true,
          incompleteReasons: [],
          missingWorkflows: [],
          missingJobs: [],
          cancelledJobs: [],
          failedJobs: [],
          partialTimestampJobs: [],
          timestampResolution: '1s',
          metrics: {
            repoMinutes: 0.5,
            rawRunnerSeconds: 30,
            wallClockSeconds: 30,
            prWallClockSeconds: 30,
            mainWallClockSeconds: null,
            triggerLatencySeconds: 1,
            harnessOverheadSeconds: 1,
          },
          workflows: [],
          artifacts: [],
        },
      ],
      parityByScenarioProfile: {
        'pr::cold': parityEvalOut,
      },
    })
    const failedComp = reportWithFailedParity.comparisons[0]
    expect(failedComp?.publishableHeadlineAllowed).toBe(false)
    expect(failedComp?.parityPassed).toBe(false)
    expect(failedComp?.headlineClaimText).toContain('No speedup claim yet')
    expect(failedComp?.withheldReasons).toContain('Same tests and same verdicts are not verified for every sample.')
  })
})
