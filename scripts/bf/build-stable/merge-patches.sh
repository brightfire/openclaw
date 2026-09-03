#!/usr/bin/env bash
# Squash-merge each manifest-recorded patch into the current (stable) branch,
# in order. Bails loudly on conflict or unresolved patch — patch order in
# BRIGHTFIRE_PATCHES.md is the contract, and every listed patch MUST apply.
#
# Merges the SHA recorded in the manifest's Branch HEAD column, NOT the live
# branch tip. This ensures the built tree exactly matches what the manifest
# claims; a branch that advances after the manifest is pinned does NOT
# silently leak unrecorded commits into the release.
#
# Inputs (env):
#   PATCHES     — comma-separated list of full branch names (e.g. brightfire/999239d745d/slack-mrkdwn)
#   PATCHES_FILE — path to BRIGHTFIRE_PATCHES.md (for resolving recorded SHAs)
#   VERSION     — bare upstream version (X.Y.Z); stable branch is `stable/<VERSION>`
#                 (used only for log context)

set -euo pipefail

if [ -z "${PATCHES:-}" ]; then
  echo "No patches to merge."
  exit 0
fi

PATCHES_FILE="${PATCHES_FILE:-BRIGHTFIRE_PATCHES.md}"
STABLE_BRANCH="stable/${VERSION:-unknown}"
IFS=',' read -ra PATCH_LIST <<< "$PATCHES"

# Build a branch-name → recorded-SHA lookup from the manifest table.
declare -A RECORDED_SHA
while IFS='|' read -r _ NAME BRANCH SHA _; do
  NAME=$(echo "$NAME" | xargs); BRANCH=$(echo "$BRANCH" | xargs); SHA=$(echo "$SHA" | xargs)
  # Strip markdown backticks from the branch cell
  BRANCH="${BRANCH//\`/}"
  SHA="${SHA//\`/}"
  if [ -n "$NAME" ] && [ -n "$BRANCH" ] && [[ "$SHA" =~ ^[a-f0-9]{6,40}$ ]]; then
    RECORDED_SHA["$BRANCH"]="$SHA"
  fi
done < <(grep '^|' "$PATCHES_FILE" | grep -v '^| Name' | grep -v '^|[-| ]')

for PATCH in "${PATCH_LIST[@]}"; do
  PATCH=$(echo "$PATCH" | xargs)

  echo ""
  echo "=== Merging $PATCH into $STABLE_BRANCH ==="

  # Fail if the patch branch doesn't exist on origin.
  if ! git rev-parse --verify "origin/$PATCH" >/dev/null 2>&1; then
    echo "::error::Patch branch $PATCH not found on origin — manifest lists it as active; aborting"
    exit 1
  fi

  # Resolve the merge target: recorded SHA if available, else the branch tip.
  RECORDED="${RECORDED_SHA[$PATCH]:-}"
  if [ -n "$RECORDED" ]; then
    if git cat-file -e "$RECORDED^{commit}" 2>/dev/null; then
      MERGE_REF="$RECORDED"
      echo "  Using recorded SHA: $RECORDED (from manifest Branch HEAD)"
    else
      echo "::error::Recorded SHA $RECORDED for $PATCH not in object store (fetch may be incomplete); aborting"
      exit 1
    fi
  else
    MERGE_REF="origin/$PATCH"
    echo "  WARNING: no recorded SHA for $PATCH in manifest; using live branch tip (may include unrecorded commits)"
  fi

  if git merge --squash "$MERGE_REF" 2>&1; then
    git commit --no-verify -m "ci: apply $PATCH" 2>&1
    echo "SUCCESS: $PATCH (merged $MERGE_REF)"
  else
    # Auto-resolve generated baselines and test-script conflicts by taking
    # the patch version; everything else is a hard conflict.
    CONFLICTED=$(git diff --name-only --diff-filter=U 2>/dev/null)
    NON_AUTO=$(echo "$CONFLICTED" | grep -vE '^docs/\.generated/.*\.sha256$|^test/scripts/.*\.test\.ts$|^ui/src/.*\.test\.ts$|^ui/src/.*\.browser\.test\.ts$' || true)
    if [ -n "$CONFLICTED" ] && [ -z "$NON_AUTO" ]; then
      echo "  Auto-resolving generated baselines and test-script conflicts (taking patch version)"
      while IFS= read -r file; do
        if ! git checkout --theirs -- "$file" 2>/dev/null; then
          git rm -f "$file"
        else
          git add -- "$file"
        fi
      done <<< "$CONFLICTED"
      git commit --no-verify -m "ci: apply $PATCH" 2>&1
      echo "SUCCESS: $PATCH (auto-resolved conflicts)"
    else
      git reset --hard HEAD
      echo "::error::Merge conflict applying $PATCH (non-auto-resolvable files: $NON_AUTO)"
      exit 1
    fi
  fi
done
