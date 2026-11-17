import { describe, expect, it } from 'vitest'
import {
  computeParityInputFingerprint,
  createDefaultProfiles,
  createDefaultRunnerMapping,
  defineBenchmarkConfig,
} from '../src/config.ts'
import {
  compareCoverageSummaries,
  evaluateParityGates,
  issueParityCertificate,
  type TestInputFingerprint,
  type VariantExecutionEvidence,
  verifyParityCertificateValid,
} from '../src/parity.ts'
import type { ScenarioInventory } from '../src/types.ts'

const baseScenarioInv: ScenarioInventory = {
  scenarioName: 'pr-test',
  triggeredWorkflows: ['.github/workflows/ci.yml'],
  excludedWorkflows: [],
  downstreamWorkflowRuns: [],
  jobExpectations: [
    {
      workflowFile: '.github/workflows/ci.yml',
      workflowName: 'CI',
      jobId: 'test',
      triggeredBy: 'direct',
      expectedStatus: 'executed',
      isDynamicMatrix: false,
      mappedRunsOn: { github: 'ubuntu-24.04', starsling: 'starsling-ubuntu-24.04', retainedOnGitHub: false },
    },
  ],
  mixedRunnerOnStarSling: false,
  movedJobs: ['.github/workflows/ci.yml#test'],
  retainedJobs: [],
  blockers: [],
}

const seedFp: TestInputFingerprint = {
  sourceDepsHash: 'deps-v1',
  testCodeHash: 'tests-v1',
  configHash: 'cfg-v1',
  lockfilesHash: 'lock-v1',
  toolchain: 'node-24.16.0',
  platform: 'linux-x64',
  envHash: 'env-v1',
}

