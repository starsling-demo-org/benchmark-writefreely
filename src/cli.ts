import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  BENCH_COMMANDS,
  type BenchCommandName,
  defaultPreparedDir,
  executeBenchInspect,
  executeBenchRecover,
  loadConfig,
  loadExperimentInput,
} from './commands.ts'
import { resolvePatchStack, validateBenchmarkConfig } from './config.ts'
import { type SampleEvidence, verifyEvidenceBundle } from './evidence.ts'
import { type CachedEntry, collectEvidence, type EvidenceExtractor, loadInterference } from './evidence-collect.ts'
import { GitHubClient, nullableString } from './github.ts'
import { classifyRunnerLabels, findExternalSideEffects } from './init.ts'
import { runInitCommand } from './init-command.ts'
import { countedSamples, reconcileSamples, unfilledSlots } from './manifest.ts'
import { NativeReplayBackend } from './native-backend.ts'
import { githubPatchResolver } from './patch-resolver.ts'
import { protectedBranchesOf } from './protected-branches.ts'
import { type PreparedExperiment, prepareExperiment, verifyPrepared } from './prepared.ts'
import { clearPublishState, publishShowcase, type ShowcaseFile } from './publish.ts'
import { describeReferenceComparison } from './reference.ts'
import { loadReferences, writeScenarioReferences } from './reference-files.ts'
import type { ExperimentApiUsage } from './api-budget.ts'
import { type BenchmarkExperimentReport, generateExperimentReport } from './reporter.ts'
import { type ExperimentRecord, runNativeExperiment, writeJson } from './runtime.ts'
import { type FixArmInfo, mergeFixArmFromDisk } from './fix-arm.ts'
import { renderPendingShowcase, renderShowcase } from './showcase.ts'
import { loadShowcaseNarrative, patchPath } from './showcase-model.ts'
import type { PersistedStagingState } from './staging.ts'
import type { VariantId } from './types.ts'

const HELP = `bench <command> [options]   (run from the benchmark repository's bench/control checkout)

Setup
  init       --upstream OWNER/NAME --sha FULL_SHA --bench-repo OWNER/NAME [--pr N] [--map FROM=TO]... [--history upstream] [--no-fetch] [--force]
             Discover PR/main scenarios and upstream reference runs, fetch the pinned source, write
             benchmark.config.json, showcase.json and patches/.
  reference  Fetch the locked upstream reference runs (jobs and steps) into reference/<scenario>.json.
  inspect    Inventory workflows per scenario; list blockers, native conditions and runner labels. [--full]
  prepare    Materialize the four variant payloads (idempotent per config + harness).

Execution
  run        --experiment ID [--scenarios a,b] [--profiles cold,warm] [--variants v1,v2] [--repetitions N]
  collect    --experiment ID   Resume observation of dispatched samples without dispatching new ones.
  recover    --experiment ID [--sample SAMPLE_ID]   Restore refs/workflows after an interrupted sample.

Evidence and results
  parity     --experiment ID   Compare baseline replays job-by-job with the upstream reference.
  evidence   --experiment ID [--extractor collectors/evidence.ts]   Build test, check-coverage and cache
             evidence from the samples' job logs.
  verify     [--experiment ID --evidence evidence.json]   Verify preparation, or bind evidence to samples.
  report     --experiment ID [--out DIR]   JSON, CSV and Markdown report.
  showcase   --experiment ID [--fix-arm-experiment ID] [--write README.md] [--layout default|showcase]   Render the README showcase.
             --fix-arm-experiment takes the StarSling + agent PRs arm from a second record (same scenarios, profiles, harness and config but patches).
  publish    --experiment ID   Commit the showcase to the default branch under the repository lease.

Common options
  --config benchmark.config.json   --repo .bench-work/upstream   --work-dir <prepared dir>
  --out DIR (report output; the experiment directory when --experiment is not given)
  --input <experiment or assessed JSON>   --reference-dir reference
`

