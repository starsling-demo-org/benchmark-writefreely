import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from '@actions/core'
import { loadInterference } from '../evidence-collect.ts'
import { VARIANTS } from '../manifest.ts'
import { loadReferences } from '../reference-files.ts'
import { type BenchmarkExperimentReport, generateExperimentReport } from '../reporter.ts'
import type { SampleMeasurementResult } from '../collector.ts'
import type { ScenarioReference } from '../reference.ts'
import {
  buildJobBreakdown,
  formatDuration,
  formatMinutes,
  formatMultiple,
  runLabel,
  scenarioLabel,
  VARIANT_LABELS,
  VARIANT_SHORT,
  vsGitHub,
  workflowName,
} from '../showcase-model.ts'
import type { BenchmarkConfig } from '../types.ts'

export interface ReportingActionInputPayload {
  assessments?: Parameters<typeof generateExperimentReport>[0]['assessments']
  manifest?: Parameters<typeof generateExperimentReport>[0]['manifest']
  parityByScenarioProfile?: Parameters<typeof generateExperimentReport>[0]['parityByScenarioProfile']
  cacheByScenarioProfile?: Parameters<typeof generateExperimentReport>[0]['cacheByScenarioProfile']
  references?: Record<string, ScenarioReference>
  /** Overlapping unrelated runs per sample; read from interference.json beside the input when absent. */
  interference?: Record<string, string[]>
  experimentId: string
  config: BenchmarkConfig
  samples: SampleMeasurementResult[]
  outputJsonPath?: string
  outputCsvPath?: string
  failOnIncompleteOrParityError?: boolean
}

/** Granular GitHub-vs-StarSling summary: pipeline totals, every job by runner label, then step detail. */
export function writeActionsSummary(report: BenchmarkExperimentReport, config: BenchmarkConfig): void {
  core.summary.addHeading(`StarSling whole-pipeline benchmark: ${report.upstreamRepository}`, 1)
  core.summary.addRaw(
    `<p>Experiment <code>${report.experimentId}</code>, upstream <code>${report.upstreamCommitSha.slice(0, 12)}</code>. CI duration = first workflow start to last job end across every workflow the event starts; CI minutes = sum of job runtimes. GitHub timestamps have 1 s resolution.</p>\n`,
  )
  for (const comp of report.comparisons) {
    const label = scenarioLabel(config, comp.scenarioName)
    core.summary.addHeading(`${label} · ${comp.profileName} cache`, 2)
    core.summary.addRaw(`<p><strong>${comp.headlineClaimText}</strong></p>\n`)
    const base = comp.variants['github-baseline']
    core.summary.addTable([
      [
        { data: 'Variant', header: true },
        { data: 'Complete / requested', header: true },
        { data: 'CI duration p50', header: true },
        { data: 'vs GitHub', header: true },
        { data: 'CI minutes p50', header: true },
        { data: 'vs GitHub', header: true },
        { data: 'Est. cost p50', header: true },
      ],
      ...VARIANTS.filter((v) => comp.variants[v].requestedSamples > 0).map((v) => {
        const vs = comp.variants[v]
        return [
          VARIANT_LABELS[v],
          `${vs.completeSamples}/${vs.requestedSamples}`,
          formatDuration(vs.wallClockSec.median),
          vsGitHub(v, base.wallClockSec.median, vs.wallClockSec.median),
          formatMinutes(vs.repoMinutes.median),
          vsGitHub(v, base.repoMinutes.median, vs.repoMinutes.median, 'fewer', 'more'),
          vs.billedUsd.median !== null ? `$${vs.billedUsd.median.toFixed(4)}` : '—',
        ]
      }),
    ])
    const parity = comp.upstreamParity
    core.summary.addRaw(
      `<p>Upstream parity: ${
        parity.baselineIncludesPatches?.length
          ? `not claimed (baseline is upstream + merged agent PRs: ${parity.baselineIncludesPatches.join(', ')})`
          : !parity.referenceAvailable
            ? 'no upstream reference run locked'
            : parity.passed
              ? `baseline replays match upstream runs ${parity.referenceRunUrls.map((u) => `<a href="${u}">${runLabel(u)}</a>`).join(', ')} (upstream CI duration ${formatDuration(parity.referenceWallClockSeconds)})`
              : `differs from upstream (${
                  parity.comparisons
                    .flatMap((c) => [...c.missingJobs, ...c.unexpectedJobs])
                    .slice(0, 5)
                    .join('; ') || 'no complete baseline sample'
                })`
      }</p>\n`,
    )
    const jobs = buildJobBreakdown(comp)
    if (jobs.length) {
      core.summary.addHeading('Jobs: GitHub-hosted label vs StarSling', 3)
      core.summary.addTable([
        [
          { data: 'Workflow › job', header: true },
          { data: 'GitHub label', header: true },
          { data: 'StarSling label', header: true },
          ...VARIANTS.map((v) => ({ data: VARIANT_SHORT[v], header: true })),
          { data: 'StarSling vs GitHub', header: true },
        ],
        ...jobs.map((row) => [
          `${workflowName(row.workflowPath)} › ${row.jobName}`,
          row.githubLabel ?? '—',
          row.starslingLabel ?? '—',
          ...VARIANTS.map((v) => formatDuration(row.medians[v])),
          formatMultiple(row.medians['github-baseline'], row.medians['starsling-baseline']) ?? '—',
        ]),
      ])
    }
    if (comp.stepAlignment.length) {
      const stepRows = comp.stepAlignment
        .map(
          (st) =>
            `<tr><td>${workflowName(st.workflowPath)} › ${st.jobId}</td><td>${st.stepName}</td><td>${st.changeKind}</td>${[
              st.githubBaselineMedianSec,
              st.githubPatchedMedianSec,
              st.starslingBaselineMedianSec,
              st.starslingPatchedMedianSec,
            ]
              .map((x) => `<td>${formatDuration(x)}</td>`)
              .join('')}</tr>`,
        )
        .join('')
      core.summary.addDetails(
        'Step timings (median, 1 s resolution)',
        `<table><tr><th>Job</th><th>Step</th><th>Change</th>${VARIANTS.map((v) => `<th>${VARIANT_SHORT[v]}</th>`).join('')}</tr>${stepRows}</table>`,
      )
    }
    for (const reason of comp.withheldReasons) core.warning(`[${comp.scenarioName}/${comp.profileName}] ${reason}`)
  }
}

