import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateBenchmarkConfig } from '../src/config.ts'
import { prepareReplayVariants } from '../src/generator.ts'
import { GitHubClient } from '../src/github.ts'
import { inspectRepository } from '../src/inventory.ts'
import {
  applyRunnerMappingOverrides,
  buildInitialConfig,
  classifyRunnerLabels,
  completeConfigFromSource,
  discoverUpstream,
  findExternalSideEffects,
  formatStars,
  proposeIdentityAdaptations,
} from '../src/init.ts'
import { publishShowcase } from '../src/publish.ts'
import { isLatestLabel } from '../src/runner-labels.ts'
import type { RunnerSpec } from '../src/types.ts'

// Only the remote address is replaced; every lease, tree and push operation runs real Git locally.
const transport = vi.hoisted(() => ({ remote: '' }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync(command: string, args: string[], options: ExecFileSyncOptions) {
      return actual.execFileSync(
        command,
        args.map((arg) =>
          arg === 'https://github.com/bench/replay.git' || arg === 'git@github.com:bench/replay.git'
            ? transport.remote
            : arg,
        ),
        options,
      )
    },
  }
})

const WORKFLOW = `name: CI
on:
  push:
    branches: [main]
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
  publish:
    if: github.repository == 'Org/Repo' && github.event_name == 'push'
    runs-on: ubuntu-24.04
    steps:
      - run: echo publish
  fork-only:
    if: github.repository != 'Org/Repo'
    runs-on: ubuntu-22.04
    steps:
      - run: echo fork
  owner:
    if: \${{ github.repository_owner == 'Org' }}
    runs-on: macos-latest
    steps:
      - run: echo owner
  changes:
    runs-on: ubuntu-24.04
    outputs:
      src: \${{ steps.filter.outputs.src }}
    steps:
      - id: filter
        run: echo "src=true" >> "$GITHUB_OUTPUT"
  lint:
    needs: changes
    if: needs.changes.outputs.src == 'true'
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-24.04]
    steps:
      - run: echo lint
`
const DOWNSTREAM = `name: Report
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  report:
    runs-on: ubuntu-24.04
    steps:
      - run: echo report
`

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bench-init-test-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const discovery = {
  defaultBranch: 'main',
  name: 'Repo',
  stars: 5321,
  scenarios: {
    'main-push': {
      name: 'main-push',
      description: 'main',
      event: 'push' as const,
      main: { branch: 'main', beforeSha: 'a'.repeat(40), afterSha: 'b'.repeat(40), changedPaths: ['src/a.ts'] },
      referenceRuns: [],
    },
  },
}

