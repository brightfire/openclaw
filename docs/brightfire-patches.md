---
summary: "How BRIGHTFIRE_PATCHES.md is maintained, what each column means, and the merge-not-rebase philosophy for patch branches"
title: "Brightfire patch registry"
read_when:
  - You are adding, deferring, or retiring a Brightfire patch
  - You are bringing a patch branch current with a new upstream tag
  - You are wiring CI/automation around BRIGHTFIRE_PATCHES.md
  - You are reviewing a PR that touches the manifest
---

`BRIGHTFIRE_PATCHES.md` (on the `brightfire/ci` branch) is the source of truth
for every Brightfire-specific patch that must be replayed onto each new
upstream stable release. This page documents how it is maintained, how to
read the table at the top of the file, the merge-not-rebase philosophy for
patch branches, and the procedure for adding a new entry.

## What this is

`BRIGHTFIRE_PATCHES.md` lives on the `brightfire/ci` branch — not on
`stable/*` or any patch branch. It contains:

1. A `## _meta` block with the pinned upstream tag that
   [`BF: Build Stable`](../.github/workflows/bf-build-stable.yml) rebuilds
   against.
2. A `## Patches` table that is **the** source of truth for every tool-edited
   field on every patch (Branch HEAD, Source PR, Last updated).
3. One `## <Patch name>` section per patch, carrying human prose only:
   Rationale, Files touched, Upgrade guidance.

The `## _meta` and `## Patches` blocks are mutated by automation. The
per-patch sections below the table are hand-edited.

### Patches table columns

| Column | Meaning |
| ------ | ------- |
| `Name` | Free-form display name. Matches the corresponding `## <Name>` section heading. |
| `Canonical branch` | `brightfire/<name>` — the patch's own branch on `origin`. Carries the patch's commits plus merge commits from each upstream tag the patch has been brought current with. |
| `Branch HEAD` | 10-char short SHA of the canonical branch's tip on `origin`. Auto-refreshed by `BF: Register Patch`. |
| `Source PR` | Full URL to the PR (e.g. `https://github.com/brightfire/openclaw/pull/N`). Cross-repo refs use the appropriate full URL. `—` when there is no PR. Cells may list multiple comma-separated URLs (e.g. for XGW). |
| `Last updated` | ISO date. Auto-bumped whenever Branch HEAD or Source PR changes. |

**Presence in the table is the apply signal.** Every row is included by
`BF: Build Stable` on the next rebuild. To stop applying a patch, remove its
row from the table (and delete or archive its section). Record the reason in
the git commit message or a separate notes file.

Each patch's per-section binding to its table row is the `(canonical:
brightfire/<name>)` line under the section heading. The tooling locates a
patch by matching that annotation against the `Canonical branch` cell — so the
heading text itself can drift freely without breaking automation.

## How patches are absorbed

[`BF: Build Stable`](../.github/workflows/bf-build-stable.yml) rebuilds
`stable/*` from scratch on every push to `brightfire/ci` that touches the
manifest. The flow:

1. Reset to the upstream tag in `_meta.Upstream version`.
2. Walk every row in the Patches table, in table order.
3. For each row, `git merge --squash <Canonical branch>` and commit, producing
   one squash-merge commit per patch on `stable/*`.
4. Tag the result and publish a GitHub release with the built tarball.

**No cherry-picking.** `BF: Build Stable` does not cherry-pick individual
commits. The Brightfire fork carries patches as whole branches, not as a list
of SHAs, because:

- The canonical branch's HEAD SHA changes on every upstream catch-up.
  Anything that pins a SHA goes stale immediately.
- Squash-merging the branch records the resolution of any conflicts that
  happened during the upstream-catch-up cycle, not on each rebuild.

For the same reasons, **don't put `git cherry-pick <sha>` in upgrade
guidance**. Upgrade guidance should describe *what tends to conflict and how
to resolve it*, not prescribe a commit-level workflow.

## Bringing a patch current with a new upstream tag

When a `brightfire/<patch>` branch needs to absorb a new upstream tag, we
**merge the tag into the patch branch** (`git merge v<new-tag>` on the
branch). We do **not** rebase the branch onto the new tag.

Why merge, not rebase:

- Each upstream catch-up produces real conflicts that need human or LLM
  judgment. Recording those resolutions as discrete merge commits gives a
  durable, reviewable audit trail — `git log` shows when each upstream tag
  was absorbed and `git show <merge-sha>` shows the conflict-resolution diff.
- Rebase would silently bake the resolutions into rewritten commits with no
  marker that a conflict was resolved at all, and would force-push the
  branch in the process.

The audit trail lives where it is useful (on the patch branch). The stable
history stays linear because `BF: Build Stable` always uses `git merge
--squash` — so a patch branch with internal merge commits still flattens
into one "apply patch" commit on `stable/*`.

The full upstream-upgrade procedure (which patches to walk, in what order,
and how to verify the result) is owned by the `openclaw-dev` skill. This
file just documents the philosophy.

## Adding a new patch

When [`BF: Register Patch`](../.github/workflows/bf-register-patch.yml) sees
a merged PR whose base branch is a `brightfire/<name>` that is not yet in the
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
- The `_meta.Upstream version` pin is edited by
  `scripts/bf/update-upstream-pin.py`, driven by the upstream-upgrade flow.

What you write by hand:

- New entries: the per-patch `## <Name>` section bodies (Rationale, Files
  touched, Upgrade guidance).
- Removing a patch: delete its row from the table and its `## <Name>` section.
  Record the reason in the git commit message or a separate notes file.
- Anywhere a Source PR cell carries multiple URLs or a non-default repo
  ref (the workflow only writes single Brightfire-fork URLs).
