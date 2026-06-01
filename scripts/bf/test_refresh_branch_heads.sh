#!/usr/bin/env bash
# Integration test for the `refresh_branch_heads` mode of
# .github/workflows/bf-register-patch.yml.
#
# Strategy:
# 1. Build a tiny git repo at $TMP/repo seeded from a synthetic
#    BRIGHTFIRE_PATCHES.md so parse-patches.py finds 2 active patches.
# 2. Replay the workflow's `refresh_branch_heads` shell block in isolation,
#    with a `git` shim on PATH that:
#      - allows real git for config/add/diff/commit (inside the test repo),
#      - intercepts `git ls-remote ... refs/heads/brightfire/<name>` to print
#        canned SHAs (no network), and
#      - swallows `git push` so we don't try to push to a real remote.
# 3. Assert: manifest's Branch HEAD lines are rewritten to the canned SHAs,
#    Source PR fields are preserved, exit 0.
#
# Run from repo root:
#     bash scripts/bf/test_refresh_branch_heads.sh

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
mkdir -p "$REPO/scripts/bf"
cp "$REPO_ROOT/scripts/bf/update-patch-entry.py" "$REPO/scripts/bf/"
cp "$REPO_ROOT/scripts/bf/parse-patches.py" "$REPO/scripts/bf/"

cat >"$REPO/BRIGHTFIRE_PATCHES.md" <<'EOF'
# Brightfire Patch Registry

## _meta

- **Upstream version:** `v2026.5.7`

---

## Slack Markdown

- **Status:** active
- **Reapply:** yes
- **Canonical branch:** `brightfire/slack-mrkdwn`
- **Branch HEAD commit:** `oldslackss`
- **Source PR:** #42
- **Last updated:** 2026-05-29

### Rationale

Test patch.

---

## XGW

- **Status:** active
- **Reapply:** yes
- **Canonical branch:** `brightfire/xgw`
- **Branch HEAD commit:** `oldxgwxxxx`
- **Source PR:** #17

### Rationale

Test patch.
EOF

# Real-ish git repo so `git add` / `git diff --cached --quiet` behave correctly.
cd "$REPO"
git init -q -b brightfire/ci
git config user.email ci@brightfire.net
git config user.name brightfire-ci
git remote add origin "https://example.invalid/repo.git"
git add .
git -c commit.gpgsign=false commit -q -m "seed manifest"

# Build a `git` shim that intercepts ls-remote + push.
SHIM_DIR="$TMP/shim"
mkdir -p "$SHIM_DIR"
REAL_GIT=$(command -v git)
cat >"$SHIM_DIR/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  ls-remote)
    # Args: git ls-remote <url> <ref>
    REF="\${3:-}"
    case "\$REF" in
      refs/heads/brightfire/slack-mrkdwn)
        printf '%s\t%s\n' "1111111111111111111111111111111111111111" "\$REF"
        exit 0
        ;;
      refs/heads/brightfire/xgw)
        printf '%s\t%s\n' "2222222222222222222222222222222222222222" "\$REF"
        exit 0
        ;;
      *)
        # Unknown ref: empty output, exit 0 (matches real git ls-remote behavior).
        exit 0
        ;;
    esac
    ;;
  push)
    echo "[shim] swallowed: git \$*"
    exit 0
    ;;
  *)
    exec "$REAL_GIT" "\$@"
    ;;
esac
EOF
chmod +x "$SHIM_DIR/git"

# Extract the refresh_branch_heads block from the workflow and run it.
# We do this by sourcing a small driver that sets the env + the relevant
# shell snippet from the workflow.
DRIVER="$TMP/driver.sh"
cat >"$DRIVER" <<'EOF'
set -euo pipefail
PATCHES_FILE="BRIGHTFIRE_PATCHES.md"

python3 scripts/bf/parse-patches.py "$PATCHES_FILE" /tmp/parse-out
ACTIVE_CSV=$(awk -F= '/^list=/{print substr($0,6)}' /tmp/parse-out)
IFS=',' read -ra PATCHES <<< "$ACTIVE_CSV"

REMOTE_URL=$(git config --get remote.origin.url)
UPDATED_COUNT=0
UPDATED_LIST=""
for p in "${PATCHES[@]}"; do
  p=$(echo "$p" | xargs)
  [ -z "$p" ] && continue
  LS_LINE=$(git ls-remote "$REMOTE_URL" "refs/heads/brightfire/$p" 2>/dev/null | head -n1)
  if [ -z "$LS_LINE" ]; then
    echo "::warning::brightfire/$p not on remote (ls-remote returned nothing); skipping"
    continue
  fi
  TIP=$(echo "$LS_LINE" | awk '{print $1}')
  SHORT="${TIP:0:10}"
  if python3 scripts/bf/update-patch-entry.py "$PATCHES_FILE" "$p" "$SHORT" ""; then
    UPDATED_COUNT=$((UPDATED_COUNT + 1))
    UPDATED_LIST="${UPDATED_LIST}${UPDATED_LIST:+, }$p->$SHORT"
  fi
done

git add "$PATCHES_FILE"
if git diff --cached --quiet; then
  echo "refresh_branch_heads: all active-patch HEADs already current in manifest; nothing to push."
  exit 0
fi
git -c commit.gpgsign=false commit -m "ci: refresh manifest patch HEADs via ls-remote ($UPDATED_LIST)"
git push origin brightfire/ci
echo "refresh_branch_heads: refreshed $UPDATED_COUNT entries and pushed brightfire/ci."
EOF

PATH="$SHIM_DIR:$PATH" bash "$DRIVER"

# ----- Assertions -----
fail() { echo "FAIL: $*" >&2; exit 1; }

grep -q '\*\*Branch HEAD commit:\*\* `1111111111`' BRIGHTFIRE_PATCHES.md \
  || fail "slack-mrkdwn SHA not updated to 1111111111"
grep -q '\*\*Branch HEAD commit:\*\* `2222222222`' BRIGHTFIRE_PATCHES.md \
  || fail "xgw SHA not updated to 2222222222"
grep -q '\*\*Source PR:\*\* #42' BRIGHTFIRE_PATCHES.md \
  || fail "Source PR for slack-mrkdwn was clobbered (expected #42 preserved)"
grep -q '\*\*Source PR:\*\* #17' BRIGHTFIRE_PATCHES.md \
  || fail "Source PR for xgw was clobbered (expected #17 preserved)"

# Idempotency: a second run with the manifest already current is a no-op.
SECOND_OUT=$(PATH="$SHIM_DIR:$PATH" bash "$DRIVER")
echo "$SECOND_OUT" | grep -q "nothing to push" \
  || fail "second run should be a no-op (got: $SECOND_OUT)"

echo "OK: refresh_branch_heads workflow block updates SHAs, preserves Source PRs, and is idempotent."
