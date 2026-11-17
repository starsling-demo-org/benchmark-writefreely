/**
 * Upstream reference runs: what the public project's own GitHub Actions actually ran for a scenario's commit.
 *
 * A replay reaches CI parity when its baseline variants run the same workflows and jobs, with the same
 * conclusions, as the upstream reference. Step lists are reported but do not gate parity, because cache
 * state legitimately changes which steps run (for example `if: steps.cache.outputs.cache-hit != 'true'`).
 */
import { diffSecondsWhole, type SampleMeasurementResult } from './collector.ts'
import { isPullRequestEvent } from './config.ts'
import { array, type GitHubReader, nullableString as str, object } from './github.ts'
import type { ReferenceRunSpec, ScenarioConfig } from './types.ts'

export interface ReferenceStep {
  number: number
  name: string
  conclusion: string | null
  durationSeconds: number | null
}

export interface ReferenceJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  durationSeconds: number | null
  labels: string[]
  steps: ReferenceStep[]
}

export interface ReferenceRun {
  runId: number
  attempt: number
  workflowPath: string
  workflowName: string
  event: string
  status: string
  conclusion: string | null
  htmlUrl: string
  createdAt: string
  startedAt: string | null
  jobs: ReferenceJob[]
}

export interface ScenarioReference {
  schemaVersion: 1
  scenarioName: string
  upstreamRepository: string
  event: string
  headSha: string
  retrievedAt: string
  runs: ReferenceRun[]
  metrics: { wallClockSeconds: number | null; runnerSeconds: number | null }
}

export interface ReferenceComparison {
  scenarioName: string
  sampleId: string
  variant: string
  passed: boolean
  referenceRunIds: number[]
  missingWorkflows: string[]
  unexpectedWorkflows: string[]
  missingJobs: string[]
  unexpectedJobs: string[]
  conclusionMismatches: { job: string; reference: string; replay: string }[]
  /** Informational: executed-step differences for jobs present on both sides. */
  stepDifferences: { job: string; missing: string[]; unexpected: string[] }[]
  referenceWallClockSeconds: number | null
  replayWallClockSeconds: number | null
}

function normalizeRun(raw: unknown): Omit<ReferenceRun, 'jobs'> {
  const r = object(raw)
  return {
    runId: Number(r.id),
    attempt: Number(r.run_attempt ?? 1),
    workflowPath: String(r.path ?? '').split('@')[0] ?? '',
    workflowName: String(r.name ?? ''),
    event: String(r.event),
    status: String(r.status),
    conclusion: str(r.conclusion),
    htmlUrl: String(r.html_url ?? ''),
    createdAt: String(r.created_at),
    startedAt: str(r.run_started_at),
  }
}

function normalizeJob(raw: unknown): ReferenceJob {
  const j = object(raw)
  const startedAt = str(j.started_at)
  const completedAt = str(j.completed_at)
  return {
    id: Number(j.id),
    name: String(j.name),
    status: String(j.status),
    conclusion: str(j.conclusion),
    startedAt,
    completedAt,
    durationSeconds: j.conclusion === 'skipped' ? 0 : diffSecondsWhole(startedAt, completedAt),
    labels: array(j.labels ?? []).map(String),
    steps: array(j.steps ?? []).map((rawStep) => {
      const s = object(rawStep)
      return {
        number: Number(s.number),
        name: String(s.name),
        conclusion: str(s.conclusion),
        durationSeconds: s.conclusion === 'skipped' ? 0 : diffSecondsWhole(str(s.started_at), str(s.completed_at)),
      }
    }),
  }
}

/** Head SHA and branch whose upstream runs represent the scenario. */
export function scenarioReferenceTarget(scenario: ScenarioConfig): { headSha: string; branch?: string } {
  if (scenario.pr) return { headSha: scenario.pr.headSha }
  if (scenario.main) return { headSha: scenario.main.afterSha, branch: scenario.main.branch }
  throw new Error(`Scenario ${scenario.name} has no locked commit context`)
}