export async function runReportingAction(payload: ReportingActionInputPayload): Promise<BenchmarkExperimentReport> {
  const report = generateExperimentReport({
    ...(payload.assessments ? { assessments: payload.assessments } : {}),
    ...(payload.manifest ? { manifest: payload.manifest } : {}),
    ...(payload.parityByScenarioProfile ? { parityByScenarioProfile: payload.parityByScenarioProfile } : {}),
    ...(payload.cacheByScenarioProfile ? { cacheByScenarioProfile: payload.cacheByScenarioProfile } : {}),
    ...(payload.references ? { references: payload.references } : {}),
    ...(payload.interference ? { interference: payload.interference } : {}),
    experimentId: payload.experimentId,
    config: payload.config,
    samples: payload.samples,
  })

  if (payload.outputJsonPath) {
    mkdirSync(dirname(payload.outputJsonPath), { recursive: true })
    writeFileSync(payload.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    core.setOutput('report-json-path', payload.outputJsonPath)
  }

  if (payload.outputCsvPath) {
    mkdirSync(dirname(payload.outputCsvPath), { recursive: true })
    writeFileSync(payload.outputCsvPath, report.csvContent, 'utf8')
    core.setOutput('report-csv-path', payload.outputCsvPath)
  }

  writeActionsSummary(report, payload.config)

  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary.write()
  }

  const allComplete =
    report.comparisons.length > 0 &&
    report.manifestIssues.length === 0 &&
    report.comparisons.every((c) => c.allRequestedSamplesComplete && c.parityPassed && c.cacheValidated)
  core.setOutput('complete', String(allComplete))
  core.setOutput('experiment-id', report.experimentId)

  if (!allComplete && (payload.failOnIncompleteOrParityError ?? true)) {
    core.setFailed('Benchmark experiment incomplete or parity gate failed — speedup claim withheld.')
  }

  return report
}

async function main(): Promise<void> {
  const inputFile = core.getInput('input-json') || process.env.BENCH_REPORT_INPUT_JSON
  if (!inputFile) return
  const absInput = resolve(inputFile)
  if (!existsSync(absInput)) {
    core.setFailed(`Reporting action input file not found: ${absInput}`)
    return
  }
  const raw = JSON.parse(readFileSync(absInput, 'utf8')) as ReportingActionInputPayload
  // Experiment records carry their identity in the manifest.
  if (!raw.experimentId && raw.manifest) raw.experimentId = raw.manifest.experimentId
  // The same interference the CLI's report and showcase exclude, so the summary's medians match the README.
  const interference = raw.interference ?? loadInterference(dirname(absInput))
  if (interference) raw.interference = interference
  const referenceDir = core.getInput('reference-dir') || process.env.BENCH_REFERENCE_DIR
  if (referenceDir && !raw.references) raw.references = loadReferences(resolve(referenceDir))
  const failOnWithheld = core.getInput('fail-on-withheld')
  if (failOnWithheld) raw.failOnIncompleteOrParityError = failOnWithheld !== 'false'
  await runReportingAction(raw)
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  void main().catch((error) => core.setFailed(error instanceof Error ? error.message : String(error)))
}
