// Synthetic metadata for unit/regression fixtures only; not a runnable upstream benchmark.
import { createDefaultProfiles, defineBenchmarkConfig } from '../../src/config.ts'
import { pinnedRunnerMapping } from './pinned-runner-mapping.ts'

export default defineBenchmarkConfig({
  schemaVersion: 1,
  upstream: {
    repository: 'DefinitelyTyped/DefinitelyTyped',
    commitSha: 'a5a581c188d37241fbd27c0002d86ddd72524ab9',
    defaultBranch: 'master',
  },
  benchmarkRepository: {
    repository: 'starsling-bench/definitelytyped-replay',
    controlBranch: 'bench/control',
    defaultBranch: 'master',
  },
  scenarios: {
    'pr-single-package': {
      name: 'pr-single-package',
      description: 'Single-package DefinitelyTyped PR synchronize scenario (PR #75910)',
      event: 'pull_request',
      pr: {
        prNumber: 75910,
        baseRef: 'master',
        headRef: 'bench/pr-75910',
        baseSha: 'a5a581c188d37241fbd27c0002d86ddd72524ab9',
        headSha: '385d11569e1da93b91048d388e7f35be0547efbd',
        mergeSha: '7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c',
        activityType: 'synchronize',
        changedPaths: ['types/node/index.d.ts'],
        labels: [],
      },
      referenceRuns: [
        {
          workflowPath: '.github/workflows/CI.yml',
          runId: 12000001,
        },
      ],
      semanticObligations: ['typecheck-scripts', 'test-changed-packages', 'danger-pr-check'],
    },
    'main-push': {
      name: 'main-push',
      description: 'Default branch push seed and main pipeline scenario',
      event: 'push',
      main: {
        branch: 'master',
        beforeSha: 'a5a581c188d37241fbd27c0002d86ddd72524ab9',
        afterSha: '385d11569e1da93b91048d388e7f35be0547efbd',
        changedPaths: ['types/node/index.d.ts'],
      },
      referenceRuns: [],
      semanticObligations: ['typecheck-scripts', 'test-changed-packages'],
    },
  },
  patches: [
    {
      id: 'dt-combined',
      source: 'local',
      pathOrUrl: 'tests/fixtures/dt-combined.patch',
      description: 'Sparse checkout, fast shard count, narrowed pnpm workspace, and folded scripts/danger checks',
    },
  ],
  runnerMapping: pinnedRunnerMapping(),
  profiles: createDefaultProfiles(),
  adaptations: [
    {
      id: 'remap-dt-repo-guard',
      expectedMatches: 4,
      kind: 'repository-identity-remap',
      workflowFile: '.github/workflows/CI.yml',
      fromPattern: "github.repository == 'DefinitelyTyped/DefinitelyTyped'",
      toReplacement: "github.repository == 'starsling-bench/definitelytyped-replay'",
      reason: 'Allow upstream repository-gated jobs to execute in the dedicated benchmark replay repository',
      blocksFullParity: false,
    },
  ],
  collectors: [
    {
      id: 'runner-fingerprint',
      kind: 'runner-fingerprint',
      artifactOrPath: '$RUNNER_TEMP/bench-fingerprint.txt',
      required: true,
    },
    {
      id: 'dtslint-verdicts',
      kind: 'json-verdicts',
      artifactOrPath: '$RUNNER_TEMP/test-verdicts.json',
      required: true,
    },
  ],
  execution: {
    repetitions: 5,
    timeoutMinutes: 60,
    maxConcurrentExperiments: 1,
    pollIntervalSeconds: 15,
    publicRepoGitHubFree: true,
  },
})
