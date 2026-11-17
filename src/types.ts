export type VariantId = 'github-baseline' | 'github-patched' | 'starsling-baseline' | 'starsling-patched'

export type ScenarioEventType = 'pull_request' | 'pull_request_target' | 'push' | 'merge_group' | 'workflow_dispatch'

export type CacheStateMode = 'cold' | 'warm' | 'unmanaged-diagnostic'
export type ArtifactStateMode = 'none' | 'seeded'
export type RestoreExpectation = 'required-hit' | 'allowed-miss' | 'not-applicable'
export type EvidenceLevel = 'timing-only' | 'test/verdict parity' | 'coverage-qualified'

export type BlockerCategory =
  | 'unresolvable_event_context'
  | 'missing_secret'
  | 'inaccessible_external_workflow'
  | 'unreproduced_fork_semantics'
  | 'altered_deployment_behavior'
  | 'repository_identity_guard'
  | 'uncontrolled_external_cache'
  | 'inconsistent_base_head_patch'
  | 'unresolved_moving_url'
  | 'invalid_commit_pin'
  | 'unpinned_github_runner'

export interface BlockerLocation {
  file: string
  jobId?: string
  stepIndex?: number
  stepName?: string
}

export interface SetupBlocker {
  id: string
  category: BlockerCategory
  severity: 'blocker' | 'warning'
  sourceLocation: BlockerLocation
  evidence: string
  nextAction: string
}

export interface PatchSpec {
  id: string
  source: 'local' | 'github-pr' | 'github-commit' | 'merged-pr'
  /** For `merged-pr`: the pull request URL (https://github.com/OWNER/REPO/pull/N) in the benchmark repository. */
  pathOrUrl: string
  /** `merged-pr` only, required: the branch the PR merged into. The controller never writes it. Checked against GitHub at lock time. */
  baseBranch?: string
  /** `merged-pr` only: the PR's head branch, when it still exists. Protected like the base branch. */
  headBranch?: string
  sha256?: string
  resolvedRevision?: string
  description?: string
  appliesToBaseAndHead?: boolean
  /**
   * This patch is part of the baseline: it is applied to the baseline trees as well as the patched trees, so the
   * "before" of the experiment is upstream plus the flagged patches (for example the agent PRs already merged), and
   * the "after" adds the unflagged ones. Every flagged patch must come before every unflagged patch. Without any
   * flag the baseline is bare upstream.
   */
  inBaseline?: boolean
}

export interface ScenarioPrMetadata {
  prNumber?: number
  baseRef: string
  headRef: string
  baseSha: string
  headSha: string
  mergeSha: string
  activityType: 'opened' | 'synchronize' | 'reopened' | 'labeled'
  changedPaths: string[]
  labels: string[]
}

export interface ScenarioMainMetadata {
  branch: string
  beforeSha: string
  afterSha: string
  changedPaths: string[]
}

export interface ReferenceRunSpec {
  workflowPath: string
  runId: number
  attempt?: number
  htmlUrl?: string
}

export interface ScenarioAdaptation {
  id: string
  reason: string
  preserveChangedPaths: string[]
  applyPatchToBaseCommit: boolean
}

export interface ScenarioConfig {
  name: string
  description: string
  event: ScenarioEventType
  pr?: ScenarioPrMetadata
  main?: ScenarioMainMetadata
  referenceRuns: ReferenceRunSpec[]
  seedDependencies?: string[]
  includeScheduledOrManual?: string[]
  scenarioAdaptation?: ScenarioAdaptation
  semanticObligations?: string[]
  /**
   * `workflow_dispatch` scenarios: the workflows dispatched on the default branch after the `main.afterSha`
   * tree is installed there with a `[skip ci]` commit (for example, scheduled cache producers used as a warm seed).
   */
  dispatch?: { workflows: string[] }
  /** `seed`: only runs as a warm-profile seed; experiments omit it unless it is selected explicitly. */
  role?: 'measured' | 'seed'
}

