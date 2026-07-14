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

echo "=== Running deps:shrinkwrap:generate ==="
pnpm --verbose deps:shrinkwrap:generate

# Use documented pnpm commands (not raw node calls) so the script stays
# correct even if upstream refactors the underlying generator scripts.
# See docs/.generated/README.md and docs/gateway/protocol.md.
echo "=== Running config:schema:gen ==="
pnpm --verbose config:schema:gen
echo "=== Running protocol:gen ==="
pnpm --verbose protocol:gen
echo "=== Running protocol:gen:swift ==="
pnpm --verbose protocol:gen:swift
echo "=== Running config:docs:gen ==="
pnpm --verbose config:docs:gen
echo "=== Running plugin-sdk:api:gen ==="
pnpm --verbose plugin-sdk:api:gen
echo "=== Syncing plugin versions to match root package.json ==="
pnpm --verbose plugins:sync
echo "=== All generators complete ==="

git add -A
if ! git diff --cached --quiet; then
  git commit --no-verify -m "ci: regenerate build artifacts on stable"
  echo "Regenerated build artifacts committed."
else
  echo "No regenerated-artifact drift; nothing to commit."
fi
