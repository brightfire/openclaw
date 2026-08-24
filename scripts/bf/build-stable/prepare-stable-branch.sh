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

set -euo pipefail

VERSION="${VERSION:?prepare-stable-branch.sh requires VERSION env var}"
BASE_BRANCH="${BASE_BRANCH:-main}"

STABLE_BRANCH="stable/$VERSION"

# Fetch the base branch if not already available locally.
git fetch origin "$BASE_BRANCH" 2>/dev/null || true

# Create the stable branch from the base branch.
git checkout -b "$STABLE_BRANCH" "origin/$BASE_BRANCH" 2>/dev/null || \
  git checkout -b "$STABLE_BRANCH" "refs/remotes/origin/$BASE_BRANCH"

# Drop any stale origin copy of the same branch so the post-build push is
# always a clean force-push from the freshly-built tree.
if git ls-remote --exit-code --heads origin "$STABLE_BRANCH" >/dev/null 2>&1; then
  git push origin --delete "$STABLE_BRANCH" || true
fi

echo "Created stable branch: $STABLE_BRANCH from origin/$BASE_BRANCH"
