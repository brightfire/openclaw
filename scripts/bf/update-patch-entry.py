#!/usr/bin/env python3
"""Mutate BRIGHTFIRE_PATCHES.md — the only writer for the patch manifest.

Owns four modes, all dispatched via argparse:

  1. Update existing entry (or create new one if missing):
       update-patch-entry.py -f BRIGHTFIRE_PATCHES.md \\
         --patch sessions-history-archived --commit-sha 93987583f9 [--pr 39]

  2. Create new entry (auto-detected from --patch missing in manifest);
     optional title via --pr-title (conventional-commit prefixes stripped):
       update-patch-entry.py -f BRIGHTFIRE_PATCHES.md \\
         --patch my-new-patch --commit-sha abcd1234ef --pr 42 \\
         --pr-title "feat: my new feature"

  3. Refresh ONE entry's HEAD via `git ls-remote origin
     refs/heads/brightfire/<patch>` — Source PR always preserved:
       update-patch-entry.py -f BRIGHTFIRE_PATCHES.md \\
         --refresh --patch sessions-history-archived

  4. Refresh EVERY active entry's HEAD via ls-remote — Source PR always
     preserved on all entries:
       update-patch-entry.py -f BRIGHTFIRE_PATCHES.md --refresh --all

Responsibilities are deliberately narrow:

  - Writes the manifest file in place. That is it.
  - Does NOT run `git commit` or `git push`.
  - Does NOT print commit-message-shaped strings for the workflow to consume.
  - Does NOT read environment variables — every input is an explicit CLI flag.
  - The caller (the workflow) is responsible for staging, committing, and
    pushing the change.

PR normalization:

  --pr accepts a bare number (`24`), `#N` form (`#24`), or a full URL.
  Bare/`#N` is resolved to `https://github.com/brightfire/openclaw/pull/<N>`.
  Omit / empty / `0` / `#0` mean 'preserve existing Source PR' (catch-up
  sync). This 0-conflation exists because workflow_dispatch defaulted
  `pr_number` to 0 historically; both empty and zero now mean 'preserve'.

In `--refresh` modes, `--pr` is never accepted (Source PR is always
preserved).

Idempotency:

  Update path is idempotent per entry: if the recorded Branch HEAD SHA
  already equals --commit-sha, no fields are rewritten (SHA, Source PR,
  Last updated all left byte-identical) and the script logs a no-op line.

  In `--refresh --all`, individual no-ops are silent (so we don't spam
  one line per current patch); a single summary line is printed at the
  end.
"""

import argparse
import re
import subprocess
import sys
from datetime import date

# Default repo for bare PR numbers. Brightfire fork is the assumed owner of
# any short ref (`123` or `#123`) since that's where canonical patch branches
# live. Cross-repo refs MUST be passed as full URLs by the caller.
_DEFAULT_PR_REPO_URL = "https://github.com/brightfire/openclaw"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_pr_ref(value):
    """Normalize a Source PR ref for writing into BRIGHTFIRE_PATCHES.md.

    Returns:
        None when the value should be treated as 'preserve existing Source PR'
        (empty, missing, `0`, `#0`, `#`, whitespace, or any integer-zero form).
        The original value unchanged when it's already a full http(s) URL
        (so cross-repo refs like upstream openclaw PRs are honoured).
        `https://github.com/brightfire/openclaw/pull/<N>` for bare `N` or `#N`
        (the Brightfire fork is the default owner of short refs).
    """
    if value is None:
        return None
    stripped = value.strip()
    if stripped == "" or stripped == "#":
        return None
    if stripped.startswith("http://") or stripped.startswith("https://"):
        return stripped
    if stripped.startswith("#"):
        stripped = stripped[1:].strip()
        if stripped == "":
            return None
    try:
        n = int(stripped)
    except ValueError:
        # Non-numeric, non-URL — return as-is. Lets callers pass through
        # unusual values without mangling, though in practice the workflow
        # only feeds bare numbers and URLs.
        return stripped
    if n == 0:
        return None
    return f"{_DEFAULT_PR_REPO_URL}/pull/{n}"