/**
 * Choose the upstream runs a scenario's event started: direct runs of the scenario event (earliest run per
 * workflow, which is the run the push itself caused) plus `workflow_run` listeners on the same head commit.
 */
export function selectReferenceRuns(
  runs: Omit<ReferenceRun, 'jobs'>[],
  scenario: ScenarioConfig,
  headBranch?: (runId: number) => string | undefined,
): Omit<ReferenceRun, 'jobs'>[] {
  const target = scenarioReferenceTarget(scenario)
  const direct = new Map<string, Omit<ReferenceRun, 'jobs'>>()
  const downstream: Omit<ReferenceRun, 'jobs'>[] = []
  for (const run of runs) {
    if (run.workflowPath.startsWith('dynamic/')) continue
    const matchesEvent = isPullRequestEvent(scenario.event)
      ? isPullRequestEvent(run.event)
      : run.event === scenario.event
    if (matchesEvent) {
      if (target.branch && headBranch && headBranch(run.runId) !== target.branch) continue
      const existing = direct.get(run.workflowPath)
      if (!existing || Date.parse(run.createdAt) < Date.parse(existing.createdAt)) direct.set(run.workflowPath, run)
    } else if (run.event === 'workflow_run') downstream.push(run)
  }
  return [...direct.values(), ...downstream].sort((a, b) => a.runId - b.runId)
}

function referenceMetrics(runs: ReferenceRun[]): ScenarioReference['metrics'] {
  let start: number | null = null
  let end: number | null = null
  let runnerSeconds = 0
  let partial = false
  for (const run of runs) {
    const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN
    if (!Number.isNaN(started)) start = start === null ? started : Math.min(start, started)
    for (const job of run.jobs) {
      if (job.conclusion === 'skipped') continue
      if (job.durationSeconds === null) partial = true
      else runnerSeconds += job.durationSeconds
      const completed = job.completedAt ? Date.parse(job.completedAt) : Number.NaN
      if (!Number.isNaN(completed)) end = end === null ? completed : Math.max(end, completed)
    }
  }
  return {
    wallClockSeconds: start !== null && end !== null ? Math.max(0, Math.round((end - start) / 1000)) : null,
    runnerSeconds: partial ? null : runnerSeconds,
  }
}

async function withJobs(client: GitHubReader, run: Omit<ReferenceRun, 'jobs'>): Promise<ReferenceRun> {
  const jobs = await client.all(`actions/runs/${run.runId}/attempts/${run.attempt}/jobs`, 'jobs')
  return { ...run, jobs: jobs.map(normalizeJob) }
}

/** Discover the upstream runs for a scenario's commit (used by `bench init` before reference runs are locked). */
export async function discoverReferenceRuns(
  client: GitHubReader,
  scenario: ScenarioConfig,
): Promise<ReferenceRunSpec[]> {
  const target = scenarioReferenceTarget(scenario)
  const raw = await client.all(`actions/runs?head_sha=${target.headSha}`, 'workflow_runs')
  const branches = new Map(raw.map((r) => [Number(object(r).id), String(object(r).head_branch)]))
  return selectReferenceRuns(raw.map(normalizeRun), scenario, (id) => branches.get(id)).map((run) => ({
    workflowPath: run.workflowPath,
    runId: run.runId,
    attempt: run.attempt,
    htmlUrl: run.htmlUrl,
  }))
}

