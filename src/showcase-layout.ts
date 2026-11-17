/**
 * The "showcase" README layout: Results (GitHub vs StarSling, runner time first and wait second, cold and warm side by
 * side, where the savings come from, and any warning), Terms in plain English, then an Appendix of collapsed sections with everything else
 * (agent PRs, what was slow, what we changed, same checks, every round, how it is measured, runners). Time and minutes
 * only; no money anywhere.
 *
 * Rules shared with the default layout: numbers come from the report model, a claim without verified evidence is not
 * printed, and a missing input omits its element instead of inventing it.
 */
import { isPullRequestEvent } from './config.ts'
import { describeGap, type FixArmInfo } from './fix-arm.ts'
import type { BenchmarkExperimentReport, ScenarioProfileComparisonReport } from './reporter.ts'
import { methodLines, profileSummary, runnersTable } from './showcase.ts'
import {
  type AgentPrEntry,
  patchPath,
  type RunFrequency,
  type ShowcaseNarrative,
  VARIANT_LABELS,
} from './showcase-model.ts'
import type { BenchmarkConfig, VariantId } from './types.ts'

const CONFIGS: { variant: VariantId; label: string }[] = [
  { variant: 'github-baseline', label: 'GitHub unchanged' },
  { variant: 'starsling-baseline', label: 'StarSling unchanged (hardware alone)' },
  { variant: 'starsling-patched', label: 'StarSling + agent PRs' },
]
/** The two headline rows. With agent PRs StarSling is runners + agent PRs; with none it is the runners alone. */
const headlineConfigs = (withAgentPrs: boolean): { variant: VariantId; label: string }[] => [
  { variant: 'github-baseline', label: "GitHub (the project's CI as is, on GitHub-hosted runners)" },
  withAgentPrs
    ? { variant: 'starsling-patched', label: 'StarSling (StarSling runners + agent PRs)' }
    : { variant: 'starsling-baseline', label: 'StarSling (runners)' },
]
const capitalize = (text: string) => `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
const minutes = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined || !Number.isFinite(seconds) ? '—' : `${(seconds / 60).toFixed(2)} min`
const mins = (m: number | null | undefined) =>
  m === null || m === undefined || !Number.isFinite(m) ? '—' : `${m.toFixed(2)} min`
const ratio = (from: number | null, to: number | null): number | null =>
  from === null || to === null || from <= 0 || to <= 0 ? null : from / to
/** Which number a table column or breakdown is about. Runner time leads; wait is second. */
interface Metric {
  /** Phrase after the multiple when StarSling is better, and when it is worse. */
  better: string
  worse: string
  value: (c: ScenarioProfileComparisonReport | undefined, v: VariantId) => number | null
  show: (n: number | null) => string
}
const RUNNER_TIME: Metric = {
  better: 'less runner time',
  worse: 'more runner time',
  value: (c, v) => c?.variants[v].repoMinutes.median ?? null,
  show: mins,
}
const WAIT: Metric = {
  better: 'faster',
  worse: 'slower',
  value: (c, v) => c?.variants[v].wallClockSec.median ?? null,
  show: minutes,
}
const multiple = (r: number | null, m: Metric) =>
  r === null ? '—' : r >= 1 ? `**${r.toFixed(1)}x** ${m.better}` : `**${(1 / r).toFixed(1)}x** ${m.worse}`

type Params = {
  report: BenchmarkExperimentReport
  config: BenchmarkConfig
  narrative?: ShowcaseNarrative
  leverReports?: Record<string, BenchmarkExperimentReport>
  /** Set when the StarSling + agent PRs arm came from a second experiment record (`--fix-arm-experiment`). */
  fixArm?: FixArmInfo
}

const isPr = (config: BenchmarkConfig, scenarioName: string) =>
  isPullRequestEvent(config.scenarios[scenarioName]?.event ?? '')
const find = (report: BenchmarkExperimentReport, scenario: string, profile: string) =>
  report.comparisons.find((c) => c.scenarioName === scenario && c.profileName === profile)
const wait = (c: ScenarioProfileComparisonReport | undefined, v: VariantId) =>
  c?.variants[v].wallClockSec.median ?? null
const hasData = (c: ScenarioProfileComparisonReport | undefined, v: VariantId) =>
  Boolean(c?.samples.some((s) => s.variant === v))

/** Scenarios of one lane (merges or PR updates), in config order. */
function laneScenarios(report: BenchmarkExperimentReport, config: BenchmarkConfig, pr: boolean): string[] {
  return [...new Set(report.comparisons.map((c) => c.scenarioName))].filter((n) => isPr(config, n) === pr)
}

function frequencyOf(n: ShowcaseNarrative, pr: boolean): RunFrequency | undefined {
  const f = pr ? n.prUpdatesPerMonth : n.pushesPerMonth
  return f && Number.isFinite(f.value) && f.value > 0 && f.source ? f : undefined
}

function resultTable(
  report: BenchmarkExperimentReport,
  scenario: string,
  profiles: string[],
  pr: boolean,
  withAgentPrs: boolean,
): string[] {
  const what = pr ? 'PR update' : 'push'
  const head =
    profiles.length > 1
      ? profiles.flatMap((p) => [
          `${capitalize(p)} runner time`,
          `${capitalize(p)} vs GitHub`,
          `${capitalize(p)} wait`,
          `${capitalize(p)} vs GitHub`,
        ])
      : [`Runner time per ${what}`, 'vs GitHub', `Wait per ${what}`, 'vs GitHub']
  const lines = [`| | ${head.join(' | ')} |`, `|---|${head.map(() => '---:').join('|')}|`]
  for (const { variant, label } of headlineConfigs(withAgentPrs)) {
    const cells = profiles.flatMap((p) => {
      const c = find(report, scenario, p)
      if (!hasData(c, variant)) return ['_not measured yet_', '', '', '']
      return [RUNNER_TIME, WAIT].flatMap((m) => {
        const value = m.value(c, variant)
        return [
          value === null ? '—' : `**${m.show(value)}**`,
          variant === 'github-baseline' ? '1x' : multiple(ratio(m.value(c, 'github-baseline'), value), m),
        ]
      })
    })
    lines.push(`| ${label} | ${cells.join(' | ')} |`)
  }
  return lines
}

/** The machine size a configuration ran on, read from the labels its jobs used and the config's runner specs. */
function runnerSize(report: BenchmarkExperimentReport, config: BenchmarkConfig, variant: VariantId): string {
  const labels = new Set<string>()
  for (const sample of report.comparisons.flatMap((c) => c.samples))
    if (sample.variant === variant)
      for (const job of sample.workflows.flatMap((w) => w.jobs))
        if (job.conclusion !== 'skipped' && job.labels[0]) labels.add(job.labels[0])
  const sizes = [...labels].sort().map((label) => {
    const spec = config.runnerMapping.runnerSpecs[label]
    return spec ? `${spec.vcpu} vCPU` : `\`${label}\``
  })
  return [...new Set(sizes)].join(' / ') || 'size not recorded'
}

