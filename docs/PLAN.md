# Consolidation and hardening plan

Updated 2026-11-06 after adversarial review of the implementation. This replaces the greenfield implementation plan. The next milestone is a trustworthy, usable end-to-end benchmark built from the existing modules; presentation polish follows correctness and native execution evidence.

## Current state and retained decisions

The implementation now connects deterministic preparation, a native GitHub adapter, serialized experiment execution/recovery, cache reset/seeding, collection, source-backed assessment and reporting. The three architecture polish iterations consolidated job-context observations, prepared identity, and evidence verification. See [validation](VALIDATION.md) for executable checks and native run evidence; this document retains the original acceptance criteria so incomplete capabilities remain visible.

| Work area | Implemented | Remaining scope |
|---|---|---|
| False-success prevention | Requested manifests; bound assessments; paired-only comparisons; missing data fails closed | Native upstream-reference qualification must be supplied by project collectors |
| Preparation | Clean pinned Git inputs; patch stacks; native ancestry; immutable payloads and metadata; preserved symlinks | External action/reusable dependency resolution; submodules/LFS/export attributes currently block |
| Native replay | Push and PR synchronize; downstream correlation; lease, compare-and-swap, interrupted recovery | Other PR activities, fork-only semantics, unresolved expressions and external reusable calls need adapters |
| State profiles | Actions cache cold reset, separate warm seeds, seed cost accounting, artifact provenance checks | Automatic external-cache lifecycle and arbitrary cross-run artifact binding |
| Evidence/reporting | JSON/JUnit verdicts, LCOV/Istanbul coverage, hashed sources, shared JSON/CSV/Markdown/action report | Each OSS project needs collectors for its semantic obligations and runner/image evidence |
| Polish | Three focused iterations and regression tests through existing interfaces | No new framework or parallel orchestration model |

### Template scale-out (2026-11-06, later)

To make one template produce hundreds of benchmark repositories, the following landed on top of the consolidation work:

| Area | Implemented | Remaining scope |
|---|---|---|
| Setup | `bench init` locks scenarios and upstream reference runs, fetches the pinned source, generates identity-guard remaps with exact match counts, enables `workflow_run` correlation, classifies runner labels and flags external side effects; refuses to overwrite a config | Automatic choice of representative commits/PRs; StarSling label catalog lookup |
| Workflow semantics | Three-valued GitHub expression evaluator (contexts, operators, functions, status checks); runtime-only conditions are `conditional` and evaluated natively instead of blocking | Step-level conditions are not predicted (parity reports step differences informationally) |
| Upstream parity | `bench reference`/`bench parity` compare baseline replays job-by-job with upstream's runs; the report withholds headlines without it | Reruns on upstream reference runs are taken as recorded |
| Presentation | `bench showcase` renders the README (three runner configurations, PR and merge CI duration, CI minutes, hardware vs self-improving CI speedup, claim checklist, appendix with per-job times, samples, agent PRs and method) in the language of `GLOSSARY.md`; `bench publish` writes the showcase tree to the default branch under the lease; the action summary shows per-job and per-step timings | Progressive publication while an experiment holds the lease |
| Packaging | `bench-` prefixed workflows, `setup-bench` composite action, `bench-report.yml` reusable report/publish workflow, Claude Code skill link, `scripts/sync-template.sh` for existing benchmark repositories | A controller workflow that runs experiments inside Actions (needs resumable multi-job execution beyond the 6-hour job limit); the writefreely pilot's laptop controller slept repeatedly |
| Layout | The default branch is the benchmark page with `upstream/` pinned as a submodule; replays push to a replay branch named like upstream's (`replayBranch`) | Workflow registration still commits an inactive placeholder to the default branch during an experiment (restored afterwards); try skipping placeholders in this layout, since staging commits carry `[skip ci]` |
| Cache evidence | `actions/cache`-style restores and saves read from job logs; BuildKit `type=gha` cache read from job logs | BuildKit plain-progress output is read per build: steps `DONE`/`CACHED`/`ERROR` and the `type=gha` import/export lines become a `buildkit-gha` cache event (hit = successful import plus at least one `CACHED` step), so cold and warm gating applies to Docker builds that use `type=gha`; the cold reset already deletes those entries (it filters by ref, not key). Not observed: a runner's local Docker cache (for example on a persistent StarSling machine), other BuildKit backends (`type=registry`, `type=local`, `type=s3`), builds that log no gha cache lines, and which exact entry served an import (the source ref is bound heuristically from `index-*`/`buildkit-blob-*` entries) |

