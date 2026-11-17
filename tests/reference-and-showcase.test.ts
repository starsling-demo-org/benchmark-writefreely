import { describe, expect, it } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import type { SampleMeasurementResult } from '../src/collector.ts'
import { createExperimentManifest } from '../src/manifest.ts'
import {
  assessUpstreamParity,
  compareWithReference,
  discoverReferenceRuns,
  fetchScenarioReference,
  type ScenarioReference,
} from '../src/reference.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import { renderShowcase } from '../src/showcase.ts'
import { buildJobBreakdown, formatDuration, formatMultiple } from '../src/showcase-model.ts'
import type { VariantId } from '../src/types.ts'

const config = structuredClone(fixtureConfig)
config.execution.repetitions = 1
const manifest = createExperimentManifest({
  config,
  experimentId: 'diag',
  scenarioNames: ['main-push'],
  profileNames: ['cold'],
})
const seconds: Record<VariantId, { build: number; test: number }> = {
  'github-baseline': { build: 600, test: 300 },
  'github-patched': { build: 120, test: 300 },
  'starsling-baseline': { build: 240, test: 120 },
  'starsling-patched': { build: 60, test: 120 },
}
const at = (offset: number) => new Date(Date.UTC(2026, 10, 6) + offset * 1000).toISOString()
const sample = (variant: VariantId, overrides: Partial<SampleMeasurementResult> = {}): SampleMeasurementResult => {
  const request = manifest.samples.find((s) => s.variant === variant)
  if (!request) throw new Error('missing request')
  const { build, test } = seconds[variant]
  const label = variant.startsWith('github') ? 'ubuntu-24.04' : 'starsling-ubuntu-24.04'
  const job = (id: number, name: string, duration: number) => ({
    jobRecordId: id,
    runId: id,
    runAttempt: 1,
    workflowPath: '.github/workflows/CI.yml',
    jobName: name,
    logicalJobId: name,
    conclusion: 'success' as const,
    durationSeconds: duration,
    dependencyWaitSeconds: 0,
    runnerQueueSeconds: 0,
    resolution: '1s' as const,
    labels: [label],
    steps: [
      {
        number: 1,
        name: 'Set up job',
        conclusion: 'success' as const,
        durationSeconds: 1,
        resolution: '1s' as const,
        isHarnessInstrumentation: false,
      },
      {
        number: 2,
        name: `Run ${name}`,
        conclusion: 'success' as const,
        durationSeconds: duration - 1,
        resolution: '1s' as const,
        isHarnessInstrumentation: false,
      },
    ],
  })
  return {
    ...request,
    inputFingerprint: manifest.inputFingerprint,
    complete: true,
    incompleteReasons: [],
    missingWorkflows: [],
    missingJobs: [],
    cancelledJobs: [],
    failedJobs: [],
    partialTimestampJobs: [],
    timestampResolution: '1s',
    artifacts: [],
    metrics: {
      rawRunnerSeconds: build + test,
      repoMinutes: (build + test) / 60,
      wallClockSeconds: build + test,
      prWallClockSeconds: null,
      mainWallClockSeconds: build + test,
      triggerLatencySeconds: 2,
      harnessOverheadSeconds: 0,
    },
    workflows: [
      {
        runId: 100,
        runAttempt: 1,
        priorAttemptsCount: 0,
        workflowPath: '.github/workflows/CI.yml',
        workflowName: 'CI',
        event: 'push',
        conclusion: 'success',
        durationSeconds: build + test,
        startedAt: at(0),
        completedAt: at(build + test),
        htmlUrl: `https://github.com/bench/replay/actions/runs/${variant}`,
        artifacts: [],
        jobs: [job(1, 'build', build), job(2, 'test', test)],
      },
    ],
    ...overrides,
  }
}
const reference = (jobs: { name: string; conclusion: string }[]): ScenarioReference => ({
  schemaVersion: 1,
  scenarioName: 'main-push',
  upstreamRepository: config.upstream.repository,
  event: 'push',
  headSha: config.upstream.commitSha,
  retrievedAt: at(0),
  metrics: { wallClockSeconds: 930, runnerSeconds: 930 },
  runs: [
    {
      runId: 41515783490,
      attempt: 1,
      workflowPath: '.github/workflows/CI.yml',
      workflowName: 'CI',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      htmlUrl: 'https://github.com/DefinitelyTyped/DefinitelyTyped/actions/runs/41515783490',
      createdAt: at(0),
      startedAt: at(0),
      jobs: jobs.map((j, i) => ({
        id: i,
        name: j.name,
        status: 'completed',
        conclusion: j.conclusion,
        startedAt: at(0),
        completedAt: at(60),
        durationSeconds: 60,
        labels: ['ubuntu-24.04'],
        steps: [
          { number: 1, name: 'Set up job', conclusion: 'success', durationSeconds: 1 },
          { number: 2, name: `Run ${j.name}`, conclusion: 'success', durationSeconds: 59 },
          { number: 3, name: 'Install (cache miss)', conclusion: 'success', durationSeconds: 5 },
        ],
      })),
    },
  ],
})