describe('deterministic benchmark initialization', () => {
  it('remaps upstream identity guards so guarded jobs make the upstream decision', () => {
    const source = join(directory, 'source')
    mkdirSync(join(source, '.github/workflows'), { recursive: true })
    writeFileSync(join(source, '.github/workflows/ci.yml'), WORKFLOW)
    writeFileSync(join(source, '.github/workflows/report.yml'), DOWNSTREAM)
    const rules = proposeIdentityAdaptations({
      sourceDir: source,
      upstreamRepository: 'Org/Repo',
      benchmarkRepository: 'bench/replay',
    })
    expect(rules.map((r) => [r.fromPattern, r.toReplacement, r.expectedMatches])).toEqual([
      ["github.repository != 'Org/Repo'", "github.repository != 'bench/replay'", 1],
      ["github.repository == 'Org/Repo'", "github.repository == 'bench/replay'", 1],
      ["github.repository_owner == 'Org'", "github.repository_owner == 'bench'", 1],
    ])

    const config = buildInitialConfig({
      upstreamRepository: 'Org/Repo',
      commitSha: 'b'.repeat(40),
      benchmarkRepository: 'bench/replay',
      discovery,
    })
    const { inventory, runnerLabels } = completeConfigFromSource(config, source)
    expect(config.adaptations).toHaveLength(3)
    expect(config.instrumentation).toBe(true)
    // Only the unfilled GitHub larger-runner placeholders block; identity guards are all remapped.
    expect(inventory.blockers.length).toBeGreaterThan(0)
    expect(inventory.blockers.every((b) => b.category === 'unpinned_github_runner')).toBe(true)
    expect(runnerLabels.map((r) => [r.label, r.status])).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub expression used as a runs-on label
      ['${{ matrix.os }}', 'expression'],
      ['macos-latest', 'kept-on-github'],
      ['ubuntu-22.04', 'unmapped'],
      ['ubuntu-24.04', 'mapped'],
    ])
    const scenario = inventory.scenarios['main-push']
    expect(scenario?.nativeConditions?.map((c) => c.jobId)).toEqual(['lint'])

    // The owner fills every placeholder: a pinned label for mapped labels, overrides for the rest.
    config.runnerMapping.defaultMap['ubuntu-24.04'] = {
      github: 'ubuntu-24.04-4core',
      starsling: 'starsling-ubuntu-24.04',
    }
    config.runnerMapping.runnerSpecs['ubuntu-24.04-4core'] = {
      ...config.runnerMapping.runnerSpecs['TODO-github-larger-runner-for-ubuntu-24.04'],
      label: 'ubuntu-24.04-4core',
    } as RunnerSpec
    config.runnerMapping.jobOverrides = {
      '.github/workflows/ci.yml#fork-only': { github: 'ubuntu-22.04-4core', starsling: 'ubuntu-22.04-4core' },
      '.github/workflows/ci.yml#owner': { github: 'macos-14', starsling: 'macos-14' },
      '.github/workflows/ci.yml#lint': { github: 'ubuntu-24.04-4core', starsling: 'starsling-ubuntu-24.04' },
    }
    expect(inspectRepository(source, config).blockers).toEqual([])

    // The generated adaptations apply with exact match counts and the replay keeps the upstream decisions.
    const bundle = prepareReplayVariants({
      upstreamSourceDir: source,
      workRootDir: join(directory, 'work'),
      config,
      patches: [],
    })
    const replay = bundle.variants['starsling-baseline'].inventory.scenarios['main-push']
    const status = (jobId: string) => replay?.jobExpectations.find((j) => j.jobId === jobId)?.expectedStatus
    expect([status('publish'), status('fork-only'), status('owner'), status('lint')]).toEqual([
      'executed',
      'skipped',
      'executed',
      'conditional',
    ])
    expect(replay?.downstreamWorkflowRuns).toEqual([
      { upstreamWorkflowName: 'CI', downstreamFilePath: '.github/workflows/report.yml' },
    ])
  })

  it('flags steps that reach outside the replay for an explicit parity decision', () => {
    const inventory = inspectRepository(
      (() => {
        const source = join(directory, 'publish-source')
        mkdirSync(join(source, '.github/workflows'), { recursive: true })
        writeFileSync(
          join(source, '.github/workflows/release.yml'),
          'on: push\njobs:\n  ship:\n    runs-on: ubuntu-24.04\n    environment: production\n    steps:\n      - uses: docker/build-push-action@v7\n      - name: Publish\n        run: pnpm install && pnpm publish --access public\n      - run: echo ok\n',
        )
        return source
      })(),
      buildInitialConfig({
        upstreamRepository: 'Org/Repo',
        commitSha: 'b'.repeat(40),
        benchmarkRepository: 'bench/replay',
        discovery,
      }),
    )
    expect(findExternalSideEffects(inventory)).toEqual([
      { location: '.github/workflows/release.yml#ship', evidence: 'deployment environment "production"' },
      { location: '.github/workflows/release.yml#ship step 1', evidence: 'uses docker/build-push-action@v7' },
      { location: '.github/workflows/release.yml#ship step 2 (Publish)', evidence: 'runs "pnpm publish"' },
    ])
    // A guard scoped to the job records the decision; identity remaps and other jobs' rules do not.
    const rule = (id: string, kind: 'deployment-guard' | 'repository-identity-remap', jobId?: string) => ({
      id,
      kind,
      workflowFile: '.github/workflows/release.yml',
      ...(jobId ? { jobId } : {}),
      fromPattern: 'x',
      toReplacement: 'y',
      reason: 'r',
    })
    const decided = findExternalSideEffects(inventory, [
      rule('no-publish', 'deployment-guard', 'ship'),
      rule('identity', 'repository-identity-remap'),
      rule('other-job', 'deployment-guard', 'docs'),
    ])
    expect(decided.map((e) => e.addressedBy)).toEqual([['no-publish'], ['no-publish'], ['no-publish']])
  })

  it('proposes a larger-runner placeholder for every upstream label, never a -latest label', () => {
    const config = buildInitialConfig({
      upstreamRepository: 'Org/Repo',
      commitSha: 'b'.repeat(40),
      benchmarkRepository: 'bench/replay',
      discovery,
    })
    const { defaultMap, runnerSpecs } = config.runnerMapping
    expect(Object.keys(defaultMap)).toContain('ubuntu-latest')
    for (const [upstream, target] of Object.entries(defaultMap)) {
      expect(target.github).toBe(`TODO-github-larger-runner-for-${upstream}`)
      // The placeholder carries the public-repository size the larger runner must match.
      expect(runnerSpecs[target.github]).toMatchObject({ provider: 'github', os: 'linux' })
    }
    expect(runnerSpecs['TODO-github-larger-runner-for-ubuntu-latest']).toMatchObject({ vcpu: 4, ramGiB: 16 })
    expect(Object.values(defaultMap).some((t) => isLatestLabel(t.github))).toBe(false)
    // Unfilled placeholders block only the jobs that use them, never the whole config.
    expect(validateBenchmarkConfig(config).some((b) => b.category === 'unpinned_github_runner')).toBe(false)
    const mapped = applyRunnerMappingOverrides(config.runnerMapping, ['ubuntu-latest=starsling-ubuntu-24.04'])
    expect(mapped.defaultMap['ubuntu-latest']?.github).toBe('TODO-github-larger-runner-for-ubuntu-latest')
  })

  it('maps runner labels only when told to, and reports the rest', () => {
    const config = buildInitialConfig({
      upstreamRepository: 'Org/Repo',
      commitSha: 'b'.repeat(40),
      benchmarkRepository: 'bench/replay',
      discovery,
    })
    const mapping = applyRunnerMappingOverrides(config.runnerMapping, ['ubuntu-22.04=starsling-ubuntu-22.04'])
    expect(mapping.defaultMap['ubuntu-22.04']).toEqual({
      github: 'TODO-github-larger-runner-for-ubuntu-22.04',
      starsling: 'starsling-ubuntu-22.04',
    })
    expect(() => applyRunnerMappingOverrides(mapping, ['nope'])).toThrow('FROM=TO')
    const labels = classifyRunnerLabels(
      {
        upstreamRepository: 'Org/Repo',
        commitSha: 'b'.repeat(40),
        localActions: [],
        scenarios: {},
        blockers: [],
        workflows: {
          'ci.yml': {
            filePath: 'ci.yml',
            name: 'CI',
            triggers: { events: ['push'] },
            reusableWorkflowCalls: [],
            localActionCalls: [],
            jobs: {
              a: {
                jobId: 'a',
                runsOn: 'ubuntu-22.04',
                needs: [],
                steps: [],
                referencedSecrets: [],
                cachesUsed: [],
                artifactsProduced: [],
                artifactsConsumed: [],
              },
            },
          },
        },
      },
      mapping,
    )
    expect(labels).toEqual([
      {
        label: 'ubuntu-22.04',
        jobs: ['ci.yml#a'],
        status: 'mapped',
        starsling: 'starsling-ubuntu-22.04',
        github: 'TODO-github-larger-runner-for-ubuntu-22.04',
      },
    ])
    expect([formatStars(5321), formatStars(999), formatStars(1_200_000)]).toEqual(['5.3k', '999', '1.2M'])
  })

  it('discovers main and PR scenarios with their upstream reference runs from real API shapes', async () => {
    const sha = 'b'.repeat(40)
    const responses: Record<string, unknown> = {
      '': { name: 'Repo', private: false, default_branch: 'main', stargazers_count: 42 },
      [`commits/${sha}`]: {
        sha,
        parents: [{ sha: 'a'.repeat(40) }],
        files: [{ filename: 'z.ts' }, { filename: 'a.ts' }],
      },
      [`commits/${'a'.repeat(40)}`]: {
        sha: 'a'.repeat(40),
        parents: [{ sha: 'e'.repeat(40) }],
        files: [{ filename: 'y.ts' }],
      },
      'pulls/9': {
        number: 9,
        title: 'Speed up CI',
        merge_commit_sha: 'c'.repeat(40),
        base: { ref: 'main', sha: 'a'.repeat(40) },
        head: { ref: 'feature', sha: 'd'.repeat(40) },
        labels: [{ name: 'ci' }],
      },
    }
    const client = {
      async request(path: string) {
        if (!(path in responses)) throw new Error(`unexpected ${path}`)
        return responses[path]
      },
      async all(path: string) {
        if (path === 'pulls/9/files')
          return [{ filename: 'src/b.ts' }, { filename: 'src/new.ts', previous_filename: 'src/old.ts' }]
        if (path === `actions/runs?head_sha=${sha}`)
          return [
            {
              id: 1,
              path: '.github/workflows/ci.yml',
              event: 'push',
              head_branch: 'main',
              created_at: '2026-01-01T00:00:00Z',
              run_attempt: 1,
              html_url: 'u1',
            },
          ]
        if (path === `actions/runs?head_sha=${'d'.repeat(40)}`)
          return [
            {
              id: 2,
              path: '.github/workflows/ci.yml',
              event: 'pull_request',
              head_branch: 'feature',
              created_at: '2026-01-01T00:00:00Z',
              run_attempt: 1,
              html_url: 'u2',
            },
          ]
        throw new Error(`unexpected ${path}`)
      },
    }
    const found = await discoverUpstream(client, { sha, pr: 9 })
    expect(found.scenarios['main-push']?.main?.changedPaths).toEqual(['a.ts', 'z.ts'])
    expect(found.scenarios['main-push']?.referenceRuns.map((r) => r.runId)).toEqual([1])
    // The warm seed is the previous push, with no upstream reference of its own.
    expect(found.scenarios['seed-parent']).toMatchObject({
      role: 'seed',
      main: { beforeSha: 'e'.repeat(40), afterSha: 'a'.repeat(40), changedPaths: ['y.ts'] },
      referenceRuns: [],
    })
    const seeded = buildInitialConfig({
      upstreamRepository: 'Org/Repo',
      commitSha: sha,
      benchmarkRepository: 'bench/replay',
      discovery: found,
    })
    expect(seeded.profiles.warm?.seedScenario).toBe('seed-parent')
    expect(found.scenarios['pr-synchronize']?.pr).toMatchObject({
      prNumber: 9,
      headSha: 'd'.repeat(40),
      labels: ['ci'],
      // A rename lists both paths, as the replay's `--no-renames` check does.
      changedPaths: ['src/b.ts', 'src/new.ts', 'src/old.ts'],
    })
    expect(found.scenarios['pr-synchronize']?.referenceRuns.map((r) => r.runId)).toEqual([2])
    await expect(discoverUpstream(client, { sha: 'main' })).rejects.toThrow('full 40-character')
  })
})

