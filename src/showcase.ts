/**
 * Deterministic README showcase for a benchmark repository, rendered from the validated report model.
 *
 * Numbers come only from complete rounds. Claims the evidence does not support are labeled as
 * diagnostic, with the withheld reasons, rather than hidden or rounded into a headline.
 */
import { isPullRequestEvent, replayBranchOf } from './config.ts'
import { describeGap, type FixArmInfo } from './fix-arm.ts'
import { VARIANTS } from './manifest.ts'
import type { BenchmarkExperimentReport, ScenarioProfileComparisonReport } from './reporter.ts'
// showcase-layout.ts imports helpers back from here; both only call each other at render time, so the cycle is inert.
import { renderShowcaseLayout } from './showcase-layout.ts'
import {
  buildJobBreakdown,
  formatDuration,
  formatMinutes,
  formatMultiple,
  patchPath,
  runLabel,
  scenarioLabel,
  VARIANT_LABELS,
  VARIANT_SHORT,
  type ShowcaseNarrative,
  workflowName,
} from './showcase-model.ts'
import type { BenchmarkConfig, VariantId } from './types.ts'

const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const capitalize = (text: string) => `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
const isPr = (config: BenchmarkConfig, c: ScenarioProfileComparisonReport) =>
  isPullRequestEvent(config.scenarios[c.scenarioName]?.event ?? '')
/** PR scenarios first, then merges. */
const ordered = (config: BenchmarkConfig, comparisons: ScenarioProfileComparisonReport[]) =>
  [...comparisons].sort((a, b) => Number(isPr(config, b)) - Number(isPr(config, a)))

/** The three runner configurations the results compare. GitHub-hosted with self-improving CI stays in the appendix. */
function headlineVariants(config: BenchmarkConfig): VariantId[] {
  return config.patches.length
    ? ['github-baseline', 'starsling-baseline', 'starsling-patched']
    : ['github-baseline', 'starsling-baseline']
}

function variantsWithData(comparisons: ScenarioProfileComparisonReport[], config: BenchmarkConfig): VariantId[] {
  return VARIANTS.filter(
    (v) =>
      (config.patches.length > 0 || !v.endsWith('-patched')) &&
      comparisons.some((c) => c.samples.some((s) => s.variant === v)),
  )
}

export function profileSummary(config: BenchmarkConfig, profileName: string): string {
  const profile = config.profiles[profileName]
  if (profile?.actionsCache === 'cold') return 'Every sample starts with no GitHub Actions caches.'
  if (profile?.actionsCache === 'warm')
    return 'Every sample starts from caches a seed run produced on the same runner configuration; seed time is not counted.'
  return 'Cache state is not controlled (diagnostic).'
}

function statusAlerts(report: BenchmarkExperimentReport): string[] {
  const complete = report.comparisons.flatMap((c) => c.samples).filter((s) => s.complete).length
  const lines: string[] = []
  if (complete < report.requestedSampleCount)
    lines.push(
      '> [!IMPORTANT]',
      `> **Still replaying:** ${complete} of ${report.requestedSampleCount} requested samples have finished. This page is regenerated as samples finish.`,
      '',
    )
  if (report.comparisons.some((c) => !c.publishableHeadlineAllowed))
    lines.push(
      '> [!WARNING]',
      '> **Not yet a published result.** Every number here is measured, but some evidence a published claim needs is still missing. See the [claim checklist](#claim-checklist).',
      '',
    )
  return lines
}

interface Metric {
  header: (c: ScenarioProfileComparisonReport) => string
  value: (c: ScenarioProfileComparisonReport, v: VariantId) => number | null
  format: (n: number | null) => string
  better: string
  worse: string
}

function metrics(config: BenchmarkConfig): { wall: Metric; minutes: Metric } {
  return {
    wall: {
      header: (c) =>
        `${isPr(config, c) ? 'PR CI duration' : 'Merge CI duration'}<br><sub>${scenarioLabel(config, c.scenarioName)}</sub>`,
      value: (c, v) => c.variants[v].wallClockSec.median,
      format: formatDuration,
      better: 'faster',
      worse: 'slower',
    },
    minutes: {
      header: (c) => `CI minutes<br><sub>${scenarioLabel(config, c.scenarioName)}</sub>`,
      value: (c, v) => c.variants[v].repoMinutes.median,
      format: formatMinutes,
      better: 'fewer',
      worse: 'more',
    },
  }
}

/** Columns: each metric for each event. CI durations first, then CI minutes. */
function columns(config: BenchmarkConfig, comparisons: ScenarioProfileComparisonReport[]) {
  const { wall, minutes } = metrics(config)
  const list = ordered(config, comparisons)
  return [...list.map((c) => ({ c, m: wall })), ...list.map((c) => ({ c, m: minutes }))]
}

function tableHead(first: string, cols: ReturnType<typeof columns>): string[] {
  return [
    `| ${first} | ${cols.map(({ c, m }) => m.header(c)).join(' | ')} |`,
    `|---|${cols.map(() => '---:').join('|')}|`,
  ]
}

/** Runner configurations as rows (as in the Depot comparison), each against GitHub-hosted runners. */
function resultsTable(config: BenchmarkConfig, comparisons: ScenarioProfileComparisonReport[]): string[] {
  const cols = columns(config, comparisons)
  const lines = tableHead('Runner configuration', cols)
  for (const v of headlineVariants(config)) {
    if (!comparisons.some((c) => c.samples.some((sample) => sample.variant === v))) {
      lines.push(
        `| **${VARIANT_LABELS[v]}** | _not measured yet_ | ${cols
          .slice(1)
          .map(() => '')
          .join(' | ')} |`,
      )
      continue
    }
    const cells = cols.map(({ c, m }) => {
      const value = m.value(c, v)
      const multiple =
        v === 'github-baseline' ? null : formatMultiple(m.value(c, 'github-baseline'), value, m.better, m.worse)
      return `${m.format(value)}${multiple && multiple !== 'same' ? `<br>**${multiple}**` : ''}`
    })
    lines.push(`| **${VARIANT_LABELS[v]}** | ${cells.join(' | ')} |`)
  }
  return lines
}

/** Hardware and software multiply: total = hardware × self-improving CI. */
function speedupTable(config: BenchmarkConfig, comparisons: ScenarioProfileComparisonReport[]): string[] {
  const cols = columns(config, comparisons)
  const rows: [string, VariantId, VariantId][] = [
    [
      'Hardware speedup<br><sub>StarSling vs GitHub-hosted, CI unchanged</sub>',
      'github-baseline',
      'starsling-baseline',
    ],
  ]
  if (config.patches.length)
    rows.push(
      [
        'Self-improving CI speedup<br><sub>agent PRs, both on StarSling</sub>',
        'starsling-baseline',
        'starsling-patched',
      ],
      [
        '**Total speedup**<br><sub>StarSling with self-improving CI vs GitHub-hosted</sub>',
        'github-baseline',
        'starsling-patched',
      ],
    )
  const lines = tableHead('Speedup', cols)
  for (const [label, from, to] of rows)
    lines.push(
      `| ${label} | ${cols
        .map(({ c, m }) => {
          const multiple = formatMultiple(m.value(c, from), m.value(c, to), m.better, m.worse)
          return multiple ? (label.startsWith('**') ? `**${multiple}**` : multiple) : '—'
        })
        .join(' | ')} |`,
    )
  return lines
}

/** One plain sentence per scenario, in the style of the Depot notes. */
function noteLines(config: BenchmarkConfig, comparisons: ScenarioProfileComparisonReport[]): string[] {
  const best = headlineVariants(config).at(-1) as VariantId
  const lines: string[] = []
  for (const c of ordered(config, comparisons)) {
    const base = c.variants['github-baseline']
    const top = c.variants[best]
    const wall = formatMultiple(base.wallClockSec.median, top.wallClockSec.median)
    if (!wall) continue
    const minutes = formatMultiple(base.repoMinutes.median, top.repoMinutes.median, 'fewer', 'more')
    const event = isPr(config, c)
      ? scenarioLabel(config, c.scenarioName)
      : `a ${scenarioLabel(config, c.scenarioName).toLowerCase()}`
    lines.push(
      `- On ${VARIANT_LABELS[best]}, every check for ${event} finished in **${formatDuration(top.wallClockSec.median)}** instead of ${formatDuration(base.wallClockSec.median)} (**${wall}**)${minutes ? `, using ${formatMinutes(top.repoMinutes.median)} instead of ${formatMinutes(base.repoMinutes.median)} CI minutes (**${minutes}**)` : ''}.`,
    )
  }
  return lines
}

/** Runner labels the jobs actually ran on, with specs only where the configuration records them. */
export function runnersTable(report: BenchmarkExperimentReport, config: BenchmarkConfig): string[] {
  const labels: Record<'github' | 'starsling', Set<string>> = { github: new Set(), starsling: new Set() }
  for (const sample of report.comparisons.flatMap((c) => c.samples))
    for (const job of sample.workflows.flatMap((w) => w.jobs)) {
      if (job.conclusion === 'skipped') continue
      for (const label of job.labels.slice(0, 1))
        labels[sample.variant.startsWith('github') ? 'github' : 'starsling'].add(label)
    }
  const spec = (label: string) => config.runnerMapping.runnerSpecs[label]
  const all = [...labels.github, ...labels.starsling]
  const withSpecs = all.some((label) => spec(label))
  const lines = [
    withSpecs ? '| Runners | Label | vCPU | Memory |' : '| Runners | Labels |',
    withSpecs ? '|---|---|---:|---:|' : '|---|---|',
  ]
  for (const [name, set] of [
    ['GitHub-hosted', labels.github],
    ['StarSling', labels.starsling],
  ] as const)
    for (const label of [...set].sort())
      lines.push(
        withSpecs
          ? `| ${name} | \`${label}\` | ${spec(label)?.vcpu ?? '—'} | ${spec(label) ? `${spec(label)?.ramGiB} GiB` : '—'} |`
          : `| ${name} | \`${label}\` |`,
      )
  if ([...labels.github].some((label) => spec(label)))
    lines.push(
      '',
      "GitHub-hosted jobs run on the explicit GitHub larger-runner label shown, pinned to the size of upstream's public-repository runner, so the comparison does not change with this repository's visibility.",
    )
  return lines
}

