import { computeSha256 } from './config.ts'
import type { EvidenceLevel, ParityCertificateRecord, ScenarioInventory } from './types.ts'

export interface TestInputFingerprint {
  sourceDepsHash: string
  testCodeHash: string
  configHash: string
  lockfilesHash: string
  toolchain: string
  platform: string
  envHash: string
}

export function hashTestInputFingerprint(fp: TestInputFingerprint): string {
  return computeSha256(
    JSON.stringify({
      sourceDepsHash: fp.sourceDepsHash,
      testCodeHash: fp.testCodeHash,
      configHash: fp.configHash,
      lockfilesHash: fp.lockfilesHash,
      toolchain: fp.toolchain,
      platform: fp.platform,
      envHash: fp.envHash,
    }),
  )
}

export interface TestCaseVerdictRecord {
  testId: string
  verdict: 'passed' | 'failed' | 'skipped'
  mode: 'executed' | 'reused' | 'skipped'
  seedProvenance?: {
    seedRunId: number
    seedSucceeded: boolean
    seedFingerprint: TestInputFingerprint
  }
  currentFingerprint?: TestInputFingerprint
}

export interface CoverageMetricRecord {
  covered: number
  total: number
  percentage: number
}

export interface CoverageSummaryRecord {
  scopeHash?: string
  lines: CoverageMetricRecord
  statements?: CoverageMetricRecord
  branches?: CoverageMetricRecord
  functions?: CoverageMetricRecord
  fromCachedSeed?: boolean
  seedFingerprintValid?: boolean
}

export interface BuildOutputDigestRecord {
  name: string
  sha256: string
}

export interface VariantExecutionEvidence {
  inventory: ScenarioInventory
  semanticObligationsFulfilled: string[]
  executedWorkflows: string[]
  executedMatrixRowCounts: Record<string, number>
  observedCommands: string[]
  jobOutputs: Record<string, Record<string, string>>
  tests: TestCaseVerdictRecord[]
  coverage?: CoverageSummaryRecord
  buildOutputs?: BuildOutputDigestRecord[]
  deliberateFailureFixtureInjected?: boolean
}

export interface SeparatedTestInventory {
  executed: string[]
  reused: string[]
  skipped: string[]
  missing: string[]
}

export interface ParityEvaluationResult {
  passed: boolean
  evidenceLevel: EvidenceLevel
  satisfies01PpCoverageRequirement: boolean
  structural: {
    passed: boolean
    issues: string[]
  }
  observed: {
    passed: boolean
    issues: string[]
  }
  semantic: {
    passed: boolean
    issues: string[]
    testInventory: SeparatedTestInventory
    coverageComparison?: {
      passed: boolean
      maxPercentagePointDrop: number
      denominatorScopeMaintained: boolean
      details: string[]
    }
  }
}

export function separateTestInventory(
  baselineTests: TestCaseVerdictRecord[],
  candidateTests: TestCaseVerdictRecord[],
): SeparatedTestInventory {
  const candidateById = new Map(candidateTests.map((t) => [t.testId, t]))
  const executed: string[] = []
  const reused: string[] = []
  const skipped: string[] = []
  const missing: string[] = []

  for (const baseTest of baselineTests) {
    const cand = candidateById.get(baseTest.testId)
    if (!cand) {
      missing.push(baseTest.testId)
      continue
    }
    if (cand.mode === 'executed') {
      executed.push(cand.testId)
    } else if (cand.mode === 'reused') {
      reused.push(cand.testId)
    } else {
      skipped.push(cand.testId)
    }
  }

  for (const cand of candidateTests) {
    if (!baselineTests.some((b) => b.testId === cand.testId)) {
      if (cand.mode === 'executed') executed.push(cand.testId)
      else if (cand.mode === 'reused') reused.push(cand.testId)
      else skipped.push(cand.testId)
    }
  }

  return {
    executed: executed.sort(),
    reused: reused.sort(),
    skipped: skipped.sort(),
    missing: missing.sort(),
  }
}

