#!/usr/bin/env bash
# Regenerate canonical build artifacts from merged sources, then commit any
# drift. Generated files are build output, not source; patches must never
# hand-edit them. A clean-but-stale generated file on a patch branch would
# otherwise ship in the tarball. Regenerating here keeps the build
# deterministic regardless of what any patch branch contains. See SKILL.md
# "Patch Discipline" rule 6 in the openclaw-dev skill for the full policy.

set -euo pipefail

pnpm config:schema:gen
pnpm protocol:gen
pnpm protocol:gen:swift

if ! git diff --quiet; then
  git add -A
  git commit --no-verify -m "ci: regenerate build artifacts on stable"
  echo "Regenerated build artifacts committed."
else
  echo "No regenerated-artifact drift; nothing to commit."
fi
