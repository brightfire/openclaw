#!/usr/bin/env bash
# refresh-branch-heads.sh — bulk-refresh mode for BF: Register Patch.
#
# Refreshes the Branch HEAD commit for every active patch in
# BRIGHTFIRE_PATCHES.md by querying origin via `git ls-remote` (no local
# fetch). Source PR is left untouched per entry. One commit, one push to
# brightfire/ci.
#
# This is the only bulk-refresh mode — the older `sync_all` (fetch +
# rev-parse) flow was collapsed into this one since they were functionally
# equivalent. `ls-remote` wins on cost (no fetched objects).
#
# Called from .github/workflows/bf-register-patch.yml when the workflow is
# dispatched with refresh_branch_heads=true. Use after a catch-up batch
# (per the openclaw-dev runbook step 3a).
#
# Inputs (env vars):
#   PATCHES_FILE  optional; defaults to BRIGHTFIRE_PATCHES.md
#
# Side effects:
#   - Rewrites $PATCHES_FILE in place via update-patch-entry.py.
#   - Commits and pushes to origin brightfire/ci when at least one entry
#     changed; exits 0 cleanly when every active-patch HEAD is already
#     current.

set -euo pipefail

: "${PATCHES_FILE:=BRIGHTFIRE_PATCHES.md}"

echo "refresh_branch_heads mode: refreshing HEAD commits via git ls-remote (no fetch)"

# Parse the active-patch list out of the manifest into a tmp file, then
# pull the `list=` CSV from it. parse-patches.py is shared with other
# workflows (BF: Build Stable) and is the single source of truth for what
# "active" means.
parse_out="$(mktemp)"
trap 'rm -f "$parse_out"' EXIT
python3 scripts/bf/parse-patches.py "$PATCHES_FILE" "$parse_out" >/dev/null
active_csv=$(awk -F= '/^list=/{print substr($0,6)}' "$parse_out")
IFS=',' read -ra patches <<< "$active_csv"

remote_url=$(git config --get remote.origin.url)
updated_count=0
updated_list=""

for p in "${patches[@]}"; do
  p=$(echo "$p" | xargs)
  [ -z "$p" ] && continue
  # ls-remote prints `<sha>\t<ref>` for the matched ref; empty when missing.
  ls_line=$(git ls-remote "$remote_url" "refs/heads/brightfire/$p" 2>/dev/null | head -n1)
  if [ -z "$ls_line" ]; then
    echo "::warning::brightfire/$p not on remote (ls-remote returned nothing); skipping"
    continue
  fi
  tip=$(echo "$ls_line" | awk '{print $1}')
  short="${tip:0:10}"
  # pr_number omitted -> preserve existing Source PR.
  if python3 scripts/bf/update-patch-entry.py \
       --file "$PATCHES_FILE" \
       --patch "$p" \
       --commit-sha "$short"; then
    updated_count=$((updated_count + 1))
    updated_list="${updated_list}${updated_list:+, }$p->$short"
  fi
done

git add "$PATCHES_FILE"
if git diff --cached --quiet; then
  echo "refresh_branch_heads: all active-patch HEADs already current in manifest; nothing to push."
  exit 0
fi
git commit -m "ci: refresh manifest patch HEADs via ls-remote ($updated_list)"
git push origin brightfire/ci
echo "refresh_branch_heads: refreshed $updated_count entries and pushed brightfire/ci."
