# XGW Spec Compliance Matrix

**Branch:** `feature/xgw-cross-gateway-full`
**Design:** `projects/cross-gateway-xgw/DESIGN.md` (v5.1, 2026-04-15)
**Reviewer:** Subagent (automated)
**Date:** 2026-04-17
**Prior reviews:** `xgw-review-opus.md`, `xwg-review-gpt.md`

---

## Executive Summary

This is a major revision since the Opus/GPT reviews. The two most critical findings — the inverted async ownership model and the session enumeration vulnerability — have both been corrected. Callback retry, timeout push to waiting sessions, and caller session identity propagation have all been implemented. The test suite has been substantially expanded to cover the previously missing auth, validation, and enforcement paths.

**Remaining issues:**

- `initXgw()` is exported but never called → state not loaded on startup, pruning interval never runs (Critical operational bug)
- Multi-turn loop deferred (acknowledged in DESIGN.md appendix)
- Missing required fields (`correlationId`, `nonce`) auto-filled instead of rejected in hook handler
- Max payload size and maxPendingAsync default deviate from spec
- Nonce FIFO-only eviction vs spec's time-window eviction
- Minor code quality items

**Prior critical/important findings resolved:** 9 of 11 (Opus critical); all 5 GPT blockers addressed.

---

## 1. Wire Protocol

### 1.1 Endpoint URLs

| Spec (§4.1)                      | Implementation                                                 | Status                                                                                                              |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /hooks/skynet`             | `POST /hooks/xgw`                                              | 📝 Intentional rename — design doc notes the mapping; design doc comment says "Map: `/hooks/skynet` → `/hooks/xgw`" |
| `POST /hooks/skynet/callback`    | `POST /hooks/xgw/callback`                                     | 📝 Same intentional rename                                                                                          |
| Registered in server-http.ts     | `isXgwPath()` + `getXgwHttpModule()` handler at lines ~234-960 | ✅ Correctly registered                                                                                             |
| Header `X-Skynet-Correlation-Id` | `X-XGW-Correlation-Id`                                         | 📝 Consistent with the endpoint rename                                                                              |
| Header `X-Skynet-Source-Gateway` | `X-XGW-Source-Gateway`                                         | 📝 Consistent rename                                                                                                |

**Note on the rename:** The design doc's own preamble explicitly documents this mapping (`xgw` namespace = `skynet` concept). The rename is intentional and consistent throughout. The dispatcher entry key `"skynet"` in `XGW_DISPATCHER_KEY` is intentionally preserved for backward compatibility and is documented via the constant.

### 1.2 Request Body Fields

| Field                    | Required in Spec           | Status                                                                                                                                                                              |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionKey`             | ✅ yes                     | ✅ Validated — returns 400 if absent                                                                                                                                                |
| `message`                | ✅ yes                     | ✅ Validated — returns 400 if absent                                                                                                                                                |
| `sourceSessionKey`       | ✅ yes                     | ⚠️ Accepted but defaults to `""` if absent; not rejected                                                                                                                            |
| `sourceChannel`          | no                         | ✅ Optional, correctly handled                                                                                                                                                      |
| `correlationId`          | ✅ yes                     | ⚠️ **Auto-filled with `randomUUID()` if absent** — spec marks as required. Auto-fill breaks async tracking: the caller would not know the correlation ID used by the receiver       |
| `nonce`                  | ✅ yes                     | ⚠️ **Auto-filled with `randomUUID()` if absent** — spec marks as required. Auto-fill makes replay protection useless for callers that omit nonce                                    |
| `timestamp`              | ✅ yes                     | ⚠️ Defaults to `0` if absent, which always fails the 5-minute window check (validated correctly as a side effect, but error message says "request expired" not "missing timestamp") |
| `timeoutSeconds`         | no (default 30, max 120)   | ✅ Capped at 120, defaults to 30                                                                                                                                                    |
| `multiTurn`              | no (default false)         | ✅ Parsed correctly                                                                                                                                                                 |
| `async`                  | no (default false)         | ✅ Parsed correctly                                                                                                                                                                 |
| `callbackTimeoutSeconds` | no (default 600, max 3600) | ✅ Capped at 3600, defaults to 600                                                                                                                                                  |

### 1.3 Synchronous Response

| Spec Field     | Status                                                |
| -------------- | ----------------------------------------------------- |
| `ok: true`     | ✅                                                    |
| `runId`        | ✅ Real runId from subagent.run()                     |
| `status: "ok"` | ✅                                                    |
| `sessionKey`   | ✅ Returns worker session key (`xgw:<correlationId>`) |
| `reply`        | ✅ Extracted from worker's last assistant message     |

### 1.4 Async Acknowledgment Response