export interface RunnerSpec {
  label: string
  provider: 'github' | 'starsling'
  os: 'linux' | 'macos' | 'windows'
  arch: 'x64' | 'arm64'
  vcpu: number
  ramGiB: number
  billingPerMinuteUsd: number
}

export interface RunnerMappingConfig {
  defaultMap: Record<string, { github: string; starsling: string }>
  jobOverrides?: Record<string, { github: string; starsling: string }>
  runnerSpecs: Record<string, RunnerSpec>
}

export interface CacheArtifactProfile {
  name: string
  actionsCache: CacheStateMode
  crossRunArtifacts: ArtifactStateMode
  seedScenario?: string
  seedSourceRevision?: string
  restoreExpectations: Record<string, RestoreExpectation>
  testResultReuseAllowed: boolean
  amortizationHorizonRuns?: number
  externalCacheAdapters?: ExternalCacheAdapterSpec[]
}

export interface ExternalCacheAdapterSpec {
  id: string
  kind: 'actions-cache' | 'setup-action-cache' | 'docker-cache' | 'persistent-disk' | 'external'
  resetCommand: string
  seedCommand?: string
  verifyCommand?: string
}

export interface RepositoryAdaptationRule {
  expectedMatches?: number
  /** Match count in patched variants when the patch stack changes how often the pattern occurs. */
  expectedMatchesPatched?: number
  /** `workflow-setting`: set this YAML path (relative to the workflow, or to `jobs.<jobId>`) to `setValue`. */
  setPath?: string[]
  setValue?: unknown
  id: string
  kind:
    | 'repository-identity-remap'
    | 'secret-gate-annotation'
    | 'environment-strip'
    | 'external-dependency-stub'
    | 'deployment-guard'
    | 'workflow-setting'
  workflowFile?: string
  jobId?: string
  fromPattern: string
  toReplacement: string
  reason: string
  blocksFullParity?: boolean
}

export interface EvidenceCollectorSpec {
  id: string
  kind:
    | 'junit-xml'
    | 'json-verdicts'
    | 'lcov-coverage'
    | 'istanbul-coverage'
    | 'build-artifact-digest'
    | 'runner-fingerprint'
  artifactOrPath: string
  required: boolean
}

export interface ExcludedJobSpec {
  /** Workflow path, as in `jobExpectations` (for example `.github/workflows/ci.yml`). */
  workflowFile: string
  /** The job's id in the workflow file (the logical id; a matrix counts as one job). */
  jobId: string
  /** Why the job is excluded; printed in reports. */
  reason: string
}

export interface ExecutionLimitsConfig {
  repetitions: number
  timeoutMinutes: number
  maxConcurrentExperiments: number
  /** Base wait between looks at a queued or running workflow; it grows to 120 s while nothing changes. */
  pollIntervalSeconds: number
  /**
   * GitHub API calls this controller may spend per hour (default 300). The controller stretches its waits to stay
   * within it; it never skips a check. Size it as (account limit - headroom) / parallel controllers.
   */
  apiBudgetPerHour?: number
  /** Longest any job may wait for a runner before its sample is replaced. Default 30. */
  maxJobQueueSeconds?: number
  /**
   * Replacements allowed per setup (variant + profile) when a sample's workflow failed or it was voided on queue time.
   * Each failed sample stays in the record, excluded from the medians. Past the limit the experiment stops. Default 3.
   */
  maxReplacementsPerSetup?: number
  /**
   * Jobs that keep running in every setup but are left out of the verdict and the timing: a failure in one does not make
   * a sample incomplete or replaced, and its end time is not part of the wall clock. Use it for jobs upstream itself
   * fails on every branch. They stay in the record, marked `excluded`, with their real conclusion and duration, so a
   * report can say they failed the same way everywhere. Runner minutes still count them (the repository paid for them).
   */
  excludedJobs?: ExcludedJobSpec[]
  publicRepoGitHubFree: boolean
  /** Author and committer of every commit the harness makes; else git env vars, else git config, else a built-in. */
  commitIdentity?: { name: string; email: string }
}

