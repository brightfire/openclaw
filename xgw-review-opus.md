# Cross-Gateway (XGW) Code Review

**Reviewer:** Opus (subagent)
**Date:** 2026-04-17
**Scope:** All XGW source files vs `stable/v2026.4.14`, checked against `DESIGN.md`

---

## Executive Summary

The XGW implementation is solid for an MVP. The core inbound/outbound flow works, security fundamentals (timing-safe token comparison, nonce replay, peer-scoped exposure) are correctly implemented, and the test suite covers the critical happy paths. However, there are several deviations from the spec — some intentional renames, some missing features, and a couple of security-relevant discrepancies that should be addressed before production use.

**Critical issues:** 2
**Important issues:** 8
**Minor/quality issues:** 7

---

## 1. Spec Deviations

### 1.1 Intentional Renames (Likely Fine, Should Be Documented)

The implementation consistently renames `skynet` → `xgw` in internal identifiers:

| Design Spec              | Implementation        | Files                                        |
| ------------------------ | --------------------- | -------------------------------------------- |
| `/hooks/skynet`          | `/hooks/xgw`          | `types.ts:108`, `server-http.ts` (isXgwPath) |
| `/hooks/skynet/callback` | `/hooks/xgw/callback` | `types.ts:113`, `server-http.ts`             |
| `skynet:` session prefix | `xgw:` session prefix | `types.ts:103`                               |
| `skynet-async.json`      | `xgw-async.json`      | `state.ts:75`                                |

However, the dispatcher entry point key is still `"skynet"` (`types.ts:118`, `inbound.ts:230`), which creates an inconsistency: endpoints use "xgw" but the magic session key is still "skynet". The design comment in `types.ts` references `@ember/skynet` which is the design-spec addressing, so this is intentional — but confusing. Consider documenting this mapping somewhere or completing the rename.

### 1.2 Session Enumeration Prevention — SPEC VIOLATION [CRITICAL]

**Design (§5, §10.4):** "Both unexposed and non-existent sessions return 403 - no distinction"

**Implementation (`inbound.ts:159-162`):**

```typescript
if (!exposure) {
  return { ok: false, status: "not_found", error: "unknown session key" };
}
```

This returns `"not_found"` which maps to **HTTP 404** (`inbound.ts:271`):

```typescript
const httpStatus = result.status === "timeout" ? 504 : result.status === "not_found" ? 404 : 403;
```

A 404 for non-existent sessions vs 403 for wrong-peer sessions enables session enumeration. An attacker with a valid peer token can probe session keys and distinguish "exists but not mine" (403) from "doesn't exist" (404).

**Fix:** Return 403 for both cases in the direct dispatch path, as the spec requires.

### 1.3 Max Payload Size Mismatch

**Design (§12):** "Max callback payload size: 64KB"
**Implementation (`inbound.ts`):** Both the main hook and callback handler use `readJsonBody(req, 1048576)` — **1 MB**.

This is 16x the spec limit. For callbacks especially, the design rationale is that callback payloads are small (reply text). 1MB is generous but probably fine; should be a conscious decision.

### 1.4 Max Pending Async Default Mismatch

**Design (§12):** "Max pending async callbacks per gateway: 20 (configurable)"
**Implementation (`inbound.ts:246`):** `cfg.maxPendingAsync ?? 100`

Default is **100** vs the spec's **20**. This is 5x the design default. The design notes these are gateway-level caps. This may be intentional loosening, but should be documented.

### 1.5 Missing: async + multiTurn Mutual Exclusion

**Design (§4.4):** "async=true and multiTurn=true are mutually exclusive. If both are set, the gateway returns a 400 validation error."

**Implementation:** Neither field is validated against the other. The `multiTurn` field isn't even parsed from the request body. No multi-turn logic exists at all (see §1.6).

### 1.6 Missing: Multi-Turn Loop

**Design (§4.3):** Describes a ping-pong multi-turn flow managed by the sending gateway.

