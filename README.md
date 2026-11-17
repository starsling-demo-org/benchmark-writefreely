# StarSling CI benchmark template

Create one public repository per open-source project to show, with the project's own CI, how much sooner a PR and a merge finish on StarSling Runners (the hardware speedup), and how much more StarSling's agent PRs add (the self-improving CI speedup). Each benchmark repository replays real upstream events, measures every workflow, job and step, checks the replay against upstream's own runs, and publishes a README showcase on its default branch.

## Terms

[`GLOSSARY.md`](GLOSSARY.md) defines every term. The ones the results use:

- **PR CI duration**: elapsed time from the first workflow starting to the last job finishing, across every workflow one PR update starts, including `workflow_run` follow-ups.
- **Merge CI duration**: the same, for every workflow one merge to the default branch starts.
- **CI minutes**: the sum of every job's runtime for one event. A "5× fewer CI minutes" claim needs the same tests, the same verdicts and coverage within 0.1 percentage points.
- **Hardware only / self-improving CI**: StarSling Runners running the CI unchanged, or with StarSling's agent PRs applied. The total speedup is the hardware speedup times the self-improving CI speedup.
- **Cost neutral**: self-improving CI saves CI minutes without adding parallel jobs that spend them again. Hardware speedups never establish it.
- **Same CI as upstream**: the replay runs the same workflows and jobs as upstream's own run for that event, with the same conclusions.

## How a benchmark works

1. **Pin.** `bench init` locks two events: an upstream commit merged to the default branch (against its first parent) and, optionally, an upstream PR (base, head, merge, changed files, labels), plus the IDs of upstream's own runs for those commits.
2. **Prepare the runner configurations.** For each event the pinned source is materialized four ways: GitHub-hosted runners and StarSling Runners, each with the CI unchanged and with the agent PRs applied (self-improving CI). Agent PRs apply before workflow discovery, so they may change anything, including `.github/workflows`. Both providers change only `runs-on`. StarSling configurations use the StarSling label; GitHub-hosted configurations use the `github` target of `runnerMapping`, an explicit pinned label (OS version and size, normally a larger runner the size of upstream's public runner), never a `-latest` alias, never a standard hosted Linux or Windows label (`ubuntu-24.04`, `ubuntu-24.04-arm`, `windows-2022`: 4 vCPU in a public repository, 2 vCPU in an internal one), and never upstream's own label. macOS labels are the same size in both and may be kept. Internal benchmark repositories get 2 vCPU standard GitHub runners while upstream's public repository gets 4 vCPU / 16 GiB, so an unpinned GitHub arm would be slower than upstream's and would change when the repository turns public. `bench init` writes a `TODO-github-larger-runner-for-<label>` placeholder for each upstream label; `bench inspect` and `bench prepare` refuse, naming the workflow and job, until each is replaced and its size is in `runnerMapping.runnerSpecs`. Pinned macOS, Windows and Arm labels StarSling does not offer stay as they are on both sides and still count. A job whose `runs-on` is `${{ matrix.<key> }}` over a literal list (or literal `include` entries) is supported: `runs-on` and the matrix shape stay, and each value is rewritten per configuration by the same rules as a plain label (the `github` target for GitHub-hosted configurations, the `starsling` target for StarSling ones; values StarSling does not offer stay on their GitHub label). Matching `exclude` entries are rewritten too. A job `name` that shows the value keeps showing the original value, so check names do not change; a job with no `name` gets GitHub's default check name, which includes the matrix values, so those checks carry the rewritten value. Values from `fromJSON`, outputs or variables, a key the matrix does not define, a value the job compares elsewhere (`if: matrix.os == ...`), or two values that would become the same label are refused, naming the job; add a `runnerMapping.jobOverrides` entry to replace `runs-on` outright. The README's runner table reports the GitHub label and size the jobs ran on.
3. **Replay natively.** One sample at a time, the controller pushes the exact tree to the benchmark repository's replay branch (named like upstream's branch, so branch filters match), or synchronizes a replay PR, and lets GitHub run every workflow, job and step with its own triggers, path filters, `needs`, conditions, matrices and downstream workflows. It waits for every workflow to finish, then restores the repository. Placeholder registration of workflows new to the default branch commits an inactive stub only when that file is missing or different there; an identical placeholder produces no commit or push. Rounds are interleaved in a deterministic shuffled order; caches are reset (cold) or seeded by a separate run (warm).
4. **Check and report.** `bench parity` compares replays of the unchanged CI job by job with upstream's runs. The report computes medians from complete rounds only, separates the hardware speedup from the self-improving CI speedup, and withholds any claim the evidence does not support. The same model renders JSON/CSV, the `@actions/core` job summary, and the README showcase.

