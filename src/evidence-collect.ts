/**
 * Evidence from the replay's own job logs.
 *
 * The harness does the repeatable part for every project: download each sample's job logs, extract every
 * GitHub Actions cache restore/save the steps logged, and bind cache provenance from the repository's cache
 * list. A small project extractor turns the same logs into test verdicts, semantic obligations and check
 * coverage. The output is a `SampleEvidence` bundle for `bench verify`, with every source file hashed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { parseBuildkitLog } from './buildkit-log.ts'
import type { ObservedCacheEvent } from './cache-lifecycle.ts'
import type { SampleMeasurementResult, TriggerCorrelationQuery } from './collector.ts'
import { computeSha256, replayBranchOf } from './config.ts'
import type { SampleEvidence } from './evidence.ts'
import { countedSamples, isSeedOf, slotSampleId } from './manifest.ts'
import type { TestCaseVerdictRecord } from './parity.ts'
import type { PreparedExperiment } from './prepared.ts'
import type { ExperimentRecord } from './runtime.ts'
import type { BenchmarkConfig, ScenarioConfig } from './types.ts'
import { unitCoverage } from './collectors.ts'

export interface EvidenceJob {
  workflowPath: string
  jobName: string
  logicalJobId: string
  runId: number
  jobId: number
  conclusion: string | null
  steps: { name: string; conclusion: string | null }[]
  /** Job log with timestamps and ANSI escapes removed. */
  log: string
}

export interface ExtractedEvidence {
  tests: TestCaseVerdictRecord[]
  /** Check coverage: the verification units the selection requires, and the ones that passed. */
  coverage?: { scope: string[]; covered: string[] }
  obligations: string[]
  commands: string[]
}

export type EvidenceExtractor = (input: {
  scenario: ScenarioConfig
  sample: SampleMeasurementResult
  jobs: EvidenceJob[]
}) => ExtractedEvidence

export interface CachedEntry {
  key: string
  ref: string
  created_at: string
}

