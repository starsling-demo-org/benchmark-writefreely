/**
 * The "showcase" README layout (result table first, savings, one row per agent PR). Golden file:
 * docs/SHOWCASE-LAYOUT-EXAMPLE.md; `pnpm test -u` regenerates it. The default layout stays covered by
 * tests/showcase-example.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { SampleMeasurementResult } from '../src/collector.ts'
import { createExperimentManifest } from '../src/manifest.ts'
import { mergeFixArm } from '../src/fix-arm.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import { renderShowcase } from '../src/showcase.ts'
import type { VariantId } from '../src/types.ts'
import {
  buildReport,
  config,
  headline,
  levers,
  narrative,
  render,
  seconds,
  sample,
  reference,
  verified,
  agentPrs,
  type Manifest,
  type Timing,
} from './showcase-fixture.ts'

describe('showcase layout', () => {
  it('renders the golden example', async () => {
    const readme = render()
    const example = [
      '> [!CAUTION]',
      '> **Example rendering, not a measurement.** This is the "showcase" README layout `src/showcase-layout.ts` renders, from the fixture in `tests/showcase-layout.test.ts`. Every number is made up, and links to `upstream/`, `patches/` and `benchmark/` resolve only inside a benchmark repository. Regenerate with `pnpm test -u`.',
      '',
      readme,
    ].join('\n')
    await expect(example).toMatchFileSnapshot('../docs/SHOWCASE-LAYOUT-EXAMPLE.md')
  })

  it('puts Results first, then Terms, then an Appendix whose sections are all collapsed', () => {
    const readme = render()
    const order = [
      '## Results',
      '**StarSling:',
      "| GitHub (the project's CI as is, on GitHub-hosted runners) |",
      '| StarSling (StarSling runners + agent PRs) |',
      '**Where the savings come from**',
      '## Terms',
      '## Appendix',
      '<summary>Agent PRs',
      '<summary>What was slow',
      '<summary>What we changed',
      '<summary>Same checks, same results',
      '<summary>Runner time saved per month',
      '<summary>Every push, round by round',
      '<summary>Every PR update, round by round',
      "<summary>How it's measured",
      '<summary>Runners',
    ].map((needle) => readme.indexOf(needle))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(readme).toMatch(
      /\| Cold runner time \| Cold vs GitHub \| Cold wait \| Cold vs GitHub \| Warm runner time \| Warm vs GitHub \| Warm wait \| Warm vs GitHub \|/,
    )
    // No section heading other than the three top-level ones; everything else lives in <details>.
    expect(readme.match(/^## .*/gm)).toEqual(['## Results', '## Terms', '## Appendix'])
    const appendix = readme.slice(readme.indexOf('## Appendix'))
    expect(appendix.match(/<details>/g)).toHaveLength(9)
    expect(appendix.match(/<\/details>/g)).toHaveLength(9)
    expect(appendix.match(/^### /gm)).toBeNull()
  })

  it('explains the terms in plain English, and only the ones the page uses', () => {
    const readme = render()
    const terms = readme.slice(readme.indexOf('## Terms'), readme.indexOf('## Appendix'))
    for (const term of ['Runner time', 'Wait', 'GitHub', 'StarSling', 'Agent PRs', 'Median', 'Round', 'Cold', 'Warm'])
      expect(terms).toContain(`**${term}**`)
    expect(terms).not.toMatch(/runner minutes|CI minutes/i)
    expect(terms).toContain('Total machine time all jobs used for one push, summed across jobs; billed per second.')
    expect(terms.indexOf('**Runner time**')).toBeLessThan(terms.indexOf('**Wait**'))
    const plain = renderShowcase({
      report: buildReport(
        createExperimentManifest({
          config,
          experimentId: 'hw',
          profileNames: ['cold'],
          variants: ['github-baseline', 'starsling-baseline'],
        }),
      ),
      config,
      narrative: { layout: 'showcase', title: 'DefinitelyTyped' },
    })
    const plainTerms = plain.slice(plain.indexOf('## Terms'), plain.indexOf('## Appendix'))
    expect(plainTerms).not.toContain('**Agent PRs**')
    expect(plainTerms).not.toContain('**Warm**')
    expect(plainTerms).toContain('**Cold**')
  })

  it('frames the result as GitHub vs StarSling: a headline sentence, two headline rows, and a product breakdown', () => {
    const readme = render()
    expect(readme.split('\n')[0]).toBe('# DefinitelyTyped CI: GitHub vs StarSling')
    expect(readme).toContain('StarSling = StarSling runners + StarSling agent PRs.')
    // Two headline rows only: the runners-alone configuration is in the breakdown, not the table.
    const pushTable = readme.slice(readme.indexOf('**Pushes**'), readme.indexOf('**Where the savings come from**'))
    expect(pushTable.match(/^\| (GitHub|StarSling)/gm)).toHaveLength(2)
    expect(pushTable).not.toContain('hardware alone')
    // Breakdown: runners alone x agent PRs on the same runners = the headline multiple, for runner time and for wait.
    const report = headline()
    const c = report.comparisons.find((x) => x.scenarioName === 'main-push' && x.profileName === 'cold')
    const x = (r: number) => `${r.toFixed(1)}x`
    for (const [pick, together, headlineText] of [
      [
        (v: VariantId) => c?.variants[v].repoMinutes.median as number,
        'Runner time:',
        (t: number) => `Cold: **StarSling: ${x(t)} less runner time** than GitHub per push`,
      ],
      [
        (v: VariantId) => c?.variants[v].wallClockSec.median as number,
        'Wait:',
        (t: number) => `Cold: Wait: **StarSling is ${x(t)} faster** than GitHub for a push`,
      ],
    ] as const) {
      const a = pick('github-baseline') / pick('starsling-baseline')
      const b = pick('starsling-baseline') / pick('starsling-patched')
      const total = pick('github-baseline') / pick('starsling-patched')
      expect(a * b).toBeCloseTo(total, 9)
      expect(readme).toContain(together)
      expect(readme).toContain(`Cold: Together: ${x(a)} × ${x(b)} = ${x(total)}`)
      expect(readme).toContain(headlineText(total))
    }
    expect(readme).toContain('Cold: StarSling runners alone (CI unchanged)')
    expect(readme).toContain('Cold: StarSling agent PRs, on the same runners')
  })

  it('leads Results with runner time, as exact per-second sums, and puts wait second', () => {
    // Three jobs, two of them side by side: runner time (sum of job seconds) differs from wait (wall clock), and no
    // sum is a whole number of minutes, so a per-job round-up to whole minutes would show.
    const extra = (s: SampleMeasurementResult) => {
      const lint = 37 + ((s.repetition * 11) % 7)
      const workflow = s.workflows[0]
      if (!workflow) return s
      const first = workflow.jobs[0]
      if (!first) return s
      const job = { ...first, jobName: 'lint', logicalJobId: 'lint', durationSeconds: lint }
      const raw = workflow.jobs.reduce((n, j) => n + (j.durationSeconds ?? 0), 0) + lint
      return {
        ...s,
        metrics: { ...s.metrics, rawRunnerSeconds: raw, repoMinutes: raw / 60 },
        workflows: [{ ...workflow, jobs: [...workflow.jobs, job] }],
      }
    }
    const report = headline(extra)
    const readme = renderShowcase({ report, config, narrative: narrative(), leverReports: levers() })
    const cold = report.comparisons.find((x) => x.scenarioName === 'main-push' && x.profileName === 'cold')
    const median = (v: VariantId) => {
      const paired = new Set(cold?.pairedRepetitions)
      const sums = (cold?.samples ?? [])
        .filter((s) => s.variant === v && s.complete && paired.has(s.repetition))
        .map((s) => s.workflows.flatMap((w) => w.jobs).reduce((n, j) => n + (j.durationSeconds ?? 0), 0))
        .sort((a, b) => a - b)
      expect(sums.length).toBeGreaterThan(0)
      const mid = sums.length / 2
      return (
        (sums.length % 2
          ? (sums[(sums.length - 1) / 2] as number)
          : ((sums[mid - 1] as number) + (sums[mid] as number)) / 2) / 60
      )
    }
    const github = median('github-baseline')
    const starsling = median('starsling-patched')
    expect((github * 60) % 60).not.toBe(0)
    expect(cold?.variants['github-baseline'].repoMinutes.median).toBeCloseTo(github, 3)
    const x = `${(github / starsling).toFixed(1)}x`
    expect(readme).toContain(
      `Cold: **StarSling: ${x} less runner time** than GitHub per push (${github.toFixed(2)} min → ${starsling.toFixed(2)} min of machine time; GitHub `,
    )
    // The table rows carry the same exact values, and runner time is the first number column.
    const results = readme.slice(readme.indexOf('## Results'), readme.indexOf('## Terms'))
    expect(results).toContain(`**${github.toFixed(2)} min** | 1x |`)
    expect(results).toContain(`**${starsling.toFixed(2)} min** | **${x}** less runner time |`)
    // Headline order: runner time before wait, in the sentences, the table and the breakdown.
    const at = (needle: string) => results.indexOf(needle)
    expect(at('less runner time**')).toBeGreaterThan(-1)
    expect(at('less runner time**')).toBeLessThan(at('Wait: **StarSling is'))
    expect(at('| Cold runner time |')).toBeLessThan(at('| Cold wait |'))
    expect(at('Runner time:\n')).toBeLessThan(at('Wait:\n'))
    // Runner time is not the wait: the parallel job makes them differ.
    expect(github).not.toBeCloseTo((cold?.variants['github-baseline'].wallClockSec.median ?? 0) / 60, 3)
  })

  it('with no agent PRs the StarSling row is the runners alone and the breakdown is omitted', () => {
    const manifest = createExperimentManifest({
      config,
      experimentId: 'hardware-only',
      profileNames: ['cold'],
      variants: ['github-baseline', 'starsling-baseline'],
    })
    const { pushesPerMonth: _a, prUpdatesPerMonth: _b, ...rest } = narrative({ agentPrs: [] })
    const readme = renderShowcase({ report: buildReport(manifest), config, narrative: rest })
    expect(readme).toContain('| StarSling (runners) |')
    expect(readme).toContain('StarSling = StarSling runners.')
    expect(readme).toMatch(/\*\*StarSling: [\d.]+x less runner time\*\* than GitHub per push/)
    expect(readme).toMatch(/\| Runner time per push \| vs GitHub \| Wait per push \| vs GitHub \|/)
    expect(readme).not.toContain('agent PRs, on the same runners')
    expect(readme).not.toContain('Where the speedup comes from')
    expect(readme).not.toContain('StarSling runners + agent PRs')
    expect(readme).not.toContain('<summary>Agent PRs')
  })

  it('prints no dollar figure anywhere', () => {
    expect(render()).not.toContain('$')
  })

  it('refuses a dollar figure or currency word in any prose field it prints, naming the field', () => {
    expect(() => render(narrative({ whatWasSlow: 'Saves $5,000 a month.' }))).toThrow(/whatWasSlow/)
    expect(() => render(narrative({ whatWeChanged: 'Costs 40 USD less.' }))).toThrow(/whatWeChanged/)
    expect(() => render(narrative({ same: 'Saved 3 dollars.' }))).toThrow(/same/)
    expect(() => render(narrative({ notes: ['fine', 'about $9'] }))).toThrow(/notes\[1\]/)
    const bad = agentPrs.map((p, i) => (i === 2 ? { ...p, summary: 'Cuts $12 per run' } : p))
    expect(() => render(narrative({ agentPrs: bad }))).toThrow(/agentPrs\[2\]\.summary/)
    // A lone dollar sign without a digit is not a figure; the default layout is not checked.
    expect(() => render(narrative({ whatWasSlow: 'Shell prompt $ and $HOME.' }))).not.toThrow()
    const plain = { title: 'DefinitelyTyped', whatWasSlow: 'Saves $5,000.' }
    expect(() => renderShowcase({ report: headline(), config, narrative: plain })).not.toThrow()
  })

  it('has no fourth (Disks) row', () => {
    expect(render()).not.toContain('Disks')
  })

  it('warns when the last agent PR row differs from the headline by more than 10%', () => {
    expect(render()).not.toContain('does not match the headline')
    const readme = render(narrative(), headline(), levers([360, 300, 250, 210, 300]))
    expect(readme).toContain('> [!WARNING]')
    expect(readme).toContain('does not match the headline')
    // The warning is in the visible Results section, not hidden in a collapsed block.
    expect(readme.indexOf('does not match the headline')).toBeLessThan(readme.indexOf('## Terms'))
  })

  it('warns in Results, not only in the Appendix, when the checks are not verified', () => {
    expect(render()).not.toContain('Not verified yet')
    const report = headline()
    const unverified = structuredClone(report)
    for (const c of unverified.comparisons) c.cacheValidated = false
    const readme = render(narrative(), unverified)
    expect(readme).toContain('**Not verified yet.**')
    expect(readme.indexOf('**Not verified yet.**')).toBeLessThan(readme.indexOf('## Terms'))
  })

  it('marks an agent PR "not measured" when its experiment is missing or its checks are unverified', () => {
    const missing = { ...levers() }
    delete missing['lever-2']
    expect(render(narrative(), headline(), missing)).toMatch(/Shard count from git.*not measured/)
  })

  it('notes failed or re-run samples per configuration, only when there are some', () => {
    expect(render()).not.toContain('failed or were re-run')
    const readme = render(
      narrative(),
      headline((s) =>
        s.variant === 'starsling-baseline' &&
        s.scenarioName === 'main-push' &&
        s.profileName === 'cold' &&
        s.repetition === 2
          ? { ...s, complete: false, incompleteReasons: ['Rerun requires a replacement sample: CI.yml'] }
          : s,
      ),
    )
    expect(readme).toMatch(/1 sample\(s\)? failed or were re-run and replaced/)
    expect(readme).toContain('StarSling unchanged (hardware alone): 1')
  })

  it('names the machine sizes next to the runner-time headline and table, read from the record', () => {
    const readme = render()
    const spec = (label: string) => config.runnerMapping.runnerSpecs[label]
    const report = headline()
    const labelOf = (v: VariantId) =>
      report.comparisons.flatMap((c) => c.samples).find((s) => s.variant === v)?.workflows[0]?.jobs[0]?.labels[0] ?? ''
    const g = spec(labelOf('github-baseline'))?.vcpu
    const st = spec(labelOf('starsling-patched'))?.vcpu
    expect(g).toBeGreaterThan(0)
    expect(readme).toContain(`of machine time; GitHub ${g} vCPU vs StarSling ${st} vCPU).`)
    expect(readme).toContain(`Runner time compared at these machine sizes: GitHub ${g} vCPU vs StarSling ${st} vCPU.`)
    // Not hard-coded: change the recorded spec and the page follows.
    const changed = structuredClone(config)
    const label = labelOf('github-baseline')
    const original = changed.runnerMapping.runnerSpecs[label]
    if (original) changed.runnerMapping.runnerSpecs[label] = { ...original, vcpu: 8 }
    const other = renderShowcase({ report, config: changed, narrative: narrative(), leverReports: levers() })
    expect(other).toContain('GitHub 8 vCPU vs StarSling')
  })

  it('keeps a "runner time saved per month" block in the Appendix, in minutes, only when run frequency is supplied', () => {
    const readme = render()
    const section = readme.slice(readme.indexOf('<summary>Runner time saved per month'))
    expect(section).toMatch(/\d min saved per month/)
    expect(section).not.toMatch(/\d s saved per month/)
    const { pushesPerMonth: _a, prUpdatesPerMonth: _b, ...withoutFrequency } = narrative()
    const without = render(withoutFrequency)
    expect(without).not.toContain('Runner time saved')
    expect(without).not.toContain('per month')
    // Runner time itself is in Results either way.
    expect(without).toMatch(/less runner time/)
  })

  it('renders a two-record result: the agent PR arm from the fix record, the rest from the base, the method naming both', () => {
    const only = { scenarioNames: ['main-push'], profileNames: ['cold'] }
    const baseManifest = createExperimentManifest({
      config,
      experimentId: 'base',
      inputFingerprint: 'fp-base',
      ...only,
    })
    const fixManifest = createExperimentManifest({
      config,
      experimentId: 'fix',
      inputFingerprint: 'fp-fix',
      variants: ['starsling-patched'],
      ...only,
    })
    const fixTiming = { ...seconds['main-push'], 'starsling-patched': { build: 20, test: 130 } } as Timing
    const record = (manifest: Manifest, timing: Timing | undefined, shiftMs: number) => {
      const samples = manifest.samples.map((r) => {
        const s = sample(manifest, r, timing)
        return {
          ...s,
          workflows: s.workflows.map((w) => ({
            ...w,
            startedAt: new Date(Date.parse(w.startedAt ?? '') + shiftMs).toISOString(),
            completedAt: new Date(Date.parse(w.completedAt ?? '') + shiftMs).toISOString(),
          })),
        }
      })
      return {
        input: {
          experimentId: manifest.experimentId,
          manifest,
          samples,
          assessments: Object.fromEntries(samples.map((s) => [s.sampleId, verified(manifest, s)])),
        },
        config,
        harnessHash: 'h1',
      }
    }
    const merged = mergeFixArm(
      record(baseManifest, undefined, 0),
      record(fixManifest, fixTiming, 3 * 86_400_000 + 7_200_000),
    )
    const report = generateExperimentReport({
      experimentId: 'base',
      config,
      manifest: merged.input.manifest as Manifest,
      samples: merged.input.samples,
      references: { 'main-push': reference('main-push') },
      assessments: merged.input.assessments ?? {},
    })
    const readme = renderShowcase({
      report,
      config,
      narrative: { layout: 'showcase', title: 'DefinitelyTyped' },
      fixArm: merged.info,
    })
    // The patched arm is the fix record's (about 20 + 130 s); the GitHub arm is the base record's (about 540 + 300 s).
    expect(readme).toContain('**2.48 min**')
    expect(readme).toContain('**13.98 min**')
    expect(readme).not.toContain('Not verified yet')
    expect(readme).toContain('**Two experiment records.**')
    expect(readme).toMatch(/experiment `base`; .* experiment `fix`, which ran 3 days 1 hour after `base` finished/)
    expect(readme.indexOf('`fix`, taken 3 days')).toBeLessThan(readme.indexOf('## Terms'))
    expect(readme).toContain('(StarSling + agent PRs arm from experiment `fix`)')
    // Without a fix arm none of this appears.
    expect(render()).not.toContain('Two experiment records')
  })

  it('leaves the default layout unchanged', () => {
    const report = headline()
    const plain = renderShowcase({ report, config, narrative: { title: 'DefinitelyTyped' } })
    const explicit = renderShowcase({ report, config, narrative: { title: 'DefinitelyTyped', layout: 'default' } })
    expect(explicit).toBe(plain)
    expect(plain).toContain('## Claim checklist')
    expect(plain).not.toContain('## Agent PRs')
  })
})
