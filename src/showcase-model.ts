/** Labels, formatting and per-job aggregation shared by the README showcase and the Actions summary. */
import { existsSync, readFileSync } from 'node:fs'
import { isPullRequestEvent } from './config.ts'
import { VARIANTS } from './manifest.ts'
import { computeStats } from './reporter-helpers.ts'
import type { ScenarioProfileComparisonReport } from './reporter.ts'
import type { BenchmarkConfig, VariantId } from './types.ts'
/** Self-improving CI: the upstream CI with StarSling's agent PRs applied (the patch stack). */
export const VARIANT_LABELS: Record<VariantId, string> = {
  'github-baseline': 'GitHub-hosted runners',
  'github-patched': 'GitHub-hosted runners (self-improving CI)',
  'starsling-baseline': 'StarSling Runners (hardware only)',
  'starsling-patched': 'StarSling Runners (self-improving CI)',
}
export const VARIANT_SHORT: Record<VariantId, string> = {
  'github-baseline': 'GitHub-hosted',
  'github-patched': 'GitHub-hosted, self-improving CI',
  'starsling-baseline': 'StarSling, hardware only',
  'starsling-patched': 'StarSling, self-improving CI',
}

/** Hand-written narrative, kept outside the benchmark config so editing prose never invalidates a preparation. */
export interface ShowcaseNarrative {
  /** Experiment under experiments/ that the published README presents. */
  experiment?: string
  /** Display name of the project; defaults to the upstream repository name. */
  title?: string
  /** Formatted star count, for example "5.3k". */
  stars?: string
  /** How the self-improving CI is shown to run the same checks with the same results. */
  same?: string
  /** Extra method notes (for example, documented reruns or repository differences). */
  notes?: string[]
  /** Links to the agent pull requests the self-improving CI applies. */
  agentPullRequests?: string[]
  /** README layout: `default` (the long report) or `showcase` (result table first, one row per agent PR). */
  layout?: 'default' | 'showcase'
  /** Showcase layout: prose for "What was slow". Omitted from the page when absent. */
  whatWasSlow?: string
  /** Showcase layout: prose for "What we changed"; the agent PR links are listed under it. */
  whatWeChanged?: string
  /**
   * Showcase layout: how often the project runs CI on a push to its default branch. An input, not a measurement:
   * `source` says where the number comes from and is printed with it. Without it there is no savings line.
   */
  pushesPerMonth?: RunFrequency
  /** Showcase layout: the same, for PR updates (a push to an open PR's branch). */
  prUpdatesPerMonth?: RunFrequency
  /** Showcase layout: the merged agent PRs, in merge order, each tied to the experiment that measured it. */
  agentPrs?: AgentPrEntry[]
}

export interface RunFrequency {
  value: number
  source: string
}

/**
 * One merged agent PR. Its numbers are never typed here: they are read from `experiment`, a per-lever A/B experiment
 * under experiments/ whose `before` variant is the CI with the PRs merged before this one and whose `after` variant
 * adds this PR. The "after" median is also the cumulative wait after this PR.
 */
export interface AgentPrEntry {
  url: string
  /** What the PR changed, in a short phrase. */
  summary: string
  experiment?: {
    id: string
    before: VariantId
    after: VariantId
    /** Scenario the A/B measured; defaults to the headline lane's scenario. */
    scenario?: string
    /** Cache profile the A/B measured; defaults to the headline's first profile. */
    profile?: string
  }
}

export function loadShowcaseNarrative(path: string): ShowcaseNarrative {
  if (!existsSync(path)) return {}
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a JSON object`)
  return value as ShowcaseNarrative
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  return total % 60 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${total / 60}m`
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—'
  return minutes >= 1 ? minutes.toFixed(1) : minutes.toFixed(2)
}

/** "2.5× faster" style multiple of `baseline / value`; null when either side is missing. */
export function formatMultiple(baseline: number | null, value: number | null, faster = 'faster', slower = 'slower') {
  if (baseline === null || value === null || baseline <= 0 || value <= 0) return null
  const ratio = baseline / value
  if (Math.abs(ratio - 1) < 0.05) return 'same'
  return ratio > 1 ? `${ratio.toFixed(1)}× ${faster}` : `${(1 / ratio).toFixed(1)}× ${slower}`
}