describe('upstream reference parity', () => {
  it('passes an event only when every complete baseline replay, in any cache state, matches upstream', () => {
    const ref = reference([
      { name: 'build', conclusion: 'success' },
      { name: 'test', conclusion: 'success' },
    ])
    const divergent = reference([
      { name: 'build', conclusion: 'failure' },
      { name: 'test', conclusion: 'success' },
    ])
    // Without a complete baseline replay, parity is unchecked rather than passed.
    expect(assessUpstreamParity(ref, [sample('github-baseline', { complete: false })])).toMatchObject({
      referenceAvailable: true,
      passed: false,
      comparisons: [],
    })
    expect(assessUpstreamParity(undefined, [sample('github-baseline')]).passed).toBe(false)
    expect(assessUpstreamParity(ref, [sample('github-baseline'), sample('starsling-baseline')]).passed).toBe(true)
    // Patched variants never count: the agent PRs may legitimately change the job graph.
    expect(assessUpstreamParity(divergent, [sample('github-patched')]).comparisons).toEqual([])
    expect(assessUpstreamParity(divergent, [sample('github-baseline')]).passed).toBe(false)
  })

  it('passes on matching jobs and reports step differences without gating on them', () => {
    const comparison = compareWithReference(
      reference([
        { name: 'build', conclusion: 'success' },
        { name: 'test', conclusion: 'success' },
        { name: 'dangerbot', conclusion: 'skipped' },
      ]),
      sample('github-baseline'),
    )
    expect(comparison.passed).toBe(true)
    expect(comparison.stepDifferences.map((d) => d.missing)).toEqual([
      ['Install (cache miss)'],
      ['Install (cache miss)'],
    ])
  })

  it('ignores the lifecycle steps a StarSling runner adds to every job', () => {
    const replay = sample('starsling-baseline')
    for (const job of replay.workflows[0]?.jobs ?? [])
      job.steps.push(
        {
          number: 90,
          name: 'Set up runner',
          conclusion: 'success',
          durationSeconds: 2,
          resolution: '1s',
          isHarnessInstrumentation: false,
        },
        {
          number: 91,
          name: 'Complete runner',
          conclusion: 'success',
          durationSeconds: 1,
          resolution: '1s',
          isHarnessInstrumentation: false,
        },
      )
    const comparison = compareWithReference(
      reference([
        { name: 'build', conclusion: 'success' },
        { name: 'test', conclusion: 'success' },
      ]),
      replay,
    )
    expect(comparison.stepDifferences.flatMap((d) => d.unexpected)).toEqual([])
  })

  it('names missing, unexpected and divergent jobs', () => {
    const comparison = compareWithReference(
      reference([
        { name: 'build', conclusion: 'failure' },
        { name: 'lint', conclusion: 'success' },
      ]),
      sample('github-baseline'),
    )
    expect(comparison.passed).toBe(false)
    expect(comparison.missingJobs).toEqual(['.github/workflows/CI.yml › lint'])
    expect(comparison.unexpectedJobs).toEqual(['.github/workflows/CI.yml › test'])
    expect(comparison.conclusionMismatches).toEqual([
      { job: '.github/workflows/CI.yml › build', reference: 'failure', replay: 'success' },
    ])
  })

  it('discovers the runs a push started and fetches locked runs with their jobs', async () => {
    const scenario = config.scenarios['main-push']
    if (!scenario) throw new Error('missing scenario')
    const runs = [
      {
        id: 3,
        path: '.github/workflows/CI.yml',
        event: 'push',
        head_branch: 'master',
        created_at: at(5),
        run_attempt: 1,
        html_url: 'u3',
      },
      {
        id: 2,
        path: '.github/workflows/CI.yml',
        event: 'push',
        head_branch: 'master',
        created_at: at(0),
        run_attempt: 2,
        html_url: 'u2',
      },
      {
        id: 4,
        path: '.github/workflows/Fmt.yml',
        event: 'workflow_run',
        head_branch: 'master',
        created_at: at(9),
        run_attempt: 1,
        html_url: 'u4',
      },
      {
        id: 5,
        path: '.github/workflows/CI.yml',
        event: 'push',
        head_branch: 'release',
        created_at: at(1),
        run_attempt: 1,
        html_url: 'u5',
      },
      {
        id: 6,
        path: 'dynamic/dependabot/dependabot-updates',
        event: 'push',
        head_branch: 'master',
        created_at: at(1),
        run_attempt: 1,
        html_url: 'u6',
      },
      {
        id: 7,
        path: '.github/workflows/Nightly.yml',
        event: 'schedule',
        head_branch: 'master',
        created_at: at(1),
        run_attempt: 1,
        html_url: 'u7',
      },
    ]
    const requested: string[] = []
    const client = {
      async request(path: string) {
        requested.push(path)
        const run = runs.find((r) => path === `actions/runs/${r.id}`)
        return { ...run, name: 'CI', status: 'completed', conclusion: 'success', run_started_at: at(0) }
      },
      async all(path: string) {
        requested.push(path)
        if (path.startsWith('actions/runs?head_sha=')) return runs
        return [
          {
            id: 1,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            started_at: at(0),
            completed_at: at(90),
            labels: ['ubuntu-24.04'],
            steps: [],
          },
        ]
      },
    }
    const locked = await discoverReferenceRuns(client, scenario)
    expect(locked).toEqual([
      { workflowPath: '.github/workflows/CI.yml', runId: 2, attempt: 2, htmlUrl: 'u2' },
      { workflowPath: '.github/workflows/Fmt.yml', runId: 4, attempt: 1, htmlUrl: 'u4' },
    ])
    const snapshot = await fetchScenarioReference({
      client,
      upstreamRepository: config.upstream.repository,
      scenario: { ...scenario, referenceRuns: locked.slice(0, 1) },
      retrievedAt: at(0),
    })
    expect(requested).toContain('actions/runs/2/attempts/2/jobs')
    expect(snapshot.metrics).toEqual({ wallClockSeconds: 90, runnerSeconds: 90 })
  })
})