def _parse_active_patches(content):
    """Return list of active patch names (no `brightfire/` prefix).

    Mirrors scripts/bf/parse-patches.py's active-list semantics: a patch is
    active when Status=active and Reapply!=no. parse-patches.py is still
    the source of truth for bf-build-stable.yml; this in-process copy
    exists so update-patch-entry.py is self-contained for `--refresh --all`.
    """
    active = []
    current_patch = None
    current_status = "active"
    current_reapply = None

    for line in content.split("\n"):
        if re.match(r"^\s*##\s+[A-Z]", line):
            if current_patch and current_status == "active" and current_reapply != "no":
                active.append(current_patch)
            current_patch = None
            current_status = "active"
            current_reapply = None

        m = re.match(r"\s*-\s*\*\*Canonical branch:\*\*\s*`brightfire/([^`]+)`", line)
        if m:
            current_patch = m.group(1)

        m = re.match(r"\s*-\s*\*\*Status:\*\*\s*(\w+)", line)
        if m:
            current_status = m.group(1)

        m = re.match(r"\s*-\s*\*\*Reapply:\*\*\s*(\w+)", line)
        if m:
            current_reapply = m.group(1)

    if current_patch and current_status == "active" and current_reapply != "no":
        active.append(current_patch)

    return active


def _resolve_branch_head(patch_name):
    """Resolve the HEAD short SHA of `brightfire/<patch_name>` on origin.

    Uses `git ls-remote origin refs/heads/brightfire/<patch>` — no fetch.
    Returns the 10-char short SHA. Raises RuntimeError when the branch
    isn't on origin or git fails.
    """
    ref = f"refs/heads/brightfire/{patch_name}"
    try:
        result = subprocess.run(
            ["git", "ls-remote", "origin", ref],
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"git ls-remote failed for {ref}: {exc.stderr.strip() or exc}"
        ) from exc
    out = result.stdout.strip()
    if not out:
        raise RuntimeError(f"brightfire/{patch_name} not found on origin (ls-remote empty)")
    first_line = out.splitlines()[0]
    sha = first_line.split()[0]
    return sha[:10]


def _strip_conventional_prefix(title):
    """Strip a leading `feat:` / `fix:` / `doc:` / `docs:` from a PR title."""
    if not title:
        return ""
    return re.sub(r"^(feat|fix|docs?)\s*:\s*", "", title)


# ---------------------------------------------------------------------------
# Entry-level mutators
# ---------------------------------------------------------------------------


def _update_entry(content, patch_name, commit_short, pr_value):
    """Update an existing patch entry's Branch HEAD / Source PR / Last updated.

    Args:
        content: full manifest text.
        patch_name: patch name without the `brightfire/` prefix.
        commit_short: 10-char short SHA to record.
        pr_value: raw --pr value (may be None for 'preserve'). Normalized
            via `_normalize_pr_ref()`; only written when non-None.

    Returns:
        (new_content, did_change, found_entry)
          new_content: rewritten manifest text (== content when nothing changed).
          did_change: True when at least one field was rewritten.
          found_entry: True when a matching section was located in the file.
    """
    today = date.today().isoformat()
    branch_pattern = f"brightfire/{patch_name}"

    parts = re.split(r"(?=^## )", content, flags=re.MULTILINE)
    found = False
    did_change = False
    new_parts = []

    for part in parts:
        if branch_pattern in part and "**Canonical branch:**" in part:
            found = True
            existing_sha_match = re.search(
                r"\*\*Branch HEAD commit:\*\*\s*`([^`]*)`",
                part,
            )
            existing_sha = existing_sha_match.group(1) if existing_sha_match else None

            normalized_pr = _normalize_pr_ref(pr_value)

            # Idempotency: same SHA AND no Source PR change → leave the
            # entry byte-identical (no Last updated bump either).
            if existing_sha == commit_short and normalized_pr is None:
                new_parts.append(part)
                continue

            # Branch HEAD commit
            part = re.sub(
                r"(\*\*Branch HEAD commit:\*\*\s*)(`[^`]*`|[^\n]*)",
                lambda m: m.group(1) + f"`{commit_short}`",
                part,
            )
            # Source PR — only when caller actually provided one.
            if normalized_pr is not None:
                part = re.sub(
                    r"(\*\*Source PR:\*\*\s*)([^\n]*)",
                    lambda m: m.group(1) + normalized_pr,
                    part,
                )
            elif pr_value is not None and pr_value.strip() not in ("", "#"):
                # Caller passed something (e.g. "0"/"#0") that resolved to
                # preserve — emit a debug line so the log explains why
                # Source PR didn't change. Empty/omitted stays silent.
                print(
                    f"DEBUG: pr={pr_value!r} treated as preserve; Source PR for {branch_pattern} left unchanged",
                    file=sys.stderr,
                )
            # Last updated
            if "**Last updated:**" in part:
                part = re.sub(
                    r"(\*\*Last updated:\*\*\s*)([^\n]*)",
                    lambda m: m.group(1) + today,
                    part,
                )
            else:
                part = re.sub(
                    r"(\*\*Source PR:\*\*\s*[^\n]*\n)",
                    lambda m: m.group(0) + f"- **Last updated:** {today}\n",
                    part,
                )
            did_change = True
        new_parts.append(part)

    return "".join(new_parts), did_change, found


