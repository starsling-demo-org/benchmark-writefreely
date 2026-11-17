import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  addUsage,
  AdaptiveInterval,
  ApiBudget,
  DEFAULT_API_BUDGET_PER_HOUR,
  emptyUsage,
  type ExperimentApiUsage,
} from './api-budget.ts'
import { collectSampleExecution, type SampleMeasurementResult, type TriggerCorrelationQuery } from './collector.ts'
import { replayBranchOf } from './config.ts'
import { controllerWrittenBranches, protectedBranchesOf } from './protected-branches.ts'
import {
  createExperimentManifest,
  type ExperimentManifest,
  isSeedOf,
  type RequestedSample,
  replacementSampleId,
  sampleKey,
  seedSampleId,
  slotSampleId,
  unfilledSlots,
} from './manifest.ts'
import { GitHubActionsApi, GitHubClient, object } from './github.ts'
import { NativeReplayBackend } from './native-backend.ts'
import { verifyPrepared, type PreparedExperiment, type PreparedVariant } from './prepared.ts'
import { ReplayStagingController } from './staging.ts'
import type { BenchmarkConfig, ExcludedJobSpec, VariantId } from './types.ts'

export interface ExperimentRecord {
  schemaVersion: 1
  manifest: ExperimentManifest
  config: BenchmarkConfig
  samples: SampleMeasurementResult[]
  seedSamples: SampleMeasurementResult[]
  cacheResets?: string[]
  cacheSnapshots: Record<string, unknown[]>
  /** Content hash of the harness that ran this experiment; lets `bench showcase --fix-arm-experiment` check two records used the same harness. */
  harnessHash?: string
  /** GitHub API calls this controller made: per sample and for the whole experiment (see README, parallel runs). */
  apiUsage?: ExperimentApiUsage
}
/** Seed attempts per warm sample before the experiment stops. */
export const SEED_ATTEMPTS = 3
/** Replacements per setup (variant + profile) before the experiment stops, unless `execution.maxReplacementsPerSetup` says otherwise. */
export const DEFAULT_MAX_REPLACEMENTS_PER_SETUP = 3

