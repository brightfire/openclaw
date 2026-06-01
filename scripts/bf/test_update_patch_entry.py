#!/usr/bin/env python3
"""Unit tests for update-patch-entry.py.

Covers:
- Issue 1: pr_number=0 / "0" / whitespace-zero are treated as preserve
  (Source PR left untouched, single debug line emitted to stderr).
- Existing behavior: non-zero pr_number is written through; empty pr_number
  preserves Source PR; matching SHA is a no-op.

Run from repo root:
    python3 scripts/bf/test_update_patch_entry.py
"""

import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPT_PATH = SCRIPT_DIR / "update-patch-entry.py"


# Import update-patch-entry.py as a module (hyphenated filename ↦ importlib).
_spec = importlib.util.spec_from_file_location("update_patch_entry", SCRIPT_PATH)
upe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(upe)


MANIFEST_TEMPLATE = """# Brightfire Patch Registry

## _meta

- **Upstream version:** `v2026.5.7`

---

## Slack Markdown

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/slack-mrkdwn`
- **Branch HEAD commit:** `{slack_sha}`
- **Source PR:** {slack_pr}
- **Last updated:** 2026-05-29

### Rationale

Tested patch.

---

## XGW Cross-Gateway

- **Status:** active
- **Reapply:** yes
- **Canonical branch:** `brightfire/xgw`
- **Branch HEAD commit:** `{xgw_sha}`
- **Source PR:** {xgw_pr}

### Rationale

Another tested patch.
"""


def _write_manifest(tmp: Path, *, slack_sha="aaaaaaaaaa", slack_pr="#42",
                    xgw_sha="bbbbbbbbbb", xgw_pr="#17"):
    p = tmp / "BRIGHTFIRE_PATCHES.md"
    p.write_text(MANIFEST_TEMPLATE.format(
        slack_sha=slack_sha, slack_pr=slack_pr,
        xgw_sha=xgw_sha, xgw_pr=xgw_pr,
    ))
    return p


def _run_main(argv):
    """Invoke upe.main() with patched sys.argv and capture stdout/stderr."""
    old_argv = sys.argv
    sys.argv = argv
    stdout, stderr = io.StringIO(), io.StringIO()
    rc = 0
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                upe.main()
            except SystemExit as e:
                rc = int(e.code or 0)
    finally:
        sys.argv = old_argv
    return rc, stdout.getvalue(), stderr.getvalue()


class IsPreservePR(unittest.TestCase):
    """Issue 1 core predicate."""

    def test_empty_string_preserves(self):
        self.assertTrue(upe._is_preserve_pr(""))

    def test_whitespace_preserves(self):
        self.assertTrue(upe._is_preserve_pr("   "))

    def test_zero_preserves(self):
        self.assertTrue(upe._is_preserve_pr("0"))

    def test_zero_padded_preserves(self):
        self.assertTrue(upe._is_preserve_pr("00"))
        self.assertTrue(upe._is_preserve_pr("000"))

    def test_zero_with_whitespace_preserves(self):
        self.assertTrue(upe._is_preserve_pr(" 0 "))

    def test_nonzero_int_writes_through(self):
        self.assertFalse(upe._is_preserve_pr("42"))
        self.assertFalse(upe._is_preserve_pr("1"))

    def test_non_numeric_writes_through(self):
        # Falls through as a literal value (workflow already restricts inputs).
        self.assertFalse(upe._is_preserve_pr("abc"))

    def test_none_preserves(self):
        self.assertTrue(upe._is_preserve_pr(None))