describe('README showcase', () => {
  const variants: VariantId[] = ['github-baseline', 'github-patched', 'starsling-baseline', 'starsling-patched']
  const samples = variants.map((v) => sample(v))
  const references = {
    'main-push': reference([
      { name: 'build', conclusion: 'success' },
      { name: 'test', conclusion: 'success' },
    ]),
  }
  const report = generateExperimentReport({ experimentId: 'diag', config, manifest, samples, references })

  it('dates a report by its last observation, so republishing the same record changes nothing', () => {
    const again = generateExperimentReport({ experimentId: 'diag', config, manifest, samples, references })
    const last = samples
      .flatMap((s) => s.workflows.map((w) => w.completedAt ?? ''))
      .sort()
      .at(-1)
    expect(report.generatedAt).toBe(last)
    expect(JSON.stringify(again)).toBe(JSON.stringify(report))
  })

  it('formats durations and multiples like the published showcases', () => {
    expect(formatDuration(24)).toBe('24s')
    expect(formatDuration(516)).toBe('8m 36s')
    expect(formatDuration(1260)).toBe('21m')
    expect(formatMultiple(1272, 63)).toBe('20.2× faster')
    expect(formatMultiple(60, 90)).toBe('1.5× slower')
    expect(formatMultiple(60, null)).toBeNull()
  })

  it('breaks pipelines down by job and runner label', () => {
    const [comparison] = report.comparisons
    if (!comparison) throw new Error('missing comparison')
    const rows = buildJobBreakdown(comparison)
    expect(rows.map((r) => r.jobName)).toEqual(['build', 'test'])
    expect(rows[0]).toMatchObject({
      githubLabel: 'ubuntu-24.04',
      starslingLabel: 'starsling-ubuntu-24.04',
      medians: { 'github-baseline': 600, 'starsling-patched': 60 },
    })
  })

  it('renders measured numbers, upstream parity and a diagnostic banner for a withheld claim', () => {
    expect(report.comparisons[0]?.upstreamParity.passed).toBe(true)
    expect(report.upstreamParityByScenario['main-push']?.passed).toBe(true)
    const readme = renderShowcase({ report, config, narrative: { title: 'DefinitelyTyped', stars: '50k' } })
    expect(readme).toContain('# DefinitelyTyped CI: GitHub-hosted vs StarSling Runners')
    // The product name is always capitalized.
    expect(readme).not.toMatch(/StarSling runners/)
    expect(readme).toContain(
      "# DefinitelyTyped CI: GitHub-hosted vs StarSling Runners\n\n_Not affiliated with [DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) (50k stars)._\n\nDefinitelyTyped's own CI workflows, replayed for real upstream merges on GitHub-hosted runners and on StarSling Runners. The results separate the hardware speedup from the self-improving CI speedup.",
    )
    expect(readme).not.toContain('[!NOTE]')
    expect(readme).toContain('> [!WARNING]\n> **Not yet a published result.**')
    // Three runner configurations as rows, each against GitHub-hosted runners.
    expect(readme).toContain(
      '| **GitHub-hosted runners** | 15m | 15.0 |\n| **StarSling Runners (hardware only)** | 6m<br>**2.5× faster** | 6.0<br>**2.5× fewer** |\n| **StarSling Runners (self-improving CI)** | 3m<br>**5.0× faster** | 3.0<br>**5.0× fewer** |',
    )
    // The speedup splits into hardware and software, and they multiply.
    expect(readme).toContain(
      '| Hardware speedup<br><sub>StarSling vs GitHub-hosted, CI unchanged</sub> | 2.5× faster | 2.5× fewer |',
    )
    expect(readme).toContain(
      '| Self-improving CI speedup<br><sub>agent PRs, both on StarSling</sub> | 2.0× faster | 2.0× fewer |',
    )
    expect(readme).toContain(
      '| **Total speedup**<br><sub>StarSling with self-improving CI vs GitHub-hosted</sub> | **5.0× faster** | **5.0× fewer** |',
    )
    expect(readme).toContain('every check for a merge to master finished in **3m** instead of 15m (**5.0× faster**)')
    expect(readme).toContain(
      '| Runner configuration | Merge CI duration<br><sub>Merge to master</sub> | CI minutes<br><sub>Merge to master</sub> |',
    )
    expect(readme).toContain('using 3.0 instead of 15.0 CI minutes')
    expect(readme).toContain('| Event | Cache | Round |')
    for (const retired of ['wall clock', 'Repo minutes', 'repetition', 'paired sample'])
      expect(readme.toLowerCase()).not.toContain(retired.toLowerCase())
    expect(readme).not.toContain('## What was slow')
    expect(readme).not.toContain('changes\n')
    expect(readme).toContain('- [x] **Same CI as upstream:**')
    expect(readme).toContain('- [x] **All 3 runner configurations measured** (3 of 3)')
    expect(readme).toContain('- [ ] **At least 5 rounds** (1 requested)')
    expect(readme).toContain('<summary>Where the time goes: median time per job (cold cache)</summary>')
    expect(readme.indexOf('## Appendix')).toBeLessThan(readme.indexOf('Where the time goes'))
    expect(readme).toContain('`ubuntu-24.04` → `starsling-ubuntu-24.04`')
    expect(readme).toContain('| GitHub-hosted | `ubuntu-24.04` | 4 | 16 GiB |')
    expect(readme).toContain('same workflows and 2 jobs as upstream')
    expect(readme).toContain("Upstream's own run took 15m 30s.")
    expect(readme).toContain('- [Agent PR 1](patches/dt-combined.patch) (patch file)')
    expect(readme).toMatch(
      /\| Merge to master \| cold \| 1 \| 15m \[🔗\]\(https:\/\/github\.com\/bench\/replay\/actions\/runs\/github-baseline\)/,
    )
    // Rendering is a pure function of the report.
    expect(renderShowcase({ report, config })).toBe(renderShowcase({ report, config }))
  })

  it('reports the GitHub target label and its size in the runners section, not the upstream label', () => {
    const larger = 'ubuntu-24.04-4core'
    const largerConfig = structuredClone(config)
    largerConfig.runnerMapping.defaultMap['ubuntu-24.04'] = { github: larger, starsling: 'starsling-ubuntu-24.04' }
    largerConfig.runnerMapping.runnerSpecs[larger] = {
      label: larger,
      provider: 'github',
      os: 'linux',
      arch: 'x64',
      vcpu: 4,
      ramGiB: 16,
      billingPerMinuteUsd: 0.016,
    }
    const relabeled = samples.map((s) => ({
      ...s,
      workflows: s.workflows.map((w) => ({
        ...w,
        jobs: w.jobs.map((j) => ({ ...j, labels: s.variant.startsWith('github') ? [larger] : j.labels })),
      })),
    }))
    const largerReport = generateExperimentReport({
      experimentId: 'diag',
      config: largerConfig,
      manifest,
      samples: relabeled,
      references,
    })
    const readme = renderShowcase({ report: largerReport, config: largerConfig })
    expect(readme).toContain(`| GitHub-hosted | \`${larger}\` | 4 | 16 GiB |`)
    expect(readme).not.toContain('| GitHub-hosted | `ubuntu-24.04` |')
    expect(readme).toContain('explicit GitHub larger-runner label')
  })

  it('shows replay progress and upstream differences instead of a headline', () => {
    const partial = generateExperimentReport({
      experimentId: 'diag',
      config,
      manifest,
      samples: [sample('github-baseline'), sample('starsling-baseline', { complete: false, incompleteReasons: ['x'] })],
      references: { 'main-push': reference([{ name: 'build', conclusion: 'success' }]) },
    })
    const readme = renderShowcase({ report: partial, config })
    expect(readme).toContain('> [!IMPORTANT]\n> **Still replaying:** 1 of 4 requested samples have finished.')
    expect(readme).toContain('does not match upstream yet')
    expect(readme).toContain('- [ ] **Same CI as upstream:**')
    expect(readme).toContain('| **StarSling Runners (self-improving CI)** | _not measured yet_ |')
    expect(readme).toContain('Ran in the replay, not upstream: .github/workflows/CI.yml › test')
  })
})