| Spec Field                | Status                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `ok: true`                | ✅                                                                     |
| `status: "accepted"`      | ✅                                                                     |
| `correlationId`           | ✅ Returned                                                            |
| `sessionKey` (worker key) | ✅ Returned (deviation: not in spec's ack body, but harmless addition) |

### 1.5 async + multiTurn Mutual Exclusion

| Spec (§4.4)            | Status                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Return 400 if both set | ✅ Implemented and tested — returns `400 {"error": "async and multiTurn are mutually exclusive"}` |

---

## 2. Session Model

### 2.1 Dispatcher Entry Point

| Requirement                                                | Status                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@gateway/skynet` routes to dispatcher (§3.3)              | ✅ `XGW_DISPATCHER_KEY = "skynet"` — requests with `sessionKey === "skynet"` invoke `spawnWorker()`           |
| Spawns fresh worker session                                | ✅ `subagent.run()` called with new `sessionKey = xgw:<correlationId>`                                        |
| Worker session key format: `skynet:<correlationId>` (§3.1) | 📝 Implementation uses `xgw:<correlationId>` — consistent with endpoint rename, `XGW_SESSION_PREFIX = "xgw:"` |
| Worker registered in exposure table                        | ✅ `setExposure()` called before `subagent.run()`                                                             |
| Uses configured `agentId` (default: `"skynet"`) (§6)       | ✅ `agentId = cfg.agentId ?? "skynet"` passed to `subagent.run({ agentId })`                                  |
| Concurrency cap enforced (§12)                             | ✅ `getActiveSessionCount() >= maxConcurrent` → 503                                                           |
| Default `maxConcurrent = 10`                               | ✅ `cfg.maxConcurrent ?? 10`                                                                                  |

### 2.2 Exposure Table

| Requirement                                                                  | Status                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Map<sessionKey, {correlationId, allowedPeer, createdAt, expiresAt}>` (§5)   | ✅ Matches exactly                                                                                                                                                                                                                                        |
| Peer-scoped: only originating peer can address (§5)                          | ✅ `dispatchDirect()` checks `exposure.allowedPeer !== peer` → 403                                                                                                                                                                                        |
| TTL from last activity (§5)                                                  | ✅ `refreshExposure()` called on each direct dispatch                                                                                                                                                                                                     |
| Default TTL 5 minutes                                                        | ✅ `cfg.exposureTtlSeconds ?? 300`                                                                                                                                                                                                                        |
| Periodic cleanup (§5)                                                        | ⚠️ **`initXgw()` never called from server-http.ts** — the pruning interval is set up in `initXgw()`, but that function is exported and unused. The module is lazy-imported on first request, so `initXgw()` is never invoked. Pruning never runs. See §8. |
| Session enumeration: both non-existent and wrong-peer return 403 (§5, §10.4) | ✅ **FIXED** — `dispatchDirect()` returns `status: "forbidden"` for both missing (`getExposure()` returns undefined) and wrong-peer cases. Both map to HTTP 403. Test "returns 403 for nonexistent exposed xgw sessions" confirms.                        |

### 2.3 Direct Session Dispatch

| Requirement                                                  | Status                                                |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `sessionKey.startsWith("xgw:")` routes to `dispatchDirect()` | ✅ Correct                                            |
| Exposure check → 403 if not found                            | ✅                                                    |
| Peer check → 403 if mismatch                                 | ✅                                                    |
| Refresh TTL on access                                        | ✅                                                    |
| Sync wait with timeout                                       | ✅ `waitForRun()` called with `timeoutSeconds * 1000` |
| Reply extracted from last assistant message                  | ✅ `extractReply()` used, checks last 5 messages      |

### 2.4 Spawn Failure Handling

| Behavior                                | Status                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| On spawn failure, remove exposure entry | ⚠️ Sets `expiresAt: now` (immediate expiry) instead of calling `removeExposure()`. Entry sits in table until next prune cycle rather than being cleaned up immediately. Minor issue. |

---

## 3. Async Flow

### 3.1 Async Ownership Model (§4.4.1)

This was a CRITICAL finding in both prior reviews. The implementation has been rearchitected to match the spec.

| Requirement                                                                 | Status                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Caller** (Gateway A) creates `pendingCallbacks` record before dispatching | ✅ **FIXED** — `sessions-xgw.ts` pre-generates `correlationId`, calls `setPendingCallback()` and `saveState()` before `xgwOutboundDispatch()`                                                                                   |
| **Receiver** (Gateway B) does NOT create local pending record               | ✅ **FIXED** — `handleAsyncCallbackOutbound()` on the receiver side just runs the worker and POSTs callback back. No local `pendingCallbacks` entry. Tests verify `getPendingCallback("corr-async")` is `undefined` on receiver |
| Caller creates record with `allowedPeer = gwName`                           | ✅                                                                                                                                                                                                                              |
| Caller creates record with `sourceSessionKey = callerSessionKey`            | ✅                                                                                                                                                                                                                              |
| Pre-generated `correlationId` passed to outbound dispatch                   | ✅ `preCorrelationId` passed via `opts.correlationId`                                                                                                                                                                           |

### 3.2 Async Request Fields Sent to Receiver

| Field                           | Status                                   |
| ------------------------------- | ---------------------------------------- |
| `async: true`                   | ✅                                       |
| `callbackTimeoutSeconds`        | ✅ Clamped to 3600                       |
| `correlationId` (pre-generated) | ✅ Caller's correlationId passed through |

### 3.3 Callback Delivery (§4.4.2)

| Requirement                                                                                    | Status                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Receiver POSTs to `<peerUrl>/hooks/xgw/callback`                                               | ✅ `postCallbackWithRetry()` constructs URL from peer config             |
| Callback URL derived from peer fleet config (no sender-supplied URL)                           | ✅ SSRF prevented                                                        |
| Callback body includes: `correlationId`, `sessionKey`, `status`, `reply`, `nonce`, `timestamp` | ✅ All fields set in `handleAsyncCallbackOutbound()`                     |
| Retry: 3 attempts, 5s/15s/45s backoff (§4.4.4)                                                 | ✅ **FIXED** — `postCallbackWithRetry()` implements exact retry sequence |
| On all retries exhausted: log error                                                            | ✅ `console.error()` on permanent failure                                |
| Callback idempotency: `already_delivered` (§4.4.2)                                             | ✅ Tested and implemented                                                |

### 3.4 Callback Handler on Caller Side

| Requirement                                                 | Status                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth bearer token → peer identity                           | ✅                                                                                                                                                                      |
| Nonce + timestamp validation                                | ✅                                                                                                                                                                      |
| Lookup `pendingCallbacks[correlationId]` → 403 if not found | ✅                                                                                                                                                                      |
| Already delivered → 200 `already_delivered`                 | ✅ Tested                                                                                                                                                               |
| Expired → 410                                               | ✅ Tested                                                                                                                                                               |
| Wrong peer → 403                                            | ✅ Tested                                                                                                                                                               |
| Deliver to `sourceSessionKey` directly                      | ✅ **FIXED** — `pending.sourceSessionKey` used directly, no `xgw:` prefix fabrication                                                                                   |
| Mark delivered                                              | ✅ `markCallbackDelivered()`                                                                                                                                            |
| Refresh exposure for follow-up (§4.4.5)                     | ✅ `refreshExposure()` called on callback's `sessionKey`                                                                                                                |
| 200 `delivery_failed` on local dispatch error               | ⚠️ Returns 200 to suppress peer retries, but this means transient delivery failures are silently non-recoverable. Acknowledged tradeoff; conflicts with retry semantics |

### 3.5 Timeout Push to Waiting Session (§4.4.4)

| Requirement                                                      | Status                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Push timeout message to `sourceSessionKey` when callback expires | ✅ **FIXED** — `notifyExpiredCallbacks()` dispatches `"[Cross-gateway callback timed out]"` to `entry.sourceSessionKey` |
| Called periodically                                              | ✅ 60-second interval in `initXgw()`                                                                                    |
| **But:** `initXgw()` never called from server-http.ts            | ⚠️ See §8 — this feature works in tests but not in production                                                           |

### 3.6 Pending Callback Capacity

| Spec Default | Implementation Default                        | Status                                                                                                                                                         |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20 (§12)     | `maxPendingAsync ?? 100` in `sessions-xgw.ts` | ⚠️ Defaults differ. Config type comment says `"(default: 20)"` matching spec; handler code defaults to 100. If unconfigured, 100 is used. Minor inconsistency. |

---

## 4. Outbound Dispatch

### 4.1 `@gateway/sessionKey` Parsing

| Requirement                                                    | Status                                       |
| -------------------------------------------------------------- | -------------------------------------------- |
| Intercept `sessionKey` starting with `@` before local dispatch | ✅ `sessions.ts` lines 449-458               |
| Parse `gwName` and `remoteKey` at first `/`                    | ✅                                           |
| Reject malformed keys (no `/`)                                 | ✅ Returns `INVALID_REQUEST`                 |
| `enabled` check                                                | ✅ Checked in `handleCrossGatewayDispatch()` |
| Unknown peer → error                                           | ✅                                           |
| Missing token → error                                          | ✅                                           |

### 4.2 Caller Session Identity (§4.2, §7.2)

This was a CRITICAL finding in the GPT review. Now fixed.

| Requirement                                            | Status                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `sourceSessionKey` = actual caller's session key       | ✅ **FIXED** — `callerSessionKey` param used; falls back to `resolveMainSessionKey()` only when not provided |
| `callerChannel` propagated                             | ✅                                                                                                           |
| Test: `callerSessionKey` from params overrides default | ✅ Tested in sessions-xgw.test.ts                                                                            |

### 4.3 Timeout Cap

| Requirement                                       | Status                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| `timeoutSeconds` capped at 120s server-side (§12) | ✅ `Math.min(120, ...)` in `xgwOutboundDispatch()` |
| AbortController for client-side timeout           | ✅ `ctrl.abort()` at `timeoutSec * 1000 + 5000` ms |

### 4.4 HTTPS Enforcement (§10.1)

| Requirement              | Status                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All comms must use HTTPS | ⚠️ **Warning only, not enforced.** `outbound.ts` logs `"[xgw] outbound request to peer ${gwName} uses insecure URL"` but does not block the request. Test "logs a stderr warning when outbound peer URL uses http://" verifies the warning. Actual enforcement (rejecting non-HTTPS URLs) is not implemented. |

### 4.5 Response Handling

| Requirement                                    | Status                                              |
| ---------------------------------------------- | --------------------------------------------------- |
| Use remote `runId` (not local idempotency key) | ✅ **FIXED** — `result.runId` used directly; tested |
| `messageSeq` passed through when present       | ✅ **FIXED** — not hard-coded; tested               |
| `sessionKey` in response is remote worker key  | ✅ `remoteSessionKey: result.sessionKey` returned   |
| 401 → `UNAVAILABLE`                            | ✅                                                  |
| 403 → `UNAVAILABLE` with "not exposed" message | ✅                                                  |
| 504 → `AGENT_TIMEOUT`                          | ✅ Tested                                           |
| Network abort → unreachable error              | ✅                                                  |

---

## 5. Multi-Turn

### 5.1 Cross-Gateway Multi-Turn Loop (§4.3)

| Requirement                                       | Status                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Multi-turn ping-pong loop (turn caps, REPLY_SKIP) | ❌ Not implemented                                                               |
| `multiTurn` field parsed                          | ✅                                                                               |
| `async + multiTurn` → 400                         | ✅ Implemented and tested                                                        |
| Comment in code acknowledges deferral             | ✅ `// TODO: implement multi-turn cross-gateway ping-pong loop (DESIGN.md §4.3)` |
| DESIGN.md appendix notes multi-turn deferred      | ✅ Explicitly deferred to MVP+1                                                  |

**Status: Intentionally deferred per spec appendix.** The 400 validation for the `async+multiTurn` combination is implemented to prevent confusion when multi-turn support lands.

### 5.2 Circular Send Detection (§11)

| Requirement                                                                   | Status                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| Reject synchronous ping-pong where authenticated peer matches original sender | ❌ Not implemented (follows from multi-turn deferral) |
| Async callbacks explicitly exempt                                             | N/A (deferred)                                        |

---

## 6. Security

### 6.1 Token Auth (§9, §10.3)

| Requirement                                         | Status                                                        |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Per-peer named bearer tokens                        | ✅ `acceptedTokens` map                                       |
| Timing-safe comparison (`timingSafeEqual`)          | ✅ Both buffer lengths compared before `timingSafeEqual`      |
| Peer identity derived from token (not request body) | ✅                                                            |
| `${ENV_VAR}` resolution for token values            | ✅ `resolveEnvValue()` in `utils.ts` (shared, not duplicated) |
| Test for token resolution                           | ✅ Tested                                                     |

### 6.2 Nonce / Timestamp (§10.2)

| Requirement                                     | Status                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5-minute timestamp window                       | ✅ `TIMESTAMP_WINDOW_SEC = 300`                                                                                                                                                                                                               |
| Per-peer nonce tracking                         | ✅ `noncesByPeer` map                                                                                                                                                                                                                         |
| FIFO eviction at 10K cap                        | ✅ `MAX_NONCES = 10_000`                                                                                                                                                                                                                      |
| Nonce replay rejection                          | ✅ Returns 409; tested                                                                                                                                                                                                                        |
| Timestamp expiry rejection                      | ✅ Returns 400; tested                                                                                                                                                                                                                        |
| **Nonce tracking window (time-based eviction)** | ⚠️ FIFO-only, no time-based eviction. A nonce from 6 hours ago can still block a legitimate request if it's within the 10K FIFO. Spec says "for the 5-minute window" — this is a semantic gap. Low practical impact at typical request rates. |
| **Nonce required field validation**             | ⚠️ Hook handler auto-fills missing nonce with `randomUUID()`. Callback handler correctly requires it. Inconsistency.                                                                                                                          |

### 6.3 Session Enumeration Prevention (§5, §10.4)

| Requirement                                          | Status                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Non-existent and wrong-peer sessions both return 403 | ✅ **FIXED** — `dispatchDirect()` returns `status: "forbidden"` for both cases. HTTP status is 403 for both. Tests verify this. |
| Callback unknown correlationId → 403 (not 404)       | ✅ Returns `403 {"error": "unauthorized"}`                                                                                      |

### 6.4 Callback Authorization (§4.4.3)

| Requirement                                           | Status    |
| ----------------------------------------------------- | --------- |
| `pendingCallbacks[correlationId].allowedPeer` checked | ✅        |
| Wrong peer → 403                                      | ✅ Tested |
| Expired → 410                                         | ✅ Tested |
| Already delivered → 200 `already_delivered`           | ✅ Tested |

### 6.5 Resource Limits (§12)

| Limit                      | Spec  | Implementation                      | Status                                             |
| -------------------------- | ----- | ----------------------------------- | -------------------------------------------------- |
| Max concurrent sessions    | 10    | `cfg.maxConcurrent ?? 10`           | ✅                                                 |
| Max concurrent → 503       | yes   | `503 {status: "capacity_exceeded"}` | ✅ Tested                                          |
| Max pending async          | 20    | `maxPendingAsync ?? 100` in handler | ⚠️ Default mismatch (see §3.6)                     |
| Max pending async → 503    | yes   | Returns `UNAVAILABLE` via respond   | ✅ Tested                                          |
| Max callback payload       | 64KB  | 1MB (1048576)                       | ⚠️ 16x spec limit; consistent across both handlers |
| Max sync timeout           | 120s  | 120s                                | ✅                                                 |
| Max async callback timeout | 3600s | 3600s                               | ✅                                                 |

---

## 7. Config (§6, §8)

### 7.1 Fleet Config Types

| Field                | Config Type (`types.gateway.ts`)    | Status                                   |
| -------------------- | ----------------------------------- | ---------------------------------------- |
| `enabled`            | ✅                                  | ✅                                       |
| `gatewayName`        | ✅                                  | ✅                                       |
| `agentId`            | ✅ `(default: "skynet")` in comment | ✅                                       |
| `maxConcurrent`      | ✅ `(default: 10)`                  | ✅                                       |
| `maxPendingAsync`    | ✅ `(default: 20)` in comment       | ⚠️ Comment says 20; code defaults to 100 |
| `exposureTtlSeconds` | ✅ `(default: 300)`                 | ✅                                       |
| `acceptedTokens`     | ✅                                  | ✅                                       |
| `peers[].url`        | ✅                                  | ✅                                       |
| `peers[].token`      | ✅                                  | ✅                                       |

### 7.2 Agent Config (§6)

| Requirement                                    | Status                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker sessions use `agentId` from config      | ✅ `agentId = cfg.agentId ?? "skynet"` passed to `subagent.run()`                                                                                                                                                                                                   |
| Default agent ID is `"skynet"`                 | ✅                                                                                                                                                                                                                                                                  |
| Default system prompt for unconfigured gateway | ⚠️ Not implemented. The spec (§6) specifies a defensive default system prompt. The code passes `agentId = "skynet"` — if no `skynet` agent config exists, the runtime falls back to default agent behavior. The spec's safety-fence default prompt is not injected. |

### 7.3 `XgwConfig` Dual Definition

| Issue                                                                           | Status                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two `XgwConfig` types: one in `types.ts`, one in `types.gateway.ts`             | ⚠️ `types.ts` extends `NonNullable<FleetConfig["crossGateway"]>` which IS `types.gateway.ts`'s `XgwConfig`. The extension adds no new fields. Redundant; confusing. Minor code quality issue. |
| `exposureTtlSeconds` missing from `types.ts` XgwConfig but used in `inbound.ts` | ⚠️ Works at runtime via the `extends` chain; invisible in local type definition. Minor.                                                                                                       |

---

## 8. Persistence and State Management (§12.1)

### 8.1 State File

| Requirement                                   | Status                                                |
| --------------------------------------------- | ----------------------------------------------------- |
| Persist to `~/.openclaw/state/xgw-async.json` | ✅ `getStateFile()` returns correct path              |
| Save on create/update/resolve                 | ✅ `saveState()` called after each mutation           |
| Load on startup, prune expired                | ✅ Logic exists in `initXgw()`                        |
| Corrupt file: start fresh                     | ✅ `loadState()` handles parse errors, logs to stderr |
| Expose table persisted                        | ✅ Included in `saveState()`                          |
| Nonce table NOT persisted                     | ✅ Correct — nonces are in-memory only                |

### 8.2 CRITICAL: `initXgw()` Never Called

| Issue                                                        | Status                |
| ------------------------------------------------------------ | --------------------- |
| `initXgw()` exported from `inbound.ts`                       | ✅ Exists at line 782 |
| `initXgw()` called from `server-http.ts` or any startup path | ❌ **Never called**   |
| `shutdownXgw()` called on graceful shutdown                  | ❌ **Never called**   |

**Impact:** The XGW module is lazy-imported on first request via `getXgwHttpModule()`. When the module loads, it defines module-level state but does NOT call `initXgw()`. This means:

1. **State not restored on startup** — `loadState()` never runs; pending callbacks from a previous run are lost
2. **Periodic pruning never starts** — the 60-second `setInterval` is never created
3. **Expired callback notifications never run** — `notifyExpiredCallbacks()` never fires
4. **Sessions waiting for async callbacks will never get timeout messages** — even though the code is correct, it's never invoked

This is a regression from the GPT review finding "I do not see startup code calling `initXgw()`". It was NOT fixed.

**Fix:** Call `initXgw()` in `server-http.ts` when XGW is enabled, and call `shutdownXgw()` on server shutdown.

---

## 9. Inbound Message Context Injection (§7.2)

| Requirement                                   | Status                                                        |
| --------------------------------------------- | ------------------------------------------------------------- |
| `extraSystemPrompt` includes peer identity    | ✅ `[Cross-gateway message from ${peer}/${sourceSessionKey}]` |
| `inputProvenance.kind = "inter_session"`      | ✅                                                            |
| `inputProvenance.sourceSessionKey`            | ✅                                                            |
| `inputProvenance.sourceChannel`               | ✅                                                            |
| `sourceGateway` derived from token (not body) | ✅                                                            |

---

## 10. Error Handling (§11)

| Scenario                                  | Spec                              | Implementation                                             | Status |
| ----------------------------------------- | --------------------------------- | ---------------------------------------------------------- | ------ |
| Target gateway unreachable                | "gateway unreachable"             | `"cross-gateway unreachable: ${gwName}"`                   | ✅     |
| Target session not found (or not exposed) | 403 "session not accessible"      | 403 `status: "forbidden", error: "session not accessible"` | ✅     |
| Auth failure                              | 401                               | 401 `"unauthorized"`                                       | ✅     |
| Timeout (sync)                            | 504                               | 504 `status: "timeout"`                                    | ✅     |
| `async + multiTurn`                       | 400                               | 400                                                        | ✅     |
| Capacity exceeded                         | 503                               | 503 `status: "capacity_exceeded"`                          | ✅     |
| Payload too large                         | 413                               | 413                                                        | ✅     |
| Invalid JSON                              | 400                               | 400                                                        | ✅     |
| Duplicate nonce                           | 409 (not in spec, but reasonable) | 409                                                        | ✅     |
| Circular send detection                   | 403 (sync multi-turn only)        | ❌ Not implemented                                         | ❌     |

---

## 11. Test Coverage Analysis

### 11.1 Coverage Significantly Improved Since Prior Reviews

| Scenario                             | Prior Status           | Current Status                    |
| ------------------------------------ | ---------------------- | --------------------------------- |
| Nonce replay rejection               | ❌ Not tested          | ✅ Tested (409)                   |
| Timestamp expiry                     | ❌ Not tested          | ✅ Tested (400)                   |
| Payload too large (>1MB)             | ❌ Not tested          | ✅ Tested (413)                   |
| maxConcurrent enforcement            | ❌ Not tested          | ✅ Tested (503)                   |
| XGW disabled enforcement             | ❌ Not tested          | ✅ Tested (503)                   |
| Invalid JSON body                    | ❌ Not tested          | ✅ Tested (400)                   |
| Missing required fields              | ❌ Not tested          | ✅ Tested (400)                   |
| 401 for invalid/missing token        | ❌ Not tested          | ✅ Tested                         |
| Callback wrong-peer (403)            | ❌ Not tested          | ✅ Tested                         |
| Callback already delivered           | ❌ Not tested          | ✅ Tested (200 already_delivered) |
| Callback expired (410)               | ❌ Not tested          | ✅ Tested                         |
| async+multiTurn rejection            | ❌ Not tested          | ✅ Tested                         |
| Corrupt state file recovery          | ❌ Not tested          | ✅ Tested                         |
| resolveEnvValue                      | ❌ Not tested          | ✅ Tested                         |
| Caller-side async ownership          | ❌ Not tested          | ✅ Tested                         |
| callerSessionKey propagation         | ❌ Not tested          | ✅ Tested                         |
| Remote runId over idempotency key    | ❌ Not tested          | ✅ Tested                         |
| messageSeq passthrough               | ❌ Not tested          | ✅ Tested                         |
| HTTP warning for insecure URL        | ❌ Not tested          | ✅ Tested                         |
| Non-existent session → 403 (not 404) | ❌ (test expected 404) | ✅ Fixed and tested               |

### 11.2 Remaining Coverage Gaps

| Scenario                                                          | Status                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `postCallbackWithRetry` retry backoff behavior (unit)             | ❌ Not tested                                                                                   |
| `initXgw()` called on startup (integration)                       | ❌ Not tested (and not wired)                                                                   |
| Dedicated `skynet` agentId selection on spawn                     | ❌ Not tested (behavior verified in code but no test asserts `agentId: "skynet"` in run params) |
| Circular-send detection                                           | ❌ Not tested (deferred feature)                                                                |
| Nonce time-window eviction                                        | ❌ Not tested                                                                                   |
| Callback delivery where `sourceSessionKey` has special characters | ❌ Not tested                                                                                   |
| `xgwOutboundDispatch` direct unit tests (unmocked)                | ❌ Only `sessions-xgw.test.ts` mocks it                                                         |
| `maxPendingAsync` 503 on inbound async                            | ❌ Not tested for inbound path (tested for outbound in sessions-xgw)                            |

---

## 12. Code Quality

### 12.1 Fixed Since Prior Reviews

| Issue                                              | Prior Status  | Current Status                                      |
| -------------------------------------------------- | ------------- | --------------------------------------------------- |
| `resolveEnvValue` duplicated in inbound + outbound | ⚠️ Duplicated | ✅ Extracted to `utils.ts`                          |
| `shutdownXgw()` / interval cleanup                 | ❌ Missing    | ✅ `shutdownXgw()` exported, stores `pruneInterval` |
| State persistence error logging                    | ⚠️ Silent     | ✅ `process.stderr.write()` in both catch blocks    |
| Receptionist fallback path                         | ⚠️ Dead code  | ✅ Removed                                          |
| `replyBack` dead field                             | ⚠️ Unused     | ✅ Removed                                          |
| `messageSeq: 1` hard-coded                         | ⚠️ Hard-coded | ✅ Fixed, passes through from remote                |
| Callback delivery session key prefix bug           | ❌ Critical   | ✅ Fixed                                            |

### 12.2 Remaining Quality Issues

| Issue                                                                                                        | Severity                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `XgwConfig` dual definition in `types.ts` and `types.gateway.ts`                                             | Minor — works at runtime via `extends`; confusing                                  |
| `exposureTtlSeconds` missing from `types.ts` XgwConfig                                                       | Minor — inherited via `extends`                                                    |
| `Date.now() / 1000` repeated without `nowSec()` helper                                                       | Minor — fragile pattern; no single bug but inconsistent                            |
| `getSessionMessages({ limit: 1 })` in `dispatchDirect` vs `limit: 5` in `extractReply`                       | Minor — inconsistency; direct dispatch may miss last reply on high-volume sessions |
| Config import paths: `inbound.ts` uses `../../config/config.js`, `sessions-xgw.ts` uses `../../config/io.js` | Minor — maintenance hazard                                                         |
| Global mutable state in `state.ts` (module-level Maps)                                                       | Minor — limits test isolation; tests work around it                                |
| `console.error` / `process.stderr.write` mixed logging (not using subsystem logger)                          | Minor — inconsistent with rest of gateway                                          |
| `as unknown as Record<string, unknown>` casts in HTTP responses                                              | Minor — hides type mismatches                                                      |

---

## 13. Prior Review Findings: Resolution Status

### 13.1 Opus Critical Findings

| Finding                                                                                 | Status                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Session enumeration: 404 vs 403** — Non-existent sessions returned 404 instead of 403 | ✅ **RESOLVED** — Both paths return 403            |
| **Callback delivery session key: `xgw:` prefix bug** — Created orphaned sessions        | ✅ **RESOLVED** — Uses `sourceSessionKey` directly |

### 13.2 Opus Important Findings

| Finding                                               | Status                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing `enabled` check on inbound                    | ✅ **RESOLVED** — Both handlers check `enabled !== true` at top                                                                                    |
| Callback retry with backoff missing                   | ✅ **RESOLVED** — `postCallbackWithRetry()` with 5s/15s/45s                                                                                        |
| Timeout push to waiting sessions missing              | ✅ **RESOLVED** — `notifyExpiredCallbacks()` implemented                                                                                           |
| Missing tests (auth, nonce, timestamp, maxConcurrent) | ✅ **RESOLVED** — All added                                                                                                                        |
| No outbound dispatch unit tests                       | ⚠️ **PARTIALLY RESOLVED** — `sessions-xgw.test.ts` tests the outbound dispatch handler; `xgwOutboundDispatch()` itself only tested via integration |
| Receptionist routing (dead code)                      | ✅ **RESOLVED** — Removed                                                                                                                          |

### 13.3 Opus Minor Findings

| Finding                                       | Status                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Shared `resolveEnvValue` utility              | ✅ **RESOLVED**                                                            |
| State persistence error logging               | ✅ **RESOLVED**                                                            |
| `shutdownXgw()` interval cleanup              | ✅ **RESOLVED** (implemented but not called)                               |
| Standardize logging                           | ⚠️ **PARTIALLY RESOLVED** — stderr logging exists but not subsystem logger |
| `replyBack` dead field                        | ✅ **RESOLVED**                                                            |
| Align 200 delivery_failed with retry strategy | ⚠️ **UNRESOLVED** — Still returns 200 on local delivery failure            |

### 13.4 GPT Blocker Findings

| Finding                                                         | Status                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Async ownership inverted** — receiver stored pendingCallbacks | ✅ **RESOLVED** — Correct ownership model implemented                                  |
| **Direct-session enumeration leaks**                            | ✅ **RESOLVED**                                                                        |
| **Outbound always impersonates main session**                   | ✅ **RESOLVED** — Uses `callerSessionKey`                                              |
| **Async retries missing**                                       | ✅ **RESOLVED**                                                                        |
| **Several required validations unimplemented**                  | ✅ **MOSTLY RESOLVED** — `async+multiTurn` now validated; multi-turn deferred per spec |

### 13.5 GPT Important Follow-ups

| Finding                                                          | Status                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `async && multiTurn` validation + multi-turn deferral documented | ✅ **RESOLVED**                                             |
| HTTPS enforcement                                                | ⚠️ **PARTIALLY RESOLVED** — Warning only, not enforced      |
| Wrong-peer callback tests                                        | ✅ **RESOLVED**                                             |
| Idempotency tests                                                | ✅ **RESOLVED**                                             |
| Caller-side persistence tests                                    | ✅ **RESOLVED**                                             |
| `skynet` agent selection test                                    | ⚠️ **UNRESOLVED** — No test asserts `agentId` in run params |
| **`initXgw()` not called**                                       | ❌ **STILL UNRESOLVED** — GPT flagged this; still present   |

---

## 14. Consolidated Findings by Priority

### Critical (Block Production Use)

| #   | Finding                                          | Impact                                                                                                                                                                                      |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **`initXgw()` never called from server-http.ts** | State not restored on restart; periodic pruning/timeout-notify never runs; stale exposure entries persist forever; async callbacks silently expire without notification to waiting sessions |

### Important (Fix Before Wider Rollout)

| #   | Finding                                                                                                | Impact                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| I1  | **`correlationId` and `nonce` auto-filled when absent** — hook handler accepts missing required fields | Breaks async tracking (caller can't predict correlationId); replay protection useless if nonce omitted |
| I2  | **Default `maxPendingAsync` = 100 in code, 20 in spec and config comment**                             | Allows 5x more pending async callbacks than spec                                                       |
| I3  | **Max payload size = 1MB vs spec's 64KB**                                                              | 16x the intended limit; especially risky for callback payloads                                         |
| I4  | **Nonce tracking is FIFO-only, not time-window-based**                                                 | Nonces older than 5 minutes still tracked; clean nonces can be permanently blocked if FIFO wraps       |
| I5  | **Default `skynet` safety fence system prompt not injected**                                           | Unconfigured gateways fall through to default agent behavior; spec's defensive prompt not guaranteed   |
| I6  | **HTTPS not enforced, only warned**                                                                    | Plaintext cross-gateway traffic allowed; token and payload in cleartext on LAN                         |

### Minor / Cleanup

| #   | Finding                                                                      | Impact                                                     |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| M1  | Spawn failure sets `expiresAt: now` instead of `removeExposure()`            | Stale zero-TTL entries sit in table until next prune cycle |
| M2  | `XgwConfig` dual definition                                                  | Code clarity and maintenance                               |
| M3  | `Date.now() / 1000` repeated without helper                                  | Fragile pattern; no immediate bug                          |
| M4  | Mixed logging (`console.error` + `process.stderr.write` vs subsystem logger) | Log level control, consistency                             |
| M5  | 200 on delivery failure suppresses peer retries                              | Non-recoverable transient failures                         |
| M6  | `dispatchDirect` uses `limit: 1` vs `extractReply`'s `limit: 5`              | Inconsistency in reply extraction                          |
| M7  | Config import path inconsistency (`config.js` vs `io.js`)                    | Maintenance hazard                                         |

---

_End of spec compliance matrix._