/** Runs one command; null when only the help text was printed. */
async function main(args: string[]): Promise<{ command: BenchCommandName; ok: boolean; data: unknown } | null> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      config: { type: 'string' },
      repo: { type: 'string' },
      'work-dir': { type: 'string' },
      prepared: { type: 'string' },
      experiment: { type: 'string' },
      'fix-arm-experiment': { type: 'string' },
      out: { type: 'string' },
      input: { type: 'string' },
      evidence: { type: 'string' },
      'reference-dir': { type: 'string' },
      extractor: { type: 'string' },
      write: { type: 'string' },
      layout: { type: 'string' },
      scenarios: { type: 'string' },
      profiles: { type: 'string' },
      variants: { type: 'string' },
      repetitions: { type: 'string' },
      scenario: { type: 'string' },
      variant: { type: 'string' },
      sample: { type: 'string' },
      upstream: { type: 'string' },
      sha: { type: 'string' },
      'bench-repo': { type: 'string' },
      pr: { type: 'string' },
      map: { type: 'string', multiple: true },
      'no-fetch': { type: 'boolean' },
      force: { type: 'boolean' },
      history: { type: 'string' },
      full: { type: 'boolean' },
    },
  })
  const command = positionals[0] as BenchCommandName | undefined
  if (!command || values.help || (command as string) === 'help') {
    process.stdout.write(HELP)
    return null
  }
  if (!BENCH_COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}`)
  const required = (name: keyof typeof values): string => {
    const value = values[name]
    if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`)
    return value
  }
  const repetitions = values.repetitions === undefined ? undefined : Number(values.repetitions)
  if (repetitions !== undefined && !(Number.isSafeInteger(repetitions) && repetitions > 0))
    throw new Error(`--repetitions must be a positive integer, got "${values.repetitions}"`)
  const root = process.cwd()
  const defaultConfigPath = existsSync(join(root, 'benchmark.config.json'))
    ? join(root, 'benchmark.config.json')
    : join(root, 'benchmark.config.ts')
  const configPath = resolve(values.config ?? defaultConfigPath)
  const referenceDir = resolve(values['reference-dir'] ?? join(dirname(configPath), 'reference'))
  const defaultSource = join(root, '.bench-work', 'upstream')
  const repoDir = resolve(values.repo ?? (existsSync(defaultSource) ? defaultSource : '.'))

  if (command === 'init') return runInitCommand({ values, root, configPath, referenceDir, defaultSource })

  const config = await loadConfig(configPath)
  const workDir = resolve(values['work-dir'] ?? defaultPreparedDir(root, config))
  const preparedPath = resolve(values.prepared ?? join(workDir, 'prepared.json'))
  // The showcase names its headline experiment, so report/showcase/publish need no flags in CI.
  const narrative = loadShowcaseNarrative(join(dirname(configPath), 'showcase.json'))
  if (
    !values.experiment &&
    !values.input &&
    narrative.experiment &&
    ['parity', 'report', 'showcase', 'publish'].includes(command)
  )
    values.experiment = narrative.experiment
  // --experiment names the experiment directory; --out is an output location (report files, assessed JSON) and
  // names the experiment directory only when --experiment is absent.
  const experimentDir = values.experiment
    ? join(root, 'experiments', values.experiment)
    : values.out
      ? resolve(values.out)
      : undefined
  const inputPath = (): string => {
    if (values.input) return resolve(values.input)
    if (!experimentDir) throw new Error('Missing --experiment (or --input)')
    const assessed = join(experimentDir, 'assessed.json')
    return existsSync(assessed) ? assessed : join(experimentDir, 'experiment.json')
  }
  const references = () => loadReferences(referenceDir)
  let fixArm: FixArmInfo | undefined
  const buildReport = () => {
    const path = inputPath()
    let input = loadExperimentInput(path)
    let interference = loadInterference(dirname(path))
    if (values['fix-arm-experiment']) {
      if (command !== 'showcase') throw new Error('--fix-arm-experiment is only for bench showcase')
      if (!values.experiment || values.input) throw new Error('--fix-arm-experiment needs --experiment (not --input)')
      const merged = mergeFixArmFromDisk(root, path, values['fix-arm-experiment'])
      input = merged.input
      interference = merged.interference
      fixArm = merged.info
    }
    // assessed.json may predate the counts; the experiment record beside it always has them.
    const recordPath = join(dirname(path), 'experiment.json')
    const apiUsage =
      input.apiUsage ??
      (existsSync(recordPath)
        ? (JSON.parse(readFileSync(recordPath, 'utf8')) as { apiUsage?: ExperimentApiUsage }).apiUsage
        : undefined)
    return generateExperimentReport({
      experimentId: input.experimentId,
      samples: input.samples,
      config,
      references: references(),
      ...(interference ? { interference } : {}),
      ...(input.manifest ? { manifest: input.manifest } : {}),
      ...(input.assessments ? { assessments: input.assessments } : {}),
      ...(apiUsage ? { apiUsage } : {}),
    })
  }

  if (command === 'reference') {
    const written = await writeScenarioReferences({
      client: new GitHubClient(config.upstream.repository),
      upstreamRepository: config.upstream.repository,
      scenarios: Object.values(config.scenarios).filter((s) => s.role !== 'seed'),
      directory: referenceDir,
    })
    return { command, ok: written.length > 0, data: { written: written.map((p) => relative(root, p)) } }
  }
  if (command === 'inspect') {
    const result = executeBenchInspect({ upstreamSourceDir: repoDir, config })
    if (values.full) return result
    const inventory = result.data
    return {
      command,
      ok: result.ok,
      data: {
        scenarios: Object.fromEntries(
          Object.entries(inventory.scenarios).map(([name, s]) => [
            name,
            {
              triggeredWorkflows: s.triggeredWorkflows,
              downstreamWorkflowRuns: s.downstreamWorkflowRuns,
              excludedWorkflows: s.excludedWorkflows,
              jobs: {
                executed: s.jobExpectations
                  .filter((j) => j.expectedStatus === 'executed')
                  .map((j) => `${j.workflowFile}#${j.jobId}`),
                conditional: s.jobExpectations
                  .filter((j) => j.expectedStatus === 'conditional')
                  .map((j) => `${j.workflowFile}#${j.jobId}`),
                skipped: s.jobExpectations
                  .filter((j) => j.expectedStatus === 'skipped')
                  .map((j) => `${j.workflowFile}#${j.jobId}: ${j.skipReason ?? ''}`),
              },
              retainedOnGitHub: s.retainedJobs,
              nativeConditions: s.nativeConditions ?? [],
            },
          ]),
        ),
        runnerLabels: classifyRunnerLabels(inventory, config.runnerMapping),
        sideEffects: findExternalSideEffects(inventory, config.adaptations),
        blockers: inventory.blockers,
      },
    }
  }
  const loadPrepared = () => JSON.parse(readFileSync(preparedPath, 'utf8')) as PreparedExperiment
  if (command === 'prepare') {
    if (existsSync(preparedPath)) {
      const prepared = loadPrepared()
      verifyPrepared(prepared, config)
      return {
        command,
        ok: true,
        data: { prepared: relative(root, preparedPath), inputFingerprint: prepared.inputFingerprint, reused: true },
      }
    }
    const blockers = validateBenchmarkConfig(config).filter((b) => b.category !== 'unresolved_moving_url')
    if (blockers.length) throw new Error(blockers.map((b) => b.evidence).join('; '))
    const patches = await resolvePatchStack(config.patches, dirname(configPath), githubPatchResolver)
    const prepared = prepareExperiment({ source: repoDir, workDir, config, patches })
    return {
      command,
      ok: true,
      data: {
        prepared: relative(root, preparedPath),
        inputFingerprint: prepared.inputFingerprint,
        scenarios: Object.fromEntries(
          Object.entries(prepared.variants).map(([name, map]) => [
            name,
            Object.fromEntries(
              Object.entries(map).map(([variant, v]) => [
                variant,
                { movedJobs: v.lock.movedJobs.length, retainedJobs: v.lock.retainedJobs },
              ]),
            ),
          ]),
        ),
      },
    }
  }
  if (command === 'parity') {
    // The same per-event decision the report, the README claim checklist and the Actions summary use.
    const parity = buildReport().upstreamParityByScenario
    const refs = references()
    // Seed-only scenarios (cache producers) have no upstream event to compare with.
    const missing = Object.entries(config.scenarios)
      .filter(([name, scenario]) => scenario.role !== 'seed' && !refs[name])
      .map(([name]) => name)
    return {
      command,
      ok:
        Object.keys(parity).length > 0 &&
        missing.length === 0 &&
        Object.values(parity).every((p) => p.passed || p.baselineIncludesPatches?.length),
      data: {
        missingReferences: missing,
        unchecked: Object.entries(parity)
          .filter(([, p]) => p.referenceAvailable && !p.comparisons.length)
          .map(([name]) => name),
        comparisons: Object.values(parity)
          .flatMap((p) => p.comparisons)
          .map((c) => ({ ...c, nextActions: describeReferenceComparison(c) })),
      },
    }
  }
  if (command === 'report') {
    const report = buildReport()
    if (values.out) {
      const out = resolve(values.out)
      mkdirSync(out, { recursive: true })
      writeJson(join(out, 'report.json'), report)
      writeFileSync(join(out, 'report.md'), report.markdownSummary)
      writeFileSync(join(out, 'samples.csv'), report.csvContent)
    }
    return { command, ok: report.manifestIssues.length === 0, data: report }
  }
  // The benchmark page always carries the pinned upstream as a submodule.
  const upstreamFiles: ShowcaseFile[] = [
    {
      path: '.gitmodules',
      content: `[submodule "upstream"]\n\tpath = upstream\n\turl = https://github.com/${config.upstream.repository}.git\n`,
    },
    { path: 'upstream', gitlink: config.upstream.commitSha },
  ]
  const publish = async (files: ShowcaseFile[], label: string) => {
    const stateDir = experimentDir ?? join(root, '.bench-work', 'publish')
    const result = await publishShowcase({
      client: new GitHubClient(config.benchmarkRepository.repository),
      defaultBranch: config.benchmarkRepository.defaultBranch,
      protectedBranches: protectedBranchesOf(config),
      files: [...files, ...upstreamFiles],
      message: `showcase: ${label}`,
      stateDir,
      owner: `publish-${label}`,
    })
    clearPublishState(stateDir)
    return result
  }
  if (command === 'publish' && !experimentDir && !values.input) {
    // Before the first experiment the benchmark page says what is being measured.
    const readme = renderPendingShowcase({ config, narrative })
    return { command, ok: true, data: await publish([{ path: 'README.md', content: readme }], 'pending') }
  }
  if (command === 'showcase' || command === 'publish') {
    const report = buildReport()
    // Resolving checks every patch against its locked hash, for the showcase as well as for publishing.
    const patches = await resolvePatchStack(config.patches, dirname(configPath), githubPatchResolver)
    if (values.layout !== undefined && values.layout !== 'default' && values.layout !== 'showcase')
      throw new Error(`--layout must be "default" or "showcase", not "${values.layout}"`)
    const layoutNarrative = values.layout
      ? { ...narrative, layout: values.layout as 'default' | 'showcase' }
      : narrative
    // The showcase layout reads each agent PR's numbers from its own per-lever experiment; one that is not on disk
    // is left out, and its row prints as "not measured".
    const leverReports: Record<string, BenchmarkExperimentReport> = {}
    if (layoutNarrative.layout === 'showcase')
      for (const id of new Set((narrative.agentPrs ?? []).flatMap((e) => (e.experiment ? [e.experiment.id] : [])))) {
        const dir = join(root, 'experiments', id)
        const assessed = join(dir, 'assessed.json')
        const path = existsSync(assessed) ? assessed : join(dir, 'experiment.json')
        if (!existsSync(path)) continue
        const input = loadExperimentInput(path)
        const interference = loadInterference(dir)
        leverReports[id] = generateExperimentReport({
          experimentId: input.experimentId,
          samples: input.samples,
          config,
          references: references(),
          ...(interference ? { interference } : {}),
          ...(input.manifest ? { manifest: input.manifest } : {}),
          ...(input.assessments ? { assessments: input.assessments } : {}),
        })
      }
    const readme = renderShowcase({
      report,
      config,
      narrative: layoutNarrative,
      leverReports,
      ...(fixArm ? { fixArm } : {}),
    })
    if (command === 'showcase') {
      const target = resolve(values.write ?? join(experimentDir ?? root, 'README.md'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readme)
      return {
        command,
        ok: true,
        data: {
          written: relative(root, target),
          publishable: report.comparisons.every((c) => c.publishableHeadlineAllowed),
        },
      }
    }
    const { markdownSummary: _markdown, csvContent, ...results } = report
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
    const files: ShowcaseFile[] = [
      { path: 'README.md', content: readme },
      ...patches.map((p) => ({ path: patchPath(p.id), content: p.patchContent })),
      { path: 'benchmark/results.json', content: json(results) },
      { path: 'benchmark/samples.csv', content: csvContent },
      { path: 'benchmark/config.json', content: json(config) },
      ...Object.values(references()).map((r) => ({
        path: `benchmark/reference/${r.scenarioName}.json`,
        content: json(r),
      })),
    ]
    return { command, ok: true, data: await publish(files, report.experimentId) }
  }

  const prepared = loadPrepared()
  const loadRecord = (path: string): ExperimentRecord => {
    const record = JSON.parse(readFileSync(path, 'utf8')) as ExperimentRecord
    if (record.manifest.inputFingerprint !== prepared.inputFingerprint)
      throw new Error('Experiment does not match the prepared payload')
    return record
  }
  // run/collect verify inside the runtime; hashing every payload twice costs minutes on large repositories.
  // Evidence commands read only prepared metadata, which the input fingerprint binds, so they skip the trees.
  const evidenceOnly = command === 'evidence' || (command === 'verify' && Boolean(values.evidence))
  if (command !== 'run' && command !== 'collect')
    verifyPrepared(prepared, config, { recovery: command === 'recover' || evidenceOnly, metadataOnly: evidenceOnly })
  if (command === 'evidence') {
    if (!experimentDir) throw new Error('Missing --experiment')
    const directory = experimentDir
    const record = loadRecord(join(directory, 'experiment.json'))
    const extractorPath = resolve(values.extractor ?? join(dirname(configPath), 'collectors', 'evidence.ts'))
    const extractor = (await import(pathToFileURL(extractorPath).href)).default as EvidenceExtractor
    if (typeof extractor !== 'function') throw new Error(`${extractorPath} must default-export an extractor`)
    const client = new GitHubClient(config.benchmarkRepository.repository)
    const result = await collectEvidence({
      record,
      prepared,
      config,
      extractor,
      directory,
      deps: {
        downloadLog: (jobId) => client.downloadJobLog(jobId),
        listCaches: async () => (await client.all('actions/caches', 'actions_caches')) as CachedEntry[],
        listRuns: async () => {
          // Every run created on or after the day (UTC) the first sample started.
          const firstStart = record.samples
            .flatMap((s) => s.workflows.map((w) => w.startedAt ?? ''))
            .filter(Boolean)
            .sort()[0]
          return (await client.runsCreatedSince(firstStart?.slice(0, 10) ?? '')).map((run) => ({
            id: Number(run.id),
            path: String(run.path),
            event: String(run.event),
            conclusion: nullableString(run.conclusion),
            run_started_at: nullableString(run.run_started_at),
            updated_at: String(run.updated_at),
          }))
        },
      },
    })
    return {
      command,
      ok: true,
      data: {
        written: relative(root, result.evidencePath),
        samples: Object.fromEntries(
          Object.entries(result.summaries).map(([id, s]) => [
            id,
            {
              tests: s.tests.map((t) => `${t.testId}:${t.verdict}`),
              obligations: s.obligations,
              coverage: s.coverage ? `${s.coverage.covered.length}/${s.coverage.scope.length}` : null,
              interference: result.interference[id] ?? [],
              cacheEvents: result.evidence
                .find((e) => e.sampleId === id)
                ?.cache.cacheEvents.map((e) => `${e.cacheKey}:${e.hitKind}@${e.sourceRef}`),
            },
          ]),
        ),
        nextAction: `bench verify --experiment ${record.manifest.experimentId} --evidence ${relative(root, result.evidencePath)}`,
      },
    }
  }
  if (command === 'verify') {
    if (!values.evidence)
      return {
        command,
        ok: true,
        data: {
          preparationVerified: true,
          inputFingerprint: prepared.inputFingerprint,
          parityVerified: false,
          note: 'Supply --experiment ID --evidence evidence.json to bind test, coverage and cache evidence.',
        },
      }
    const recordPath = values.input ? resolve(values.input) : join(experimentDir ?? root, 'experiment.json')
    const record = loadRecord(recordPath)
    const evidencePath = resolve(required('evidence'))
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as SampleEvidence[]
    const assessments = await verifyEvidenceBundle({
      manifest: record.manifest,
      samples: record.samples,
      evidence,
      profiles: config.profiles,
      readSource: async (path) => readFileSync(resolve(dirname(evidencePath), path)),
    })
    const assessed = { ...record, experimentId: record.manifest.experimentId, assessments }
    const unassessed = countedSamples(record.samples)
      .filter((s) => !assessments[s.sampleId])
      .map((s) => ({
        sampleId: s.sampleId,
        reason: `No ${s.variant.startsWith('github-') ? 'github' : 'starsling'}-baseline sample in the same round to compare with`,
      }))
    const target = values.out?.endsWith('.json')
      ? resolve(values.out)
      : experimentDir
        ? join(experimentDir, 'assessed.json')
        : undefined
    if (target) writeJson(target, assessed)
    return {
      command,
      ok:
        Object.values(assessments).length > 0 &&
        unassessed.length === 0 &&
        Object.values(assessments).every((a) => a.parity.passed && a.cache.valid),
      data: target ? { written: relative(root, target), assessments, unassessed } : { ...assessed, unassessed },
    }
  }
  const experimentId = required('experiment')
  const directory = experimentDir ?? join(root, 'experiments', experimentId)
  if (command === 'recover') {
    // Default to the sample whose staging did not finish; its journal names the scenario and variant.
    const sampleId = values.sample ?? findUnfinishedSample(directory)
    const state = readStagingState(join(directory, `${sampleId}.staging.json`))
    const scenario = values.scenario ?? state.scenarioName
    const variant = (values.variant as VariantId | undefined) ?? state.variant
    const payload = prepared.variants[scenario]?.[variant]
    if (!payload) throw new Error('Unknown scenario/variant')
    return executeBenchRecover({
      stagingStateFilePath: join(directory, `${sampleId}.staging.json`),
      replayBackend: new NativeReplayBackend(
        new GitHubClient(config.benchmarkRepository.repository),
        payload,
        join(directory, 'controller.json'),
        experimentId,
      ),
    })
  }
  const data = await runNativeExperiment({
    config,
    prepared,
    directory,
    experimentId,
    ...(values.scenarios ? { scenarioNames: values.scenarios.split(',') } : {}),
    ...(values.profiles ? { profileNames: values.profiles.split(',') } : {}),
    ...(values.variants ? { variants: values.variants.split(',') as VariantId[] } : {}),
    ...(repetitions !== undefined ? { repetitions } : {}),
    collectOnly: command === 'collect',
  })
  return {
    command,
    ok:
      reconcileSamples(data.manifest, data.samples).length === 0 &&
      unfilledSlots(data.manifest, data.samples).length === 0,
    data: {
      experiment: relative(root, join(directory, 'experiment.json')),
      samples: data.samples.map((s) => ({
        sampleId: s.sampleId,
        complete: s.complete,
        wallClockSeconds: s.metrics.wallClockSeconds,
        repoMinutes: s.metrics.repoMinutes,
        incompleteReasons: s.incompleteReasons,
      })),
      nextAction: 'Run bench parity, then bench report / bench showcase.',
    },
  }
}

const readStagingState = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as PersistedStagingState

function findUnfinishedSample(directory: string): string {
  const unfinished = readdirSync(directory)
    .filter((file) => file.endsWith('.staging.json'))
    .filter((file) => {
      const step = readStagingState(join(directory, file)).currentStep
      return step !== 'completed' && step !== 'recovered' && step !== 'superseded'
    })
  if (unfinished.length !== 1)
    throw new Error(`Expected one unfinished sample in ${directory}, found ${unfinished.length}; pass --sample`)
  return (unfinished[0] as string).replace(/\.staging\.json$/, '')
}

export async function runCli(argv: string[]): Promise<void> {
  const args = argv.slice(2)
  let command = (args.find((a) => !a.startsWith('-')) ?? 'help') as BenchCommandName
  try {
    const result = await main(args)
    if (!result) return
    command = result.command
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ command, ok: false, errors: [error instanceof Error ? error.message : String(error)] })}\n`,
    )
    process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void runCli(process.argv)
