#!/usr/bin/env python3
"""Update an existing patch entry in BRIGHTFIRE_PATCHES.md.

Called by the BF: Register Patch workflow when a patch is already registered.
Updates the Branch HEAD commit and the last-updated date.

Idempotent per-entry: when the recorded Branch HEAD SHA already equals
commit_short, no fields are rewritten (SHA, Source PR, Last updated are all
left unchanged) and the script exits 0 with a no-op message.

Usage:
    python3 update-patch-entry.py \\
        --file BRIGHTFIRE_PATCHES.md \\
        --patch sessions-history-archived \\
        --commit-sha 93987583f9 \\
        [--pr 39 | --pr "#39" | --pr https://github.com/brightfire/openclaw/pull/39]

    Short forms: -f / -p / -c for --file / --patch / --commit-sha.

If --pr is omitted, empty (""), or "0" (or any integer-zero form), the Source
PR field is left untouched. This is the 'catch-up sync' mode — brings the
recorded SHA current after a direct push to the patch branch without
overwriting the historical PR audit trail.

The '0'/empty conflation exists because workflow_dispatch defaulted `pr_number`
to 0 historically, and re-dispatching with that default would silently wipe
every patch's real Source PR to `#0`. Empty and zero both now mean 'preserve';
the script emits a single debug line to stderr noting the preserve, and the
caller can pass a non-zero PR number to actually update the field.

Source PR refs are written as full URLs to keep the manifest unambiguous about
which repo a PR belongs to (Brightfire fork vs. upstream openclaw vs. anything
else). When the caller passes a bare `N` or `#N`, it is defaulted to
`https://github.com/brightfire/openclaw/pull/N`. Full URLs (http:// or https://)
are written through unchanged so cross-repo refs (e.g. upstream openclaw PRs)
are honoured. See `_normalize_pr_ref()`.
"""

import argparse
import re
import sys
from datetime import date

# Default repo for bare PR numbers. Brightfire fork is the assumed owner of
# any short ref (`123` or `#123`) since that's where canonical patch branches
# live. Cross-repo refs MUST be passed as full URLs by the caller.
_DEFAULT_PR_REPO_URL = "https://github.com/brightfire/openclaw"


def _normalize_pr_ref(value):
    """Normalize a Source PR ref for writing into BRIGHTFIRE_PATCHES.md.

    Returns:
        None when the value should be treated as 'preserve existing Source PR'
        (empty, missing, `0`, `#0`, `#`, whitespace, or any integer-zero form).
        The original value unchanged when it's already a full http(s) URL
        (so cross-repo refs like upstream openclaw PRs are honoured).
        `https://github.com/brightfire/openclaw/pull/<N>` for bare `N` or `#N`
        (the Brightfire fork is the default owner of short refs).

    Examples:
        _normalize_pr_ref("")    -> None
        _normalize_pr_ref("0")   -> None
        _normalize_pr_ref("#0")  -> None
        _normalize_pr_ref("#")   -> None
        _normalize_pr_ref("24")  -> "https://github.com/brightfire/openclaw/pull/24"
        _normalize_pr_ref("#24") -> "https://github.com/brightfire/openclaw/pull/24"
        _normalize_pr_ref("https://github.com/openclaw/openclaw/pull/51067")
            -> "https://github.com/openclaw/openclaw/pull/51067"
    """
    if value is None:
        return None
    stripped = value.strip()
    if stripped == "" or stripped == "#":
        return None
    # Full URLs (http:// or https://) — pass through unchanged so cross-repo
    # refs like upstream openclaw PRs survive.
    if stripped.startswith("http://") or stripped.startswith("https://"):
        return stripped
    # Strip a single leading `#` for `#N` form.
    if stripped.startswith("#"):
        stripped = stripped[1:].strip()
        if stripped == "":
            return None
    # Pure integer? Treat 0 as preserve, anything else as a Brightfire fork PR.
    try:
        n = int(stripped)
    except ValueError:
        # Non-numeric, non-URL — return as-is. Lets callers pass through
        # unusual values (e.g. multi-PR composites) without mangling them,
        # though in practice the workflow only feeds bare numbers and URLs.
        return stripped
    if n == 0:
        return None
    return f"{_DEFAULT_PR_REPO_URL}/pull/{n}"


