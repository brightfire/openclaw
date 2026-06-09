#!/usr/bin/env bash
# Regenerate canonical build artifacts from merged sources, then commit any
# drift. Generated files are build output, not source; patches must never
# hand-edit them. A clean-but-stale generated file on a patch branch would
# otherwise ship in the tarball. Regenerating here keeps the build
# deterministic regardless of what any patch branch contains. See SKILL.md
# "Patch Discipline" rule 6 in the openclaw-dev skill for the full policy.

set -euo pipefail

echo "=== Debug: node_modules state ==="
echo "node_modules packages: $(ls node_modules/.pnpm 2>/dev/null | wc -l)"
echo "pnpm version: $(pnpm -v)"
echo "tsx available: $(node -e 'try{require.resolve("tsx");console.log("yes")}catch{console.log("no")}')"
echo "verifyDepsBeforeRun: $(pnpm config get verify-deps-before-run 2>/dev/null || echo 'unknown')"

# Use documented pnpm commands (not raw node calls) so the script stays
# correct even if upstream refactors the underlying generator scripts.
# See docs/.generated/README.md and docs/gateway/protocol.md.
echo "=== Running config:schema:gen ==="
pnpm config:schema:gen
echo "=== Running protocol:gen ==="
pnpm protocol:gen
echo "=== Running protocol:gen:swift ==="
pnpm protocol:gen:swift
echo "=== Running config:docs:gen ==="
pnpm config:docs:gen
echo "=== Running plugin-sdk:api:gen ==="
pnpm plugin-sdk:api:gen
echo "=== All generators complete ==="

if ! git diff --quiet; then
  git add -A
  git commit --no-verify -m "ci: regenerate build artifacts on stable"
  echo "Regenerated build artifacts committed."
else
  echo "No regenerated-artifact drift; nothing to commit."
fi
