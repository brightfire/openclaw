#!/usr/bin/env python3
"""Parse BRIGHTFIRE_PATCHES.md and emit patch branches for CI workflows.

Reads the patches manifest file and outputs a comma-separated list of
canonical branch names, in the order they appear in the `## Patches` table.
Presence in the table is the apply signal — every row is included.

Usage: parse-patches.py [patches-file] [github-output-file]
  patches-file defaults to BRIGHTFIRE_PATCHES.md
  github-output-file is the $GITHUB_OUTPUT file path (optional)

Outputs summary to stdout, and writes key=value pairs to github-output-file.
"""

import re
import sys


# Extract the full branch name from the Canonical branch table cell.
# The cell content is wrapped in backticks — the branch name is whatever
# is between them (e.g. `brightfire/0a6c013be5f/upstream-test-fixes`).
_CANONICAL_BRANCH_RE = re.compile(r"`([^`]+)`")


def _split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _is_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    for c in cells:
        if not re.match(r"^:?-+:?$", c.strip()):
            return False
    return True


def parse_patches(patches_file: str) -> list[str]:
    """Parse BRIGHTFIRE_PATCHES.md and return patch branch names to apply.

    Walks the `## Patches` table; presence in the table is the apply signal.
    Every row with a valid Canonical branch cell (text between backticks) is
    included. Rows whose Canonical branch cell doesn't match are skipped
    silently (separator row, malformed entries).
    """
    try:
        with open(patches_file, "r") as f:
            content = f.read()
    except FileNotFoundError:
        print(f"::error::{patches_file} not found", file=sys.stderr)
        sys.exit(1)

    lines = content.split("\n")
    in_patches = False
    header_idx = None
    for i, line in enumerate(lines):
        if re.match(r"^\s*##\s+Patches\s*$", line):
            in_patches = True
            continue
        if in_patches and re.match(r"^\s*##\s+", line):
            break
        if in_patches and line.lstrip().startswith("|"):
            header_idx = i
            break

    if header_idx is None:
        # No table found — empty active list (build-stable will warn).
        return []

    header_cells = _split_row(lines[header_idx])
    # Locate the column indices we need by header name.
    def _col(name: str) -> int:
        for j, c in enumerate(header_cells):
            if c.strip().lower() == name.lower():
                return j
        raise RuntimeError(f"Patches table missing required column: {name}")

    try:
        canonical_col = _col("Canonical branch")
    except RuntimeError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        sys.exit(1)

    sep_idx = header_idx + 1
    if sep_idx >= len(lines) or not _is_separator_row(_split_row(lines[sep_idx])):
        print(
            "::error::Patches table is missing its header-separator row",
            file=sys.stderr,
        )
        sys.exit(1)

    active = []
    for j in range(sep_idx + 1, len(lines)):
        line = lines[j]
        stripped = line.strip()
        if not stripped:
            break
        if not stripped.startswith("|"):
            break
        cells = _split_row(line)
        if len(cells) <= canonical_col:
            continue
        m = _CANONICAL_BRANCH_RE.search(cells[canonical_col])
        if not m:
            continue
        active.append(m.group(1))

    return active


def parse_base_branch(patches_file: str) -> str:
    """Parse BRIGHTFIRE_PATCHES.md and return the base branch from _meta.

    Reads `- **Base branch:** `main`` from the ## _meta section.
    Defaults to 'main' if not found.
    """
    try:
        with open(patches_file, "r") as f:
            content = f.read()
    except FileNotFoundError:
        return "main"

    m = re.search(r"##\s*_meta\s*\n.*?\*\*Base branch:\*\*\s*`([^`]+)`", content, re.DOTALL)
    return m.group(1) if m else "main"


def parse_base_commit(patches_file: str) -> str:
    """Parse BRIGHTFIRE_PATCHES.md and return the base commit from _meta.

    Reads `- **Base commit:** `0a6c013be5f`` from the ## _meta section.
    Returns empty string if not pinned (fall back to base branch HEAD).
    """
    try:
        with open(patches_file, "r") as f:
            content = f.read()
    except FileNotFoundError:
        return ""

    m = re.search(r"##\s*_meta\s*\n.*?\*\*Base commit:\*\*\s*`([^`]+)`", content, re.DOTALL)
    return m.group(1) if m else ""


def main():
    patches_file = sys.argv[1] if len(sys.argv) > 1 else "BRIGHTFIRE_PATCHES.md"
    active = parse_patches(patches_file)
    base_branch = parse_base_branch(patches_file)
    base_commit = parse_base_commit(patches_file)

    out = ",".join(active)
    print(f"Base branch: {base_branch}")
    if base_commit:
        print(f"Base commit: {base_commit}")
    print(f"Active patches ({len(active)}): {out}")

    # Write $GITHUB_OUTPUT file if provided
    if len(sys.argv) > 2:
        output_file = sys.argv[2]
        with open(output_file, "a") as f:
            f.write(f"count={len(active)}\n")
            f.write(f"list={out}\n")
            f.write(f"base_branch={base_branch}\n")
            if base_commit:
                f.write(f"base_commit={base_commit}\n")


if __name__ == "__main__":
    main()
