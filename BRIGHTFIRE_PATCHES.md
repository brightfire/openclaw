# Brightfire Patch Registry

Manifest maintenance is owned by the `openclaw-dev` skill
(brightfire/gpt-skills). New-entry template:
[.github/brightfire-patches/new-entry-template.md](.github/brightfire-patches/new-entry-template.md).

## _meta

- **Base branch:** `main`
- **Base commit:** `41344e0b7dbd`
- **Upstream version:** `v2026.9.3`

## Patches

| Name                           | Canonical branch                                        | Branch HEAD   | Source PR                                       | Last updated |
| ------------------------------ | ------------------------------------------------------- | ------------- | ----------------------------------------------- | ------------ |
| Upstream Test Fixes            | `brightfire/41344e0b7dbd/upstream-test-fixes`           | `5e598e2f8f1` | https://github.com/brightfire/openclaw/pull/190 | 2026-09-09   |
| Slack Markdown                 | `brightfire/41344e0b7dbd/slack-mrkdwn`                  | `cad2f53a617` | —                                               | 2026-09-09   |
| CLI HTTP Health Fallback       | `brightfire/41344e0b7dbd/cli-http-fallback`             | `fbae11610a5` | https://github.com/brightfire/openclaw/pull/183 | 2026-09-09   |
| Webhook Session Target Support | `brightfire/41344e0b7dbd/webhook-sessiontarget-support` | `c4d1521f060` | https://github.com/brightfire/openclaw/pull/106 | 2026-09-09   |
| OTEL Improvements              | `brightfire/41344e0b7dbd/otel-improvements`             | `8dd16dfb1f0` | https://github.com/brightfire/openclaw/pull/191 | 2026-09-09   |

## Upstream Test Fixes

(canonical: `brightfire/41344e0b7dbd/upstream-test-fixes`)

### Rationale

Fixes/skips upstream tests that are flaky or broken in our CI environment.
Pure test-file changes only — never product code. Applies before any product
patch so subsequent patches inherit a green baseline.

### Files touched

Surface as of the v2026.9.3 upgrade (41344e0b7dbd) — the previous list was stale:

- `src/tui/tui-pty-harness.e2e.test.ts` (line-neutral PTY skip form — also carries the oxlint max-lines fix applied first on stable)
- `src/tui/tui-pty-local.e2e.test.ts`
- `src/plugins/.../missing-configured-plugin-install.test.ts` (gateway doctor shared test)

Historical context: `src/gateway/server-startup-web-fetch-bind.test.ts` and
`src/config/doc-baseline.integration.test.ts` fixes are carried in
`brightfire/ci` history (merged forward by the ci update), not on this patch
branch; `server.minimal-channel-pin.test.ts` and `prompt-snapshots.test.ts`
entries were absorbed by upstream and dropped.

### Upgrade guidance

On each upstream upgrade, re-check whether each skipped/patched test now
passes upstream as-is; drop entries that no longer apply. Conflicts here
are expected to be trivial since all changes are test-file-only and small.
If upstream renames or restructures one of these files, the merge will
surface it and the corresponding fix should be re-applied (or dropped if
upstream fixed the underlying issue).

## Slack Markdown

(canonical: `brightfire/41344e0b7dbd/slack-mrkdwn`)

### Rationale

The Slack extension was using `text_markup: 'mrkdwn'` (Slack's proprietary dialect) in `inboundFormattingHints`, which causes models to produce Slack-specific markdown (bold via `*word*`, etc.) that renders poorly outside Slack and is often incorrect even within it. Fix: switch to `text_markup: 'markdown'` and instruct models to write standard Markdown.

### Files touched

- `extensions/slack/src/shared.ts` (`inboundFormattingHints` text_markup change)

### Upgrade guidance

**Conflicts:** Unlikely. Small, isolated change to `inboundFormattingHints`.

## CLI HTTP Health Fallback

(canonical: `brightfire/41344e0b7dbd/cli-http-fallback`)

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
auth behaviour in `trusted-proxy` mode). No upstream PR has shipped an equivalent
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

## Webhook Session Target Support

(canonical: `brightfire/41344e0b7dbd/webhook-sessiontarget-support`)

### Rationale

Adds configurable `sessionTarget` for webhook hook mappings, allowing
webhook-triggered flows to direct sessions to specific targets rather than
always using the default.

### Files touched

Surface as of the v2026.9.3 upgrade (41344e0b7dbd):

- `src/config/zod-schema.hooks.session-mode.test.ts` (schema conformance test for HookMappingSchema sessionMode + sessionKey pairing)

The original `extensions/webhooks/src/` hook-mapping sessionTarget source
changes were absorbed by upstream before the previous base; upstream's
HookMappingSchema already supports sessionMode/sessionKey and the schema
test passes against it. The webhook `sessionTarget` field itself does not
exist upstream. Retirement candidate — keep only for the pinned schema
test; retirement is the operator's call.

### Upgrade guidance

**Conflicts:** Unlikely. Isolated change to webhook hook mapping configuration.

## OTEL Improvements

(canonical: `brightfire/41344e0b7dbd/otel-improvements`)

### Rationale

Combines OTEL agent identity propagation and skill version tracking into a
single patch. Improves OpenTelemetry tracing by ensuring agent identity and
skill usage metadata are properly propagated through spans.

### Files touched

- `src/agents/` (OTEL agent identity propagation)
- `extensions/diagnostics-otel/` (skill version tracking in spans)

### Upgrade guidance

**Conflicts:** May conflict if upstream changes OTEL span attributes or agent
identity propagation. Check `extensions/diagnostics-otel/` for upstream changes.