def _append_new_entry(content, patch_name, commit_short, pr_value, pr_title):
    """Append a fresh manifest section for a brand-new patch."""
    title = _strip_conventional_prefix(pr_title) or "Manual registration"
    normalized_pr = _normalize_pr_ref(pr_value)
    source_pr_field = normalized_pr if normalized_pr is not None else "—"

    # The manifest's existing sections end without a trailing blank line in
    # some places, so we always inject a leading newline to play safe.
    block_lines = [
        "",
        f"## {title}",
        "",
        "- **Status:** active",
        "- **Reapply:** yes",
        "- **Stable branch first merged into:** TBD",
        f"- **Canonical branch:** `brightfire/{patch_name}`",
        f"- **Branch HEAD commit:** `{commit_short}`",
        f"- **Source PR:** {source_pr_field}",
        "",
        "### Rationale",
        "",
        "_Add description of what this patch does and why._",
        "",
        "### Files touched",
        "",
        "TBD — update after first stable merge",
        "",
        "### Upgrade guidance",
        "",
        "_Describe upstream changes that have historically conflicted and how they were resolved. Patches are absorbed by `bf-build-stable` via squash-merge of the canonical branch — do not prescribe `git cherry-pick` here._",
        "",
    ]
    return content + "\n".join(block_lines)


def _refresh_one(content, patch_name):
    """Resolve the patch's HEAD via ls-remote and update the manifest entry.

    Source PR is always preserved (this is the refresh contract).

    Returns:
        (new_content, did_change, short_sha)
    """
    short_sha = _resolve_branch_head(patch_name)
    new_content, did_change, found = _update_entry(
        content, patch_name, short_sha, pr_value=None
    )
    if not found:
        raise RuntimeError(
            f"--refresh --patch {patch_name}: no entry found in manifest"
        )
    return new_content, did_change, short_sha


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser():
    parser = argparse.ArgumentParser(
        description="Mutate BRIGHTFIRE_PATCHES.md (the only writer for the patch manifest).",
    )
    parser.add_argument(
        "-f", "--file",
        required=True,
        metavar="PATCHES_FILE",
        help="Path to BRIGHTFIRE_PATCHES.md.",
    )
    parser.add_argument(
        "-p", "--patch",
        metavar="PATCH_NAME",
        help="Patch name without the brightfire/ prefix (e.g. sessions-history-archived). "
             "Required in single-entry modes and in `--refresh --patch`. Mutually exclusive with --all.",
    )
    parser.add_argument(
        "-c", "--commit-sha",
        metavar="COMMIT_SHORT",
        help="Short (10-char) Branch HEAD commit SHA. Omit to resolve via "
             "`git ls-remote origin refs/heads/brightfire/<patch>`.",
    )
    parser.add_argument(
        "--pr",
        default=None,
        metavar="PR_REF",
        help="Source PR ref. Accepts a bare number (24), #N form (#24), or full URL. "
             "Bare/#N is resolved to the Brightfire fork URL. Omit (or pass empty/0/#0) "
             "to preserve the existing Source PR. Not accepted in --refresh modes.",
    )
    parser.add_argument(
        "--pr-title",
        default=None,
        metavar="PR_TITLE",
        help="PR title used when creating a NEW entry. Ignored when updating an "
             "existing entry. Conventional-commit prefixes (feat:/fix:/docs:) are stripped.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Refresh mode: resolve Branch HEAD via `git ls-remote` instead of "
             "taking it from --commit-sha. Source PR is always preserved. Requires "
             "either --patch <name> or --all.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="With --refresh: walk EVERY active entry in the manifest and refresh "
             "each via ls-remote. Mutually exclusive with --patch.",
    )
    return parser


