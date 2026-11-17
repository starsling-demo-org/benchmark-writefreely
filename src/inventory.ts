import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { parseDocument } from 'yaml'
import { replayBranchOf, validateBenchmarkConfig } from './config.ts'
import { findGitHubRunnerBlockers } from './github-runners.ts'
import { matrixRunsOnField } from './matrix-runners.ts'
import {
  type DependencyStatus,
  evaluateJobIfCondition,
  matchesBranchFilter,
  matchesPathFilter,
  resolveJobRunnerMapping,
  expandMatrix,
  scanJobBlockers,
} from './inventory-helpers.ts'
import type {
  BenchmarkConfig,
  RepositoryInventory,
  ScenarioConfig,
  ScenarioInventory,
  ScenarioJobExpectation,
  SetupBlocker,
  WorkflowFileInventory,
  WorkflowJobInventory,
  WorkflowStepInventory,
} from './types.ts'

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return typeof val === 'object' && val !== null && !Array.isArray(val) ? (val as Record<string, unknown>) : undefined
}

function asStringArray(val: unknown): string[] | undefined {
  if (typeof val === 'string') return [val]
  if (Array.isArray(val)) return val.map((item) => String(item))
  return undefined
}

function extractSecretNames(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
    if (match[1]) names.add(match[1])
  }
  return [...names]
}

