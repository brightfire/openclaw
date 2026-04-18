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

---

## xgw-cross-gateway

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Source PR:** #5
- **Feature branch:** `feature/xgw-cross-gateway-full`
- **Primary commits:** `629998cc32` through `cc20d225ff` (17 commits)
- **Squash-friendly commit:** `ee06966773` ("All the Brightfire custom changes" on stable)

### Rationale

Cross-gateway messaging (XGW) enables OpenClaw instances to communicate across a fleet. Agents on one gateway can dispatch tasks to agents on another gateway via `sessions_send` with `@gateway/session` addressing. Supports sync, async, and multi-turn modes.

This is a Brightfire feature not present in upstream OpenClaw.

### Files touched

- `src/gateway/xgw/` (new directory: `inbound.ts`, `outbound.ts`, `state.ts`, `types.ts`, `utils.ts`)
- `src/gateway/xgw/inbound-http.test.ts` (26 tests)
- `src/gateway/server-methods/sessions-xgw.ts` (new)
- `src/gateway/server-methods/sessions-xgw.test.ts` (22 tests)
- `src/gateway/server-methods/sessions.ts` (modified — XGW session key handling)
- `src/gateway/server-runtime-state.ts` (modified — XGW state field)
- `src/gateway/inbound-http.ts` (modified — XGW routes)
- `src/gateway/server.impl.ts` (modified — XGW initialization)

### Upgrade guidance

This is a large feature patch. On future stable branches:

```bash
git checkout -b feature/xgw-cross-gateway-vNEXT stable/vNEXT
git cherry-pick 629998cc32^..cc20d225ff
```

If cherry-pick conflicts, resolve against the new `inbound-http.ts` and `server.impl.ts` (most likely conflict points). Run the 48 XGW tests to verify:

```bash
pnpm test -- "src/gateway/xgw/inbound-http.test.ts" "src/gateway/server-methods/sessions-xgw.test.ts"
```

### Drop when

Drop when upstream OpenClaw ships cross-gateway messaging natively.

---

## slack-mrkdwn-formatting-fix

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Source PR:** #6
- **Feature branch:** `feature/slack-mrkdwn-formatting-fix`
- **Primary commit:** `81e405249a`

### Rationale

The Slack extension's `inboundFormattingHints()` told models to write Slack mrkdwn directly (`text_markup: "slack_mrkdwn"`), but the output pipeline runs `markdownToSlackMrkdwn()` which converts standard Markdown to mrkdwn. This caused double-conversion: bold `*text*` became italic `_text_`, links broke, etc.

Fix: changed `text_markup` from `"slack_mrkdwn"` to `"markdown"` and updated the formatting rules to instruct standard Markdown.

### Files touched

- `extensions/slack/src/shared.ts` (1 file, 9 lines changed)

### Upgrade guidance

```bash
git cherry-pick 81e405249a
```

Unlikely to conflict — the change is a string literal and a few rule lines in `inboundFormattingHints()`.

### Drop when

Drop when upstream fixes the mrkdwn double-conversion. Check whether `inboundFormattingHints()` returns `"markdown"` (not `"slack_mrkdwn"`) in the upstream release.

---

## cli-health-probe-fallback

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.4.15`
- **Source PR:** (part of #6 branch)
- **Feature branch:** `feature/slack-mrkdwn-formatting-fix`
- **Primary commit:** `e232a46374`

### Rationale

`openclaw status` sends a WebSocket probe to check gateway health. In trusted-proxy mode, loopback WS connections are rejected (`trusted_proxy_loopback_source`). This made `openclaw status` always report the gateway as unreachable.

Fix: added an HTTP health endpoint fallback in the CLI probe. When the WS probe fails, it tries an HTTP GET to the gateway's health endpoint instead.

### Files touched

- `src/cli/daemon-cli/probe.ts` (new fallback logic)
- `src/cli/daemon-cli/status.gather.ts` (1 line)
- `src/cli/daemon-cli/status.print.ts` (6 lines)

### Upgrade guidance

```bash
git cherry-pick e232a46374
```

### Drop when

Drop when upstream either:
- Fixes the WS probe to work in trusted-proxy mode, OR
- Adds an HTTP health fallback natively

Note: this is a symptom-level fix. The root cause (loopback rejection in trusted-proxy) is addressed by the `trusted-proxy-loopback-password-fallback` patch below. If that patch is upstreamed, the WS probe may start working again, but this HTTP fallback is still useful as defense-in-depth.

---

## trusted-proxy-loopback-password-fallback

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** (pending merge into `stable/v2026.4.15`)
- **Source PR:** #7
- **Feature branch:** `fix/trusted-proxy-loopback-password-fallback`
- **Primary commit:** `03031eb723`

### Rationale

Upstream PR #58371 (Mar 31) removed the local-direct token auth fallback from trusted-proxy mode and made `auth.token` mutually exclusive with trusted-proxy. This left no auth path for loopback connections — CLI tools and sub-agents connect via `127.0.0.1` with password auth, but:

1. `authorizeTrustedProxy()` rejects loopback with `trusted_proxy_loopback_source`
2. The trusted-proxy code path returns `{ ok: false }` immediately with no fallback
3. `auth.token` is banned in trusted-proxy mode

This breaks all sub-agent spawns on instances using `gateway.auth.mode: trusted-proxy`.

Fix: when `authorizeTrustedProxy` returns `trusted_proxy_loopback_source`, fall back to password auth if `auth.password` is configured and the client provided a matching password. Includes rate limiting and failure recording.

### Files touched

- `src/gateway/auth.ts` (27 lines added)
- `src/gateway/auth.test.ts` (62 lines added — 3 new tests, 61 total passing)

### Upgrade guidance

```bash
git cherry-pick 03031eb723
```

If the `authorizeGatewayConnectCore` function has changed, apply the patch manually — it inserts a password fallback block between the `authorizeTrustedProxy` success path and the final `return { ok: false }` in the `auth.mode === "trusted-proxy"` branch.

Run auth tests to verify:

```bash
pnpm test -- "src/gateway/auth.test.ts"
```

### Drop when

Drop when upstream restores a local auth fallback for trusted-proxy mode. This is a clear upstream bug — loopback connections have no auth path in trusted-proxy mode. Likely to be fixed upstream once reported.