def _validate_args(args, parser):
    if args.all and not args.refresh:
        parser.error("--all requires --refresh")
    if args.refresh:
        if args.commit_sha is not None:
            parser.error("--refresh cannot be combined with --commit-sha (HEAD is resolved via ls-remote)")
        if args.pr is not None:
            parser.error("--refresh cannot be combined with --pr (Source PR is always preserved)")
        if args.all and args.patch:
            parser.error("--all and --patch are mutually exclusive")
        if not args.all and not args.patch:
            parser.error("--refresh requires either --patch <name> or --all")
    else:
        # Single-entry update / new-entry path.
        if not args.patch:
            parser.error("--patch <name> is required (or use --refresh --all)")
        # --commit-sha is optional: when omitted, the SHA is resolved via
        # `git ls-remote origin refs/heads/brightfire/<patch>` — same as
        # `--refresh --patch`. Lets manual workflow_dispatch (no merge SHA)
        # invoke the same code path.


def _run_refresh_all(content, patches_file):
    patches = _parse_active_patches(content)
    if not patches:
        print("refresh-all: no active patches found in manifest; nothing to do.")
        return 0
    updated = []
    skipped = []
    for p in patches:
        try:
            content, did_change, short = _refresh_one(content, p)
        except RuntimeError as exc:
            print(f"::warning::{exc}", file=sys.stderr)
            continue
        if did_change:
            updated.append(f"{p}->{short}")
        else:
            skipped.append(p)
    with open(patches_file, "w") as f:
        f.write(content)
    if updated:
        print(f"refresh-all: updated {len(updated)} entries: {', '.join(updated)}")
    if skipped:
        print(f"refresh-all: {len(skipped)} entries already current (no-op).")
    if not updated and not skipped:
        print("refresh-all: nothing refreshed.")
    return 0


def main():
    parser = _build_parser()
    args = parser.parse_args()
    _validate_args(args, parser)

    patches_file = args.file
    with open(patches_file, "r") as f:
        content = f.read()

    # --refresh --all
    if args.refresh and args.all:
        return _run_refresh_all(content, patches_file)

    # --refresh --patch X
    if args.refresh and args.patch:
        new_content, did_change, short = _refresh_one(content, args.patch)
        with open(patches_file, "w") as f:
            f.write(new_content)
        if did_change:
            print(f"Refreshed entry for brightfire/{args.patch}: commit={short} (Source PR preserved)")
        else:
            print(f"No changes for brightfire/{args.patch}: commit={short} already recorded")
        return 0

    # Single-entry update; auto-fall-through to new-entry append when missing.
    patch_name = args.patch
    pr_value = args.pr
    pr_title = args.pr_title

    if args.commit_sha:
        commit_short = args.commit_sha
    else:
        # --patch X with no --commit-sha → resolve via ls-remote. This
        # behaves like `--refresh --patch X` except that --pr can still
        # be supplied (the refresh mode forbids --pr; this mode does not).
        commit_short = _resolve_branch_head(patch_name)

    new_content, did_change, found = _update_entry(content, patch_name, commit_short, pr_value)
    if found:
        with open(patches_file, "w") as f:
            f.write(new_content)
        normalized_pr = _normalize_pr_ref(pr_value)
        if not did_change:
            print(f"No changes for brightfire/{patch_name}: commit={commit_short} already recorded")
        elif normalized_pr is None:
            print(f"Updated entry for brightfire/{patch_name}: commit={commit_short} (Source PR unchanged)")
        else:
            print(f"Updated entry for brightfire/{patch_name}: commit={commit_short}, PR={normalized_pr}")
        return 0

    # No existing entry → append a new one.
    new_content = _append_new_entry(content, patch_name, commit_short, pr_value, pr_title)
    with open(patches_file, "w") as f:
        f.write(new_content)
    normalized_pr = _normalize_pr_ref(pr_value)
    source_pr = normalized_pr if normalized_pr is not None else "—"
    print(f"Created new entry for brightfire/{patch_name}: commit={commit_short}, Source PR={source_pr}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
