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
#   - No prior bf/v* release         -> needs_release=true (first build)
#   - Latest release has no asset    -> needs_release=true (backfill run)
#   - gh release view fails (other)  -> fail loudly (no silent skip)
#
# Manifest source (preferred): a pinned file path + pre-computed sha256
# staged by the workflow's "Fetch patch manifest from brightfire/ci (pinned)"
# step. Pinning matters because origin/brightfire/ci can advance between the
# moment the build started and the moment this gate runs — concurrent pushes
# happen during the ~30+ min build/test window, and several intervening
# `git fetch` calls update the remote tracking ref. Reading the moving ref
# here would gate (and fingerprint) on a manifest that did NOT drive this
# build, letting newly-registered patches sneak into a fingerprint that
# claims to represent only the older set.
#
# Fallback: read from a git ref (default origin/brightfire/ci). This keeps
# local invocations working and provides a graceful degradation if the
# workflow ever ran this script without staging the pinned copy.
#
# Inputs (env):
#   GITHUB_REPOSITORY        — owner/repo (set by GHA runtime)
#   GITHUB_TOKEN             — used implicitly by gh
#   GITHUB_OUTPUT            — path to GitHub Actions output file
#   PINNED_MANIFEST_PATH     — path to the staged pinned manifest; preferred
#                              source when present and readable
#   PINNED_MANIFEST_SHA256   — sha256 of the pinned manifest, computed at
#                              staging time; used directly when set so the
#                              fingerprint writer and the gate share the
#                              exact same value byte-for-byte
#   MANIFEST_REF             — git ref fallback (default:
#                              origin/brightfire/ci); override only for
#                              local testing
#   FORCE_RELEASE            — "true" forces needs_release=true (from
#                              workflow_dispatch)

#
# Outputs (written to $GITHUB_OUTPUT):
#   needs_release     — "true" | "false"
#   manifest_sha256   — sha256 of the manifest that drove this build

set -euo pipefail

MANIFEST_REF="${MANIFEST_REF:-origin/brightfire/ci}"
FORCE_RELEASE="${FORCE_RELEASE:-false}"
PINNED_MANIFEST_PATH="${PINNED_MANIFEST_PATH:-}"
PINNED_MANIFEST_SHA256="${PINNED_MANIFEST_SHA256:-}"

if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "::error::GITHUB_OUTPUT not set"
  exit 2
fi

if [ -n "$PINNED_MANIFEST_PATH" ] && [ -r "$PINNED_MANIFEST_PATH" ]; then
  # Preferred path: pinned file + pre-computed sha.
  if [ -n "$PINNED_MANIFEST_SHA256" ]; then
    MANIFEST_SHA="$PINNED_MANIFEST_SHA256"
  else
    MANIFEST_SHA=$(sha256sum "$PINNED_MANIFEST_PATH" | awk '{print $1}')
  fi
  echo "Manifest source: pinned ($PINNED_MANIFEST_PATH)"
else
  if [ -n "$PINNED_MANIFEST_PATH" ]; then
    echo "::warning::PINNED_MANIFEST_PATH set but not readable ($PINNED_MANIFEST_PATH); falling back to $MANIFEST_REF"
  fi
  if ! git rev-parse --verify "$MANIFEST_REF:BRIGHTFIRE_PATCHES.md" >/dev/null 2>&1; then
    echo "::error::BRIGHTFIRE_PATCHES.md not found at $MANIFEST_REF"
    exit 2
  fi
  # Pipe git-show through sha256sum so the trailing newline is preserved
  # byte-for-byte (sha must match `sha256sum BRIGHTFIRE_PATCHES.md` taken
  # elsewhere, e.g. by write-build-fingerprint.sh).
  MANIFEST_SHA=$(git show "$MANIFEST_REF:BRIGHTFIRE_PATCHES.md" | sha256sum | awk '{print $1}')
  echo "Manifest source: $MANIFEST_REF (fallback)"
fi

echo "Current manifest sha256: $MANIFEST_SHA"
echo "manifest_sha256=$MANIFEST_SHA" >> "$GITHUB_OUTPUT"

# Composite build-input sha: manifest + workflow + scripts. Used for the
# release gate comparison so changes to the build infrastructure itself
# trigger a release without needing a manifest edit.
BUILD_INPUT_SHA=$(
  {
    echo "manifest:"
    cat BRIGHTFIRE_PATCHES.md
    echo "workflow:"
    cat .github/workflows/bf-build-stable.yml 2>/dev/null || echo "(absent)"
    echo "scripts:"
    find scripts/bf/ -type f \( -name '*.sh' -o -name '*.py' \) 2>/dev/null | sort | while read f; do
      echo "--- $f"
      cat "$f"
    done
  } | sha256sum | awk '{print $1}'
)
echo "build_input_sha256=$BUILD_INPUT_SHA" >> "$GITHUB_OUTPUT"

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
print(data.get("build_input_sha256", data.get("manifest_sha256", "")))
' "$TMPDIR_FP/$FINGERPRINT_NAME")

if [ -z "$PRIOR_SHA" ]; then
  emit_release "fingerprint on $LATEST_TAG missing build_input_sha256 field"
fi
echo "Prior release build-input sha256: $PRIOR_SHA (tag $LATEST_TAG)"

if [ "$PRIOR_SHA" = "$MANIFEST_SHA" ]; then
  emit_skip "Build inputs unchanged since release $LATEST_TAG; skipping release"
fi

emit_release "build inputs changed (was $PRIOR_SHA, now $BUILD_INPUT_SHA; last release $LATEST_TAG)"