export function compareCoverageSummaries(
  baseline: CoverageSummaryRecord,
  candidate: CoverageSummaryRecord,
): NonNullable<ParityEvaluationResult['semantic']['coverageComparison']> {
  const details: string[] = []
  let passed = true
  let denominatorScopeMaintained = true
  let maxDrop = 0

  if (baseline.scopeHash !== undefined && baseline.scopeHash !== candidate.scopeHash) {
    passed = false
    denominatorScopeMaintained = false
    details.push('Coverage source scope mismatch')
  }

  if (candidate.fromCachedSeed && candidate.seedFingerprintValid !== true) {
    passed = false
    details.push('Cached coverage rejected because its input fingerprint scope is no longer valid.')
  }

  const metricKeys = ['lines', 'statements', 'branches', 'functions'] as const
  for (const key of metricKeys) {
    const baseMetric = baseline[key]
    const candMetric = candidate[key]
    if (!baseMetric && !candMetric) continue
    if (baseMetric && !candMetric) {
      passed = false
      details.push(`Missing coverage metric "${key}" in candidate (baseline had ${baseMetric.percentage.toFixed(2)}%).`)
      continue
    }
    if (!baseMetric || !candMetric) continue

    // Check denominator scope: reject dropped scope masquerading as unchanged percentages
    if (candMetric.total < baseMetric.total) {
      passed = false
      denominatorScopeMaintained = false
      details.push(
        `Coverage metric "${key}" reduced denominator scope from ${baseMetric.total} to ${candMetric.total} items (rejected dropped scope masquerading as ${candMetric.percentage.toFixed(2)}%).`,
      )
    }

    const basePct = baseMetric.total > 0 ? (baseMetric.covered / baseMetric.total) * 100 : baseMetric.percentage
    const candPct = candMetric.total > 0 ? (candMetric.covered / candMetric.total) * 100 : candMetric.percentage
    const drop = Number((basePct - candPct).toFixed(4))
    if (drop > maxDrop) {
      maxDrop = drop
    }

    // 0.1 percentage-point requirement: drop <= 0.1 pp is allowed; drop > 0.1 pp fails
    if (drop > 0.1 + 1e-6) {
      passed = false
      details.push(
        `Coverage metric "${key}" dropped by ${drop.toFixed(2)} pp (${basePct.toFixed(2)}% -> ${candPct.toFixed(2)}%), exceeding the 0.10 pp maximum threshold.`,
      )
    }
  }

  return {
    passed,
    maxPercentagePointDrop: maxDrop,
    denominatorScopeMaintained,
    details,
  }
}

