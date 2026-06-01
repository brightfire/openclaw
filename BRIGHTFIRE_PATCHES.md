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
2. **Canonical branch**: `brightfire/<name>` — carries the patch's own commits **plus** merge commits from each upstream tag the patch has been brought current with. The `brightfire/ci` build flow squash-merges this branch onto stable.
3. **Source PR**: Full URL to the PR (e.g. `https://github.com/brightfire/openclaw/pull/N`). For cross-repo refs (upstream `openclaw/openclaw`, etc.) use the appropriate full URL. Use `—` when there is no PR. Tooling that receives a bare `N` or `#N` will default to `https://github.com/brightfire/openclaw/pull/N`.
4. **Upgrade guidance**: notes on which upstream changes have historically conflicted and how they were resolved, to help future upgrades.

## Brightfire patches use **merge**, not rebase, to absorb upstream

When a `brightfire/<patch>` branch needs to be brought current with a new upstream tag, we **merge the tag into the patch branch** (`git merge v<new-tag>` on the branch). We do not rebase the branch onto the new tag.

Why: each upstream catch-up produces real conflicts that need human/LLM judgment. Recording those resolutions as discrete merge commits gives a durable, reviewable audit trail — `git log` shows exactly when each upstream tag was absorbed and `git show <merge-sha>` shows the conflict resolution diff. Rebase would silently bake the resolutions into rewritten commits with no marker that a conflict was resolved at all, and would force-push the branch in the process.

The `bf-build-stable.yml` workflow always uses `git merge --squash` to apply each patch onto stable, so a patch branch with internal merge commits still flattens cleanly into a single "apply patch" commit on `stable/*`. The audit trail lives where it's useful (on the patch branch); the stable history stays linear.

---

## _meta

- **Upstream version:** `v2026.5.7`

> The pinned upstream tag that `BF: Build Stable` rebuilds against. Patches in this
> manifest are applied on top of this exact upstream version. Bumping this value is a
> deliberate upgrade decision (handled by the openclaw-fleet-upgrade flow), **never**
> auto-detected. Must be a `vX.Y.Z` tag that exists on the upstream remote
> (`openclaw/openclaw`).

---

## Slack Markdown

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/slack-mrkdwn`
- **Branch HEAD commit:** `d60b00265d`
- **Source PR:** —
- **Last updated:** 2026-05-29

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
- **Source PR:** https://github.com/brightfire/openclaw/pull/19, https://github.com/brightfire/openclaw/pull/20, https://github.com/brightfire/openclaw/pull/21 (v2026.4.15); ported to v2026.5.3 as single commit

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

## Cache Write TTL Cost

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/cache-write-ttl-cost`
- **Branch HEAD commit:** `b88dbad357`
- **Source PR:** https://github.com/brightfire/openclaw/pull/24
- **Last updated:** 2026-05-29

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

## Context Window Min Cap

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** `stable/v2026.5.3`
- **Canonical branch:** `brightfire/context-window-min-cap`
- **Branch HEAD commit:** `68203b417d`
- **Source PR:** https://github.com/brightfire/openclaw/pull/31
- **Last updated:** 2026-05-29

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
- **Branch HEAD commit:** `88504fce32`
- **Source PR:** https://github.com/brightfire/openclaw/pull/30
- **Last updated:** 2026-05-29

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
- **Branch HEAD commit:** `0027e9c8fd`
- **Source PR:** https://github.com/openclaw/openclaw/pull/51067
- **Last updated:** 2026-05-29

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

## Patch Registry Table

| Patch                  | Canonical branch                    | Branch HEAD commit | Status |
| ---------------------- | ----------------------------------- | ------------------ | ------ |
| slack-mrkdwn           | `brightfire/slack-mrkdwn`           | `f3adf06a84`       | active |
| xgw-cross-gateway      | `brightfire/xgw`                    | `caabb461f2`       | active |
| cache-write-ttl-cost   | `brightfire/cache-write-ttl-cost`   | `13bb2c6064`       | active |
| context-window-min-cap | `brightfire/context-window-min-cap` | `13d7032bf3`       | active |
| session-reset-prompt   | `brightfire/session-reset-prompt`   | `da5af0fb19`       | active |
| control-ui-title       | `brightfire/control-ui-title`       | `c87162eba5`       | active |

## store-based session archiving with configurable retention

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** TBD
- **Canonical branch:** `brightfire/sessions-history-archived`
- **Branch HEAD commit:** `1fc52459d4`
- **Source PR:** https://github.com/brightfire/openclaw/pull/39

### Rationale

_Add description of what this patch does and why._

### Files touched

TBD — update after first stable merge

### Upgrade guidance

_Add known conflict notes or `git cherry-pick` command here._

## CLI HTTP Health Fallback (Loopback Trusted-Proxy)

- **Status:** active
- **Reapply:** yes
- **Stable branch first merged into:** TBD
- **Canonical branch:** `brightfire/cli-http-fallback`
- **Branch HEAD commit:** `3340721625`
- **Source PR:** —

### Rationale

_Add description of what this patch does and why._

### Files touched

TBD — update after first stable merge

### Upgrade guidance

_Add known conflict notes or `git cherry-pick` command here._