class UpdatePatchEntry_Issue1(unittest.TestCase):
    """End-to-end checks that the script preserves Source PR for 0/empty."""

    def test_pr_number_zero_preserves_source_pr(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="#42")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "0",
            ])
            self.assertEqual(rc, 0, f"stderr={err}")
            text = mf.read_text()
            # SHA bumped:
            self.assertIn("**Branch HEAD commit:** `cccccccccc`", text)
            # Source PR untouched:
            self.assertIn("**Source PR:** #42", text)
            self.assertNotIn("**Source PR:** #0", text)
            # Debug line emitted to stderr:
            self.assertIn("treated as preserve", err)

    def test_pr_number_quoted_zero_preserves_source_pr(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="#42")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "00",
            ])
            self.assertEqual(rc, 0)
            self.assertIn("**Source PR:** #42", mf.read_text())

    def test_pr_number_empty_preserves_source_pr(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="#42")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "",
            ])
            self.assertEqual(rc, 0)
            self.assertIn("**Source PR:** #42", mf.read_text())
            # Empty is the normal catch-up sync path — no debug noise.
            self.assertNotIn("treated as preserve", err)

    def test_nonzero_pr_number_writes_through(self):
        # Bare PR numbers now default to a full Brightfire fork URL so the
        # manifest unambiguously identifies which repo the PR lives in.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="#42")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "99",
            ])
            self.assertEqual(rc, 0)
            text = mf.read_text()
            self.assertIn("**Branch HEAD commit:** `cccccccccc`", text)
            self.assertIn("**Source PR:** https://github.com/brightfire/openclaw/pull/99", text)
            self.assertNotIn("**Source PR:** #42", text)
            # Stdout summary now shows the normalized URL.
            self.assertIn("PR=https://github.com/brightfire/openclaw/pull/99", out)

    def test_pr_number_zero_does_not_touch_other_entries(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="#42", xgw_pr="#17")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "0",
            ])
            self.assertEqual(rc, 0)
            text = mf.read_text()
            # XGW section untouched
            self.assertIn("**Branch HEAD commit:** `bbbbbbbbbb`", text)
            self.assertIn("**Source PR:** #17", text)


class NormalizePRRef(unittest.TestCase):
    """PART 3: Source PR ref normalization — short refs default to the
    Brightfire fork URL, full URLs pass through, preserve forms return None."""

    BF_URL = "https://github.com/brightfire/openclaw/pull/"

    def test_none_is_preserve(self):
        self.assertIsNone(upe._normalize_pr_ref(None))

    def test_empty_is_preserve(self):
        self.assertIsNone(upe._normalize_pr_ref(""))
        self.assertIsNone(upe._normalize_pr_ref("   "))

    def test_zero_forms_are_preserve(self):
        self.assertIsNone(upe._normalize_pr_ref("0"))
        self.assertIsNone(upe._normalize_pr_ref("00"))
        self.assertIsNone(upe._normalize_pr_ref(" 0 "))
        self.assertIsNone(upe._normalize_pr_ref("#0"))
        self.assertIsNone(upe._normalize_pr_ref("#00"))
        self.assertIsNone(upe._normalize_pr_ref(" #0 "))

    def test_bare_hash_is_preserve(self):
        # `#` with no number means "empty PR ref" — catch-up sync semantic.
        self.assertIsNone(upe._normalize_pr_ref("#"))
        self.assertIsNone(upe._normalize_pr_ref(" # "))

    def test_bare_number_becomes_brightfire_url(self):
        self.assertEqual(upe._normalize_pr_ref("24"), self.BF_URL + "24")
        self.assertEqual(upe._normalize_pr_ref("1"), self.BF_URL + "1")
        self.assertEqual(upe._normalize_pr_ref("123456"), self.BF_URL + "123456")

    def test_hash_number_becomes_brightfire_url(self):
        self.assertEqual(upe._normalize_pr_ref("#24"), self.BF_URL + "24")
        self.assertEqual(upe._normalize_pr_ref("#31"), self.BF_URL + "31")
        # Leading/trailing whitespace and #-prefix coexist.
        self.assertEqual(upe._normalize_pr_ref(" #24 "), self.BF_URL + "24")

    def test_https_url_passes_through_unchanged(self):
        # Cross-repo refs (e.g. upstream openclaw) MUST be honoured verbatim.
        upstream = "https://github.com/openclaw/openclaw/pull/51067"
        self.assertEqual(upe._normalize_pr_ref(upstream), upstream)
        # Brightfire fork full URL also passes through unchanged.
        bf_full = "https://github.com/brightfire/openclaw/pull/24"
        self.assertEqual(upe._normalize_pr_ref(bf_full), bf_full)

    def test_http_url_passes_through_unchanged(self):
        # Tolerate http:// even though we expect https:// in practice.
        url = "http://example.com/pr/1"
        self.assertEqual(upe._normalize_pr_ref(url), url)

    def test_url_with_surrounding_whitespace_is_stripped(self):
        self.assertEqual(
            upe._normalize_pr_ref("  https://github.com/openclaw/openclaw/pull/51067  "),
            "https://github.com/openclaw/openclaw/pull/51067",
        )

    def test_non_numeric_non_url_returned_unchanged(self):
        # Tolerant of unusual values (e.g. multi-PR composites). Workflow
        # only feeds bare numbers and URLs in practice, but the helper
        # never mangles arbitrary strings.
        self.assertEqual(upe._normalize_pr_ref("abc"), "abc")


