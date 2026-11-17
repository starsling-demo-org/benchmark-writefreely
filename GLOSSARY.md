# StarSling CI benchmark

How much sooner a public project's CI finishes, and how much compute it uses, on GitHub-hosted runners versus StarSling Runners, with and without StarSling's agent PRs.

## Measurements

**PR CI duration**:
Elapsed time from the first workflow starting to the last job finishing, across every workflow one PR update starts, including `workflow_run` follow-ups. Waiting for a runner after the first workflow starts counts; the time before it does not.
_Avoid_: PR wall clock, whole wait, time to green, latency

**Merge CI duration**:
The same, for every workflow one merge to the default branch starts.
_Avoid_: main wall clock, main CI time

**CI minutes**:
The sum of every job's runtime for one event. Skipped jobs add nothing; jobs kept on GitHub-hosted runners still count.
_Avoid_: repo minutes, runner minutes, billable minutes, build minutes

**Speedup**:
A ratio against GitHub-hosted runners for the same event: "× faster" for a CI duration, "× fewer" for CI minutes.
_Avoid_: improvement, gain, percent faster

**Hardware speedup**:
The speedup of StarSling Runners over GitHub-hosted runners, both running the project's CI unchanged.

**Self-improving CI speedup**:
The speedup of self-improving CI over the unchanged CI, both on StarSling Runners.

**Total speedup**:
StarSling Runners with self-improving CI against GitHub-hosted runners; the product of the hardware and self-improving CI speedups.

## Runner configurations

**Runner configuration**:
One combination of runners and CI that replays an event: GitHub-hosted runners, StarSling Runners (hardware only), StarSling Runners (self-improving CI), or GitHub-hosted runners with self-improving CI.
_Avoid_: arm, lane, variant (in prose)

**GitHub-hosted runners**:
The comparison's baseline machines: an explicit, pinned GitHub label (OS version and size, normally a larger runner the size of upstream's public runner), never a `-latest` alias and never a size that depends on the repository's visibility.
_Avoid_: standard runners, ubuntu-latest

**Matrix runner**:
A job whose `runs-on` is `${{ matrix.<key> }}` over a literal list (or literal `include` entries). Each value is mapped like a plain label, per configuration; the job's matrix shape stays. Values from `fromJSON`, outputs or variables are refused.

**Hardware only**:
StarSling Runners running the project's CI unchanged.
_Avoid_: StarSling baseline

**Self-improving CI**:
The project's CI with StarSling's agent PRs applied.
_Avoid_: patched CI, fix, optimizations, patch codes such as "c14"

**Agent PR**:
A pull request from StarSling's agent that changes how the project's CI runs: code, configuration, dependencies or workflows.
_Avoid_: patch, optimization

**Merged agent PR**:
An agent PR that was opened in the benchmark repository, ran CI there, and was merged by a human into a dedicated base branch. The harness measures exactly what landed (the merge commit against its first parent) and never writes that base branch. See "Patch sources" in the README.
_Avoid_: patch file

**Stacked baseline**:
A baseline that is upstream plus the agent PRs already merged (patches flagged `inBaseline`), so one agent PR is measured on top of the ones before it. It is not upstream's own CI, so "Same CI as upstream" is not claimed for it. See "Patch sources" in the README.
_Avoid_: patched baseline

## Events and replays

**Upstream**:
The public project whose CI is being measured.

**Event**:
One real upstream PR update or merge to the default branch, pinned to exact commits, whose CI is replayed.
_Avoid_: scenario (in prose), workload

**Replay**:
Pushing an event's exact tree to the benchmark repository and firing the same GitHub event, so the project's own workflows, jobs and steps run with their own triggers, conditions and order.
_Avoid_: simulation, re-run

**Commit identity**:
The one name and email that author and commit everything the harness commits. It comes from `execution.commitIdentity`, else the git environment variables, else git config, else a built-in with a warning.
_Avoid_: bot identity, bench user

**Placeholder registration**:
Committing an inactive stub of a new workflow file to the default branch so GitHub knows the workflow path before a replay. It commits only when the default branch lacks that file or holds different content; an identical placeholder is left alone, so the benchmark branch gets no repeated "Register" commit per sample. The workflow is disabled either way.
_Avoid_: stub commit

**Upstream run**:
The upstream project's own workflow runs for an event's commit, used as the reference for the replay.
_Avoid_: reference build, baseline run

**Sample**:
One replay of one event on one runner configuration, with one cache state.

**API budget**:
The number of GitHub API calls one controller may spend per hour (`execution.apiBudgetPerHour`, default 300). Many controllers share one account's 5,000 calls an hour, so each paces itself to its budget by waiting longer between looks, never by skipping a check. Calls are counted per sample and per experiment.
_Avoid_: quota, rate limit (that is GitHub's own account-wide limit)

**Round**:
One sample of every runner configuration for the same event and cache state. Medians use only complete rounds.
_Avoid_: paired repetition, rep, iteration

**Cold cache**:
A sample that starts with no GitHub Actions caches. This includes Docker's `type=gha` build cache, which is stored as Actions cache entries. It is verified cold when no Docker build in its logs reused an imported cache (an import with `CACHED` steps).

**Warm cache**:
A sample that starts from caches a seed run produced on the same runner configuration. For a Docker build using the `type=gha` cache it is verified warm only when the build log shows the cache import and at least one `CACHED` step. A Docker layer cache that lives on the runner itself (a persistent machine's local cache) is not Actions-managed and is not observed.

**Seed run**:
A replay that only produces caches for the next warm sample; its time is not counted.

## Evidence and claims

**Claim**:
A published statement about a speedup or CI minutes saved, made only when every item of the claim checklist holds.
_Avoid_: result, headline (for unqualified numbers)

**Same CI as upstream**:
A replay runs the same workflows and jobs as the upstream run for that event, with the same conclusions.
_Avoid_: upstream parity (in prose)

**Check coverage**:
The share of the checks the project's own test selection requires (packages, type checks, linters) that ran and passed. Used where CI has no line coverage.

**Cost neutral**:
Self-improving CI saves CI minutes without adding parallel jobs that spend them again. Hardware speedups never establish it, because they change the runners.

**Interference**:
Any workflow run outside the benchmark that overlapped a sample and could have competed for runners; such samples are excluded.

**Queue void**:
A sample in which any job waited longer than `execution.maxJobQueueSeconds` (default 30 s) for a runner, so queue time would sit inside the measured wait. Such a sample is incomplete and replaced, not published. Interference cannot catch it, because the competing load is outside the benchmark repository.

## Harness

**Scenario**:
The harness's record of one event and its complete workflow cascade.

**Variant**:
The harness's name for a runner configuration.

**Profile**:
The harness's name for a cache state (cold or warm) and how it is produced.

**Experiment**:
The requested set of samples (events, runner configurations, cache states and rounds) and their recorded results.

**Showcase**:
The README, agent PRs and results the benchmark repository's default branch holds between experiments.