### Faster experiments

A full DefinitelyTyped matrix (2 scenarios × 2 cache profiles × 4 variants × 5 repetitions, plus a warm seed per warm sample) takes about 15 hours from one repository, because samples are serialized behind one lease. Use a staged approach:

1. **Validation run** (about 1.5 hours): one repetition of GitHub-unchanged vs StarSling-with-patch, both profiles and both scenarios. It proves parity, evidence, cache seeding and the showcase.
2. **Statistical run**, made faster by: one replay repository per variant (leases are per repository, so variants run concurrently, about 4x), reusing a warm seed across consecutive samples of the same variant when the measured samples do not write the seeded keys, and measuring only the cache profile a patch can change.

Retain these product decisions:

- One benchmark repository, with a control branch and benchmark-owned replay default/topic branches. Serialize whole samples; preserve native parallelism, dependencies, conditions, concurrency behavior and step order inside each sample.
- Lock a public upstream SHA and real PR/main scenarios. A PR scenario additionally needs immutable base/head/merge context and changed paths; a single SHA does not supply that context.
- Compare GitHub baseline, GitHub patched, StarSling baseline, and StarSling patched. Keep unsupported OS/architecture jobs on their original GitHub runners and label mixed pipelines explicitly.
- Apply ordered patches before discovering each variant's graph. Patches may change any source, dependency, or workflow. Compare semantic work across graph changes rather than requiring identical job names.
- Support named profiles with independent GitHub Actions cache and artifact policies, including cold, warm, and explicitly uncontrolled diagnostics. Cached test results require validated provenance.
- Repo minutes are the sum of runner-job elapsed time. PR/main wall clock spans the earliest relevant workflow start through the last relevant job end across the complete event cascade. Independent jobs have no fixed chronological ordering to reproduce.
- Separate same-hardware agent optimization from cross-hardware runner impact. “Cost neutral” excludes sharding that spends freed minutes. Missing coverage permits accurately labeled timing/test evidence, not a claim of coverage within 0.1 percentage points.
- Deterministic TypeScript owns repeatable setup and execution. The skill handles scenario ambiguity, contextual adaptations, collector design, and diagnosis. Shared actions/workflows encapsulate harness behavior without flattening upstream workflows into a new synthetic pipeline.

The local review reproduced: successful empty collection; a no-op `bench run` exiting zero; headline approval without parity/cache evidence; warm validation without cache observations; incorrect negative-path/boolean-condition handling; unverified source preparation; stale prepared-tree hashes; and symlink-target hash collisions. These are release blockers, not cosmetic issues.

## Consolidate around five contracts

Refactor the current modules in place. Add only the missing integration boundaries; avoid a second framework or a new workflow representation for every subsystem.

| Contract | Owns | Existing modules to consolidate |
|---|---|---|
| Prepared experiment | Resolved inputs, scenario ancestry, immutable variant payloads, invocation expectations, compatibility blockers | `config`, `types`, `inventory`, `inventory-helpers`, `patcher`, `generator` |
| Experiment manifest and journal | Selected sample matrix, ordering, lease/fence, remote operations, replay identities, recovery | `cli`, `staging`; add concrete GitHub adapter |
| Observed execution | Raw API/webhook/log/artifact evidence, invocation IDs, timings, cache events, runner fingerprints | `collector`; add native payload normalization and lifecycle adapters |
| Evidence assessment | Completeness, parity, cache validity, coverage qualification, hardware comparability, claim eligibility | `parity`, `cache-lifecycle`, relevant `reporter-helpers` logic |
| Report | One validated report model rendered as JSON, CSV, Markdown and Actions summary | `reporter`, `reporter-helpers`, `action/index` |

Every observation and assessment must reference the experiment/sample identity and prepared-input fingerprint. Keep “unknown”, “failed”, “passed”, and explicitly “not applicable” distinct. A caller-provided boolean is not provenance. Persist schemas with versions and validate external JSON at runtime.

The CLI is a thin orchestrator over these contracts. The action renders a validated assessment; it must not independently infer parity or silently omit required evidence.

## Work package 1 — Stop false-success results

