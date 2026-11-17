import { parseIstanbul, parseJsonVerdicts, parseJUnit, parseLcov, parseUnitCoverage } from './collectors.ts'
import { computeSha256 } from './config.ts'
import { evaluateParityGates, type VariantExecutionEvidence, type ParityEvaluationResult } from './parity.ts'
import { validateCacheAndArtifactLifecycle, type CacheLifecycleValidationResult } from './cache-lifecycle.ts'
import { countedSamples, type ExperimentManifest, slotSampleId } from './manifest.ts'
import type { SampleMeasurementResult } from './collector.ts'

export interface SampleEvidence {
  sampleId: string
  inputFingerprint: string
  runIds: number[]
  execution: VariantExecutionEvidence
  cache: Parameters<typeof validateCacheAndArtifactLifecycle>[0]
  sources: {
    path: string
    sha256: string
    kind: 'tests' | 'coverage' | 'cache' | 'runner' | 'context'
    format?: 'json-verdicts' | 'junit' | 'lcov' | 'istanbul' | 'units'
  }[]
}
export interface BoundAssessment {
  sampleId: string
  inputFingerprint: string
  observationHash: string
  sourceHashes: string[]
  parity: ParityEvaluationResult
  cache: CacheLifecycleValidationResult
}
export function observationHash(sample: SampleMeasurementResult): string {
  return computeSha256(JSON.stringify(sample))
}
function assessSample(params: {
  manifest: ExperimentManifest
  sample: SampleMeasurementResult
  baseline: SampleEvidence
  evidence: SampleEvidence
  allowTestResultReuse: boolean
}): BoundAssessment {
  const { manifest, sample, evidence, baseline } = params
  if (
    evidence.sampleId !== sample.sampleId ||
    evidence.inputFingerprint !== manifest.inputFingerprint ||
    baseline.inputFingerprint !== manifest.inputFingerprint
  )
    throw new Error('Evidence identity/fingerprint mismatch')
  if (!manifest.samples.some((s) => s.sampleId === slotSampleId(sample.sampleId)))
    throw new Error('Evidence is not requested')
  const observedRuns = sample.workflows.map((w) => w.runId).sort((a, b) => a - b)
  if (JSON.stringify([...evidence.runIds].sort((a, b) => a - b)) !== JSON.stringify(observedRuns))
    throw new Error('Evidence run IDs do not match collection')
  if (!evidence.sources.length || evidence.sources.some((s) => !/^[a-f0-9]{64}$/.test(s.sha256)))
    throw new Error('Evidence source digests are missing')
  return {
    sampleId: sample.sampleId,
    inputFingerprint: manifest.inputFingerprint,
    observationHash: observationHash(sample),
    sourceHashes: evidence.sources.map((s) => s.sha256),
    parity: evaluateParityGates({
      baseline: baseline.execution,
      candidate: evidence.execution,
      allowTestResultReuse: params.allowTestResultReuse,
    }),
    cache: validateCacheAndArtifactLifecycle(evidence.cache),
  }
}

/** One binding contract for every report consumer. This is integrity, not a signature. */
export function boundAssessment(
  assessment: BoundAssessment | undefined,
  sample: SampleMeasurementResult,
  manifest: ExperimentManifest,
): BoundAssessment | undefined {
  return assessment?.sampleId === sample.sampleId &&
    assessment.inputFingerprint === manifest.inputFingerprint &&
    assessment.observationHash === observationHash(sample) &&
    assessment.sourceHashes.length > 0 &&
    assessment.sourceHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))
    ? assessment
    : undefined
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      )
    return item
  }
  return JSON.stringify(normalize(value))
}