describe('showcase publishing', () => {
  const git = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  let original: string
  beforeEach(() => {
    transport.remote = join(directory, 'remote.git')
    const seed = join(directory, 'seed')
    git(['init', '--quiet', '--bare', transport.remote], directory)
    git(['init', '--quiet', '-b', 'main', seed], directory)
    writeFileSync(join(seed, 'template.txt'), 'template contents\n')
    git(['add', '.'], seed)
    git(['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-qm', 'Template'], seed)
    git(['push', '-q', transport.remote, 'main'], seed)
    original = git(['rev-parse', 'HEAD'], seed)
  })
  const publish = (content: string) =>
    publishShowcase({
      client: new GitHubClient('bench/replay'),
      defaultBranch: 'main',
      files: [
        { path: 'README.md', content },
        { path: 'benchmark/results.json', content: '{}\n' },
      ],
      message: 'showcase: exp',
      stateDir: join(directory, 'state'),
      owner: 'publish-exp',
    })

  it('replaces the default branch tree under the lease and releases it', async () => {
    const result = await publish('# Showcase\n')
    expect(result.previousSha).toBe(original)
    const head = git(['rev-parse', 'refs/heads/main'], transport.remote)
    expect(head).toBe(result.commitSha)
    expect(git(['show', '-s', '--format=%P %s', head], transport.remote)).toBe(`${original} [skip ci] showcase: exp`)
    expect(git(['ls-tree', '-r', '--name-only', head], transport.remote).split('\n')).toEqual([
      'README.md',
      'benchmark/results.json',
    ])
    expect(git(['ls-remote', transport.remote, 'refs/tags/bench-controller-lease'], directory)).toBe('')
    const again = await publish('# Showcase\n')
    expect(again.unchanged).toBe(true)
    expect(git(['rev-parse', 'refs/heads/main'], transport.remote)).toBe(head)
  })

  it('publishes the pinned upstream as a submodule next to the showcase', async () => {
    const pin = 'c'.repeat(40)
    const result = await publishShowcase({
      client: new GitHubClient('bench/replay'),
      defaultBranch: 'main',
      files: [
        { path: 'README.md', content: '# Showcase\n' },
        {
          path: '.gitmodules',
          content: '[submodule "upstream"]\n\tpath = upstream\n\turl = https://github.com/Org/Repo.git\n',
        },
        { path: 'upstream', gitlink: pin },
      ],
      message: 'showcase: pending',
      stateDir: join(directory, 'state-submodule'),
      owner: 'publish-pending',
    })
    // A gitlink entry (mode 160000), the same object `git submodule add` records.
    expect(git(['ls-tree', result.commitSha, 'upstream'], transport.remote)).toBe(`160000 commit ${pin}\tupstream`)
    await expect(
      publishShowcase({
        client: new GitHubClient('bench/replay'),
        defaultBranch: 'main',
        files: [{ path: 'upstream', gitlink: 'main' }],
        message: 'm',
        stateDir: join(directory, 'state-bad-submodule'),
        owner: 'publish-bad',
      }),
    ).rejects.toThrow('Invalid submodule commit')
  })

  it('refuses to publish while another controller holds the repository lease', async () => {
    const tree = git(['mktree'], transport.remote)
    const lease = git(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit-tree', tree, '-m', 'lease'],
      transport.remote,
    )
    git(['update-ref', 'refs/tags/bench-controller-lease', lease], transport.remote)
    await expect(publish('# Showcase\n')).rejects.toThrow('lease held by another controller')
    expect(git(['rev-parse', 'refs/heads/main'], transport.remote)).toBe(original)
    await expect(
      publishShowcase({
        client: new GitHubClient('bench/replay'),
        defaultBranch: 'main',
        files: [{ path: '.github/workflows/x.yml', content: 'x' }],
        message: 'm',
        stateDir: join(directory, 'state2'),
        owner: 'publish-x',
      }),
    ).rejects.toThrow('must not contain workflows')
  })
})