**Implementation:** Not implemented. The `multiTurn` field is declared in `XgwInboundRequest` (`types.ts:55`) but never read or acted upon in `inbound.ts`. This is the biggest feature gap vs the spec.

### 1.7 Missing: Callback Retry Logic [IMPORTANT]

**Design (§4.4.4):** "Ember retries callback POST up to 3 times with exponential backoff (5s, 15s, 45s)"

**Implementation (`inbound.ts:320-368`):** `handleAsyncCallback` is fire-and-forget with a single attempt. On failure, it logs a warning and marks the delivery attempt but does NOT retry:

```typescript
// line ~355
console.warn(`[xgw] callback POST failed for %s: %s`, correlationId, errMsg);
return;
```

This means transient network failures between gateways will cause permanent callback loss. The design explicitly requires retry with backoff.

### 1.8 Missing: Circular Send Detection

**Design (§11):** "Circular send (looped reply): Rejected for synchronous multi-turn loops only: if the authenticated peer identity matches the original sender during a ping-pong exchange, the gateway rejects the send."

Not implemented (follows from multi-turn not being implemented).

### 1.9 Missing: Timeout Push to Waiting Session

**Design (§4.4.4):** "callbackTimeoutSeconds expires → Gateway pushes a timeout message to the waiting session"

**Implementation:** `pruneExpired()` in `state.ts` transitions pending callbacks to "expired" and sets `resultStatus: "timeout"`, but it does **NOT** push a timeout message to the waiting session. The session just never hears back. The agent will be stuck waiting indefinitely.

**Fix:** `pruneExpired()` (or a separate mechanism) should dispatch a timeout notification to `sourceSessionKey` when transitioning to expired status.

---

## 2. Security

### 2.1 Token Auth — Good ✓

`authenticateXgwToken` (`inbound.ts:100-109`) uses `timingSafeEqual` with proper buffer length comparison. This prevents timing attacks on token values.

### 2.2 Nonce/Timestamp Validation — Good ✓

- `checkNonce` (`state.ts:105-116`): Per-peer nonce tracking with FIFO eviction at 10K cap, matching spec.
- `validateTimestamp` (`state.ts:118-121`): 5-minute window, matching spec.
- Both are applied in `handleXgwHook` and `handleXgwCallback`.

### 2.3 Env Variable Resolution — Good ✓

`resolveEnvValue` properly resolves `${ENV_VAR}` syntax for token configs, with stderr warnings for unresolved vars.

### 2.4 Exposure Table Peer Scoping — Good ✓

`dispatchDirect` (`inbound.ts:155-192`) checks `exposure.allowedPeer !== peer` before dispatching. Callback handler (`inbound.ts:415`) also checks `pending.allowedPeer !== peer`.

### 2.5 Callback Authorization — Minor Issue

When a callback's `pendingCallbacks` entry doesn't exist (pruned or never created), the response is:

```typescript
sendJson(res, 403, { ok: false, error: "unauthorized" });
```

This matches the spec ("Unknown correlationId → 403"). Good — no information leakage.

### 2.6 No TLS Enforcement

**Design (§10.1):** "All cross-gateway communication must use HTTPS, even on LAN."

Neither inbound nor outbound enforce or warn about non-TLS connections. The outbound dispatch (`outbound.ts`) will happily POST to `http://` URLs. Consider at minimum logging a warning when a peer URL doesn't use HTTPS.

### 2.7 Callback Delivery Session Key Construction — Potential Bug [IMPORTANT]

In `handleXgwCallback` (`inbound.ts:434-438`):

```typescript
const deliverySk =
  pending.sourceSessionKey.startsWith(XGW_SESSION_PREFIX) ||
  pending.sourceSessionKey.startsWith("hook:")
    ? pending.sourceSessionKey
    : `${XGW_SESSION_PREFIX}${pending.sourceSessionKey}`;
```

If `sourceSessionKey` is `"agent:main"` (the common case from the design flow), this becomes `"xgw:agent:main"`. That's a **new session key** that doesn't correspond to any existing session. The callback result would be dispatched into a fresh session instead of injecting into the calling agent's existing session.