export function evaluateParityGates(params: {
  baseline: VariantExecutionEvidence
  candidate: VariantExecutionEvidence
  allowTestResultReuse: boolean
  adaptationBlocksFullParity?: boolean
}): ParityEvaluationResult {
  const { baseline, candidate, allowTestResultReuse, adaptationBlocksFullParity = false } = params
  const structuralIssues: string[] = []
  const observedIssues: string[] = []
  const semanticIssues: string[] = []

  // Stage 1: Structural Parity
  // Structural reorganizations in the patched variant are allowed if all semantic obligations and root workflows are represented
  if (candidate.inventory.blockers.length > 0) {
    for (const blocker of candidate.inventory.blockers) {
      structuralIssues.push(`Unresolved setup blocker [${blocker.category}]: ${blocker.evidence}`)
    }
  }
  if (adaptationBlocksFullParity) {
    structuralIssues.push(
      'Active repository adaptation blocks full-parity claims (e.g., stripped required secret or altered deployment).',
    )
  }

  const baseObligations =
    baseline.semanticObligationsFulfilled.length > 0
      ? baseline.semanticObligationsFulfilled
      : baseline.inventory.jobExpectations
          .filter((j) => j.expectedStatus === 'executed')
          .map((j) => `${j.workflowFile}#${j.jobId}`)

  const candObligations = new Set(
    candidate.semanticObligationsFulfilled.length > 0
      ? candidate.semanticObligationsFulfilled
      : candidate.inventory.jobExpectations
          .filter((j) => j.expectedStatus === 'executed')
          .map((j) => `${j.workflowFile}#${j.jobId}`),
  )

  for (const obligation of baseObligations) {
    if (!candObligations.has(obligation)) {
      structuralIssues.push(`Missing semantic obligation "${obligation}" across candidate workflow graph.`)
    }
  }

  // Stage 2: Observed Parity
  for (const expectedWf of candidate.inventory.triggeredWorkflows) {
    if (!candidate.executedWorkflows.includes(expectedWf)) {
      observedIssues.push(`Expected workflow "${expectedWf}" did not execute in candidate run.`)
    }
  }

  for (const jobExp of candidate.inventory.jobExpectations) {
    if (jobExp.expectedStatus === 'executed' && jobExp.expectedMatrixCount !== undefined) {
      const key = `${jobExp.workflowFile}#${jobExp.jobId}`
      const actualRows = candidate.executedMatrixRowCounts[key]
      if (actualRows !== jobExp.expectedMatrixCount) {
        observedIssues.push(`Matrix job "${key}" expected ${jobExp.expectedMatrixCount} rows, observed ${actualRows}.`)
      }
    }
  }

  // Stage 3: Semantic Parity
  const testInventory = separateTestInventory(baseline.tests, candidate.tests)
  if (testInventory.missing.length > 0) {
    semanticIssues.push(`Missing test cases in candidate: ${testInventory.missing.join(', ')}`)
  }

  if (!baseline.tests.length || !candidate.tests.length)
    semanticIssues.push('Test inventory is missing; verdict parity is unproven')
  if (new Set(candidate.tests.map((t) => t.testId)).size !== candidate.tests.length)
    semanticIssues.push('Duplicate candidate test identities')
  if (new Set(baseline.tests.map((t) => t.testId)).size !== baseline.tests.length)
    semanticIssues.push('Duplicate baseline test identities')
  const candidateById = new Map(candidate.tests.map((t) => [t.testId, t]))
  for (const baseTest of baseline.tests) {
    const candTest = candidateById.get(baseTest.testId)
    if (!candTest) continue

    if (baseTest.verdict !== candTest.verdict) {
      semanticIssues.push(
        `Test "${baseTest.testId}" verdict mismatch: baseline="${baseTest.verdict}" vs candidate="${candTest.verdict}".`,
      )
    }

    if (candTest.mode === 'reused') {
      if (!allowTestResultReuse) {
        semanticIssues.push(
          `Test "${candTest.testId}" reused cached verdict when profile disables testResultReuseAllowed.`,
        )
        continue
      }
      if (!candTest.seedProvenance) {
        semanticIssues.push(`Reused test "${candTest.testId}" is missing seed provenance link.`)
        continue
      }
      if (!candTest.seedProvenance.seedSucceeded) {
        semanticIssues.push(
          `Reused test "${candTest.testId}" links to failed or incomplete seed run ${candTest.seedProvenance.seedRunId}.`,
        )
      }
      if (!candTest.currentFingerprint) {
        semanticIssues.push(
          `Reused test "${candTest.testId}" is missing current input fingerprint for invalidation check.`,
        )
      } else {
        const seedFpHash = hashTestInputFingerprint(candTest.seedProvenance.seedFingerprint)
        const currFpHash = hashTestInputFingerprint(candTest.currentFingerprint)
        if (seedFpHash !== currFpHash) {
          semanticIssues.push(
            `Cached test "${candTest.testId}" failed to invalidate when relevant inputs changed (seed=${seedFpHash.slice(0, 12)} vs current=${currFpHash.slice(0, 12)}).`,
          )
        }
      }
      if (candidate.deliberateFailureFixtureInjected) {
        semanticIssues.push(
          `Cached test "${candTest.testId}" returned a stale reused verdict despite a deliberately failing fixture being injected.`,
        )
      }
    }
  }

  // Build output digests parity
  if (baseline.buildOutputs && baseline.buildOutputs.length > 0) {
    const candOutputs = new Map((candidate.buildOutputs ?? []).map((b) => [b.name, b.sha256]))
    for (const reqOut of baseline.buildOutputs) {
      const actualDigest = candOutputs.get(reqOut.name)
      if (!actualDigest) {
        semanticIssues.push(`Missing required build output "${reqOut.name}" in candidate.`)
      } else if (actualDigest !== reqOut.sha256) {
        semanticIssues.push(
          `Build output "${reqOut.name}" digest mismatch: baseline=${reqOut.sha256.slice(0, 16)} vs candidate=${actualDigest.slice(0, 16)}.`,
        )
      }
    }
  }

  let coverageComparison: ParityEvaluationResult['semantic']['coverageComparison']
  if (baseline.coverage && candidate.coverage) {
    coverageComparison = compareCoverageSummaries(baseline.coverage, candidate.coverage)
    if (!coverageComparison.passed) {
      semanticIssues.push(...coverageComparison.details)
    }
  } else if (baseline.coverage && !candidate.coverage) {
    semanticIssues.push('Baseline recorded coverage, but candidate is missing coverage data.')
  }

  const structuralPassed = structuralIssues.length === 0
  const observedPassed = observedIssues.length === 0
  const semanticPassed = semanticIssues.length === 0
  const allGatesPassed = structuralPassed && observedPassed && semanticPassed

  let evidenceLevel: EvidenceLevel = 'timing-only'
  let satisfies01PpCoverageRequirement = false

  if (allGatesPassed && baseline.tests.length > 0) {
    if (baseline.coverage && candidate.coverage && coverageComparison?.passed) {
      evidenceLevel = 'coverage-qualified'
      satisfies01PpCoverageRequirement = true
    } else {
      evidenceLevel = 'test/verdict parity'
      satisfies01PpCoverageRequirement = false
    }
  }

  return {
    passed: allGatesPassed,
    evidenceLevel,
    satisfies01PpCoverageRequirement,
    structural: {
      passed: structuralPassed,
      issues: structuralIssues,
    },
    observed: {
      passed: observedPassed,
      issues: observedIssues,
    },
    semantic: {
      passed: semanticPassed,
      issues: semanticIssues,
      testInventory,
      ...(coverageComparison ? { coverageComparison } : {}),
    },
  }
}

