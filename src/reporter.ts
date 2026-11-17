import { type ExperimentApiUsage, renderApiUsageMarkdown } from './api-budget.ts'
import { boundAssessment, type BoundAssessment } from './evidence.ts'
import {
  countedSamples,
  createExperimentManifest,
  reconcileSamples,
  type ExperimentManifest,
  VARIANTS,
} from './manifest.ts'
import type { CacheLifecycleValidationResult } from './cache-lifecycle.ts'
import type { ObservedRunnerMetadata, SampleMeasurementResult } from './collector.ts'
import type { ParityEvaluationResult } from './parity.ts'
import { assessUpstreamParity, type ScenarioReference, type UpstreamParity } from './reference.ts'
import {
  alignStepsAcrossVariants,
  assessCostNeutrality,
  type CostNeutralityAssessment,
  computeSampleBilledUsd,
  computeStats,
  type MetricSummaryStats,
  type StepAlignmentEntry,
  serializeSamplesToCsv,
} from './reporter-helpers.ts'
import { VARIANT_SHORT } from './showcase-model.ts'
import type { BenchmarkConfig, EvidenceLevel, VariantId } from './types.ts'

export interface VariantAggregateSummary {
  variant: VariantId
  requestedSamples: number
  completeSamples: number
  wallClockSec: MetricSummaryStats
  repoMinutes: MetricSummaryStats
  billedUsd: MetricSummaryStats
  triggerLatencySec: MetricSummaryStats
  harnessOverheadSec: MetricSummaryStats
  observedRunners: ObservedRunnerMetadata[]
}

export interface FourWayRatioSummary {
  /** github-baseline / github-patched (same-runner agent optimization on GitHub) */
  githubSameRunnerOptimizationRatio: number | null
  /** starsling-baseline / starsling-patched (same-runner agent optimization on StarSling) */
  starslingSameRunnerOptimizationRatio: number | null
  /** github-baseline / starsling-baseline (pure runner hardware impact — never qualifies as agent-only) */
  baselineCrossRunnerRatio: number | null
  /** github-patched / starsling-patched (patched cross-runner hardware ratio) */
  patchedCrossRunnerRatio: number | null
  /** github-baseline / starsling-patched (combined runner + agent impact) */
  combinedOptimizationRatio: number | null
}

export interface ScenarioProfileComparisonReport {
  scenarioName: string
  profileName: string
  requestedRepetitions: number
  isDiagnosticSingleRepetition: boolean
  completePairedRepetitions: number
  /** The rounds the medians use: every requested variant completed, with no interference. */
  pairedRepetitions: number[]
  allRequestedSamplesComplete: boolean
  parityPassed: boolean
  /** Every sample's cache/artifact assessment is bound and valid for its profile. */
  cacheValidated: boolean
  /** Samples excluded from pairs because unrelated workflow runs overlapped them. */
  interferedSamples: string[]
  evidenceLevel: EvidenceLevel
  mixedRunnerPipeline: boolean
  movedJobs: string[]
  retainedJobs: string[]
  publishableHeadlineAllowed: boolean
  headlineClaimText: string
  withheldReasons: string[]
  variants: Record<VariantId, VariantAggregateSummary>
  ratios: FourWayRatioSummary
  costNeutrality: {
    github: CostNeutralityAssessment
    starsling: CostNeutralityAssessment
  }
  cacheLifecycle?: CacheLifecycleValidationResult
  parityEvaluation?: ParityEvaluationResult
  /** This event and cache state's baseline replays compared with the upstream project's own runs. */
  upstreamParity: UpstreamParity
  stepAlignment: StepAlignmentEntry[]
  samples: SampleMeasurementResult[]
}

export interface BenchmarkExperimentReport {
  manifestIssues: string[]
  /** Samples the experiment manifest requested (all selected scenarios, profiles, variants, repetitions). */
  requestedSampleCount: number
  schemaVersion: 'benchmark-report.v1'
  experimentId: string
  /** The last observation in the record (or the render time, without one): the same record yields the same report. */
  generatedAt: string
  upstreamRepository: string
  upstreamCommitSha: string
  timestampResolution: '1s'
  comparisons: ScenarioProfileComparisonReport[]
  /** Per event, every baseline replay in any cache state compared with upstream: `bench parity` and the claim. */
  upstreamParityByScenario: Record<string, UpstreamParity>
  /** What the controller spent of the GitHub API on this experiment (absent in records from before it was counted). */
  apiUsage?: ExperimentApiUsage
  markdownSummary: string
  csvContent: string
}