/** "GitHub 4 vCPU vs StarSling 4 vCPU": runner time only compares at equal machine size, so the sizes sit next to it. */
function sizeComparison(report: BenchmarkExperimentReport, config: BenchmarkConfig, withAgentPrs: boolean): string {
  const github = runnerSize(report, config, 'github-baseline')
  const starsling = runnerSize(report, config, withAgentPrs ? 'starsling-patched' : 'starsling-baseline')
  return `GitHub ${github} vs StarSling ${starsling}`
}

const hasAgentPrData = (report: BenchmarkExperimentReport) =>
  report.comparisons.some((c) => hasData(c, 'starsling-patched'))

/**
 * The headline above the table: runner time first (the total machine time all jobs used for one push), then wait.
 * StarSling vs GitHub, per cache profile when there are several.
 */
function headlineSentences(
  report: BenchmarkExperimentReport,
  config: BenchmarkConfig,
  scenario: string,
  profiles: string[],
  pr: boolean,
  withAgentPrs: boolean,
): string[] {
  const starsling: VariantId = withAgentPrs ? 'starsling-patched' : 'starsling-baseline'
  const what = pr ? 'PR update' : 'push'
  const sentence = (m: Metric, text: (verdict: string, from: string, to: string, tag: string) => string) =>
    profiles
      .flatMap((p) => {
        const c = find(report, scenario, p)
        const from = m.value(c, 'github-baseline')
        const to = m.value(c, starsling)
        const r = ratio(from, to)
        if (r === null) return []
        const verdict = r >= 1 ? `${r.toFixed(1)}x ${m.better}` : `${(1 / r).toFixed(1)}x ${m.worse}`
        return [text(verdict, m.show(from), m.show(to), profiles.length > 1 ? `${capitalize(p)}: ` : '')]
      })
      .join(' ')
  const runner = sentence(
    RUNNER_TIME,
    (verdict, from, to, tag) =>
      `${tag}**StarSling: ${verdict}** than GitHub per ${what} (${from} → ${to} of machine time; ${sizeComparison(report, config, withAgentPrs)}).`,
  )
  const waitSentence = sentence(
    WAIT,
    (verdict, from, to, tag) =>
      `${tag}Wait: **StarSling is ${verdict}** than GitHub for a ${what} to finish every check (${from} → ${to}).`,
  )
  if (!runner && !waitSentence) return []
  const definition = withAgentPrs
    ? 'StarSling = StarSling runners + StarSling agent PRs.'
    : 'StarSling = StarSling runners.'
  return [...(runner ? [runner, '', definition] : [definition]), ...(waitSentence ? ['', waitSentence] : [])]
}

