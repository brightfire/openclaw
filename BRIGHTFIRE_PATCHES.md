# Brightfire Patch Registry

This file is the source of truth for Brightfire-specific changes that may need to be replayed onto future upstream stable releases.

## How to use this file

When creating a new stable branch from an upstream release tag:

1. Start from the new upstream stable tag.
2. Review all entries below with `Status: active` and `Reapply: yes`.
3. For each active patch, use its **canonical branch** (`brightfire/<name>`) as the source for cherry-picking or rebasing.
4. Open PRs from `brightfire/<name>` branches back into the new `stable/*` branch — do NOT cherry-pick from messy intermediate branches.
5. When upstream includes an equivalent fix, mark the patch `upstreamed` and stop reapplying it.

## Canonical branches

Each active patch has a **canonical branch** (`brightfire/<name>`) that contains a single squashed commit with the complete change set. These branches are the authoritative source for upstream replay.

| Patch | Canonical branch | Squashed commit |
|---|---|---|
| cache-write-ttl-cost | `brightfire/cache-write-ttl-cost` | `13bb2c6064` |
| context-estimate-compaction | `brightfire/context-estimate-compaction` | `8929fa251a` |
| xgw-cross-gateway | `brightfire/xgw` | `caabb461f2` |
| slack-mrkdwn-formatting-fix | `brightfire/slack-mrkdwn` | `f3adf06a84` |
| trusted-proxy-loopback-password-fallback | `brightfire/trusted-proxy-loopback` | `58f1404caf` |
| control-ui-configurable-title | `brightfire/control-ui-title` | `c87162eba5` |

## Versioning

Brightfire releases use a `-bf<N>` suffix appended to the upstream version:

```
2026.4.15-bf1   ← first Brightfire release on top of upstream 2026.4.15
2026.4.15-bf2   ← second Brightfire release
2026.4.16-bf1   ← first Brightfire release on top of upstream 2026.4.16
```

The version lives in `package.json`. Before each build+release:
1. Bump the `-bf<N>` counter on a `chore/bump-bf<N>` branch
2. PR + merge to `stable/*`
3. Build → tarball will be `openclaw-2026.4.15-bf<N>.tgz`

When pulling a new upstream release, reset the counter to `-bf1`.

## Branch hygiene rules