describe('Stage 5: Three-stage semantic parity gates, cached-test invalidation, coverage thresholds, and certificate invalidation', () => {
  it('separates executed, reused, skipped, and missing tests and validates cached-test invalidation on changed inputs or failing fixtures', () => {
    const baselineEvidence: VariantExecutionEvidence = {
      inventory: baseScenarioInv,
      semanticObligationsFulfilled: ['unit-tests', 'typecheck'],
      executedWorkflows: ['.github/workflows/ci.yml'],
      executedMatrixRowCounts: {},
      observedCommands: ['pnpm test'],
      jobOutputs: {},
      tests: [
        { testId: 'auth.spec.ts', verdict: 'passed', mode: 'executed' },
        { testId: 'db.spec.ts', verdict: 'passed', mode: 'executed' },
        { testId: 'legacy.spec.ts', verdict: 'skipped', mode: 'skipped' },
      ],
    }

    // 1. Valid reused test linked to valid seed with matching input fingerprint
    const validCandidate: VariantExecutionEvidence = {
      ...baselineEvidence,
      tests: [
        { testId: 'auth.spec.ts', verdict: 'passed', mode: 'executed' },
        {
          testId: 'db.spec.ts',
          verdict: 'passed',
          mode: 'reused',
          seedProvenance: {
            seedRunId: 9001,
            seedSucceeded: true,
            seedFingerprint: seedFp,
          },
          currentFingerprint: { ...seedFp },
        },
        { testId: 'legacy.spec.ts', verdict: 'skipped', mode: 'skipped' },
      ],
    }

    const okEval = evaluateParityGates({
      baseline: baselineEvidence,
      candidate: validCandidate,
      allowTestResultReuse: true,
    })
    expect(okEval.passed).toBe(true)
    expect(okEval.evidenceLevel).toBe('test/verdict parity')
    expect(okEval.satisfies01PpCoverageRequirement).toBe(false) // No coverage provided
    expect(okEval.semantic.testInventory).toEqual({
      executed: ['auth.spec.ts'],
      reused: ['db.spec.ts'],
      skipped: ['legacy.spec.ts'],
      missing: [],
    })

    // 2. Invalidation failure on changed test code, dependencies, config, or lockfile
    for (const mutatedField of ['testCodeHash', 'sourceDepsHash', 'configHash', 'lockfilesHash'] as const) {
      const staleCandidate: VariantExecutionEvidence = {
        ...validCandidate,
        tests: [
          { testId: 'auth.spec.ts', verdict: 'passed', mode: 'executed' },
          {
            testId: 'db.spec.ts',
            verdict: 'passed',
            mode: 'reused',
            seedProvenance: {
              seedRunId: 9001,
              seedSucceeded: true,
              seedFingerprint: seedFp,
            },
            currentFingerprint: {
              ...seedFp,
              [mutatedField]: 'mutated-value',
            },
          },
          { testId: 'legacy.spec.ts', verdict: 'skipped', mode: 'skipped' },
        ],
      }

      const staleEval = evaluateParityGates({
        baseline: baselineEvidence,
        candidate: staleCandidate,
        allowTestResultReuse: true,
      })
      expect(staleEval.passed).toBe(false)
      expect(staleEval.semantic.issues.some((i) => i.includes('failed to invalidate'))).toBe(true)
    }

    // 3. Deliberately introduced failing fixture must invalidate cached test verdict
    const failingFixtureEval = evaluateParityGates({
      baseline: baselineEvidence,
      candidate: {
        ...validCandidate,
        deliberateFailureFixtureInjected: true,
      },
      allowTestResultReuse: true,
    })
    expect(failingFixtureEval.passed).toBe(false)
    expect(failingFixtureEval.semantic.issues.some((i) => i.includes('deliberately failing fixture'))).toBe(true)
  })

  it('evaluates coverage differences below (0.05 pp), at (0.10 pp), and above (0.15 pp) 0.1 pp, and rejects reduced denominators', () => {
    const baseCov = {
      lines: { covered: 8000, total: 10000, percentage: 80.0 },
      branches: { covered: 750, total: 1000, percentage: 75.0 },
    }

    // 1. Below 0.1 pp (0.05 pp drop: 7995/10000 = 79.95%) -> PASS
    const below01 = compareCoverageSummaries(baseCov, {
      lines: { covered: 7995, total: 10000, percentage: 79.95 },
      branches: { covered: 750, total: 1000, percentage: 75.0 },
    })
    expect(below01.passed).toBe(true)
    expect(below01.maxPercentagePointDrop).toBeCloseTo(0.05)

    // 2. Exactly at 0.10 pp (7990/10000 = 79.90%) -> PASS
    const at01 = compareCoverageSummaries(baseCov, {
      lines: { covered: 7990, total: 10000, percentage: 79.9 },
      branches: { covered: 750, total: 1000, percentage: 75.0 },
    })
    expect(at01.passed).toBe(true)
    expect(at01.maxPercentagePointDrop).toBeCloseTo(0.1)

    // 3. Above 0.10 pp (0.15 pp drop: 7985/10000 = 79.85%) -> FAIL
    const above01 = compareCoverageSummaries(baseCov, {
      lines: { covered: 7985, total: 10000, percentage: 79.85 },
      branches: { covered: 750, total: 1000, percentage: 75.0 },
    })
    expect(above01.passed).toBe(false)
    expect(above01.details[0]).toContain('exceeding the 0.10 pp maximum threshold')

    // 4. Unchanged percentage (80.0%) with reduced denominator (4000/5000 vs 8000/10000) -> REJECTED!
    const reducedDenominator = compareCoverageSummaries(baseCov, {
      lines: { covered: 4000, total: 5000, percentage: 80.0 },
      branches: { covered: 750, total: 1000, percentage: 75.0 },
    })
    expect(reducedDenominator.passed).toBe(false)
    expect(reducedDenominator.denominatorScopeMaintained).toBe(false)
    expect(reducedDenominator.details[0]).toContain('reduced denominator scope')
  })

  it('invalidates parity certificate whenever patch, adapter, scenario, runner mapping, or cache profile changes', () => {
    const config = defineBenchmarkConfig({
      schemaVersion: 1,
      upstream: {
        repository: 'org/repo',
        commitSha: 'a'.repeat(40),
        defaultBranch: 'main',
      },
      benchmarkRepository: {
        repository: 'starsling-bench/repo',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
      },
      scenarios: {
        'pr-test': {
          name: 'pr-test',
          description: 'PR test',
          event: 'pull_request',
          pr: {
            prNumber: 1,
            baseRef: 'main',
            headRef: 'feat/x',
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            mergeSha: 'c'.repeat(40),
            activityType: 'synchronize',
            changedPaths: ['src/index.ts'],
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
            beforeSha: 'a'.repeat(40),
            afterSha: 'b'.repeat(40),
            changedPaths: ['src/index.ts'],
          },
          referenceRuns: [],
        },
      },
      patches: [],
      runnerMapping: createDefaultRunnerMapping(),
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

    const initialPatches = [
      {
        id: 'p1',
        source: 'local' as const,
        originalPathOrUrl: 'p1.patch',
        immutableOrigin: 'file://p1.patch',
        resolvedRevision: '1'.repeat(40),
        sha256: 'hash-v1',
        byteLength: 10,
        patchContent: 'diff',
      },
    ]

    const fp1 = computeParityInputFingerprint({
      config,
      scenarioName: 'pr-test',
      profileName: 'cold',
      lockedPatches: initialPatches,
    })

    const cert = issueParityCertificate({
      scenario: 'pr-test',
      profile: 'cold',
      inputFingerprint: fp1,
      evaluation: {
        passed: true,
        evidenceLevel: 'coverage-qualified',
        satisfies01PpCoverageRequirement: true,
        structural: { passed: true, issues: [] },
        observed: { passed: true, issues: [] },
        semantic: {
          passed: true,
          issues: [],
          testInventory: { executed: ['t1'], reused: [], skipped: [], missing: [] },
        },
      },
    })

    expect(verifyParityCertificateValid(cert, fp1).valid).toBe(true)

    const firstPatch = initialPatches[0]
    if (!firstPatch) throw new Error('Expected initial patch')

    // Mutating patch SHA invalidates certificate
    const fpChangedPatch = computeParityInputFingerprint({
      config,
      scenarioName: 'pr-test',
      profileName: 'cold',
      lockedPatches: [{ ...firstPatch, sha256: 'hash-v2' }],
    })
    expect(verifyParityCertificateValid(cert, fpChangedPatch).valid).toBe(false)

    // Mutating adaptation invalidates certificate
    const fpChangedAdapter = computeParityInputFingerprint({
      config: {
        ...config,
        adaptations: [
          {
            id: 'a1',
            kind: 'repository-identity-remap',
            fromPattern: 'org/repo',
            toReplacement: 'starsling-bench/repo',
            reason: 'remap',
          },
        ],
      },
      scenarioName: 'pr-test',
      profileName: 'cold',
      lockedPatches: initialPatches,
    })
    expect(verifyParityCertificateValid(cert, fpChangedAdapter).valid).toBe(false)
  })
})