describe('stacked baseline (upstream + merged agent PRs)', () => {
  const variants: VariantId[] = ['github-baseline', 'github-patched', 'starsling-baseline', 'starsling-patched']
  const samples = variants.map((v) => sample(v))
  const matching = reference([
    { name: 'build', conclusion: 'success' },
    { name: 'test', conclusion: 'success' },
  ])
  const stacked = structuredClone(config)
  stacked.patches = [
    {
      id: 'agent-1',
      source: 'merged-pr',
      pathOrUrl: 'https://github.com/o/r/pull/1',
      baseBranch: 'b',
      inBaseline: true,
    },
    { id: 'agent-2', source: 'merged-pr', pathOrUrl: 'https://github.com/o/r/pull/2', baseBranch: 'b' },
  ]

  it('does not claim same CI as upstream when the baseline carries patches, even if the jobs match', () => {
    const parity = assessUpstreamParity(matching, samples, ['agent-1'])
    expect(parity.passed).toBe(false)
    expect(parity.baselineIncludesPatches).toEqual(['agent-1'])
    expect(parity.comparisons.every((c) => c.passed)).toBe(true)
    // No flagged patches: unchanged.
    expect(assessUpstreamParity(matching, samples).passed).toBe(true)
    expect(assessUpstreamParity(matching, samples)).not.toHaveProperty('baselineIncludesPatches')
  })

  it('labels the baseline in the report and the showcase instead of withholding the whole claim', () => {
    const report = generateExperimentReport({
      experimentId: 'diag',
      config: stacked,
      manifest,
      samples,
      references: { 'main-push': matching },
    })
    expect(report.upstreamParityByScenario['main-push']?.baselineIncludesPatches).toEqual(['agent-1'])
    const withheld = report.comparisons[0]?.withheldReasons.join(' ') ?? ''
    expect(withheld).not.toContain('upstream')
    const readme = renderShowcase({ report, config: stacked })
    expect(readme).toContain('- [ ] **Same CI as upstream:** not claimed')
    expect(readme).toContain('upstream + merged agent PRs')
    expect(readme).toContain('agent-1')
    expect(readme).not.toContain('same workflows and 2 jobs as upstream')
  })
})

