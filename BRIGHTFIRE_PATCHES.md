# Brightfire Patch Registry

> **This file lives on the `brightfire/ci` branch — not on `stable/*` or any patch branch.**
>
> It is the **source of truth** for all Brightfire-specific patches that must be replayed
> onto each new upstream stable release.
>
> **Maintained automatically** by the [`BF: Register Patch`](.github/workflows/bf-register-patch.yml)
> workflow, which runs whenever a PR is merged into a `brightfire/*` branch. It adds a new
> entry for previously-unseen branches and updates the commit SHA / source PR for known ones.
>
> **Read by [`BF: Build Stable`](.github/workflows/bf-build-stable.yml)** to know which
> patch branches to merge (in order) when rebuilding the `stable/*` branch.
>
> **Manual edits are welcome** — add rationale, upgrade guidance, conflict notes, or update
> the status field (`active` → `deferred` / `upstreamed` / `superseded`) as patches evolve.
> The workflow will continue to update `Branch HEAD commit` and `Source PR` automatically.

This file is the source of truth for all Brightfire-specific changes that must be replayed onto future upstream stable releases.

For each patch:

1. **Status**: `active`, `deferred`, `upstreamed`, or `superseded`
2. **Canonical branch**: `brightfire/<name>` — single squashed commit for clean cherry-pick
3. **Upgrade guidance**: exact `git cherry-pick` command for applying to a new stable branch

---

## Slack Markdown

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/slack-mrkdwn`
- **Branch HEAD commit:** `f3adf06a84`
- **Source PR:** —

### Rationale

The Slack extension was using `text_markup: 'mrkdwn'` (Slack's proprietary dialect) in `inboundFormattingHints`, which causes models to produce Slack-specific markdown (bold via `*word*`, etc.) that renders poorly outside Slack and is often incorrect even within it. Fix: switch to `text_markup: 'markdown'` and instruct models to write standard Markdown.

### Files touched

- `extensions/slack/src/shared.ts` (`inboundFormattingHints` text_markup change)

### Upgrade guidance

```
git cherry-pick 8b472f2555
```

**Conflicts:** Unlikely. Small, isolated change.

---

## XGW Cross-Gateway

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/xgw`
- **Branch HEAD commit:** `caabb461f2`
- **Source PR:** #19, #20, #21 (v2026.4.15); ported to v2026.5.3 as single commit

### Rationale

Cross-gateway (XGW) communication layer that allows OpenClaw instances to route sessions across gateway boundaries. Includes:

- Session routing: `sessions_send` tool dispatches to remote peers via `POST /xgateway`
- Async callback injection: remote agents can post results back via `POST /xgateway/callback`
- Fleet config: `fleet.crossGateway` section in OpenClaw config with peer registry
- Route registration: XGW HTTP routes wired into `createGatewayHttpServer()`
- Lifecycle: `initXgw()` called at gateway startup, `shutdownXgw()` at shutdown
- Porting fixes: `fleet/FleetConfig` type on `OpenClawConfig`, `correlationId` on `startAgentRun` return type

### Files touched

- `skills/cross-gateway/SKILL.md` (new; agent instructions for XGW usage)
- `src/agents/tools/sessions-resolution.ts` (XGW routing logic)
- `src/agents/tools/sessions-send-tool.ts` (XGW dispatch + callerSessionKey/callerChannel)
- `src/config/types.gateway.ts` (`fleet/FleetConfig` fields on `OpenClawConfig`)
- `src/gateway/server-methods/agent.ts` (`correlationId` on `startAgentRun` return)
- `src/gateway/server-methods/sessions.ts` (gateway session routing helpers)
- `src/gateway/server-methods/sessions-xgw.ts` (new; XGW session method handlers)
- `src/gateway/server-methods/sessions-xgw.test.ts` (new; 22 tests)
- `src/gateway/sessions-resolve.ts` (cross-gateway session resolution)
- `src/gateway/xgw/inbound.ts` (new; XGW HTTP endpoint handlers)
- `src/gateway/xgw/inbound-http.test.ts` (new; 26 tests)
- `src/gateway/xgw/outbound.ts` (new; outbound request logic)
- `src/gateway/xgw/signing.ts` (new; Ed25519 key management + signing)
- `src/gateway/xgw/signing.test.ts` (new; signing tests)
- `src/gateway/xgw/state.ts` (new; persisted XGW exposure/callback state)
- `src/gateway/xgw/types.ts` (new; XGW type definitions)
- `src/gateway/xgw/utils.ts` (new; XGW utility functions)

