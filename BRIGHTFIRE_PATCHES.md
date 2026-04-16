# Brightfire Patch Registry

This file is the source of truth for Brightfire-specific changes that may need to be replayed onto future upstream stable releases.

## How to use this file

When creating a new stable branch from an upstream release tag:

1. Start from the new upstream stable tag.
2. Review all entries below with `Status: active` and `Reapply: yes`.
3. Cherry-pick the listed commit(s), or recreate the patch if the code has drifted.
4. Open PRs from `feature/*` branches back into the new `stable/*` branch.
5. When upstream includes an equivalent fix, mark the patch `upstreamed` and stop reapplying it.

## Status meanings

- `active` — still needed in Brightfire fork
- `upstreamed` — equivalent fix exists upstream, do not reapply
- `superseded` — replaced by a different Brightfire patch
- `obsolete` — no longer needed

---

## context-estimate-compaction

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.14`
- **Source PR:** #3
- **Feature branch:** `feature/context-estimate-compaction`
- **Primary commit:** `8929fa251a`
- **Previous equivalent commit:** `b42bad6b24`

### Rationale

This patch preserves useful context and allows compaction to happen before overflow handling trims or rejects requests.

It combines two changes:

1. **Tool-result estimate fix**
   - changes `TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE` from `2` to `4`
   - removes an effective 2x multiplier applied to tool result text in context estimation

2. **Preflight compaction fix**
   - removes the early return in `runPreflightCompactionIfNeeded` when `totalTokensFresh === true`
   - allows proactive compaction to trigger even when token counts are fresh

### Files touched

- `src/agents/pi-embedded-runner/tool-result-char-estimator.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`

### Upgrade guidance

When creating a future stable branch:

```bash
git checkout -b feature/context-estimate-compaction-vNEXT stable/vNEXT
git cherry-pick 8929fa251a
```

If the cherry-pick conflicts:
- resolve manually
- verify that upstream has not already fixed one or both behaviors
- if upstream has equivalent behavior, update this entry to `upstreamed` or narrow the remaining delta

### Drop when

Drop this patch once upstream includes both of these behaviors in a stable release:

- no 2x special-case tool-result inflation relative to normal text estimation
- preflight compaction still runs when token counts are fresh