/** Same-runner pairs (CI unchanged vs self-improving CI) the experiment measured. */
const costPairs = (variants: VariantId[]) =>
  (['github', 'starsling'] as const).filter(
    (p) => variants.includes(`${p}-patched`) && variants.includes(`${p}-baseline`),
  )

/** "PRs and merges", "PRs" or "merges": the kinds of upstream event this experiment replayed. */
function eventsReplayed(report: BenchmarkExperimentReport, config: BenchmarkConfig): string {
  const measured = new Set(report.comparisons.map((c) => c.scenarioName))
  const kinds = Object.values(config.scenarios).filter((s) => measured.has(s.name))
  const prs = kinds.some((s) => isPullRequestEvent(s.event))
  const merges = kinds.some((s) => !isPullRequestEvent(s.event))
  return prs && merges ? 'PRs and merges' : prs ? 'PRs' : 'merges'
}

function claimChecklist(report: BenchmarkExperimentReport, variants: VariantId[], config: BenchmarkConfig): string[] {
  const comparisons = report.comparisons
  const all = (test: (c: ScenarioProfileComparisonReport) => boolean) =>
    comparisons.length > 0 && comparisons.every(test)
  const box = (done: boolean, text: string) => `- [${done ? 'x' : ' '}] ${text}`
  const requested = Math.max(...comparisons.map((c) => c.requestedRepetitions))
  const finished = comparisons.flatMap((c) => c.samples).filter((s) => s.complete).length
  const interfered = [...new Set(comparisons.flatMap((c) => c.interferedSamples))]
  const parity = Object.values(report.upstreamParityByScenario)
  const upstream = parity.length > 0 && parity.every((p) => p.passed)
  const needed = headlineVariants(config)
  const measured = needed.filter((v) => variants.includes(v))
  const stackedIds = [...new Set(parity.flatMap((p) => p.baselineIncludesPatches ?? []))]
  const lines = [
    stackedIds.length
      ? box(
          false,
          `**Same CI as upstream:** not claimed: the baseline is upstream + merged agent PRs (${stackedIds.map((id) => `\`${id}\``).join(', ')})`,
        )
      : box(
          upstream,
          "**Same CI as upstream:** replays run the same workflows and jobs as upstream's own runs, with the same conclusions",
        ),
    box(
      all((c) => c.parityPassed),
      '**Same tests, same verdicts:** verified for every sample against the same runners with the CI unchanged',
    ),
    box(
      all((c) => c.evidenceLevel === 'coverage-qualified'),
      '**Coverage within 0.1 percentage points**',
    ),
    box(
      all((c) => c.cacheValidated),
      '**Cache state verified** for every sample',
    ),
    box(
      measured.length === needed.length,
      `**All ${needed.length} runner configurations measured** (${measured.length} of ${needed.length})`,
    ),
    box(
      finished === report.requestedSampleCount,
      `**All requested samples finished** (${finished} of ${report.requestedSampleCount})`,
    ),
    box(requested >= 5, `**At least 5 rounds** (${requested} requested)`),
    box(
      interfered.length === 0,
      `**No interference:** no other workflow run overlapped a sample${interfered.length ? ` (${interfered.length} excluded)` : ''}`,
    ),
  ]
  if (config.patches.length)
    lines.push(
      box(
        // Judged on every same-runner pair the experiment measured; the headline runs StarSling's pair only.
        costPairs(variants).length > 0 &&
          all((c) => costPairs(variants).every((p) => c.costNeutrality[p].qualifiesAsCostNeutralAgentOptimization)),
        '**Cost neutral:** the agent PRs add no sharding that spends the freed minutes',
      ),
    )
  for (const job of config.execution.excludedJobs ?? [])
    lines.push(
      `- **Not timed, not judged:** \`${job.workflowFile}\` job \`${job.jobId}\` runs in every setup but is left out of the wait and the verdict (${job.reason}); the only claim made for it is that it fails the same way in every setup`,
    )
  const reasons = [...new Set(comparisons.flatMap((c) => c.withheldReasons))]
  if (reasons.length)
    lines.push(
      '',
      '<details>',
      '<summary>Every reason a claim is withheld</summary>',
      '',
      ...reasons.map((r) => `- ${r}`),
      '',
      '</details>',
    )
  return lines
}

