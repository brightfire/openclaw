#!/usr/bin/env python3
"""Parse BRIGHTFIRE_PATCHES.md and emit active branches for CI workflows.

Reads the patches manifest file and outputs a comma-separated list of
canonical branch names that have Status=active and Reapply!=no.

Usage: parse-patches.py [patches-file] [github-output-file]
  patches-file defaults to BRIGHTFIRE_PATCHES.md
  github-output-file is the $GITHUB_OUTPUT file path (optional)

Outputs summary to stdout, and writes key=value pairs to github-output-file.
"""

import re
import sys


# A vX.Y.Z tag — no suffix, no prefix. Used to validate the manifest pin and any
# explicit workflow input.
UPSTREAM_VERSION_RE = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")

# Match `- **Upstream version:** \`v2026.5.7\`` inside the _meta section.
# (Manifest uses `**Foo:**` — colon inside the bold.)
_UPSTREAM_VERSION_LINE_RE = re.compile(
    r"\s*-\s*\*\*Upstream version:\*\*\s*`([^`]+)`"
)


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

        # Canonical branch — manifest uses `**Foo:**` (colon inside bold)
        m = re.match(r"\s*-\s*\*\*Canonical branch:\*\*\s*`brightfire/([^`]+)`", line)
        if m:
            current_patch = m.group(1)

        # Status
        m = re.match(r"\s*-\s*\*\*Status:\*\*\s*(\w+)", line)
        if m:
            current_status = m.group(1)

        # Reapply
        m = re.match(r"\s*-\s*\*\*Reapply:\*\*\s*(\w+)", line)
        if m:
            current_reapply = m.group(1)

    # Last patch
    if current_patch and current_status == "active" and current_reapply != "no":
        active.append(current_patch)

    return active


def parse_upstream_version(patches_file: str) -> str | None:
    """Return the `Upstream version` declared in the manifest's `_meta` section.

    Returns the tag string (e.g. `v2026.5.7`) or None if not present. Does not
    validate the tag shape — callers should reject empty or malformed values
    rather than silently auto-detecting.
    """
    try:
        with open(patches_file, "r") as f:
            content = f.read()
    except FileNotFoundError:
        return None

    in_meta = False
    for line in content.split("\n"):
        # Enter the _meta section on its heading; leave on any subsequent ##.
        if re.match(r"^\s*##\s+_meta\s*$", line):
            in_meta = True
            continue
        if in_meta and re.match(r"^\s*##\s+", line):
            break
        if in_meta:
            m = _UPSTREAM_VERSION_LINE_RE.match(line)
            if m:
                return m.group(1).strip()
    return None


def main():
    patches_file = sys.argv[1] if len(sys.argv) > 1 else "BRIGHTFIRE_PATCHES.md"
    active = parse_patches(patches_file)
    upstream_version = parse_upstream_version(patches_file)

    out = ",".join(active)
    print(f"Active patches ({len(active)}): {out}")
    print(f"Upstream version: {upstream_version or '(none declared)'}")

    # Write $GITHUB_OUTPUT file if provided
    if len(sys.argv) > 2:
        output_file = sys.argv[2]
        with open(output_file, "a") as f:
            f.write(f"count={len(active)}\n")
            f.write(f"list={out}\n")
            f.write(f"upstream_version={upstream_version or ''}\n")


if __name__ == "__main__":
    main()