export function issueParityCertificate(params: {
  scenario: string
  profile: string
  inputFingerprint: string
  evaluation: ParityEvaluationResult
  issuedAt?: string
}): ParityCertificateRecord {
  const { scenario, profile, inputFingerprint, evaluation, issuedAt } = params
  return {
    scenario,
    profile,
    inputFingerprint,
    issuedAt: issuedAt ?? new Date().toISOString(),
    evidenceLevel: evaluation.evidenceLevel,
    structuralPassed: evaluation.structural.passed,
    observedPassed: evaluation.observed.passed,
    semanticPassed: evaluation.semantic.passed,
  }
}

export function verifyParityCertificateValid(
  certificate: ParityCertificateRecord | undefined,
  currentInputFingerprint: string,
): { valid: boolean; reason?: string } {
  if (!certificate) {
    return { valid: false, reason: 'No parity certificate issued for this scenario and profile.' }
  }
  if (certificate.inputFingerprint !== currentInputFingerprint) {
    return {
      valid: false,
      reason: `Parity certificate invalidated by change in patch, adapter, scenario, runner mapping, or cache profile (expected ${currentInputFingerprint.slice(0, 12)}, cert has ${certificate.inputFingerprint.slice(0, 12)}).`,
    }
  }
  if (!certificate.structuralPassed || !certificate.observedPassed || !certificate.semanticPassed) {
    return { valid: false, reason: 'Parity certificate recorded a failed parity stage.' }
  }
  return { valid: true }
}
