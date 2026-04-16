# Brightfire OpenClaw Fork Workflow

## Branch roles

- `stable/v2026.4.14`
  - Brightfire's deployable baseline for the upstream `v2026.4.14` release.
  - Only merge reviewed PRs here.
  - Do not commit experimental work directly here.

- `feature/*`
  - Brightfire-specific fixes and customizations.
  - Branch from the current `stable/*` branch.
  - Open PRs back into the matching `stable/*` branch.

## Current active branches

- `stable/v2026.4.14`
- `feature/context-estimate-compaction`

## Standard workflow

### 1. Start from a known stable upstream release

```bash
git fetch upstream --tags
git checkout -B stable/v2026.4.14 v2026.4.14
git push -u origin stable/v2026.4.14
```

### 2. Make Brightfire changes on a feature branch

```bash
git checkout -b feature/my-change stable/v2026.4.14
# make changes
git commit -m "fix: describe change"
git push -u origin feature/my-change
gh pr create --repo brightfire/openclaw --base stable/v2026.4.14 --head feature/my-change
```

### 3. Upgrade to a newer upstream stable release

```bash
git fetch upstream --tags
git checkout -B stable/v2026.4.15 v2026.4.15
git push -u origin stable/v2026.4.15

git checkout -b feature/context-estimate-compaction-v2026.4.15 stable/v2026.4.15
git cherry-pick <brightfire-feature-commit>
git push -u origin feature/context-estimate-compaction-v2026.4.15
gh pr create --repo brightfire/openclaw --base stable/v2026.4.15 --head feature/context-estimate-compaction-v2026.4.15
```

## Rules

- Do not base Brightfire work on upstream `main`.
- Use upstream release tags or another explicitly stable branch only.
- Do not push Brightfire patches directly onto `stable/*`; use PRs.
- Keep one stable branch per deployed upstream version.
- Close and delete obsolete feature branches after merge.

## Notes

The fork's GitHub default `main` may track upstream's moving head. Treat it as non-deployable unless intentionally repurposed.
