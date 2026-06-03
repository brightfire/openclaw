#!/usr/bin/env bash
# Add the upstream remote (so upstream branches/tags are reachable) and check
# out the stable branch from the resolved upstream tag.
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

# Add upstream remote pointing at openclaw/openclaw and fetch its tags so
# stable/<version> and the upstream tag are both reachable for checkout.
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "")
if echo "$ORIGIN_URL" | grep -q brightfire; then
  UPSTREAM_URL=$(echo "$ORIGIN_URL" | sed 's|brightfire/openclaw|openclaw/openclaw|')
  git remote add upstream "$UPSTREAM_URL" 2>/dev/null || git remote set-url upstream "$UPSTREAM_URL"
  git fetch --force --tags upstream
fi

# Prefer upstream's stable/<version> branch if it exists (upstream may have
# follow-up commits on top of the tag); otherwise check out the tag directly.
if git ls-remote --exit-code --heads upstream "$STABLE_BRANCH" 2>/dev/null; then
  git checkout -b "$STABLE_BRANCH" "upstream/$STABLE_BRANCH" 2>/dev/null || \
    git checkout -b "$STABLE_BRANCH" "$TAG"
else
  git checkout -b "$STABLE_BRANCH" "$TAG"
fi

# Drop any stale origin copy of the same branch so the post-build push is
# always a clean force-push from the freshly-built tree.
if git ls-remote --exit-code --heads origin "$STABLE_BRANCH" 2>/dev/null; then
  git push origin --delete "$STABLE_BRANCH" || true
fi

echo "Created stable branch: $STABLE_BRANCH"
