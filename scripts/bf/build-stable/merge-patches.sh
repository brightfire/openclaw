#!/usr/bin/env bash
# Squash-merge each patch branch listed in PATCHES into the
# current (stable) branch, in order. Bails loudly on conflict — patch order
# in BRIGHTFIRE_PATCHES.md is the contract.
#
# Inputs (env):
#   PATCHES — comma-separated list of full branch names (e.g. 0a6c013be5f/upstream-test-fixes)
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
  PATCH_BRANCH="$PATCH"  # $PATCH is already the full branch name from parse-patches.py

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
    # Check whether every conflicted file is auto-resolvable. Two categories
    # are safe to auto-resolve by taking "theirs" (the patch branch version):
    #   1. docs/.generated/*.sha256 — regenerated from scratch in the next
    #      workflow step, so textual conflicts are harmless.
    #   2. test/scripts/*.test.ts — test-only files where a later patch may
    #      need to update assertions for build behavior changes introduced by
    #      the same patch.  The patch branch version is authoritative.
    CONFLICTED=$(git diff --name-only --diff-filter=U 2>/dev/null)
    NON_AUTO=$(echo "$CONFLICTED" | grep -vE '^docs/\.generated/.*\.sha256$|^test/scripts/.*\.test\.ts$|^ui/src/.*\.test\.ts$|^ui/src/.*\.browser\.test\.ts$' || true)
    if [ -n "$CONFLICTED" ] && [ -z "$NON_AUTO" ]; then
      echo "Auto-resolving generated baseline hashes and test-script conflicts (taking patch version)"
      while IFS= read -r file; do
        # If "theirs" is a deletion there is no blob to check out; remove the file instead.
        if ! git checkout --theirs -- "$file" 2>/dev/null; then
          git rm -f "$file"
        else
          git add -- "$file"
        fi
      done <<< "$CONFLICTED"
      git commit --no-verify -m "ci: apply $PATCH_BRANCH" 2>&1
      echo "SUCCESS: $PATCH_BRANCH (auto-resolved conflicts)"
    else
      git reset --hard HEAD
      echo "::error::Merge conflict applying $PATCH_BRANCH"
      exit 1
    fi
  fi
done
