import { fetchAllPaginatedArtifacts, fetchAllPaginatedJobs, fetchAllPaginatedRuns } from './collector-pages.ts'
import { QueueTracker } from './queue-time.ts'
import type { ExcludedJobSpec, ScenarioInventory, VariantId } from './types.ts'

export { fetchAllPaginatedArtifacts, fetchAllPaginatedJobs, fetchAllPaginatedRuns }

export interface GitHubStepRecord {
  number: number
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  started_at: string | null
  completed_at: string | null
}

export interface ObservedRunnerMetadata {
  runnerName: string
  labels: string[]
  imageOs?: string
  imageVersion?: string
  cpuModel?: string
  vcpu?: number
  memoryGiB?: number
  kernel?: string
  inContainer?: boolean
  adaptiveResources?: Record<string, string | number>
  fingerprintCritical?: Record<string, string>
}

export interface GitHubJobRecord {
  id: number
  run_id: number
  run_attempt: number
  name: string
  workflow_job_id?: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  created_at: string | null
  started_at: string | null
  completed_at: string | null
  labels: string[]
  runner_name: string | null
  steps: GitHubStepRecord[]
  observedRunner?: ObservedRunnerMetadata
  monotonicPhasesUs?: Record<string, number>
}

export interface GitHubArtifactRecord {
  id: number
  run_id: number
  name: string
  size_in_bytes: number
  sha256: string
  created_at: string
  expired: boolean
}

export interface GitHubWorkflowRunRecord {
  id: number
  name: string
  path: string
  event: string
  head_branch: string
  head_sha: string
  pr_numbers?: number[]
  run_number: number
  run_attempt: number
  triggering_run_id?: number
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  created_at: string
  run_started_at: string | null
  updated_at: string
  html_url: string
}

export interface PaginatedGitHubActionsApi {
  listWorkflowRunsPage(params: { page: number; perPage: number }): Promise<{
    runs: GitHubWorkflowRunRecord[]
    hasNextPage: boolean
  }>
  listJobsForRunAttemptPage(params: { runId: number; attempt: number; page: number; perPage: number }): Promise<{
    jobs: GitHubJobRecord[]
    hasNextPage: boolean
  }>
  listRunArtifactsPage(params: { runId: number; page: number; perPage: number }): Promise<{
    artifacts: GitHubArtifactRecord[]
    hasNextPage: boolean
  }>
}

export interface TriggerCorrelationQuery {
  sampleId: string
  repetition: number
  scenarioName: string
  variant: VariantId
  profileName: string
  event: string
  dispatchedAt: string
  headSha: string
  targetBranch: string
  defaultBranch: string
  prNumber?: number
  controllerStagingOverheadSeconds?: number
}

export interface MeasuredStepTiming {
  number: number
  name: string
  conclusion: GitHubStepRecord['conclusion']
  durationSeconds: number | null
  resolution: '1s' | '1us'
  isHarnessInstrumentation: boolean
}

export interface MeasuredJobTiming {
  jobRecordId: number
  runId: number
  runAttempt: number
  workflowPath: string
  jobName: string
  logicalJobId: string
  /** True for a job named in `execution.excludedJobs`: recorded as it ran, but not part of the verdict or the wall clock. */
  excluded?: true
  conclusion: GitHubJobRecord['conclusion']
  durationSeconds: number | null
  dependencyWaitSeconds: number | null
  runnerQueueSeconds: number | null
  resolution: '1s'
  labels: string[]
  observedRunner?: ObservedRunnerMetadata
  steps: MeasuredStepTiming[]
  monotonicPhasesUs?: Record<string, number>
}

export interface MeasuredWorkflowTiming {
  runId: number
  runAttempt: number
  priorAttemptsCount: number
  workflowPath: string
  workflowName: string
  event: string
  triggeringRunId?: number
  conclusion: GitHubWorkflowRunRecord['conclusion']
  durationSeconds: number | null
  startedAt: string | null
  completedAt: string | null
  htmlUrl: string
  jobs: MeasuredJobTiming[]
  artifacts: GitHubArtifactRecord[]
}