Conditions that depend only on the event (`github.event_name`, `github.ref`, identity guards, labels) are evaluated before dispatch. Conditions that need runtime state (`needs.*.outputs`, `vars`, step outputs) are left to GitHub and checked by upstream parity.

## Create a benchmark repository

Requires Node 24+, pnpm, Git, and `gh` authenticated as a user or GitHub App that can push and toggle workflows in the benchmark repository. Replays push workflow files, so an HTTPS token needs the `workflow` scope (`gh auth refresh -h github.com -s workflow`); `BENCH_GIT_TRANSPORT=ssh` uses SSH instead. A push made with a workflow's `GITHUB_TOKEN` does not trigger other workflows, so the controller cannot run with it. The controller runs on your machine and must stay awake for the whole experiment, which takes hours: on macOS, run it on AC power with the lid open under `caffeinate -dimsu`. A laptop with its lid closed sleeps whatever `caffeinate` says, and every sleep stalls the experiment until it is resumed; a server or an always-on desktop avoids that. An interrupted run resumes when the same `bench run` command runs again.

```sh
gh repo create OWNER/PROJECT-ci-speedup --public --template OWNER/benchmark-template --clone
cd PROJECT-ci-speedup && git switch -c bench/control && pnpm install --frozen-lockfile
# If upstream's default branch is also main: rename this repository's main to benchmark (init's notes say how).

pnpm bench init --upstream UPSTREAM/PROJECT --sha FULL_SHA --bench-repo OWNER/PROJECT-ci-speedup --pr 1234 \
  --history upstream                                 # when upstream CI checks out full history (fetch-depth: 0)
pnpm bench inspect                                   # blockers, runner labels, side effects, native conditions
pnpm bench publish                                   # the benchmark page, with upstream/ pinned, before any result
pnpm bench prepare
pnpm bench run --experiment diag-1 --scenarios main-push --variants github-baseline --profiles cold --repetitions 1
pnpm bench parity --experiment diag-1                # iterate until green
# add one patch per agent PR (a patches/*.patch file, or a merged PR: see "Patch sources"), then bench prepare, a one-round validation run, and the full run:
pnpm bench run --experiment check-1 --repetitions 1 --variants github-baseline,starsling-baseline,starsling-patched
pnpm bench run --experiment full-1
pnpm bench evidence --experiment full-1 --extractor collectors/<project>.ts   # verdicts, check coverage, caches
pnpm bench verify --experiment full-1 --evidence experiments/full-1/evidence/evidence.json
pnpm bench showcase --experiment full-1              # preview experiments/full-1/README.md
pnpm bench showcase --experiment full-1 --fix-arm-experiment fix-2   # StarSling + agent PRs arm from experiments/fix-2 (same scenarios, profiles, harness and config but patches)
pnpm bench publish --experiment full-1               # or push bench/control and let the workflow publish
```

An AI agent should follow [`skills/setup-parity`](skills/setup-parity/SKILL.md), which drives this loop and lists a fix for each blocker and parity difference. It is also available to Claude Code as a project skill. `pnpm bench --help` lists every command and flag.

## What lives where

