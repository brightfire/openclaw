---
summary: "How BRIGHTFIRE_PATCHES.md is maintained, what each column means, and the patch-branch model (applied fresh per base commit)"
title: "Brightfire patch registry"
read_when:
  - You are adding, deferring, or retiring a Brightfire patch
  - You are bringing a patch current with a new upstream base commit
  - You are wiring CI/automation around BRIGHTFIRE_PATCHES.md
  - You are reviewing a PR that touches the manifest
---

`BRIGHTFIRE_PATCHES.md` (on the `brightfire/ci` branch) is the source of truth
for every Brightfire-specific patch that must be replayed onto each new
upstream stable release. This page documents how it is maintained, how to
read the table at the top of the file, the patch-branch model, and the
procedure for adding a new entry.

## What this is

`BRIGHTFIRE_PATCHES.md` lives on the `brightfire/ci` branch — not on
`stable/*` or any patch branch. It contains:

1. A `## _meta` block with the base branch and base commit that
   [`BF: Build Stable`](../.github/workflows/bf-build-stable.yml) rebuilds
   against.
2. A `## Patches` table that is **the** source of truth for every tool-edited
   field on every patch (Branch HEAD, Source PR, Last updated).
3. One `## <Patch name>` section per patch, carrying human prose only:
   Rationale, Files touched, Upgrade guidance.

The `## _meta` and `## Patches` blocks are mutated by automation. The
per-patch sections below the table are hand-edited.

### Patches table columns

| Column             | Meaning                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Name`             | Free-form display name. Matches the corresponding `## <Name>` section heading.                                                                                                                                                                           |
| `Canonical branch` | `brightfire/<base-commit>/<name>` — the patch's canonical branch on `origin` for a specific base commit. Created fresh per upgrade by applying the patch from the previous base's branch onto the new base commit. Old-base branches remain for history. |
| `Branch HEAD`      | 10-char short SHA of the canonical branch's tip on `origin`. Auto-refreshed by `BF: Register Patch`.                                                                                                                                                     |
| `Source PR`        | Full URL to the PR (e.g. `https://github.com/brightfire/openclaw/pull/N`). Cross-repo refs use the appropriate full URL. `—` when there is no PR. Cells may list multiple comma-separated URLs (e.g. for XGW).                                           |
| `Last updated`     | ISO date. Auto-bumped whenever Branch HEAD or Source PR changes.                                                                                                                                                                                         |

**Presence in the table is the apply signal.** Every row is included by
`BF: Build Stable` on the next rebuild. To stop applying a patch, remove its
row from the table (and delete or archive its section). Record the reason in
the git commit message or a separate notes file.

Each patch's per-section binding to its table row is the `(canonical:
brightfire/<base-commit>/<name>)` line under the section heading. The tooling locates a
patch by matching that annotation against the `Canonical branch` cell — so the
heading text itself can drift freely without breaking automation.

## How patches are absorbed

[`BF: Build Stable`](../.github/workflows/bf-build-stable.yml) rebuilds
`stable/*` from scratch on every push to `brightfire/ci` that touches the
manifest. The flow:

1. Reset to the base commit in `_meta` (`Base branch` + `Base commit`).
2. Walk every row in the Patches table, in table order.
3. For each row, `git merge --squash <Canonical branch>` and commit, producing
   one squash-merge commit per patch on `stable/*`.
4. Tag the result and publish a GitHub release with the built tarball.

**No SHA lists.** `BF: Build Stable` does not cherry-pick individual
commits; it applies whole branches in manifest order. Canonical branch HEAD
SHAs change on every upgrade (branches are recreated fresh on each new base),
so anything that pins a SHA goes stale immediately. For the same reasons,
**don't put `git cherry-pick <sha>` in upgrade guidance**. Upgrade guidance
should describe _what tends to conflict and how to resolve it_, not
prescribe a commit-level workflow.

## Bringing a patch current with a new upstream release

Patches are **not** merged or rebased forward. Each upgrade creates new
`brightfire/<new-base-commit>/<name>` branches by applying the patch
changes from the previous base's branch onto the new base commit
(diff-and-apply, with cherry-pick as the per-commit fallback when the diff
does not apply cleanly).

Why apply-fresh, not merge:

- Merging upstream into a patch branch can silently overwrite patch
  changes with upstream's versions of the same files — the exact failure
  mode this model eliminates.
- Old-base branches remain on `origin` for history but are no longer
  referenced by the manifest; recovery is simply "the old branch still
  exists."

The full upstream-upgrade procedure (which patches to walk, in what order,
and how to verify the result) is owned by the `openclaw-dev` skill. This
file just documents the philosophy.

## Adding a new patch

When [`BF: Register Patch`](../.github/workflows/bf-register-patch.yml) sees
a merged PR whose base branch is a `brightfire/<base-commit>/<name>` that is not yet in the
manifest, it appends a fresh row to the Patches table and a stub section
using the template at
[`docs/brightfire-patches/new-entry-template.md`](brightfire-patches/new-entry-template.md).

You can also append entries by hand — copy the template, fill in the Branch
HEAD, Source PR, and a real Rationale / Files touched / Upgrade guidance.
Don't forget to add a new row to the Patches table as well; the table is
where build-stable looks.

## Maintenance

What automation writes:

- The Patches table cells (`Branch HEAD`, `Source PR`, `Last updated`) are
  edited by `scripts/bf/update-patch-entry.py`, driven by the `BF: Register
Patch` workflow.
- The `_meta` block (Base branch, Base commit, Upstream version) is
  updated by the upstream-upgrade runbook (`openclaw-dev` skill);
  `scripts/bf/update-upstream-pin.py` bumps just the `Upstream version` line.

What you write by hand:

- New entries: the per-patch `## <Name>` section bodies (Rationale, Files
  touched, Upgrade guidance).
- Removing a patch: delete its row from the table and its `## <Name>` section.
  Record the reason in the git commit message or a separate notes file.
- Anywhere a Source PR cell carries multiple URLs or a non-default repo
  ref (the workflow only writes single Brightfire-fork URLs).