Priority: P0. Implement before any public benchmark claim.

1. Introduce the requested experiment manifest: selected scenarios × profiles × variants × repetitions, deterministic order keyed by the entire tuple, expected invocations, and replacement-attempt policy. Configuration alone does not identify which subset was requested.
2. Reconcile collection and reports against that manifest. Reject empty selections, duplicate tuple/sample identities, unknown samples, mismatched fingerprints and absent requested groups. Classify a proven no-work scenario explicitly; do not turn zero work into a speedup.
3. Replace default-success parity/cache handling with explicit assessments. Bind evidence to every relevant variant/sample; forbid broad profile/scenario fallbacks from borrowing another sample's proof.
4. Define claim categories: diagnostic timing; complete-pipeline timing; test-verdict parity; coverage-qualified parity; same-hardware optimization; cost-neutral optimization. Compute eligibility independently for each category and explain withheld claims.
5. Require nonempty comparison sets for action success. Separate execution completion, evidence qualification and publication eligibility. Reporting a useful diagnostic must not mislabel it as verified parity.
6. Keep descriptive unpaired data separate; compute comparative ratios from declared, complete pairs only. Do not silently fall back to unpaired results. Record failed, cancelled and replaced attempts; never choose only the fastest/successful attempts retrospectively.

Exit criteria: the current false-success probes fail closed; five fabricated repetitions cannot obtain a parity-qualified headline; missing one requested group, one matrix instance, or one required evidence artifact is visible and disqualifies the affected claim. CLI and action produce the same eligibility decisions.

## Work package 2 — Make preparation genuinely immutable

Priority: P1. Depends on the prepared-experiment contract, not on live execution.

1. Materialize the configured Git objects into isolated temporary directories. Reject a mismatched local checkout and prevent generated output from being recursively copied into its source. Resolve patch bytes/URLs and reusable workflow/action dependencies; record immutable revisions separately from the source's original reference.
2. Preserve executable bits, symlink targets, binary changes and submodule/gitlink identity. Support or explicitly block unsupported checkout semantics such as unresolved LFS/submodules.
3. Connect existing ancestry construction to preparation. Produce scenario-specific base, head, merge and push-before/after replay objects; preserve changed-path and parent-relative behavior. Document unavoidable identity differences in the adaptation ledger.
4. Define a final execution-payload manifest and hash only after transformations are complete. Keep the hash-containing ledger outside that payload to avoid self-reference. Distinguish Git tree/commit IDs from SHA-256 content fingerprints; staging must install and verify actual payload bytes.
5. Expand lock/certificate invalidation to source/patch bytes, dependency resolutions, scenario context, adaptations, runner mapping, collectors, cache adapters/profiles, harness version and generated payloads. Record observed runner-image drift separately; invalidate comparability when it changes relevant assumptions.
6. Consolidate configuration loading around the existing `benchmark.config.ts`; optionally accept validated JSON explicitly. Eliminate README/skill/CLI disagreement. Discovery must never silently fabricate PR numbers, changed paths, or commits.

Exit criteria: a wrong SHA, dirty/untracked input, changed symlink target, changed local action or altered installed file is detected. Two preparations from the same locked inputs produce identical payloads. Existing patch fixtures still pass, and parent-relative diff tests operate through the real preparation path.

## Work package 3 — Preserve native workflow semantics

Priority: P1. Build from current inventory/generator modules.

1. Store filters per trigger event, including activity types and ordered positive/negative patterns. Expand supported static matrices with proper include/exclude semantics. Treat dynamic matrices and unsupported expressions as unresolved until actual execution provides evidence.
2. Remove confident regex approximations of arbitrary GitHub expressions. Recognize only a documented safe subset; preserve expressions for native evaluation and surface unresolved expectations. Downstream workflows use their own event context.
3. Resolve local/external reusable workflows and composite actions recursively with cycle handling, source revisions and call-site identities. Inspect nested cache/artifact/secret requirements. Preserve native caller/callee execution rather than inventing separate workflow runs for callees.
4. Preserve `runs-on` arrays, groups, expressions, architecture and matrix context. Resolve StarSling mapping per actual job instance; unknown mappings block runner-impact claims. Retained GitHub jobs remain in wall-clock/repo-minute totals.
5. Replace whole-file textual adaptations with scoped YAML-node edits and expected match counts. Fail on missing/ambiguous matches; emit reviewable changes with source locations. Record each adaptation as a parity obligation.
6. Compare independent baseline and patched graphs. Graph restructuring needs observed evidence linking commands, tests, outputs and coverage to semantic obligations, not an author-supplied list claiming those obligations were fulfilled.

