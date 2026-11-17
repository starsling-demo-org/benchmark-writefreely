/**
 * Deterministic setup for a new benchmark repository: everything repeatable about adopting an upstream
 * project is generated here, so the setup skill only handles the judgment calls `bench inspect` reports.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { parseDocument } from 'yaml'
import { createDefaultProfiles, createDefaultRunnerMapping } from './config.ts'
import { visitStringScalars } from './generator.ts'
import { git } from './git.ts'
import { type GitHubReader, object } from './github.ts'
import { inspectRepository } from './inventory.ts'
import { escapeRegExp, resolveJobRunnerMapping } from './inventory-helpers.ts'
import { discoverReferenceRuns } from './reference.ts'
import { githubTargetPlaceholder } from './runner-labels.ts'
import { writeJson } from './runtime.ts'
import type { ShowcaseNarrative } from './showcase-model.ts'
import type {
  BenchmarkConfig,
  RepositoryAdaptationRule,
  RepositoryInventory,
  RunnerMappingConfig,
  ScenarioConfig,
} from './types.ts'

export interface UpstreamDiscovery {
  defaultBranch: string
  name: string
  stars: number
  scenarios: Record<string, ScenarioConfig>
}

const FULL_SHA = /^[0-9a-f]{40}$/

/** REST file lists name a rename once; list its old path too, as `changedPaths` (`--no-renames`) does. */
function restChangedPaths(files: unknown[]): string[] {
  const paths = files.flatMap((raw) => {
    const file = object(raw)
    return [String(file.filename), ...(typeof file.previous_filename === 'string' ? [file.previous_filename] : [])]
  })
  return [...new Set(paths)].sort()
}

