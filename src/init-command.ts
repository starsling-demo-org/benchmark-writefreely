import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { changedPaths } from './git.ts'
import { GitHubClient, object } from './github.ts'
import {
  applyRunnerMappingOverrides,
  buildInitialConfig,
  completeConfigFromSource,
  discoverUpstream,
  fetchUpstreamSource,
  formatStars,
  writeInstanceScaffold,
} from './init.ts'
import { writeScenarioReferences } from './reference-files.ts'

export interface InitCommandValues {
  upstream?: string | undefined
  sha?: string | undefined
  'bench-repo'?: string | undefined
  pr?: string | undefined
  map?: string[] | undefined
  repo?: string | undefined
  'no-fetch'?: boolean | undefined
  force?: boolean | undefined
  history?: string | undefined
}

/** `bench init`: discovery, source fetch and scaffolding (see init.ts for the deterministic steps). */
export async function runInitCommand(params: {
  values: InitCommandValues
  root: string
  configPath: string
  referenceDir: string
  defaultSource: string
}): Promise<{ command: 'init'; ok: boolean; data: unknown }> {
  const { values, root, configPath, referenceDir, defaultSource } = params
  const command = 'init' as const
  const required = (name: 'upstream' | 'sha' | 'bench-repo'): string => {
    const value = values[name]
    if (!value) throw new Error(`Missing --${name}`)
    return value
  }
  const outDir = dirname(configPath.endsWith('.ts') ? join(root, 'benchmark.config.json') : configPath)
  if (existsSync(join(outDir, 'benchmark.config.json')) && !values.force)
    throw new Error('benchmark.config.json exists; edit it, or pass --force to regenerate it from scratch')
  const upstream = required('upstream')
  const sha = required('sha')
  const benchRepo = required('bench-repo')
  const pr = values.pr === undefined ? undefined : Number(values.pr)
  if (pr !== undefined && !Number.isSafeInteger(pr)) throw new Error('--pr must be a PR number')
  const client = new GitHubClient(upstream)
  if (!/^[\w.-]+\/[\w.-]+$/.test(benchRepo)) throw new Error('--bench-repo must be OWNER/NAME')
  const discovery = await discoverUpstream(client, { sha, ...(pr !== undefined ? { pr } : {}) })
  const config = buildInitialConfig({
    upstreamRepository: upstream,
    commitSha: sha,
    benchmarkRepository: benchRepo,
    discovery,
  })
  config.runnerMapping = applyRunnerMappingOverrides(config.runnerMapping, values.map ?? [])
  if (values.history !== undefined && values.history !== 'upstream' && values.history !== 'synthetic')
    throw new Error('--history must be upstream or synthetic')
  if (values.history === 'upstream') config.benchmarkRepository.replayHistory = 'upstream'
  const notes: string[] = []
  let benchDefaultBranch: string | undefined
  // GitHub-hosted minutes are free, and Linux runners match upstream's hardware, only in a public repository.
  try {
    const bench = object(await new GitHubClient(benchRepo).request(''))
    benchDefaultBranch = typeof bench.default_branch === 'string' ? bench.default_branch : undefined
    config.execution.publicRepoGitHubFree = bench.visibility === 'public'
    // Private and internal repositories get GitHub's 2 vCPU / 8 GiB standard Linux runner, not the public 4 / 16.
    // Labels the GitHub arm runs on (mapping targets) keep their size: they are explicit larger runners.
    const githubTargets = new Set([
      ...Object.values(config.runnerMapping.defaultMap).map((t) => t.github),
      ...Object.values(config.runnerMapping.jobOverrides ?? {}).map((t) => t.github),
    ])
    if (bench.visibility !== 'public')
      for (const spec of Object.values(config.runnerMapping.runnerSpecs))
        if (spec.provider === 'github' && spec.os === 'linux' && spec.vcpu === 4 && !githubTargets.has(spec.label))
          Object.assign(spec, { vcpu: 2, ramGiB: 8 })
    if (bench.visibility !== 'public')
      notes.push(
        `${benchRepo} is ${String(bench.visibility)}: GitHub bills its hosted minutes, and its standard Linux runners (2 vCPU) are smaller than the public-repository runners upstream uses (4 vCPU / 16 GiB). The GitHub-hosted arm therefore runs on the explicit larger-runner label you supply in runnerMapping (every GitHub target is a placeholder until you do), sized to match upstream's public runner; it does not use the 2 vCPU standard runner, so this repository's visibility does not skew the comparison. The larger runner must be provisioned for the organization.`,
      )
    notes.push(
      'GitHub-hosted jobs never run on a -latest label. Upstream "ubuntu-latest" on a public repository means 4 vCPU / 16 GiB: set runnerMapping.defaultMap["ubuntu-latest"].github to a pinned larger-runner label of that size, and rename its runnerSpecs placeholder entry to the same label.',
    )
  } catch {
    notes.push(`Could not read ${benchRepo}; execution.publicRepoGitHubFree assumes it is public.`)
  }
  let source: ReturnType<typeof completeConfigFromSource> | undefined
  if (!values['no-fetch']) {
    const sourceDir = resolve(values.repo ?? defaultSource)
    const shas = [
      sha,
      ...Object.values(config.scenarios).flatMap((s) =>
        s.pr ? [s.pr.baseSha, s.pr.headSha] : s.main ? [s.main.beforeSha, s.main.afterSha] : [],
      ),
    ]
    fetchUpstreamSource({
      repository: upstream,
      shas,
      pin: sha,
      directory: sourceDir,
      fullHistory: values.history === 'upstream',
      fetchTags: values.history === 'upstream',
    })
    for (const { main } of Object.values(config.scenarios))
      if (main) main.changedPaths = changedPaths(sourceDir, main.beforeSha, main.afterSha)
    source = completeConfigFromSource(config, sourceDir)
  } else notes.push('Source not fetched (--no-fetch): identity remaps and runner labels were not inspected.')
  // Layout: the repository's default branch is the benchmark page and replays push to upstream's branch name, unless
  // upstream's CI has workflow_run listeners, which GitHub runs only from the default branch.
  const upstreamBranch = discovery.defaultBranch
  if (config.instrumentation)
    notes.push(
      `Upstream's CI has workflow_run listeners, which GitHub runs only from the default branch: make "${upstreamBranch}" this repository's default branch, so replays run there.`,
    )
  else if (benchDefaultBranch && benchDefaultBranch !== upstreamBranch) {
    config.benchmarkRepository.defaultBranch = benchDefaultBranch
    config.benchmarkRepository.replayBranch = upstreamBranch
  } else if (benchDefaultBranch)
    notes.push(
      `This repository's default branch is "${upstreamBranch}", upstream's branch name, so replays would replace the benchmark page. Rename it (gh api -X POST repos/${benchRepo}/branches/${upstreamBranch}/rename -f new_name=benchmark) and run bench init --force again.`,
    )
  for (const scenario of Object.values(config.scenarios))
    if (scenario.role !== 'seed' && !scenario.referenceRuns.length)
      notes.push(`No upstream runs found for ${scenario.name}; pick a commit/PR whose runs GitHub still retains.`)
  const written = writeInstanceScaffold({
    directory: outDir,
    config,
    narrative: {
      experiment: '',
      title: discovery.name,
      stars: formatStars(discovery.stars),
      same: '',
      notes: [],
      agentPullRequests: [],
    },
  })
  const references = await writeScenarioReferences({
    client,
    upstreamRepository: upstream,
    scenarios: Object.values(config.scenarios).filter((s) => s.referenceRuns.length),
    directory: referenceDir,
  })
  const blockers = source?.inventory.blockers ?? []
  const unmapped = source?.runnerLabels.filter((r) => r.status === 'unmapped' || r.status === 'expression') ?? []
  return {
    command,
    ok: true,
    data: {
      written: [...written, ...references].map((p) => relative(root, p)),
      scenarios: Object.fromEntries(
        Object.values(config.scenarios).map((s) => [
          s.name,
          { referenceRuns: s.referenceRuns.length, description: s.description },
        ]),
      ),
      identityAdaptations: config.adaptations.length,
      instrumentation: config.instrumentation === true,
      runnerLabels: source?.runnerLabels ?? [],
      sideEffects: source?.sideEffects ?? [],
      blockers: blockers.map((b) => ({
        category: b.category,
        location: b.sourceLocation,
        evidence: b.evidence,
        nextAction: b.nextAction,
      })),
      notes,
      nextAction:
        blockers.length || unmapped.length
          ? 'Resolve blockers and unmapped runner labels (see skills/setup-parity), then run bench prepare.'
          : 'Run bench prepare, then a one-sample diagnostic: bench run --experiment diag-1 --variants github-baseline --profiles cold --repetitions 1',
    },
  }
}