Exit criteria: regression fixtures cover different PR/push filters, negative patterns, compound conditions, static/dynamic matrices, repeated reusable calls, runner arrays/expressions, and job-scoped adaptations. Unsupported semantics create actionable blockers rather than invented parity. Every in-scope upstream job is accounted for.

## Work package 4 — Connect native execution and recovery

Priority: P1. Deliver the smallest working vertical slice first: one real pinned main scenario, one variant, one repetition, diagnostic-only. Then PR and downstream workflows, then the full matrix.

1. Implement concrete GitHub adapters for refs/objects, workflow states, PR metadata/events, runs/jobs/artifacts and relevant cache operations. Validate against real payload fixtures. Keep credentials in the controller; workload jobs do not receive the controller's repository-management token.
2. Route all advertised CLI commands (`init`, `inspect`, `prepare`, `verify`, `run`, `collect`, `report`, `recover`) with structured errors and reliable exit codes. Unknown commands fail. `collect` and `report` resume from persisted experiment state.
3. Replace the local-file lease with a repository-scoped atomic mechanism and fencing. Specify and test the actual primitive; a concurrency label alone does not fence local/external controllers. Snapshot prior ref values and workflow states.
4. Stage verified ancestry before PR creation. Preserve the real base branch semantics; store replay PR number, refs and SHAs separately from upstream identities. Avoid changing the source default-branch name to simplify staging.
5. Journal intent before remote mutations. Reconcile remote state after a crash before retrying; native event APIs do not acquire idempotence merely because the adapter receives an idempotency key. Persist PR metadata immediately.
6. Make completion waiting mandatory. Hold the lease and replay tree fixed until all correlated direct/downstream invocations finish, or a timeout yields an incomplete sample. Reconcile expected late runs before concluding; a brief period of quiet is not proof of completeness.
7. Recovery must first resolve active executions, then restore only owned refs whose current values match the journal's expectations, and restore prior workflow states. Unexpected mutations stop recovery with a concrete conflict report.

Exit criteria: crash tests before and after every remote side effect; two independent controllers cannot mutate concurrently; resume does not duplicate events or lose the replay PR identity; delayed downstream runs see the correct tree; recovery never overwrites a third-party ref update. A native pilot proves PR branch/path filters and downstream execution.

## Work package 5 — Execute cache profiles and collect complete evidence

Priority: P1. Integrate these operations into the lifecycle, not just the validators.

### Cold and warm state

- Inventory all eligible caches: explicit Actions cache usage, setup-action caches, cross-run artifacts, persistent runner/disk state, Docker caches and external services. Each controlled store needs a reset/seed/observe adapter or a blocker.
- Cold means no eligible pre-existing workload state at sample start. Preserve lookup, population, save and upload behavior. Permit a downstream job to consume state created earlier in the same cold sample when producer provenance proves that origin.
- Warm runs a locked producer scenario for the same variant and compatible inputs, verifies visible state, then measures the consumer. Keep provider/variant/profile state isolated. Test exact hits, restore-key hits, required misses and unexpected misses separately.
- Apply cache and artifact policies independently. Within-scenario artifacts remain normal dependencies; cross-run artifact reuse requires a patch introducing it and verified producer-run/content provenance. Bind required seed IDs to actual consumption, not merely matching names.
- Preserve native keys and branch visibility where possible. Any namespacing adaptation must be recorded and shown to preserve key/invalidation semantics. Delete only benchmark-owned state; verify reset completion before dispatch.
- Report cold population/save cost, seed execution, measured warm consumer, and explicitly defined amortization separately. Include post-job cache saves in measured job time. Never hide seed costs in a cost-neutral claim.

### Timing and semantic evidence

