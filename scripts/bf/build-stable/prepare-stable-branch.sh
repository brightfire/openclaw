#!/usr/bin/env bash
# Add the upstream remote (so upstream branches/tags are reachable) and check
# out the stable branch from the resolved upstream tag.
#
# Fetches ONLY the refs we need (the upstream tag and the optional
# `stable/<version>` branch). A blanket `git fetch --tags` pulls every branch
# and tag in openclaw/openclaw, which adds ~60s of pointless network/disk on
# a fresh runner.
#
# Inputs (env):
#   TAG     — upstream tag (vX.Y.Z) to base stable branch on
#   VERSION — bare version (X.Y.Z); stable branch is `stable/<VERSION>`

set -euo pipefail

if [ -z "${TAG:-}" ] || [ -z "${VERSION:-}" ]; then
  echo "::error::prepare-stable-branch.sh requires TAG and VERSION env vars"
  exit 2
fi

STABLE_BRANCH="stable/$VERSION"

ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "")
if echo "$ORIGIN_URL" | grep -q brightfire; then
  UPSTREAM_URL=$(echo "$ORIGIN_URL" | sed 's|brightfire/openclaw|openclaw/openclaw|')
  git remote add upstream "$UPSTREAM_URL" 2>/dev/null || git remote set-url upstream "$UPSTREAM_URL"

  # Build a targeted refspec list. Tag is always fetched. Branch is fetched
  # only if it exists upstream (some upstream tags don't have a follow-up
  # stable branch). One `git fetch` call no matter what.
  REFSPECS=("+refs/tags/$TAG:refs/tags/$TAG")
  if git ls-remote --exit-code --heads upstream "$STABLE_BRANCH" >/dev/null 2>&1; then
    REFSPECS+=("+refs/heads/$STABLE_BRANCH:refs/remotes/upstream/$STABLE_BRANCH")
    HAS_STABLE_BRANCH=1
  else
    HAS_STABLE_BRANCH=0
  fi
  git fetch --no-tags --force upstream "${REFSPECS[@]}"
else
  # Origin is already upstream (or we don't know how to derive it); assume
  # the tag is reachable as-is.
  HAS_STABLE_BRANCH=0
fi

# Prefer upstream's stable/<version> branch if it exists (upstream may have
# follow-up commits on top of the tag); otherwise check out the tag directly.
if [ "$HAS_STABLE_BRANCH" = "1" ]; then
  git checkout -b "$STABLE_BRANCH" "upstream/$STABLE_BRANCH" 2>/dev/null || \
    git checkout -b "$STABLE_BRANCH" "$TAG"
else
  git checkout -b "$STABLE_BRANCH" "$TAG"
fi

# Drop any stale origin copy of the same branch so the post-build push is
# always a clean force-push from the freshly-built tree.
if git ls-remote --exit-code --heads origin "$STABLE_BRANCH" >/dev/null 2>&1; then
  git push origin --delete "$STABLE_BRANCH" || true
fi

echo "Created stable branch: $STABLE_BRANCH"
