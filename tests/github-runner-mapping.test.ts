import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultProfiles, createDefaultRunnerMapping, validateBenchmarkConfig } from '../src/config.ts'
import { prepareReplayVariants } from '../src/generator.ts'
import { inspectRepository } from '../src/inventory.ts'
import type { BenchmarkConfig, RunnerSpec, VariantId } from '../src/types.ts'

const LARGER = 'ubuntu-24.04-4core'
const largerSpec: RunnerSpec = {
  label: LARGER,
  provider: 'github',
  os: 'linux',
  arch: 'x64',
  vcpu: 4,
  ramGiB: 16,
  billingPerMinuteUsd: 0.016,
}

function makeConfig(mutate: (config: BenchmarkConfig) => void = () => {}): BenchmarkConfig {
  const runnerMapping = createDefaultRunnerMapping()
  runnerMapping.defaultMap['ubuntu-24.04'] = { github: LARGER, starsling: 'starsling-ubuntu-24.04' }
  runnerMapping.runnerSpecs[LARGER] = largerSpec
  const config: BenchmarkConfig = {
    schemaVersion: 1,
    upstream: { repository: 'org/repo', commitSha: 'a'.repeat(40), defaultBranch: 'main' },
    benchmarkRepository: { repository: 'bench/repo', controlBranch: 'bench/control', defaultBranch: 'main' },
    scenarios: {
      push: {
        name: 'push',
        description: 'push',
        event: 'push',
        main: { branch: 'main', beforeSha: '1'.repeat(40), afterSha: '2'.repeat(40), changedPaths: ['a.ts'] },
        referenceRuns: [],
      },
    },
    patches: [],
    runnerMapping,
    profiles: createDefaultProfiles(),
    adaptations: [],
    collectors: [],
    execution: {
      repetitions: 1,
      timeoutMinutes: 10,
      maxConcurrentExperiments: 1,
      pollIntervalSeconds: 5,
      publicRepoGitHubFree: false,
    },
  }
  delete config.profiles.warm
  mutate(config)
  return config
}

const workflow = (jobs: Record<string, string>) =>
  [
    'name: CI',
    'on: push',
    'jobs:',
    ...Object.entries(jobs).flatMap(([id, runsOn]) => [
      `  ${id}:`,
      `    runs-on: ${runsOn}`,
      '    steps:',
      '      - run: echo hi',
    ]),
    '',
  ].join('\n')

