#!/usr/bin/env python3
"""Parse BRIGHTFIRE_PATCHES.md and emit active branches for CI workflows.

Reads the patches manifest file and outputs a comma-separated list of
canonical branch names that have Status=active and Reapply!=no, in the
order they appear in the `## Patches` table.

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
_UPSTREAM_VERSION_LINE_RE = re.compile(
    r"\s*-\s*\*\*Upstream version:\*\*\s*`([^`]+)`"
)

# Match a `brightfire/<name>` ref inside backticks (used in the
# Canonical branch table cell).
_CANONICAL_BRANCH_RE = re.compile(r"`brightfire/([^`]+)`")


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
    """Parse BRIGHTFIRE_PATCHES.md and return active patch branch names.

    Walks the `## Patches` table; a row is active iff its Status cell is
    'active' (case-insensitive) and its Reapply cell is not 'no'. Rows
    whose Canonical branch cell doesn't match `brightfire/<name>` are
    skipped silently (separator row, malformed entries).
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
        status_col = _col("Status")
        reapply_col = _col("Reapply")
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
        if len(cells) <= max(canonical_col, status_col, reapply_col):
            continue
        m = _CANONICAL_BRANCH_RE.search(cells[canonical_col])
        if not m:
            continue
        if cells[status_col].strip().lower() != "active":
            continue
        if cells[reapply_col].strip().lower() == "no":
            continue
        active.append(m.group(1))

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