/** "Where the savings come from": runners alone times agent PRs on the same runners equals the headline. Agent PRs only. */
function breakdownLines(report: BenchmarkExperimentReport, scenario: string, profiles: string[]): string[] {
  const section = (m: Metric, title: string): string[] => {
    const lines = profiles.flatMap((p) => {
      const c = find(report, scenario, p)
      const github = m.value(c, 'github-baseline')
      const runners = m.value(c, 'starsling-baseline')
      const patched = m.value(c, 'starsling-patched')
      const a = ratio(github, runners)
      const b = ratio(runners, patched)
      const total = ratio(github, patched)
      if (a === null || b === null || total === null) return []
      const x = (r: number) => `${r.toFixed(1)}x`
      const tag = profiles.length > 1 ? `${capitalize(p)}: ` : ''
      return [
        `- ${tag}StarSling runners alone (CI unchanged): ${m.show(runners)}, ${multiple(a, m)} than GitHub`,
        `- ${tag}StarSling agent PRs, on the same runners: ${multiple(b, m)} (${m.show(runners)} → ${m.show(patched)})`,
        `- ${tag}Together: ${x(a)} × ${x(b)} = ${x(total)}`,
      ]
    })
    return lines.length ? [title, '', ...lines] : []
  }
  const runner = section(RUNNER_TIME, 'Runner time:')
  const waitLines = section(WAIT, 'Wait:')
  if (!runner.length && !waitLines.length) return []
  return [
    '**Where the savings come from**',
    '',
    ...runner,
    ...(runner.length && waitLines.length ? [''] : []),
    ...waitLines,
  ]
}

/** Samples that failed or were re-run and replaced, per configuration (an incomplete sample with a recorded reason). */
function failedSamples(report: BenchmarkExperimentReport): { label: string; count: number }[] {
  return CONFIGS.map(({ variant, label }) => ({
    label,
    count: report.comparisons
      .flatMap((c) => c.samples)
      .filter(
        (s) =>
          s.variant === variant &&
          !s.complete &&
          (s.incompleteReasons.length > 0 || s.failedJobs.length > 0 || s.cancelledJobs.length > 0),
      ).length,
  }))
}

