# New-entry template for BRIGHTFIRE_PATCHES.md

This file is the literal scaffolding that `scripts/bf/update-patch-entry.py`
appends when it encounters a previously-unseen `brightfire/<base-commit>/<name>` patch
branch. Editing this template changes the stub future auto-registered
entries get.

Two pieces are appended in this exact order:

1. A new row in the `## Patches` table.
2. A new `## <Patch name>` section below all existing per-patch sections.

## Presence-in-file is the apply signal

Every row in the Patches table is applied by `bf-build-stable`. There is no
`Status` or `Reapply` column — the row existing in the file means it will be
included on the next rebuild. To stop applying a patch, **remove its row from
the table and delete (or archive) its section**. If you want to track _why_
you dropped it, record that decision in the git commit message or in a
separate notes file.

## Field reference

These are the columns in the Patches table and the placeholders the script
substitutes when registering a new patch. Every field is hand-editable later
either by maintainers (prose fields) or by the register-patch workflow
(Branch HEAD, Source PR, Last updated).

| Field                                | What it means                                                                                                                                                                         | Who edits it                                                                                                                     | Allowed values                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name** (`{NAME}`)                  | Human-readable display name shown in the table and as the per-patch section heading. Derived from the PR title with conventional-commit prefix (`feat:` / `fix:` / `docs:`) stripped. | Maintainers may rename freely. The script never rewrites this.                                                                   | Free-form short name.                                                                                                                                                                                                                                            |
| **Canonical branch** (`{CANONICAL}`) | The `brightfire/<base-commit>/<name>` branch that holds the canonical commits for this patch. `bf-build-stable` reads this column to know which branch to squash-merge onto stable.   | Hand-edited only (renaming a branch requires a manual edit).                                                                     | Full branch path in the placeholder; the template wraps it as `` `{CANONICAL}` ``.                                                                                                                                                                               |
| **Branch HEAD** (`{COMMIT}`)         | 10-character short SHA of the canonical branch tip. Tracked so reviewers can see what state stable was built from without consulting GitHub.                                          | Auto-refreshed by `update-patch-entry.py` on every patch-PR merge (the register-patch workflow) and on `--refresh --all` sweeps. | 10 hex chars wrapped in backticks.                                                                                                                                                                                                                               |
| **Source PR** (`{SOURCE_PR}`)        | URL of the PR (or PRs) that introduced or last touched this patch. Audit trail for "why does this patch exist."                                                                       | Auto-written by `update-patch-entry.py` when a `--pr` is provided. Preserved on catch-up syncs (omitted / empty / `0` / `#0`).   | Full URL (e.g. `https://github.com/brightfire/openclaw/pull/N`), comma-separated list of URLs for multi-PR patches, or `—` if there is no PR. Bare `N` / `#N` is normalized by the tool to the Brightfire fork URL. Cross-repo refs must be passed as full URLs. |
| **Last updated** (`{TODAY}`)         | ISO date of the most recent change to this row. Useful as a "is this stale?" hint.                                                                                                    | Auto-bumped by `update-patch-entry.py` when Branch HEAD or Source PR changes (and never bumped when the row is byte-identical).  | `YYYY-MM-DD`.                                                                                                                                                                                                                                                    |

The per-patch section below the table carries the **prose** for each patch:

| Section                | What goes here                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `### Rationale`        | What problem this patch solves and a short summary of the approach. The "why this patch exists" answer. Audience: a future maintainer wondering whether they can drop it.                                                                                                                 |
| `### Files touched`    | Bullet list of source files this patch modifies, with a one-line note per file. Helps reviewers gauge conflict surface during upstream upgrades. Acceptable for early stubs: `TBD — update after first stable merge`.                                                                     |
| `### Upgrade guidance` | Notes on what tends to conflict when applying the patch onto a new base commit, and how those conflicts have historically been resolved. **Do not put `git cherry-pick <sha>` here** — canonical branches are recreated fresh on each new base, so SHAs go stale on every upgrade anyway. |

## Table row template

```
| {NAME} | `{CANONICAL}` | `{COMMIT}` | {SOURCE_PR} | {TODAY} |
```

## Section template

```
## {NAME}

(canonical: `{CANONICAL}`)

### Rationale

_Add description of what this patch does and why._

### Files touched

TBD — update after first stable merge

### Upgrade guidance

_Describe upstream changes that have historically conflicted and how they
were resolved. Patches are absorbed by `bf-build-stable` via squash-merge of
the canonical branch — do **not** prescribe `git cherry-pick` here. Describe
what tends to conflict and how to resolve it._
```
