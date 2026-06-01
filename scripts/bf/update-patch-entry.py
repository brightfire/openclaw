#!/usr/bin/env python3
"""Update an existing patch entry in BRIGHTFIRE_PATCHES.md.

Called by the BF: Register Patch workflow when a patch is already registered.
Updates the Branch HEAD commit and the last-updated date.

Idempotent per-entry: when the recorded Branch HEAD SHA already equals
commit_short, no fields are rewritten (SHA, Source PR, Last updated are all
left unchanged) and the script exits 0 with a no-op message.

Usage:
    python3 update-patch-entry.py <patches_file> <patch_name> <commit_short> <pr_number>

If <pr_number> is empty ("") OR "0" (or any integer-zero form), the Source PR
field is left untouched. This is the 'catch-up sync' mode — brings the recorded
SHA current after a direct push to the patch branch without overwriting the
historical PR audit trail.

The '0'/empty conflation exists because workflow_dispatch defaulted `pr_number`
to 0 historically, and re-dispatching with that default would silently wipe
every patch's real Source PR to `#0`. Empty and zero both now mean 'preserve';
the script emits a single debug line to stderr noting the preserve, and the
caller can pass a non-zero PR number to actually update the field.
"""

import re
import sys
from datetime import date


def _is_preserve_pr(pr_number: str) -> bool:
    """Return True if pr_number should be treated as 'preserve existing Source PR'.

    Both an empty string and any integer-zero form ('0', '00', whitespace-only,
    etc.) are treated as preserve. This matches the workflow_dispatch quirk
    where the historical input default was 0, and catch-up re-dispatches that
    accept the default should not overwrite the historical Source PR with #0.
    Non-zero integers and any non-numeric string are taken at face value and
    written through to the manifest.
    """
    if pr_number is None:
        return True
    stripped = pr_number.strip()
    if stripped == "":
        return True
    try:
        return int(stripped) == 0
    except ValueError:
        return False


def main():
    if len(sys.argv) != 5:
        print(f"Usage: {sys.argv[0]} <patches_file> <patch_name> <commit_short> <pr_number>", file=sys.stderr)
        sys.exit(1)

    patches_file = sys.argv[1]
    patch_name = sys.argv[2]
    commit_short = sys.argv[3]
    pr_number = sys.argv[4]
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
            if not _is_preserve_pr(pr_number):
                part = re.sub(
                    r"(\*\*Source PR:\*\*\s*)([^\n]*)",
                    lambda m: m.group(1) + f"#{pr_number}",
                    part,
                )
            elif pr_number is not None and pr_number.strip() != "":
                # Non-empty but zero — emit a single debug line so the
                # workflow run log explains why Source PR didn't change.
                # Empty pr_number is the normal catch-up path and stays silent.
                print(
                    f"DEBUG: pr_number={pr_number!r} treated as preserve; Source PR for {branch_pattern} left unchanged",
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

    if _is_preserve_pr(pr_number):
        print(f"Updated entry for {branch_pattern}: commit={commit_short} (Source PR unchanged)")
    else:
        print(f"Updated entry for {branch_pattern}: commit={commit_short}, PR=#{pr_number}")


if __name__ == "__main__":
    main()
