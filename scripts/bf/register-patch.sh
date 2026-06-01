#!/usr/bin/env bash
# register-patch.sh — single-patch register/update flow.
#
# Two modes, dispatched on whether the patch already has an entry in
# BRIGHTFIRE_PATCHES.md:
#
#   * EXISTING patch — bump the Branch HEAD commit (and Source PR, when
#     provided) via scripts/bf/update-patch-entry.py.
#   * NEW patch     — append a fresh manifest section, pre-populated with
#     a title, status, canonical branch, head SHA, normalized Source PR
#     field, and TBD placeholders for the rationale / files-touched /
#     upgrade-guidance subsections.
#
# Called from .github/workflows/bf-register-patch.yml on a merged PR_TARGET
# event OR a manual dispatch where REFRESH_BRANCH_HEADS!=true.
#
# Inputs (env vars):
#   PATCHES_FILE  optional; defaults to BRIGHTFIRE_PATCHES.md
#   PATCH_BRANCH  required; full branch ref (e.g. brightfire/foo). Stripped
#                 of the `brightfire/` prefix to derive PATCH_NAME.
#   PR_NUMBER     optional; bare N, #N, full URL, "0"/"#0"/empty/whitespace.
#                 "0"/empty/whitespace mean 'preserve existing Source PR'
#                 (catch-up sync). Stripped of a leading `#` before being
#                 forwarded so commit messages don't end up as `PR ##24`.
#   PR_TITLE      optional; PR title used when appending a new entry.
#   MERGE_SHA     optional; PR merge commit SHA. Preferred over local
#                 fetch+rev-parse when set (i.e. on a real PR event).
#   HEAD_SHA      optional; fallback SHA when MERGE_SHA is empty and the
#                 patch branch can't be resolved locally.
#
# Side effects:
#   - Rewrites $PATCHES_FILE in place (new section appended OR existing
#     section rewritten via update-patch-entry.py).
#   - Commits and pushes to origin brightfire/ci. The push triggers
#     BF: Build Stable. For the existing-patch path, a no-op rewrite
#     (same SHA, same PR already recorded) exits 0 cleanly without pushing.

set -euo pipefail

: "${PATCHES_FILE:=BRIGHTFIRE_PATCHES.md}"

# ------------------------------------------------------------
# Normalize PR_NUMBER.
#
# Treat 0 / "0" / "#0" / whitespace as empty so that the historical
# workflow_dispatch default of `0` does not clobber Source PR on catch-up
# dispatches. Also strip a leading `#` from `#N` inputs so downstream code
# (commit messages, new-entry append) sees a clean value;
# update-patch-entry.py and normalize-pr-ref.py both normalize either form
# to a full URL when actually written.
# ------------------------------------------------------------
pr_number_raw="${PR_NUMBER:-}"
pr_number_stripped="$(printf '%s' "$pr_number_raw" | tr -d '[:space:]')"
pr_number_stripped="${pr_number_stripped#'#'}"
if [ -z "$pr_number_stripped" ] || [ "$pr_number_stripped" = "0" ]; then
  if [ -n "$pr_number_raw" ]; then
    echo "DEBUG: PR_NUMBER='$pr_number_raw' treated as preserve"
  fi
  PR_NUMBER=""
else
  PR_NUMBER="$pr_number_stripped"
fi

# ------------------------------------------------------------
# Resolve the commit SHA.
#   - PR event: use the merge commit SHA (preferred — authoritative).
#   - Manual dispatch: resolve HEAD of the patch branch from git,
#     falling back to $HEAD_SHA when the fetch/rev-parse fails.
# ------------------------------------------------------------
if [ -n "${MERGE_SHA:-}" ]; then
  raw_sha="$MERGE_SHA"
else
  git fetch origin "$PATCH_BRANCH" 2>/dev/null || true
  raw_sha=$(git rev-parse "origin/$PATCH_BRANCH" 2>/dev/null || echo "${HEAD_SHA:-}")
fi
commit_short="${raw_sha:0:10}"

