#!/usr/bin/env bash
# Read the upstream version from package.json on origin/main.
#
# The base is now origin/main (not a pinned upstream tag), so the version
# is simply the `version` field from package.json on origin/main.
#
# Inputs (env):
#   GITHUB_OUTPUT — path to GitHub Actions output file (set by GHA runtime)
#
# Outputs (written to $GITHUB_OUTPUT):
#   tag       — full tag (vX.Y.Z)
#   version   — bare version (X.Y.Z)

set -euo pipefail

# Read version from package.json on origin/main
VERSION=$(git show origin/main:package.json | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")

if [ -z "$VERSION" ]; then
  echo "::error::Could not read version from package.json on origin/main"
  exit 1
fi

TAG="v${VERSION}"

echo "Read version from origin/main package.json: $TAG"
{
  echo "tag=$TAG"
  echo "version=$VERSION"
} >> "$GITHUB_OUTPUT"