export function parseWorkflowYaml(filePath: string, content: string): WorkflowFileInventory {
  const doc = parseDocument(content, { merge: true })
  const raw = asRecord(doc.toJS({ maxAliasCount: -1 })) ?? {}
  const name = typeof raw.name === 'string' ? raw.name : posix.basename(filePath)

  const onRaw = raw.on ?? raw.true
  const events: string[] = []
  const eventFilters: NonNullable<WorkflowFileInventory['triggers']['eventFilters']> = {}
  let pullRequestTypes: string[] | undefined
  let branches: string[] | undefined
  let branchesIgnore: string[] | undefined
  let paths: string[] | undefined
  let pathsIgnore: string[] | undefined
  let workflowRunTrigger: WorkflowFileInventory['triggers']['workflowRunTrigger']

  if (typeof onRaw === 'string') {
    events.push(onRaw)
  } else if (Array.isArray(onRaw)) {
    for (const item of onRaw) events.push(String(item))
  } else {
    const onObj = asRecord(onRaw)
    if (onObj) {
      for (const [evtName, evtCfgRaw] of Object.entries(onObj)) {
        events.push(evtName)
        const evtCfg = asRecord(evtCfgRaw)
        if (!evtCfg) continue
        eventFilters[evtName] = {
          ...(asStringArray(evtCfg.branches) ? { branches: asStringArray(evtCfg.branches) ?? [] } : {}),
          ...(asStringArray(evtCfg['branches-ignore'])
            ? { branchesIgnore: asStringArray(evtCfg['branches-ignore']) ?? [] }
            : {}),
          ...(asStringArray(evtCfg.paths) ? { paths: asStringArray(evtCfg.paths) ?? [] } : {}),
          ...(asStringArray(evtCfg['paths-ignore'])
            ? { pathsIgnore: asStringArray(evtCfg['paths-ignore']) ?? [] }
            : {}),
          ...(asStringArray(evtCfg.types) ? { types: asStringArray(evtCfg.types) ?? [] } : {}),
        }
        if (evtName === 'pull_request' || evtName === 'pull_request_target') {
          pullRequestTypes = asStringArray(evtCfg.types) ?? pullRequestTypes
          branches = asStringArray(evtCfg.branches) ?? branches
          branchesIgnore = asStringArray(evtCfg['branches-ignore']) ?? branchesIgnore
          paths = asStringArray(evtCfg.paths) ?? paths
          pathsIgnore = asStringArray(evtCfg['paths-ignore']) ?? pathsIgnore
        } else if (evtName === 'push') {
          branches = asStringArray(evtCfg.branches) ?? branches
          branchesIgnore = asStringArray(evtCfg['branches-ignore']) ?? branchesIgnore
          paths = asStringArray(evtCfg.paths) ?? paths
          pathsIgnore = asStringArray(evtCfg['paths-ignore']) ?? pathsIgnore
        } else if (evtName === 'workflow_run') {
          const wrBranches = asStringArray(evtCfg.branches)
          workflowRunTrigger = {
            workflows: asStringArray(evtCfg.workflows) ?? [],
            types: asStringArray(evtCfg.types) ?? ['completed'],
            ...(wrBranches ? { branches: wrBranches } : {}),
          }
        }
      }
    }
  }

  const jobsRaw = asRecord(raw.jobs) ?? {}
  const jobs: Record<string, WorkflowJobInventory> = {}
  const reusableWorkflowCalls = new Set<string>()
  const localActionCalls = new Set<string>()

  for (const [jobId, jobVal] of Object.entries(jobsRaw)) {
    const jobObj = asRecord(jobVal)
    if (!jobObj) continue
    const jobJsonText = JSON.stringify(jobObj)
    const referencedSecrets = extractSecretNames(jobJsonText)

    let runsOn: WorkflowJobInventory['runsOn'] = ''
    if (typeof jobObj['runs-on'] === 'string') {
      runsOn = jobObj['runs-on']
    } else if (Array.isArray(jobObj['runs-on'])) {
      runsOn = jobObj['runs-on'].map((x) => String(x))
    } else if (jobObj['runs-on'] && typeof jobObj['runs-on'] === 'object') {
      runsOn = jobObj['runs-on'] as { group?: string; labels?: string | string[] }
    }

    const needs = asStringArray(jobObj.needs) ?? []
    const ifCondition = jobObj.if !== undefined ? String(jobObj.if) : undefined
    const usesReusableWorkflow = typeof jobObj.uses === 'string' ? jobObj.uses : undefined
    if (usesReusableWorkflow) reusableWorkflowCalls.add(usesReusableWorkflow)

    let matrixConfig: WorkflowJobInventory['matrixConfig']
    const strategyObj = asRecord(jobObj.strategy)
    if (strategyObj && strategyObj.matrix !== undefined) {
      const matRaw = strategyObj.matrix
      const failFast = typeof strategyObj['fail-fast'] === 'boolean' ? strategyObj['fail-fast'] : undefined
      if (typeof matRaw === 'string') {
        matrixConfig = {
          isDynamic: true,
          expression: matRaw,
          ...(failFast !== undefined ? { failFast } : {}),
        }
      } else {
        const matObj = asRecord(matRaw)
        const matStr = JSON.stringify(matObj ?? {})
        const isDynamic = matStr.includes('${{')
        const includeArr = Array.isArray(matObj?.include)
          ? (matObj.include.filter((r) => typeof r === 'object' && r !== null) as Record<string, unknown>[])
          : undefined
        matrixConfig = {
          isDynamic,
          ...(isDynamic ? { expression: matStr } : {}),
          ...(!isDynamic ? { staticRows: expandMatrix(matObj ?? {}, includeArr ?? []) } : {}),
          ...(failFast !== undefined ? { failFast } : {}),
        }
      }
    }

    const stepsRaw = Array.isArray(jobObj.steps) ? jobObj.steps : []
    const steps: WorkflowStepInventory[] = []
    const cachesUsed: string[] = []
    const artifactsProduced: string[] = []
    const artifactsConsumed: string[] = []

    stepsRaw.forEach((stepVal, idx) => {
      const st = asRecord(stepVal)
      if (!st) return
      const uses = typeof st.uses === 'string' ? st.uses : undefined
      const run = typeof st.run === 'string' ? st.run : undefined
      const withInputs = asRecord(st.with)

      if (uses?.startsWith('./')) {
        localActionCalls.add(uses)
      }
      if (uses?.startsWith('actions/cache')) {
        const key = withInputs?.key !== undefined ? String(withInputs.key) : `step-${idx}-cache`
        cachesUsed.push(key)
      }
      if (uses?.startsWith('actions/setup-') && withInputs?.cache !== undefined) {
        cachesUsed.push(`setup-cache:${uses}:${String(withInputs.cache)}`)
      }
      if (uses?.startsWith('actions/upload-artifact')) {
        const artName = withInputs?.name !== undefined ? String(withInputs.name) : `artifact-${idx}`
        artifactsProduced.push(artName)
      }
      if (uses?.startsWith('actions/download-artifact')) {
        const artName = withInputs?.name !== undefined ? String(withInputs.name) : '*'
        artifactsConsumed.push(artName)
      }

      const envObj = asRecord(st.env)
      const env: Record<string, string> | undefined = envObj
        ? Object.fromEntries(Object.entries(envObj).map(([k, v]) => [k, String(v)]))
        : undefined

      steps.push({
        index: idx,
        ...(typeof st.id === 'string' ? { id: st.id } : {}),
        ...(typeof st.name === 'string' ? { name: st.name } : {}),
        ...(uses !== undefined ? { uses } : {}),
        ...(run !== undefined ? { run } : {}),
        ...(st.if !== undefined ? { ifCondition: String(st.if) } : {}),
        ...(withInputs !== undefined ? { withInputs } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(typeof st['continue-on-error'] === 'boolean' ? { continueOnError: st['continue-on-error'] } : {}),
      })
    })

    const outputsObj = asRecord(jobObj.outputs)
    const outputs: Record<string, string> | undefined = outputsObj
      ? Object.fromEntries(Object.entries(outputsObj).map(([k, v]) => [k, String(v)]))
      : undefined

    const envField =
      typeof jobObj.environment === 'string'
        ? jobObj.environment
        : typeof asRecord(jobObj.environment)?.name === 'string'
          ? String(asRecord(jobObj.environment)?.name)
          : undefined

    const servicesObj = asRecord(jobObj.services)

    jobs[jobId] = {
      jobId,
      ...(typeof jobObj.name === 'string' ? { name: jobObj.name } : {}),
      runsOn,
      ...matrixRunsOnField(runsOn, jobObj),
      needs,
      ...(ifCondition !== undefined ? { ifCondition } : {}),
      ...(usesReusableWorkflow !== undefined ? { usesReusableWorkflow } : {}),
      ...(matrixConfig !== undefined ? { matrixConfig } : {}),
      ...(outputs !== undefined ? { outputs } : {}),
      steps,
      ...(servicesObj ? { services: servicesObj } : {}),
      ...(jobObj.container !== undefined ? { container: jobObj.container } : {}),
      ...(envField !== undefined ? { environment: envField } : {}),
      ...(jobObj.permissions !== undefined ? { permissions: jobObj.permissions } : {}),
      ...(jobObj.concurrency !== undefined ? { concurrency: jobObj.concurrency } : {}),
      referencedSecrets,
      cachesUsed,
      artifactsProduced,
      artifactsConsumed,
    }
  }

  return {
    filePath,
    name,
    triggers: {
      events,
      eventFilters,
      ...(pullRequestTypes ? { pullRequestTypes } : {}),
      ...(branches ? { branches } : {}),
      ...(branchesIgnore ? { branchesIgnore } : {}),
      ...(paths ? { paths } : {}),
      ...(pathsIgnore ? { pathsIgnore } : {}),
      ...(workflowRunTrigger ? { workflowRunTrigger } : {}),
    },
    ...(raw.concurrency !== undefined ? { concurrency: raw.concurrency } : {}),
    ...(raw.permissions !== undefined ? { permissions: raw.permissions } : {}),
    jobs,
    reusableWorkflowCalls: [...reusableWorkflowCalls],
    localActionCalls: [...localActionCalls],
  }
}

function collectLocalActionsRecursively(repoDir: string, initialCalls: Iterable<string>): string[] {
  const visited = new Set<string>()
  const queue = [...initialCalls]

  while (queue.length > 0) {
    const rel = queue.shift()
    if (!rel) continue
    const normalized = rel.replace(/^\.\//, '')
    if (visited.has(normalized)) continue
    visited.add(normalized)

    for (const candidate of ['action.yml', 'action.yaml']) {
      const fullPath = join(repoDir, normalized, candidate)
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf8')
        const doc = parseDocument(content)
        const obj = asRecord(doc.toJS())
        const runs = asRecord(obj?.runs)
        const steps = Array.isArray(runs?.steps) ? runs.steps : []
        for (const step of steps) {
          const st = asRecord(step)
          if (typeof st?.uses === 'string' && st.uses.startsWith('./')) {
            queue.push(st.uses)
          }
        }
      }
    }
  }

  return [...visited].sort()
}

function topologicallySortJobs(jobs: Record<string, WorkflowJobInventory>): WorkflowJobInventory[] {
  const visited = new Set<string>()
  const sorted: WorkflowJobInventory[] = []

  const visit = (jobId: string) => {
    if (visited.has(jobId)) return
    visited.add(jobId)
    const job = jobs[jobId]
    if (!job) return
    for (const dep of job.needs) {
      visit(dep)
    }
    sorted.push(job)
  }

  for (const id of Object.keys(jobs)) {
    visit(id)
  }
  return sorted
}

function buildScenarioInventory(
  scenario: ScenarioConfig,
  workflows: Record<string, WorkflowFileInventory>,
  config: BenchmarkConfig,
  executionRepository: string,
): ScenarioInventory {
  const triggeredWorkflows: string[] = []
  const excludedWorkflows: { filePath: string; reason: string }[] = []
  const downstreamWorkflowRuns: { upstreamWorkflowName: string; downstreamFilePath: string }[] = []
  const jobExpectations: ScenarioJobExpectation[] = []
  const blockers: SetupBlocker[] = []
  const nativeConditions: NonNullable<ScenarioInventory['nativeConditions']> = []

  const targetBranch = scenario.pr?.baseRef ?? scenario.main?.branch ?? config.upstream.defaultBranch
  const changedPaths = scenario.pr?.changedPaths ?? scenario.main?.changedPaths ?? []
  const explicitAllowed = new Set([...(scenario.seedDependencies ?? []), ...(scenario.includeScheduledOrManual ?? [])])

  for (const wf of Object.values(workflows)) {
    const evts = wf.triggers.events
    // A dispatch scenario runs exactly the workflows it dispatches; other workflow_dispatch triggers stay idle.
    if (scenario.event === 'workflow_dispatch') {
      if (scenario.dispatch?.workflows.includes(wf.filePath) && evts.includes('workflow_dispatch'))
        triggeredWorkflows.push(wf.filePath)
      else if (!evts.includes('workflow_run'))
        excludedWorkflows.push({ filePath: wf.filePath, reason: 'Not dispatched by this scenario' })
      continue
    }
    const isDirectEvent = evts.includes(scenario.event)
    const isScheduleOrManualOnly = evts.length > 0 && evts.every((e) => e === 'schedule' || e === 'workflow_dispatch')

    if (isScheduleOrManualOnly && !explicitAllowed.has(wf.filePath)) {
      excludedWorkflows.push({
        filePath: wf.filePath,
        reason: 'Scheduled/manual workflow excluded unless requested or required as a seed dependency',
      })
      continue
    }

    if (isDirectEvent) {
      if (
        (scenario.event === 'pull_request' || scenario.event === 'pull_request_target') &&
        wf.triggers.pullRequestTypes &&
        scenario.pr?.activityType &&
        !wf.triggers.pullRequestTypes.includes(scenario.pr.activityType)
      ) {
        excludedWorkflows.push({
          filePath: wf.filePath,
          reason: `PR activity "${scenario.pr.activityType}" not in workflow types [${wf.triggers.pullRequestTypes.join(', ')}]`,
        })
        continue
      }

      if (
        !matchesBranchFilter(
          targetBranch,
          wf.triggers.eventFilters?.[scenario.event]?.branches,
          wf.triggers.eventFilters?.[scenario.event]?.branchesIgnore,
        )
      ) {
        excludedWorkflows.push({
          filePath: wf.filePath,
          reason: `Target branch "${targetBranch}" excluded by branch filter`,
        })
        continue
      }

      if (
        !matchesPathFilter(
          changedPaths,
          wf.triggers.eventFilters?.[scenario.event]?.paths,
          wf.triggers.eventFilters?.[scenario.event]?.pathsIgnore,
        )
      ) {
        excludedWorkflows.push({
          filePath: wf.filePath,
          reason: 'Scenario changedPaths did not match workflow path filter',
        })
        continue
      }

      triggeredWorkflows.push(wf.filePath)
    } else if (!evts.includes('workflow_run') && !evts.includes('workflow_call')) {
      excludedWorkflows.push({
        filePath: wf.filePath,
        reason: `Does not trigger on "${scenario.event}" (triggers on: ${evts.join(', ')})`,
      })
    }
  }

  // Resolve downstream workflow_run listeners transitively
  const triggeredNames = new Set(
    triggeredWorkflows.map((fp) => workflows[fp]?.name).filter((n): n is string => Boolean(n)),
  )
  let addedDownstream = true
  while (addedDownstream) {
    addedDownstream = false
    for (const wf of Object.values(workflows)) {
      if (triggeredWorkflows.includes(wf.filePath)) continue
      const wr = wf.triggers.workflowRunTrigger
      if (!wr) continue
      const matchParent = wr.workflows.find((parentName) => triggeredNames.has(parentName))
      if (matchParent) {
        if (wr.branches && !matchesBranchFilter(targetBranch, wr.branches)) {
          excludedWorkflows.push({
            filePath: wf.filePath,
            reason: `workflow_run branch filter [${wr.branches.join(', ')}] excluded "${targetBranch}"`,
          })
          continue
        }
        triggeredWorkflows.push(wf.filePath)
        triggeredNames.add(wf.name)
        downstreamWorkflowRuns.push({
          upstreamWorkflowName: matchParent,
          downstreamFilePath: wf.filePath,
        })
        addedDownstream = true
      }
    }
  }

  if (downstreamWorkflowRuns.length && replayBranchOf(config) !== config.benchmarkRepository.defaultBranch)
    blockers.push({
      id: `workflow-run-needs-default-branch-${scenario.name}`,
      category: 'unresolvable_event_context',
      severity: 'blocker',
      sourceLocation: { file: downstreamWorkflowRuns[0]?.downstreamFilePath ?? 'benchmark.config.json' },
      evidence: `Scenario "${scenario.name}" starts workflow_run listeners (${downstreamWorkflowRuns.map((d) => d.downstreamFilePath).join(', ')}), which GitHub runs only from the default branch, but replays push to "${replayBranchOf(config)}".`,
      nextAction: 'Remove benchmarkRepository.replayBranch so replays push to the default branch.',
    })

  const movedJobs: string[] = []
  const retainedJobs: string[] = []

  const callStack = new Set<string>()
  // Expand jobs for each triggered workflow, including local reusable workflows
  const processWorkflowJobs = (
    wf: WorkflowFileInventory,
    triggeredBy: ScenarioJobExpectation['triggeredBy'],
    upstreamWorkflowTrigger?: string,
  ) => {
    if (callStack.has(wf.filePath)) throw new Error(`Reusable workflow cycle at ${wf.filePath}`)
    callStack.add(wf.filePath)
    const depStatuses: Record<string, DependencyStatus> = {}
    const orderedJobs = topologicallySortJobs(wf.jobs)

    for (const job of orderedJobs) {
      const jobBlockers = scanJobBlockers({
        workflow: wf,
        job,
        upstreamRepo: config.upstream.repository,
        adaptations: config.adaptations,
      })
      blockers.push(...jobBlockers)

      const neededStatuses: Record<string, DependencyStatus> = {}
      for (const dep of job.needs) {
        neededStatuses[dep] = depStatuses[dep] ?? 'executed'
      }

      const evalResult = evaluateJobIfCondition(
        job.ifCondition,
        scenario,
        config.upstream.repository,
        config.adaptations,
        neededStatuses,
        executionRepository,
      )
      // Runtime-only conditions (job outputs, vars, unknown event fields) are evaluated natively by GitHub.
      // They are not predicted here; upstream reference parity compares what actually ran.
      if (evalResult.unresolved)
        nativeConditions.push({
          workflowFile: wf.filePath,
          jobId: job.jobId,
          ...(job.ifCondition !== undefined ? { condition: job.ifCondition } : {}),
          reason: evalResult.skipReason ?? 'Requires native evaluation',
        })
      const expectedStatus: ScenarioJobExpectation['expectedStatus'] = !evalResult.shouldExecute
        ? 'skipped'
        : evalResult.unresolved
          ? 'conditional'
          : 'executed'
      depStatuses[job.jobId] = expectedStatus

      const mappedRunsOn = resolveJobRunnerMapping(wf.filePath, job.jobId, job.runsOn, config.runnerMapping)
      const qualifiedJobId = `${wf.filePath}#${job.jobId}`
      if (expectedStatus !== 'skipped' && !job.usesReusableWorkflow) {
        if (mappedRunsOn.retainedOnGitHub) {
          retainedJobs.push(qualifiedJobId)
        } else {
          movedJobs.push(qualifiedJobId)
        }
      }

      jobExpectations.push({
        workflowFile: wf.filePath,
        workflowName: wf.name,
        jobId: job.jobId,
        triggeredBy,
        ...(upstreamWorkflowTrigger !== undefined ? { upstreamWorkflowTrigger } : {}),
        expectedStatus,
        ...(evalResult.skipReason !== undefined ? { skipReason: evalResult.skipReason } : {}),
        isDynamicMatrix: Boolean(job.matrixConfig?.isDynamic),
        ...(job.matrixConfig?.staticRows ? { expectedMatrixCount: job.matrixConfig.staticRows.length } : {}),
        mappedRunsOn,
      })

      // Follow local reusable workflow calls
      if (job.usesReusableWorkflow?.startsWith('./')) {
        const normalizedReusable = job.usesReusableWorkflow.replace(/^\.\//, '')
        const reusableWf = workflows[normalizedReusable]
        if (reusableWf && expectedStatus !== 'skipped') {
          processWorkflowJobs(reusableWf, 'reusable_workflow', wf.name)
        }
      }
    }
    callStack.delete(wf.filePath)
  }

  for (const wfPath of triggeredWorkflows) {
    const wf = workflows[wfPath]
    if (!wf) continue
    const downstreamEntry = downstreamWorkflowRuns.find((d) => d.downstreamFilePath === wfPath)
    processWorkflowJobs(wf, downstreamEntry ? 'workflow_run' : 'direct', downstreamEntry?.upstreamWorkflowName)
  }

  const mixedRunnerOnStarSling = movedJobs.length > 0 && retainedJobs.length > 0

  return {
    scenarioName: scenario.name,
    triggeredWorkflows,
    excludedWorkflows,
    downstreamWorkflowRuns,
    jobExpectations,
    mixedRunnerOnStarSling,
    movedJobs,
    retainedJobs,
    blockers,
    nativeConditions,
  }
}

export function inspectRepository(
  repoDir: string,
  config: BenchmarkConfig,
  executionRepository = config.upstream.repository,
  options: { checkGitHubRunners?: boolean } = {},
): RepositoryInventory {
  const configBlockers = validateBenchmarkConfig(config)
  const workflowsDir = join(repoDir, '.github', 'workflows')
  const workflows: Record<string, WorkflowFileInventory> = {}
  const initialLocalActionCalls = new Set<string>()

  if (existsSync(workflowsDir)) {
    const entries = readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .sort()
    for (const entry of entries) {
      const relPath = posix.join('.github/workflows', entry)
      const fullPath = join(workflowsDir, entry)
      const content = readFileSync(fullPath, 'utf8')
      const wfInv = parseWorkflowYaml(relPath, content)
      workflows[relPath] = wfInv
      for (const act of wfInv.localActionCalls) {
        initialLocalActionCalls.add(act)
      }
    }
  }

  const localActions = collectLocalActionsRecursively(repoDir, initialLocalActionCalls)
  const scenarios: Record<string, ScenarioInventory> = {}
  const checked = options.checkGitHubRunners === false ? {} : workflows
  const allBlockers: SetupBlocker[] = [...configBlockers, ...findGitHubRunnerBlockers(checked, config.runnerMapping)]

  for (const [scenarioName, scenarioCfg] of Object.entries(config.scenarios)) {
    const scInv = buildScenarioInventory(scenarioCfg, workflows, config, executionRepository)
    scenarios[scenarioName] = scInv
    for (const b of scInv.blockers) {
      if (!allBlockers.some((existing) => existing.id === b.id)) {
        allBlockers.push(b)
      }
    }
  }

  return {
    upstreamRepository: config.upstream.repository,
    commitSha: config.upstream.commitSha,
    workflows,
    localActions,
    scenarios,
    blockers: allBlockers,
  }
}