### Upgrade guidance

```
git cherry-pick ee129e4c2a
```

**Conflicts on v2026.5.7:** `server-http.ts` and `server.impl.ts`.

- `server-http.ts`: upstream added `isManagedOutgoingImagePath()` in the same area as our `isXgwPath()`. Include both; XGW handler goes AFTER upstream's `isManagedOutgoingImagePath` in the function declarations.
- `server.impl.ts`: upstream added `else` branch after `scheduleGatewayPostReadyMaintenance`. Our `initXgw()` goes inside the `if (!minimalTestGateway)` block; preserve upstream's `else` branch.

**Note:** On v2026.4.15 this was three separate canonical branches (`brightfire/xgw`, `brightfire/xgw-async`, `brightfire/xgw-sessions-send-reply`). For v2026.5.3 all three were ported together as one squashed commit since they are tightly coupled and there is no reason to apply them independently.

---

## XGW Security Prompt

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/xgw-security-prompt`
- **Branch HEAD commit:** _branch deleted — merged into brightfire/xgw_
- **Source PR:** #29

### Rationale

Makes the XGW inbound security prompt (the context injected before cross-gateway requests are processed) configurable via `fleet.crossGateway.securityPrompt` in config. Also relaxes the default policy from strict refusal to a more permissive default that still informs the agent it is receiving an inter-agent request.

### Files touched

- `src/config/schema.base.generated.ts` (regenerated; new config field)
- `src/config/zod-schema.ts` (new `securityPrompt` field in XGW fleet config)
- `src/gateway/xgw/inbound.ts` (reads `securityPrompt` from config; default policy updated)
- `src/gateway/xgw/types.ts` (type update)

### Upgrade guidance

```
git cherry-pick 139a6d1b6d
```

**Conflicts:** `schema.base.generated.ts` — regenerate with `npm run config:schema:gen` instead of manual resolve.

---

## Preserve Cache Write Short Normalization

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/preserve-cache-write-short-normalization`
- **Branch HEAD commit:** _branch deleted — no longer exists as standalone_
- **Source PR:** — (ported from stable/v2026.4.15 canonical commit `d7d8bcc73e`)

### Rationale

