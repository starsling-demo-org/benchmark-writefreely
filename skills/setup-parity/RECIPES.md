# Parity recipes

Reach for the entry matching the `bench init`/`inspect` field, `bench parity` difference, or `incompleteReasons` text. Every fix is a config edit followed by `bench prepare`; generated workflows are never edited by hand.

Adaptations are scoped string replacements inside a workflow's YAML values (and optionally one job's). A pattern matches text within a value, never a `key: value` line, so `push: ${{ ... }}` finds nothing; match the value itself:

```json
{
  "id": "no-image-push",
  "kind": "deployment-guard",
  "workflowFile": ".github/workflows/docker-publish.yml",
  "jobId": "build",
  "fromPattern": "${{ github.event_name != 'pull_request' }}",
  "toReplacement": "false",
  "expectedMatches": 1,
  "reason": "The benchmark must not publish images; the build itself still runs",
  "blocksFullParity": false
}
```

Rules apply in config order, so a later rule sees earlier replacements. Above, a second rule `github.event_name != 'pull_request'` -> `false` then matches only the login step's `if:`.

`expectedMatches` must equal the occurrences in scope or preparation fails; when the patch stack changes the count, set `expectedMatchesPatched` for the patched variants. For structural edits (for example, workflow `permissions`), use `"kind": "workflow-setting"` with `setPath` and `setValue`. Set `blocksFullParity: true` when the edit removes work upstream did (a skipped deployment, a stripped required secret); the report then withholds the full-parity claim.

## `sideEffects`: registry pushes, releases, deployments, uploads

The replay must not publish anything as the upstream project. Keep the work that costs time and disable only the outward action:

- Image builds: keep `docker/build-push-action`, turn its `push` value off (as above), and turn `docker/login-action`'s `if:` value to `false` when the login only serves the push.
- Releases, package publishes, Pages deploys: guard the step or job off with a `deployment-guard` adaptation; set `blocksFullParity: true` if it was a meaningful share of upstream's time.
- Coverage and analytics uploads (Codecov, Coveralls): they usually tolerate a missing token. Keep them if the job stays green; otherwise guard them and say so in `showcase.json` `notes`.

## Cache-dependent workflows

If upstream restores a cache that only a scheduled or manual workflow saves (a daily dependency cache, for example), upstream's real runs are warm. Add a seed scenario that dispatches those producers, and point the warm profile at it:

```json
"cache-seed": { "name": "cache-seed", "role": "seed", "event": "workflow_dispatch", "description": "...",
  "main": { ...same as main-push... }, "dispatch": { "workflows": [".github/workflows/cache.yml"] }, "referenceRuns": [] }
```

Measure both `cold` and `warm` whenever the patch changes what is cached or restored.

## `blockers`

- `missing_secret`: a secret upstream has and the replay does not; the covering adaptation's `fromPattern` must contain the secret's name. If the step only publishes or notifies, guard it (`secret-gate-annotation`). If the work needs it (private registry, API test), add an `external-dependency-stub` and set `blocksFullParity: true`; choose another scenario if the job is central.
- `repository_identity_guard`: `init` remaps `github.repository == 'owner/name'` and owner guards automatically. A remaining one uses another form (`contains(...)`, a `vars`/`env` comparison); add a `repository-identity-remap` for that exact text.
- `unreproduced_fork_semantics`: the replay PR comes from a branch in the same repository. If upstream's PR came from a fork, replace the fork expression with its upstream value, or pick a same-repository PR.
- `altered_deployment_behavior`: a job targets a protected environment. Treat as a side effect (above).
- `inaccessible_external_workflow`: a reusable workflow is referenced by `owner/name/.github/workflows/x.yml@ref`. Point it at the local path with an adaptation when the file exists in the tree.
- Event or activity types other than push and PR `synchronize`: choose a different scenario; the native controller replays only those two.

## `runnerLabels`

