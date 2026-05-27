#!/usr/bin/env python3
"""Parse BRIGHTFIRE_PATCHES.md and emit active branches for CI workflows.

Reads the patches manifest file and outputs a comma-separated list of
canonical branch names that have Status=active and Reapply!=no.

Usage: parse-patches.py [patches-file]
  patches-file defaults to BRIGHTFIRE_PATCHES.md

Outputs GitHub Actions step output format:
  ::set-output name=count::N
  ::set-output name=list::branch1,branch2,...
  And prints a human-readable summary to stdout.
"""

import re
import sys


def parse_patches(patches_file: str) -> list[str]:
    """Parse BRIGHTFIRE_PATCHES.md and return list of active patch branch names."""
    try:
        with open(patches_file, "r") as f:
            content = f.read()
    except FileNotFoundError:
        print(f"::error::{patches_file} not found", file=sys.stderr)
        sys.exit(1)

    active = []
    current_patch = None
    current_status = "active"
    current_reapply = None

    for line in content.split("\n"):
        # Detect new patch section header (## followed by non-space)
        if re.match(r"^\s*##\s+[A-Z]", line):
            if current_patch and current_status == "active" and current_reapply != "no":
                active.append(current_patch)
            current_patch = None
            current_status = "active"
            current_reapply = None

        # Canonical branch
        m = re.match(r"\s*-\s*\*\*Canonical branch\*\*:\s*`brightfire/([^`]+)`", line)
        if m:
            current_patch = m.group(1)

        # Status
        m = re.match(r"\s*-\s*\*\*Status\*\*:\s*(\w+)", line)
        if m:
            current_status = m.group(1)

        # Reapply
        m = re.match(r"\s*-\s*\*\*Reapply\*\*:\s*(\w+)", line)
        if m:
            current_reapply = m.group(1)

    # Last patch
    if current_patch and current_status == "active" and current_reapply != "no":
        active.append(current_patch)

    return active


def main():
    patches_file = sys.argv[1] if len(sys.argv) > 1 else "BRIGHTFIRE_PATCHES.md"
    active = parse_patches(patches_file)

    out = ",".join(active)
    # GitHub Actions ::set-output format
    print(f"::set-output name=count::{len(active)}")
    print(f"::set-output name=list::{out}")
    print(f"Active patches ({len(active)}): {out}")


if __name__ == "__main__":
    main()
