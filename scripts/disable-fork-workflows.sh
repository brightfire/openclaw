#!/bin/bash
# Disable upstream-only workflows in the Brightfire fork.
# Run this after pulling from upstream to re-apply the fork policy.
#
# Strategy: move unwanted workflows to .github/workflows/disabled/
# so GitHub ignores them but files remain in version control.
# Easy to re-apply after upstream pulls: just rerun this script.
#
# Usage: scripts/disable-fork-workflows.sh

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/.."

WORKFLOWS_DIR=".github/workflows"
DISABLED_DIR="${WORKFLOWS_DIR}/disabled"
mkdir -p "$DISABLED_DIR"

# Upstream community management, release pipelines, docs infrastructure,
# provider integration tests, platform-specific scans, and on-demand
# workflows that serve no purpose in the Brightfire fork.
WORKFLOWS=(
    # GitHub App automation (upstream community management)
    auto-response.yml
    labeler.yml
    maintainer-command-reactions.yml
    mantis-discord-smoke.yml
    mantis-discord-status-reactions.yml
    clawsweeper-dispatch.yml
    stale.yml
    duplicate-after-merge.yml
    # Release pipeline (we don't publish upstream releases)
    docker-release.yml
    openclaw-npm-release.yml
    macos-release.yml
    openclaw-cross-os-release-checks-reusable.yml
    openclaw-release-checks.yml
    openclaw-release-publish.yml
    full-release-validation.yml
    plugin-npm-release.yml
    plugin-clawhub-release.yml
    plugin-prerelease.yml
    npm-telegram-beta-e2e.yml
    # Docs
    docs.yml
    docs-agent.yml
    docs-sync-publish.yml
    docs-translate-trigger-release.yml
    # QA Lab (burns credits testing upstream provider integrations)
    qa-live-transports-convex.yml
    # CodeQL platform variants (we only run Linux)
    codeql-android-critical-security.yml
    codeql-macos-critical-security.yml
    # Testbox / Blacksmith (upstream testing infrastructure)
    ci-build-artifacts-testbox.yml
    ci-check-testbox.yml
    windows-blacksmith-testbox.yml
    windows-testbox-probe.yml
    # Scheduled provider integration checks
    openclaw-scheduled-live-checks.yml
    openclaw-performance.yml
    # Misc not needed for our fork
    control-ui-locale-refresh.yml
    live-media-runner-image.yml
    install-smoke.yml
    crabbox-hydrate.yml
    test-performance-agent.yml
    package-acceptance.yml
    update-migration.yml
    opengrep-precise-full.yml
)

count=0
for wf in "${WORKFLOWS[@]}"; do
    src="${WORKFLOWS_DIR}/${wf}"
    dst="${DISABLED_DIR}/${wf}"
    if [[ -f "$src" ]]; then
        mv "$src" "$dst"
        echo "DISABLED: $wf"
        count=$((count + 1))
    elif [[ -f "$dst" ]]; then
        : # Already disabled
    else
        echo "NOT FOUND: $wf"
    fi
done

echo ""
echo "$count workflows disabled. Active:"
for f in ${WORKFLOWS_DIR}/*.yml; do
    echo "  $(basename "$f")"
done
