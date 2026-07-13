# Brightfire Patch Registry

See [docs/brightfire-patches.md](docs/brightfire-patches.md) for how this file
is maintained, the merge-not-rebase philosophy, and the new-entry template.

## \_meta

- **Upstream version:** `v2026.6.8`

## Patches

| Name                                                                                | Canonical branch                           | Branch HEAD  | Source PR                                         | Last updated |
| ----------------------------------------------------------------------------------- | ------------------------------------------ | ------------ | ------------------------------------------------- | ------------ |
| Upstream Test Fixes | `brightfire/upstream-test-fixes` | `7c3b9ffcd5` | https://github.com/brightfire/openclaw/pull/150 | 2026-07-13 |
| Slack Markdown                                                                      | `brightfire/slack-mrkdwn`                  | `4db19e0ed5` | —                                                 | 2026-06-16   |
| XGW Cross-Gateway                                                                   | `brightfire/xgw`                           | `711c73af36` | https://github.com/brightfire/openclaw/pull/87    | 2026-06-16   |
| Context Window Min Cap                                                              | `brightfire/context-window-min-cap`        | `5c10c1d69f` | <https://github.com/brightfire/openclaw/pull/31>  | 2026-06-16   |
| Session Reset Prompt                                                                | `brightfire/session-reset-prompt`          | `9dbb036ead` | https://github.com/brightfire/openclaw/pull/67    | 2026-06-16   |
| Control UI Title                                                                    | `brightfire/control-ui-title`              | `0f886ced90` | <https://github.com/openclaw/openclaw/pull/51067> | 2026-06-16   |
| Store-Based Session Archiving                                                       | `brightfire/sessions-history-archived`     | `b4e7fdf7bb` | https://github.com/brightfire/openclaw/pull/97    | 2026-06-16   |
| CLI HTTP Health Fallback                                                            | `brightfire/cli-http-fallback`             | `82107367f0` | —                                                 | 2026-06-16   |
| skip changelog trimming for Brightfire -bf versions                                 | `brightfire/changelog-bf-version`          | `c41a70f132` | —                                                 | 2026-06-16   |
| configurable sessionTarget for hook mappings                                        | `brightfire/webhook-sessiontarget-support` | `ef22d62d59` | https://github.com/brightfire/openclaw/pull/106   | 2026-06-17   |
| chore(plugins): enable diagnostics-otel and slack by default                        | `brightfire/default-installed-plugins`     | `d017181ce4` | https://github.com/brightfire/openclaw/pull/129   | 2026-07-08   |
| feat(otel): combine otel-agent-identity + skill-used-version into otel-improvements | `brightfire/otel-improvements` | `28f4443b9e` | https://github.com/brightfire/openclaw/pull/151 | 2026-07-13 |

## Slack Markdown

(canonical: `brightfire/slack-mrkdwn`)

### Rationale

