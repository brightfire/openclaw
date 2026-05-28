#!/usr/bin/env python3
"""Update an existing patch entry in BRIGHTFIRE_PATCHES.md.

Called by the BF: Register Patch workflow when a patch is already registered.
Updates the squashed commit SHA, source PR number, and last-updated date.

Usage:
    python3 update-patch-entry.py <patches_file> <patch_name> <commit_short> <pr_number>
"""

import re
import sys
from datetime import date


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
    new_parts = []
    for part in parts:
        if branch_pattern in part and "**Canonical branch:**" in part:
            # Update Squashed commit (source)
            part = re.sub(
                r"(\*\*Squashed commit \(source\):\*\*\s*)(`[^`]*`|[^\n]*)",
                lambda m: m.group(1) + f"`{commit_short}`",
                part,
            )
            # Update Source PR
            part = re.sub(
                r"(\*\*Source PR:\*\*\s*)([^\n]*)",
                lambda m: m.group(1) + f"#{pr_number}",
                part,
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

    print(f"Updated entry for {branch_pattern}: commit={commit_short}, PR=#{pr_number}")


if __name__ == "__main__":
    main()
