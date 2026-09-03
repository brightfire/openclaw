#!/usr/bin/env python3
"""Mutate BRIGHTFIRE_PATCHES.md — the only writer for the patch manifest.

The manifest's `## Patches` table is the source of truth for all
tool-editable fields (Branch HEAD, Source PR, Last updated). The per-patch
prose sections below the table carry only Rationale / Files touched /
Upgrade guidance and are not touched by this script except when creating
brand-new entries (using the template at
`docs/brightfire-patches/new-entry-template.md`).

Owns four modes, all dispatched via argparse:

  1. Update existing entry (or create new one if missing):
       update-patch-entry.py -f BRIGHTFIRE_PATCHES.md \\
         --patch brightfire/0a6c013be5f/sessions-history-archived --commit-sha 93987583f9 [--pr 39]

  2. Create new entry (auto-detected from --patch missing in manifest);
     optional title via --pr-title (conventional-commit prefixes stripped):
       update-patch-entry.py -f BRIGHTFIRE_PATCHES.md \\
         --patch brightfire/0a6c013be5f/my-new-patch --commit-sha abcd1234ef --pr 42 \\
         --pr-title "feat: my new feature"

  3. Refresh ONE entry's HEAD via `git ls-remote origin
     refs/heads/<patch>` — Source PR always preserved:
       update-patch-entry.py -f BRIGHTFIRE_PATCHES.md \\
         --refresh --patch brightfire/0a6c013be5f/sessions-history-archived

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
import os
import re
import subprocess
import sys
from datetime import date

# Default repo for bare PR numbers. Brightfire fork is the assumed owner of
# any short ref (`123` or `#123`) since that's where canonical patch branches
# live. Cross-repo refs MUST be passed as full URLs by the caller.
_DEFAULT_PR_REPO_URL = "https://github.com/brightfire/openclaw"

# Path to the externalized new-entry template (relative to repo root).
_TEMPLATE_PATH = "docs/brightfire-patches/new-entry-template.md"


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


# ---------------------------------------------------------------------------
# Table parsing / mutation
# ---------------------------------------------------------------------------


# Column ordering, fixed for the lifetime of this manifest format.
_TABLE_COLS = [
    "Name",
    "Canonical branch",
    "Branch HEAD",
    "Source PR",
    "Last updated",
]


def _split_row(line):
    """Split a pipe-delimited markdown table row into cells (no outer pipes)."""
    # Drop leading/trailing whitespace; tolerate optional leading/trailing |.
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _is_separator_row(cells):
    """A markdown header-separator row: every cell matches ^:?-+:?$."""
    if not cells:
        return False
    for c in cells:
        if not re.match(r"^:?-+:?$", c.strip()):
            return False
    return True


def _find_table_bounds(content):
    """Locate the Patches table in the manifest.

    Returns (header_idx, sep_idx, first_row_idx, last_row_idx, lines) where
    indices are 0-based line numbers and last_row_idx is inclusive. Raises
    RuntimeError when no table is found.
    """
    lines = content.split("\n")
    in_patches = False
    header_idx = None
    for i, line in enumerate(lines):
        # Enter the Patches section; leave at any subsequent ## heading.
        if re.match(r"^\s*##\s+Patches\s*$", line):
            in_patches = True
            continue
        if in_patches and re.match(r"^\s*##\s+", line):
            break
        if not in_patches:
            continue
        # First pipe-delimited row in the section is the header.
        if line.lstrip().startswith("|") and header_idx is None:
            header_idx = i
            break

    if header_idx is None:
        raise RuntimeError("Could not find Patches table in manifest.")

    sep_idx = header_idx + 1
    if sep_idx >= len(lines) or not _is_separator_row(_split_row(lines[sep_idx])):
        raise RuntimeError(
            "Patches table is missing its header-separator row "
            f"(expected at line {sep_idx + 1})."
        )

    first_row_idx = sep_idx + 1
    last_row_idx = first_row_idx - 1
    for j in range(first_row_idx, len(lines)):
        line = lines[j]
        stripped = line.strip()
        if not stripped:
            break
        if not stripped.startswith("|"):
            break
        last_row_idx = j

    return header_idx, sep_idx, first_row_idx, last_row_idx, lines


def _parse_table(content):
    """Return (rows, bounds, lines) where rows is a list of dicts keyed by
    `_TABLE_COLS` and bounds is `(header_idx, sep_idx, first_row_idx,
    last_row_idx)`. Skips header + separator rows.
    """
    header_idx, sep_idx, first_row_idx, last_row_idx, lines = _find_table_bounds(content)
    header_cells = _split_row(lines[header_idx])
    # We don't strictly require column-name match (lets cosmetic header
    # changes through), but we do require column count.
    if len(header_cells) != len(_TABLE_COLS):
        raise RuntimeError(
            f"Patches table header has {len(header_cells)} columns; expected "
            f"{len(_TABLE_COLS)} ({', '.join(_TABLE_COLS)})."
        )

    rows = []
    for j in range(first_row_idx, last_row_idx + 1):
        cells = _split_row(lines[j])
        if len(cells) != len(_TABLE_COLS):
            # Don't crash on malformed cells — just skip. parse-patches
            # treats only well-formed rows as patches.
            continue
        row = dict(zip(_TABLE_COLS, cells))
        row["_line"] = j
        rows.append(row)

    return rows, (header_idx, sep_idx, first_row_idx, last_row_idx), lines


_CANONICAL_BRANCH_RE = re.compile(r"`([^`]+)`")


def _row_branch_name(row):
    """Extract the full branch name from the Canonical branch cell.
    Returns the text between backticks — the full branch path (e.g.
    `brightfire/0a6c013be5f/bundle-all-plugins`); legacy `brightfire/<name>`
    rows still parse.
    Returns None when the cell has no backtick-delimited value.
    """
    m = _CANONICAL_BRANCH_RE.search(row.get("Canonical branch", ""))
    if not m:
        return None
    return m.group(1)  # Full branch name, no prefix stripping


def _row_head_sha(row):
    """Pull the bare SHA out of the Branch HEAD cell (strip backticks)."""
    cell = row.get("Branch HEAD", "").strip()
    m = re.match(r"`([0-9a-fA-F]+)`", cell)
    if m:
        return m.group(1)
    return cell


def _render_row(row):
    """Render a row dict back into a `| ... |` markdown row line."""
    cells = [row[c] for c in _TABLE_COLS]
    return "| " + " | ".join(cells) + " |"


def _replace_row(lines, row, new_row):
    """Replace `row` in `lines` with `new_row` (both share `_line`)."""
    j = row["_line"]
    new_row["_line"] = j
    lines[j] = _render_row(new_row)


# ---------------------------------------------------------------------------
# Section helpers (for new-entry append)
# ---------------------------------------------------------------------------


def _strip_conventional_prefix(title):
    """Strip a leading `feat:` / `fix:` / `doc:` / `docs:` from a PR title."""
    if not title:
        return ""
    return re.sub(r"^(feat|fix|docs?)\s*:\s*", "", title)


def _load_template(manifest_path):
    """Locate and read the new-entry template.

    Search order:
      1. `$BF_NEW_ENTRY_TEMPLATE` env var (test/override hook).
      2. `<manifest-dir>/docs/brightfire-patches/new-entry-template.md`.
      3. `<cwd>/docs/brightfire-patches/new-entry-template.md`.
      4. `<script-dir>/../../docs/brightfire-patches/new-entry-template.md`
         (script lives at `scripts/bf/`).

    Returns the raw template text. Raises FileNotFoundError when no
    candidate is readable.
    """
    override = os.environ.get("BF_NEW_ENTRY_TEMPLATE")
    if override:
        with open(override, "r") as f:
            return f.read()

    candidates = []
    manifest_dir = os.path.dirname(os.path.abspath(manifest_path)) or "."
    candidates.append(os.path.join(manifest_dir, _TEMPLATE_PATH))
    candidates.append(os.path.join(os.getcwd(), _TEMPLATE_PATH))
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates.append(
        os.path.normpath(os.path.join(script_dir, "..", "..", _TEMPLATE_PATH))
    )

    seen = set()
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        if os.path.isfile(path):
            with open(path, "r") as f:
                return f.read()

    raise FileNotFoundError(
        "new-entry template not found. Looked in: "
        + ", ".join(candidates)
        + ". Set $BF_NEW_ENTRY_TEMPLATE to override."
    )


def _extract_fenced_block(template_text, heading):
    """Pull the first fenced code block following the given `##` heading.

    Lets `new-entry-template.md` document the row + section templates as
    fenced blocks, which the script just lifts verbatim.
    """
    # Find the heading line, then capture content between the next pair of
    # ``` fences after it.
    heading_re = re.compile(rf"^\s*##\s+{re.escape(heading)}\s*$", re.MULTILINE)
    m = heading_re.search(template_text)
    if not m:
        raise RuntimeError(
            f"new-entry template missing required heading: '## {heading}'"
        )
    rest = template_text[m.end():]
    fence_re = re.compile(r"```[^\n]*\n(.*?)\n```", re.DOTALL)
    fm = fence_re.search(rest)
    if not fm:
        raise RuntimeError(
            f"new-entry template heading '{heading}' has no following ``` block."
        )
    return fm.group(1)


def _render_template(template_str, substitutions):
    """Apply `{KEY}` substitution to the template text."""
    rendered = template_str
    for k, v in substitutions.items():
        rendered = rendered.replace("{" + k + "}", v)
    return rendered


# ---------------------------------------------------------------------------
# git helpers
# ---------------------------------------------------------------------------


def _resolve_branch_head(patch_name):
    """Resolve the HEAD short SHA of `brightfire/<patch_name>` on origin.

    Uses `git ls-remote origin refs/heads/<patch>` — no fetch.
    Returns the 10-char short SHA. Raises RuntimeError when the branch
    isn't on origin or git fails.
    """
    ref = f"refs/heads/{patch_name}"
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


# ---------------------------------------------------------------------------
# Entry-level mutators
# ---------------------------------------------------------------------------


def _update_entry(content, patch_name, commit_short, pr_value):
    """Update an existing patch entry's Branch HEAD / Source PR / Last updated.

    The table row is the source of truth; only table cells are mutated.

    Returns:
        (new_content, did_change, found_entry)
    """
    today = date.today().isoformat()

    rows, _bounds, lines = _parse_table(content)
    found_row = None
    for row in rows:
        if _row_branch_name(row) == patch_name:
            found_row = row
            break

    if not found_row:
        return content, False, False

    normalized_pr = _normalize_pr_ref(pr_value)
    existing_sha = _row_head_sha(found_row)

    # Idempotency: same SHA AND no Source PR change → leave the row
    # byte-identical (no Last updated bump either).
    if existing_sha == commit_short and normalized_pr is None:
        return content, False, True

    new_row = dict(found_row)
    new_row["Branch HEAD"] = f"`{commit_short}`"
    if normalized_pr is not None:
        new_row["Source PR"] = normalized_pr
    elif pr_value is not None and pr_value.strip() not in ("", "#"):
        print(
            f"DEBUG: pr={pr_value!r} treated as preserve; Source PR for "
            f"brightfire/{patch_name} left unchanged",
            file=sys.stderr,
        )
    new_row["Last updated"] = today

    _replace_row(lines, found_row, new_row)
    return "\n".join(lines), True, True


def _append_new_entry(content, patch_name, commit_short, pr_value, pr_title,
                     manifest_path):
    """Append a fresh table row + manifest section for a brand-new patch.

    The row template and section template both live in
    `docs/brightfire-patches/new-entry-template.md` so the prose can be
    edited without touching this script.
    """
    title = _strip_conventional_prefix(pr_title) or "Manual registration"
    normalized_pr = _normalize_pr_ref(pr_value)
    source_pr_field = normalized_pr if normalized_pr is not None else "—"
    today = date.today().isoformat()

    substitutions = {
        "NAME": title,
        "CANONICAL": patch_name,
        "COMMIT": commit_short,
        "SOURCE_PR": source_pr_field,
        "TODAY": today,
    }

    template_text = _load_template(manifest_path)
    row_template = _extract_fenced_block(template_text, "Table row template").strip("\n")
    section_template = _extract_fenced_block(template_text, "Section template").strip("\n")

    rendered_row = _render_template(row_template, substitutions).strip("\n")
    rendered_section = _render_template(section_template, substitutions)

    # 1. Insert the new row at the end of the existing Patches table.
    _rows, bounds, lines = _parse_table(content)
    _header_idx, _sep_idx, _first_row_idx, last_row_idx = bounds
    if last_row_idx >= bounds[2] - 1:
        # last_row_idx may be (first_row_idx - 1) when the table has no
        # body rows yet; we want to insert at the next line either way.
        insert_at = last_row_idx + 1
    else:
        insert_at = last_row_idx + 1
    lines.insert(insert_at, rendered_row)
    content_with_row = "\n".join(lines)

    # 2. Append the section at the end of the file.
    if not content_with_row.endswith("\n"):
        content_with_row += "\n"
    return content_with_row + "\n" + rendered_section.rstrip("\n") + "\n"


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


def _list_active_patches(content):
    """Return list of patch names (no `brightfire/` prefix) from the
    Patches table. Presence in the table IS the apply signal — every row
    is active by definition.
    """
    rows, _bounds, _lines = _parse_table(content)
    active = []
    for row in rows:
        name = _row_branch_name(row)
        if not name:
            continue
        active.append(name)
    return active


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
             "`git ls-remote origin refs/heads/<patch>`.",
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
        # `git ls-remote origin refs/heads/<patch>` — same as
        # `--refresh --patch`. Lets manual workflow_dispatch (no merge SHA)
        # invoke the same code path.


def _run_refresh_all(content, patches_file):
    patches = _list_active_patches(content)
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
    new_content = _append_new_entry(
        content, patch_name, commit_short, pr_value, pr_title, patches_file,
    )
    with open(patches_file, "w") as f:
        f.write(new_content)
    normalized_pr = _normalize_pr_ref(pr_value)
    source_pr = normalized_pr if normalized_pr is not None else "—"
    print(f"Created new entry for brightfire/{patch_name}: commit={commit_short}, Source PR={source_pr}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