/** When the record's last workflow finished; republishing an unchanged experiment then changes nothing. */
function lastObservation(samples: SampleMeasurementResult[]): string | undefined {
  return samples
    .flatMap((s) => s.workflows.map((w) => w.completedAt ?? ''))
    .filter(Boolean)
    .sort()
    .at(-1)
}

function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null
  return Number((numerator / denominator).toFixed(2))
}

function formatSec(sec: number | null, count?: number): string {
  if (sec === null) return '—'
  return count !== undefined ? `${sec.toFixed(1)} s (n=${count})` : `${sec.toFixed(1)} s`
}

function formatRatio(r: number | null): string {
  return r === null ? '—' : `${r.toFixed(2)}×`
}

export function generateExperimentReport(params: {
  assessments?: Record<string, BoundAssessment>
  manifest?: ExperimentManifest
  experimentId: string
  config: BenchmarkConfig
  samples: SampleMeasurementResult[]
  parityByScenarioProfile?: Record<string, ParityEvaluationResult>
  cacheByScenarioProfile?: Record<string, CacheLifecycleValidationResult>
  mixedRunnerByScenario?: Record<string, { mixedRunner: boolean; movedJobs: string[]; retainedJobs: string[] }>
  mergedStepMappings?: Record<string, string>
  /** Upstream reference snapshots keyed by scenario name (see `bench reference`). */
  references?: Record<string, ScenarioReference>
  /** Workflow runs outside a sample that overlapped its time window, keyed by sample ID (`bench evidence`). */
  interference?: Record<string, string[]>
  generatedAt?: string
  /** GitHub API calls the controller counted (from the experiment record). */
  apiUsage?: ExperimentApiUsage
}): BenchmarkExperimentReport {
  const {
    experimentId,
    config,
    samples,
    parityByScenarioProfile = {},
    cacheByScenarioProfile = {},
    mixedRunnerByScenario = {},
    mergedStepMappings,
    generatedAt,
  } = params

  const interferenceOf = (sampleId: string): string[] => params.interference?.[sampleId] ?? []
  const manifest = params.manifest ?? createExperimentManifest({ experimentId, config })
  const manifestIssues = reconcileSamples(manifest, samples)
  if (!params.manifest) manifestIssues.push('Explicit requested experiment manifest is required for claims')
  // Group samples by scenarioName::profileName
  const groups = new Map<string, SampleMeasurementResult[]>()
  for (const requested of manifest.samples) groups.set(`${requested.scenarioName}::${requested.profileName}`, [])
  for (const s of samples) {
    const key = `${s.scenarioName}::${s.profileName}`
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }

  const comparisons: ScenarioProfileComparisonReport[] = []

  for (const [groupKey, groupSamples] of groups.entries()) {
    const [scenarioName = 'default', profileName = 'cold'] = groupKey.split('::')
    // The manifest, not the configuration, says what this experiment requested.
    const requestedInGroup = manifest.samples.filter(
      (s) => s.scenarioName === scenarioName && s.profileName === profileName,
    )
    const requestedRepetitions = Math.max(0, ...requestedInGroup.map((s) => s.repetition))
    const requestedVariants = VARIANTS.filter((v) => requestedInGroup.some((s) => s.variant === v))
    const isDiagnosticSingleRepetition = requestedRepetitions < 5
    const samplesByVariant: Record<VariantId, SampleMeasurementResult[]> = {
      'github-baseline': [],
      'github-patched': [],
      'starsling-baseline': [],
      'starsling-patched': [],
    }
    // A replaced slot lists its counted (complete) sample first; failed attempts follow, excluded from the medians.
    groupSamples.sort((a, b) => Number(b.complete) - Number(a.complete))
    for (const s of groupSamples) {
      samplesByVariant[s.variant].push(s)
    }

    // Paired repetitions: only repetitions where every requested variant completed cleanly
    const completePairedRepNums: number[] = []
    for (let rep = 1; rep <= requestedRepetitions; rep++) {
      const allFourComplete = requestedVariants.every((v) =>
        samplesByVariant[v].some(
          (s) =>
            s.repetition === rep &&
            s.complete &&
            s.metrics.wallClockSeconds !== null &&
            !interferenceOf(s.sampleId).length,
        ),
      )
      if (allFourComplete) {
        completePairedRepNums.push(rep)
      }
    }

    const variantsSummary = {} as Record<VariantId, VariantAggregateSummary>
    for (const v of VARIANTS) {
      const vSamples = samplesByVariant[v]
      const pairedSamples = vSamples.filter((s) => completePairedRepNums.includes(s.repetition) && s.complete)
      const effectiveSamples = pairedSamples

      const wallClocks = effectiveSamples.map((s) => s.metrics.wallClockSeconds).filter((x): x is number => x !== null)
      const repoMins = effectiveSamples.map((s) => s.metrics.repoMinutes).filter((x): x is number => x !== null)
      const billedUsds = effectiveSamples
        .map((s) => computeSampleBilledUsd(s, config))
        .filter((x): x is number => x !== null)
      const latencies = effectiveSamples
        .map((s) => s.metrics.triggerLatencySeconds)
        .filter((x): x is number => x !== null)
      const overheads = effectiveSamples.map((s) => s.metrics.harnessOverheadSeconds)

      const observedRunners: ObservedRunnerMetadata[] = []
      for (const s of vSamples) {
        for (const wf of s.workflows) {
          for (const j of wf.jobs) {
            if (j.observedRunner) {
              observedRunners.push(j.observedRunner)
            }
          }
        }
      }

      variantsSummary[v] = {
        variant: v,
        // The manifest says which configurations were requested; one it left out has nothing outstanding.
        requestedSamples: requestedInGroup.filter((s) => s.variant === v).length,
        completeSamples: vSamples.filter((s) => s.complete).length,
        wallClockSec: computeStats(wallClocks),
        repoMinutes: computeStats(repoMins),
        billedUsd: computeStats(billedUsds),
        triggerLatencySec: computeStats(latencies),
        harnessOverheadSec: computeStats(overheads),
        observedRunners,
      }
    }

    const ghBaseMed = variantsSummary['github-baseline'].wallClockSec.median
    const ghPatMed = variantsSummary['github-patched'].wallClockSec.median
    const ssBaseMed = variantsSummary['starsling-baseline'].wallClockSec.median
    const ssPatMed = variantsSummary['starsling-patched'].wallClockSec.median

    const ratios: FourWayRatioSummary = {
      githubSameRunnerOptimizationRatio: safeRatio(ghBaseMed, ghPatMed),
      starslingSameRunnerOptimizationRatio: safeRatio(ssBaseMed, ssPatMed),
      baselineCrossRunnerRatio: safeRatio(ghBaseMed, ssBaseMed),
      patchedCrossRunnerRatio: safeRatio(ghPatMed, ssPatMed),
      combinedOptimizationRatio: safeRatio(ghBaseMed, ssPatMed),
    }

    const costNeutrality = {
      github: assessCostNeutrality({
        provider: 'github',
        baselineSamples: samplesByVariant['github-baseline'],
        patchedSamples: samplesByVariant['github-patched'],
        config,
      }),
      starsling: assessCostNeutrality({
        provider: 'starsling',
        baselineSamples: samplesByVariant['starsling-baseline'],
        patchedSamples: samplesByVariant['starsling-patched'],
        config,
      }),
    }

    const parityEval = parityByScenarioProfile[groupKey]
    const cacheEval = cacheByScenarioProfile[groupKey]
    const mixedInfo = mixedRunnerByScenario[scenarioName] ?? {
      mixedRunner: false,
      movedJobs: [],
      retainedJobs: [],
    }

    const allRequestedSamplesComplete = completePairedRepNums.length === requestedRepetitions
    const bound = countedSamples(groupSamples).map((sample) =>
      boundAssessment(params.assessments?.[sample.sampleId], sample, manifest),
    )
    const boundComplete = groupSamples.length > 0 && bound.every((a) => a !== undefined)
    const parityPassed = boundComplete && bound.every((a) => a?.parity.passed === true)
    const cacheValid = boundComplete && bound.every((a) => a?.cache.valid === true)
    const evidenceLevel: EvidenceLevel = parityPassed
      ? bound.every((a) => a?.parity.evidenceLevel === 'coverage-qualified')
        ? 'coverage-qualified'
        : 'test/verdict parity'
      : 'timing-only'

    const baselinePatchIds = config.patches.filter((p) => p.inBaseline).map((p) => p.id)
    const upstreamParity = assessUpstreamParity(params.references?.[scenarioName], groupSamples, baselinePatchIds)

    const withheldReasons: string[] = [...manifestIssues]
    const interferedSamples = groupSamples.filter((sample) => interferenceOf(sample.sampleId).length)
    for (const sample of interferedSamples)
      withheldReasons.push(
        `Sample ${sample.sampleId} overlapped unrelated workflow runs (${interferenceOf(sample.sampleId).join(', ')}) and is excluded from the medians.`,
      )
    // A stacked baseline (upstream + merged agent PRs) is not upstream's own CI, so "same CI as upstream" is not
    // claimed for it and does not gate the speedup claim: the comparison that matters is baseline vs patched.
    if (!baselinePatchIds.length) {
      if (!upstreamParity.referenceAvailable)
        withheldReasons.push('No upstream run is locked for this event, so same CI as upstream is unverified.')
      else if (!upstreamParity.passed)
        withheldReasons.push(
          upstreamParity.comparisons.length
            ? 'The replay with the CI unchanged ran different jobs from the upstream run (see Same CI as upstream).'
            : 'No complete replay with the CI unchanged to compare with the upstream run.',
        )
    }
    if (!boundComplete)
      withheldReasons.push('Test, coverage and cache evidence is not yet verified for every sample (`bench verify`).')
    if (!parityPassed || !cacheValid) {
      for (const assessment of Object.values(costNeutrality)) {
        assessment.qualifiesAsCostNeutralAgentOptimization = false
        assessment.disqualificationReasons.push('Validated parity and cache evidence required')
      }
    }
    if (!allRequestedSamplesComplete) {
      withheldReasons.push(`Incomplete rounds (${completePairedRepNums.length} of ${requestedRepetitions} complete).`)
    }
    if (isDiagnosticSingleRepetition) {
      withheldReasons.push(
        `Diagnostic run: ${requestedRepetitions} round${requestedRepetitions === 1 ? '' : 's'}; a claim needs at least 5.`,
      )
    }
    if (!parityPassed) {
      withheldReasons.push('Same tests and same verdicts are not verified for every sample.')
    }
    if (!cacheValid) {
      withheldReasons.push(
        'Cache state is not verified for every sample, or a cache from outside the sample was restored.',
      )
    }

    const publishableHeadlineAllowed = withheldReasons.length === 0
    const headlineClaimText = publishableHeadlineAllowed
      ? `Total speedup ${formatRatio(ratios.combinedOptimizationRatio)}: hardware speedup ${formatRatio(ratios.baselineCrossRunnerRatio)}, self-improving CI speedup ${formatRatio(ratios.starslingSameRunnerOptimizationRatio)} on StarSling Runners and ${formatRatio(ratios.githubSameRunnerOptimizationRatio)} on GitHub-hosted runners. Evidence: ${evidenceLevel}.`
      : `No speedup claim yet: ${withheldReasons.join(' ')}`

    const stepAlignment = alignStepsAcrossVariants(samplesByVariant, mergedStepMappings)

    comparisons.push({
      scenarioName,
      profileName,
      requestedRepetitions,
      isDiagnosticSingleRepetition,
      completePairedRepetitions: completePairedRepNums.length,
      pairedRepetitions: completePairedRepNums,
      allRequestedSamplesComplete,
      parityPassed,
      cacheValidated: cacheValid,
      interferedSamples: interferedSamples.map((sample) => sample.sampleId),
      evidenceLevel,
      mixedRunnerPipeline: mixedInfo.mixedRunner,
      movedJobs: mixedInfo.movedJobs,
      retainedJobs: mixedInfo.retainedJobs,
      publishableHeadlineAllowed,
      headlineClaimText,
      withheldReasons,
      variants: variantsSummary,
      ratios,
      costNeutrality,
      ...(cacheEval ? { cacheLifecycle: cacheEval } : {}),
      ...(parityEval ? { parityEvaluation: parityEval } : {}),
      upstreamParity,
      stepAlignment,
      samples: groupSamples,
    })
  }

  const markdownSummary = [
    renderMarkdownReport({ experimentId, config, comparisons }),
    ...(params.apiUsage ? ['', ...renderApiUsageMarkdown(params.apiUsage)] : []),
  ].join('\n')
  const csvContent = serializeSamplesToCsv(samples, config)

  return {
    schemaVersion: 'benchmark-report.v1',
    manifestIssues,
    requestedSampleCount: manifest.samples.length,
    experimentId,
    generatedAt: generatedAt ?? lastObservation(samples) ?? new Date().toISOString(),
    upstreamRepository: config.upstream.repository,
    upstreamCommitSha: config.upstream.commitSha,
    timestampResolution: '1s',
    comparisons,
    upstreamParityByScenario: Object.fromEntries(
      [...new Set(comparisons.map((c) => c.scenarioName))].map((name) => [
        name,
        assessUpstreamParity(
          params.references?.[name],
          samples.filter((s) => s.scenarioName === name),
          config.patches.filter((p) => p.inBaseline).map((p) => p.id),
        ),
      ]),
    ),
    ...(params.apiUsage ? { apiUsage: params.apiUsage } : {}),
    markdownSummary,
    csvContent,
  }
}

