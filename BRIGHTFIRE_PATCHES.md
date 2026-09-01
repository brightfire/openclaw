# Brightfire Patch Registry

See [docs/brightfire-patches.md](docs/brightfire-patches.md) for how this file
is maintained, the merge-not-rebase philosophy, and the new-entry template.

## _meta

- **Base branch:** `main`
- **Upstream version:** `v2026.8.1`

## Patches

| Name                           | Canonical branch                           | Branch HEAD   | Source PR                                       | Last updated |
| ------------------------------ | ------------------------------------------ | ------------- | ----------------------------------------------- | ------------ |
| Upstream Test Fixes            | `brightfire/upstream-test-fixes`           | `08f14ac3d3` | https://github.com/brightfire/openclaw/pull/150 | 2026-08-25   |
| Slack Markdown                 | `brightfire/slack-mrkdwn`                  | `3fc05ac327`  | —                                               | 2026-08-24   |
| CLI HTTP Health Fallback       | `brightfire/cli-http-fallback`             | `d0a8dfb097`  | —                                               | 2026-08-24   |
| Webhook Session Target Support | `brightfire/webhook-sessiontarget-support` | `dd89590762`  | https://github.com/brightfire/openclaw/pull/106 | 2026-08-24   |
| OTEL Improvements              | `brightfire/otel-improvements`             | `cfca72a2f6`  | https://github.com/brightfire/openclaw/pull/173 | 2026-09-01   |
| Bundle All Plugins             | `brightfire/bundle-all-plugins`            | `71956fd01c`  | —                                               | 2026-08-25   |

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

## Slack Markdown

(canonical: `brightfire/slack-mrkdwn`)

### Rationale

The Slack extension was using `text_markup: 'mrkdwn'` (Slack's proprietary dialect) in `inboundFormattingHints`, which causes models to produce Slack-specific markdown (bold via `*word*`, etc.) that renders poorly outside Slack and is often incorrect even within it. Fix: switch to `text_markup: 'markdown'` and instruct models to write standard Markdown.

### Files touched

- `extensions/slack/src/shared.ts` (`inboundFormattingHints` text_markup change)

### Upgrade guidance

**Conflicts:** Unlikely. Small, isolated change to `inboundFormattingHints`.

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

(canonical: `brightfire/webhook-sessiontarget-support`)

### Rationale

Adds configurable `sessionTarget` for webhook hook mappings, allowing
webhook-triggered flows to direct sessions to specific targets rather than
always using the default.

### Files touched

- `extensions/webhooks/src/` (hook mapping sessionTarget configuration)

### Upgrade guidance

**Conflicts:** Unlikely. Isolated change to webhook hook mapping configuration.

## OTEL Improvements

(canonical: `brightfire/otel-improvements`)

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

## Bundle All Plugins

(canonical: `brightfire/bundle-all-plugins`)

### Rationale

By default, OpenClaw's `package.json` `files` array excludes all extension
subdirectories under `dist/extensions/` from the published tarball, meaning
plugins must be installed separately via the plugin registry. This patch
removes those exclusions so all bundled extensions ship in the core tarball,
enabling airgapped and offline deployments where plugin installation from
the registry is not available.

Also inlines the `get-east-asian-width` transitive dependency (used by the
Slack plugin's CJK width formatting via `string-width`) into the bundle by
adding it to `shouldAlwaysBundleDependency()` in `tsdown.config.ts`, ensuring
the CLI bootstrap import guard doesn't flag it as an external import.

### Files touched

- `package.json` (removes `!dist/extensions/*` exclusions from `files` array; adds `get-east-asian-width` dependency)
- `tsdown.config.ts` (adds `get-east-asian-width` to `shouldAlwaysBundleDependency()`)
- `extensions/*/openclaw.plugin.json` (bundled flag updates for brave, diagnostics-otel, slack)

### Upgrade guidance

**Conflicts:** `package.json` — the `files` array changes are in a region that
upstream frequently modifies (adding/removing extension exclusions). Take
upstream's version of the `files` array and re-apply the removal of extension
exclusions. The `get-east-asian-width` dependency should be preserved in
`dependencies`. `tsdown.config.ts` — check `shouldAlwaysBundleDependency()`
for upstream changes to the function signature or existing entries.