- **One canonical branch per atomic feature/fix.** If a fix requires changes to multiple files (e.g. Zod schema + generated schema + feature code), those ALL belong in the same branch and the same squashed commit.
- **Never create separate fix/* branches for issues discovered during a feature.** The schema fix for XGW is part of XGW — it lives in `brightfire/xgw`, not in `fix/xgw-schema-*`.
- **Canonical branches live on the upstream base.** Each `brightfire/<name>` branch is based on the upstream tag commit, not on `stable/*`. This lets them be cleanly cherry-picked onto any future stable.
- **Do not push directly to `stable/*`.** All changes go through PRs from feature/fix branches.

## Status meanings

- `active` — still needed in Brightfire fork, must be replayed on future stable branches
- `upstreamed` — equivalent fix exists upstream, do not reapply
- `superseded` — replaced by a different Brightfire patch
- `obsolete` — no longer needed

---

## xgw-cross-gateway

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/xgw`
- **Squashed commit:** `caabb461f2` (updated 2026-04-18: squashed post-PR#19)

### What this includes

Cross-gateway messaging (XGW) enables OpenClaw instances to communicate across a fleet. Agents on one gateway can dispatch tasks to agents on another gateway via `sessions_send` with `@<gateway>/session` addressing. Supports sync, async, and multi-turn modes.

This includes:
- XGW implementation (inbound HTTP, outbound dispatch, state machine, types)
- Config types (`XgwPeerConfig`, `XgwConfig`, `FleetConfig`)
- Zod schema and regenerated JSON schema for `fleet.crossGateway`
- `sessions_send` routing for `@gateway/` keys
- Built-in `skills/cross-gateway/SKILL.md`
- Updated `describeSessionsSendTool()` with `@<gateway>/session` hint
- Session routing rename: skynet → receptionist (PR #18)
- Default worker agent uses gateway default instead of hardcoded receptionist
- `sessions_send` XGW reply fix (PR #20): captures `status`/`reply` from `startAgentRun`, short-circuits `waitForAgentRun` for sync XGW dispatches, dynamic API timeout

### Config shape

```json
{
  "fleet": {
    "crossGateway": {
      "enabled": true,
      "gatewayName": "aster",
      "acceptedTokens": { "ember": "<inbound-token>" },
      "peers": {
        "ember": { "url": "https://ember.example.com", "token": "<outbound-token>" }
      }
    }
  }
}
```

### Files touched

- `src/gateway/xgw/` — new directory (inbound.ts, outbound.ts, state.ts, types.ts, utils.ts)
- `src/gateway/xgw/inbound-http.test.ts`
- `src/gateway/server-methods/sessions-xgw.ts` + `.test.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/server-runtime-state.ts`
- `src/gateway/server-http.ts`
- `src/gateway/server-close.ts`
- `src/gateway/protocol/schema/error-codes.ts`
- `src/config/types.gateway.ts` + `types.openclaw.ts`
- `src/config/zod-schema.ts` + `schema.base.generated.ts`
- `src/agents/tool-description-presets.ts`
- `skills/cross-gateway/SKILL.md`

### Upgrade guidance

```bash
git checkout -b brightfire/xgw-vNEXT stable/vNEXT
git cherry-pick caabb461f2
```

If cherry-pick conflicts, most likely conflict points are `server-http.ts` (route registration) and `schema.base.generated.ts` (regenerate from the updated `zod-schema.ts` instead of cherry-picking the generated file directly).

Run tests to verify:
```bash
pnpm test -- "src/gateway/xgw/inbound-http.test.ts" "src/gateway/server-methods/sessions-xgw.test.ts"
```

### Drop when

Drop when upstream OpenClaw ships cross-gateway messaging natively.

---

## trusted-proxy-loopback-password-fallback

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/trusted-proxy-loopback`
- **Squashed commit:** `58f1404caf`

### Rationale

Upstream PR #58371 (Mar 31) removed the local-direct token auth fallback from trusted-proxy mode. This left no auth path for loopback connections (CLI, sub-agents), breaking all sub-agent spawns on trusted-proxy deployments.

Fix: when `authorizeTrustedProxy` returns `trusted_proxy_loopback_source`, fall back to password auth if `auth.password` is configured.

### Files touched

- `src/gateway/auth.ts` (27 lines)
- `src/gateway/auth.test.ts` (62 lines — 3 new tests)

### Upgrade guidance

```bash
git cherry-pick 03031eb723
```

### Drop when

Drop when upstream restores a local auth fallback for trusted-proxy mode.

---

## slack-mrkdwn-formatting-fix

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/slack-mrkdwn`
- **Squashed commit:** `f3adf06a84`

### Rationale

`inboundFormattingHints()` in the Slack extension told models to write Slack mrkdwn (`text_markup: "slack_mrkdwn"`), but the output pipeline runs `markdownToSlackMrkdwn()` causing double-conversion. Fix: use `text_markup: "markdown"` and instruct standard Markdown.

### Files touched

- `extensions/slack/src/shared.ts` (9 lines)

### Upgrade guidance

```bash
git cherry-pick 81e405249a
```

### Drop when

Drop when upstream fixes the mrkdwn double-conversion.

---

## control-ui-configurable-title

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/control-ui-title`
- **Squashed commit:** `c87162eba5`

### Rationale

Adds `gateway.controlUi.title` config option. The title resolution priority is:
1. `gateway.controlUi.title` (explicit config)
2. Assistant identity name (from `ui.assistant.name`)
3. "OpenClaw Control" (default)

The fix uses a stable placeholder (`__OPENCLAW_CONTROL_TITLE__`) in `ui/index.html` instead of brittle string matching, and also sets `document.title` client-side from the bootstrap config JSON.

### Files touched

- `src/gateway/control-ui.ts`
- `src/gateway/control-ui-contract.ts`
- `src/config/types.gateway.ts`
- `src/config/schema.base.generated.ts`
- `ui/index.html`
- `ui/src/ui/controllers/control-ui-bootstrap.ts`

### Upgrade guidance

Cherry-pick both commits in order:
```bash
git cherry-pick 15ea179faf
git cherry-pick 9c59279895
```

Note: `schema.base.generated.ts` is auto-generated. If there are conflicts, run `pnpm config:schema:gen` instead of manually resolving.

### Drop when

Drop when upstream adds a configurable Control UI title.

---

## context-estimate-compaction

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.14`
- **Canonical branch:** `brightfire/context-estimate-compaction`
- **Squashed commit:** `8929fa251a`

### Rationale

Two fixes to context estimation and compaction:
1. `TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE` changed from `2` to `4` (removes effective 2x multiplier)
2. `runPreflightCompactionIfNeeded` no longer returns early when `totalTokensFresh === true` (allows proactive compaction)

### Files touched

- `src/agents/pi-embedded-runner/tool-result-char-estimator.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`

### Upgrade guidance

```bash
git cherry-pick 8929fa251a
```

### Drop when

Drop when upstream fixes both behaviors.

---

## cache-write-ttl-cost

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Canonical branch:** `brightfire/cache-write-ttl-cost`
- **Squashed commit:** `13bb2c6064`
- **Source PR:** #24

### Rationale

Anthropic has two cache write pricing tiers: 5-minute TTL (1.25x base input) and 1-hour TTL (2x base input). OpenClaw's `models.json` had a single `cacheWrite` rate, and `estimateUsageCost()` used it regardless of which TTL was in effect. Worker/sub-agent sessions using `cacheRetention: "short"` (5m) were costed at the 1h rate, overstating cache write costs by ~60%.

Fix: adds optional `cacheWriteShort` field to the model cost schema, threads `cacheRetention` through `estimateUsageCost()`, and updates all primary call sites.

### Files touched

- `src/utils/usage-format.ts` — `estimateUsageCost()` accepts `cacheRetention`, selects rate accordingly
- `src/utils/usage-format.test.ts` — 4 new test cases
- `src/config/types.models.ts` — `cacheWriteShort` optional field
- `src/config/zod-schema.core.ts` — schema validation
- `src/config/schema.base.generated.ts` — generated schema
- `src/auto-reply/reply/agent-runner.ts` — passes `cacheRetention` to cost estimation
- `src/auto-reply/reply/session-usage.ts` — passes `cacheRetention`
- `src/auto-reply/reply/agent-runner-usage-line.ts` — passes `cacheRetention`
- `src/agents/command/session-store.ts` — passes `cacheRetention`
- `src/agents/pi-embedded-runner/run.ts` — passes `cacheRetention`
- `src/agents/pi-embedded-runner/run/attempt.ts` — passes `cacheRetention`
- `src/agents/pi-embedded-runner/run/types.ts` — type updated
- `src/agents/pi-embedded-runner/types.ts` — type updated
- `src/cron/isolated-agent/run.ts` — passes `cacheRetention`

### Upgrade guidance

```bash
git cherry-pick 13bb2c6064
```

Likely conflict point: `schema.base.generated.ts` — regenerate with `pnpm config:schema:gen` instead of manual resolve.

### Drop when

Drop when upstream adds dual cache write pricing support (5m vs 1h TTL-aware cost estimation).

---

## cli-health-probe-fallback

- **Status:** superseded
- **Reapply:** no
- **Superseded by:** `trusted-proxy-loopback-password-fallback`
- **Primary commit:** `e232a46374`

HTTP fallback in the CLI health probe for trusted-proxy loopback rejection. Superseded by the auth fix which restores WS probe auth.
