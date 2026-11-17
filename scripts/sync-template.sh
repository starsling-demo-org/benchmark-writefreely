#!/usr/bin/env bash
# Update this benchmark repository's harness from the template. A benchmark repository is a one-time copy of the
# template, so fixes reach it only this way. Run on bench/control with a clean worktree and no experiment running:
# a harness change invalidates prepared payloads (run `pnpm bench prepare` afterwards), so an experiment started
# with the old harness cannot resume. Experiment records, config, showcase.json, patches/, reference/ and
# collectors/<project>.ts are this repository's own and are never touched.
#
#   scripts/sync-template.sh [template-ref]      (default: main)
set -euo pipefail
ref="${1:-main}"
template="${BENCH_TEMPLATE_URL:-https://github.com/OWNER/benchmark-template.git}"
# The paths the template owns. Keep in sync with the template's tree when adding top-level files.
owned=(.claude .gitattributes .github .gitignore GLOSSARY.md README.md action.yml biome.jsonc
  collectors/definitelytyped.ts dist docs examples package.json pnpm-lock.yaml scripts skills src tests
  tsconfig.json tsdown.config.ts)
if [ -n "$(git status --porcelain)" ]; then echo "Commit or stash local changes first." >&2; exit 1; fi
git fetch --quiet --no-tags "$template" "$ref"
git archive FETCH_HEAD -- "${owned[@]}" | tar -x
git status --short
echo "Synced from $template@$(git rev-parse --short FETCH_HEAD). Next: pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm bench prepare, then commit."