function savingsLines(
  report: BenchmarkExperimentReport,
  config: BenchmarkConfig,
  narrative: ShowcaseNarrative,
  profiles: string[],
  withAgentPrs: boolean,
): string[] {
  const lines: string[] = []
  for (const pr of [false, true]) {
    const freq = frequencyOf(narrative, pr)
    if (!freq) continue
    for (const scenario of laneScenarios(report, config, pr))
      for (const p of profiles) {
        const c = find(report, scenario, p)
        const before = c?.variants['github-baseline']
        const after = c?.variants[withAgentPrs ? 'starsling-patched' : 'starsling-baseline']
        if (before?.wallClockSec.median == null || after?.wallClockSec.median == null) continue
        if (before.repoMinutes.median == null || after.repoMinutes.median == null) continue
        const perRun = before.repoMinutes.median - after.repoMinutes.median
        const saved = perRun * freq.value
        const fmt = (n: number) =>
          `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} min`
        lines.push(
          `- **${profiles.length > 1 ? `${capitalize(p)}, ` : ''}per ${pr ? 'PR update' : 'push'}:** ${fmt(perRun)} of runner time saved per run, **${fmt(saved)} saved per month** (${freq.value.toLocaleString('en-US')} ${pr ? 'PR updates' : 'pushes'} per month; source: ${freq.source}).`,
        )
      }
  }
  return lines
}

interface LeverRow {
  entry: AgentPrEntry
  before: number | null
  after: number | null
  runs: string
}

function leverRow(entry: AgentPrEntry, params: Params, headlineScenario: string, headlineProfile: string): LeverRow {
  const empty = { entry, before: null, after: null, runs: '' }
  const ref = entry.experiment
  const lever = ref ? params.leverReports?.[ref.id] : undefined
  if (!ref || !lever) return empty
  const c = find(lever, ref.scenario ?? headlineScenario, ref.profile ?? headlineProfile)
  // Unverified checks (the lever's CI did not provably do the same work) are not a measurement.
  if (!c?.parityPassed) return empty
  const b = c.variants[ref.before]
  const a = c.variants[ref.after]
  if (b.wallClockSec.median === null || a.wallClockSec.median === null) return empty
  const runs =
    b.completeSamples === a.completeSamples
      ? `${a.completeSamples} runs per side`
      : `${b.completeSamples} runs before, ${a.completeSamples} after`
  return { entry, before: b.wallClockSec.median, after: a.wallClockSec.median, runs }
}

function agentPrSection(
  params: Params,
  headlineScenario: string,
  headlineProfile: string,
): { table: string[]; warning: string[] } {
  const { report } = params
  const entries = params.narrative?.agentPrs ?? []
  if (!entries.length) return { table: [], warning: [] }
  const rows = entries.map((e) => leverRow(e, params, headlineScenario, headlineProfile))
  const lines = [
    '| # | Agent PR | What it changed | Its own effect (typical wait, before → after) | Wait after it (cumulative) |',
    '|---:|---|---|---|---:|',
  ]
  rows.forEach((row, i) => {
    const effect =
      row.before === null || row.after === null
        ? '_not measured_'
        : `${minutes(row.before)} → ${minutes(row.after)} (${row.after <= row.before ? '−' : '+'}${Math.abs(Math.round(((row.after - row.before) / row.before) * 100))}%), ${row.runs}`
    lines.push(
      `| ${i + 1} | [${row.entry.url.split('/').slice(-2).join('/')}](${row.entry.url}) | ${row.entry.summary.replace(/\|/g, '\\|')} | ${effect} | ${row.after === null ? '—' : minutes(row.after)} |`,
    )
  })
  const last = rows.at(-1)
  const lastRef = last?.entry.experiment
  const headlineWait = wait(
    find(report, lastRef?.scenario ?? headlineScenario, lastRef?.profile ?? headlineProfile),
    'starsling-patched',
  )
  const warning =
    last?.after != null && headlineWait !== null && Math.abs(last.after - headlineWait) / headlineWait > 0.1
      ? [
          '> [!WARNING]',
          `> **The last agent PR's cumulative wait (${minutes(last.after)}) does not match the headline "StarSling" (${minutes(headlineWait)}).** They differ by more than 10%, so the per-PR numbers and the headline do not describe the same CI. Treat both as unreconciled until the per-PR experiments are re-run.`,
        ]
      : []
  return { table: lines, warning }
}

