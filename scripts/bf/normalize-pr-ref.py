#!/usr/bin/env python3
"""Normalize a Source PR ref using the same rules as `update-patch-entry.py`.

Thin CLI wrapper around `update_patch_entry._normalize_pr_ref`. Exists so
shell callers (notably the new-entry append path in
.github/workflows/bf-register-patch.yml via scripts/bf/register-patch.sh)
can normalize a value without resorting to inline `python3 -c
"import importlib.util ..."` ceremony.

Usage:
    python3 scripts/bf/normalize-pr-ref.py <value>

Prints the normalized URL to stdout when the value resolves to a real PR
ref, prints "—" when the value resolves to 'preserve / no PR' (None), and
exits 0 in both cases.

Examples:
    $ python3 scripts/bf/normalize-pr-ref.py 24
    https://github.com/brightfire/openclaw/pull/24

    $ python3 scripts/bf/normalize-pr-ref.py ''
    —

    $ python3 scripts/bf/normalize-pr-ref.py 'https://github.com/openclaw/openclaw/pull/51067'
    https://github.com/openclaw/openclaw/pull/51067
"""

import importlib.util
import sys
from pathlib import Path


def _load_helper():
    # update-patch-entry.py uses a dash in its filename so it isn't a valid
    # Python module name for a plain `import`. Load it by path.
    here = Path(__file__).resolve().parent
    target = here / "update-patch-entry.py"
    spec = importlib.util.spec_from_file_location("_bf_update_patch_entry", target)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load {target}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if len(sys.argv) != 2:
        print("usage: normalize-pr-ref.py <value>", file=sys.stderr)
        sys.exit(2)
    value = sys.argv[1]
    module = _load_helper()
    normalized = module._normalize_pr_ref(value)
    print(normalized if normalized is not None else "—")


if __name__ == "__main__":
    main()