export function formatStars(stars: number): string {
  if (stars >= 1_000_000) return `${(stars / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (stars >= 1000) return `${(stars / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(stars)
}

/** Lock the pinned main scenario (commit vs. first parent) and, optionally, a real upstream PR. */
export async function discoverUpstream(
  client: GitHubReader,
  params: { sha: string; pr?: number },
): Promise<UpstreamDiscovery> {
  if (!FULL_SHA.test(params.sha)) throw new Error('Pin must be a full 40-character commit SHA')
  const repo = object(await client.request(''))
  if (repo.private === true || repo.visibility === 'private') throw new Error('Upstream must be public')
  const defaultBranch = String(repo.default_branch)
  const commit = object(await client.request(`commits/${params.sha}`))
  if (commit.sha !== params.sha) throw new Error('Pin must be a full immutable SHA')
  const scenarios: Record<string, ScenarioConfig> = {}
  const parents = (commit.parents as { sha: string }[] | undefined) ?? []
  if (parents[0]) {
    scenarios['main-push'] = {
      name: 'main-push',
      description: `Merge of ${params.sha.slice(0, 12)} to ${defaultBranch}`,
      event: 'push',
      main: {
        branch: defaultBranch,
        beforeSha: parents[0].sha,
        afterSha: params.sha,
        // The REST API lists at most 300 files; init replaces this with the exact local diff after fetching.
        changedPaths: restChangedPaths((commit.files as unknown[] | undefined) ?? []),
      },
      referenceRuns: [],
    }
    // The warm seed replays the previous push, so a warm sample builds new source against the caches that push left,
    // as CI does. Seeding with the measured tree itself would make content-addressed build caches a 100% hit.
    const previous = object(await client.request(`commits/${parents[0].sha}`))
    const grandparent = ((previous.parents as { sha: string }[] | undefined) ?? [])[0]
    if (grandparent)
      scenarios['seed-parent'] = {
        name: 'seed-parent',
        role: 'seed',
        description: `Warm seed: the previous push (${parents[0].sha.slice(0, 12)} onto ${grandparent.sha.slice(0, 12)})`,
        event: 'push',
        main: {
          branch: defaultBranch,
          beforeSha: grandparent.sha,
          afterSha: parents[0].sha,
          changedPaths: restChangedPaths((previous.files as unknown[] | undefined) ?? []),
        },
        referenceRuns: [],
      }
  }
  if (params.pr !== undefined) {
    const pr = object(await client.request(`pulls/${params.pr}`))
    const base = object(pr.base)
    const head = object(pr.head)
    if (typeof pr.merge_commit_sha !== 'string') throw new Error('PR merge SHA is unresolved')
    const files = await client.all(`pulls/${params.pr}/files`)
    scenarios['pr-synchronize'] = {
      name: 'pr-synchronize',
      description: `Upstream PR #${params.pr}: ${String(pr.title ?? '').slice(0, 120)}`,
      event: 'pull_request',
      pr: {
        prNumber: params.pr,
        baseRef: String(base.ref),
        headRef: String(head.ref),
        baseSha: String(base.sha),
        headSha: String(head.sha),
        mergeSha: pr.merge_commit_sha,
        activityType: 'synchronize',
        changedPaths: restChangedPaths(files),
        labels: ((pr.labels as unknown[] | undefined) ?? []).map((l) => String(object(l).name)).sort(),
      },
      referenceRuns: [],
    }
  }
  if (!Object.keys(scenarios).length) throw new Error('Pinned commit has no parent and no PR was selected')
  for (const scenario of Object.values(scenarios))
    if (scenario.role !== 'seed') scenario.referenceRuns = await discoverReferenceRuns(client, scenario)
  return {
    defaultBranch,
    name: String(repo.name),
    stars: Number(repo.stargazers_count ?? 0),
    scenarios,
  }
}

/** Shallow-fetch exactly the commits the scenarios need and check out the pin. */
export function fetchUpstreamSource(params: {
  repository: string
  shas: string[]
  pin: string
  directory: string
  /** Fetch complete history (upstream-history replays); otherwise only the scenario commits. */
  fullHistory?: boolean
  /** Also fetch upstream's tags (for mirroring). Needs `fullHistory`. */
  fetchTags?: boolean
}) {
  const { directory } = params
  const run = (...args: string[]) => git(directory, args)
  if (existsSync(join(directory, '.git'))) {
    if (run('rev-parse', 'HEAD') !== params.pin) throw new Error(`${directory} is checked out at another commit`)
    if (run('status', '--porcelain', '--untracked-files=all')) throw new Error(`${directory} is not clean`)
  } else {
    mkdirSync(directory, { recursive: true })
    run('init', '-q')
    run('remote', 'add', 'origin', `https://github.com/${params.repository}.git`)
  }
  const missing = [...new Set(params.shas)].filter((sha) => {
    try {
      run('cat-file', '-e', `${sha}^{commit}`)
      return false
    } catch {
      return true
    }
  })
  const shallow = run('rev-parse', '--is-shallow-repository') === 'true'
  if (params.fullHistory) {
    if (missing.length || shallow)
      run('fetch', '--quiet', '--no-tags', ...(shallow ? ['--unshallow'] : []), 'origin', ...params.shas)
  } else if (missing.length) run('fetch', '--quiet', '--no-tags', '--depth=1', 'origin', ...missing)
  if (params.fullHistory && params.fetchTags) run('fetch', '--quiet', '--tags', 'origin')
  run('-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', params.pin)
}

/**
 * Upstream identity guards (`github.repository == 'owner/name'`, `github.repository_owner == 'owner'`) are true
 * upstream and false in the benchmark repository. Remapping the literal keeps the upstream decision, for
 * both `==` and `!=`. Match counts use the same scalar traversal as the workflow generator.
 */
export function proposeIdentityAdaptations(params: {
  sourceDir: string
  upstreamRepository: string
  benchmarkRepository: string
}): RepositoryAdaptationRule[] {
  const upRepo = escapeRegExp(params.upstreamRepository)
  const upOwner = escapeRegExp(params.upstreamRepository.split('/')[0] ?? '')
  const [benchOwner = ''] = params.benchmarkRepository.split('/')
  const patterns = [
    {
      regex: new RegExp(`github\\.repository\\s*[!=]=\\s*'${upRepo}'`, 'gi'),
      replace: (match: string) => match.replace(/'[^']*'$/, `'${params.benchmarkRepository}'`),
      reason: 'Upstream repository guard: keep the decision GitHub makes upstream',
    },
    {
      regex: new RegExp(`'${upRepo}'\\s*[!=]=\\s*github\\.repository\\b`, 'gi'),
      replace: (match: string) => match.replace(/^'[^']*'/, `'${params.benchmarkRepository}'`),
      reason: 'Upstream repository guard: keep the decision GitHub makes upstream',
    },
    {
      regex: new RegExp(`github\\.repository_owner\\s*[!=]=\\s*'${upOwner}'`, 'gi'),
      replace: (match: string) => match.replace(/'[^']*'$/, `'${benchOwner}'`),
      reason: 'Upstream owner guard: keep the decision GitHub makes upstream',
    },
  ]
  const rules: RepositoryAdaptationRule[] = []
  const workflowsDir = join(params.sourceDir, '.github', 'workflows')
  if (!existsSync(workflowsDir)) return rules
  for (const file of readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const workflowFile = posix.join('.github/workflows', file)
    const doc = parseDocument(readFileSync(join(workflowsDir, file), 'utf8'))
    const found = new Map<string, { to: string; reason: string }>()
    visitStringScalars(doc.contents, ({ value }) => {
      for (const pattern of patterns)
        for (const match of value.matchAll(pattern.regex))
          found.set(match[0], { to: pattern.replace(match[0]), reason: pattern.reason })
    })
    for (const [fromPattern, { to, reason }] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
      if (fromPattern === to) continue
      let expectedMatches = 0
      visitStringScalars(doc.contents, ({ value }) => {
        expectedMatches += value.split(fromPattern).length - 1
      })
      rules.push({
        id: `identity-${file.replace(/\.ya?ml$/, '')}-${rules.filter((r) => r.workflowFile === workflowFile).length + 1}`,
        kind: 'repository-identity-remap',
        workflowFile,
        fromPattern,
        toReplacement: to,
        expectedMatches,
        reason,
        blocksFullParity: false,
      })
    }
  }
  return rules
}

export interface RunnerLabelReport {
  label: string
  jobs: string[]
  status: 'mapped' | 'kept-on-github' | 'unmapped' | 'expression'
  starsling?: string
  /** The explicit GitHub label the GitHub-hosted arm runs this label's jobs on (a placeholder until supplied). */
  github?: string
}

/**
 * Classify every `runs-on` label the inventory references, using the generator's own runner resolution so
 * `bench init` and `bench inspect` report what `bench prepare` will do.
 */
export function classifyRunnerLabels(
  inventory: RepositoryInventory,
  mapping: RunnerMappingConfig,
): RunnerLabelReport[] {
  const byLabel = new Map<string, { jobs: string[]; kinds: ReturnType<typeof resolveJobRunnerMapping>[] }>()
  for (const workflow of Object.values(inventory.workflows))
    for (const job of Object.values(workflow.jobs)) {
      if (job.usesReusableWorkflow) continue
      const label = typeof job.runsOn === 'string' ? job.runsOn : JSON.stringify(job.runsOn)
      const entry = byLabel.get(label) ?? { jobs: [], kinds: [] }
      entry.jobs.push(`${workflow.filePath}#${job.jobId}`)
      entry.kinds.push(resolveJobRunnerMapping(workflow.filePath, job.jobId, job.runsOn, mapping))
      byLabel.set(label, entry)
    }
  return [...byLabel]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, { jobs, kinds }]) => {
      // Overrides are per job; every other rule depends only on the label, so one non-override decides.
      const decided = kinds.find((r) => r.kind !== 'override')
      if (!decided) return { label, jobs, status: 'mapped' as const }
      if (decided.kind === 'compound' || label.includes('${{')) return { label, jobs, status: 'expression' as const }
      if (decided.kind === 'mapped')
        return { label, jobs, status: 'mapped' as const, starsling: decided.starsling, github: decided.github }
      if (decided.kind === 'unsupported') return { label, jobs, status: 'kept-on-github' as const }
      return { label, jobs, status: 'unmapped' as const }
    })
}