export interface BenchmarkConfig {
  instrumentation?: boolean
  schemaVersion: 1
  upstream: {
    repository: string
    commitSha: string
    defaultBranch: string
  }
  benchmarkRepository: {
    repository: string
    controlBranch: string
    /** The repository's default branch: the benchmark page (README showcase, patches, results, `upstream/`). */
    defaultBranch: string
    /**
     * The branch replays push to, named like upstream's branch so branch filters match natively. Defaults to
     * `defaultBranch`. A separate replay branch keeps the default branch as the benchmark page during samples, and
     * Dependabot (configured from the default branch only) never starts. GitHub runs `workflow_run` listeners and
     * `workflow_dispatch` only from the default branch, so scenarios that need them replay on the default branch.
     */
    replayBranch?: string
    /**
     * `upstream`: each replay base commit's parent is the real upstream base commit, so full-history checkouts
     * (`fetch-depth: 0`, `git describe`, changelog tools) cost what they cost upstream. Requires a full clone.
     * `synthetic` (default): two-commit replay ancestry.
     */
    replayHistory?: 'synthetic' | 'upstream'
    /**
     * Also push upstream's tags at or before the pinned commit (`refs/tags/<name>`, annotated stay annotated), so
     * `git describe` and changelog tools see upstream's releases. Defaults to true for `replayHistory: "upstream"`;
     * `false` opts out. Setting it true with any other history is a configuration error.
     */
    mirrorTags?: boolean
  }
  scenarios: Record<string, ScenarioConfig>
  patches: PatchSpec[]
  runnerMapping: RunnerMappingConfig
  profiles: Record<string, CacheArtifactProfile>
  adaptations: RepositoryAdaptationRule[]
  collectors: EvidenceCollectorSpec[]
  execution: ExecutionLimitsConfig
}

/** What a merged-PR patch was locked from. */
export interface MergedPrLock {
  repository: string
  number: number
  mergeCommitSha: string
  /** First parent of the merge commit: the tree the landed change applies to. */
  firstParentSha: string
  baseRef: string
  /** The PR's base SHA as GitHub reports it (the base tip when the PR was last updated). */
  baseSha: string
  headRef: string
  headSha: string
}

export interface LockedPatchRecord {
  id: string
  source: PatchSpec['source']
  originalPathOrUrl: string
  immutableOrigin: string
  resolvedRevision: string
  sha256: string
  byteLength: number
  patchContent: string
  mergedPr?: MergedPrLock
  /** Copied from the spec; present only when true (see `PatchSpec.inBaseline`). */
  inBaseline?: true
}

export interface ReferencedActionLock {
  workflowFile: string
  jobId: string
  uses: string
  resolvedRevision: string
  isLocal: boolean
}

export interface VariantTreeLock {
  variant: VariantId
  sourceTreeHash: string
  workflowTreeHash: string
  combinedHash: string
  mixedRunner: boolean
  movedJobs: string[]
  retainedJobs: string[]
}

export interface ParityCertificateRecord {
  scenario: string
  profile: string
  inputFingerprint: string
  issuedAt: string
  evidenceLevel: EvidenceLevel
  structuralPassed: boolean
  observedPassed: boolean
  semanticPassed: boolean
}

export interface BenchmarkLockfile {
  schemaVersion: 1
  generatedAt: string
  configHash: string
  upstream: {
    repository: string
    commitSha: string
    defaultBranch: string
  }
  scenarios: Record<
    string,
    {
      event: ScenarioEventType
      baseSha: string
      headSha: string
      mergeSha: string
      changedPaths: string[]
      activityType?: string
      labels: string[]
    }
  >
  patches: LockedPatchRecord[]
  referencedActions: ReferencedActionLock[]
  variantTrees: Record<string, Record<VariantId, VariantTreeLock>>
  adapterVersions: Record<string, string>
  runnerSpecs: Record<string, RunnerSpec>
  parityCertificates: Record<string, ParityCertificateRecord>
}