describe('separate replay branch', () => {
  it('refuses a replay branch where GitHub needs the default branch, and says where replays run', async () => {
    const { validateBenchmarkConfig } = await import('../src/config.ts')
    const { renderPendingShowcase } = await import('../src/showcase.ts')
    const hybrid = structuredClone(config)
    hybrid.benchmarkRepository.defaultBranch = 'main'
    hybrid.benchmarkRepository.replayBranch = hybrid.upstream.defaultBranch
    for (const scenario of Object.values(hybrid.scenarios))
      if (scenario.main) scenario.main.branch = hybrid.upstream.defaultBranch
    const ids = (c: typeof hybrid) => validateBenchmarkConfig(c).map((b) => b.id)
    expect(ids(hybrid).filter((id) => id.startsWith('replay-branch-mismatch'))).toEqual([])
    const wrongBranch = structuredClone(hybrid)
    wrongBranch.benchmarkRepository.replayBranch = 'elsewhere'
    expect(ids(wrongBranch).some((id) => id.startsWith('replay-branch-mismatch'))).toBe(true)
    // workflow_dispatch seeds run only from the default branch.
    expect(ids(hybrid).some((id) => id.startsWith('dispatch-needs-default-branch'))).toBe(
      Object.values(hybrid.scenarios).some((s) => s.event === 'workflow_dispatch'),
    )
    const page = renderPendingShowcase({ config: hybrid, narrative: { title: 'DefinitelyTyped' } })
    expect(page).toContain('**Results pending.**')
    expect(page).toContain(`[\`upstream/\`](upstream) is ${hybrid.upstream.repository} at the pinned commit`)
    expect(page).toContain(`Replays run on the \`${hybrid.upstream.defaultBranch}\` branch.`)
  })
})
