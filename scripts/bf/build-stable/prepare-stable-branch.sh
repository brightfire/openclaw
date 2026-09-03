#!/usr/bin/env bash
# Prepare the stable branch by checking out the configured base branch.
#
# The base branch is read from BRIGHTFIRE_PATCHES.md _meta (default: main).
# Patches are merged on top by merge-patches.sh.
#
# Inputs (env):
#   VERSION     — bare version (X.Y.Z) read from package.json on the base branch;
#                 stable branch is `stable/<VERSION>`
#   BASE_BRANCH — base branch name (default: main), read from manifest _meta
#   BASE_COMMIT — optional pinned commit SHA from manifest _meta; when present,
#                 stable is built from this commit instead of origin/<BASE_BRANCH> HEAD

set -euo pipefail

VERSION="${VERSION:?prepare-stable-branch.sh requires VERSION env var}"
BASE_BRANCH="${BASE_BRANCH:-main}"
BASE_COMMIT="${BASE_COMMIT:-}"

STABLE_BRANCH="stable/$VERSION"

# Fetch the base branch so the pinned commit (if any) is available.
git fetch origin "$BASE_BRANCH" 2>/dev/null || true

# Determine the ref to build from.
if [ -n "$BASE_COMMIT" ]; then
  # Pinned commit: fail closed if it can't be resolved. A bad pin must
  # never silently fall back to the branch HEAD — that would build a
  # different tree than the manifest specifies.
  git fetch origin "$BASE_COMMIT" 2>/dev/null || true
  if ! git cat-file -e "$BASE_COMMIT^{commit}" 2>/dev/null; then
    echo "::error::Pinned BASE_COMMIT $BASE_COMMIT is not a valid, available commit. Aborting — refusing to fall back to branch HEAD."
    exit 1
  fi
  BASE_REF="$BASE_COMMIT"
  echo "Using pinned base commit: $BASE_COMMIT"
else
  BASE_REF="origin/$BASE_BRANCH"
  echo "Using base branch HEAD: origin/$BASE_BRANCH"
fi

# Create the stable branch from the determined ref.
git checkout -b "$STABLE_BRANCH" "$BASE_REF" 2>/dev/null || \
  git checkout -b "$STABLE_BRANCH" "refs/remotes/origin/$BASE_BRANCH"

# Drop any stale origin copy of the same branch so the post-build push is
# always a clean force-push from the freshly-built tree.
if git ls-remote --exit-code --heads origin "$STABLE_BRANCH" >/dev/null 2>&1; then
  git push origin --delete "$STABLE_BRANCH" || true
fi

echo "Created stable branch: $STABLE_BRANCH from origin/$BASE_BRANCH"
