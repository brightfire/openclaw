#!/usr/bin/env bash
# Compute the next {N} suffix for the current upstream version and emit the
# combined tag/version/n strings.
#
# Tag format: bf/v{VERSION}-{N}
#   The bf/ prefix prevents upstream workflows (e.g. docker-release.yml) from
#   triggering on our tags — they match on `v*` which would otherwise fire
#   on bare v{VERSION}-{N} tags.
#   The -{N} suffix (a plain build number) is recognized by OpenClaw's version
#   comparator as "later than the base release". The former -bf{N} suffix was
#   not recognized and was treated as a pre-release (i.e. earlier).
#
# Inputs (env):
#   VERSION       — bare upstream version (X.Y.Z) from determine-upstream-tag.sh
#   GITHUB_OUTPUT — path to GitHub Actions output file
#
# Outputs (written to $GITHUB_OUTPUT):
#   n        — {N}
#   version  — X.Y.Z-{N}
#   tag      — bf/vX.Y.Z-{N}

set -euo pipefail

if [ -z "${VERSION:-}" ]; then
  echo "::error::compute-bf-version.sh requires VERSION env var"
  exit 2
fi

# Only count new-style tags (pure numeric suffix, e.g. bf/v2026.6.8-3).
# Old-style -bf{N} tags are excluded so the counter is independent of
# pre-migration builds.
BF_NUM=$(git tag -l "bf/v${VERSION}-*" \
  | grep -vE -- '-bf[0-9]+$' \
  | grep -E -- '-[0-9]+$' \
  | sed -E 's/.*-([0-9]+)$/\1/' \
  | sort -n | tail -1)

if [ -z "$BF_NUM" ]; then
  BF_NUM=1
else
  BF_NUM=$((BF_NUM + 1))
fi

{
  echo "n=${BF_NUM}"
  echo "version=${VERSION}-${BF_NUM}"
  echo "tag=bf/v${VERSION}-${BF_NUM}"
} >> "$GITHUB_OUTPUT"

echo "Computed version: ${VERSION}-${BF_NUM} (tag bf/v${VERSION}-${BF_NUM})"
