# Native adapters and evidence

The GitHub adapter normalizes the documented [workflow job responses](https://docs.github.com/en/rest/actions/workflow-jobs) and [workflow run responses](https://docs.github.com/en/rest/actions/workflow-runs). Logical job IDs and downstream parent IDs are enrichment, not invented REST fields. Optional deterministic context steps emit these IDs into job logs. Raw responses are retained under the experiment's `raw/` directory.

The controller uses native push and PR synchronize events; its credentials must be a GitHub App token or user credential that can trigger workflows. See [triggering events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). The staging interface rejects backends identified as using GITHUB_TOKEN. The local adapter uses authenticated gh/Git credentials; do not supply the repository GITHUB_TOKEN as controller credentials. Git operations use the configured Git credentials; local SSH users can set `BENCH_GIT_TRANSPORT=ssh`.

The lease is an atomic create of `refs/tags/bench-controller-lease` using `git push --force-with-lease=<ref>:`. Its commit identifies the owning experiment. Controllers never steal leases automatically. Every ref mutation compares the expected remote value; an unexpected value stops execution. Keep `controller.json` and each staging journal until recovery completes. Recovery refuses to run while workflows are active.

Repository-specific evidence belongs in hashed source files, linked to the exact sample, run IDs and prepared fingerprint. `verify` validates those files and computes assessments; reporting binds each assessment to the hash of its collected observation. An absent collector downgrades evidence, never implies success. Public claims still require native upstream-reference parity, not just a green replay.

Controlled cache state requires inventory of all eligible stores. The native adapter resets Actions caches in benchmark-owned refs, seeds each warm variant separately and records seed runner time. External cache adapters and artifact reuse must provide explicit reset/seed/provenance evidence. Unknown stores block controlled claims.

Preparation and replay metadata are immutable. Use a fresh prepared directory for changed inputs; the CLI refuses to overwrite a completed preparation. Keep that directory with the experiment record. Historical assessment accepts the original harness identity but requires the experiment and prepared fingerprints to match.

Staging base commits and PR preludes contain `[skip ci]`, while measured head commits do not. This prevents delayed staging events from filling a cold cache when workflow states change. GitHub documents this behavior for [push and pull-request events](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs); it does not suppress `pull_request_target`. Such event semantics require a dedicated adapter. Workflow enable/disable operations wait for observed state propagation.

Evidence hashes establish integrity, not authenticity. The evidence adapter must obtain files from the recorded run, preserve artifact provenance, and extract complete tests/coverage/cache observations. Test and coverage declarations are checked against parsed bytes. Reports do not independently authenticate a user-supplied assessment file.

Replay ancestry preserves the selected base/head diff and PR merge-parent relationship. It does not mirror all upstream history, tags or unrelated refs. (With `replayHistory: "upstream"` the history and the tags at or before the pin are mirrored.) Workflows that depend on those inputs (including the cost of an unshallow checkout) need an explicit history-preserving adapter before claiming upstream timing parity. Treat the default replay's timings as controlled replay measurements until that comparison is verified.

Workflow registration uses local Git objects and a temporary index, then the controller's guarded push. It does not require Git Data REST write access or modify the payload worktree/index. The lease commit uses an empty tree, so acquiring a lease cannot publish upstream workflows through a tag.

## Upstream reference and publishing

`bench init` locks the upstream runs GitHub recorded for each scenario's commit: the earliest run per workflow for the scenario event (the run the push or PR update caused) plus `workflow_run` listeners on the same head SHA. Scheduled, manual and GitHub-managed dynamic runs are excluded. `bench reference` re-fetches those exact run IDs and attempts with their jobs and steps; snapshots are immutable inputs committed under `reference/`. GitHub deletes runs after the repository's retention period, so a pin needs retained runs to qualify for upstream parity.

`bench publish` builds the showcase tree (README, patches, results, config, reference snapshots; never workflows) with a temporary index, commits it on top of the current default branch with `[skip ci]`, and updates the branch with an expected-value guard while holding the repository lease. A concurrent experiment therefore blocks publishing instead of racing it. An interrupted publish is resumed by publishing again; its journal lives in the experiment directory until it succeeds. In Actions, `bench-report.yml` publishes with the workflow's `GITHUB_TOKEN`, whose pushes do not start workflows.

## Protected branches

Every branch write goes through `NativeReplayBackend.updateRef` (tree installs, workflow placeholders, recovery restores and `bench publish`). It refuses any branch named as the base or head of a `merged-pr` patch, and `ReplayStagingController` refuses to start a sample whose owned refs include one. The default branch counts as controller-written (placeholders, publish, restore), so agent PRs merge into a separate base branch. The lease tag and `refs/bench/history/*` are not branches and are unaffected.

## Dispatch seeds and log evidence

A `workflow_dispatch` scenario installs its head tree on the default branch with a `[skip ci]` commit, so push workflows cannot start, then dispatches exactly the listed workflows there. Each dispatch is journaled before the next. Caches the seed saves are scoped to the default branch, so the measured PR or push sample can restore them, as upstream's runs restore caches from upstream's scheduled producers.

`bench evidence` downloads job logs with a token-bearing request to the API, which redirects to blob storage; the token is not forwarded to the storage host. Cache restores are read from the action's logged inputs (`key`, `restore-keys`) and results (`Cache hit for`, `Cache hit for restore-key`, `Cache not found for input keys`), then bound to the producing ref using the repository's cache list taken right after the sample. Logs stay under `experiments/<id>/logs/` (git-ignored); the derived evidence files and their hashes are committed.
