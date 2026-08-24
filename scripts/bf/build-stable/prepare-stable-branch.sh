#!/usr/bin/env bash
# Prepare the stable branch by checking out origin/main as the base.
#
# Instead of fetching an upstream tag, we use origin/main (current upstream
# HEAD on the Brightfire fork) as the build base. Patches are merged on top
# by merge-patches.sh.
#
# Inputs (env):
#   VERSION — bare version (X.Y.Z) read from package.json on origin/main;
#            stable branch is `stable/<VERSION>`

set -euo pipefail

if [ -z "${VERSION:-}" ]; then
  echo "::error::prepare-stable-branch.sh requires VERSION env var"
  exit 2
fi

STABLE_BRANCH="stable/$VERSION"

# Create the stable branch from origin/main.
git checkout -b "$STABLE_BRANCH" origin/main 2>/dev/null || \
  git checkout -b "$STABLE_BRANCH" refs/remotes/origin/main

# Drop any stale origin copy of the same branch so the post-build push is
# always a clean force-push from the freshly-built tree.
if git ls-remote --exit-code --heads origin "$STABLE_BRANCH" >/dev/null 2>&1; then
  git push origin --delete "$STABLE_BRANCH" || true
fi

echo "Created stable branch: $STABLE_BRANCH from origin/main"