export interface ExternalSideEffect {
  location: string
  evidence: string
  /** Adaptations scoped to this job (guards, stubs, settings): the recorded decision, when there is one. */
  addressedBy?: string[]
}

const PUBLISH_ACTION =
  /^(docker\/login-action|docker\/build-push-action|softprops\/action-gh-release|ncipollo\/release-action|actions\/create-release|actions\/deploy-pages|peaceiris\/actions-gh-pages|pypa\/gh-action-pypi-publish|js-devtools\/npm-publish|changesets\/action|codecov\/codecov-action|coverallsapp\/github-action|stefanzweifel\/git-auto-commit-action|peter-evans\/create-pull-request|endbug\/add-and-commit|aws-actions\/|azure\/|google-github-actions\/)/i
const PUBLISH_COMMAND =
  /\b(?:npm|pnpm|yarn) publish\b|\bcargo publish\b|\btwine upload\b|\bgh release (?:create|upload)\b|\bdocker (?:push|login)\b|\bgoreleaser\b|\bgit push\b/

/**
 * Steps that reach outside the replay (registries, releases, deployments, coverage services). They are not
 * blockers: whether to keep, stub or guard each one is a parity decision for the setup skill. Each lists the
 * non-identity adaptations scoped to its job, so a decided side effect is visible as such.
 */