function parityLines(report: BenchmarkExperimentReport, config: BenchmarkConfig): string[] {
  const lines: string[] = []
  for (const name of [...new Set(ordered(config, report.comparisons).map((c) => c.scenarioName))]) {
    const parity = report.upstreamParityByScenario[name]
    if (!parity) continue
    const label = scenarioLabel(config, name)
    const runs = parity.referenceRunUrls.map((url) => `[${runLabel(url)}](${url})`).join(', ')
    if (parity.baselineIncludesPatches?.length) {
      lines.push(
        `- **${label}:** not claimed. The baseline is upstream + merged agent PRs (${parity.baselineIncludesPatches.map((id) => `\`${id}\``).join(', ')}), so it differs from upstream's own run${runs ? ` (${runs})` : ''} on purpose.`,
      )
      continue
    }
    if (!parity.referenceAvailable) {
      lines.push(`- **${label}:** no upstream reference run locked yet.`)
      continue
    }
    const timing =
      parity.referenceWallClockSeconds !== null
        ? ` Upstream's own run took ${formatDuration(parity.referenceWallClockSeconds)}.`
        : ''
    if (parity.passed) {
      const jobs = report.comparisons
        .flatMap((c) => (c.scenarioName === name ? c.samples : []))
        .find((s) => s.variant === 'github-baseline' && s.complete)
        ?.workflows.flatMap((w) => w.jobs)
        .filter((j) => j.conclusion !== 'skipped').length
      lines.push(
        `- **${label}:** same workflows and ${jobs === undefined ? 'all jobs' : `${jobs} ${jobs === 1 ? 'job' : 'jobs'}`} as upstream (${runs}), same conclusions.${timing}`,
      )
    } else {
      lines.push(`- **${label}:** does not match upstream yet (${runs}).${timing}`)
      const first = parity.comparisons.find((cmp) => !cmp.passed)
      for (const job of first?.missingJobs.slice(0, 5) ?? []) lines.push(`  - Ran upstream, not in the replay: ${job}`)
      for (const job of first?.unexpectedJobs.slice(0, 5) ?? [])
        lines.push(`  - Ran in the replay, not upstream: ${job}`)
      for (const m of first?.conclusionMismatches.slice(0, 5) ?? [])
        lines.push(`  - ${m.job}: upstream ${m.reference}, replay ${m.replay}`)
    }
  }
  return lines
}

