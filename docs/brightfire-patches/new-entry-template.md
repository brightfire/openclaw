# New-entry template for BRIGHTFIRE_PATCHES.md

This file is the literal scaffolding that
`scripts/bf/update-patch-entry.py` appends when it encounters a previously-
unseen `brightfire/<name>` patch branch. Editing this template changes the
stub future auto-registered entries get.

Two pieces are appended in this exact order:

1. A new row in the `## Patches` table.
2. A new `## <Patch name>` section below all existing per-patch sections.

The script substitutes the following placeholders:

- `{NAME}` — display name (PR title with conventional-commit prefix stripped).
- `{CANONICAL}` — patch name without the `brightfire/` prefix.
- `{COMMIT}` — 10-char short SHA of the canonical branch HEAD.
- `{SOURCE_PR}` — full Source PR URL, or `—` when none.
- `{TODAY}` — ISO date the entry is appended on.

## Table row template

```
| {NAME} | `brightfire/{CANONICAL}` | `{COMMIT}` | {SOURCE_PR} | TBD | active | yes | {TODAY} |
```

## Section template

```
## {NAME}

(canonical: `brightfire/{CANONICAL}`)

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
