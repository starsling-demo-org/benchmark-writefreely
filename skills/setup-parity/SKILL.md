---
name: setup-parity
description: Set up a StarSling benchmark repository for a public GitHub project and drive its replay to CI parity with upstream. Use when creating a benchmark repo from this template, resolving `bench init`/`bench inspect` blockers, fixing `bench parity` differences, adding optimization patches, or writing and publishing the README showcase.
---

# Set up a benchmark to parity

The `bench` CLI does every repeatable step deterministically and prints JSON with a `nextAction`. Your job is the judgment calls it hands back: which upstream events to replay, how to neutralize side effects, how to map runners, and what the showcase says. `pnpm bench --help` lists every command and flag; `README.md` explains the model.

**Parity** (same CI as upstream) means the replay of an event with the CI unchanged runs the same workflows and jobs as upstream's own run for that commit, with the same conclusions. [`GLOSSARY.md`](../../GLOSSARY.md) defines every term. `bench parity` is the observable: the loop is **green** when it returns `"ok": true`. Every adaptation you make serves parity; record its reason in the config.

## Steps

1. **Create the repository.** From this template, create `OWNER/<project>-ci-speedup` (public, so GitHub-hosted runners match upstream's public-repo hardware), clone it, and create `bench/control` from `main`. Keep `main` as the repository's default branch: it becomes the benchmark page. Replays push to a branch named like upstream's (`replayBranch`), which `init` sets. If upstream's default branch is also `main`, rename this repository's `main` to `benchmark` first. Give `gh` the `workflow` scope (`gh auth refresh -h github.com -s workflow`), because replays push workflow files. All commands below run on `bench/control`.
   Done when `git branch --show-current` prints `bench/control` and `pnpm install --frozen-lockfile` succeeds.

2. **Pick the events.** Choose a recent upstream commit on the default branch whose CI ran green, and optionally a recent open or merged PR whose CI ran green. Prefer events that exercise the slow path the patches target. GitHub deletes old runs, so an event without retained runs cannot be checked for parity.
   Done when you have a full 40-character SHA (and a PR number) whose upstream runs are visible in the Actions tab.

3. **Initialize.** Run `pnpm bench init --upstream O/N --sha SHA --bench-repo O/B [--pr N] [--map LABEL=starsling-label]`. Add `--history upstream` when any upstream workflow checks out full history (`fetch-depth: 0`, `git describe`, changelog tools): without it, those checkouts are almost free in the replay and the comparison understates upstream's CI. It locks events and upstream runs, fetches the pinned source to `.bench-work/upstream`, generates identity-guard remaps, and writes `benchmark.config.json`, `showcase.json`, `patches/` and `reference/`.
   Then run `pnpm bench publish`: before any experiment it puts a short benchmark page on the default branch, with upstream pinned as the `upstream/` submodule, so the repository never looks like a fork of upstream.
   Done when every entry in the output's `blockers`, `runnerLabels` (status `unmapped` or `expression`), `sideEffects` and `notes` has a decision. A side effect's `addressedBy` lists the adaptations scoped to its job; one without it is either kept on purpose or still open. Resolve each with [RECIPES.md](RECIPES.md); rerun `pnpm bench inspect` after config edits until `blockers` is empty.

4. **Prepare and run one diagnostic sample.** Run `pnpm bench prepare`, then `pnpm bench run --experiment diag-1 --variants github-baseline --profiles cold --repetitions 1 --scenarios <one scenario>` (without `--repetitions 1` it runs the configured five rounds). Repeat per scenario (new experiment ID each time).
   Done when the run output shows `"complete": true` for the sample. An incomplete sample lists `incompleteReasons` and keeps the repository lease: run `pnpm bench recover --experiment diag-1`, fix the cause (RECIPES.md), and use a new experiment ID.

5. **Close the parity loop.** Run `pnpm bench parity --experiment diag-1`. Each difference comes with a `nextActions` line. Change the config (adaptations, runner mapping, scenario choice), `bench prepare` again, run a fresh diagnostic, and repeat.
   Done when `bench parity` is green for every scenario. Step differences (`stepDifferences`) are informational: confirm each is explained by cache state, and note the explanation in `showcase.json` `notes` if a reader would ask.

6. **Add the agent PRs.** Add each agent PR as `patches/<id>.patch` (a `git diff` against the pinned source) or a `github-pr`/`github-commit` URL entry in `benchmark.config.json` `patches`, in the order they apply. If a PR changes what the CI caches or restores, add a warm-cache seed (RECIPES.md). Run `bench prepare`, then a diagnostic of `starsling-patched` (self-improving CI on StarSling Runners).
   Done when the sample is complete and every upstream test, check and output a PR dropped or merged is accounted for: same checks, same verdicts. PRs that add parallel jobs are recorded as such; the report withholds a cost-neutral claim for them automatically.

7. **Validate, then run the experiment.** First run one round of the three headline runner configurations: `pnpm bench run --experiment check-1 --repetitions 1 --variants github-baseline,starsling-baseline,starsling-patched`. It proves parity, evidence and cache seeding in about an hour. Then run `pnpm bench run --experiment <id>` with no selection flags (every event, cache state and runner configuration, five rounds). A large project takes many hours, so run the controller on AC power with the lid open (`caffeinate -dimsu`) or on an always-on machine: sleep stalls the experiment. If interrupted, rerun the same command, or use `bench collect`/`bench recover` as the error says.
   Done when the run returns `"ok": true`, then `pnpm bench evidence --experiment <id> --extractor collectors/<project>.ts` and `pnpm bench verify --experiment <id> --evidence experiments/<id>/evidence/evidence.json` succeed. Write the extractor from an existing one in `collectors/`; without verified evidence, claims stay at the timing-only evidence level.

8. **Write the narrative.** The README is about impact, so the narrative is short. Fill `showcase.json`: `experiment` (the headline experiment ID), `same` (how the self-improving CI was shown to run the same checks with the same results, citing the evidence), `notes` (method facts a reader would ask about, such as repository visibility or adaptations) and `agentPullRequests` (links to the agent PRs the patches come from). Write facts the data supports: short, concrete, no superlatives.
   Done when `pnpm bench showcase` writes `experiments/<id>/README.md` and every sentence in it is backed by a number or file in the experiment.

9. **Publish.** Commit `benchmark.config.json`, `showcase.json`, `patches/`, `reference/` and `experiments/<id>/` to `bench/control` and push. The `Benchmark report` workflow summarizes the experiment in the Actions UI and publishes the showcase to the default branch; `pnpm bench publish` does the same locally. To review the README first, put `experiments/<id>/README.md` on a branch and open a PR against the default branch.
   Done when the repository's front page shows the showcase and its banner states exactly which claims are qualified.