function jobTable(comparison: ScenarioProfileComparisonReport, variants: VariantId[], limit = 15): string[] {
  const rows = buildJobBreakdown(comparison)
  if (!rows.length) return ['_No complete rounds yet._']
  const lines = [
    `| Job | Runner | ${variants.map((v) => VARIANT_SHORT[v]).join(' | ')} |`,
    `|---|---|${variants.map(() => '---:').join('|')}|`,
  ]
  for (const row of rows.slice(0, limit)) {
    const runner =
      row.githubLabel && row.starslingLabel && row.githubLabel !== row.starslingLabel
        ? `\`${row.githubLabel}\` → \`${row.starslingLabel}\``
        : row.githubLabel
          ? `\`${row.githubLabel}\``
          : '—'
    lines.push(
      `| \`${escapeCell(workflowName(row.workflowPath))}\` › ${escapeCell(row.jobName)} | ${runner} | ${variants
        .map((v) => formatDuration(row.medians[v]))
        .join(' | ')} |`,
    )
  }
  lines.push(
    '',
    `<sub>— means the job does not run in that configuration (an agent PR removed or merged it) or has no complete round.${rows.length > limit ? ` ${rows.length - limit} shorter jobs are in [\`benchmark/results.json\`](benchmark/results.json).` : ''}</sub>`,
  )
  return lines
}

function sampleTable(
  comparisons: ScenarioProfileComparisonReport[],
  config: BenchmarkConfig,
  variants: VariantId[],
): string[] {
  const lines = [
    `| Event | Cache | Round | ${variants.map((v) => VARIANT_SHORT[v]).join(' | ')} |`,
    `|---|---|---:|${variants.map(() => '---:').join('|')}|`,
  ]
  for (const c of ordered(config, comparisons)) {
    const reps = [...new Set(c.samples.map((s) => s.repetition))].sort((a, b) => a - b)
    for (const rep of reps) {
      const cells = variants.map((v) => {
        const sample = c.samples.find((s) => s.variant === v && s.repetition === rep)
        if (!sample) return '—'
        const link = sample.workflows[0]?.htmlUrl
        const text = !sample.complete
          ? sample.queueVoid
            ? `replaced (${sample.incompleteReasons.find((r) => r.startsWith('queued ')) ?? 'queued for a runner'})`
            : 'incomplete'
          : `${formatDuration(sample.metrics.wallClockSeconds)}${c.interferedSamples.includes(sample.sampleId) ? ' (excluded)' : ''}`
        return link ? `${text} [🔗](${link})` : text
      })
      lines.push(`| ${scenarioLabel(config, c.scenarioName)} | ${c.profileName} | ${rep} | ${cells.join(' | ')} |`)
    }
  }
  return lines
}

/** Reader-facing terms; GLOSSARY.md holds the full language. */
function termsTable(): string[] {
  return [
    '| Term | Meaning |',
    '|---|---|',
    '| **PR CI duration** | Elapsed time from the first workflow starting to the last job finishing, across every workflow one PR update starts (including `workflow_run` follow-ups). |',
    '| **Merge CI duration** | The same, for every workflow one merge to the default branch starts. |',
    '| **CI minutes** | The sum of every job’s runtime for one event. Jobs kept on GitHub-hosted runners still count. |',
    '| **Hardware only** | StarSling Runners running the project’s CI unchanged. |',
    '| **Self-improving CI** | The project’s CI with StarSling’s agent PRs applied. |',
    '| **Total speedup** | Hardware speedup × self-improving CI speedup, against GitHub-hosted runners. |',
    '| **Round** | One replay of the event on every runner configuration. Medians use only complete rounds. |',
    '| **Cold / warm cache** | Cold starts with no GitHub Actions caches; warm starts from caches a seed run produced on the same runner configuration. |',
    '| **Cost neutral** | Self-improving CI saves CI minutes without adding parallel jobs that spend them again. Hardware speedups never establish it. |',
  ]
}

/** The method note for a two-record result: which record each arm comes from, and how far apart they ran. */
export function fixArmNote(fixArm: FixArmInfo): string {
  const when = Number.isFinite(fixArm.gapSeconds)
    ? `, which ran ${describeGap(fixArm.gapSeconds)} ${fixArm.gapSeconds < 0 ? 'before' : 'after'} \`${fixArm.baseId}\` finished`
    : ''
  return `**Two experiment records.** The GitHub and StarSling-runners-alone numbers come from experiment \`${fixArm.baseId}\`; the StarSling + agent PRs numbers come from experiment \`${fixArm.fixId}\`${when}. Both ran the same scenarios and cache profiles with the same configuration; only the agent PR patches differ. ${fixArm.harness === 'matched' ? 'Both records name the same harness version.' : 'The harness version is not recorded in one or both records, so it could not be compared.'} Because the two arms were not measured back to back, GitHub-hosted and StarSling machine conditions may differ between them.`
}

export function methodLines(
  report: BenchmarkExperimentReport,
  config: BenchmarkConfig,
  narrative: ShowcaseNarrative,
  fixArm?: FixArmInfo,
): string[] {
  const up = config.upstream.repository
  const measured = new Set(report.comparisons.map((c) => c.scenarioName))
  const scenarios = Object.values(config.scenarios)
    .filter((s) => measured.has(s.name))
    .map((s) => {
      if (s.pr)
        return `PR [#${s.pr.prNumber ?? '?'}](https://github.com/${up}/pull/${s.pr.prNumber ?? ''}) (head [\`${s.pr.headSha.slice(0, 8)}\`](https://github.com/${up}/commit/${s.pr.headSha}))`
      if (s.main)
        return `the merge of [\`${s.main.afterSha.slice(0, 8)}\`](https://github.com/${up}/commit/${s.main.afterSha}) to \`${s.main.branch}\``
      return s.name
    })
  const profiles = [...new Set(report.comparisons.map((c) => c.profileName))]
  const reps = Math.max(...report.comparisons.map((c) => c.requestedRepetitions))
  const prs = config.patches.length
  const lines = [
    `1. **Pin.** ${up} is pinned at [\`${config.upstream.commitSha.slice(0, 8)}\`](https://github.com/${up}/commit/${config.upstream.commitSha}), the [\`upstream/\`](upstream) submodule in this repository. Each scenario replays one real upstream event: ${scenarios.join('; ')}.`,
    `2. **Replay natively.** Each sample pushes that exact tree to this repository's \`${replayBranchOf(config)}\` branch and fires the real GitHub event (a push, or a PR synchronize). Every workflow, job and step runs with its own triggers, filters, \`needs\`, conditions, matrices and \`workflow_run\` follow-ups, in the order GitHub schedules them.`,
    `3. **Runner configurations.** GitHub-hosted runners and StarSling Runners run the CI unchanged${prs ? `; StarSling Runners also run it with the ${prs === 1 ? 'agent PR' : `${prs} agent PRs`} applied (self-improving CI)` : ''}. Jobs on runners StarSling does not offer stay on GitHub-hosted runners in every configuration and still count.`,
    `4. **Rounds.** ${reps} round${reps === 1 ? '' : 's'}; in each, every runner configuration replays the event once, in a deterministic shuffled order, one sample at a time. Medians use only complete rounds, and a sample counts only if every expected job succeeded on the first attempt.`,
    `5. **Control caches.** ${profiles.map((p) => `${capitalize(p)} cache: ${profileSummary(config, p)}`).join(' ')}`,
    "6. **Check.** Replays are compared job by job with upstream's own runs for the same commit, and every sample's test verdicts, coverage and cache restores are read from its own job logs.",
  ]
  const notes = [...(narrative.notes ?? [])]
  if (fixArm) notes.push(fixArmNote(fixArm))
  if (notes.length) lines.push('', ...notes.map((note) => `- ${note}`))
  return lines
}

function details(summary: string, body: string[]): string[] {
  return ['<details>', `<summary>${summary}</summary>`, '', ...body, '', '</details>', '']
}

/** The benchmark page before its first experiment: what is measured, where, and against which upstream commit. */
export function renderPendingShowcase(params: { config: BenchmarkConfig; narrative?: ShowcaseNarrative }): string {
  const { config } = params
  const narrative = params.narrative ?? {}
  const up = config.upstream.repository
  const title = narrative.title ?? up.split('/')[1] ?? up
  const prs = config.patches.length
  return [
    `# ${title} CI: GitHub-hosted vs StarSling Runners`,
    '',
    `_Not affiliated with [${up}](https://github.com/${up})${narrative.stars ? ` (${narrative.stars} stars)` : ''}._`,
    '',
    `${title}'s own CI workflows, replayed for real upstream ${Object.values(config.scenarios).some((s) => s.pr) ? 'PRs and merges' : 'merges'} on GitHub-hosted runners and on StarSling Runners${prs ? `, with and without ${prs === 1 ? 'one agent PR' : `${prs} agent PRs`} (self-improving CI)` : ''}.`,
    '',
    '> [!NOTE]',
    '> **Results pending.** The first experiment has not been published yet; this page is replaced by its results.',
    '',
    `[\`upstream/\`](upstream) is ${up} at the pinned commit [\`${config.upstream.commitSha.slice(0, 8)}\`](https://github.com/${up}/commit/${config.upstream.commitSha}). Replays run on the \`${replayBranchOf(config)}\` branch.`,
    '',
  ].join('\n')
}

export function renderShowcase(params: {
  report: BenchmarkExperimentReport
  config: BenchmarkConfig
  narrative?: ShowcaseNarrative
  /** Showcase layout only: the per-lever A/B experiments the agent PR table reads, by experiment id. */
  leverReports?: Record<string, BenchmarkExperimentReport>
  /** Set when the StarSling + agent PRs arm came from a second experiment record (`--fix-arm-experiment`). */
  fixArm?: FixArmInfo
}): string {
  if (params.narrative?.layout === 'showcase') return renderShowcaseLayout(params)
  const { report, config } = params
  const narrative = params.narrative ?? {}
  const up = config.upstream.repository
  const title = narrative.title ?? up.split('/')[1] ?? up
  const prs = config.patches.length
  const profiles = [...new Set(report.comparisons.map((c) => c.profileName))]
  const variants = variantsWithData(report.comparisons, config)
  const out: string[] = [
    `# ${title} CI: GitHub-hosted vs StarSling Runners`,
    '',
    `_Not affiliated with [${up}](https://github.com/${up})${narrative.stars ? ` (${narrative.stars} stars)` : ''}._`,
    '',
    `${title}'s own CI workflows, replayed for real upstream ${eventsReplayed(report, config)} on GitHub-hosted runners and on StarSling Runners. ${prs ? 'The results separate the hardware speedup from the self-improving CI speedup.' : 'The results show the hardware speedup.'} Every number comes from this repository's replays; upstream's own runs are linked for comparison.`,
    '',
    ...statusAlerts(report),
    '## Results',
  ]
  for (const profile of profiles) {
    const comparisons = report.comparisons.filter((c) => c.profileName === profile)
    if (profiles.length > 1) out.push('', `### ${capitalize(profile)} cache`)
    out.push(
      '',
      profileSummary(config, profile),
      '',
      ...resultsTable(config, comparisons),
      '',
      ...speedupTable(config, comparisons),
    )
    const notes = noteLines(config, comparisons)
    if (notes.length) out.push('', ...notes)
  }
  out.push('', '<sub>Medians over complete rounds. Total speedup = hardware speedup × self-improving CI speedup.</sub>')

  out.push('', '## Runners', '', ...runnersTable(report, config))
  out.push('', '## Claim checklist', '', ...claimChecklist(report, variants, config))
  out.push('', '### Same CI as upstream', '', ...parityLines(report, config))
  if (narrative.same) out.push('', '### Same checks, same results', '', narrative.same)

  out.push('', '## Terms', '', ...termsTable())

  out.push('', '## Appendix', '')
  const primary = profiles[0]
  out.push(
    ...details(
      `Where the time goes: median time per job (${primary ?? ''} cache)`,
      report.comparisons
        .filter((c) => c.profileName === primary)
        .flatMap((c) => ['', `**${scenarioLabel(config, c.scenarioName)}**`, '', ...jobTable(c, variants)])
        .slice(1),
    ),
    ...details('Every sample, with links to its runs', sampleTable(report.comparisons, config, variants)),
  )
  if (prs) {
    const files = config.patches.map((p) => patchPath(p.id))
    out.push(
      ...details('Agent PRs in the self-improving CI', [
        ...(narrative.agentPullRequests?.length
          ? narrative.agentPullRequests.map((url) => `- ${url}`)
          : [
              `The self-improving CI applies ${prs === 1 ? 'one agent PR' : `${prs} agent PRs`} to ${title}'s own files:`,
            ]),
        '',
        ...files.map((file, i) => `- [Agent PR ${i + 1}](${file}) (patch file)`),
      ]),
    )
  }
  out.push(...details('Method', methodLines(report, config, narrative)))
  out.push(
    `<sub>Generated by \`bench showcase\` from experiment \`${report.experimentId}\`. Machine-readable results: [\`benchmark/results.json\`](benchmark/results.json).</sub>`,
    '',
  )
  return out.join('\n')
}
