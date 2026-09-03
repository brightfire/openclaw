#!/usr/bin/env bash
# Regenerate canonical build artifacts from merged sources, then commit any
# drift. Generated files are build output, not source; patches must never
# hand-edit them. A clean-but-stale generated file on a patch branch would
# otherwise ship in the tarball. Regenerating here keeps the build
# deterministic regardless of what any patch branch contains. See SKILL.md
# "Patch Discipline" rule 6 in the openclaw-dev skill for the full policy.

set -euo pipefail

# Debug: capture node_modules state for diagnosing CI hangs
echo "=== Debug: node_modules state ==="
echo "node_modules packages: $(ls node_modules/.pnpm 2>/dev/null | wc -l)"
echo "pnpm version: $(pnpm -v)"
echo "tsx available: $(node -e 'try{require.resolve("tsx");console.log("yes")}catch{console.log("no")}')"
echo "verifyDepsBeforeRun: $(pnpm config get verify-deps-before-run 2>/dev/null || echo 'unknown')"

# All generators are independent (different inputs, non-overlapping outputs)
# so run them all in parallel and wait for every one before committing.
#
#   config:schema:gen         validates only; no file output
#   protocol:gen              -> dist/protocol.schema.json
#   protocol:gen:swift        -> apps/*/ Swift protocol files
#   config:docs:gen           -> config doc baseline hash
#   plugins:sync              -> propagates root package.json version to extensions/*/package.json
# (deps:shrinkwrap:generate and plugin-sdk:api:gen removed upstream after v2026.6.8)
#
echo "=== Running generators in parallel ==="
declare -a GEN_PIDS=()
declare -a GEN_NAMES=()

# deps:shrinkwrap:generate and plugin-sdk:api:gen were removed upstream in
# versions after v2026.6.8. Removed from this script on 2026-08-24.
pnpm config:schema:gen         & GEN_PIDS+=($!) GEN_NAMES+=("config:schema:gen")
pnpm protocol:gen              & GEN_PIDS+=($!) GEN_NAMES+=("protocol:gen")
pnpm protocol:gen:swift        & GEN_PIDS+=($!) GEN_NAMES+=("protocol:gen:swift")
pnpm config:docs:gen           & GEN_PIDS+=($!) GEN_NAMES+=("config:docs:gen")
pnpm plugins:sync              & GEN_PIDS+=($!) GEN_NAMES+=("plugins:sync")

# Wait for all — collect failures without short-circuiting so every PID is
# reaped and the error list is complete.
GEN_FAIL=0
for i in "${!GEN_PIDS[@]}"; do
  if ! wait "${GEN_PIDS[$i]}"; then
    echo "=== FAILED: ${GEN_NAMES[$i]} ===" >&2
    GEN_FAIL=1
  fi
done
if [ "$GEN_FAIL" -ne 0 ]; then
  echo "One or more generators failed." >&2
  exit 1
fi

echo "=== All generators complete ==="

git add -A
if ! git diff --cached --quiet; then
  git commit --no-verify -m "ci: regenerate build artifacts on stable"
  echo "Regenerated build artifacts committed."
else
  echo "No regenerated-artifact drift; nothing to commit."
fi