# Extract patch name from branch (strip brightfire/ prefix).
patch_name=${PATCH_BRANCH#brightfire/}

if grep -q "brightfire/${patch_name}" "$PATCHES_FILE"; then
  # ----------------------------------------------------------------
  # EXISTING PATCH — update commit SHA, source PR, and last-updated
  # ----------------------------------------------------------------
  echo "Existing patch detected: $patch_name — updating entry"

  # Only forward --pr when there's a real value to write. Passing an empty
  # string would still trigger update-patch-entry.py's preserve path, but
  # omitting the flag entirely matches how callers normally invoke it.
  if [ -n "$PR_NUMBER" ]; then
    python3 scripts/bf/update-patch-entry.py \
      --file "$PATCHES_FILE" \
      --patch "$patch_name" \
      --commit-sha "$commit_short" \
      --pr "$PR_NUMBER"
  else
    python3 scripts/bf/update-patch-entry.py \
      --file "$PATCHES_FILE" \
      --patch "$patch_name" \
      --commit-sha "$commit_short"
  fi

  git add "$PATCHES_FILE"
  if git diff --cached --quiet; then
    # No-op update: the manifest already has this SHA (and PR, if one was
    # provided) for this patch. Treat as success and skip the push — there
    # is nothing for bf-build-stable to react to. If a rebuild is desired
    # anyway, dispatch bf-build-stable manually.
    if [ -z "$PR_NUMBER" ]; then
      echo "No manifest changes for $patch_name (commit=$commit_short already recorded; Source PR preserved); skipping push."
    else
      echo "No manifest changes for $patch_name (commit=$commit_short, PR=${PR_NUMBER} already recorded); skipping push."
    fi
    exit 0
  fi
  if [ -z "$PR_NUMBER" ]; then
    git commit -m "ci: update patch entry for brightfire/${patch_name} (sync, ${commit_short})"
  else
    # Commit message uses the (now de-#'d, non-zero) ref as-is. For bare/#N
    # this is a plain number; for full URLs it's the URL.
    git commit -m "ci: update patch entry for brightfire/${patch_name} (PR ${PR_NUMBER}, ${commit_short})"
  fi
else
  # ----------------------------------------------------------------
  # NEW PATCH — append a full manifest entry
  # ----------------------------------------------------------------
  echo "New patch detected: $patch_name — creating entry"

  # Strip common conventional commit prefixes from the PR title.
  title=$(echo "${PR_TITLE:-}" | sed 's/^feat\s*:\s*//; s/^fix\s*:\s*//; s/^doc\s*:\s*//; s/^docs\s*:\s*//')

  # Normalize Source PR to a full URL so the new entry matches the
  # convention used by update-patch-entry.py for existing entries. Falls
  # back to `—` when there is no PR (PR_NUMBER was emptied above). The
  # dedicated helper avoids the inline-importlib ceremony the inline
  # workflow used to carry.
  source_pr_field=$(python3 scripts/bf/normalize-pr-ref.py "$PR_NUMBER")

  {
    echo ""
    echo "## $title"
    echo ""
    echo "- **Status:** active"
    echo "- **Reapply:** yes"
    echo "- **Stable branch first merged into:** TBD"
    echo "- **Canonical branch:** \`brightfire/${patch_name}\`"
    echo "- **Branch HEAD commit:** \`${commit_short}\`"
    echo "- **Source PR:** ${source_pr_field}"
    echo ""
    echo "### Rationale"
    echo ""
    echo "_Add description of what this patch does and why._"
    echo ""
    echo "### Files touched"
    echo ""
    echo "TBD — update after first stable merge"
    echo ""
    echo "### Upgrade guidance"
    echo ""
    echo "_Add known conflict notes or \`git cherry-pick\` command here._"
  } >> "$PATCHES_FILE"

  git add "$PATCHES_FILE"
  if [ -z "$PR_NUMBER" ]; then
    git commit -m "ci: register new patch brightfire/${patch_name} (no PR)"
  else
    git commit -m "ci: register new patch brightfire/${patch_name} (PR ${PR_NUMBER})"
  fi
fi

# Always push to brightfire/ci — this triggers BF: Build Stable.
git push origin brightfire/ci
echo "Pushed updated manifest to brightfire/ci"