def main():
    parser = argparse.ArgumentParser(
        description="Update an existing patch entry in BRIGHTFIRE_PATCHES.md.",
    )
    parser.add_argument(
        "-f", "--file",
        required=True,
        metavar="PATCHES_FILE",
        help="Path to BRIGHTFIRE_PATCHES.md.",
    )
    parser.add_argument(
        "-p", "--patch",
        required=True,
        metavar="PATCH_NAME",
        help="Patch name (without brightfire/ prefix, e.g. sessions-history-archived).",
    )
    parser.add_argument(
        "-c", "--commit-sha",
        required=True,
        metavar="COMMIT_SHORT",
        help="Short (10-char) Branch HEAD commit SHA.",
    )
    parser.add_argument(
        "--pr",
        default=None,
        metavar="PR_REF",
        help=(
            "Source PR ref. Accepts a bare number (24), #N form (#24), or a "
            "full URL. Bare/\\#N is resolved to the Brightfire fork URL. "
            "Omit (or pass empty/0/#0) to preserve the existing Source PR."
        ),
    )
    args = parser.parse_args()

    patches_file = args.file
    patch_name = args.patch
    commit_short = args.commit_sha
    pr_number = args.pr  # None when --pr is omitted; str (possibly "") when provided
    today = date.today().isoformat()
    branch_pattern = f"brightfire/{patch_name}"

    with open(patches_file, "r") as f:
        content = f.read()

    # Split on top-level "## " section boundaries (preserve leading text before first ##)
    parts = re.split(r"(?=^## )", content, flags=re.MULTILINE)

    updated = False
    noop = False
    new_parts = []
    for part in parts:
        if branch_pattern in part and "**Canonical branch:**" in part:
            # Extract the currently recorded Branch HEAD SHA for idempotency check.
            existing_sha_match = re.search(
                r"\*\*Branch HEAD commit:\*\*\s*`([^`]*)`",
                part,
            )
            existing_sha = existing_sha_match.group(1) if existing_sha_match else None

            if existing_sha == commit_short:
                # SHA already matches — skip all mutations to keep the entry
                # byte-identical (no Last updated bump, no Source PR overwrite).
                # This makes sync_all truly no-op when all patch tips are current.
                updated = True
                noop = True
                new_parts.append(part)
                print(f"No changes for {branch_pattern}: commit={commit_short} already recorded")
                continue

            # Update Squashed commit (source)
            part = re.sub(
                r"(\*\*Branch HEAD commit:\*\*\s*)(`[^`]*`|[^\n]*)",
                lambda m: m.group(1) + f"`{commit_short}`",
                part,
            )
            # Update Source PR — but only when pr_number is non-empty AND
            # non-zero. The catch-up sync flow passes an empty string and the
            # historical workflow_dispatch default of 0 both mean 'preserve'
            # so we don't clobber the historical Source PR with stale data.
            #
            # Short refs (bare `N` / `#N`) are normalized to a full Brightfire
            # fork URL so the manifest always shows where the PR lives. Full
            # URLs (cross-repo refs) are written through unchanged.
            normalized_pr = _normalize_pr_ref(pr_number)
            if normalized_pr is not None:
                part = re.sub(
                    r"(\*\*Source PR:\*\*\s*)([^\n]*)",
                    lambda m: m.group(1) + normalized_pr,
                    part,
                )
            elif pr_number is not None and pr_number.strip() not in ("", "#"):
                # Caller passed something (e.g. "0" / "#0") that resolved to
                # preserve — emit a debug line so the workflow log explains why
                # Source PR didn't change. Empty/omitted is the normal catch-up
                # path and stays silent.
                print(
                    f"DEBUG: pr={pr_number!r} treated as preserve; Source PR for {branch_pattern} left unchanged",
                    file=sys.stderr,
                )
            # Update or insert Last updated
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
            updated = True
        new_parts.append(part)

    if not updated:
        print(f"ERROR: Could not find section for {branch_pattern}", file=sys.stderr)
        sys.exit(1)

    with open(patches_file, "w") as f:
        f.write("".join(new_parts))

    if noop:
        # Message already printed inside the loop; nothing more to emit.
        return

    normalized_pr = _normalize_pr_ref(pr_number)
    if normalized_pr is None:
        print(f"Updated entry for {branch_pattern}: commit={commit_short} (Source PR unchanged)")
    else:
        print(f"Updated entry for {branch_pattern}: commit={commit_short}, PR={normalized_pr}")


if __name__ == "__main__":
    main()