describe('GitHub-side runner mapping', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  function prepare(jobs: Record<string, string>, config: BenchmarkConfig) {
    const root = mkdtempSync(join(tmpdir(), 'bench-gh-runner-'))
    dirs.push(root)
    mkdirSync(join(root, 'upstream/.github/workflows'), { recursive: true })
    writeFileSync(join(root, 'upstream/.github/workflows/ci.yml'), workflow(jobs))
    return {
      root,
      run: () =>
        prepareReplayVariants({
          upstreamSourceDir: join(root, 'upstream'),
          workRootDir: join(root, 'work'),
          config,
          patches: [],
        }),
    }
  }
  const runsOn = (root: string, variant: VariantId) =>
    [
      ...readFileSync(join(root, 'work/variants', variant, '.github/workflows/ci.yml'), 'utf8').matchAll(
        /runs-on: (.+)/g,
      ),
    ].map((m) => m[1])

  it('rewrites runs-on for every job in both GitHub variants and leaves StarSling variants as before', () => {
    const { root, run } = prepare({ build: 'ubuntu-24.04', test: 'ubuntu-24.04' }, makeConfig())
    const bundle = run()
    for (const v of ['github-baseline', 'github-patched'] as const) expect(runsOn(root, v)).toEqual([LARGER, LARGER])
    for (const v of ['starsling-baseline', 'starsling-patched'] as const)
      expect(runsOn(root, v)).toEqual(['starsling-ubuntu-24.04', 'starsling-ubuntu-24.04'])
    expect(bundle.variants['github-baseline'].lock.movedJobs).toEqual([])
  })

  it('applies a <workflow>#<job> override on the GitHub side', () => {
    const config = makeConfig((c) => {
      c.runnerMapping.jobOverrides = {
        '.github/workflows/ci.yml#test': { github: LARGER, starsling: 'starsling-ubuntu-24.04' },
      }
    })
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub expression used as a runs-on label
    const matrixOs = '${{ matrix.os }}'
    const { root, run } = prepare({ build: 'ubuntu-24.04', test: matrixOs }, config)
    run()
    expect(runsOn(root, 'github-baseline')).toEqual([LARGER, LARGER])
  })

  it('refuses a -latest label as a GitHub target, in config validation and in prepare', () => {
    const config = makeConfig((c) => {
      c.runnerMapping.defaultMap['ubuntu-24.04'] = { github: 'ubuntu-latest', starsling: 'starsling-ubuntu-24.04' }
    })
    expect(
      validateBenchmarkConfig(config)
        .map((b) => b.evidence)
        .join('\n'),
    ).toMatch(/ubuntu-latest/)
    expect(() => prepare({ build: 'ubuntu-24.04' }, config).run()).toThrow(/-latest/)
  })

  it('refuses a -latest override target', () => {
    const config = makeConfig((c) => {
      c.runnerMapping.jobOverrides = {
        '.github/workflows/ci.yml#build': { github: 'windows-latest', starsling: 'windows-latest' },
      }
    })
    expect(
      validateBenchmarkConfig(config)
        .map((b) => b.evidence)
        .join('\n'),
    ).toMatch(/windows-latest/)
  })

  it('refuses an unmapped upstream label and names the workflow and job', () => {
    expect(() => prepare({ build: 'ubuntu-24.04', lint: 'ubuntu-22.04' }, makeConfig()).run()).toThrow(
      /\.github\/workflows\/ci\.yml#lint.*ubuntu-22\.04/s,
    )
  })

  it('refuses a job that would still run on a -latest label', () => {
    expect(() => prepare({ build: 'macos-latest' }, makeConfig()).run()).toThrow(
      /\.github\/workflows\/ci\.yml#build.*macos-latest/s,
    )
  })

  it('refuses an unfilled larger-runner placeholder and a target with no runner spec', () => {
    const placeholder = makeConfig((c) => {
      c.runnerMapping.defaultMap['ubuntu-24.04'] = {
        github: 'TODO-github-larger-runner-for-ubuntu-24.04',
        starsling: 'starsling-ubuntu-24.04',
      }
    })
    expect(() => prepare({ build: 'ubuntu-24.04' }, placeholder).run()).toThrow(/ci\.yml#build.*larger-runner/s)
    const noSpec = makeConfig((c) => {
      delete c.runnerMapping.runnerSpecs[LARGER]
    })
    expect(() => prepare({ build: 'ubuntu-24.04' }, noSpec).run()).toThrow(/ci\.yml#build.*runnerSpecs/s)
  })

  it('refuses expression, matrix, array and group runs-on without an override, naming the job', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub expression used as a runs-on label
    const expression = '${{ matrix.os }}'
    for (const value of [expression, '[ubuntu-24.04, gpu]', '{ group: big, labels: ubuntu-24.04 }'])
      expect(() => prepare({ build: value }, makeConfig()).run(), value).toThrow(/ci\.yml#build.*jobOverrides/s)
  })

  it('keeps pinned macOS labels, whose size is the same in public and private repositories', () => {
    const { root, run } = prepare({ mac: 'macos-14', arm: 'macos-15' }, makeConfig())
    run()
    expect(runsOn(root, 'github-baseline')).toEqual(['macos-14', 'macos-15'])
    expect(runsOn(root, 'starsling-baseline')).toEqual(['macos-14', 'macos-15'])
  })

  const standardLabels = [
    'ubuntu-24.04',
    'ubuntu-22.04',
    'ubuntu-24.04-arm',
    'windows-2022',
    'windows-2025',
    'windows-11-arm',
  ]

  it.each(standardLabels)(
    'refuses the standard label %s as a GitHub target: its size depends on visibility',
    (label) => {
      const asDefault = makeConfig((c) => {
        c.runnerMapping.defaultMap['ubuntu-24.04'] = { github: label, starsling: 'starsling-ubuntu-24.04' }
      })
      expect(
        validateBenchmarkConfig(asDefault)
          .map((b) => b.evidence)
          .join('\n'),
      ).toMatch(/size depends on repository visibility; use a larger-runner label/)
      expect(() => prepare({ build: 'ubuntu-24.04' }, asDefault).run()).toThrow(/ci\.yml#build.*visibility/s)
      const asOverride = makeConfig((c) => {
        c.runnerMapping.jobOverrides = {
          '.github/workflows/ci.yml#build': { github: label, starsling: 'starsling-ubuntu-24.04' },
        }
      })
      expect(
        validateBenchmarkConfig(asOverride)
          .map((b) => b.evidence)
          .join('\n'),
      ).toMatch(/visibility/)
    },
  )

  it('refuses a standard Windows or Arm label kept on both sides, naming the job', () => {
    for (const label of ['windows-2022', 'ubuntu-24.04-arm'])
      expect(() => prepare({ win: label }, makeConfig()).run(), label).toThrow(/ci\.yml#win.*visibility/s)
  })

  it('never maps a standard label to itself in the default mapping', () => {
    const { defaultMap } = createDefaultRunnerMapping()
    for (const [upstream, target] of Object.entries(defaultMap))
      if (upstream !== 'ubuntu-slim') expect(target.github, upstream).toMatch(/^TODO-github-larger-runner-for-/)
  })

  it('accepts a larger-runner label the way the fixtures do', () => {
    const { root, run } = prepare({ build: 'ubuntu-24.04' }, makeConfig())
    run()
    expect(runsOn(root, 'github-baseline')).toEqual([LARGER])
  })

  it('reports the same refusals from bench inspect as blockers', () => {
    const { root } = prepare({ build: 'ubuntu-24.04', lint: 'ubuntu-22.04' }, makeConfig())
    const blockers = inspectRepository(join(root, 'upstream'), makeConfig()).blockers
    expect(blockers.map((b) => b.evidence).join('\n')).toMatch(/ci\.yml#lint/)
  })
})