export function renderMarkdownReport(params: {
  experimentId: string
  config: BenchmarkConfig
  comparisons: ScenarioProfileComparisonReport[]
}): string {
  const { experimentId, config, comparisons } = params
  const lines: string[] = [
    `# StarSling Whole-Pipeline Benchmark Report (\`${experimentId}\`)`,
    '',
    `- **Upstream:** \`${config.upstream.repository}@${config.upstream.commitSha}\``,
    `- **Timestamp Resolution:** \`1s\` (GitHub Actions workflow/job/step timestamps)`,
    '',
  ]

  for (const comp of comparisons) {
    lines.push(
      `## Event \`${comp.scenarioName}\` · ${comp.profileName} cache${comp.mixedRunnerPipeline ? ' · some jobs kept on GitHub-hosted runners' : ''}`,
      '',
      `**${comp.headlineClaimText}**`,
      '',
    )

    if (comp.mixedRunnerPipeline) {
      lines.push(
        `> **Jobs kept on GitHub-hosted runners:** \`${comp.retainedJobs.join(', ')}\`. Moved to StarSling Runners: \`${comp.movedJobs.join(', ')}\`.`,
        '',
      )
    }

    lines.push(
      '### Runner configurations',
      '',
      '| Runner configuration | Complete / requested | CI duration p50 (IQR) | CI minutes p50 | Estimated cost p50 (USD) | Trigger latency p50 | Harness overhead p50 |',
      '|---|---|---|---|---|---|---|',
    )

    for (const v of VARIANTS.filter((variant) => comp.variants[variant].requestedSamples > 0)) {
      const vs = comp.variants[v]
      const wcStr =
        vs.wallClockSec.median !== null
          ? `${vs.wallClockSec.median.toFixed(1)} s (IQR ${(vs.wallClockSec.iqr ?? 0).toFixed(1)} s, n=${vs.wallClockSec.count})`
          : '—'
      const rmStr = vs.repoMinutes.median !== null ? `${vs.repoMinutes.median.toFixed(2)} min` : '—'
      const billStr = vs.billedUsd.median !== null ? `$${vs.billedUsd.median.toFixed(4)}` : '—'
      lines.push(
        `| \`${v}\` | ${vs.completeSamples}/${vs.requestedSamples} | ${wcStr} | ${rmStr} | ${billStr} | ${formatSec(vs.triggerLatencySec.median)} | ${formatSec(vs.harnessOverheadSec.median)} |`,
      )
    }

    lines.push(
      '',
      '### Speedups',
      '',
      '| Speedup | Ratio | Compares | Cost neutral |',
      '|---|---|---|---|',
      `| \`github-baseline\` / \`github-patched\` | ${formatRatio(comp.ratios.githubSameRunnerOptimizationRatio)} | Self-improving CI speedup, GitHub-hosted runners | ${comp.costNeutrality.github.qualifiesAsCostNeutralAgentOptimization ? 'Yes' : `Not established (${comp.costNeutrality.github.disqualificationReasons.join('; ') || 'incomplete'})`} |`,
      `| \`starsling-baseline\` / \`starsling-patched\` | ${formatRatio(comp.ratios.starslingSameRunnerOptimizationRatio)} | Self-improving CI speedup, StarSling Runners | ${comp.costNeutrality.starsling.qualifiesAsCostNeutralAgentOptimization ? 'Yes' : `Not established (${comp.costNeutrality.starsling.disqualificationReasons.join('; ') || 'incomplete'})`} |`,
      `| \`github-baseline\` / \`starsling-baseline\` | ${formatRatio(comp.ratios.baselineCrossRunnerRatio)} | Hardware speedup | Not applicable: hardware speedups never establish it |`,
      `| \`github-baseline\` / \`starsling-patched\` | ${formatRatio(comp.ratios.combinedOptimizationRatio)} | Total speedup | Not applicable |`,
      '',
    )

    if (comp.cacheLifecycle) {
      const cb = comp.cacheLifecycle.costBreakdown
      lines.push(
        '### Cache provenance',
        '',
        `- **Mode:** \`${comp.cacheLifecycle.mode}\` (Valid: \`${comp.cacheLifecycle.valid}\`, Contaminated: \`${comp.cacheLifecycle.contaminated}\`)`,
        `- **Cold Population Cost:** \`${cb.coldPopulationSeconds.toFixed(1)} s\` • **Cold Save Cost:** \`${cb.coldSaveSeconds.toFixed(1)} s\``,
        `- **Warm Consumer Cost:** \`${cb.warmConsumerSeconds.toFixed(1)} s\`${cb.amortizedTotalSeconds !== null ? ` • **Amortized Total (${cb.amortizationHorizonRuns} runs):** \`${cb.amortizedTotalSeconds.toFixed(1)} s\`` : ''}`,
        '',
      )
    }

    lines.push(
      '### Step times',
      '',
      `| Workflow › job | Step | Change | ${VARIANTS.map((v) => `${VARIANT_SHORT[v]} p50`).join(' | ')} |`,
      '|---|---|---|---|---|---|---|',
    )
    for (const st of comp.stepAlignment) {
      lines.push(
        `| \`${st.workflowPath}#${st.jobId}\` | ${st.stepName} | \`${st.changeKind}\` | ${formatSec(st.githubBaselineMedianSec)} | ${formatSec(st.githubPatchedMedianSec)} | ${formatSec(st.starslingBaselineMedianSec)} | ${formatSec(st.starslingPatchedMedianSec)} |`,
      )
    }
    lines.push('')

    lines.push(
      '### Samples',
      '',
      '| Sample ID | Round | Runner configuration | Complete | CI duration | CI minutes | Runs and diagnostics |',
      '|---|---|---|---|---|---|---|',
    )
    for (const s of comp.samples) {
      const links = s.workflows.map((w) => `[run #${w.runId}](${w.htmlUrl})`).join(', ')
      const diag = s.incompleteReasons.length > 0 ? ` (${s.incompleteReasons.join('; ')})` : ''
      lines.push(
        `| \`${s.sampleId}\` | ${s.repetition} | \`${s.variant}\` | ${s.complete ? '✓' : '✗'} | ${formatSec(s.metrics.wallClockSeconds)} | ${s.metrics.repoMinutes !== null ? `${s.metrics.repoMinutes.toFixed(2)}m` : '—'} | ${links || 'no runs'}${diag} |`,
      )
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