The design (§4.4.1 step 6d) says: "Pushes the reply as the next message to agent:main". The callback should deliver to the _actual_ source session key, not prefix it with `xgw:`.

This logic seems designed for the case where the source session is itself an XGW session, but for the primary use case (main agent → remote gateway → callback), it will create an orphaned session.

**Fix:** Remove or rethink the `xgw:` prefixing. The `sourceSessionKey` should be used as-is for delivery.

---

## 3. Error Handling & Edge Cases

### 3.1 State Persistence — Silent Failures

Both `loadState` and `saveState` in `state.ts` swallow all errors:

```typescript
} catch {
  // corrupt or missing — start fresh
}
```

```typescript
} catch {
  // best-effort persistence; no fsync guarantees
}
```

The design acknowledges this is acceptable ("No WAL or fsync guarantees"), but there's no logging at all. A corrupt state file will silently reset all pending callbacks, with no trace in logs. Add at minimum a `console.warn` in both catch blocks.

### 3.2 spawnWorker — Broken Exposure Entry on Failure [MINOR]

In `spawnWorker` (`inbound.ts:140-145`), on `subagent.run()` failure:

```typescript
setExposure(sessionKey, {
  correlationId,
  allowedPeer: peer,
  createdAt: now,
  expiresAt: now, // expire immediately on failure
});
```

Setting `expiresAt: now` doesn't actually remove the entry — it just makes it expired. It will sit in the table until the next pruneExpired cycle. Better to call `removeExposure(sessionKey)` to clean up immediately.

### 3.3 handleAsyncCallback — Worker Timeout Handling

In `handleAsyncCallback` (`inbound.ts:299-317`):

```typescript
if (workerTimedOut) {
  resultStatus = "timeout";
  resultError = `Worker timed out after ${Math.floor(timeoutMs / 1000)}s`;
}

if (!workerTimedOut) {
  reply = await extractReply(sessionKey);
```

When the worker times out, the function still tries to POST the callback with `status: "timeout"`. If the callback POST also fails, it marks the callback as expired. But if the callback POST succeeds, the callback is marked as "delivered" with `resultStatus: "timeout"` — which is correct behavior.

However, if the worker produces output but then times out during `waitForRun`, the timeout path is taken even though a reply may exist. Consider attempting `extractReply` even on timeout.

### 3.4 Exposure Table — Mixed Units

`getExposure` uses `Date.now() / 1000` (seconds) for comparison, which is consistent with how `expiresAt` is stored. But `refreshExposure` uses:

```typescript
entry.expiresAt = Date.now() / 1000 + ttlSeconds;
```

This is correct, but the pattern of `Date.now() / 1000` scattered throughout (no helper function) is fragile. A `nowSec()` utility would prevent potential floating-point issues.

### 3.5 Callback Delivery on Server Error Returns 200

In `handleXgwCallback` (`inbound.ts:457-460`):

```typescript
} catch (err) {
  // Return 200 to prevent peer retries that would also fail
  sendJson(res, 200, { ok: true, status: "delivery_failed" });
  return true;
}
```

The comment explains the rationale, but this is inconsistent with the design's retry expectation (§4.4.4). If we're supposed to implement retries on the sender side, returning 200 defeats that. If we're NOT implementing retries, the 200 is defensible. Needs alignment with the retry decision.

---

## 4. Outbound Dispatch

### 4.1 Receptionist Key Resolution — Logic Issue

In `outbound.ts:72-74`:

```typescript
if (remoteKey === "receptionist") {
  targetKey = xgwCfg.receptionist?.sessionKey ?? "agent:receptionist:main";
}
```

This resolves the receptionist key using the **local** gateway's config, not the remote gateway's. The remote gateway may have a different receptionist session key configured. This should probably just pass `"receptionist"` through and let the remote gateway resolve it — or be documented as a convention that both sides must agree on.

### 4.2 Response Data Extraction — Fragile Casting

`outbound.ts:112-127` uses extensive `as` casts to extract fields from the response:

```typescript
return {
  runId: (data as { runId?: string } | null)?.runId ?? corrId,
  status: (data as { status?: string } | null)?.status ?? "ok",
  reply: (data as { reply?: string | null } | null)?.reply ?? null,
  sessionKey: (data as { sessionKey?: string } | null)?.sessionKey ?? targetKey,
};
```

This works but is fragile and hard to read. A simple type guard or validation function would be cleaner and safer.

### 4.3 Custom Headers on Outbound

Outbound requests include `X-XGW-Correlation-Id` and `X-XGW-Source-Gateway` headers (`outbound.ts:95-96`), but the inbound handler never reads these headers — it derives everything from the body and auth token. These headers are effectively dead code. They could be useful for logging/debugging on the receiving side, but currently serve no purpose.

---

## 5. Sessions-XGW Integration

### 5.1 Missing `enabled` Check on Inbound

The outbound handler (`sessions-xgw.ts:44-50`) correctly checks `xgwCfg.enabled`:

```typescript
if (!xgwCfg.enabled) {
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, "Cross-gateway messaging is not enabled"),
  );
  return;
}
```

But the inbound handler (`inbound.ts:handleXgwHook`) does NOT check if XGW is enabled before processing requests. If `crossGateway.enabled` is false but tokens are still configured, the inbound endpoint will still accept and process requests.

**Fix:** Add an `enabled` check at the top of `handleXgwHook` and `handleXgwCallback`.

### 5.2 Config Import Paths — Inconsistency

- `inbound.ts` imports `loadConfig` from `../../config/config.js`
- `sessions-xgw.ts` imports `loadConfig` from `../../config/io.js`

These may resolve to the same thing (io.js re-exports from config.js or vice versa), but the inconsistency is a maintenance hazard. Should use the same import path.

### 5.3 Receptionist Routing in Inbound — Not in Spec

`inbound.ts:278-290` includes a receptionist routing path:

```typescript
const rxKey = getReceptionistKey();
if (sessionKey === rxKey || sessionKey.startsWith("agent:receptionist")) {
  const result = await dispatchDirect(sessionKey, message, peer, timeoutSeconds, cfg);
```

This is not documented in the design spec, which only describes two paths: dispatcher (`skynet`) and direct session (`xgw:<id>`). The receptionist routing appears to be a legacy path from the pre-dispatcher model. It calls `dispatchDirect` which requires an exposure table entry — but receptionist sessions aren't registered in the exposure table, so this will always return "not_found".

This code path is effectively dead unless exposure entries are manually created for receptionist keys. Consider removing it or documenting it.

---

## 6. Type Safety

### 6.1 XgwConfig in types.ts — Circular Extension

```typescript
export interface XgwConfig extends NonNullable<FleetConfig["crossGateway"]> {
```

This creates a type that extends itself (FleetConfig.crossGateway IS XgwConfig from types.gateway.ts). The types.gateway.ts file defines its own `XgwConfig` type. Having two `XgwConfig` types — one in `types.ts` (XGW module) and one in `types.gateway.ts` (config module) — is confusing.

The one in `types.ts` adds no new fields beyond what's in `types.gateway.ts`, making the extension pointless. It should either import and re-export the config type or be removed in favor of using `types.gateway.ts` directly.

### 6.2 Missing `exposureTtlSeconds` in types.ts XgwConfig

The `XgwConfig` in `types.ts` doesn't declare `exposureTtlSeconds`, but `inbound.ts` accesses `cfg.exposureTtlSeconds` (e.g., line ~130, ~168). This works at runtime because the `extends NonNullable<FleetConfig["crossGateway"]>` pulls in the property from `types.gateway.ts`, but it's invisible in the local type definition — confusing for anyone reading `types.ts`.

### 6.3 replyBack Field — Unused

`XgwInboundRequest.replyBack` is declared in `types.ts` and sent in outbound requests (`outbound.ts:88`), but never read by the inbound handler. Dead field.

---

## 7. Test Coverage

### 7.1 What's Covered — Good

The `inbound-http.test.ts` file covers:

- ✅ Sync dispatcher flow (skynet → spawn → reply)
- ✅ Callback delivery to pending sessions
- ✅ Direct dispatch to exposed sessions
- ✅ Peer scoping (403 for wrong peer)
- ✅ 404 for non-existent sessions
- ✅ Async flow with state persistence
- ✅ Failed callback delivery with reload persistence
- ✅ Expired callback pruning
- ✅ Expired exposure table entries

The `sessions-xgw.test.ts` covers:

- ✅ Malformed `@gateway` key rejection
- ✅ Successful outbound dispatch with reply
- ✅ Timeout mapping to AGENT_TIMEOUT

### 7.2 Coverage Gaps [IMPORTANT]

| Scenario                                            | Status                  |
| --------------------------------------------------- | ----------------------- |
| Nonce replay rejection (same nonce, same peer)      | ❌ Not tested           |
| Timestamp expiry (>5 min old)                       | ❌ Not tested           |
| Payload too large (>1MB body)                       | ❌ Not tested           |
| maxConcurrent enforcement (503 when full)           | ❌ Not tested           |
| XGW disabled but tokens configured (inbound)        | ❌ Not tested           |
| Invalid JSON body                                   | ❌ Not tested           |
| Missing required fields (no sessionKey, no message) | ❌ Not tested           |
| 401 for invalid/missing token                       | ❌ Not tested           |
| Outbound dispatch (`xgwOutboundDispatch`)           | ❌ No unit tests at all |
| State sanitization (corrupt JSON in state file)     | ❌ Not tested           |
| `resolveEnvValue` for token resolution              | ❌ Not tested           |
| Callback expiry (410 response)                      | ❌ Not tested           |
| Callback wrong peer (403)                           | ❌ Not tested           |
| Callback already delivered (idempotent 200)         | ❌ Not tested           |

The auth rejection path (401) is particularly important to test — it's the first line of defense.

---

## 8. Code Quality

### 8.1 Duplicated `resolveEnvValue`

The function appears in both `inbound.ts` (~line 80) and `outbound.ts` (~line 8). Extract to a shared utility.

### 8.2 initXgw Interval Cleanup

`initXgw` (`inbound.ts:474`) creates a `setInterval` for periodic pruning but returns no cleanup handle:

```typescript
setInterval(() => {
  pruneExpired();
}, 60_000);
```

In test environments or gateway restarts, these intervals can leak. Return the interval ID and provide a `shutdownXgw()` function.

### 8.3 Global Mutable State in state.ts

`state.ts` uses module-level `Map` instances for all state. This works for a single gateway process but makes testing harder (tests must manually reset state between runs). The test file works around this by dynamically importing the module. Consider a state class that can be instantiated per test.

### 8.4 Console Logging

The module uses a mix of `console.warn`, `console.error`, and `process.stderr.write` for logging. The rest of the gateway uses `createSubsystemLogger`. XGW should use the same logging infrastructure for consistency and log level control.

---

## 9. Summary of Recommended Actions

### Critical (Fix Before Production)

1. **Session enumeration:** Change direct-session 404 to 403 to match spec and prevent enumeration
2. **Callback delivery session key:** Fix `xgw:` prefix logic in `handleXgwCallback` that creates orphaned sessions instead of delivering to the actual source session

### Important (Fix Before Wider Rollout)

3. Add `enabled` check to inbound handlers
4. Implement callback retry with exponential backoff (or explicitly document deviation from spec)
5. Push timeout notification to waiting sessions when async callbacks expire
6. Add tests for auth rejection, nonce replay, timestamp expiry, maxConcurrent
7. Add outbound dispatch unit tests
8. Fix receptionist routing (remove dead code or implement properly)

### Minor (Cleanup)

9. Extract shared `resolveEnvValue` utility
10. Add logging to state persistence error handlers
11. Provide `shutdownXgw()` for interval cleanup
12. Standardize logging (use subsystem logger)
13. Document intentional spec deviations (endpoint rename, payload size, defaults)
14. Clean up dead `replyBack` field
15. Align 200 response on delivery failure with retry strategy decision