- GitHub target, every `mapped` label: `init` writes `"github": "TODO-github-larger-runner-for-<label>"`, and a `runnerSpecs` entry under the same name holding the size to match (upstream's public runner: `ubuntu-latest` is 4 vCPU / 16 GiB). Replace the target with the pinned larger-runner label of that size (provisioned for the organization), rename the `runnerSpecs` entry to the same label and keep its vCPU and RAM. `bench inspect` lists a `unpinned_github_runner` blocker per job until you do. A `-latest` target is always refused, and so is a standard hosted Linux or Windows label (`ubuntu-24.04`, `ubuntu-22.04`, `ubuntu-24.04-arm`, `windows-2022`, `windows-2025`, `windows-11-arm`): "size depends on repository visibility; use a larger-runner label" (4 vCPU public, 2 vCPU internal). So is a target with no GitHub `runnerSpecs` entry. There is no opt-out. macOS labels and `ubuntu-slim` are the same size in both and are accepted.
- `unmapped`: a GitHub-hosted label with no entry in `runnerMapping.defaultMap`; `inspect` and `prepare` refuse it by workflow and job. Add `"LABEL": { "github": "<pinned larger-runner label>", "starsling": "starsling-label" }` (or pass `--map LABEL=starsling-label` to the first `init`, then fill in the placeholder) when StarSling offers the same OS image and architecture. To keep the job on GitHub in every variant, add `jobOverrides["<workflow>#<job>"] = { "github": "LABEL", "starsling": "LABEL" }` with a pinned label.
- `expression` (`${{ matrix.os }}`, arrays, groups): refused by `inspect` and `prepare`, naming the job. Map each concrete job with `runnerMapping.jobOverrides["<workflow>#<job>"] = { "github": "...", "starsling": "..." }`; the override replaces `runs-on` in every instance of that job.
- `kept-on-github` (macOS, Windows, Arm): nothing to do while the label is a pinned macOS label (`macos-14`, `macos-15`); these jobs keep upstream's label on both sides and count toward every variant's totals. A `-latest` label (`macos-latest`) or a standard Windows or Arm label (`windows-2022`, `ubuntu-24.04-arm`) is refused: add a `jobOverrides` entry with a pinned label (a larger runner for Windows and Linux Arm). `init` and `inspect` classify labels with the same rules `prepare` uses, so an Arm label stays here even if you add it to `defaultMap`.
- Parity is unaffected by the GitHub label: `bench parity` compares workflows, jobs and conclusions, not runner labels.

## `bench parity` differences

- **Job ran upstream, missing in the replay**: read the job's `if:` and `needs`. Identity guards, fork checks, labels and `github.actor` conditions are the usual causes; `bench inspect` lists jobs left to native evaluation under `nativeConditions`. Path filters are evaluated against the scenario's `changedPaths`.
- **Job ran in the replay, not upstream**: usually a `!=` identity or fork condition that is true here, or a matrix row upstream excluded. Remap the condition to its upstream value.
- **Workflow ran upstream, missing in the replay**: a branch filter, a `workflow_run` listener (enable correlation with `"instrumentation": true`, which `init` sets when listeners exist), or a workflow GitHub-managed outside YAML (Dependabot) that is out of scope.
- **`unchecked`** lists events with a locked upstream run but no complete replay with the CI unchanged in this experiment. Run a diagnostic for that event with `--variants github-baseline`; an unchecked event never counts as green.
- **Conclusion differs**: open the replay run from the experiment record's `htmlUrl` and fix the cause (missing secret, network allowlist, rate limit). Upstream failures cannot be paritied; choose a scenario whose upstream run was green.

## `Unowned cache scope <ref>`

A cold reset deletes only caches on the default branch, the replay branch, `bench/*` and PR refs. Another ref's cache (a branch someone pushed, or a repository created from an older template whose CI cached pnpm on `main`) cannot be reset safely: delete it (`gh api -X DELETE repos/O/R/actions/caches/<id>`), and rerun the same `bench run`; it reuses the lease it already holds.

## `dispatch-needs-default-branch`, `workflow-run-needs-default-branch`

GitHub runs `workflow_dispatch` and `workflow_run` workflows only from the default branch. Remove `benchmarkRepository.replayBranch` so replays push to the default branch, and make upstream's branch name the repository's default (then the default branch shows upstream's tree while samples run). Seed a warm profile with a push scenario instead of a dispatch where you can.

## `incompleteReasons`

- `Missing expected workflow runs` right after dispatch: GitHub may not have registered a new workflow yet; `bench collect --experiment <id>` resumes observation without dispatching again.
- `Rerun requires a replacement sample`: a run had more than one attempt. Start a new experiment ID; reruns never count.
- `Incomplete sample ...; state remains leased`: the controller keeps the repository lease so nothing changes the evidence. Run `bench collect --experiment <id>` if runs are still in progress, otherwise `bench recover --experiment <id>`, which restores `main`, workflow states and the lease.
- `could not read Username` or `refusing to allow an OAuth App to create or update workflow`: the Git credentials cannot push workflow files. Run `gh auth refresh -h github.com -s workflow`, or set `BENCH_GIT_TRANSPORT=ssh` with an SSH key that does not wait for interactive approval.
- `Failed jobs` on a `<sample>-seed` attempt: the seed is retried as `<sample>-seed-r2` (up to three attempts). Before the retry, the controller cancels the failed attempt's remaining runs and waits until no other run is active, then marks its journal `superseded`; all attempts stay in the record and in seed cost.
- `Sample ... overlapped unrelated workflow runs` (in the report): a scheduled cron or a Dependabot run competed for runners. The sample is excluded; run the missing round again in a new experiment, timed away from upstream's crons.
- `Repository lease held by another controller`: another experiment or publish owns the repository. Wait for it, or `bench recover` the experiment named in the lease commit message.
