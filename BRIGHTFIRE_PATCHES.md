# Brightfire Patch Registry

This file is the source of truth for all Brightfire-specific changes that must be replayed onto future upstream stable releases.

For each patch:
1. **Status**: `active`, `upstreamed`, or `superseded`
2. **Canonical branch**: `brightfire/<name>` — single squashed commit for clean cherry-pick
3. **Upgrade guidance**: exact `git cherry-pick` command for applying to a new stable branch

---

## Session Reset Prompt

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/session-reset-prompt`
- **Squashed commit:** `da5af0fb19`
- **Source PR:** #30

### Rationale

Makes the bare `/new` and `/reset` session greeting customizable via `agents.defaults.sessionResetPrompt` in the OpenClaw config file.

### Files touched

- `src/auto-reply/reply/session-reset-prompt.ts` (read cfg fallback)
- `src/config/zod-schema.agent-defaults.ts` (new optional field)
- `src/config/types.agent-defaults.ts` (TS type with JSDoc)
- `src/config/schema.help.ts` (help text entry)
- `src/config/schema.base.generated.ts` (regenerated)
- `src/auto-reply/reply/session-reset-prompt.test.ts` (2 new tests)

### Upgrade guidance

```
git cherry-pick da5af0fb19
```

**Conflicts:** `schema.base.generated.ts` — regenerate with `pnpm config:schema:gen` instead of manual resolve.

---

## Context Window Min Cap

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/context-window-min-cap`
- **Squashed commit:** `13d7032bf3`
- **Source PR:** #31

### Rationale

When a user configures `contextWindow: 200000` for a model whose native capacity is `128000`, OpenClaw uses 200k → context overflow errors. Fix: cap configured value at `Math.min(configured, modelNativeContextWindow)` in `resolveContextWindowInfo()`.

### Files touched

- `src/agents/context-window-guard.ts` (`catalogContextWindow` parameter + `Math.min` cap)
- `src/agents/context-window-guard.test.ts` (5 new test cases)
- `src/agents/pi-embedded-runner/run/setup.ts` (pass `catalogContextWindow`)
- `src/agents/pi-embedded-runner/compact.ts` (pass `catalogContextWindow`)
- `src/agents/pi-embedded-runner/compact.queued.ts` (pass `catalogContextWindow`)
- `src/agents/pi-embedded-runner/extensions.ts` (pass `catalogContextWindow`, 2 call sites)

### Upgrade guidance

```
git cherry-pick 13d7032bf3
```

---

## Sessions History Archived

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/sessions-history-archived`
- **Squashed commit:** `566dee3c99`
- **Source PR:** #32

### Rationale

`sessions_history` tool can't access archived session transcripts after `/reset` or delete. The archive files exist on disk (`{sessionId}.jsonl.reset.{timestamp}`) but were invisible to the lookup layer.

### Files touched

- `src/gateway/session-transcript-files.fs.ts` (new `resolveArchivedTranscriptPaths()`)
- `src/gateway/sessions-history-http.ts` (HTTP endpoint archive fallback)
- `src/gateway/session-utils.fs.ts` (`readSessionMessages()` archive fallback)
- `src/gateway/session-utils.ts` (re-export)
- `src/gateway/server-methods/chat.ts` (WS `chat.history` fallback)
- `src/agents/tools/sessions-history-tool.ts` (pass through `archived` flag)
- `src/agents/tool-description-presets.ts` (update tool description)
- `src/gateway/sessions-history-http.test.ts` (4 new tests)
- `src/gateway/session-utils.fs.test.ts` (15 new tests)

### Upgrade guidance

```
git cherry-pick 566dee3c99
```

**Conflicts:** `server-methods/chat.ts` — large file with frequent upstream churn. Check imports and the `chat.history` handler block if conflicts arise.

---

## Patch Registry Table

| Patch | Canonical branch | Squashed commit | Status |
|---|---|---|---|
| session-reset-prompt | `brightfire/session-reset-prompt` | `da5af0fb19` | active |
| context-window-min-cap | `brightfire/context-window-min-cap` | `13d7032bf3` | active |
| sessions-history-archived | `brightfire/sessions-history-archived` | `566dee3c99` | active |
| xgw-cross-gateway | `brightfire/xgw` | `caabb461f2` | active |
| xgw-async-sessions | `brightfire/xgw-async` | `66b6e70112` | active |
| xgw-sessions-send-reply | `brightfire/xgw-sessions-send-reply` | `e9e88ebc12` | active |
| xgw-security-prompt | `brightfire/xgw-security-prompt` | `396b60ec85` | active |
| cache-write-ttl-cost | `brightfire/cache-write-ttl-cost` | `13bb2c6064` | active |
| per-message-cache-write-cost | `brightfire/per-message-cache-write-cost` | `6293fcc3a7` | active |
| preserve-cache-write-short-normalization | `brightfire/preserve-cache-write-short-normalization` | `d7d8bcc73e` | active |
| slack-mrkdwn | `brightfire/slack-mrkdwn` | `f3adf06a84` | active |
| control-ui-title | `brightfire/control-ui-title` | `c87162eba5` | active |
| context-estimate-compaction | `brightfire/context-estimate-compaction` | `8929fa251a` | active |

## Canonical Branch Table (summary view)

| Branch | Commit | Lines | Files |
|---|---|---|---|
| `brightfire/session-reset-prompt` | `da5af0fb19` | ~40 | 6 |
| `brightfire/context-window-min-cap` | `13d7032bf3` | ~187 | 6 |
| `brightfire/sessions-history-archived` | `566dee3c99` | ~178 | 8 |
