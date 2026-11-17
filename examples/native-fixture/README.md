# Native acceptance fixture

This intentionally tiny workload executes four assertions, saves an Actions cache, uploads the actual verdicts and cache-hit observation, and triggers a second workflow via `workflow_run`. It exercises orchestration; it is not performance evidence for an OSS project.

From the template checkout:

```sh
node scripts/create-fixture.ts --source /tmp/bench-fixture-source \
  --config /tmp/bench-fixture.json --repository OWNER/DEDICATED_REPLAY
# Optionally pass --runner with an installed StarSling runner label.
node src/cli.ts prepare --config /tmp/bench-fixture.json \
  --repo /tmp/bench-fixture-source --work-dir /tmp/bench-fixture-prepared
node src/cli.ts run --config /tmp/bench-fixture.json \
  --prepared /tmp/bench-fixture-prepared/prepared.json \
  --experiment fixture-main --out /tmp/fixture-main \
  --scenarios main-push --profiles cold --variants github-baseline
```

Initialize the dedicated replay's default `main` branch before running. The template itself is sufficient initial content. Keep tooling on `bench/control` or in the local controller checkout. The fixture script refuses to overwrite an existing source/configuration.

Run `pr-synchronize` separately to test PR behavior, then `warm` to test seeding. Download `fixture-evidence` from both root seed and consumer runs: seed `cache.json` should show a miss and consumer should show `"hit":"true"`. A successful workflow alone does not establish warm-cache validity. The runtime retains seed costs separately.

To test patches, create a Git diff against the fixture, save it outside the clean source, and add a local patch entry to the configuration. Reprepare into a new directory and select all four variants. The fixture has no coverage instrumentation: it must never produce a coverage-qualified claim.

For a completed main experiment, exercise the evidence/report path:

```sh
node scripts/collect-fixture-evidence.ts --experiment /tmp/fixture-main/experiment.json \
  --prepared /tmp/bench-fixture-prepared/prepared.json --out /tmp/fixture-evidence
node src/cli.ts verify --config /tmp/bench-fixture.json \
  --prepared /tmp/bench-fixture-prepared/prepared.json \
  --input /tmp/fixture-main/experiment.json --evidence /tmp/fixture-evidence/evidence.json \
  --out /tmp/fixture-assessed.json
node src/cli.ts report --config /tmp/bench-fixture.json \
  --input /tmp/fixture-assessed.json --out /tmp/fixture-report
```

The sample collector supports this fixture's main workflow only. A single-variant run can verify evidence but cannot establish a four-way comparative headline.
