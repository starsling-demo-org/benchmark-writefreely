import type { SampleMeasurementResult } from './collector.ts'
import { VARIANTS } from './manifest.ts'
import type { BenchmarkConfig, VariantId } from './types.ts'

export interface MetricSummaryStats {
  count: number
  median: number | null
  min: number | null
  max: number | null
  iqr: number | null
}

export interface StepAlignmentEntry {
  workflowPath: string
  jobId: string
  stepName: string
  changeKind: 'matched' | 'added' | 'removed' | 'merged' | 'unmatched'
  githubBaselineMedianSec: number | null
  githubPatchedMedianSec: number | null
  starslingBaselineMedianSec: number | null
  starslingPatchedMedianSec: number | null
}

export interface CostNeutralityAssessment {
  provider: 'github' | 'starsling'
  qualifiesAsCostNeutralAgentOptimization: boolean
  sameRunnerMapping: boolean
  additionalShardsSpentSavings: boolean
  baselineMaxJobInstances: number
  patchedMaxJobInstances: number
  baselineMedianRawMinutes: number | null
  patchedMedianRawMinutes: number | null
  baselineMedianBilledUsd: number | null
  patchedMedianBilledUsd: number | null
  disqualificationReasons: string[]
}

export function computeStats(values: number[]): MetricSummaryStats {
  if (values.length === 0) {
    return { count: 0, median: null, min: null, max: null, iqr: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mid = Math.floor(n / 2)
  const median =
    n % 2 === 1 ? (sorted[mid] ?? 0) : Number((((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2).toFixed(4))
  const q1 = sorted[Math.floor((n - 1) * 0.25)] ?? sorted[0] ?? 0
  const q3 = sorted[Math.floor((n - 1) * 0.75)] ?? sorted[n - 1] ?? 0
  return {
    count: n,
    median: Number(median.toFixed(4)),
    min: Number((sorted[0] ?? 0).toFixed(4)),
    max: Number((sorted[n - 1] ?? 0).toFixed(4)),
    iqr: Number((q3 - q1).toFixed(4)),
  }
}

export function computeSampleBilledUsd(sample: SampleMeasurementResult, config: BenchmarkConfig): number | null {
  if (!sample.complete || sample.metrics.repoMinutes === null) return null
  let totalUsd = 0
  for (const wf of sample.workflows) {
    for (const job of wf.jobs) {
      if (job.durationSeconds === null || job.conclusion === 'skipped') continue
      const specs = job.labels
        .map((label) => config.runnerMapping.runnerSpecs[label])
        .filter((spec) => spec !== undefined)
      if (specs.length !== 1) return null
      const spec = specs[0]
      if (!spec) return null
      // Only explicitly identified standard hosted labels receive public-repository free billing.
      if (
        config.execution.publicRepoGitHubFree &&
        spec.provider === 'github' &&
        /^(ubuntu-(24\.04|26\.04|slim)|macos-latest|windows-latest)$/.test(spec.label)
      )
        continue
      if (!Number.isFinite(spec.billingPerMinuteUsd)) return null
      totalUsd += Math.ceil(job.durationSeconds / 60) * spec.billingPerMinuteUsd
    }
  }

  return Number(totalUsd.toFixed(6))
}

export function assessCostNeutrality(params: {
  provider: 'github' | 'starsling'
  baselineSamples: SampleMeasurementResult[]
  patchedSamples: SampleMeasurementResult[]
  config: BenchmarkConfig
}): CostNeutralityAssessment {
  const { provider, baselineSamples, patchedSamples, config } = params
  const completeBase = baselineSamples.filter((s) => s.complete && s.metrics.repoMinutes !== null)
  const completePat = patchedSamples.filter((s) => s.complete && s.metrics.repoMinutes !== null)

  const baseRawMins = completeBase.map((s) => s.metrics.repoMinutes ?? 0)
  const patRawMins = completePat.map((s) => s.metrics.repoMinutes ?? 0)
  const baseBilled = completeBase.map((s) => computeSampleBilledUsd(s, config)).filter((v): v is number => v !== null)
  const patBilled = completePat.map((s) => computeSampleBilledUsd(s, config)).filter((v): v is number => v !== null)

  const baseStats = computeStats(baseRawMins)
  const patStats = computeStats(patRawMins)
  const baseBilledStats = computeStats(baseBilled)
  const patBilledStats = computeStats(patBilled)

  const countActiveJobs = (s: SampleMeasurementResult) =>
    s.workflows.reduce((acc, wf) => acc + wf.jobs.filter((j) => j.conclusion !== 'skipped').length, 0)

  const baselineMaxJobInstances = Math.max(0, ...completeBase.map(countActiveJobs))
  const patchedMaxJobInstances = Math.max(0, ...completePat.map(countActiveJobs))

  const hardwareByWorkload = (samples: SampleMeasurementResult[]) => {
    const result = new Map<string, string>()
    for (const sample of samples)
      for (const wf of sample.workflows)
        for (const job of wf.jobs) {
          const key = `${wf.workflowPath}#${job.logicalJobId}`
          const labels = [...job.labels].sort().join(',')
          if (result.has(key) && result.get(key) !== labels) result.set(key, 'drift')
          else result.set(key, labels)
        }
    return result
  }
  const baselineHardware = hardwareByWorkload(completeBase)
  const patchedHardware = hardwareByWorkload(completePat)
  const sameRunnerMapping =
    baselineHardware.size > 0 &&
    patchedHardware.size > 0 &&
    [...patchedHardware].every(([key, value]) => value !== 'drift' && baselineHardware.get(key) === value)

  const disqualificationReasons: string[] = []
  if (!sameRunnerMapping) {
    disqualificationReasons.push(
      'Self-improving CI changed which runners jobs use, so its speedup includes a hardware change.',
    )
  }

  // Added instances need an optimized unsharded control before cost neutrality is proven.
  const additionalShardsSpentSavings = patchedMaxJobInstances > baselineMaxJobInstances
  if (additionalShardsSpentSavings)
    disqualificationReasons.push('The agent PRs add parallel jobs; cost neutrality needs an unsharded control.')

  if (baseStats.median !== null && patStats.median !== null && patStats.median > baseStats.median) {
    disqualificationReasons.push(
      `Self-improving CI used more CI minutes (${patStats.median.toFixed(2)}) than the unchanged CI (${baseStats.median.toFixed(2)}).`,
    )
  }

  return {
    provider,
    qualifiesAsCostNeutralAgentOptimization:
      disqualificationReasons.length === 0 && completeBase.length > 0 && completePat.length > 0,
    sameRunnerMapping,
    additionalShardsSpentSavings,
    baselineMaxJobInstances,
    patchedMaxJobInstances,
    baselineMedianRawMinutes: baseStats.median,
    patchedMedianRawMinutes: patStats.median,
    baselineMedianBilledUsd: baseBilledStats.median,
    patchedMedianBilledUsd: patBilledStats.median,
    disqualificationReasons,
  }
}

export function alignStepsAcrossVariants(
  samplesByVariant: Record<VariantId, SampleMeasurementResult[]>,
  mergedStepMappings?: Record<string, string>,
): StepAlignmentEntry[] {
  const stepDurations = new Map<
    string,
    {
      workflowPath: string
      jobId: string
      stepName: string
      byVariant: Record<VariantId, number[]>
    }
  >()

  for (const variant of VARIANTS) {
    for (const sample of samplesByVariant[variant] ?? []) {
      if (!sample.complete) continue
      for (const wf of sample.workflows) {
        for (const job of wf.jobs) {
          for (const st of job.steps) {
            if (st.durationSeconds === null) continue
            const key = `${wf.workflowPath}::${job.logicalJobId}::${st.name}`
            let entry = stepDurations.get(key)
            if (!entry) {
              entry = {
                workflowPath: wf.workflowPath,
                jobId: job.logicalJobId,
                stepName: st.name,
                byVariant: {
                  'github-baseline': [],
                  'github-patched': [],
                  'starsling-baseline': [],
                  'starsling-patched': [],
                },
              }
              stepDurations.set(key, entry)
            }
            entry.byVariant[variant].push(st.durationSeconds)
          }
        }
      }
    }
  }

  const results: StepAlignmentEntry[] = []
  for (const [key, entry] of stepDurations.entries()) {
    const inBase = entry.byVariant['github-baseline'].length > 0 || entry.byVariant['starsling-baseline'].length > 0
    const inPat = entry.byVariant['github-patched'].length > 0 || entry.byVariant['starsling-patched'].length > 0

    let changeKind: StepAlignmentEntry['changeKind'] = 'matched'
    if (mergedStepMappings?.[key] || mergedStepMappings?.[entry.stepName]) {
      changeKind = 'merged'
    } else if (inBase && !inPat) {
      changeKind = 'removed'
    } else if (!inBase && inPat) {
      changeKind = 'added'
    }

    results.push({
      workflowPath: entry.workflowPath,
      jobId: entry.jobId,
      stepName: entry.stepName,
      changeKind,
      githubBaselineMedianSec: computeStats(entry.byVariant['github-baseline']).median,
      githubPatchedMedianSec: computeStats(entry.byVariant['github-patched']).median,
      starslingBaselineMedianSec: computeStats(entry.byVariant['starsling-baseline']).median,
      starslingPatchedMedianSec: computeStats(entry.byVariant['starsling-patched']).median,
    })
  }

  return results
}

export function serializeSamplesToCsv(samples: SampleMeasurementResult[], config: BenchmarkConfig): string {
  const header = [
    'sample_id',
    'repetition',
    'scenario',
    'profile',
    'variant',
    'complete',
    'wall_clock_sec',
    'repo_minutes',
    'raw_runner_sec',
    'billed_usd',
    'trigger_latency_sec',
    'harness_overhead_sec',
    'incomplete_reasons',
  ].join(',')

  const rows = samples.map((s) => {
    const billed = computeSampleBilledUsd(s, config)
    const reasons = s.incompleteReasons.join('; ').replace(/"/g, '""')
    return [
      s.sampleId,
      s.repetition,
      s.scenarioName,
      s.profileName,
      s.variant,
      s.complete,
      s.metrics.wallClockSeconds ?? '',
      s.metrics.repoMinutes ?? '',
      s.metrics.rawRunnerSeconds ?? '',
      billed ?? '',
      s.metrics.triggerLatencySeconds ?? '',
      s.metrics.harnessOverheadSeconds,
      `"${reasons}"`,
    ].join(',')
  })

  return `${[header, ...rows].join('\n')}\n`
}