export function cleanLog(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => stripVTControlCharacters(line.replace(/^(?:\uFEFF)?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')))
    .join('\n')
}

/** `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Cache restores and saves exactly as actions/cache and setup actions log them. */
export function parseCacheLog(log: string): {
  restores: { cacheKey: string; restoreKeys: string[]; matchedKey: string | null; exact: boolean; action: string }[]
  saves: string[]
} {
  const restores: ReturnType<typeof parseCacheLog>['restores'] = []
  const saves: string[] = []
  let action = ''
  let key: string | undefined
  let restoreKeys: string[] = []
  let readingRestoreKeys = false
  let lastHitExact: boolean | undefined
  for (const line of log.split('\n')) {
    if (line.startsWith('##[group]Run ')) {
      action = line.slice('##[group]Run '.length).trim()
      key = undefined
      restoreKeys = []
      readingRestoreKeys = false
      lastHitExact = undefined
      continue
    }
    const input = /^ {2}([\w-]+): ?(.*)$/.exec(line)
    if (input) {
      readingRestoreKeys = input[1] === 'restore-keys'
      if (input[1] === 'key') key = input[2]
      if (readingRestoreKeys && input[2]) restoreKeys.push(input[2])
      continue
    }
    if (readingRestoreKeys && line && !line.startsWith('##[') && !line.startsWith(' ')) {
      restoreKeys.push(line.trim())
      continue
    }
    readingRestoreKeys = false
    let match = /^Cache hit for(?: restore-key)?: (.+)$/.exec(line)
    if (match) {
      lastHitExact = !line.includes('restore-key')
      continue
    }
    match = /^Cache restored from key: (.+)$/.exec(line)
    if (match?.[1]) {
      const matched = match[1].trim()
      restores.push({
        cacheKey: key ?? matched,
        restoreKeys: [...restoreKeys],
        matchedKey: matched,
        exact: lastHitExact ?? (key !== undefined && key === matched),
        action,
      })
      continue
    }
    match = /^Cache not found for input keys: (.+)$/.exec(line)
    if (match?.[1]) {
      const keys = match[1].split(',').map((k) => k.trim())
      restores.push({
        cacheKey: key ?? keys[0] ?? '',
        restoreKeys: restoreKeys.length ? [...restoreKeys] : keys.slice(1),
        matchedKey: null,
        exact: false,
        action,
      })
      continue
    }
    match = /^Cache saved with key: (.+)$/.exec(line)
    if (match?.[1]) saves.push(match[1].trim())
  }
  return { restores, saves }
}

/** Cache restores bound to the ref that produced the matched cache, and to the sample when it produced it. */
export function observeCacheEvents(params: {
  sample: SampleMeasurementResult
  jobs: EvidenceJob[]
  caches: CachedEntry[]
}): ObservedCacheEvent[] {
  const starts = params.sample.workflows.map((w) => (w.startedAt ? Date.parse(w.startedAt) : Number.NaN))
  const sampleStart = Math.min(...starts.filter((t) => !Number.isNaN(t)))
  const events: ObservedCacheEvent[] = []
  for (const job of params.jobs) {
    for (const build of parseBuildkitLog(job.log)) {
      // A build that never mentions a gha cache is not observed: its layer cache is not Actions-managed.
      if (!build.cacheImports.length && !build.cacheExports) continue
      const imported = build.cacheImports.find((i) => !i.failed)
      // A hit needs both a successful import and a step BuildKit restored; CACHED alone may be in-build reuse.
      const hit = imported !== undefined && build.cached > 0
      const gha = params.caches.filter((c) => /^(index-|buildkit-blob-)/.test(c.key))
      // Prefer an entry that existed before the sample (a seed's), as the one that served the import.
      const entry = gha.find((c) => Date.parse(c.created_at) < sampleStart) ?? gha[0]
      events.push({
        cacheKey: 'buildkit-gha',
        requestedRestoreKeys: [],
        matchedKey: hit ? imported.id : null,
        hitKind: hit ? 'exact' : 'miss',
        sourceRef: hit ? (entry?.ref ?? 'unknown') : 'unknown',
        buildkit: {
          done: build.done,
          cached: build.cached,
          error: build.error,
          imported: imported !== undefined,
          exported: build.cacheExports > 0,
        },
      })
    }
    for (const restore of parseCacheLog(job.log).restores) {
      const entry = restore.matchedKey ? params.caches.find((c) => c.key === restore.matchedKey) : undefined
      const createdInSample = entry ? Date.parse(entry.created_at) >= sampleStart : false
      events.push({
        cacheKey: restore.cacheKey,
        requestedRestoreKeys: restore.restoreKeys,
        matchedKey: restore.matchedKey,
        hitKind: restore.matchedKey === null ? 'miss' : restore.exact ? 'exact' : 'restore-key-fallback',
        sourceRef: entry?.ref ?? 'unknown',
        ...(createdInSample ? { producerSampleId: params.sample.sampleId, producerRunId: job.runId } : {}),
      })
    }
  }
  return events
}

export interface CollectEvidenceDeps {
  downloadLog: (jobId: number) => Promise<string>
  listCaches: () => Promise<CachedEntry[]>
  /** Every workflow run in the repository created since the experiment started. */
  listRuns?: () => Promise<RepositoryRun[]>
}

export interface RepositoryRun {
  id: number
  path: string
  event: string
  conclusion?: string | null
  run_started_at: string | null
  updated_at: string
}

/** `bench evidence` writes interference next to the experiment record; reports read it from beside their input. */
export const INTERFERENCE_FILE = 'interference.json'

export function loadInterference(directory: string): Record<string, string[]> | undefined {
  const path = join(directory, INTERFERENCE_FILE)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>) : undefined
}

/**
 * Runs outside a sample that overlapped its execution window (scheduled crons, managed Dependabot runs,
 * manual runs). They compete for runners, so an overlapped sample does not count toward pairs.
 */
export function findInterference(samples: SampleMeasurementResult[], runs: RepositoryRun[]): Record<string, string[]> {
  const own = new Set(samples.flatMap((s) => s.workflows.map((w) => w.runId)))
  const result: Record<string, string[]> = {}
  for (const sample of samples) {
    const starts = sample.workflows.map((w) => Date.parse(w.startedAt ?? '')).filter((t) => !Number.isNaN(t))
    const ends = sample.workflows.map((w) => Date.parse(w.completedAt ?? '')).filter((t) => !Number.isNaN(t))
    if (!starts.length || !ends.length) continue
    const [from, to] = [Math.min(...starts), Math.max(...ends)]
    const overlapping = runs.filter((run) => {
      // A run whose jobs were all skipped never held a runner.
      if (own.has(run.id) || !run.run_started_at || run.conclusion === 'skipped') return false
      const started = Date.parse(run.run_started_at)
      // Staging cancels every active managed (dynamic/) run right before the event; that cancellation can land
      // seconds after the sample starts. A managed run that started during the sample still counts.
      if (run.path.startsWith('dynamic/') && run.conclusion === 'cancelled' && started <= from) return false
      return started < to && Date.parse(run.updated_at) > from
    })
    if (overlapping.length) result[sample.sampleId] = overlapping.map((r) => `${r.path} (${r.event}, run ${r.id})`)
  }
  return result
}

/**
 * The refs a sample's runs restore caches as, under GitHub's cache scoping. A PR replay runs as the benchmark
 * repository's own PR (its merge ref and its base branch, the upstream PR's base); other events run on the
 * replay branch.
 */
export function cacheConsumerRefs(params: {
  scenario: ScenarioConfig
  replayBranch: string
  /** The replay PR in the benchmark repository, from the sample's correlation query. */
  replayPrNumber: number | undefined
}): { consumerRef: string; consumerBaseRef?: string } {
  const { scenario, replayBranch, replayPrNumber } = params
  if (!scenario.pr) return { consumerRef: `refs/heads/${replayBranch}` }
  if (replayPrNumber === undefined) throw new Error(`No replay PR is recorded for scenario ${scenario.name}`)
  return { consumerRef: `refs/pull/${replayPrNumber}/merge`, consumerBaseRef: `refs/heads/${scenario.pr.baseRef}` }
}

/** The cache list right after a sample: the next sample's pre-reset snapshot, or the live list for the last one. */
function cachesAfter(record: ExperimentRecord, sampleId: string, live: () => Promise<CachedEntry[]>) {
  const order = record.manifest.samples.map((s) => s.sampleId)
  for (const next of order.slice(order.indexOf(slotSampleId(sampleId)) + 1)) {
    const snapshot = record.cacheSnapshots[next]
    if (snapshot) return Promise.resolve(snapshot as CachedEntry[])
  }
  return live()
}

export async function collectEvidence(params: {
  record: ExperimentRecord
  prepared: PreparedExperiment
  config: BenchmarkConfig
  extractor: EvidenceExtractor
  directory: string
  deps: CollectEvidenceDeps
}): Promise<{
  evidencePath: string
  evidence: SampleEvidence[]
  summaries: Record<string, ExtractedEvidence>
  interference: Record<string, string[]>
}> {
  const { record, prepared, config, directory } = params
  const logsDir = join(directory, 'logs')
  const evidenceDir = join(directory, 'evidence')
  mkdirSync(logsDir, { recursive: true })
  mkdirSync(evidenceDir, { recursive: true })
  const log = async (jobId: number) => {
    const path = join(logsDir, `${jobId}.log`)
    if (existsSync(path)) return cleanLog(readFileSync(path, 'utf8'))
    const raw = await params.deps.downloadLog(jobId)
    writeFileSync(path, raw)
    return cleanLog(raw)
  }
  const replayPrNumber = (sampleId: string) => {
    const path = join(directory, `${sampleId}.query.json`)
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as TriggerCorrelationQuery).prNumber : undefined
  }
  const evidence: SampleEvidence[] = []
  const summaries: Record<string, ExtractedEvidence> = {}
  for (const sample of countedSamples(record.samples)) {
    const scenario = config.scenarios[sample.scenarioName]
    const payload = prepared.variants[sample.scenarioName]?.[sample.variant]
    const profile = config.profiles[sample.profileName]
    if (!scenario || !payload || !profile) throw new Error(`Unknown sample context: ${sample.sampleId}`)
    const executed = sample.workflows.flatMap((workflow) =>
      workflow.jobs.filter((job) => job.conclusion !== 'skipped').map((job) => ({ workflow, job })),
    )
    const jobs: EvidenceJob[] = await mapConcurrent(executed, 4, async ({ workflow, job }) => ({
      workflowPath: workflow.workflowPath,
      jobName: job.jobName,
      logicalJobId: job.logicalJobId,
      runId: workflow.runId,
      jobId: job.jobRecordId,
      conclusion: job.conclusion,
      steps: job.steps.map((s) => ({ name: s.name, conclusion: s.conclusion })),
      log: await log(job.jobRecordId),
    }))
    // Strings cut from a log can be V8 slices that keep the whole log alive; copies let each sample's logs be freed.
    const extracted = structuredClone(params.extractor({ scenario, sample, jobs }))
    summaries[sample.sampleId] = extracted
    const cacheEvents = structuredClone(
      observeCacheEvents({ sample, jobs, caches: await cachesAfter(record, sample.sampleId, params.deps.listCaches) }),
    )
    const sampleDir = join(evidenceDir, sample.sampleId)
    mkdirSync(sampleDir, { recursive: true })
    const write = (name: string, value: unknown) => {
      const content = `${JSON.stringify(value, null, 2)}\n`
      writeFileSync(join(sampleDir, name), content)
      return { path: `${sample.sampleId}/${name}`, sha256: computeSha256(content) }
    }
    const sources: SampleEvidence['sources'] = [
      { ...write('tests.json', { tests: extracted.tests }), kind: 'tests', format: 'json-verdicts' },
      { ...write('cache.json', { cacheEvents }), kind: 'cache' },
    ]
    if (extracted.coverage)
      sources.push({ ...write('coverage.json', extracted.coverage), kind: 'coverage', format: 'units' })
    const rows: Record<string, number> = {}
    for (const job of jobs) {
      const key = `${job.workflowPath}#${job.logicalJobId}`
      rows[key] = (rows[key] ?? 0) + 1
    }
    const seeds = record.seedSamples.filter((s) => isSeedOf(s.sampleId, sample.sampleId))
    evidence.push({
      sampleId: sample.sampleId,
      inputFingerprint: record.manifest.inputFingerprint,
      runIds: sample.workflows.map((w) => w.runId),
      sources,
      execution: {
        inventory: payload.inventory,
        semanticObligationsFulfilled: extracted.obligations,
        executedWorkflows: sample.workflows.map((w) => w.workflowPath),
        executedMatrixRowCounts: rows,
        observedCommands: extracted.commands,
        jobOutputs: {},
        tests: extracted.tests,
        ...(extracted.coverage ? { coverage: unitCoverage(extracted.coverage) } : {}),
      },
      cache: {
        sampleId: sample.sampleId,
        profile,
        expectedSourceSha: config.upstream.commitSha,
        ...cacheConsumerRefs({
          scenario,
          replayBranch: replayBranchOf(config),
          replayPrNumber: replayPrNumber(sample.sampleId),
        }),
        defaultBranch: config.benchmarkRepository.defaultBranch,
        cacheEvents,
        // Every executed job's log was scanned, so an empty list means no step used the Actions cache.
        inventoryVerified: true,
        coldSeedTotalSeconds: seeds.reduce((n, s) => n + (s.metrics.rawRunnerSeconds ?? 0), 0),
        warmSampleTotalSeconds: sample.metrics.rawRunnerSeconds ?? 0,
      },
    })
  }
  const evidencePath = join(evidenceDir, 'evidence.json')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  // Seed runs belong to the experiment too; only runs outside every sample count as interference.
  const interference = params.deps.listRuns
    ? findInterference(
        record.samples,
        (await params.deps.listRuns()).filter(
          (run) => !record.seedSamples.some((s) => s.workflows.some((w) => w.runId === run.id)),
        ),
      )
    : {}
  writeFileSync(join(directory, INTERFERENCE_FILE), `${JSON.stringify(interference, null, 2)}\n`)
  return { evidencePath, evidence, summaries, interference }
}
