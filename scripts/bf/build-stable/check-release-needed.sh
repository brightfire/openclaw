#!/usr/bin/env bash
# Decide whether BF: Build Stable needs to PUBLISH a new release for the
# current BRIGHTFIRE_PATCHES.md manifest.
#
# Build + test ALWAYS run (so we keep getting signal on upstream/patch
# regressions and warm caches). This script gates only the publish steps:
# pushing stable, tagging, writing the fingerprint asset, and creating the
# GitHub Release. If the manifest is byte-identical to the one that produced
# the most recent release, those steps are a no-op and are skipped.
#
# Resolution:
#   1. sha256(BRIGHTFIRE_PATCHES.md) of the current checkout
#   2. Most recent bf/v* release on brightfire/openclaw
#   3. That release's bf-build-fingerprint.json asset (if present)
#   4. Compare manifest_sha256
#
# Edge cases:
#   - FORCE_RELEASE=true             -> always needs_release=true
#   - UPSTREAM_TAG_INPUT non-empty   -> always needs_release=true (operator
#                                       asked to build a specific upstream
#                                       tag; fingerprint comparison would
#                                       skip ad-hoc builds for a different
#                                       upstream version since the manifest
#                                       is unchanged)
#   - No prior bf/v* release         -> needs_release=true (first build)
#   - Latest release has no asset    -> needs_release=true (backfill run)
#   - gh release view fails (other)  -> fail loudly (no silent skip)
#
# Inputs (env):
#   GITHUB_REPOSITORY    — owner/repo (set by GHA runtime)
#   GITHUB_TOKEN         — used implicitly by gh
#   GITHUB_OUTPUT        — path to GitHub Actions output file
#   PATCHES_FILE         — manifest path (default: BRIGHTFIRE_PATCHES.md)
#   FORCE_RELEASE        — "true" forces needs_release=true (from workflow_dispatch)
#   UPSTREAM_TAG_INPUT   — non-empty value forces needs_release=true (from
#                          workflow_dispatch upstream_tag input)
#
# Outputs (written to $GITHUB_OUTPUT):
#   needs_release     — "true" | "false"
#   manifest_sha256   — sha256 of the current manifest

set -euo pipefail

PATCHES_FILE="${PATCHES_FILE:-BRIGHTFIRE_PATCHES.md}"
FORCE_RELEASE="${FORCE_RELEASE:-false}"
UPSTREAM_TAG_INPUT="${UPSTREAM_TAG_INPUT:-}"

if [ ! -f "$PATCHES_FILE" ]; then
  echo "::error::Manifest not found: $PATCHES_FILE"
  exit 2
fi

if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "::error::GITHUB_OUTPUT not set"
  exit 2
fi

MANIFEST_SHA=$(sha256sum "$PATCHES_FILE" | awk '{print $1}')
echo "Current manifest sha256: $MANIFEST_SHA"
echo "manifest_sha256=$MANIFEST_SHA" >> "$GITHUB_OUTPUT"

emit_release() {
  local reason="$1"
  echo "::notice::Release required: $reason"
  echo "needs_release=true" >> "$GITHUB_OUTPUT"
  exit 0
}

emit_skip() {
  local reason="$1"
  echo "::notice::$reason"
  echo "needs_release=false" >> "$GITHUB_OUTPUT"
  exit 0
}

if [ "$FORCE_RELEASE" = "true" ]; then
  emit_release "force_release=true (workflow_dispatch input)"
fi

if [ -n "$UPSTREAM_TAG_INPUT" ]; then
  emit_release "upstream_tag input set: $UPSTREAM_TAG_INPUT (workflow_dispatch input)"
fi

# Find the most recent bf/v* release. `gh release view` with no tag returns
# the latest non-draft, non-prerelease release; we further filter to bf/v*
# tags so other (unrelated) tags can't pollute the gate.
REPO_FLAG=()
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  REPO_FLAG=(--repo "$GITHUB_REPOSITORY")
fi

set +e
RELEASE_JSON=$(gh release list "${REPO_FLAG[@]}" --limit 50 --json tagName,isDraft,isPrerelease 2>&1)
RELEASE_LIST_RC=$?
set -e
if [ $RELEASE_LIST_RC -ne 0 ]; then
  echo "::error::gh release list failed: $RELEASE_JSON"
  exit 1
fi

LATEST_TAG=$(printf '%s' "$RELEASE_JSON" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for r in data:
    if r.get("isDraft") or r.get("isPrerelease"):
        continue
    tag = r.get("tagName", "")
    if tag.startswith("bf/v"):
        print(tag)
        break
')

if [ -z "$LATEST_TAG" ]; then
  emit_release "no prior bf/v* release found"
fi
echo "Latest bf/v* release: $LATEST_TAG"

set +e
VIEW_JSON=$(gh release view "$LATEST_TAG" "${REPO_FLAG[@]}" --json tagName,assets 2>&1)
VIEW_RC=$?
set -e
if [ $VIEW_RC -ne 0 ]; then
  echo "::error::gh release view '$LATEST_TAG' failed: $VIEW_JSON"
  exit 1
fi

FINGERPRINT_NAME="bf-build-fingerprint.json"
HAS_ASSET=$(printf '%s' "$VIEW_JSON" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for a in data.get("assets", []):
    if a.get("name") == "'"$FINGERPRINT_NAME"'":
        print("yes"); break
')

if [ "$HAS_ASSET" != "yes" ]; then
  emit_release "release $LATEST_TAG has no $FINGERPRINT_NAME asset (first build with gate)"
fi

TMPDIR_FP=$(mktemp -d)
trap 'rm -rf "$TMPDIR_FP"' EXIT

set +e
DL_OUT=$(gh release download "$LATEST_TAG" "${REPO_FLAG[@]}" \
  --pattern "$FINGERPRINT_NAME" --dir "$TMPDIR_FP" --clobber 2>&1)
DL_RC=$?
set -e
if [ $DL_RC -ne 0 ]; then
  echo "::error::gh release download '$LATEST_TAG' $FINGERPRINT_NAME failed: $DL_OUT"
  exit 1
fi

PRIOR_SHA=$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print(data.get("manifest_sha256", ""))
' "$TMPDIR_FP/$FINGERPRINT_NAME")

if [ -z "$PRIOR_SHA" ]; then
  emit_release "fingerprint on $LATEST_TAG missing manifest_sha256 field"
fi
echo "Prior release manifest sha256: $PRIOR_SHA (tag $LATEST_TAG)"

if [ "$PRIOR_SHA" = "$MANIFEST_SHA" ]; then
  emit_skip "Manifest unchanged since release $LATEST_TAG; skipping release"
fi

emit_release "manifest changed (was $PRIOR_SHA, now $MANIFEST_SHA; last release $LATEST_TAG)"