| Path | Branch | Contents |
|---|---|---|
| `src/`, `tests/`, `dist/`, `action.yml` | `bench/control` | The harness, its tests, and the bundled reporting action |
| `benchmark.config.json` | `bench/control` | Generated by `init`: pin, scenarios, reference runs, patches, runner mapping, cache profiles, adaptations |
| `showcase.json` | `bench/control` | Short hand-written README notes (how the checks were shown to be the same, method notes, agent PR links) and the headline `experiment`. `"layout": "showcase"` (or `bench showcase --layout showcase`) selects the result-table-first page ([example](docs/SHOWCASE-LAYOUT-EXAMPLE.md)); its extra inputs are `whatWasSlow`, `whatWeChanged`, `pushesPerMonth` / `prUpdatesPerMonth` (`{ "value", "source" }`, omitted savings line without them) and `agentPrs` (`url`, `summary`, and the per-lever `experiment` `{ id, before, after }` whose results supply that PR's numbers) |
| `patches/` | `bench/control` | One patch file per agent PR, applied in config order (merged-PR patches need no file; see below) |
| `reference/<scenario>.json` | `bench/control` | Upstream's own runs, jobs and steps for each event |
| `collectors/<project>.ts` | `bench/control` | The project's evidence extractor (test verdicts, check coverage) |
| `experiments/<id>/` | `bench/control` | Experiment record, journals and evidence (`raw/` API dumps are git-ignored) |
| `.bench-work/` | local only | Upstream checkout and prepared payloads |
| `README.md`, `upstream/`, `patches/`, `benchmark/` | default branch | The benchmark page: the published showcase ([example](docs/SHOWCASE-EXAMPLE.md)), and upstream at the pinned commit as a submodule. Replays never touch it. |
| upstream's tree | replay branch | Named like upstream's branch (`develop`, `master`, `main`); the controller pushes each sample's tree here and restores it afterwards. Upstream CI with `workflow_run` listeners replays on the default branch instead, because GitHub runs those only from there. |

The harness workflows are prefixed `bench-` so they never collide with an upstream workflow path: `bench-harness.yml` tests the harness through the reusable `bench-verify.yml`, and `bench-report.yml` summarizes a committed experiment and publishes the showcase. Both use the `setup-bench` composite action.

## Patch sources

Each entry in `patches` has a `source`:

- `local`: a file under `patches/`, locked by SHA-256.
- `github-pr` / `github-commit`: a pull request or commit URL, locked to a full SHA when prepared. A `github-pr` patch is the PR's base...head diff and is not checked for state.
- `merged-pr`: a pull request in the benchmark repository that **must be merged**. `pathOrUrl` is `https://github.com/OWNER/REPO/pull/N`; `baseBranch` (required) names the branch it merged into; `headBranch` (optional) names its head branch if that still exists.

A `merged-pr` patch is what actually landed: the merge commit's diff against its first parent, which is right for merge, squash and single-commit rebase merges. `bench prepare` refuses a PR that is not merged, whose base branch differs from `baseBranch`, or whose landed diff differs from the reviewed base...head diff (checked when the base has not moved since the PR's base SHA). A multi-commit PR whose single-parent merge commit sits on a moved base is refused, because a squash cannot be told from a multi-commit rebase merge. The lock records the PR number, merge commit SHA, first parent, base ref and SHA, and head ref and SHA. Patches apply in config order, and for merged PRs each must have landed on top of the previous one; list them in the order they merged.

**Measuring one agent PR on top of the ones merged before it (`inBaseline`).** Set `"inBaseline": true` on a patch to make it part of the baseline: it is applied to both the baseline and the patched trees, so "before" is upstream plus the flagged patches and "after" adds the unflagged ones. List every `inBaseline` patch before every other patch (`bench prepare` and `bench inspect` refuse otherwise). For lever *k* of a stack, flag levers 1 to k-1 and leave lever k unflagged. Without any flag the baseline is bare upstream, as before. The lock and prepared record carry the flag, and `BENCH-OVERRIDES.md` gets an "In baseline" column. Such a baseline is upstream + merged agent PRs, not upstream's own CI, so the report and showcase do **not** claim "Same CI as upstream" for it (the checklist box stays unchecked and says why), and that comparison no longer blocks the speedup claim; the other claim requirements are unchanged.

