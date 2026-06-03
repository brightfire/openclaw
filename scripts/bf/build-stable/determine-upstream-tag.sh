#!/usr/bin/env bash
# Resolve the upstream tag for this build-stable run.
#
# Resolution order (no auto-detect, no silent fallbacks):
#   1. workflow_dispatch input  (ad-hoc test build during an upgrade)
#   2. BRIGHTFIRE_PATCHES.md _meta `Upstream version` pin
#
# If neither is set, fail loudly. Bumping the pin is the job of the
# BF: Upgrade workflow — build-stable never decides the target version.
#
# Inputs (env):
#   INPUT_TAG     — workflow_dispatch input (may be empty)
#   MANIFEST_TAG  — upstream_version parsed from BRIGHTFIRE_PATCHES.md (may be empty)
#   GITHUB_OUTPUT — path to GitHub Actions output file (set by GHA runtime)
#
# Outputs (written to $GITHUB_OUTPUT):
#   tag       — full tag (vX.Y.Z)
#   version   — bare version (X.Y.Z)

set -euo pipefail

if [ -n "${INPUT_TAG:-}" ]; then
  TAG="$INPUT_TAG"
  SOURCE="workflow_dispatch input"
elif [ -n "${MANIFEST_TAG:-}" ]; then
  TAG="$MANIFEST_TAG"
  SOURCE="BRIGHTFIRE_PATCHES.md _meta pin"
else
  echo "::error::No upstream tag resolved. Add an 'Upstream version' to the _meta section of BRIGHTFIRE_PATCHES.md, or pass inputs.upstream_tag explicitly."
  exit 1
fi

if ! echo "$TAG" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "::error::Resolved upstream tag '$TAG' (from $SOURCE) is not vX.Y.Z; refusing to continue."
  exit 1
fi

VERSION="${TAG#v}"
echo "Resolved upstream tag: $TAG (version=$VERSION, source=$SOURCE)"
{
  echo "tag=$TAG"
  echo "version=$VERSION"
} >> "$GITHUB_OUTPUT"
