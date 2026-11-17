import { setTimeout as delay } from 'node:timers/promises'
import { readFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { computeDirectoryHash } from './patcher.ts'
import { mirrorTagsToRemote } from './history-tags.ts'
import { COMMIT_TREE, git, isTransientGitError } from './git.ts'
import { type GitHubClient, type JsonObject, object, array } from './github.ts'
import type { PreparedVariant } from './prepared.ts'
import { assertRefNotProtected } from './protected-branches.ts'
import type { ExperimentRecovery, GitHubReplayBackend } from './staging.ts'

const ACTIVE_RUN_STATUSES = ['requested', 'pending', 'waiting', 'queued', 'in_progress'] as const
/** Content of the inactive workflow committed to the default branch so GitHub registers the workflow path. */
const PLACEHOLDER_WORKFLOW =
  'name: Benchmark registration placeholder\non: workflow_dispatch\njobs:\n  inactive:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo inactive\n'

const REGISTRATION_WAITS_MS = [1_000, 1_000, 2_000, 2_000, 3_000, 3_000, 3_000]
const STATE_SETTLE_WAITS_MS = [5_000, 5_000, 10_000, 10_000, 15_000, 15_000]

interface BackendJournal {
  owner: string
  leaseSha?: string
  initialRefs?: Record<string, string>
  expectedRefs: Record<string, string | null>
  workflowStates: Record<string, string>
  dispatches: Record<string, { headSha: string; dispatchedAt: string; workflows?: string[] }>
  prNumber?: number
  recovery?: ExperimentRecovery & { phase: 'restored' | 'completed' }
}
export class NativeReplayBackend implements GitHubReplayBackend {
  readonly tokenKind = 'pat' as const
  readonly client: GitHubClient
  readonly payload: PreparedVariant
  readonly journalPath: string
  private journal: BackendJournal
  private readonly holdLease: boolean
  private readonly leaseRef = 'refs/tags/bench-controller-lease'
  private readonly protectedBranches: readonly string[]
  constructor(
    client: GitHubClient,
    payload: PreparedVariant,
    journalPath: string,
    owner: string,
    holdLease = false,
    /** Branches no ref write may touch (merged-PR patch base/head branches). */
    protectedBranches: readonly string[] = [],
  ) {
    this.holdLease = holdLease
    this.protectedBranches = protectedBranches
    this.client = client
    this.payload = payload
    this.journalPath = journalPath
    this.journal = existsSync(journalPath)
      ? (JSON.parse(readFileSync(journalPath, 'utf8')) as BackendJournal)
      : { owner, expectedRefs: {}, workflowStates: {}, dispatches: {} }
    if (this.journal.owner !== owner) throw new Error('Journal belongs to another sample')
  }
  private save(): void {
    mkdirSync(dirname(this.journalPath), { recursive: true })
    writeFileSync(`${this.journalPath}.tmp`, JSON.stringify(this.journal, null, 2))
    renameSync(`${this.journalPath}.tmp`, this.journalPath)
  }
  private git(args: string[], options: { input?: string; indexFile?: string } = {}): string {
    return git(this.payload.gitDir, args, options)
  }
  /** Git remote for the benchmark repository; `BENCH_GIT_TRANSPORT=ssh` selects SSH credentials. */
  remoteUrl(): string {
    return process.env.BENCH_GIT_TRANSPORT === 'ssh'
      ? `git@github.com:${this.client.repository}.git`
      : `https://github.com/${this.client.repository}.git`
  }
  private remoteRef(ref: string): string | null {
    return this.git(['ls-remote', this.remoteUrl(), ref]).split(/\s/)[0] || null
  }
  async acquireLease(): Promise<void> {
    if (this.journal.recovery)
      throw new Error('Experiment is finalized; use a new experiment directory to dispatch more samples')
    // Atomic create via force-with-lease expecting absence; never automatically steal a stale lease.
    if (!this.journal.leaseSha) {
      const emptyTree = this.git(['mktree'], { input: '' })
      this.journal.leaseSha = this.git([...COMMIT_TREE, emptyTree, '-m', `benchmark lease ${this.journal.owner}`])
      this.save()
    }
    const actual = this.remoteRef(this.leaseRef)
    if (actual === this.journal.leaseSha) return
    if (actual) throw new Error('Repository lease held by another controller; recover its journal first')
    this.git([
      'push',
      `--force-with-lease=${this.leaseRef}:`,
      this.remoteUrl(),
      `${this.journal.leaseSha}:${this.leaseRef}`,
    ])
  }
  private assertLease(): void {
    if (!this.journal.leaseSha || this.remoteRef(this.leaseRef) !== this.journal.leaseSha)
      throw new Error('Repository lease lost; refusing mutation')
  }
  async releaseLease(): Promise<void> {
    if (this.holdLease) return
    await this.releaseExperimentLease()
  }
  async releaseExperimentLease(): Promise<void> {
    this.assertLease()
    this.git([
      'push',
      `--force-with-lease=${this.leaseRef}:${this.journal.leaseSha}`,
      this.remoteUrl(),
      `:${this.leaseRef}`,
    ])
  }
  async getCurrentRefs(): Promise<Record<string, string>> {
    const refs = Object.fromEntries(
      this.git(['ls-remote', '--heads', this.remoteUrl()])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(/\s+/)
          if (!ref || !sha) throw new Error('Invalid ls-remote response')
          return [ref, sha]
        }),
    )
    if (!this.journal.initialRefs) {
      this.journal.initialRefs = refs
      this.save()
    }
    return refs
  }
  async updateRef(ref: string, sha: string | null): Promise<void> {
    // The single choke point for branch writes: installs, placeholder registration, restore and publish.
    assertRefNotProtected(ref, this.protectedBranches)
    this.assertLease()
    const actual = this.remoteRef(ref)
    const expected = this.journal.expectedRefs[ref]
    if (expected !== undefined && actual !== expected && actual !== sha)
      throw new Error(`Concurrent ref mutation: ${ref}`)
    if (actual === sha) return
    if (actual) this.git(['fetch', '--quiet', this.remoteUrl(), actual])
    if (sha) {
      try {
        this.git(['cat-file', '-e', `${sha}^{commit}`])
      } catch {
        this.git(['fetch', '--quiet', this.remoteUrl(), sha])
      }
    }
    // Save expected before push; a crash is reconciled against desired SHA on retry.
    this.journal.expectedRefs[ref] = actual
    this.save()
    for (let attempt = 1; ; attempt++) {
      try {
        this.git(['push', `--force-with-lease=${ref}:${actual ?? ''}`, this.remoteUrl(), `${sha ?? ''}:${ref}`])
        break
      } catch (error) {
        // A dropped connection may or may not have landed the push; the remote ref says which. The lease guard
        // makes a repeat safe: it updates only from the value this journal expects.
        if (!isTransientGitError(error) || attempt >= 4) throw error
        const now = this.remoteRef(ref)
        if (now === sha) break
        if (now !== actual) throw new Error(`Concurrent ref mutation: ${ref}`)
        await delay(5_000 * attempt)
      }
    }
    this.journal.expectedRefs[ref] = sha
    this.save()
  }
  /** Blob id of `path` in the fetched commit, or undefined when the path is absent. */
  private blobAt(commit: string, path: string): string | undefined {
    try {
      return this.git(['rev-parse', '--verify', '--quiet', `${commit}:${path}`])
    } catch {
      return undefined
    }
  }
  async registerInactiveWorkflowPlaceholder(defaultBranch: string, workflowFile: string): Promise<void> {
    this.assertLease()
    if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflowFile)) throw new Error('Invalid workflow path')
    const workflows = (await this.client.all('actions/workflows', 'workflows')).map(object)
    for (const workflow of workflows) await this.disableWorkflow(String(workflow.path))
    this.journal.workflowStates[workflowFile] = 'absent'
    this.save()
    const ref = `refs/heads/${defaultBranch}`
    const current = this.remoteRef(ref)
    if (!current) throw new Error('Default branch must exist before registration')
    this.git(['fetch', '--quiet', this.remoteUrl(), current])
    // Placeholder registration is idempotent: an identical placeholder already on the default branch needs no commit.
    if (this.blobAt(current, workflowFile) === this.git(['hash-object', '--stdin'], { input: PLACEHOLDER_WORKFLOW })) {
      await this.disableWorkflow(workflowFile)
      return
    }
    // Use the same authenticated Git transport as replay pushes. An isolated index
    // keeps registration independent of the payload worktree and its staging area.
    const temporary = mkdtempSync(join(tmpdir(), 'bench-registration-'))
    let sha: string
    try {
      const indexFile = join(temporary, 'index')
      this.git(['read-tree', current], { indexFile })
      const blob = this.git(['hash-object', '-w', '--stdin'], { input: PLACEHOLDER_WORKFLOW })
      this.git(['update-index', '--add', '--cacheinfo', '100644', blob, workflowFile], { indexFile })
      const tree = this.git(['write-tree'], { indexFile })
      sha = this.git([...COMMIT_TREE, tree, '-p', current, '-m', `[skip ci] Register ${workflowFile}`])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
    await this.updateRef(ref, sha)
    // Newly registered workflow has only a manual trigger, so it cannot start workload execution.
    await this.disableWorkflow(workflowFile)
  }
  private async workflow(file: string): Promise<{ id: number; state: string } | undefined> {
    const workflows = await this.client.all('actions/workflows', 'workflows')
    const workflow = workflows.map(object).find((w) => w.path === file)
    if (!workflow) return undefined
    if (!(file in this.journal.workflowStates)) {
      this.journal.workflowStates[file] = String(workflow.state)
      this.save()
    }
    return { id: Number(workflow.id), state: String(workflow.state) }
  }
  async disableWorkflow(file: string): Promise<void> {
    this.assertLease()
    if (file.startsWith('dynamic/')) return // GitHub-managed workflows have no enable/disable endpoint.
    const workflow = await this.workflow(file)
    if (workflow?.state === 'active') {
      await this.client.request(`actions/workflows/${workflow.id}/disable`, 'PUT')
      await this.awaitWorkflowState(file, 'disabled_manually')
    }
  }
  /** Runs GitHub has not finished, in every pre-completion status (a run seconds old is `requested` or `pending`). */
  private async activeRuns(): Promise<JsonObject[]> {
    const runs: JsonObject[] = []
    for (const status of ACTIVE_RUN_STATUSES)
      runs.push(...(await this.client.all(`actions/runs?status=${status}`, 'workflow_runs')).map(object))
    return runs
  }
  private async cancelRun(id: number): Promise<void> {
    const status = async () => String(object(await this.client.request(`actions/runs/${id}`)).status)
    try {
      await this.client.request(`actions/runs/${id}/cancel`, 'POST')
    } catch (error) {
      // GitHub refuses to cancel a run that finished between the listing and the cancel.
      if ((await status()) !== 'completed') throw error
    }
  }
  /**
   * GitHub-managed Dependabot runs start seconds after the replayed tree adds a dependabot.yml to the default branch.
   * Cancel them and wait until no managed run has been active for two polls in a row, so none overlaps the event
   * (where it would count as interference) or opens PRs that start extra workflow runs during a sample.
   */
  async cancelManagedRuns(options: { pollMs?: number; timeoutMinutes?: number } = {}): Promise<string[]> {
    this.assertLease()
    // Each poll lists every active status (5 reads); 15 s keeps a quiet repository at a few calls a minute.
    const { pollMs = 15_000, timeoutMinutes = 5 } = options
    const deadline = Date.now() + timeoutMinutes * 60_000
    const cancelled = new Map<number, string>()
    for (let quietPolls = 0; ; ) {
      const managed = (await this.activeRuns()).filter((run) => String(run.path).startsWith('dynamic/'))
      for (const run of managed)
        if (!cancelled.has(Number(run.id))) {
          await this.cancelRun(Number(run.id))
          cancelled.set(Number(run.id), String(run.path))
        }
      quietPolls = managed.length ? 0 : quietPolls + 1
      if (quietPolls >= 2) return [...cancelled.values()]
      if (Date.now() >= deadline)
        throw new Error(`Managed runs still active after cancellation: ${managed.map((r) => r.id).join(', ')}`)
      await this.client.pause(pollMs)
    }
  }
  /**
   * Settle a failed attempt before the next one starts: cancel any of its runs still active, then wait until no
   * run outside dynamic/ is active, so neither its jobs nor runs they start overlap the retry.
   */
  async settleRuns(runIds: number[], timeoutMinutes: number): Promise<void> {
    for (const id of runIds)
      if (String(object(await this.client.request(`actions/runs/${id}`)).status) !== 'completed')
        await this.cancelRun(id)
    const deadline = Date.now() + timeoutMinutes * 60_000
    let settlePolls = 0
    for (;;) {
      const active = (await this.activeRuns())
        .filter((run) => !String(run.path).startsWith('dynamic/'))
        .map((run) => Number(run.id))
      if (!active.length) return
      if (Date.now() >= deadline)
        throw new Error(`Runs still active after settling a failed attempt: ${active.join(', ')}`)
      await this.client.pause(Math.min(60_000, 10_000 * 2 ** settlePolls++))
    }
  }
  async enableWorkflow(file: string): Promise<void> {
    this.assertLease()
    if (file.startsWith('dynamic/')) return
    let workflow = await this.workflow(file)
    // Same 15 s of patience as one read a second, in 7 reads.
    for (let attempt = 0; !workflow && attempt < REGISTRATION_WAITS_MS.length; attempt++) {
      await this.client.pause(REGISTRATION_WAITS_MS[attempt] ?? 3_000)
      workflow = await this.workflow(file)
    }
    if (!workflow) throw new Error(`Workflow registration did not become visible: ${file}`)
    if (workflow.state !== 'active') {
      await this.client.request(`actions/workflows/${workflow.id}/enable`, 'PUT')
      await this.awaitWorkflowState(file, 'active')
    }
  }
  private async awaitWorkflowState(file: string, expected: string): Promise<void> {
    // GitHub acknowledges mutations before event routing consistently observes them.
    // Require a stable read after a propagation interval before changing refs.
    // 60 s of patience in 6 reads (it was 12 reads at 5 s): propagation usually takes seconds, so the early reads are
    // close together and the later ones spread out.
    for (const waitMs of STATE_SETTLE_WAITS_MS) {
      await this.client.pause(waitMs)
      if ((await this.workflow(file))?.state === expected) return
    }
    throw new Error(`Workflow state did not settle: ${file} -> ${expected}`)
  }
  async restoreWorkflowStates(): Promise<void> {
    for (const [file, state] of Object.entries(this.journal.workflowStates)) {
      // Restoring the original tree can remove metadata for workflows absent from it.
      if (state === 'absent' || !(await this.workflow(file))) continue
      if (state === 'active') await this.enableWorkflow(file)
      else await this.disableWorkflow(file)
    }
  }
  async ensureNoActiveRuns(): Promise<void> {
    if ((await this.activeRuns()).length)
      throw new Error('Active runs remain; collect them to completion before recovery')
  }
  async recoverExperiment(): Promise<ExperimentRecovery> {
    if (!existsSync(this.journalPath)) return { restoredRefs: {}, disabledWorkflows: [] }
    if (!this.journal.recovery) await this.acquireLease()
    await this.finishExperiment()
    const recovery = this.journal.recovery
    if (!recovery) throw new Error('Experiment recovery was not recorded')
    return { restoredRefs: recovery.restoredRefs, disabledWorkflows: recovery.disabledWorkflows }
  }
  async finishExperiment(): Promise<void> {
    if (this.journal.recovery?.phase === 'completed') return
    if (!this.journal.recovery) {
      this.assertLease()
      await this.ensureNoActiveRuns()
      if (!this.journal.initialRefs && Object.keys(this.journal.expectedRefs).length)
        throw new Error('Cannot restore modified refs without the initial experiment snapshot')
      const disabledWorkflows: string[] = []
      for (const workflow of (await this.client.all('actions/workflows', 'workflows')).map(object)) {
        if (workflow.state === 'active' && !String(workflow.path).startsWith('dynamic/')) {
          const file = String(workflow.path)
          await this.disableWorkflow(file)
          disabledWorkflows.push(file)
        }
      }
      const restoredRefs: Record<string, string | null> = {}
      for (const ref of Object.keys(this.journal.expectedRefs)) {
        const sha = this.journal.initialRefs?.[ref] ?? null
        await this.updateRef(ref, sha)
        restoredRefs[ref] = sha
      }
      await this.restoreWorkflowStates()
      // Persist restoration before releasing the lease. A crash after the remote
      // deletion can then complete locally without reacquiring or replaying mutations.
      this.journal.recovery = { phase: 'restored', restoredRefs, disabledWorkflows }
      this.save()
    }
    const lease = this.remoteRef(this.leaseRef)
    if (lease === this.journal.leaseSha) await this.releaseExperimentLease()
    else if (lease) throw new Error('Repository lease now belongs to another controller; refusing mutation')
    this.journal.recovery.phase = 'completed'
    this.save()
  }
  async preparePullRequestMetadata(params: {
    baseRef: string
    headRef: string
    labels: string[]
  }): Promise<{ prNumber: number }> {
    this.assertLease()
    const base = params.baseRef.replace('refs/heads/', '')
    const head = params.headRef.replace('refs/heads/', '')
    const pulls = array(
      await this.client.request(
        `pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${this.client.repository.split('/')[0]}:${head}`)}`,
      ),
    )
    const pr =
      pulls[0] ??
      (await this.client.request('pulls', 'POST', {
        title: `Benchmark ${this.journal.owner}`,
        head,
        base,
        body: 'Benchmark-owned replay PR.',
      }))
    const number = Number(object(pr).number)
    this.journal.prNumber = number
    this.save()
    if (params.labels.length) await this.client.request(`issues/${number}/labels`, 'PUT', { labels: params.labels })
    return { prNumber: number }
  }
  /** Set once the payload tree hash and history ref are checked; a sample installs base and head from one payload. */
  private payloadReady = false
  /**
   * Upstream-history replays: keep the upstream base commit advertised under a benchmark-owned ref, so its
   * history is uploaded once and later pushes negotiate against it. The ref lives outside refs/heads and
   * refs/tags: pushes there start no workflows (a tag push would start push workflows without branch filters).
   * Upstream's tags (`historyTags`) are mirrored here too, in one push (GitHub starts no workflow for more than
   * three tags pushed at once).
   */
  private ensureUpstreamHistory(): void {
    const sha = this.payload.historyBaseSha
    if (!sha) return
    const ref = `refs/bench/history/${sha.slice(0, 12)}`
    const actual = this.remoteRef(ref)
    if (actual && actual !== sha) throw new Error(`History ref ${ref} points to ${actual}, not ${sha}`)
    if (!actual) {
      this.assertLease()
      this.git(['push', '--quiet', `--force-with-lease=${ref}:`, this.remoteUrl(), `${sha}:${ref}`])
    }
    // Tags are mirrored on every start: identical ones are skipped, a conflicting one stops the run.
    if (this.payload.historyTags?.length) {
      this.assertLease()
      mirrorTagsToRemote({ gitDir: this.payload.gitDir, remoteUrl: this.remoteUrl(), tags: this.payload.historyTags })
    }
  }
  async installTreeToRef(params: {
    ref: string
    treeHash: string
    expectedCombinedHash: string
    role?: 'base' | 'head'
  }): Promise<{ commitSha: string; verifiedHash: string }> {
    if (params.treeHash !== this.payload.lock.combinedHash) throw new Error('Payload integrity mismatch')
    if (!this.payloadReady) {
      if (computeDirectoryHash(this.payload.treeDir) !== this.payload.lock.sourceTreeHash)
        throw new Error('Payload integrity mismatch')
      this.ensureUpstreamHistory()
      this.payloadReady = true
    }
    const commitSha =
      params.role === 'head'
        ? this.git([
            ...COMMIT_TREE,
            `${this.payload.headSha}^{tree}`,
            '-p',
            this.payload.baseSha,
            '-m',
            `[skip ci] Pre-dispatch head for ${this.journal.owner}`,
          ])
        : this.payload.baseSha
    await this.updateRef(params.ref, commitSha)
    return { commitSha, verifiedHash: this.payload.lock.combinedHash }
  }
  async triggerNativeEvent(params: {
    idempotencyKey: string
    event: string
    activityType?: string
    prNumber?: number
    targetRef: string
    workflows?: string[]
  }): Promise<{ headSha: string; dispatchedAt: string }> {
    this.assertLease()
    if (params.event === 'workflow_dispatch') return this.dispatchWorkflows(params)
    if (
      !['push', 'pull_request'].includes(params.event) ||
      (params.event === 'pull_request' && params.activityType !== 'synchronize')
    )
      throw new Error(
        'Native adapter currently supports push and PR synchronize; other activities require a dedicated adapter',
      )
    let dispatch = this.journal.dispatches[params.idempotencyKey]
    if (!dispatch) {
      dispatch = { headSha: this.payload.headSha, dispatchedAt: new Date().toISOString() }
      this.journal.dispatches[params.idempotencyKey] = dispatch
      this.save()
    }
    // Retry reconciles the desired immutable head; no empty trigger commits change HEAD^1.
    await this.updateRef(params.targetRef, dispatch.headSha)
    return dispatch
  }
  /**
   * Dispatch each workflow once on the installed head. The journal records every dispatch before the next,
   * so a resumed controller skips completed ones; a crash between the API call and the journal write can
   * duplicate one dispatch, which the collector rejects as an unexpected extra run.
   */
  private async dispatchWorkflows(params: {
    idempotencyKey: string
    targetRef: string
    workflows?: string[]
  }): Promise<{ headSha: string; dispatchedAt: string }> {
    const branch = params.targetRef.replace('refs/heads/', '')
    let dispatch = this.journal.dispatches[params.idempotencyKey]
    if (!dispatch) {
      const headSha = this.remoteRef(params.targetRef)
      if (!headSha) throw new Error(`Dispatch ref is missing: ${params.targetRef}`)
      dispatch = { headSha, dispatchedAt: new Date().toISOString(), workflows: [] }
      this.journal.dispatches[params.idempotencyKey] = dispatch
      this.save()
    }
    if (this.remoteRef(params.targetRef) !== dispatch.headSha) throw new Error('Dispatch ref moved before dispatch')
    for (const file of params.workflows ?? []) {
      if (dispatch.workflows?.includes(file)) continue
      const workflow = await this.workflow(file)
      if (!workflow) throw new Error(`Workflow is not registered: ${file}`)
      await this.client.request(`actions/workflows/${workflow.id}/dispatches`, 'POST', { ref: branch })
      dispatch.workflows = [...(dispatch.workflows ?? []), file]
      this.save()
    }
    return { headSha: dispatch.headSha, dispatchedAt: dispatch.dispatchedAt }
  }
}