export interface SampleMeasurementResult {
  inputFingerprint?: string
  sampleId: string
  repetition: number
  scenarioName: string
  variant: VariantId
  profileName: string
  complete: boolean
  incompleteReasons: string[]
  missingWorkflows: string[]
  missingJobs: string[]
  cancelledJobs: string[]
  failedJobs: string[]
  /** Outcome of each job in `execution.excludedJobs` that ran in this sample. */
  excludedJobs?: { job: string; conclusion: GitHubJobRecord['conclusion']; reason: string }[]
  partialTimestampJobs: string[]
  timestampResolution: '1s'
  metrics: {
    repoMinutes: number | null
    rawRunnerSeconds: number | null
    wallClockSeconds: number | null
    prWallClockSeconds: number | null
    mainWallClockSeconds: number | null
    triggerLatencySeconds: number | null
    harnessOverheadSeconds: number
    /** Longest wait of any job for a runner (job `started_at` minus `created_at`, dependency wait excluded). */
    maxJobQueueSeconds?: number | null
    /** The runner label of the job with that longest wait. */
    maxJobQueueLabel?: string | null
  }
  /** True when a job waited longer than `execution.maxJobQueueSeconds` for a runner, so the sample needs a replacement. */
  queueVoid?: boolean
  workflows: MeasuredWorkflowTiming[]
  artifacts: GitHubArtifactRecord[]
}

function parseEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

export function diffSecondsWhole(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): number | null {
  const s = parseEpochMs(startIso)
  const e = parseEpochMs(endIso)
  if (s === null || e === null) return null
  return Math.max(0, Math.round((e - s) / 1000))
}

function normalizeLogicalJobId(job: GitHubJobRecord, expectedJobIds: string[]): string {
  if (job.workflow_job_id) return job.workflow_job_id
  const baseName = job.name.split(' (')[0]?.trim() ?? job.name
  const exactMatch = expectedJobIds.find((id) => id.toLowerCase() === baseName.toLowerCase())
  return exactMatch ?? baseName
}

function isHarnessStep(stepName: string): boolean {
  const lower = stepName.toLowerCase()
  return (
    lower.includes('benchmark event context (harness)') ||
    lower.includes('runner fingerprint (bench parity)') ||
    lower.includes('bench-host-info') ||
    lower.includes('bench-finish')
  )
}

/**
 * Collects all pages of workflow runs, attempts, jobs, steps, and artifacts, correlating by
 * recorded trigger, PR/ref/SHA, workflow identity, and downstream `workflow_run` relationships.
 */
