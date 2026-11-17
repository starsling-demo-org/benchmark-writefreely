# writefreely CI: GitHub-hosted runners vs StarSling Runners (with agents)

_Not affiliated with [writefreely/writefreely](https://github.com/writefreely/writefreely) (5.3k stars)._

writefreely's own CI workflows, replayed for a real upstream merge to its default branch on GitHub-hosted runners and on StarSling Runners (with agents). Every number comes from this repository's replays; upstream's own runs are linked for comparison.

StarSling Runners (with agents) = StarSling runners + StarSling agent PRs.

## Results

Every sample starts with no GitHub Actions caches.

| Runner configuration | Merge CI duration<br><sub>Merge to the default branch</sub> | Runner time<br><sub>Merge to the default branch</sub> |
|---|---:|---:|
| **GitHub-hosted runners** | 15.97 min | 15.90 min |
| **StarSling Runners (with agents)** | 1.62 min<br>**9.9× faster** | 1.47 min<br>**10.8× less** |

- On StarSling Runners (with agents), every check for a merge to the default branch finished in **1.62 min** instead of 15.97 min (**9.9× faster**), using 1.47 min instead of 15.90 min of runner time (**10.8× less**).
- **PR updates:** not measured. Upstream's only workflow, `docker-publish.yml`, runs on merges to the default branch and to `main`, and on release tags, never on pull requests, so a PR update starts no CI to compare.
- **Context, not the headline** (upstream's own runs; not like-for-like with the numbers above): What upstream sees today: a median 21.1 min per merge to the default branch on upstream's own GitHub runners (n=13, most recent comparable merges to the default branch within the last 60 days; warm Docker layer caches likely, many commits; standard runners; includes registry push; not a like-for-like replay).

<sub>Medians over complete rounds.</sub>

## Runners

| Runners | Label | vCPU | Memory |
|---|---|---:|---:|
| GitHub-hosted | `ubuntu-24.04-4core` | 4 | 16 GiB |
| StarSling | `starsling-ubuntu-24.04` | 4 | 16 GiB |

Runner time compared at these machine sizes: GitHub 4 vCPU vs StarSling 4 vCPU. StarSling's 4 vCPU runners can burst to 5 vCPU and 32 GB RAM (Afterburner); GitHub's 4-core runners have 16 GB.

GitHub-hosted jobs run on the explicit GitHub larger-runner label shown, pinned to the size of upstream's public-repository runner, so the comparison does not change with this repository's visibility.

## Claim checklist

- [x] **Same CI as upstream:** replays run the same workflows and jobs as upstream's own runs, with the same conclusions
- [x] **Same checks, same results:** every sample's test verdicts were read from its own job logs and match the unchanged CI
- [x] **Cache state verified** for every sample
- [x] **Both runner configurations measured** (2 of 2)
- [x] **All requested samples finished** (10 of 10)
- [x] **At least 5 rounds** (5 requested)
- [x] **No interference:** no other workflow run overlapped a sample
- [x] **Cost neutral:** the agent PRs add no parallel jobs that spend the freed runner time

### Same CI as upstream

- **Merge to the default branch:** same workflow and 1 job as upstream's own run for the same commit ([#36467521733](https://github.com/writefreely/writefreely/actions/runs/36467521733)), same conclusions. The only step difference, identical in every configuration, is the registry login, which is not run here because nothing is published.

### Same checks, same results

Every counted sample's test verdicts, coverage and cache restores were read from its own job logs and match the unchanged CI.

## Terms

| Term | Meaning |
|---|---|
| **PR CI duration** | Elapsed time from the first workflow starting to the last job finishing, across every workflow one PR update starts (including `workflow_run` follow-ups). |
| **Merge CI duration** | The same, for every workflow one merge to the default branch starts. |
| **Runner time** | Total machine time all jobs used for one event, summed across jobs; billed per second. Jobs kept on GitHub-hosted runners still count. |
| **StarSling Runners (with agents)** | StarSling runners plus StarSling agent PRs: the project's CI with StarSling's agent PRs applied, running on StarSling runners. "StarSling" on this page always means this one configuration. |
| **Round** | One replay of the event on every runner configuration. Medians use only complete rounds. |
| **Cost neutral** | The agent PRs save runner time without adding parallel jobs that spend it again. |

## Appendix

<details>
<summary>Agent PRs</summary>

Merged in this order. Each fix's own measurement, on the CI step it changes, is under What we changed.

| # | Agent PR | What it changed |
|---:|---|---|
| 1 | [pull/1](https://github.com/starsling-demo-org/benchmark-writefreely/pull/1) | Cross-compile the arm64 build with the xx helper instead of running the Go and SQLite compile under CPU emulation. One file, the Dockerfile; the build checks that the arm64 binary is static and for the right CPU. |
| 2 | [pull/2](https://github.com/starsling-demo-org/benchmark-writefreely/pull/2) | Build the UI assets (CSS and editor JavaScript) once in a shared stage instead of once per platform. One file, the Dockerfile; the per-platform stage copies in the finished static files. |

</details>

<details>
<summary>What was slow</summary>

Every merge to the default branch builds the WriteFreely Docker image for two CPU types, amd64 and arm64, on a fresh runner. The arm64 build ran under a CPU emulator, so the whole Go and SQLite compile ran at emulation speed, and that build was by far the slowest part of the merge's CI. The emulated arm64 build is also the step that most often breaks upstream: 19 of the last 123 upstream runs (merges to the default branch or to `main`, and release tags) failed in the image build step (15%), including crashes of the emulated compiler ("Illegal instruction", for example [run 32290209731](https://github.com/writefreely/writefreely/actions/runs/32290209731)). Fix A removes that emulated step.

</details>

<details>
<summary>What we changed</summary>

The original showcase for this project proposed four fixes. We re-measured each one on its own, one at a time, on StarSling, with 5 runs on each side (the CI as it was, and the CI with the fix). Cold means no caches at the start; warm means starting from caches a seed run left behind.

| Fix | Result | Decision |
|---|---|---|
| A. Cross-compile the arm64 build instead of emulating it | Cold: 525 s to 102 s, **5.15x faster** | Kept (agent PR 1) |
| B. Build the UI assets once and share them (measured on top of A) | Cold: 102 s to 93 s, **1.10x faster**; every run with the fix beat every run without it | Kept (agent PR 2) |
| C. Install dependencies in their own layers (measured on top of A and B) | Cold median: 126 s to 91 s, but the ranges overlap (3 of the 5 runs without the fix took as long as the runs with it). Warm: no difference | Dropped |
| D. Save and restore Docker layers in the GitHub Actions cache (`type=gha`) | **Slower.** Cold: 94 s to 196 s (0.48x). Warm: 100 s to 184 s (0.54x) | Dropped |

The original showcase's cache levers (C and D) did not reproduce as wins on this base. D made the build slower, and C's gain was not distinguishable from run-to-run noise. Only A and B ship as agent PRs.

The agent PRs are in the table above. The full benchmark that follows compares GitHub-hosted runners running the plain upstream CI with StarSling Runners (with agents), A and B applied, over 5 rounds. Neither kept fix uses a cache, so the full benchmark runs cold only: warm rounds would repeat the cold numbers.

- [Cross-compile the arm64 build with the xx helper instead of running the Go and SQLite compile under CPU emulation. One file, the Dockerfile; the build checks that the arm64 binary is static and for the right CPU.](https://github.com/starsling-demo-org/benchmark-writefreely/pull/1)
- [Build the UI assets (CSS and editor JavaScript) once in a shared stage instead of once per platform. One file, the Dockerfile; the per-platform stage copies in the finished static files.](https://github.com/starsling-demo-org/benchmark-writefreely/pull/2)

</details>

<details>
<summary>Every sample, with links to its runs</summary>

Each cell is the whole wait for that merge and links to its run.

| Upstream commit | Round | GitHub-hosted runners | StarSling Runners (with agents) |
|---|---:|---:|---:|
| [`5d1bc057`](https://github.com/writefreely/writefreely/commit/5d1bc057e86aafb6888bf301376b46ea5e0620e7) | 1 | [15.65 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43750444955) | [1.63 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43753131964) |
| [`5d1bc057`](https://github.com/writefreely/writefreely/commit/5d1bc057e86aafb6888bf301376b46ea5e0620e7) | 2 | [16.48 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43754442708) | [1.58 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43756247624) |
| [`5d1bc057`](https://github.com/writefreely/writefreely/commit/5d1bc057e86aafb6888bf301376b46ea5e0620e7) | 3 | [21.05 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43756544348) | [1.58 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43759784598) |
| [`5d1bc057`](https://github.com/writefreely/writefreely/commit/5d1bc057e86aafb6888bf301376b46ea5e0620e7) | 4 | [15.97 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43760343203) | [1.62 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43760064426) |
| [`5d1bc057`](https://github.com/writefreely/writefreely/commit/5d1bc057e86aafb6888bf301376b46ea5e0620e7) | 5 | [14.05 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43763018010) | [1.62 min](https://github.com/starsling-demo-org/benchmark-writefreely/actions/runs/43765445581) |

</details>

<details>
<summary>Method</summary>

1. **Pin.** writefreely/writefreely is pinned at [`5d1bc057`](https://github.com/writefreely/writefreely/commit/5d1bc057e86aafb6888bf301376b46ea5e0620e7), the [`upstream/`](upstream) submodule in this repository. Each scenario replays one real upstream event: the merge of [`5d1bc057`](https://github.com/writefreely/writefreely/commit/5d1bc057e86aafb6888bf301376b46ea5e0620e7) to the default branch.
2. **Replay natively.** Each sample lands that exact tree on this repository as a merge to the default branch and fires the real GitHub event (a merge to the default branch, or a PR update). Every workflow, job and step runs with its own triggers, filters, `needs`, conditions, matrices and `workflow_run` follow-ups, in the order GitHub schedules them.
3. **Runner configurations.** GitHub-hosted runners run the CI unchanged; StarSling Runners (with agents) run it with the 2 agent PRs applied. Jobs on runners StarSling does not offer stay on GitHub-hosted runners in every configuration and still count.
4. **Rounds.** 5 rounds; in each, every runner configuration replays the event once, in a deterministic shuffled order, one sample at a time. Medians use only complete rounds, and a sample counts only if every expected job succeeded on the first attempt.
5. **Control caches.** Cold cache: every sample starts with no GitHub Actions caches.
6. **Check.** Replays are compared job by job with upstream's own runs for the same commit, and every sample's test verdicts, coverage and cache restores are read from its own job logs.

- **Control configuration.** Each round also replayed the event on StarSling runners with the CI unchanged, as an internal control. It is not part of this comparison, and its samples are not shown in the tables on this page; they are in the data files under `benchmark/`.
- **Default branch.** Upstream's default branch is `develop`.
- The fixes were measured one at a time from patch files before the agent PRs were opened; the full benchmark ran after both PRs merged. Outside the bench-only CI setup, the measured trees are exact: the unchanged CI equals upstream `5d1bc057` (git tree `ef89d9cf`), and the CI with agent PRs equals the merged agent PRs (git tree `e5d36ffa`). Tree comparison: [experiments/p5c/TREES.md](https://github.com/starsling-demo-org/benchmark-writefreely/blob/bench/control/experiments/p5c/TREES.md).
- **Runner sizes.** GitHub `ubuntu-24.04-4core` (4 vCPU, 16 GiB) and StarSling `starsling-ubuntu-24.04` (4 vCPU, 16 GiB). StarSling's 4 vCPU runners can burst to 5 vCPU and 32 GB RAM (Afterburner); GitHub's 4-core runners have 16 GB.
- **Upstream reference (context only; not like-for-like; not the headline).** What upstream sees today: a median 21.1 min per merge to the default branch on upstream's own GitHub runners (n=13, most recent comparable merges to the default branch within the last 60 days; warm Docker layer caches likely, many commits; standard runners; includes registry push; not a like-for-like replay).
- **Failed or re-run samples** (replaced, not in the medians): GitHub-hosted runners: 0; StarSling Runners (with agents): 0.

</details>

<sub>Generated by `bench showcase` from experiment `p5c`. Machine-readable results: [`benchmark/results.json`](benchmark/results.json).</sub>