/** The "same checks" evidence: a visible warning when it is incomplete, else the sentence for the Appendix. */
function sameChecks(
  report: BenchmarkExperimentReport,
  narrative: ShowcaseNarrative,
): { warning: string[]; note: string[] } {
  const all =
    report.comparisons.length > 0 &&
    report.comparisons.every((c) => c.parityPassed && c.evidenceLevel === 'coverage-qualified' && c.cacheValidated)
  if (!all) {
    const reasons = [...new Set(report.comparisons.flatMap((c) => c.withheldReasons))]
    return {
      warning: [
        '> [!WARNING]',
        '> **Not verified yet.** The evidence that the checks and their output are the same is incomplete, so no "same output" claim is made.',
        ...(reasons.length ? ['', ...reasons.map((r) => `- ${r}`)] : []),
      ],
      note: ['Not verified yet. See the warning under Results for what is missing.'],
    }
  }
  return {
    warning: [],
    note: [
      narrative.same ??
        "Every counted sample's test verdicts, coverage and cache restores were read from its own job logs and match the unchanged CI.",
    ],
  }
}

/** Plain-English terms, only the ones this page uses. */
function termsLines(profiles: string[], withAgentPrs: boolean): string[] {
  const rows: [string, string][] = [
    ['Runner time', 'Total machine time all jobs used for one push, summed across jobs; billed per second.'],
    [
      'Wait',
      'How long one push (or PR update) takes until every check has finished: from the first workflow starting to the last job finishing.',
    ],
    ['GitHub', "The project's own CI, unchanged, on GitHub-hosted runners (the machines GitHub rents out)."],
    [
      'StarSling',
      withAgentPrs
        ? 'StarSling runners (faster machines) plus StarSling agent PRs (changes to the CI itself).'
        : 'StarSling runners: faster machines running the same CI.',
    ],
    ...(withAgentPrs
      ? ([
          [
            'Agent PRs',
            "Small pull requests StarSling's agent wrote against the project's CI to make it faster. Each is measured on its own in the Appendix.",
          ],
        ] as [string, string][])
      : []),
    ['Median', 'The middle result. Half the runs were faster, half were slower, so one odd run does not move it.'],
    ['Round', 'One replay of the same change on every setup. Only rounds where every setup finished cleanly count.'],
    ...(profiles.includes('cold')
      ? ([['Cold', 'Every run starts with no GitHub Actions caches (saved downloads and build output).']] as [
          string,
          string,
        ][])
      : []),
    ...(profiles.includes('warm')
      ? ([['Warm', 'Every run starts from caches that an earlier run on the same setup saved.']] as [string, string][])
      : []),
  ]
  return ['| Term | Meaning |', '|---|---|', ...rows.map(([term, meaning]) => `| **${term}** | ${meaning} |`)]
}

const details = (summary: string, body: string[]): string[] => [
  '<details>',
  `<summary>${summary}</summary>`,
  '',
  ...body,
  '',
  '</details>',
  '',
]