export async function collectSampleExecution(params: {
  api: PaginatedGitHubActionsApi
  query: TriggerCorrelationQuery
  scenarioInventory: ScenarioInventory
  jobDependenciesByWorkflow?: Record<string, Record<string, string[]>>
  /** Longest a job may wait for a runner before the sample is void; defaults to 30 s. */
  maxJobQueueSeconds?: number
  /** Jobs that run but do not gate or time the sample (`execution.excludedJobs`). */
  excludedJobs?: ExcludedJobSpec[]
}): Promise<SampleMeasurementResult> {
  const { api, query, scenarioInventory, jobDependenciesByWorkflow } = params
  const excludedSpecs = params.excludedJobs ?? []
  const excludedOutcomes: NonNullable<SampleMeasurementResult['excludedJobs']> = []
  const queue = new QueueTracker(params.maxJobQueueSeconds)
  const allRuns = await fetchAllPaginatedRuns(api)
  const dispatchMs = parseEpochMs(query.dispatchedAt) ?? 0
  const expectedDirectWorkflows = new Set(
    scenarioInventory.triggeredWorkflows.filter(
      (wf) => !scenarioInventory.downstreamWorkflowRuns.some((d) => d.downstreamFilePath === wf),
    ),
  )
  const expectedDownstreamWorkflows = new Set(scenarioInventory.downstreamWorkflowRuns.map((d) => d.downstreamFilePath))

  // 1. Correlate direct root runs by trigger event, headSha, targetBranch, prNumber, and dispatch timestamp
  const correlatedDirectByPath = new Map<string, GitHubWorkflowRunRecord[]>()
  for (const run of allRuns) {
    if (!expectedDirectWorkflows.has(run.path)) continue
    const createdMs = parseEpochMs(run.created_at) ?? 0
    if (createdMs < dispatchMs) continue
    if (run.event !== query.event) continue
    if (run.head_sha !== query.headSha) continue
    if (run.head_branch !== query.targetBranch) continue
    if (query.prNumber !== undefined && !run.pr_numbers?.includes(query.prNumber)) {
      continue
    }
    const existing = correlatedDirectByPath.get(String(run.id)) ?? []
    existing.push(run)
    correlatedDirectByPath.set(String(run.id), existing)
  }

  // Select latest run_attempt for each correlated workflow run ID
  const selectedDirectRuns = new Map<string, { latest: GitHubWorkflowRunRecord; priorAttempts: number }>()
  for (const [wfPath, runs] of correlatedDirectByPath.entries()) {
    const sorted = [...runs].sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id)
    const latest = sorted[0]
    if (latest) {
      selectedDirectRuns.set(wfPath, {
        latest,
        priorAttempts: Math.max(0, latest.run_attempt - 1),
      })
    }
  }

  // 2. Correlate downstream `workflow_run` runs transitively by `triggering_run_id` and defaultBranch
  const selectedDownstreamRuns = new Map<string, { latest: GitHubWorkflowRunRecord; priorAttempts: number }>()
  const parentRunIds = new Set([...selectedDirectRuns.values()].map((r) => r.latest.id))

  let addedDownstream = true
  while (addedDownstream) {
    addedDownstream = false
    for (const run of allRuns) {
      if (!expectedDownstreamWorkflows.has(run.path)) continue
      if (selectedDownstreamRuns.has(String(run.id))) continue
      if (run.event !== 'workflow_run') continue
      const createdMs = parseEpochMs(run.created_at) ?? 0
      if (createdMs < dispatchMs) continue

      const matchesParent = run.triggering_run_id !== undefined && parentRunIds.has(run.triggering_run_id)

      if (matchesParent) {
        const allAttempts = allRuns.filter((r) => r.id === run.id).sort((a, b) => b.run_attempt - a.run_attempt)
        const latest = allAttempts[0] ?? run
        selectedDownstreamRuns.set(String(run.id), {
          latest,
          priorAttempts: Math.max(0, latest.run_attempt - 1),
        })
        parentRunIds.add(latest.id)
        addedDownstream = true
      }
    }
  }

  const allSelectedRuns = new Map<string, { latest: GitHubWorkflowRunRecord; priorAttempts: number }>([
    ...selectedDirectRuns.entries(),
    ...selectedDownstreamRuns.entries(),
  ])

  const missingWorkflows: string[] = []
  for (const expectedWf of scenarioInventory.triggeredWorkflows) {
    if (![...allSelectedRuns.values()].some((r) => r.latest.path === expectedWf)) {
      missingWorkflows.push(expectedWf)
    }
  }

  // A listener can run once for each matching parent invocation, not merely once per path.
  for (const dependency of scenarioInventory.downstreamWorkflowRuns) {
    const parents = [...allSelectedRuns.values()].filter((r) => r.latest.name === dependency.upstreamWorkflowName)
    for (const parent of parents)
      if (
        ![...selectedDownstreamRuns.values()].some(
          (r) => r.latest.path === dependency.downstreamFilePath && r.latest.triggering_run_id === parent.latest.id,
        )
      )
        missingWorkflows.push(`${dependency.downstreamFilePath}@parent:${parent.latest.id}`)
  }
  const measuredWorkflows: MeasuredWorkflowTiming[] = []
  const allArtifacts: GitHubArtifactRecord[] = []
  const missingJobs: string[] = []
  const cancelledJobs: string[] = []
  const failedJobs: string[] = []
  const partialTimestampJobs: string[] = []
  const incompleteReasons: string[] = []
  if (!scenarioInventory.triggeredWorkflows.length || !scenarioInventory.jobExpectations.length)
    incompleteReasons.push('Empty or unresolved scenario inventory')
  if (scenarioInventory.blockers.some((b) => b.severity === 'blocker'))
    incompleteReasons.push('Unresolved scenario blockers')

  if (missingWorkflows.length > 0) {
    incompleteReasons.push(`Missing expected workflow runs: ${missingWorkflows.join(', ')}`)
  }

  let totalRunnerSeconds = 0
  let instrumentationOverheadSeconds = 0
  let earliestWorkflowStartMs: number | null = null
  let latestJobEndMs: number | null = null

  for (const { latest: run, priorAttempts } of allSelectedRuns.values()) {
    const wfPath = run.path
    if (run.status !== 'completed') {
      incompleteReasons.push(`Workflow "${wfPath}" (run ${run.id}) has not completed (status=${run.status})`)
    }
    if (run.conclusion === 'cancelled') {
      incompleteReasons.push(`Workflow "${wfPath}" (run ${run.id}) was cancelled`)
    }

    const jobs = await fetchAllPaginatedJobs(api, run.id, run.run_attempt)
    const artifacts = await fetchAllPaginatedArtifacts(api, run.id)
    allArtifacts.push(...artifacts)

    const expectedJobsForWf = scenarioInventory.jobExpectations.filter((j) => j.workflowFile === wfPath)
    const expectedJobIds = expectedJobsForWf.map((j) => j.jobId)
    const wfDeps = jobDependenciesByWorkflow?.[wfPath] ?? {}

    // Track completion time per logical job ID for dependency wait calculation
    const logicalJobCompletionMs: Record<string, number> = {}
    for (const job of jobs) {
      const logicalId = normalizeLogicalJobId(job, expectedJobIds)
      const compMs = parseEpochMs(job.completed_at)
      if (compMs !== null) {
        logicalJobCompletionMs[logicalId] = Math.max(logicalJobCompletionMs[logicalId] ?? 0, compMs)
      }
    }

    const measuredJobs: MeasuredJobTiming[] = []
    let wfLatestEndIso: string | null = null

    const wfStartMs = parseEpochMs(run.run_started_at)
    if (wfStartMs !== null) {
      earliestWorkflowStartMs =
        earliestWorkflowStartMs === null ? wfStartMs : Math.min(earliestWorkflowStartMs, wfStartMs)
    }

    for (const job of jobs) {
      const logicalId = normalizeLogicalJobId(job, expectedJobIds)
      const qualifiedJobName = `${wfPath}#${job.name}`
      const exclusion = excludedSpecs.find((e) => e.workflowFile === wfPath && e.jobId === logicalId)
      if (exclusion)
        excludedOutcomes.push({ job: qualifiedJobName, conclusion: job.conclusion, reason: exclusion.reason })

      if (job.status !== 'completed') {
        incompleteReasons.push(`Job "${qualifiedJobName}" is still ${job.status}`)
      }
      if (job.conclusion === 'cancelled') {
        cancelledJobs.push(qualifiedJobName)
      } else if (job.conclusion === 'failure' && !exclusion) {
        failedJobs.push(qualifiedJobName)
      }

      const jobDuration = job.conclusion === 'skipped' ? 0 : diffSecondsWhole(job.started_at, job.completed_at)

      if (job.conclusion !== 'skipped' && (job.started_at === null || job.completed_at === null)) {
        partialTimestampJobs.push(qualifiedJobName)
      }

      if (jobDuration !== null && job.conclusion !== 'skipped') {
        totalRunnerSeconds += jobDuration
      }

      const jobEndMs = parseEpochMs(job.completed_at)
      if (jobEndMs !== null && job.conclusion !== 'skipped' && !exclusion) {
        latestJobEndMs = latestJobEndMs === null ? jobEndMs : Math.max(latestJobEndMs, jobEndMs)
        if (!wfLatestEndIso || (parseEpochMs(wfLatestEndIso) ?? 0) < jobEndMs) {
          wfLatestEndIso = job.completed_at
        }
      }

      // Compute dependency wait vs runner queue time
      const jobCreatedMs = parseEpochMs(job.created_at)
      const jobStartedMs = parseEpochMs(job.started_at)
      const deps = wfDeps[logicalId] ?? []
      let maxDepEndMs: number | null = null
      for (const dep of deps) {
        const depEnd = logicalJobCompletionMs[dep]
        if (depEnd !== undefined) {
          maxDepEndMs = maxDepEndMs === null ? depEnd : Math.max(maxDepEndMs, depEnd)
        }
      }

      let dependencyWaitSeconds: number | null = null
      let runnerQueueSeconds: number | null = null
      if (jobCreatedMs !== null && jobStartedMs !== null && job.conclusion !== 'skipped') {
        if (maxDepEndMs !== null && maxDepEndMs > jobCreatedMs) {
          dependencyWaitSeconds = Math.max(0, Math.round((maxDepEndMs - jobCreatedMs) / 1000))
          runnerQueueSeconds = Math.max(0, Math.round((jobStartedMs - maxDepEndMs) / 1000))
        } else {
          dependencyWaitSeconds = 0
          runnerQueueSeconds = Math.max(0, Math.round((jobStartedMs - jobCreatedMs) / 1000))
        }
      }

      queue.record(runnerQueueSeconds, job.labels)

      const measuredSteps: MeasuredStepTiming[] = job.steps.map((st) => {
        const stDur = st.conclusion === 'skipped' ? 0 : diffSecondsWhole(st.started_at, st.completed_at)
        const harness = isHarnessStep(st.name)
        if (harness && stDur !== null) {
          instrumentationOverheadSeconds += stDur
        }
        return {
          number: st.number,
          name: st.name,
          conclusion: st.conclusion,
          durationSeconds: stDur,
          resolution: '1s',
          isHarnessInstrumentation: harness,
        }
      })

      measuredJobs.push({
        jobRecordId: job.id,
        runId: run.id,
        runAttempt: run.run_attempt,
        workflowPath: wfPath,
        jobName: job.name,
        logicalJobId: logicalId,
        ...(exclusion ? { excluded: true as const } : {}),
        conclusion: job.conclusion,
        durationSeconds: jobDuration,
        dependencyWaitSeconds,
        runnerQueueSeconds,
        resolution: '1s',
        labels: job.labels,
        ...(job.observedRunner ? { observedRunner: job.observedRunner } : {}),
        steps: measuredSteps,
        ...(job.monotonicPhasesUs ? { monotonicPhasesUs: job.monotonicPhasesUs } : {}),
      })
    }

    // Verify expected executed jobs in this workflow ran
    const observedLogicalIds = new Set(
      measuredJobs.filter((j) => j.conclusion !== 'skipped').map((j) => j.logicalJobId),
    )
    for (const exp of expectedJobsForWf) {
      if (exp.expectedStatus === 'executed' && !observedLogicalIds.has(exp.jobId)) {
        missingJobs.push(`${wfPath}#${exp.jobId}`)
      }
    }

    for (const exp of expectedJobsForWf) {
      if (
        exp.expectedStatus === 'executed' &&
        exp.expectedMatrixCount !== undefined &&
        measuredJobs.filter((j) => j.logicalJobId === exp.jobId && j.conclusion !== 'skipped').length !==
          exp.expectedMatrixCount
      )
        incompleteReasons.push(`Matrix count mismatch: ${wfPath}#${exp.jobId}`)
    }
    // A run that failed only because of excluded jobs is as good as a success; any other failure still counts.
    const onlyExcludedFailed =
      run.conclusion === 'failure' &&
      measuredJobs.some((j) => j.excluded && j.conclusion === 'failure') &&
      measuredJobs.every((j) => j.excluded || j.conclusion !== 'failure')
    if (run.status !== 'completed' || (run.conclusion !== 'success' && !onlyExcludedFailed))
      incompleteReasons.push(`Workflow not successful: ${wfPath}`)
    if (!run.run_started_at) incompleteReasons.push(`Missing workflow start: ${wfPath}`)
    if (priorAttempts > 0) incompleteReasons.push(`Rerun requires a replacement sample: ${wfPath}`)
    const wfDuration = diffSecondsWhole(run.run_started_at, wfLatestEndIso)

    measuredWorkflows.push({
      runId: run.id,
      runAttempt: run.run_attempt,
      priorAttemptsCount: priorAttempts,
      workflowPath: wfPath,
      workflowName: run.name,
      event: run.event,
      ...(run.triggering_run_id !== undefined ? { triggeringRunId: run.triggering_run_id } : {}),
      conclusion: run.conclusion,
      durationSeconds: wfDuration,
      startedAt: run.run_started_at,
      completedAt: wfLatestEndIso,
      htmlUrl: run.html_url,
      jobs: measuredJobs,
      artifacts,
    })
  }

  if (missingJobs.length > 0) {
    incompleteReasons.push(`Missing expected jobs: ${missingJobs.join(', ')}`)
  }
  if (cancelledJobs.length > 0) {
    incompleteReasons.push(`Cancelled jobs: ${cancelledJobs.join(', ')}`)
  }
  if (failedJobs.length > 0) {
    incompleteReasons.push(`Failed jobs: ${failedJobs.join(', ')}`)
  }
  if (partialTimestampJobs.length > 0) {
    incompleteReasons.push(`Missing timestamps on executed jobs: ${partialTimestampJobs.join(', ')}`)
  }

  // Queue time lands inside the measured wait; a sample that waited for a machine is replaced, like a rerun.
  incompleteReasons.push(...queue.reasons)

  const complete = incompleteReasons.length === 0
  const wallClockSeconds =
    earliestWorkflowStartMs !== null && latestJobEndMs !== null
      ? Math.max(0, Math.round((latestJobEndMs - earliestWorkflowStartMs) / 1000))
      : null

  const isPrEvent = query.event === 'pull_request' || query.event === 'pull_request_target'
  const triggerLatencySeconds =
    earliestWorkflowStartMs !== null && dispatchMs > 0
      ? Math.max(0, Math.round((earliestWorkflowStartMs - dispatchMs) / 1000))
      : null

  const harnessOverheadSeconds = (query.controllerStagingOverheadSeconds ?? 0) + instrumentationOverheadSeconds

  return {
    sampleId: query.sampleId,
    repetition: query.repetition,
    scenarioName: query.scenarioName,
    variant: query.variant,
    profileName: query.profileName,
    complete,
    incompleteReasons,
    missingWorkflows,
    missingJobs,
    cancelledJobs,
    failedJobs,
    ...(excludedOutcomes.length ? { excludedJobs: excludedOutcomes } : {}),
    partialTimestampJobs,
    timestampResolution: '1s',
    metrics: {
      repoMinutes: partialTimestampJobs.length === 0 ? Number((totalRunnerSeconds / 60).toFixed(4)) : null,
      rawRunnerSeconds: partialTimestampJobs.length === 0 ? totalRunnerSeconds : null,
      wallClockSeconds,
      prWallClockSeconds: isPrEvent ? wallClockSeconds : null,
      mainWallClockSeconds: !isPrEvent ? wallClockSeconds : null,
      triggerLatencySeconds,
      harnessOverheadSeconds,
      maxJobQueueSeconds: queue.maxSeconds,
      maxJobQueueLabel: queue.maxLabel,
    },
    ...(queue.reasons.length ? { queueVoid: true } : {}),
    workflows: measuredWorkflows,
    artifacts: allArtifacts,
  }
}