export function scenarioLabel(config: BenchmarkConfig, scenarioName: string): string {
  const scenario = config.scenarios[scenarioName]
  if (!scenario) return scenarioName
  if (isPullRequestEvent(scenario.event)) return scenario.pr?.prNumber ? `PR #${scenario.pr.prNumber}` : 'PR'
  return `Merge to ${scenario.main?.branch ?? config.upstream.defaultBranch}`
}

export const workflowName = (path: string) => path.replace('.github/workflows/', '')

/** Where an agent PR's patch lives, in the benchmark repository and in the published showcase. */
export const patchPath = (patchId: string) => `patches/${patchId}.patch`

/** `#<run id>` link text for a workflow run URL. */
export const runLabel = (url: string) => `#${url.split('/').pop()}`

/** A variant's value against GitHub-hosted runners: `1x` for the baseline itself, `—` when unmeasured. */
export function vsGitHub(
  variant: VariantId,
  baseline: number | null,
  value: number | null,
  better = 'faster',
  worse = 'slower',
): string {
  return variant === 'github-baseline' ? '1x' : (formatMultiple(baseline, value, better, worse) ?? '—')
}

export interface JobBreakdownRow {
  workflowPath: string
  jobName: string
  githubLabel: string | null
  starslingLabel: string | null
  medians: Record<VariantId, number | null>
}

/** Median duration of every job across the paired rounds the medians use, by variant, slowest GitHub job first. */
export function buildJobBreakdown(comparison: ScenarioProfileComparisonReport): JobBreakdownRow[] {
  const paired = new Set(comparison.pairedRepetitions)
  // An agent PR may rename a job (one DefinitelyTyped PR turns the one-row `test (1, 1)` matrix into `test`). Rows match on the
  // logical job ID when every sample has at most one instance of it, and on the job name otherwise (real matrices).
  const instances = new Map<string, number>()
  for (const sample of comparison.samples)
    for (const workflow of sample.workflows) {
      const counts = new Map<string, number>()
      for (const job of workflow.jobs) {
        if (job.conclusion === 'skipped') continue
        const id = `${workflow.workflowPath}\u0000${job.logicalJobId}`
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      for (const [id, n] of counts) instances.set(id, Math.max(instances.get(id) ?? 0, n))
    }
  const rows = new Map<string, Omit<JobBreakdownRow, 'medians'> & { durations: Record<VariantId, number[]> }>()
  for (const sample of comparison.samples) {
    if (!sample.complete || !paired.has(sample.repetition)) continue
    for (const workflow of sample.workflows)
      for (const job of workflow.jobs) {
        if (job.conclusion === 'skipped' || job.durationSeconds === null) continue
        const logical = `${workflow.workflowPath}\u0000${job.logicalJobId}`
        const key = (instances.get(logical) ?? 0) <= 1 ? logical : `${workflow.workflowPath}\u0000${job.jobName}`
        let row = rows.get(key)
        if (!row) {
          row = {
            workflowPath: workflow.workflowPath,
            jobName: job.jobName,
            githubLabel: null,
            starslingLabel: null,
            durations: {
              'github-baseline': [],
              'github-patched': [],
              'starsling-baseline': [],
              'starsling-patched': [],
            },
          }
          rows.set(key, row)
        }
        if (sample.variant === 'github-baseline') row.jobName = job.jobName
        row.durations[sample.variant].push(job.durationSeconds)
        if (sample.variant.startsWith('github-')) row.githubLabel ??= job.labels[0] ?? null
        else row.starslingLabel ??= job.labels[0] ?? null
      }
  }
  return [...rows.values()]
    .map(({ durations, ...row }) => ({
      ...row,
      medians: Object.fromEntries(VARIANTS.map((v) => [v, computeStats(durations[v]).median])) as Record<
        VariantId,
        number | null
      >,
    }))
    .sort(
      (a, b) =>
        (b.medians['github-baseline'] ?? -1) - (a.medians['github-baseline'] ?? -1) ||
        a.workflowPath.localeCompare(b.workflowPath) ||
        a.jobName.localeCompare(b.jobName),
    )
}