function sampleTables(report: BenchmarkExperimentReport, config: BenchmarkConfig, pr: boolean): string[] {
  const up = config.upstream.repository
  const profiles = [...new Set(report.comparisons.map((c) => c.profileName))]
  const lines = [
    `| Upstream commit | ${profiles.length > 1 ? 'Cache | ' : ''}Round | ${CONFIGS.map((c) => c.label).join(' | ')} |`,
    `|---|${profiles.length > 1 ? '---|' : ''}---:|${CONFIGS.map(() => '---:').join('|')}|`,
  ]
  for (const scenario of laneScenarios(report, config, pr)) {
    const s = config.scenarios[scenario]
    const sha = s?.pr?.headSha ?? s?.main?.afterSha ?? ''
    const commit = sha ? `[\`${sha.slice(0, 8)}\`](https://github.com/${up}/commit/${sha})` : scenario
    for (const profile of profiles) {
      const c = find(report, scenario, profile)
      if (!c) continue
      const reps = [...new Set(c.samples.map((x) => x.repetition))].sort((a, b) => a - b)
      for (const rep of reps) {
        const cells = CONFIGS.map(({ variant }) => {
          const sample = c.samples.find((x) => x.variant === variant && x.repetition === rep)
          if (!sample) return '—'
          const link = sample.workflows[0]?.htmlUrl
          const text = sample.complete ? minutes(sample.metrics.wallClockSeconds) : 'failed / re-run'
          return link ? `[${text}](${link})` : text
        })
        lines.push(
          `| ${commit} | ${profiles.length > 1 ? `${capitalize(profile)} | ` : ''}${rep} | ${cells.join(' | ')} |`,
        )
      }
    }
  }
  return lines
}

const MONEY = /\$\s*\d|\b(?:usd|dollars?)\b/i

/** This layout shows time and minutes only: refuse a dollar figure or currency word in any prose it prints. */
function assertNoMoney(n: ShowcaseNarrative): void {
  const fields: [string, string | undefined][] = [
    ['title', n.title],
    ['stars', n.stars],
    ['whatWasSlow', n.whatWasSlow],
    ['whatWeChanged', n.whatWeChanged],
    ['same', n.same],
    ['pushesPerMonth.source', n.pushesPerMonth?.source],
    ['prUpdatesPerMonth.source', n.prUpdatesPerMonth?.source],
    ...(n.notes ?? []).map((t, i): [string, string] => [`notes[${i}]`, t]),
    ...(n.agentPrs ?? []).map((p, i): [string, string] => [`agentPrs[${i}].summary`, p.summary]),
  ]
  for (const [name, text] of fields)
    if (text && MONEY.test(text))
      throw new Error(
        `showcase.json "${name}" contains a dollar figure or currency word; the showcase layout shows time and minutes only`,
      )
}