/** Fetch the locked reference runs (immutable run IDs and attempts) with their jobs and steps. */
export async function fetchScenarioReference(params: {
  client: GitHubReader
  upstreamRepository: string
  scenario: ScenarioConfig
  retrievedAt?: string
}): Promise<ScenarioReference> {
  const { client, scenario } = params
  if (!scenario.referenceRuns.length)
    throw new Error(`Scenario ${scenario.name} has no locked upstream reference runs; run bench init or add them`)
  const runs: ReferenceRun[] = []
  for (const spec of scenario.referenceRuns) {
    const meta = normalizeRun(await client.request(`actions/runs/${spec.runId}`))
    const attempt = spec.attempt ?? meta.attempt
    if (meta.workflowPath !== spec.workflowPath)
      throw new Error(`Reference run ${spec.runId} is ${meta.workflowPath}, not ${spec.workflowPath}`)
    runs.push(await withJobs(client, { ...meta, attempt }))
  }
  return {
    schemaVersion: 1,
    scenarioName: scenario.name,
    upstreamRepository: params.upstreamRepository,
    event: scenario.event,
    headSha: scenarioReferenceTarget(scenario).headSha,
    retrievedAt: params.retrievedAt ?? new Date().toISOString(),
    runs,
    metrics: referenceMetrics(runs),
  }
}

