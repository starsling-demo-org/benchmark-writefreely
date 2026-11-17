import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultProfiles, defineBenchmarkConfig } from '../src/config.ts'
import { pinnedRunnerMapping } from './fixtures/pinned-runner-mapping.ts'
import { inspectRepository } from '../src/inventory.ts'

describe('Stage 1 & 2: Workflow graph inventory, dynamic matrices, reusable workflows, workflow_run chains, skip propagation, and path filters', () => {
  const tempDirs: string[] = []

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `bench-${prefix}-`))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0, tempDirs.length)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('inventories multiple root workflows, dynamic matrices, reusable workflows, workflow_run chains, skip propagation, path filters, and mixed runners', () => {
    const repoDir = createTempDir('multi-wf')
    mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(repoDir, '.github', 'actions', 'custom-setup'), { recursive: true })
    mkdirSync(join(repoDir, '.github', 'actions', 'nested-helper'), { recursive: true })

    // Local composite action calling a nested local composite action
    writeFileSync(
      join(repoDir, '.github', 'actions', 'custom-setup', 'action.yml'),
      [
        'name: Custom Setup',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: ./.github/actions/nested-helper',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(repoDir, '.github', 'actions', 'nested-helper', 'action.yml'),
      [
        'name: Nested Helper',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - run: echo ok',
        '      shell: bash',
        '',
      ].join('\n'),
      'utf8',
    )

    // Root workflow 1: CI with dynamic matrix, reusable workflow call, skipped job propagating to dependent job, and macOS job
    const exprOpen = `\${{`
    writeFileSync(
      join(repoDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: Primary CI',
        'on:',
        '  pull_request:',
        '    types: [opened, synchronize]',
        '    branches: [main]',
        '    paths:',
        '      - "packages/**"',
        '      - ".github/workflows/**"',
        'concurrency:',
        `  group: ci-${exprOpen} github.ref }}`,
        '  cancel-in-progress: true',
        'jobs:',
        '  plan-matrix:',
        '    runs-on: ubuntu-latest',
        '    outputs:',
        `      shards: ${exprOpen} steps.gen.outputs.shards }}`,
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: ./.github/actions/custom-setup',
        '      - id: gen',
        '        run: echo "shards=[1,2]" >> "$GITHUB_OUTPUT"',
        '  linux-test:',
        '    needs: [plan-matrix]',
        '    runs-on: ubuntu-latest',
        '    strategy:',
        '      fail-fast: false',
        `      matrix: ${exprOpen} fromJson(needs.plan-matrix.outputs.shards) }}`,
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm test',
        '  macos-smoke:',
        '    runs-on: macos-14',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm run smoke',
        '  call-reusable:',
        '    uses: ./.github/workflows/reusable-lint.yml',
        '  schedule-only-job:',
        '    runs-on: ubuntu-latest',
        "    if: github.event_name == 'schedule'",
        '    steps:',
        '      - run: echo nightly',
        '  downstream-of-skipped:',
        '    needs: [schedule-only-job]',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo should-also-skip',
        '',
      ].join('\n'),
      'utf8',
    )

    // Root workflow 2: Docs workflow with path filter that does NOT match packages/**
    writeFileSync(
      join(repoDir, '.github', 'workflows', 'docs.yml'),
      [
        'name: Docs CI',
        'on:',
        '  pull_request:',
        '    paths:',
        '      - "docs/**"',
        'jobs:',
        '  build-docs:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo docs',
        '',
      ].join('\n'),
      'utf8',
    )

    // Root workflow 3: Security Audit (second triggered root workflow on pull_request)
    writeFileSync(
      join(repoDir, '.github', 'workflows', 'security.yml'),
      [
        'name: Security Audit',
        'on: [pull_request]',
        'jobs:',
        '  audit:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm audit',
        '',
      ].join('\n'),
      'utf8',
    )

    // Reusable workflow called by ci.yml
    writeFileSync(
      join(repoDir, '.github', 'workflows', 'reusable-lint.yml'),
      [
        'name: Reusable Lint',
        'on:',
        '  workflow_call:',
        'jobs:',
        '  eslint:',
        '    runs-on: ubuntu-slim',
        '    steps:',
        '      - run: npm run lint',
        '',
      ].join('\n'),
      'utf8',
    )

    // Downstream workflow_run listener triggered when Primary CI completes
    writeFileSync(
      join(repoDir, '.github', 'workflows', 'post-ci-report.yml'),
      [
        'name: Post CI Report',
        'on:',
        '  workflow_run:',
        '    workflows: ["Primary CI"]',
        '    types: [completed]',
        'jobs:',
        '  publish-summary:',
        '    runs-on: ubuntu-slim',
        '    steps:',
        '      - run: echo summary',
        '',
      ].join('\n'),
      'utf8',
    )

    // Scheduled workflow that should be excluded by default
    writeFileSync(
      join(repoDir, '.github', 'workflows', 'nightly.yml'),
      [
        'name: Nightly',
        'on:',
        '  schedule:',
        '    - cron: "0 0 * * *"',
        'jobs:',
        '  cron-job:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo cron',
        '',
      ].join('\n'),
      'utf8',
    )

    const config = defineBenchmarkConfig({
      schemaVersion: 1,
      upstream: {
        repository: 'org/monorepo',
        commitSha: 'a'.repeat(40),
        defaultBranch: 'main',
      },
      benchmarkRepository: {
        repository: 'starsling-bench/monorepo',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
      },
      scenarios: {
        'pr-packages': {
          name: 'pr-packages',
          description: 'PR touching packages/core',
          event: 'pull_request',
          pr: {
            prNumber: 7,
            baseRef: 'main',
            headRef: 'feat/core',
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            mergeSha: 'c'.repeat(40),
            activityType: 'synchronize',
            changedPaths: ['packages/core/index.ts'],
            labels: [],
          },
          referenceRuns: [],
        },
        'main-push': {
          name: 'main-push',
          description: 'Main push seed scenario',
          event: 'push',
          main: {
            branch: 'main',
            beforeSha: 'a'.repeat(40),
            afterSha: 'b'.repeat(40),
            changedPaths: ['packages/core/index.ts'],
          },
          referenceRuns: [],
        },
      },
      patches: [],
      runnerMapping: pinnedRunnerMapping(),
      profiles: createDefaultProfiles(),
      adaptations: [],
      collectors: [],
      execution: {
        repetitions: 5,
        timeoutMinutes: 45,
        maxConcurrentExperiments: 1,
        pollIntervalSeconds: 10,
        publicRepoGitHubFree: true,
      },
    })

    const inv = inspectRepository(repoDir, config)
    expect(inv.blockers).toEqual([])
    expect(inv.localActions).toEqual(['.github/actions/custom-setup', '.github/actions/nested-helper'])

    const sc = inv.scenarios['pr-packages']
    if (!sc) throw new Error('Expected pr-packages scenario')
    // Triggered workflows: ci.yml, security.yml, and downstream post-ci-report.yml (docs.yml and nightly.yml excluded!)
    expect(sc.triggeredWorkflows).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/security.yml',
      '.github/workflows/post-ci-report.yml',
    ])
    expect(sc.downstreamWorkflowRuns).toEqual([
      {
        upstreamWorkflowName: 'Primary CI',
        downstreamFilePath: '.github/workflows/post-ci-report.yml',
      },
    ])

    // Dynamic matrix detected on linux-test
    const linuxTestExp = sc.jobExpectations.find((j) => j.jobId === 'linux-test')
    expect(linuxTestExp?.isDynamicMatrix).toBe(true)
    expect(linuxTestExp?.expectedStatus).toBe('executed')

    // Reusable workflow job eslint expanded
    const eslintExp = sc.jobExpectations.find((j) => j.jobId === 'eslint')
    expect(eslintExp?.triggeredBy).toBe('reusable_workflow')
    expect(eslintExp?.expectedStatus).toBe('executed')

    // Skip propagation: schedule-only-job is skipped, and downstream-of-skipped is skipped because its dependency skipped
    const schedExp = sc.jobExpectations.find((j) => j.jobId === 'schedule-only-job')
    const downSkippedExp = sc.jobExpectations.find((j) => j.jobId === 'downstream-of-skipped')
    expect(schedExp?.expectedStatus).toBe('skipped')
    expect(downSkippedExp?.expectedStatus).toBe('skipped')
    expect(downSkippedExp?.skipReason).toContain('schedule-only-job')

    // Mixed-runner pipeline classification: macos-smoke stays on macos-14 (GitHub), Linux jobs move to StarSling
    expect(sc.mixedRunnerOnStarSling).toBe(true)
    expect(sc.retainedJobs).toEqual(['.github/workflows/ci.yml#macos-smoke'])
    expect(sc.movedJobs).toContain('.github/workflows/ci.yml#linux-test')
  })

  it('flags machine-readable blockers for unadapted repository guards, secrets, fork checks, and deployments', () => {
    const repoDir = createTempDir('blockers')
    const exprOpen = `\${{`
    mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      join(repoDir, '.github', 'workflows', 'deploy.yml'),
      [
        'name: Deploy',
        'on: [pull_request]',
        'jobs:',
        '  release:',
        '    runs-on: ubuntu-latest',
        "    if: github.repository == 'upstream/prod-app' && !github.event.pull_request.head.repo.fork",
        '    environment: production',
        '    steps:',
        `      - run: echo "${exprOpen} secrets.PROD_DEPLOY_KEY }}"`,
        '',
      ].join('\n'),
      'utf8',
    )

    const config = defineBenchmarkConfig({
      schemaVersion: 1,
      upstream: {
        repository: 'upstream/prod-app',
        commitSha: 'a'.repeat(40),
        defaultBranch: 'main',
      },
      benchmarkRepository: {
        repository: 'starsling-bench/prod-app',
        controlBranch: 'bench/control',
        defaultBranch: 'main',
      },
      scenarios: {
        pr: {
          name: 'pr',
          description: 'PR',
          event: 'pull_request',
          pr: {
            prNumber: 1,
            baseRef: 'main',
            headRef: 'feat/a',
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            mergeSha: 'c'.repeat(40),
            activityType: 'opened',
            changedPaths: ['index.ts'],
            labels: [],
          },
          referenceRuns: [],
        },
        'main-push': {
          name: 'main-push',
          description: 'Main push seed scenario',
          event: 'push',
          main: {
            branch: 'main',
            beforeSha: 'a'.repeat(40),
            afterSha: 'b'.repeat(40),
            changedPaths: ['packages/core/index.ts'],
          },
          referenceRuns: [],
        },
      },
      patches: [],
      runnerMapping: pinnedRunnerMapping(),
      profiles: createDefaultProfiles(),
      adaptations: [],
      collectors: [],
      execution: {
        repetitions: 5,
        timeoutMinutes: 30,
        maxConcurrentExperiments: 1,
        pollIntervalSeconds: 10,
        publicRepoGitHubFree: true,
      },
    })

    const inv = inspectRepository(repoDir, config)
    const categories = inv.blockers.map((b) => b.category)
    expect(categories).toContain('repository_identity_guard')
    expect(categories).toContain('missing_secret')
    expect(categories).toContain('unreproduced_fork_semantics')
    expect(categories).toContain('altered_deployment_behavior')
  })
})