export function renderShowcaseLayout(params: Params): string {
  const { report, config } = params
  const narrative = params.narrative ?? {}
  assertNoMoney(narrative)
  const up = config.upstream.repository
  const title = narrative.title ?? up.split('/')[1] ?? up
  const profiles = [...new Set(report.comparisons.map((c) => c.profileName))]
  const lanes = [false, true].filter((pr) => laneScenarios(report, config, pr).length > 0)
  const headlineScenario = laneScenarios(report, config, lanes[0] ?? false)[0] ?? ''
  const headlineProfile = profiles[0] ?? ''
  const out: string[] = [
    `# ${title} CI: GitHub vs StarSling`,
    '',
    `> Not affiliated with [${up}](https://github.com/${up})${narrative.stars ? ` (${narrative.stars} stars)` : ''}. This repository replays ${title}'s own CI on real upstream commits to measure **how much machine time a push uses** (runner time) and **how long it waits for every check**, from the first workflow starting to the last job finishing.`,
    '',
    '## Results',
  ]
  const failed = failedSamples(report)
  const withAgentPrs = hasAgentPrData(report)
  for (const pr of lanes) {
    for (const scenario of laneScenarios(report, config, pr)) {
      out.push(
        '',
        `**${pr ? 'Pull-request updates' : 'Pushes'}** (${pr ? 'typical per PR update' : 'typical per push'}):`,
        '',
      )
      const sentence = headlineSentences(report, config, scenario, profiles, pr, withAgentPrs)
      if (sentence.length) out.push(...sentence, '')
      out.push(...resultTable(report, scenario, profiles, pr, withAgentPrs))
      out.push('', `Runner time compared at these machine sizes: ${sizeComparison(report, config, withAgentPrs)}.`)
      const breakdown = withAgentPrs ? breakdownLines(report, scenario, profiles) : []
      if (breakdown.length) out.push('', ...breakdown)
    }
  }
  const failedTotal = failed.reduce((n, f) => n + f.count, 0)
  if (failedTotal > 0)
    out.push(
      '',
      `> **${failedTotal} sample(s) failed or were re-run and replaced** (${failed
        .filter((f) => f.count)
        .map((f) => `${f.label}: ${f.count}`)
        .join('; ')}). Only complete samples are in the medians.`,
    )
  const savings = savingsLines(report, config, narrative, profiles, withAgentPrs)

  const prs = agentPrSection(params, headlineScenario, headlineProfile)
  const same = sameChecks(report, narrative)
  // Warnings stay in view: a collapsed block must not hide a reason to distrust the numbers above.
  for (const warning of [prs.warning, same.warning]) if (warning.length) out.push('', ...warning)
  if (params.fixArm)
    out.push(
      '',
      `> The StarSling + agent PRs numbers come from a second run, \`${params.fixArm.fixId}\`, taken ${describeGap(params.fixArm.gapSeconds)} ${params.fixArm.gapSeconds < 0 ? 'before' : 'after'} the first (\`${params.fixArm.baseId}\`). See "How it's measured" in the Appendix.`,
    )
  out.push(
    '',
    `<sub>Typical = the median over complete rounds. Total = StarSling runners alone × agent PRs on top. Details are in the Appendix.</sub>`,
    '',
    '## Terms',
    '',
    ...termsLines(profiles, withAgentPrs),
    '',
    '## Appendix',
    '',
  )

  if (prs.table.length)
    out.push(
      ...details('Agent PRs: what each one changed and its own effect', [
        `Merged in this order. Each row's effect comes from its own before/after experiment; the last row's cumulative wait is the headline.`,
        '',
        ...prs.table,
      ]),
    )
  if (narrative.whatWasSlow) out.push(...details('What was slow', [narrative.whatWasSlow]))
  const changeLinks = narrative.agentPrs?.length
    ? narrative.agentPrs.map((e) => `- [${e.summary}](${e.url})`)
    : config.patches.map((p, i) => `- [Agent PR ${i + 1}](${patchPath(p.id)}) (patch file)`)
  if (narrative.whatWeChanged || changeLinks.length)
    out.push(
      ...details('What we changed', [
        ...(narrative.whatWeChanged ? [narrative.whatWeChanged, ''] : []),
        ...changeLinks,
      ]),
    )
  out.push(...details('Same checks, same results', same.note))
  if (savings.length)
    out.push(
      ...details('Runner time saved per month', [
        'The runner time StarSling saves versus GitHub, computed from the per-run medians in Results and the run frequency below.',
        '',
        ...savings,
      ]),
    )
  if (lanes.includes(false))
    out.push(
      ...details('Every push, round by round', [
        'Each cell is the whole wait for that push and links to its run.',
        '',
        ...sampleTables(report, config, false),
      ]),
    )
  if (lanes.includes(true))
    out.push(
      ...details('Every PR update, round by round', [
        'Each cell is the whole wait for that update and links to its run.',
        '',
        ...sampleTables(report, config, true),
      ]),
    )
  out.push(
    ...details("How it's measured", [
      ...methodLines(report, config, narrative, params.fixArm),
      '',
      ...profiles.map((p) => `- **${capitalize(p)}:** ${profileSummary(config, p)}`),
      '- **Failed or re-run samples** (replaced, not in the medians): ' +
        failed.map((f) => `${f.label}: ${f.count}`).join('; ') +
        '.',
    ]),
    ...details('Runners', runnersTable(report, config)),
    `<sub>Generated by \`bench showcase\` from experiment \`${report.experimentId}\`${params.fixArm ? ` (StarSling + agent PRs arm from experiment \`${params.fixArm.fixId}\`)` : ''}. Machine-readable results: [\`benchmark/results.json\`](benchmark/results.json). Configurations: ${CONFIGS.map((c) => VARIANT_LABELS[c.variant]).join('; ')}.</sub>`,
    '',
  )
  return out.join('\n')
}