class UpdatePatchEntry_FullURL(unittest.TestCase):
    """PART 3: End-to-end behavior for the URL normalization integration."""

    def test_bare_number_writes_brightfire_fork_url(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="#42")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "24",
            ])
            self.assertEqual(rc, 0)
            self.assertIn(
                "**Source PR:** https://github.com/brightfire/openclaw/pull/24",
                mf.read_text(),
            )

    def test_hash_prefixed_number_writes_brightfire_fork_url(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="#42")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "#31",
            ])
            self.assertEqual(rc, 0)
            self.assertIn(
                "**Source PR:** https://github.com/brightfire/openclaw/pull/31",
                mf.read_text(),
            )

    def test_full_url_writes_through_unchanged(self):
        # Cross-repo refs MUST survive verbatim (e.g. upstream openclaw PR).
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="#42")
            upstream = "https://github.com/openclaw/openclaw/pull/51067"
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", upstream,
            ])
            self.assertEqual(rc, 0)
            self.assertIn(f"**Source PR:** {upstream}", mf.read_text())
            self.assertIn(f"PR={upstream}", out)

    def test_hash_zero_preserves_source_pr(self):
        # `#0` is the legacy clobber form; must be treated as preserve and
        # never written to the manifest as a URL.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="https://github.com/brightfire/openclaw/pull/24")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "#0",
            ])
            self.assertEqual(rc, 0)
            text = mf.read_text()
            self.assertIn("**Source PR:** https://github.com/brightfire/openclaw/pull/24", text)
            self.assertNotIn("pull/0", text)

    def test_existing_full_url_preserved_on_empty(self):
        # Catch-up sync path: bumps SHA, leaves the existing full-URL ref alone.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_pr="https://github.com/openclaw/openclaw/pull/51067")
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "",
            ])
            self.assertEqual(rc, 0)
            text = mf.read_text()
            self.assertIn("**Branch HEAD commit:** `cccccccccc`", text)
            self.assertIn("**Source PR:** https://github.com/openclaw/openclaw/pull/51067", text)


class UpdatePatchEntry_Existing(unittest.TestCase):
    """Behavior that must remain unchanged after Issue 1 + Issue 2."""

    def test_no_op_when_sha_already_current(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp, slack_sha="aaaaaaaaaa", slack_pr="#42")
            before = mf.read_text()
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "aaaaaaaaaa", "0",
            ])
            self.assertEqual(rc, 0)
            self.assertEqual(mf.read_text(), before, "no-op must be byte-identical")
            self.assertIn("No changes for brightfire/slack-mrkdwn", out)

    def test_missing_patch_errors(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp)
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "does-not-exist", "cccccccccc", "0",
            ])
            self.assertNotEqual(rc, 0)
            self.assertIn("Could not find section", err)

    def test_last_updated_bumped_when_sha_changes(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            mf = _write_manifest(tmp)
            rc, out, err = _run_main([
                "update-patch-entry.py", str(mf), "slack-mrkdwn", "cccccccccc", "0",
            ])
            self.assertEqual(rc, 0)
            self.assertIn(f"**Last updated:** {date.today().isoformat()}", mf.read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
