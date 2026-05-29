#!/usr/bin/env python3
"""Update the `Upstream version` pin in BRIGHTFIRE_PATCHES.md's _meta section.

Usage: update-upstream-pin.py <patches-file> <new-tag>

Exits non-zero (with a clear ::error:: message for GitHub Actions) if the
manifest does not contain the expected `- **Upstream version:** \\`...\\`` line
inside its `## _meta` section, so we never silently fail to bump the pin.
"""

from __future__ import annotations

import pathlib
import re
import sys


PATTERN = re.compile(
    r"(\s*-\s*\*\*Upstream version:\*\*\s*`)[^`]+(`)"
)
VERSION_SHAPE = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")


def main() -> int:
    if len(sys.argv) != 3:
        print("::error::usage: update-upstream-pin.py <patches-file> <new-tag>", file=sys.stderr)
        return 2

    patches_file = pathlib.Path(sys.argv[1])
    new_tag = sys.argv[2].strip()

    if not VERSION_SHAPE.match(new_tag):
        print(
            f"::error::Refusing to write non-semver upstream tag '{new_tag}' (expected vX.Y.Z)",
            file=sys.stderr,
        )
        return 2

    if not patches_file.is_file():
        print(f"::error::{patches_file} not found", file=sys.stderr)
        return 2

    content = patches_file.read_text()
    if not PATTERN.search(content):
        print(
            "::error::Could not find `- **Upstream version:** `...`` line in the _meta section "
            f"of {patches_file}",
            file=sys.stderr,
        )
        return 1

    updated = PATTERN.sub(rf"\g<1>{new_tag}\g<2>", content)
    patches_file.write_text(updated)
    print(f"Set upstream pin to {new_tag} in {patches_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
