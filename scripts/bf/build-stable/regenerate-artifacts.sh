#!/usr/bin/env bash
# Regenerate canonical build artifacts from merged sources, then commit any
# drift. Generated files are build output, not source; patches must never
# hand-edit them. A clean-but-stale generated file on a patch branch would
# otherwise ship in the tarball. Regenerating here keeps the build
# deterministic regardless of what any patch branch contains. See SKILL.md
# "Patch Discipline" rule 6 in the openclaw-dev skill for the full policy.

set -euo pipefail

# Invoke generators directly via node instead of `pnpm run` to avoid corepack
# version-shim overhead: when packageManager in package.json differs from the
# corepack-activated version, corepack re-downloads the declared version on
# every invocation, which can stall in CI network environments.
node --import tsx scripts/generate-base-config-schema.ts --write
node --import tsx scripts/protocol-gen.ts
node --import tsx scripts/protocol-gen-swift.ts

if ! git diff --quiet; then
  git add -A
  git commit --no-verify -m "ci: regenerate build artifacts on stable"
  echo "Regenerated build artifacts committed."
else
  echo "No regenerated-artifact drift; nothing to commit."
fi