- Normalize real GitHub payloads. Use workflow-run ID, attempt, parent invocation, reusable-call path and matrix identity; do not collapse all runs at one workflow path. Obtain missing correlation evidence through documented payloads/recorded events rather than fabricated API fields.
- Persist raw paginated evidence and retrieval timestamps. Account for eventual consistency, rate limits and repeated collection. Preserve all attempts; predeclare how retries affect the sample.
- Require expected jobs to actually execute, with expected matrix instances and conclusions. Preserve unknown timestamps; never substitute creation time for execution start. Derive wall clock and runner minutes from the documented boundaries, including setup/post-job effects, and report instrumentation overhead separately.
- Keep GitHub's second-resolution timestamps distinct from optional monotonic phase measurements. `@actions/core` formats and publishes measurements; it is not the timing source. Do not claim queue/dependency-wait separation unless the available evidence supports it.
- Parse native test/coverage/build artifacts into stable identities. Require positive seed validation for reused tests and cached coverage. Missing matrix counts or required collectors are unknown/failure, never pass. Compare coverage scope as well as percentage; missing coverage downgrades qualification.

Exit criteria: test cold misses followed by valid same-sample hits, warm exact/partial hits, missing/expired/mismatched seeds, cross-variant contamination, PR-scope visibility and unknown external state. Mutation fixtures must invalidate cached test results when relevant inputs change. Repeated listener invocations and skipped required jobs cannot disappear from totals or parity checks.

## Work package 6 — Finish claim policy, usability and maintenance

Priority: P1 for claim policy; P2 for presentation and packaging.

1. Compare runner hardware per corresponding workload, not pooled labels. Separate same-provider optimization, runner-only and combined ratios. Show mixed pipelines and observed runner/image metadata prominently.
2. Implement the user's cost-neutral rule. If a patch adds sharding, prove that it did not spend freed minutes using an appropriate controlled optimized reference; otherwise classify cost-neutrality as unproven. Do not use total job count as a proxy for shard count.
3. Keep raw repo minutes, estimated billed minutes and billed currency separate. Version pricing inputs and applicable runner classes; public-repo status is not sufficient to assume every runner is free. Unknown billing stays unknown.
4. Use one report model for Markdown, JSON/CSV and `core.summary`: requested/completed counts, complete-pair distributions, wall-clock and repo-minute ratios, job/step details, cache state, seed cost, evidence level, withheld reasons and links to raw runs. Map renamed/merged steps explicitly; ambiguous mappings remain unaligned.
5. Update README and setup skill to the implemented command contract and capability status. Provide one tested quick-start plus a troubleshooting path keyed by structured blockers. Keep nondeterministic agent work narrowly scoped; regenerate repeatable files through TypeScript.
6. Add reusable maintenance workflows for tests/typecheck/lint/build and deterministic bundle checks. Make Git fixtures hermetic, including signing configuration. Smoke-test the packaged CLI and bundled reporting action outside the source checkout. Use composite/reusable actions for harness-only tasks; avoid adding measurable jobs to the upstream graph merely to reduce YAML duplication.

Exit criteria: a new user can follow the quick-start from a clean template; CLI and action reports agree; diagnostics explain incomplete claims without inspection of source code; source and bundled action have consistent behavior.

## Delivery order and release gate

| Increment | Deliverable | Required proof |
|---|---|---|
| A | Fail-closed assessment and requested manifest | Adversarial false-success regressions |
| B | Immutable preparation and corrected inventory | Hash/ancestry/semantics fixtures through public entry points |
| C | Real CLI/backend vertical slice | Native main then PR/downstream diagnostic pilot, crash/recovery tests |
| D | Integrated cache and semantic evidence | Cold/warm provenance, invalidation and full-cascade collection |
| E | Four-way reports and template polish | Complete paired experiment and clean-template onboarding |

Do not add more integrations or abstraction layers until increment C works. Retain and extend the existing DefinitelyTyped fixture as a regression for workflow-changing patches, but label it as a fixture: it does not establish live DefinitelyTyped parity. Use a small purpose-built native fixture first, then a real public-project pilot with an immutable reference workload and the requested patch behavior.

Before calling the template ready, run the full four-variant matrix for selected PR and main scenarios and both controlled cold/warm profiles. Start with one diagnostic repetition to resolve parity; then run the declared publication repetition count (currently five) with deterministic interleaving and complete paired reporting. Five is a minimum policy, not proof of statistical significance; expose variance and additional sampling needs. Retain all raw evidence, seed costs, failure history and the lock/journal. No missing in-scope workflow/job can be waived into a full-parity claim.

This review changes the plan only. Implementation changes and native pilot execution remain subsequent work.
