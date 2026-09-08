# Brightfire CI Guide

How CI works on the Brightfire fork, how to read a red PR, and where test changes belong.

## The two questions CI answers

A patch PR gets two kinds of signal:

1. **"Is my patch clean on its own?"** — upstream CI runs against the raw PR tree (base + this patch only). Catches patch-local hygiene: lint, knip, max-lines, formatting. Runs on
   every PR; failures here are usually about the patch itself.
2. **"Will the integration work?"** — `bf-pr-context.yml` assembles the representative tree (upstream base + ALL manifest patches at their recorded SHAs + the PR head — exactly
   what `bf-build-stable` would build on merge) and runs the upstream test suite against that. A failure here means stable will fail if this merges.

The raw-tree checks will show failures from _missing patch context_ (see taxonomy below) — those are noise on question 1 and are the reason question 2 exists. The PR-context
summary gates only on **new** failures relative to the ledger.

## Failure taxonomy

Every red check is one of:

| Class                    | Example                                                | Where the fix goes                                            |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| PR's own change          | a test your patch actually breaks; a guard it violates | the PR itself                                                 |
| Patch contract change    | upstream test asserts the old contract the patch flips | the owning patch, per the doctrine below                      |
| Pre-existing at base     | fails on the clean upstream tree too                   | `upstream-test-fixes` (skip, with clean-base evidence)        |
| CI-environment-sensitive | passes locally, fails on GH-hosted runners             | `upstream-test-fixes` (skip, with CI-run evidence)            |
| Missing patch context    | fails only on raw-tree PR CI — other patches missing   | nowhere — PR-context CI suppresses it; do not "fix" it per-PR |
| Infra flake              | artifact-service 403, runner failures                  | rerun; do not code around                                     |

## Test-change doctrine (per-assertion)

When a patch deliberately changes a contract (e.g. bundle-all-plugins ships all plugins in the tarball), evaluate failing tests **per assertion**, not per file:

1. The whole case asserts the old contract (externality/exclusion) → invalid on the patched tree → skip the case (or delete it if the patch erroneously carried it).
2. The old contract is one condition inside a broader valid test → surgically remove that condition; keep the test active.
3. The test asserts presence/correctness of what the patch now ships → update its expectations to the patched tree's truth; the test now **enforces** the new contract.
4. Ambiguous → skip, and say why in the resolution note.

**Skip placement:** env/pre-existing failures go in `upstream-test-fixes` (applies first, so every later tree inherits the green baseline). Contract changes go in the patch that
changes the contract. CI infrastructure goes on `brightfire/ci`. Never maintain the same skip in two places — if you find yourself copying a skip between the patch stack and a
branch, the assembly step is missing (see PR-context CI).

**Before skipping anything because "the patch changed the contract":** check what the test actually pins. A test that fails because of a patch can still be flagging a real bug
**in** the patch (example: the `cli-http-fallback` probe test caught the /ready fallback masking explicitly rejected tokens — the fix was gating the patch, not skipping the test).

## Triage playbook

1. **Never reason from absolute red/green.** Diff the PR's failing checks against the base branch's last CI run, or against the previous head's run. New-vs-known is the only
   signal.
2. For each new failing test, classify it against the taxonomy above. Reproduce on the clean base before calling anything "pre-existing".
3. Route the fix per the table. Patch PRs should not accumulate skips for classes that PR-context CI already covers.

## The expected-failures ledger

`.github/brightfire-ci/expected-test-failures.json` lists, per pinned base commit, the test files expected to fail on the **assembled** tree. PR-context CI gates only on failing
files not in the ledger. Rules:

- Add an entry only with evidence that the failure exists on the assembled tree independent of the PR under review.
- Remove entries as they are fixed — the list must trend to zero. - Entries are file-level for now; case-level granularity can be added when file-level proves too coarse.

## Merge order and intermediate red builds

`bf-register-patch` commits manifest bumps to `brightfire/ci` on every patch-PR merge, and those commits touch `BRIGHTFIRE_PATCHES.md` — which triggers `bf-build-stable`. Multi-PR
sets therefore produce **intermediate red build-stable runs** while the set is landing. That is expected: use those runs as incremental verification of what has landed so far, and
expect the final PR in the set (usually the `brightfire/ci` one) to trigger the first fully green run.