function countBy(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

function multisetDifference(left: string[], right: string[]): string[] {
  const remaining = countBy(right)
  const missing: string[] = []
  for (const key of left) {
    const count = remaining.get(key) ?? 0
    if (count > 0) remaining.set(key, count - 1)
    else missing.push(key)
  }
  return missing
}

const jobKey = (workflowPath: string, name: string) => `${workflowPath} › ${name}`

/** Steps a self-hosted runner adds to every job (StarSling's lifecycle); not part of the workflow upstream ran. */
const RUNNER_LIFECYCLE_STEPS = new Set(['Set up runner', 'Complete runner'])

/** Compare one replay sample with the upstream reference for its scenario. */
export function compareWithReference(
  reference: ScenarioReference,
  sample: SampleMeasurementResult,
): ReferenceComparison {
  const refPaths = [...new Set(reference.runs.map((r) => r.workflowPath))].sort()
  const replayPaths = [...new Set(sample.workflows.map((w) => w.workflowPath))].sort()
  const refJobs = reference.runs.flatMap((run) =>
    run.jobs.map((job) => ({ key: jobKey(run.workflowPath, job.name), job })),
  )
  const replayJobs = sample.workflows.flatMap((wf) =>
    wf.jobs.map((job) => ({ key: jobKey(wf.workflowPath, job.jobName), job })),
  )
  const refExecuted = refJobs.filter((j) => j.job.conclusion !== 'skipped')
  const replayExecuted = replayJobs.filter((j) => j.job.conclusion !== 'skipped')
  const missingJobs = multisetDifference(
    refExecuted.map((j) => j.key),
    replayExecuted.map((j) => j.key),
  )
  const unexpectedJobs = multisetDifference(
    replayExecuted.map((j) => j.key),
    refExecuted.map((j) => j.key),
  )
  const conclusionMismatches: ReferenceComparison['conclusionMismatches'] = []
  const stepDifferences: ReferenceComparison['stepDifferences'] = []
  const replayByKey = new Map<string, (typeof replayExecuted)[number][]>()
  for (const entry of replayExecuted) replayByKey.set(entry.key, [...(replayByKey.get(entry.key) ?? []), entry])
  for (const { key, job } of refExecuted) {
    const candidates = replayByKey.get(key)
    const match = candidates?.shift()
    if (!match) continue
    if ((job.conclusion ?? 'unknown') !== (match.job.conclusion ?? 'unknown'))
      conclusionMismatches.push({
        job: key,
        reference: job.conclusion ?? 'unknown',
        replay: match.job.conclusion ?? 'unknown',
      })
    const refSteps = job.steps.filter((s) => s.conclusion !== 'skipped').map((s) => s.name)
    const replaySteps = match.job.steps
      .filter((s) => s.conclusion !== 'skipped' && !s.isHarnessInstrumentation && !RUNNER_LIFECYCLE_STEPS.has(s.name))
      .map((s) => s.name)
    const missing = multisetDifference(refSteps, replaySteps)
    const unexpected = multisetDifference(replaySteps, refSteps)
    if (missing.length || unexpected.length) stepDifferences.push({ job: key, missing, unexpected })
  }
  const missingWorkflows = refPaths.filter((p) => !replayPaths.includes(p))
  const unexpectedWorkflows = replayPaths.filter((p) => !refPaths.includes(p))
  return {
    scenarioName: reference.scenarioName,
    sampleId: sample.sampleId,
    variant: sample.variant,
    passed:
      !missingWorkflows.length &&
      !unexpectedWorkflows.length &&
      !missingJobs.length &&
      !unexpectedJobs.length &&
      !conclusionMismatches.length,
    referenceRunIds: reference.runs.map((r) => r.runId),
    missingWorkflows,
    unexpectedWorkflows,
    missingJobs,
    unexpectedJobs,
    conclusionMismatches,
    stepDifferences,
    referenceWallClockSeconds: reference.metrics.wallClockSeconds,
    replayWallClockSeconds: sample.metrics.wallClockSeconds,
  }
}

export interface UpstreamParity {
  referenceAvailable: boolean
  passed: boolean
  referenceWallClockSeconds: number | null
  referenceRunUrls: string[]
  comparisons: ReferenceComparison[]
  /**
   * Patches (IDs) that are part of the baseline. Present only for a stacked baseline, whose "baseline" is upstream
   * plus these patches: then it is not upstream's own CI and `passed` is never true, whatever the comparisons say.
   */
  baselineIncludesPatches?: string[]
}

/**
 * Upstream parity of a scenario's replays: every complete replay with the CI unchanged (a baseline variant) runs
 * the same workflows and jobs, with the same conclusions, as the locked upstream runs. Without a locked reference
 * or a complete baseline replay, parity is unchecked, which never counts as passed.
 */
export function assessUpstreamParity(
  reference: ScenarioReference | undefined,
  samples: SampleMeasurementResult[],
  baselinePatchIds: string[] = [],
): UpstreamParity {
  const referenceAvailable = Boolean(reference?.runs.length)
  const comparisons = reference
    ? samples
        .filter((s) => s.complete && (s.variant === 'github-baseline' || s.variant === 'starsling-baseline'))
        .map((sample) => compareWithReference(reference, sample))
    : []
  return {
    referenceAvailable,
    passed:
      baselinePatchIds.length === 0 &&
      referenceAvailable &&
      comparisons.length > 0 &&
      comparisons.every((c) => c.passed),
    referenceWallClockSeconds: reference?.metrics.wallClockSeconds ?? null,
    referenceRunUrls: reference?.runs.map((r) => r.htmlUrl).filter(Boolean) ?? [],
    comparisons,
    ...(baselinePatchIds.length ? { baselineIncludesPatches: [...baselinePatchIds] } : {}),
  }
}

/** Human-readable next actions for the setup loop. */
export function describeReferenceComparison(comparison: ReferenceComparison): string[] {
  const lines: string[] = []
  for (const path of comparison.missingWorkflows)
    lines.push(`Workflow ran upstream but not in the replay: ${path} (check triggers, path filters, adaptations).`)
  for (const path of comparison.unexpectedWorkflows)
    lines.push(`Workflow ran in the replay but not upstream: ${path} (check branch/path filters and event type).`)
  for (const job of comparison.missingJobs)
    lines.push(
      `Job ran upstream but was skipped or absent in the replay: ${job} (check if: conditions, identity guards, needs).`,
    )
  for (const job of comparison.unexpectedJobs)
    lines.push(`Job ran in the replay but not upstream: ${job} (check fork/identity conditions and matrix rows).`)
  for (const m of comparison.conclusionMismatches)
    lines.push(
      `Conclusion differs for ${m.job}: upstream ${m.reference}, replay ${m.replay} (inspect the replay logs).`,
    )
  return lines
}