async function verifySourceMeaning(
  evidence: SampleEvidence,
  readSource: (path: string) => Promise<Uint8Array>,
): Promise<void> {
  const tests: VariantExecutionEvidence['tests'] = []
  const coverage: NonNullable<VariantExecutionEvidence['coverage']>[] = []
  for (const source of evidence.sources) {
    const bytes = await readSource(source.path)
    if (computeSha256(bytes) !== source.sha256) throw new Error(`Evidence digest mismatch: ${source.path}`)
    const content = new TextDecoder().decode(bytes)
    if (source.kind === 'tests') {
      if (source.format === 'junit') tests.push(...parseJUnit(content))
      else if (!source.format || source.format === 'json-verdicts') tests.push(...parseJsonVerdicts(content))
      else throw new Error(`Unsupported test evidence format: ${source.format}`)
    }
    if (source.kind === 'coverage') {
      if (source.format === 'lcov') coverage.push(parseLcov(content))
      else if (source.format === 'istanbul') coverage.push(parseIstanbul(content))
      else if (source.format === 'units') coverage.push(parseUnitCoverage(content))
      else throw new Error('Coverage evidence requires an explicit LCOV, Istanbul or units format')
    }
  }
  const sortedTests = (values: VariantExecutionEvidence['tests']) =>
    [...values].sort((a, b) => a.testId.localeCompare(b.testId))
  if (!tests.length || canonical(sortedTests(tests)) !== canonical(sortedTests(evidence.execution.tests)))
    throw new Error(`Test declarations differ from verified sources: ${evidence.sampleId}`)
  if (evidence.execution.coverage) {
    // Repository collectors must merge shards before submitting a single coverage document.
    if (coverage.length !== 1) throw new Error('Coverage declaration requires exactly one merged source')
    const { fromCachedSeed: _cached, seedFingerprintValid: _valid, ...declared } = evidence.execution.coverage
    if (canonical(coverage[0]) !== canonical(declared))
      throw new Error('Coverage declaration differs from verified source')
  } else if (coverage.length) throw new Error('Coverage source has no corresponding declaration')
}

/** Validate the evidence files before deriving assessments; callers cannot submit only pass booleans. */
export async function verifyEvidenceBundle(params: {
  manifest: ExperimentManifest
  samples: SampleMeasurementResult[]
  evidence: SampleEvidence[]
  profiles: Record<string, { testResultReuseAllowed: boolean }>
  readSource: (path: string) => Promise<Uint8Array>
}): Promise<Record<string, BoundAssessment>> {
  const byId = new Map(params.evidence.map((e) => [e.sampleId, e]))
  if (byId.size !== params.evidence.length) throw new Error('Duplicate evidence sample')
  // Validate the complete bundle first: candidates must never compare against unchecked baselines.
  for (const evidence of params.evidence) await verifySourceMeaning(evidence, params.readSource)
  const assessments: Record<string, BoundAssessment> = {}
  for (const sample of countedSamples(params.samples)) {
    const evidence = byId.get(sample.sampleId)
    if (!evidence) throw new Error(`Missing evidence: ${sample.sampleId}`)
    const baselineVariant = sample.variant.startsWith('github-') ? 'github-baseline' : 'starsling-baseline'
    const baselineSample = countedSamples(params.samples).find(
      (s) =>
        s.scenarioName === sample.scenarioName &&
        s.profileName === sample.profileName &&
        s.repetition === sample.repetition &&
        s.variant === baselineVariant,
    )
    const baseline = baselineSample ? byId.get(baselineSample.sampleId) : undefined
    // Without the CI unchanged on the same runners there is nothing to compare with: the sample stays unassessed
    // (so no claim can use it) instead of failing every other sample's assessment.
    if (!baseline) continue
    const assessment = assessSample({
      manifest: params.manifest,
      sample,
      baseline,
      evidence,
      allowTestResultReuse: params.profiles[sample.profileName]?.testResultReuseAllowed ?? false,
    })
    if (!evidence.execution.coverage?.scopeHash || !baseline.execution.coverage?.scopeHash) {
      assessment.parity.satisfies01PpCoverageRequirement = false
      if (assessment.parity.evidenceLevel === 'coverage-qualified')
        assessment.parity.evidenceLevel = 'test/verdict parity'
    }
    assessments[sample.sampleId] = assessment
  }
  return assessments
}
