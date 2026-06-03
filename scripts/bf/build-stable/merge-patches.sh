#!/usr/bin/env bash
# Squash-merge each brightfire/<patch> branch listed in PATCHES into the
# current (stable) branch, in order. Bails loudly on conflict — patch order
# in BRIGHTFIRE_PATCHES.md is the contract.
#
# Inputs (env):
#   PATCHES — comma-separated list of patch names (without the brightfire/ prefix)
#   VERSION — bare upstream version (X.Y.Z); stable branch is `stable/<VERSION>`
#             (used only for log context)

set -euo pipefail

if [ -z "${PATCHES:-}" ]; then
  echo "No patches to merge."
  exit 0
fi

STABLE_BRANCH="stable/${VERSION:-unknown}"
IFS=',' read -ra PATCH_LIST <<< "$PATCHES"

for PATCH in "${PATCH_LIST[@]}"; do
  PATCH=$(echo "$PATCH" | xargs)
  PATCH_BRANCH="brightfire/$PATCH"

  echo ""
  echo "=== Merging $PATCH_BRANCH into $STABLE_BRANCH ==="

  if ! git ls-remote --exit-code --heads origin "$PATCH_BRANCH" 2>/dev/null; then
    echo "::warning::$PATCH_BRANCH not found on remote — skipping"
    continue
  fi

  if git merge --squash "origin/$PATCH_BRANCH" 2>&1; then
    git commit --no-verify -m "ci: apply $PATCH_BRANCH" 2>&1
    echo "SUCCESS: $PATCH_BRANCH"
  else
    git reset --hard HEAD
    echo "::error::Merge conflict applying $PATCH_BRANCH"
    exit 1
  fi
done