**Branch layout.** Agent PRs merge into a dedicated base branch (its name comes from `baseBranch`; there is no built-in name). It must not be the default branch (the page), the control branch or the replay branch: the controller force-pushes and restores those, and would erase the fix. The controller never installs, resets, restores, publishes to or deletes a branch named as a merged-PR `baseBranch` or `headBranch`. `bench inspect`/`prepare` report a blocker if one of those branches is also a branch the controller writes (replay, default, control, a PR scenario's base and `bench/pr/*/head`), and `bench run` refuses to start; every ref write is also refused at the point of the write.

## Commit identity

Every commit the harness makes (showcase publish, workflow placeholder registration, the controller lease, and the replay base, head and merge commits) is authored and committed by one identity, so GitHub shows a real author. The harness picks it in this order: `execution.commitIdentity` (`{"name": "...", "email": "..."}`) in `benchmark.config.json`; then `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` (or `GIT_COMMITTER_*`); then `user.name`/`user.email` from git config; and only then the built-in `StarSling Bench <bench@starsling.dev>`, with a warning, because no GitHub account owns that address. Replay commits change hash when the identity changes, so re-run `bench prepare` after changing it.

## Evidence and claims

Execution completeness, upstream parity, evidence level and claim eligibility are separate. A claim needs every requested round complete, the same CI as upstream, verified test, coverage and cache evidence for every sample, and at least five rounds; otherwise the showcase labels its numbers as diagnostic and lists what is missing. GitHub timestamps have one-second resolution.

- **Test and coverage evidence.** `bench evidence` downloads every sample's job logs, extracts each Actions cache restore and save, and runs a project extractor (`collectors/<project>.ts`, default export `EvidenceExtractor`) that turns the logs into test verdicts, semantic obligations and coverage. `bench verify` then binds them to the samples and compares each self-improving CI sample with the unchanged CI on the same runners. Coverage can be LCOV, Istanbul, or check coverage (`units`) for suites without instrumentation, such as type-check-only CI. Without coverage, claims stay at test-verdict or timing level and never assert the 0.1 pp requirement. `collectors/definitelytyped.ts` is a worked example.
- **Cache state.** Cold deletes every benchmark-owned Actions cache before a sample. Warm deletes them, replays the previous upstream push as a seed run on the same runner configuration (`seed-parent`, so build caches hold what that push left, as in real CI), then measures; seed cost is reported separately, and a failed seed is retried after its remaining runs are cancelled. A seed can be a `workflow_dispatch` scenario (`role: "seed"`, `dispatch.workflows`) that runs upstream's own scheduled cache producers on the default branch. Stores the harness cannot reset or observe block controlled claims.
- **Hardware vs self-improving CI.** The self-improving CI speedup is measured on the same runners, apart from the hardware speedup; the total speedup is their product. Agent PRs that add parallel jobs are not cost neutral until an unsharded control shows it.
- **Interference.** A sample that any other workflow run overlapped (a scheduled cron, a Dependabot run) is excluded from the medians, in the README and the Actions summary alike. Dependabot runs the controller cancels just before the event do not count.
- **Queue time.** Interference only sees other workflow runs in the benchmark repository, so it cannot see a job waiting for a machine on a shared runner pool (a capped GitHub larger-runner label, or StarSling capacity used by other benchmarks). Every job's queue time (`started_at` minus `created_at`, dependency wait excluded) is checked: if any exceeds `execution.maxJobQueueSeconds` (default 30), the sample is incomplete with the reason `queued <n> s for a runner (label <label>)` and needs a replacement sample, like a re-run. Each sample records its longest queue (`metrics.maxJobQueueSeconds`, `metrics.maxJobQueueLabel`); the report lists the reason and the showcase sample table shows `replaced (queued ...)`.
- **Failed or voided samples are replaced.** When a sample's workflow fails, or the sample is voided on queue time, it stays in the record as incomplete with its reasons (excluded from every median) and the controller dispatches one replacement for the same slot (same scenario, profile, variant and repetition; id `<sample>-retry<n>`; a warm replacement gets its own seed) and carries on. Each setup (variant and profile) may use `execution.maxReplacementsPerSetup` replacements (default 3); past that the experiment stops with `Incomplete sample ...`. Errors in the controller itself (GitHub API or git failures, staging integrity) and samples that never finish still stop the experiment. The report and showcase list the failed samples per configuration, and `bench verify` accepts a record when every slot has one complete sample.

The controller replays push and PR `synchronize` events, and dispatches `workflow_dispatch` seeds. With `replayHistory: "upstream"` replays carry upstream's full history and its tags at or before the pin (`mirrorTags`, on by default; `false` opts out), so full-history checkouts and `git describe` behave as upstream's do; otherwise they carry a two-commit history. Jobs on pinned runners StarSling does not offer stay on GitHub-hosted runners. [Native adapters](docs/ADAPTERS.md) covers credentials, the repository lease, recovery and evidence provenance. [Validation](docs/VALIDATION.md) records the native pilot runs. [The plan](docs/PLAN.md) tracks remaining work.

## Running many benchmarks in parallel on one account

Every controller on a machine uses the same GitHub login, and that login has one allowance of 5,000 REST calls per hour for all of them (and for any other tool or agent using it). A controller that polls freely can spend thousands of calls an hour; fourteen of them would stall each other on the limit. Each controller therefore counts its calls, paces itself to a budget, and stands down early when the account runs low.

**What a controller spends.** Measured from a finished run's raw API records (10 samples over 63 minutes, 868 recorded calls): about 87 calls per sample and 820 per hour, before the changes below. The biggest callers were run listings (25%), job listings (24%), artifact listings (24%), the five per-status listings of the managed-run cancellation (13%, every 5 s), workflow listings (8%), and cache listings and deletes (3%). Job logs, downloaded by `bench evidence`, were not in that record, so real usage was higher. Now a controller:

- polls a queued or running sample every `pollIntervalSeconds` (15 s), then 30, 60 and 120 s while nothing changes, and returns to 15 s when a run or job changes state;
- asks GitHub whether a listing changed (conditional requests with the stored ETag). A `304 Not Modified` answer is free: it is counted separately and does not use the allowance, so an unchanged run, job or artifact list costs nothing;
- cancels GitHub-managed runs by polling every 15 s (it was 5 s), and waits for workflow state changes in 6 reads over 60 s (it was 12);
- counts every call (`calls`, free `notModified`, and a breakdown by kind) per sample and per experiment, in `experiment.json` under `apiUsage` and in the report's "GitHub API calls" section;
- keeps to `execution.apiBudgetPerHour` (default 300) by lengthening its waits: after each wait it checks how many calls the last cycle spent and waits long enough that repeating the cycle stays within the budget. It never skips a check or a read; it only waits longer, and logs `[api-budget] ...` when it does;
- reads GitHub's `x-ratelimit-remaining` and `x-ratelimit-reset` from every answer. That figure is for the whole account, so when under 15% is left, every controller on it waits for the reset (logged as `account rate limit low`) before its next call.

**Expected after.** About 40 charged calls per sample for a short pipeline (modeled from the record above: polling reads mostly return 304, the rest is workflow and cache setup), and roughly 100 to 300 calls an hour per controller, depending on how often samples start and how many jobs they have. These figures are modeled, not yet measured on a live run: compare `apiUsage` in your first experiment against them.

**Sizing `apiBudgetPerHour`.** Keep `controllers x budget` below the account limit with headroom for log downloads, `init`, recovery and anything else using the login: `budget = (5,000 x 0.7) / controllers`. For 14 controllers that is 250 (3,500 of 5,000, leaving 1,500). The default of 300 suits up to 11 controllers. A lower budget makes samples slower, never wrong, because only the waits between observations grow; GitHub timestamps, not poll times, decide every measurement. If the budget is too low for the pipeline, the log shows long `stretching` lines: raise it only if the total still fits.

## Developing the harness

A benchmark repository is a one-time copy of this template, so harness fixes reach it only by syncing: `scripts/sync-template.sh [ref]` (in the benchmark repository, on `bench/control`, between experiments) replaces the paths the template owns and leaves the repository's config, showcase, patches, references, collector and experiment records alone. Then run `pnpm install --frozen-lockfile`, the checks, and `pnpm bench prepare` (a harness change invalidates prepared payloads).

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # build regenerates dist/ for the action
```

`examples/native-fixture` is a tiny workload for testing the controller end to end without an OSS project. [`docs/SHOWCASE-EXAMPLE.md`](docs/SHOWCASE-EXAMPLE.md) is the README showcase `src/showcase.ts` renders for a qualified experiment, from fixture data; a test fails when the rendering changes, so `pnpm test -u` regenerates it and the PR shows the new page as a diff.