export function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}
export async function collectUntilComplete(params: {
  api: GitHubActionsApi
  query: TriggerCorrelationQuery
  payload: PreparedVariant
  timeoutMinutes: number
  pollIntervalSeconds: number
  /** Paces the polling to the controller's hourly call budget; without one the plain adaptive interval is used. */
  budget?: ApiBudget
  maxJobQueueSeconds?: number
  excludedJobs?: ExcludedJobSpec[]
}): Promise<SampleMeasurementResult> {
  const deadline = Date.now() + params.timeoutMinutes * 60_000
  // Wait longer while nothing changes (the configured interval, then 2x, 4x, 8x up to 120 s); start over on change.
  const interval = new AdaptiveInterval(params.pollIntervalSeconds * 1000)
  let lastObservation: string | undefined
  let result: SampleMeasurementResult
  do {
    result = await collectSampleExecution({
      api: params.api,
      query: params.query,
      scenarioInventory: params.payload.inventory,
      ...(params.maxJobQueueSeconds !== undefined ? { maxJobQueueSeconds: params.maxJobQueueSeconds } : {}),
      ...(params.excludedJobs?.length ? { excludedJobs: params.excludedJobs } : {}),
    })
    if (result.complete) return result
    // A queue void cannot heal by waiting: the job already started late.
    if (Date.now() >= deadline || result.failedJobs.length || result.cancelledJobs.length || result.queueVoid)
      return result
    const observation = JSON.stringify([result.incompleteReasons, result.workflows.map((w) => [w.runId, w.conclusion])])
    const waitMs = interval.next(observation !== lastObservation)
    lastObservation = observation
    if (params.budget) await params.budget.pause(waitMs)
    else await delay(waitMs)
  } while (Date.now() < deadline)
  return result
}
export async function runNativeExperiment(params: {
  config: BenchmarkConfig
  prepared: PreparedExperiment
  directory: string
  experimentId: string
  scenarioNames?: string[]
  profileNames?: string[]
  variants?: VariantId[]
  repetitions?: number
  collectOnly?: boolean
}): Promise<ExperimentRecord> {
  const { config, prepared, directory, experimentId } = params
  verifyPrepared(prepared, config, { recovery: params.collectOnly === true })
  // Preflight: a branch a merged-PR patch landed on must not be one the controller writes.
  const protectedBranches = protectedBranchesOf(config)
  for (const { branch, why } of controllerWrittenBranches(config))
    if (protectedBranches.includes(branch))
      throw new Error(
        `Preflight: "${branch}" is a merged-PR patch base/head branch but the controller writes it: ${why}`,
      )
  mkdirSync(directory, { recursive: true })
  const recordPath = join(directory, 'experiment.json')
  const manifest = createExperimentManifest({
    config,
    experimentId,
    inputFingerprint: prepared.inputFingerprint,
    ...(params.variants ? { variants: params.variants } : {}),
    ...(params.scenarioNames ? { scenarioNames: params.scenarioNames } : {}),
    ...(params.profileNames ? { profileNames: params.profileNames } : {}),
    ...(params.repetitions ? { repetitions: params.repetitions } : {}),
  })
  const isNewExperiment = !existsSync(recordPath)
  const record: ExperimentRecord = !isNewExperiment
    ? (JSON.parse(readFileSync(recordPath, 'utf8')) as ExperimentRecord)
    : {
        schemaVersion: 1,
        manifest,
        config,
        samples: [],
        seedSamples: [],
        cacheSnapshots: {},
        harnessHash: prepared.harnessHash,
      }
  if (JSON.stringify(record.manifest) !== JSON.stringify(manifest))
    throw new Error('Existing experiment manifest differs; use a new experiment directory')
  // Resolve every deterministic dispatch constraint before taking repository ownership.
  const validateWorkload = (scenarioName: string, variant: VariantId): PreparedVariant => {
    const scenario = config.scenarios[scenarioName]
    const payload = prepared.variants[scenarioName]?.[variant]
    if (!scenario || !payload) throw new Error(`Missing prepared workload: ${scenarioName}/${variant}`)
    if (
      !payload.inventory.triggeredWorkflows.length ||
      payload.inventory.blockers.some((blocker) => blocker.severity === 'blocker')
    )
      throw new Error(`Scenario has no resolved workload: ${scenarioName}`)
    if (
      scenario.event !== 'push' &&
      scenario.event !== 'workflow_dispatch' &&
      !(scenario.event === 'pull_request' && scenario.pr?.activityType === 'synchronize')
    )
      throw new Error(`Unsupported native event for ${scenarioName}; use push, workflow_dispatch or PR synchronize`)
    return payload
  }
  for (const requested of manifest.samples) {
    validateWorkload(requested.scenarioName, requested.variant)
    const profile = config.profiles[requested.profileName]
    if (!profile) throw new Error(`Missing profile: ${requested.profileName}`)
    if (profile.externalCacheAdapters?.length)
      throw new Error('External cache lifecycle requires recorded reset/seed/verify evidence before native dispatch')
    if (profile.actionsCache === 'warm' || profile.crossRunArtifacts === 'seeded') {
      if (!profile.seedScenario) throw new Error(`Warm/seeded profile ${profile.name} requires a seed scenario`)
      validateWorkload(profile.seedScenario, requested.variant)
    }
  }
  const budget = new ApiBudget({ perHour: config.execution.apiBudgetPerHour ?? DEFAULT_API_BUDGET_PER_HOUR })
  const client = new GitHubClient(config.benchmarkRepository.repository, join(directory, 'raw'), budget)
  // Calls are added to the record as they happen; a resumed experiment keeps what earlier processes spent.
  const usage: ExperimentApiUsage = record.apiUsage ?? {
    budgetPerHour: budget.perHour,
    experiment: emptyUsage(),
    samples: {},
  }
  record.apiUsage = usage
  usage.budgetPerHour = budget.perHour
  let flushed = budget.snapshot()
  const flushUsage = () => {
    addUsage(usage.experiment, budget.since(flushed))
    flushed = budget.snapshot()
  }
  const saveRecord = () => {
    flushUsage()
    writeJson(recordPath, record)
  }
  const repo = object(await client.request(''))
  if (repo.default_branch !== config.benchmarkRepository.defaultBranch)
    throw new Error('Replay repository must be initialized with the configured default branch before dispatch')
  const first = manifest.samples[0]
  if (!first) throw new Error('Empty manifest')
  const firstPayload = prepared.variants[first.scenarioName]?.[first.variant]
  if (!firstPayload) throw new Error('Missing first payload')
  const leaseBackend = new NativeReplayBackend(
    client,
    firstPayload,
    join(directory, 'controller.json'),
    experimentId,
    true,
    protectedBranches,
  )
  if (!unfilledSlots(manifest, record.samples).length) {
    await leaseBackend.finishExperiment()
    return record
  }
  if (isNewExperiment) await leaseBackend.ensureNoActiveRuns()
  await leaseBackend.acquireLease()
  const allWorkflows = (await client.all('actions/workflows', 'workflows')).map(object).map((w) => String(w.path))
  const runSample = async (requested: RequestedSample, seed: boolean): Promise<SampleMeasurementResult> => {
    const payload = validateWorkload(requested.scenarioName, requested.variant)
    const statePath = join(directory, `${requested.sampleId}.staging.json`)
    const backend = new NativeReplayBackend(
      client,
      payload,
      join(directory, 'controller.json'),
      experimentId,
      true,
      protectedBranches,
    )
    const controller = new ReplayStagingController(statePath, backend, protectedBranches)
    if (controller.loadState()?.currentStep === 'invalidated')
      throw new Error(`Sample ${requested.sampleId} was invalidated; recover the experiment before retrying`)
    const scenario = config.scenarios[requested.scenarioName]
    if (!scenario) throw new Error('Missing scenario')
    let measured: SampleMeasurementResult | undefined
    const pendingIntegrity = 'Staging integrity validation is pending'
    const persistMeasurement = (measurement: SampleMeasurementResult) => {
      const list = seed ? record.seedSamples : record.samples
      const index = list.findIndex((s) => s.sampleId === requested.sampleId)
      if (index < 0) list.push(measurement)
      else list[index] = measurement
      saveRecord()
    }
    const collect = async (
      dispatch: NonNullable<ReturnType<ReplayStagingController['loadState']>>['dispatchRecord'],
    ) => {
      if (!dispatch) throw new Error('No recorded dispatch to collect')
      const query: TriggerCorrelationQuery = {
        ...requested,
        event: dispatch.event,
        dispatchedAt: dispatch.dispatchedAt,
        headSha: dispatch.headSha,
        targetBranch: dispatch.targetRef.replace('refs/heads/', ''),
        defaultBranch: config.benchmarkRepository.defaultBranch,
        ...(dispatch.prNumber ? { prNumber: dispatch.prNumber } : {}),
      }
      writeJson(join(directory, `${requested.sampleId}.query.json`), query)
      const enrichmentPath = join(directory, `${requested.sampleId}.correlation.json`)
      const enrichment = existsSync(enrichmentPath)
        ? (JSON.parse(readFileSync(enrichmentPath, 'utf8')) as {
            parentRunIds?: Record<string, number>
            logicalJobIds?: Record<string, string>
          })
        : {}
      measured = await collectUntilComplete({
        api: new GitHubActionsApi(client, { ...enrichment, createdAfter: dispatch.dispatchedAt }),
        query,
        payload,
        timeoutMinutes: config.execution.timeoutMinutes,
        pollIntervalSeconds: config.execution.pollIntervalSeconds,
        budget,
        ...(config.execution.maxJobQueueSeconds !== undefined
          ? { maxJobQueueSeconds: config.execution.maxJobQueueSeconds }
          : {}),
        ...(config.execution.excludedJobs?.length ? { excludedJobs: config.execution.excludedJobs } : {}),
      })
      measured.inputFingerprint = prepared.inputFingerprint
      // Persist observations immediately, but do not qualify them until staging's
      // ref-integrity check succeeds. A crash in between remains visibly incomplete.
      persistMeasurement(
        measured.complete
          ? {
              ...measured,
              complete: false,
              incompleteReasons: [...measured.incompleteReasons, pendingIntegrity],
            }
          : measured,
      )
      if (!measured.complete)
        throw new Error(`Incomplete sample ${requested.sampleId}; state remains leased for collect/recover`)
    }
    if (params.collectOnly && !controller.loadState()?.dispatchRecord)
      throw new Error(`Sample ${requested.sampleId} has not been dispatched`)
    try {
      await controller.executeSampleStaging({
        experimentId,
        sampleId: requested.sampleId,
        scenario,
        variant: requested.variant,
        profileName: requested.profileName,
        controlBranch: config.benchmarkRepository.controlBranch,
        defaultBranch: config.benchmarkRepository.defaultBranch,
        replayBranch: replayBranchOf(config),
        allRepoWorkflows: allWorkflows,
        newlyIntroducedWorkflows: payload.workflowFiles.filter((w) => !allWorkflows.includes(w)),
        scenarioWorkflows: payload.inventory.triggeredWorkflows,
        variantLock: payload.lock,
        awaitCompletionFn: collect,
      })
    } catch (error) {
      if (measured)
        persistMeasurement({
          ...measured,
          complete: false,
          incompleteReasons: [
            ...measured.incompleteReasons,
            `Staging failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        })
      throw error
    }
    if (!measured) {
      const existing = (seed ? record.seedSamples : record.samples).find((s) => s.sampleId === requested.sampleId)
      if (!existing) throw new Error('Completed staging has no measured sample')
      // A previous process may have validated staging but exited before promoting
      // the persisted observation. Only that specific pending state can be promoted.
      if (existing.incompleteReasons.includes(pendingIntegrity)) {
        measured = {
          ...existing,
          complete: true,
          incompleteReasons: existing.incompleteReasons.filter((reason) => reason !== pendingIntegrity),
        }
      } else return existing
    }
    persistMeasurement(measured)
    return measured
  }
  // The calls one sample (or seed attempt) spent, kept even when it fails, added to any earlier process's share.
  const runOne = async (requested: RequestedSample, seed: boolean): Promise<SampleMeasurementResult> => {
    const before = budget.snapshot()
    try {
      return await runSample(requested, seed)
    } finally {
      const sampleUsage = usage.samples[requested.sampleId] ?? emptyUsage()
      usage.samples[requested.sampleId] = addUsage(sampleUsage, budget.since(before))
      saveRecord()
    }
  }
  const retireAttempt = async (
    scenarioName: string,
    variant: VariantId,
    sampleId: string,
    runIds: number[],
    reason: string,
  ) => {
    const backend = new NativeReplayBackend(
      client,
      validateWorkload(scenarioName, variant),
      join(directory, 'controller.json'),
      experimentId,
      true,
      protectedBranches,
    )
    const controller = new ReplayStagingController(
      join(directory, `${sampleId}.staging.json`),
      backend,
      protectedBranches,
    )
    if (controller.loadState()?.currentStep === 'superseded') return
    await backend.settleRuns(runIds, config.execution.timeoutMinutes)
    controller.supersede(reason)
  }
  saveRecord()
  const processAttempt = async (requested: RequestedSample) => {
    const profile = config.profiles[requested.profileName]
    if (!profile) throw new Error('Missing profile')
    const started = existsSync(join(directory, `${requested.sampleId}.staging.json`))
    if (params.collectOnly && !started) return
    if (!started && !params.collectOnly && !record.cacheResets?.includes(requested.sampleId)) {
      const caches = await client.all('actions/caches', 'actions_caches')
      record.cacheSnapshots[requested.sampleId] = caches
      saveRecord()
      // Ref-scoped deletion is limited to this dedicated replay repository and benchmark-owned refs.
      if (profile.actionsCache !== 'unmanaged-diagnostic') {
        for (const cache of caches.map(object)) {
          const ref = String(cache.ref)
          if (
            ref === `refs/heads/${config.benchmarkRepository.defaultBranch}` ||
            ref === `refs/heads/${replayBranchOf(config)}` ||
            ref.startsWith('refs/heads/bench/') ||
            ref.startsWith('refs/pull/')
          )
            await client.request(`actions/caches/${Number(cache.id)}`, 'DELETE')
          else throw new Error(`Unowned cache scope ${ref}; controlled reset cannot be established`)
        }
        if ((await client.all('actions/caches', 'actions_caches')).length)
          throw new Error('Cache reset not yet complete')
      }
      record.cacheResets = [...(record.cacheResets ?? []), requested.sampleId]
      saveRecord()
    }
    if (
      !started &&
      !params.collectOnly &&
      (profile.actionsCache === 'warm' || profile.crossRunArtifacts === 'seeded')
    ) {
      if (!profile.seedScenario) throw new Error('Warm profile requires a seed scenario')
      // A seed is setup, not a measurement. When its workflows fail (for example, a dependency fetched from a
      // registry mid-publish), it is retried under a new attempt ID; every attempt stays in the record and in seed cost.
      const seeded = () => record.seedSamples.some((s) => isSeedOf(s.sampleId, requested.sampleId) && s.complete)
      const seedScenario = profile.seedScenario
      // A failed attempt stops observing at its first failed job. Before the retry, its remaining runs are cancelled
      // and awaited, so they cannot overlap the retry or the measured sample, and its journal is closed for recovery.
      const retire = (sampleId: string, nextSampleId: string) =>
        retireAttempt(
          seedScenario,
          requested.variant,
          sampleId,
          record.seedSamples.find((s) => s.sampleId === sampleId)?.workflows.map((w) => w.runId) ?? [],
          `Seed attempt failed; retried as ${nextSampleId}`,
        )
      for (let attempt = 1; !seeded(); attempt++) {
        const seedRequest = {
          ...requested,
          sampleId: seedSampleId(requested.sampleId, attempt),
          scenarioName: seedScenario,
        }
        const nextSampleId = seedSampleId(requested.sampleId, attempt + 1)
        const failedJobs = () => record.seedSamples.find((s) => s.sampleId === seedRequest.sampleId)?.failedJobs ?? []
        if (failedJobs().length && attempt < SEED_ATTEMPTS) {
          await retire(seedRequest.sampleId, nextSampleId)
          continue
        }
        try {
          await runOne(seedRequest, true)
        } catch (error) {
          if (attempt >= SEED_ATTEMPTS || !failedJobs().length) throw error
          await retire(seedRequest.sampleId, nextSampleId)
        }
      }
    }
    await runOne(requested, false)
  }
  const maxReplacements = config.execution.maxReplacementsPerSetup ?? DEFAULT_MAX_REPLACEMENTS_PER_SETUP
  // A sample whose workflow failed (or that was voided on queue time) is excluded and replaced by a fresh attempt
  // for the same slot, up to the per-setup limit. Anything else (a controller or staging error, a sample that
  // never finished) still stops the experiment.
  const isReplaceable = (sample: SampleMeasurementResult | undefined, error: unknown): boolean =>
    !params.collectOnly &&
    sample !== undefined &&
    !sample.complete &&
    error instanceof Error &&
    error.message.startsWith('Incomplete sample') &&
    (sample.queueVoid === true ||
      sample.failedJobs.length > 0 ||
      sample.cancelledJobs.length > 0 ||
      sample.incompleteReasons.some((reason) => reason.startsWith('Workflow not successful')))
  const replacementsUsed = (slot: RequestedSample) =>
    record.samples.filter(
      (s) =>
        s.variant === slot.variant && s.profileName === slot.profileName && s.sampleId !== slotSampleId(s.sampleId),
    ).length
  for (const slot of manifest.samples) {
    if (record.samples.some((s) => s.complete && sampleKey(s) === sampleKey(slot))) continue
    // Resume at the slot's latest attempt.
    let replacement = 0
    while (existsSync(join(directory, `${replacementSampleId(slot.sampleId, replacement + 1)}.staging.json`)))
      replacement++
    for (;;) {
      const sampleId = replacement ? replacementSampleId(slot.sampleId, replacement) : slot.sampleId
      try {
        await processAttempt({ ...slot, sampleId })
        break
      } catch (error) {
        const failed = record.samples.find((s) => s.sampleId === sampleId)
        if (!isReplaceable(failed, error) || replacementsUsed(slot) >= maxReplacements) throw error
        replacement++
        await retireAttempt(
          slot.scenarioName,
          slot.variant,
          sampleId,
          failed?.workflows.map((w) => w.runId) ?? [],
          `Sample failed; replaced by ${replacementSampleId(slot.sampleId, replacement)}`,
        )
      }
    }
  }
  if (!unfilledSlots(manifest, record.samples).length) {
    // Reload the journal after per-sample backend operations before releasing ownership.
    await new NativeReplayBackend(
      client,
      firstPayload,
      join(directory, 'controller.json'),
      experimentId,
      true,
    ).finishExperiment()
  }
  saveRecord()
  return record
}