`resolveModelCost()` in `src/config/defaults.ts` reconstructed cost objects with only 4 base fields (`input`, `output`, `cacheRead`, `cacheWrite`), silently stripping `cacheWriteShort` on every gateway restart. This broke the cache-retention-aware cost estimation (#24) and per-message cache pricing (#26) since their cost lookups would always fall back to the long-TTL rate. Also wires `cacheWriteShort` through `buildProviderCostIndex` (session-level cost summaries) and `computeTieredCost` (tiered pricing path).

### Files touched

- `src/config/defaults.ts` (`resolveModelCost()` preserves `cacheWriteShort`)
- `src/utils/usage-format.ts` (`buildProviderCostIndex` copies `cacheWriteShort`; `computeTieredCost` accepts `cacheWriteRateOverride`)

### Upgrade guidance

```
git cherry-pick 611b72053c
```

---

## Cache Write TTL Cost

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/cache-write-ttl-cost`
- **Branch HEAD commit:** `13bb2c6064`
- **Source PR:** #24

### Rationale

Worker/sub-agent sessions use 5-minute cache TTL (not 1-hour), but the cost estimator always used the 2× long-TTL cache write rate. Adds `cacheWriteShort` to the model cost schema and threads `cacheRetention` through `estimateUsageCost()` so short-TTL sessions are priced at the correct 1.25× rate. Backward compatible: missing `cacheWriteShort` falls back to `cacheWrite`.

### Files touched

- `src/agents/pi-embedded-runner/types.ts` (`cacheRetention` on agent types)
- `src/auto-reply/reply/agent-runner-usage-line.ts` (passes `cacheRetention`)
- `src/auto-reply/reply/agent-runner.ts` (passes `cacheRetention`)
- `src/auto-reply/reply/session-usage.ts` (passes `cacheRetention`)
- `src/config/schema.base.generated.ts` (new `cacheWriteShort` field)
- `src/config/types.models.ts` (new optional `cacheWriteShort` in cost type)
- `src/config/zod-schema.core.ts` (new optional `cacheWriteShort` in Zod schema)
- `src/cron/isolated-agent/run.ts` (passes `cacheRetention`)
- `src/utils/usage-format.test.ts` (4 new test cases)
- `src/utils/usage-format.ts` (`estimateUsageCost` accepts `cacheRetention`)

### Upgrade guidance

```
git cherry-pick f7aa4fdc7b
```

**Conflicts:** `schema.base.generated.ts` — regenerate with `npm run config:schema:gen`.

---

## Per-Message Cache Write Cost

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/per-message-cache-write-cost`
- **Branch HEAD commit:** _branch deleted — no longer exists as standalone_
- **Source PR:** #26, #28

### Rationale

Replaces the earlier post-correction approach (patching `usage.cost` after Pi's `calculateCost()` runs) with a cleaner pre-mutation pattern. Wraps `streamFn` to pass a cloned model with `cacheWrite` set to the 5-minute rate before Pi's cost calculation runs, so per-message cost is naturally correct without coupling to Pi library internals.

### Files touched

- `src/agents/pi-embedded-runner/run/attempt.ts` (streamFn wrapper; model clone with short-TTL rate)

### Upgrade guidance

```
git cherry-pick 7813559395
```

**Conflicts:** `attempt.ts` has frequent upstream changes. Check the streamFn wrapper pattern and the model clone block around the cache write rate injection.

---

## Context Estimate Compaction

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/context-estimate-compaction`
- **Branch HEAD commit:** _branch deleted — no longer exists as standalone_
- **Source PR:** — (production patches applied via fleet-upgrade post-install scripts)

### Rationale

Two production patches integrated into source to avoid re-patching after every upgrade:

1. **Tool-result token estimate:** `TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE` was `2`, causing the context guard to trim tool output at ~40% of the configured window instead of ~75%. Set to `4` to match the real token density of tool output.

2. **Preflight compaction early return:** Removed `totalTokensFresh` early return in `runPreflightCompactionIfNeeded()` that was preventing preflight compaction from firing when token counts happened to be fresh. Compaction now evaluates properly regardless of freshness.

**Note:** Semantic review flagged for this patch — verify the agent-runner-memory.ts compaction logic still behaves correctly after upstream changes in v2026.5.7.

### Files touched

- `src/agents/pi-embedded-runner/tool-result-char-estimator.ts` (`TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE` = 4)
- `src/auto-reply/reply/agent-runner-memory.ts` (`runPreflightCompactionIfNeeded` early return removed)

### Upgrade guidance

```
git cherry-pick 6029b5eb06
```

---

## Context Window Min Cap

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/context-window-min-cap`
- **Branch HEAD commit:** `13d7032bf3`
- **Source PR:** #31

### Rationale

When a user configures `contextWindow: 200000` for a model whose native catalog capacity is `128000`, OpenClaw uses 200k and produces context overflow errors. Fix: cap configured value at `Math.min(configured, modelNativeContextWindow)` in `resolveContextWindowInfo()`. Also fixes a missing `referenceTokens` field in the capped return path (needed by `evaluateContextWindowGuard` to derive compression margins).

### Files touched

- `src/agents/context-window-guard.ts` (`catalogContextWindow` parameter + `Math.min` cap + `referenceTokens` in capped return)
- `src/agents/context-window-guard.test.ts` (5 new test cases for cap behavior)
- `src/agents/pi-embedded-runner/run/setup.ts` (pass `catalogContextWindow`)
- `src/agents/pi-embedded-runner/compact.ts` (pass `catalogContextWindow`)
- `src/agents/pi-embedded-runner/compact.queued.ts` (pass `catalogContextWindow`)
- `src/agents/pi-embedded-runner/extensions.ts` (pass `catalogContextWindow`, 2 call sites)

### Upgrade guidance

```
git cherry-pick 02cf7b6a4f
```

---

## Session Reset Prompt

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/session-reset-prompt`
- **Branch HEAD commit:** `da5af0fb19`
- **Source PR:** #30

### Rationale

Makes the bare `/new` and `/reset` session greeting customizable via `agents.defaults.sessionResetPrompt` in the OpenClaw config file. Includes test update for the new upstream default prompt text in v2026.5.3.

### Files touched

- `src/auto-reply/reply/session-reset-prompt.ts` (read cfg fallback)
- `src/auto-reply/reply/session-reset-prompt.test.ts` (2 new tests + upstream text update)
- `src/config/zod-schema.agent-defaults.ts` (new optional field)
- `src/config/types.agent-defaults.ts` (TS type with JSDoc)
- `src/config/schema.help.ts` (help text entry)
- `src/config/schema.base.generated.ts` (regenerated)

### Upgrade guidance

```
git cherry-pick a59fb22abc
```

**Conflicts:** `schema.base.generated.ts` — regenerate with `npm run config:schema:gen` instead of manual resolve. The test file may also conflict if upstream changes the default reset prompt text again — update the expected string in the test.

---

## Control UI Title

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/control-ui-title`
- **Branch HEAD commit:** `c87162eba5`
- **Source PR:** —

### Rationale

Adds `gateway.controlUi.title` config option to customize the HTML `<title>` of the Control UI web app. Resolution priority: (1) explicit `gateway.controlUi.title`, (2) `ui.assistant.name` / `identity.name`, (3) `'OpenClaw Control'` default. Uses a stable placeholder (`__OPENCLAW_CONTROL_TITLE__`) in `ui/index.html` plus a client-side `document.title` update from the bootstrap config JSON after JS loads.

### Files touched

- `src/config/types.gateway.ts` (new `controlUi.title` field)
- `src/config/zod-schema.ts` (Zod validation for `controlUi.title` — strict mode requires this)
- `src/gateway/control-ui-contract.ts` (title in bootstrap contract)
- `src/gateway/control-ui.ts` (placeholder injection + resolution logic)
- `ui/index.html` (placeholder in `<title>`)
- `ui/src/ui/controllers/control-ui-bootstrap.ts` (client-side `document.title` update)

### Upgrade guidance

```
git cherry-pick 030d2bbc0c
```

**Conflicts:** `ui/index.html` — check the `<title>` tag. `src/config/types.gateway.ts` — check the `GatewayConfig` type for new upstream fields.

---

## XGW Inbound Auth

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/xgw-inbound-auth`
- **Branch HEAD commit:** _branch deleted — likely folded into brightfire/xgw_
- **Source PR:** — (new patch for v2026.5.3)

### Rationale

Wires Ed25519 signature verification into the XGW inbound auth layer. Previously `authMode: 'signature-only'` in config had no effect — requests with only a signature header were rejected as unauthorized. Adds:

- `readRawBody()`: reads request bytes once for both auth and JSON parsing (avoids double stream read)
- `authenticateXgwInbound()`: dispatches to bearer token or Ed25519 verification based on `authMode` config (`token-only` / `dual` / `signature-only`)
- Both `handleXgwHook` and `handleXgwCallback` now use `authenticateXgwInbound()`
- Imports `verifyXgwSignature` from `./signing.ts` (which was already implemented in the xgw-cross-gateway patch)

All existing bearer-token tests pass unchanged since `token-only` is the default.

### Files touched

- `src/gateway/xgw/inbound.ts` (`readRawBody`, `authenticateXgwInbound`, updated handler flow)

### Upgrade guidance

```
git cherry-pick 2ffebbbc23
```

**Conflicts:** Must be applied after `xgw-cross-gateway` (depends on `inbound.ts` existing and `verifyXgwSignature` being importable from `./signing.ts`).

---

## Sessions History Archived

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/sessions-history-archived`
- **Branch HEAD commit:** `4d6e956110`
- **Source PR:** #32

### Rationale

When a session is reset or deleted, the transcript file is renamed to
`{sessionId}.jsonl.reset.{timestamp}` / `{sessionId}.jsonl.deleted.{timestamp}`.
Previously the history lookup layer only found active files, causing `sessions_history`
to return 404 (HTTP) or empty messages (WS/tool) for archived sessions.

This patch adds a directory-scan fallback (`resolveArchivedTranscriptPaths`) at three
layers: the core `readSessionMessages()` helper, the HTTP history endpoint, and the
`chat.history` WebSocket handler used by the agent tool. Results include `archived: true`
so callers know the source was an archived transcript.

### Files touched

- `src/gateway/session-transcript-files.fs.ts` (new `resolveArchivedTranscriptPaths()`)
- `src/gateway/session-utils.fs.ts` (`readSessionMessages()` archive fallback + re-export)
- `src/gateway/session-utils.ts` (re-export `resolveArchivedTranscriptPaths`)
- `src/gateway/sessions-history-http.ts` (HTTP endpoint archive fallback + `archived: true` response)
- `src/gateway/server-methods/chat.ts` (WS `chat.history` fallback + `archived: true`)
- `src/agents/tools/sessions-history-tool.ts` (pass through `archived` flag)
- `src/agents/tool-description-presets.ts` (updated tool description)

### Upgrade guidance

```
git cherry-pick 566dee3c99
```

**Conflicts:** `server-methods/chat.ts` — large file with frequent upstream churn. Check imports and the `chat.history` handler block if conflicts arise.

### Drop when

Drop when upstream adds native archive-fallback support in `readSessionMessages()` and the `chat.history` handler.

---

## Sessions List Archived

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.7`
- **Canonical branch:** `brightfire/sessions-list-archived`
- **Branch HEAD commit:** `0653638ace`
- **Source PR:** `#35` (brightfire/sessions-list-archived)

### Rationale

Agents cannot discover archived/reset session IDs through any tool. This adds `includeArchived`, `archivedFrom`, `archivedTo` params to `sessions.list` RPC and `sessions_list` tool, enabling agents to find and read previous session transcripts after resets.

### Files touched

- `src/gateway/protocol/schema/sessions.ts`
- `src/gateway/session-utils.types.ts`
- `src/gateway/session-utils.ts`
- `src/agents/tools/sessions-list-tool.ts`
- `dist/protocol.schema.json`
- `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`
- `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/*.json`
- `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/*.md`

### Upgrade guidance

```
git cherry-pick 21956af81b
```

**Conflicts:** Likely conflicts in `session-utils.ts` if upstream changes `listSessionsFromStoreAsync()`. Re-run `pnpm protocol:gen && pnpm protocol:gen:swift` and regenerate prompt snapshots after cherry-pick.

**Drop when:** Upstream adds equivalent archived session discovery (e.g., via native `includeArchived` param or a dedicated archived sessions API).

---

## Patch Registry Table

| Patch                                    | Canonical branch                                      | Branch HEAD commit | Status |
| ---------------------------------------- | ----------------------------------------------------- | ------------------ | ------ |
| slack-mrkdwn                             | `brightfire/slack-mrkdwn`                             | `f3adf06a84`       | active |
| xgw-cross-gateway                        | `brightfire/xgw`                                      | `caabb461f2`       | active |
| xgw-security-prompt                      | `brightfire/xgw-security-prompt`                      | _branch deleted_   | active |
| preserve-cache-write-short-normalization | `brightfire/preserve-cache-write-short-normalization` | _branch deleted_   | active |
| cache-write-ttl-cost                     | `brightfire/cache-write-ttl-cost`                     | `13bb2c6064`       | active |
| per-message-cache-write-cost             | `brightfire/per-message-cache-write-cost`             | _branch deleted_   | active |
| context-estimate-compaction              | `brightfire/context-estimate-compaction`              | _branch deleted_   | active |
| context-window-min-cap                   | `brightfire/context-window-min-cap`                   | `13d7032bf3`       | active |
| session-reset-prompt                     | `brightfire/session-reset-prompt`                     | `da5af0fb19`       | active |
| control-ui-title                         | `brightfire/control-ui-title`                         | `c87162eba5`       | active |
| xgw-inbound-auth                         | `brightfire/xgw-inbound-auth`                         | _branch deleted_   | active |
| sessions-history-archived                | `brightfire/sessions-history-archived`                | `4d6e956110`       | active |
| sessions-list-archived                   | `brightfire/sessions-list-archived`                   | `0653638ace`       | active |