The Slack extension was using `text_markup: 'mrkdwn'` (Slack's proprietary dialect) in `inboundFormattingHints`, which causes models to produce Slack-specific markdown (bold via `*word*`, etc.) that renders poorly outside Slack and is often incorrect even within it. Fix: switch to `text_markup: 'markdown'` and instruct models to write standard Markdown.

### Files touched

- `extensions/slack/src/shared.ts` (`inboundFormattingHints` text_markup change)

### Upgrade guidance

**Conflicts:** Unlikely. Small, isolated change to `inboundFormattingHints`.

## XGW Cross-Gateway

(canonical: `brightfire/xgw`)

### Rationale

Cross-gateway (XGW) communication layer that allows OpenClaw instances to route sessions across gateway boundaries. Includes:

- Session routing: `sessions_send` tool dispatches to remote peers via `POST /xgateway`
- Async callback injection: remote agents can post results back via `POST /xgateway/callback`
- Fleet config: `fleet.crossGateway` section in OpenClaw config with peer registry
- Route registration: XGW HTTP routes wired into `createGatewayHttpServer()`
- Lifecycle: `initXgw()` called at gateway startup, `shutdownXgw()` at shutdown
- Porting fixes: `fleet/FleetConfig` type on `OpenClawConfig`, `correlationId` on `startAgentRun` return type

**Historical note:** On `v2026.4.15` this was three separate canonical branches (`brightfire/xgw`, `brightfire/xgw-async`, `brightfire/xgw-sessions-send-reply`), corresponding to the three Source PRs (#19, #20, #21). For `v2026.5.3` all three were ported together as one squashed commit since they are tightly coupled and there is no reason to apply them independently.

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

**Conflicts seen on past upgrades:** `server-http.ts` and `server.impl.ts`.

- `server-http.ts`: upstream added `isManagedOutgoingImagePath()` in the same area as our `isXgwPath()`. Include both; XGW handler goes AFTER upstream's `isManagedOutgoingImagePath` in the function declarations.
- `server.impl.ts`: upstream added `else` branch after `scheduleGatewayPostReadyMaintenance`. Our `initXgw()` goes inside the `if (!minimalTestGateway)` block; preserve upstream's `else` branch.

## Context Window Min Cap

(canonical: `brightfire/context-window-min-cap`)

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

**Conflicts:** Usually none. Touches isolated context-window-guard code paths.

## Session Reset Prompt

(canonical: `brightfire/session-reset-prompt`)

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

**Conflicts:** `schema.base.generated.ts` — regenerate with `npm run config:schema:gen` rather than resolving by hand. The test file may also conflict if upstream changes the default reset prompt text again — update the expected string in the test.

## Control UI Title

(canonical: `brightfire/control-ui-title`)

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

**Conflicts:** `ui/index.html` — check the `<title>` tag for upstream changes. `src/config/types.gateway.ts` — check the `GatewayConfig` type for new upstream fields.

## Store-Based Session Archiving

(canonical: `brightfire/sessions-history-archived`)

### Rationale

Replaces the upstream file-based session archive (`.jsonl.reset.*` next to the
active transcript) with a store-based archive entry created at archive time.
Centralized in `updateSessionStore` so any code path that mints a new sessionId
(rollover, explicit `/reset`, `sessions.delete`) is captured. Archive entries
carry the original metadata plus an `_archiveReason` (`"rollover"`, `"reset"`,
or `"deleted"`) and a typed `archivedAt` timestamp.

The `_archiveReason` field is transient: set on the in-memory SessionEntry
before the store write, consumed by the archive hook, then stripped before
persistence. A safety-net strip in `store-load.ts` catches any leakage.

Makes `sessions_list` with `includeArchived: true` show archived entries from
the store (full metadata, not just transcript snippets), `sessions.resolve`
find archived entries sorted by `archivedAt` descending, and `chat.history`
fall back to archived transcript files when the store entry is archived.

Config: `session.maintenance.sessionHistoryRetentionDays` (default 30).

### Files touched

- `src/agents/sessions-list-internal.ts` (archived entry merge)
- `src/agents/sessions-resolve.ts` (archived sort + lookup)
- `src/agents/tools/sessions-resolution.ts` (archived prefix detection)
- `src/chat/chat-history-internal.ts` (archive transcript fallback)
- `src/config/types.session.ts` (`sessionHistoryRetentionDays` field)
- `src/gateway/session-utils.ts` (`buildArchiveStoreEntry`, archived row builder)
- `src/gateway/sessions-internal.ts` (sessions.delete uses inline archive)
- `src/gateway/store-load.ts` (strip `_archiveReason` safety net)
- `src/gateway/update-session-store.ts` (centralized archive hook)

### Upgrade guidance

**Conflicts seen on past upgrades:** most session-related upstream changes touch
`updateSessionStore` directly; the archive hook must stay in the same call
ordering relative to the sessionId-mint check. If `chat-history-internal.ts`
upstream changes its file-finding logic, re-verify the archived-transcript
fallback path.

**Note:** several code paths mint sessionIds (rollover, explicit reset,
`sessions.delete`, `get-reply-fast-path` test path); the centralized hook in
`updateSessionStore` catches all of them. `get-reply-fast-path.ts` is
test-only and intentionally bypasses the hook.

## CLI HTTP Health Fallback

(canonical: `brightfire/cli-http-fallback`)

### Rationale

When `gateway.auth.mode` is `trusted-proxy`, the CLI's WebSocket status probe is
rejected on loopback (127.0.0.1 / ::1) because no proxy identity headers are
present on the loopback connection. Without this patch, `openclaw status` and
related CLI flows report `unreachable (unauthorized)` against a perfectly healthy
local gateway.

This patch falls back to an unauthenticated `HTTP GET /ready` health check when
the WS probe is rejected for that reason. On success, the CLI reports
`ok (health-check only — WS auth unavailable on loopback)` so the operator knows
the gateway is alive even though a full WS session was not opened.

Upstream context: openclaw/openclaw#50580, openclaw/openclaw#67524 (loopback
auth behaviour in trusted-proxy mode). No upstream PR has shipped an equivalent
CLI fallback yet, so we carry this as a Brightfire-original patch.

### Files touched

- `src/cli/daemon-cli/probe.ts`
- `src/cli/daemon-cli/status.gather.ts`
- `src/cli/daemon-cli/status.print.ts`

### Upgrade guidance

**Conflicts seen on past upgrades:** `status.print.ts` — upstream introduced a
dynamic probe label via `formatProbeKindLabel(rpc.kind)` (`"Connectivity
probe:"` / `"Read probe:"`). Preserve upstream's `probeLabel` variable and
apply it inside both the `rpc.ok && rpc.httpFallback` branch and the existing
`rpc.ok` branch. Also thread `kind` through to the `httpFallback` return in
`probe.ts` (`return { ok: true, kind, httpFallback: true, ... }`) so the dynamic
label stays correct on both code paths.

**Drop when:** upstream lands an equivalent CLI HTTP fallback, or upstream
stops rejecting loopback connections in `trusted-proxy` mode entirely.

## Upstream Test Fixes

(canonical: `brightfire/upstream-test-fixes`)

### Rationale

Fixes/skips upstream tests that are flaky or broken in our CI environment.
Pure test-file changes only — never product code. Applies before any product
patch so subsequent patches inherit a green baseline.

### Files touched

- `src/gateway/server-startup-web-fetch-bind.test.ts` (migrate to `startGatewayServerWithRetries` to dodge EADDRINUSE under PARALLEL≥5)
- `src/gateway/server.minimal-channel-pin.test.ts` (same migration, same race exposure)
- `src/config/doc-baseline.integration.test.ts` (testTimeout 240_000 → 360_000 for CPU-bound double-render)
- `test/scripts/prompt-snapshots.test.ts` (`it.skip` the committed-Codex-prompt-snapshot case — known upstream snapshot drift)

### Upgrade guidance

On each upstream upgrade, re-check whether each skipped/patched test now
passes upstream as-is; drop entries that no longer apply. Conflicts here
are expected to be trivial since all changes are test-file-only and small.
If upstream renames or restructures one of these files, the merge will
surface it and the corresponding fix should be re-applied (or dropped if
upstream fixed the underlying issue).

## skip changelog trimming for Brightfire -bf versions

(canonical: `brightfire/changelog-bf-version`)

### Rationale

_Add description of what this patch does and why._

### Files touched

TBD — update after first stable merge

### Upgrade guidance

_Describe upstream changes that have historically conflicted and how they
were resolved. Patches are absorbed by `bf-build-stable` via squash-merge of
the canonical branch — do **not** prescribe `git cherry-pick` here. Describe
what tends to conflict and how to resolve it._

## configurable sessionTarget for hook mappings

(canonical: `brightfire/webhook-sessiontarget-support`)

### Rationale

_Add description of what this patch does and why._

### Files touched

TBD — update after first stable merge

### Upgrade guidance

_Describe upstream changes that have historically conflicted and how they
were resolved. Patches are absorbed by `bf-build-stable` via squash-merge of
the canonical branch — do **not** prescribe `git cherry-pick` here. Describe
what tends to conflict and how to resolve it._

## chore(plugins): enable diagnostics-otel and slack by default

(canonical: `brightfire/default-installed-plugins`)

### Rationale

_Add description of what this patch does and why._

### Files touched

TBD — update after first stable merge

### Upgrade guidance

_Describe upstream changes that have historically conflicted and how they
were resolved. Patches are absorbed by `bf-build-stable` via squash-merge of
the canonical branch — do **not** prescribe `git cherry-pick` here. Describe
what tends to conflict and how to resolve it._

## feat(otel): combine otel-agent-identity + skill-used-version into otel-improvements

(canonical: `brightfire/otel-improvements`)

### Rationale

_Add description of what this patch does and why._

### Files touched

TBD — update after first stable merge

### Upgrade guidance

_Describe upstream changes that have historically conflicted and how they
were resolved. Patches are absorbed by `bf-build-stable` via squash-merge of
the canonical branch — do **not** prescribe `git cherry-pick` here. Describe
what tends to conflict and how to resolve it._
