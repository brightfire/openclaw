# Disabled workflows

These workflows were moved here because they are unnecessary for the
Brightfire fork. See `scripts/disable-fork-workflows.sh` to re-apply
after upstream pulls.

Rough categories of disabled workflows:

- **Community management**: auto-response, labeler, maintainer commands,
  Discord status reactions, stale PRs, duplicates
- **Release pipeline**: Docker/NPM/macOS releases, plugin publishing
- **Docs**: docs sync, translation, docs agent, locale refresh
- **Provider integration tests**: scheduled live checks, QA Lab (burns
  credits)
- **Platform-specific scans**: CodeQL for Android/macOS (we run Linux)
- **Testbox/Blacksmith**: upstream testing infrastructure
- **Misc**: install-smoke, crabbox, test-performance, package-acceptance,
  update-migration, opengrep-full

Kept active: ci.yml, codeql.yml, opengrep-precise.yml,
sandbox-common-smoke.yml, workflow-sanity.yml, codeql-critical-quality.yml
(=manual-only), openclaw-live-and-e2e-checks-reusable.yml (=call-only).