export interface WorkflowStepInventory {
  index: number
  id?: string
  name?: string
  uses?: string
  run?: string
  ifCondition?: string
  withInputs?: Record<string, unknown>
  env?: Record<string, string>
  continueOnError?: boolean
}

/** The literal runner values behind a `runs-on: ${{ matrix.<key> }}` job, or why they cannot be rewritten safely. */
export type MatrixRunsOnPlan = { key: string; values: string[] } | { problem: string }

export interface WorkflowJobInventory {
  jobId: string
  name?: string
  runsOn: string | string[] | { group?: string; labels?: string | string[] }
  /** Set only when `runsOn` is exactly `${{ matrix.<key> }}`. */
  matrixRunsOn?: MatrixRunsOnPlan
  needs: string[]
  ifCondition?: string
  usesReusableWorkflow?: string
  matrixConfig?: {
    isDynamic: boolean
    expression?: string
    staticRows?: Record<string, unknown>[]
    failFast?: boolean
  }
  outputs?: Record<string, string>
  steps: WorkflowStepInventory[]
  services?: Record<string, unknown>
  container?: unknown
  environment?: string
  permissions?: unknown
  concurrency?: unknown
  referencedSecrets: string[]
  cachesUsed: string[]
  artifactsProduced: string[]
  artifactsConsumed: string[]
}

export interface WorkflowFileInventory {
  filePath: string
  name: string
  triggers: {
    events: string[]
    eventFilters?: Record<
      string,
      { branches?: string[]; branchesIgnore?: string[]; paths?: string[]; pathsIgnore?: string[]; types?: string[] }
    >
    pullRequestTypes?: string[]
    branches?: string[]
    branchesIgnore?: string[]
    paths?: string[]
    pathsIgnore?: string[]
    workflowRunTrigger?: {
      workflows: string[]
      types: string[]
      branches?: string[]
    }
  }
  concurrency?: unknown
  permissions?: unknown
  jobs: Record<string, WorkflowJobInventory>
  reusableWorkflowCalls: string[]
  localActionCalls: string[]
}

export interface ScenarioJobExpectation {
  workflowFile: string
  workflowName: string
  jobId: string
  triggeredBy: 'direct' | 'workflow_run' | 'reusable_workflow' | 'explicit_dispatch'
  upstreamWorkflowTrigger?: string
  /** `conditional`: GitHub evaluates the condition natively; upstream reference parity checks the outcome. */
  expectedStatus: 'executed' | 'skipped' | 'conditional'
  skipReason?: string
  isDynamicMatrix: boolean
  expectedMatrixCount?: number
  mappedRunsOn: {
    github: string
    starsling: string
    retainedOnGitHub: boolean
    retentionReason?: string
  }
}

export interface ScenarioInventory {
  scenarioName: string
  triggeredWorkflows: string[]
  excludedWorkflows: { filePath: string; reason: string }[]
  downstreamWorkflowRuns: { upstreamWorkflowName: string; downstreamFilePath: string }[]
  jobExpectations: ScenarioJobExpectation[]
  mixedRunnerOnStarSling: boolean
  movedJobs: string[]
  retainedJobs: string[]
  blockers: SetupBlocker[]
  /** Job conditions left to native evaluation; their outcome is checked against the upstream reference. */
  nativeConditions?: { workflowFile: string; jobId: string; condition?: string; reason: string }[]
}

export interface RepositoryInventory {
  upstreamRepository: string
  commitSha: string
  workflows: Record<string, WorkflowFileInventory>
  localActions: string[]
  scenarios: Record<string, ScenarioInventory>
  blockers: SetupBlocker[]
}