export function findExternalSideEffects(
  inventory: RepositoryInventory,
  adaptations: RepositoryAdaptationRule[] = [],
): ExternalSideEffect[] {
  const found: ExternalSideEffect[] = []
  for (const workflow of Object.values(inventory.workflows))
    for (const job of Object.values(workflow.jobs)) {
      const at = `${workflow.filePath}#${job.jobId}`
      const addressedBy = adaptations
        .filter(
          (a) =>
            a.kind !== 'repository-identity-remap' &&
            a.workflowFile === workflow.filePath &&
            (!a.jobId || a.jobId === job.jobId),
        )
        .map((a) => a.id)
      const add = (location: string, evidence: string) =>
        found.push({ location, evidence, ...(addressedBy.length ? { addressedBy } : {}) })
      if (job.environment) add(at, `deployment environment "${job.environment}"`)
      for (const step of job.steps) {
        const where = `${at} step ${step.index + 1}${step.name ? ` (${step.name})` : ''}`
        if (step.uses && PUBLISH_ACTION.test(step.uses)) add(where, `uses ${step.uses}`)
        const command = step.run ? PUBLISH_COMMAND.exec(step.run) : null
        if (command) add(where, `runs "${command[0]}"`)
      }
    }
  return found
}

export function applyRunnerMappingOverrides(mapping: RunnerMappingConfig, overrides: string[]): RunnerMappingConfig {
  const next = structuredClone(mapping)
  for (const entry of overrides) {
    const [from, to] = entry.split('=')
    if (!from || !to) throw new Error(`Runner mapping must be FROM=TO, got "${entry}"`)
    next.defaultMap[from] = { github: githubTargetPlaceholder(from), starsling: to }
    addPlaceholderSpec(next, from)
  }
  return next
}

/**
 * Record the size the GitHub target must match under its placeholder label: upstream's label on a public
 * repository (4 vCPU / 16 GiB for `ubuntu-*`). The owner renames the label and keeps the size.
 */
function addPlaceholderSpec(mapping: RunnerMappingConfig, upstreamLabel: string): void {
  const placeholder = githubTargetPlaceholder(upstreamLabel)
  if (mapping.runnerSpecs[placeholder]) return
  const known = mapping.runnerSpecs[upstreamLabel]
  mapping.runnerSpecs[placeholder] = {
    label: placeholder,
    provider: 'github',
    os: known?.os ?? 'linux',
    arch: known?.arch ?? 'x64',
    vcpu: known?.vcpu ?? 4,
    ramGiB: known?.ramGiB ?? 16,
    billingPerMinuteUsd: known?.billingPerMinuteUsd ?? 0.016,
  }
}

