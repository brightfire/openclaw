#!/usr/bin/env bash
# Compute the next bf{N} suffix for the current upstream version and emit the
# combined tag/version/bf strings.
#
# Tag format: bf/v{VERSION}-bf{N}
#   The bf/ prefix prevents upstream workflows (e.g. docker-release.yml) from
#   triggering on our tags — they match on `v*` which would otherwise fire
#   on bare v{VERSION}-bf{N} tags.
#   The -bf{N} suffix is kept to match the package.json version.
#
# Inputs (env):
#   VERSION       — bare upstream version (X.Y.Z) from determine-upstream-tag.sh
#   GITHUB_OUTPUT — path to GitHub Actions output file
#
# Outputs (written to $GITHUB_OUTPUT):
#   bf       — bf{N}
#   version  — X.Y.Z-bf{N}
#   tag      — bf/vX.Y.Z-bf{N}

set -euo pipefail

if [ -z "${VERSION:-}" ]; then
  echo "::error::compute-bf-version.sh requires VERSION env var"
  exit 2
fi

BF_NUM=$(git tag -l "bf/v${VERSION}-bf*" | sed -E 's/.*-bf([0-9]+)/\1/' | sort -n | tail -1)
if [ -z "$BF_NUM" ]; then
  BF_NUM=1
else
  BF_NUM=$((BF_NUM + 1))
fi

{
  echo "bf=bf${BF_NUM}"
  echo "version=${VERSION}-bf${BF_NUM}"
  echo "tag=bf/v${VERSION}-bf${BF_NUM}"
} >> "$GITHUB_OUTPUT"

echo "Computed bf version: ${VERSION}-bf${BF_NUM} (tag bf/v${VERSION}-bf${BF_NUM})"