/** `bench init` never picks a GitHub target itself: each upstream label gets a placeholder that fails validation. */
function withGitHubPlaceholders(mapping: RunnerMappingConfig): RunnerMappingConfig {
  const next = structuredClone(mapping)
  for (const [from, target] of Object.entries(next.defaultMap)) {
    target.github = githubTargetPlaceholder(from)
    addPlaceholderSpec(next, from)
  }
  return next
}

export function buildInitialConfig(params: {
  upstreamRepository: string
  commitSha: string
  benchmarkRepository: string
  discovery: UpstreamDiscovery
}): BenchmarkConfig {
  const { discovery } = params
  const profiles = createDefaultProfiles()
  const seed = profiles.warm
  if (seed) {
    if (discovery.scenarios['main-push'])
      seed.seedScenario = discovery.scenarios['seed-parent'] ? 'seed-parent' : 'main-push'
    else delete profiles.warm
  }
  return {
    schemaVersion: 1,
    upstream: {
      repository: params.upstreamRepository,
      commitSha: params.commitSha,
      defaultBranch: discovery.defaultBranch,
    },
    benchmarkRepository: {
      repository: params.benchmarkRepository,
      controlBranch: 'bench/control',
      defaultBranch: discovery.defaultBranch,
    },
    scenarios: discovery.scenarios,
    patches: [],
    runnerMapping: withGitHubPlaceholders(createDefaultRunnerMapping()),
    profiles,
    adaptations: [],
    collectors: [],
    execution: {
      repetitions: 5,
      timeoutMinutes: 60,
      maxConcurrentExperiments: 1,
      pollIntervalSeconds: 15,
      apiBudgetPerHour: 300,
      maxJobQueueSeconds: 30,
      publicRepoGitHubFree: true,
    },
  }
}

/**
 * Finish the configuration from the pinned source: identity remaps, `workflow_run` correlation and a
 * classification of runner labels. Returns the facts the setup skill must resolve.
 */
export function completeConfigFromSource(config: BenchmarkConfig, sourceDir: string) {
  config.adaptations = [
    ...config.adaptations.filter((a) => a.kind !== 'repository-identity-remap' || !a.id.startsWith('identity-')),
    ...proposeIdentityAdaptations({
      sourceDir,
      upstreamRepository: config.upstream.repository,
      benchmarkRepository: config.benchmarkRepository.repository,
    }),
  ]
  const inventory = inspectRepository(sourceDir, config)
  const downstream = Object.values(inventory.scenarios).some((s) => s.downstreamWorkflowRuns.length > 0)
  // The REST API does not link a workflow_run run to its trigger; a one-line context step records it.
  if (downstream) config.instrumentation = true
  else delete config.instrumentation
  return {
    inventory,
    runnerLabels: classifyRunnerLabels(inventory, config.runnerMapping),
    sideEffects: findExternalSideEffects(inventory, config.adaptations),
  }
}

export function writeInstanceScaffold(params: {
  directory: string
  config: BenchmarkConfig
  narrative: ShowcaseNarrative
}): string[] {
  const written: string[] = []
  const configPath = join(params.directory, 'benchmark.config.json')
  writeJson(configPath, params.config)
  written.push(configPath)
  const narrativePath = join(params.directory, 'showcase.json')
  if (!existsSync(narrativePath)) {
    writeJson(narrativePath, params.narrative)
    written.push(narrativePath)
  }
  const patchesDir = join(params.directory, 'patches')
  if (!existsSync(patchesDir)) {
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(
      join(patchesDir, 'README.md'),
      '# Agent PRs\n\nAdd one patch file per agent PR (a `git diff` against the pinned upstream commit), listed in `patches` order in `benchmark.config.json`.\nAn agent PR may change any file, including dependencies and `.github/workflows`.\n',
    )
    written.push(join(patchesDir, 'README.md'))
  }
  return written
}
