# XGW Cross-Gateway Code Review

**Reviewed:** 2026-04-17  
**Branch:** `feature/xgw-cross-gateway-full`  
**Reviewer:** Qwen (sub-agent)

---

## 1. Security

### 1.1 Token Authentication — ✅ Solid but watch for timing-leak gaps

**Location:** `inbound.ts` lines 78–93, `authenticateXgwToken`

- Tokens are compared using `timingSafeEqual` (line 87), which is correct.
- `resolveEnvValue` is called on the _known_ token (line 86), resolving `${ENV_VAR}` syntax at auth time. This is important: the known side gets `$ENV_VAR` expanded, the incoming token does not. This is correct but means config must store `${XGW_EMBER_TOKEN}`, not the raw value.
- **Issue (minor):** `authenticateXgwToken` iterates all tokens in `Object.entries(tokens)`. The order is insertion order of the config object. If there are many peers, this is O(n) per request. Not a security gap, but worth noting for large fleets (10+ gateways).

### 1.2 Nonce Replay Protection — ✅ Good, but has a known edge case

**Location:** `state.ts` lines 181–193, `noncesByPeer` FIFO map

- Per-peer nonce tracking with 10,000-entry cap and FIFO eviction is sound.
- Nonces are recorded _before_ the request is fully processed (line 395 in `inbound.ts`), so even rejected requests (e.g., 403 "session not accessible") consume a nonce slot. This is correct behavior — it prevents an attacker from using replay to probe for valid sessions.
- **Confirmed by test:** `inbound-http.test.ts` "returns 409 when a nonce is replayed by the same peer" verifies the 403-then-409 pattern.

### 1.3 Timestamp Validation — ⚠️ DUPLICATE, minor inconsistency

**Location:** `inbound.ts` line 397 vs `state.ts` lines 175–177

- The inbound hook validates timestamps **inline** at line 397:
  ```typescript
  if (Math.abs(nowSec - timestamp) > 300) {
    sendJson(res, 400, ...);
  }
  ```
- But `validateTimestamp(ts)` also exists in `state.ts` (lines 175–177) and is **only used for callbacks** (line 643 in `inbound.ts`).
- This means there are two copies of the same logic (5-minute window) that could drift.
- **Recommendation:** Replace the inline check at `inbound.ts:397` with `validateTimestamp(timestamp)`. This is already imported but not used for the main request path.

### 1.4 Peer Scoping (Exposure Table) — ✅ Correct

**Location:** `inbound.ts` `dispatchDirect` (lines 206–252), `state.ts` `getExposure`

- When a dispatcher spawns a worker session, it registers an `XgwExposureEntry` with `allowedPeer: peer` (line 137 of `inbound.ts`).
- `dispatchDirect` checks `exposure.allowedPeer !== peer` before allowing access (line 212).
- Expired entries are cleaned up in `getExposure` (line 199 in `state.ts`).
- **Confirmed by test:** "returns 403 when a peer targets an exposed xgw session owned by another peer" and "expires stale xgw exposure before dispatch and returns 403".

### 1.5 Session Enumeration Prevention — ✅ Implicit

- Non-prefixed session keys (other than `"skynet"`) are rejected at line 451 of `inbound.ts`: `"unknown session key"`.
- Only `xgw:<correlationId>` keys (which are created internally by the dispatcher) can reach `dispatchDirect`.
- An attacker with a valid token cannot iterate arbitrary session keys — unknown ones are rejected.
- **One gap:** The `"skynet"` dispatcher key (line 402) is a _wildcard entry point_. Any authenticated peer can spawn worker sessions freely. There's no per-peer rate limiting on dispatcher spawns. If a peer is compromised, they could spawn unlimited workers up to `maxConcurrent` (capped per-gateway, not per-peer). Consider per-peer session limits.

### 1.6 Exposure Table — ⚠️ Race Condition on Exposure Refresh

**Location:** `inbound.ts` lines 217–218, `dispatchDirect`

```typescript
const ttl = cfg.exposureTtlSeconds ?? 300;
refreshExposure(sessionKey, ttl);
saveState();
```

Between `refreshExposure` (which mutates the in-memory Map entry) and `saveState`, another concurrent handler could also mutate the same entry. In Node.js this is not a true race (single-threaded), but if `setInterval` (`pruneExpired`) runs between these two calls, it could read a stale view. This is benign in practice since all mutations are serialized by the event loop.

### 1.7 Inbound Token Resolution — ⚠️ Potential Misconfiguration Vector

**Location:** `inbound.ts` line 84–86

```typescript
const tokens = getAcceptedTokens();
// ...
const knownBuf = Buffer.from(resolveEnvValue(known));
```

`getAcceptedTokens()` reads `acceptedTokens` from config, which maps peer names to token values. If a token in config is stored as a plain string (not `${...}`), `resolveEnvValue` returns it unchanged. If it's stored as `${ENV_VAR}` and the env var is missing, `resolveEnvValue` logs a warning and returns the literal `${ENV_VAR}`. This means a misconfigured gateway would _authenticate_ against the literal string `${XGW_TOKEN}` — which is almost certainly not what the user wants. A stricter behavior (fail to accept tokens with unresolved env vars) would be safer.

---

## 2. Error Handling

### 2.1 Edge Cases — ✅ Mostly handled

| Edge case                  | File / Line          | Status         |
| -------------------------- | -------------------- | -------------- |
| Missing auth header        | `inbound.ts:322–326` | ✅ 401         |
| Invalid token              | `inbound.ts:327–331` | ✅ 401         |
| Invalid JSON body          | `inbound.ts:340–349` | ✅ 400/413/408 |
| Missing sessionKey/message | `inbound.ts:394–396` | ✅ 400         |
| Expired timestamp          | `inbound.ts:397–401` | ✅ 400         |
| Duplicate nonce            | `inbound.ts:402–406` | ✅ 409         |
| XGW disabled               | `inbound.ts:315–321` | ✅ 503         |
| Capacity exceeded          | `inbound.ts:118–122` | ✅ 503         |
| Unknown session key        | `inbound.ts:451`     | ✅ 400         |

### 2.2 Crash Recovery — ⚠️ No fsync, best-effort only

**Location:** `state.ts` `saveState` (lines 113–126)

- State is written with `fs.writeFileSync`, no atomicity guarantees. If the process crashes mid-write, the file could be truncated/corrupt.
- `loadState` handles corrupt files gracefully (wrapping in try/catch, starts fresh). This is acceptable for this use case — stale nonces and exposure entries are tolerable loss.
- **Recommendation (future):** Write to a temp file + `fs.renameSync` for atomic updates on POSIX systems. Low cost, high reliability benefit.

### 2.3 Callback Failure Paths — ⚠️ Silent Loss on Permanent Failure

**Location:** `inbound.ts` lines 488–503, `handleAsyncCallbackOutbound`

```typescript
const result = await postCallbackWithRetry(peerUrl, outboundToken, callbackPayload);
if (!result.ok) {
  console.error(`[xgw] callback delivery permanently failed...`);
  // Caller-side record will be pruned/expired by the caller's own pruner.
}
```

- When all 3 callback retries fail, the result is **only logged to stderr**. The caller-side pendingCallback record will eventually expire and trigger a timeout notification (`notifyExpiredCallbacks`).
- This means the user on the calling side sees a generic "timed out" message rather than "callback delivery failed to peer — reply may have been generated but not received."
- **Recommendation:** Consider surfacing this distinction. The current behavior is acceptable but could be confusing for users.

### 2.4 `readJsonBody` — ⚠️ No handling of `req.socket?.destroy()` side effects

**Location:** `inbound.ts` lines 266–298

After `req.destroy()` is called (lines 273, 287), the promise resolves but `req.destroy()` may also emit an `error` event on the request stream, which could cause an unhandled rejection in the surrounding HTTP server. Node's `IncomingMessage.destroy()` is generally safe, but adding an explicit `.on('error', () => {})` guard on the request would make this clearer.

---

## 3. Async Callback Flow

### 3.1 Caller-Side Ownership — ✅ Correct Design

**Location:** `sessions-xgw.ts` lines 98–114, `outbound.ts` `handleAsyncCallbackOutbound` lines 440–503

- The calling gateway creates the `pendingCallback` record **before** dispatching (correct — this is the ownership fix described in git commit `975e89e8ba`).
- The receiving gateway does **NOT** create local state — it just runs the worker and `POST`s the callback back.
- Confirmed by test: `"accepts async requests and POSTs callback to the calling peer (receiver-side, no local state)"` verifies `getPendingCallback("corr-async")` returns `undefined` on the receiver.

### 3.2 Retry/Backoff — ✅

**Location:** `outbound.ts` `postCallbackWithRetry` (lines 28–67)

- 3 attempts with exponential backoff: 5s, 15s, 45s (5 \* 3^(n-1)).
- Total worst-case latency: ~65s. This is reasonable but worth noting: if the `callbackTimeoutSeconds` is shorter (e.g., 10s), all retries will complete _after_ the timeout expires, and the caller-side pending record will have already triggered a timeout notification by then. The late successful callback will arrive as an "already delivered" or be pruned depending on the timeline.

### 3.3 Timeout Handling — ⚠️ Worker Timeout vs Callback Timeout Ambiguity

**Location:** `inbound.ts` `_handleAsyncCallbackOutbound` (lines 440–503), `outbound.ts` `xgwOutboundDispatch` (lines 145–237)

- The **worker** has its own `timeoutMs` passed from `callbackTimeoutSeconds * 1000`.
- The **callback delivery** has its own retry window (~65s total).
- The **callee-side** pending record also has an `expiresAt` set at creation time (from `callbackTimeoutSeconds`).
- These three timers are independent and can produce confusing states:
  1. Worker times out → sets `resultStatus = "timeout"`
  2. Callback POST retries fail → result lost
  3. Caller's pending record expires → user sees timeout
  4. Later, a retry succeeds → callback delivers after timeout notification

  Steps 3 and 4 could mean the user gets both a timeout notification AND the actual reply. This is handled (idempotent "already_delivered" response), but the user experience is poor.

- **Recommendation:** Consider reducing retry delays when the callback is close to expiry, or skip retries entirely if `expiresAt - now < totalRetryWindow`.

---

## 4. Outbound Dispatch

### 4.1 Caller Identity Propagation — ✅ Correct

**Location:** `outbound.ts` lines 100–102

```typescript
const reqBody: Record<string, unknown> = {
  sessionKey: targetKey,
  message,
  sourceSessionKey: opts?.agentSessionKey ?? "",
  sourceChannel: opts?.agentChannel ?? "",
  // ...
};
```

- `agentSessionKey` and `agentChannel` flow from the caller's `callerSessionKey`/`callerChannel` params through `xgwOutboundDispatch` into `sourceSessionKey`/`sourceChannel` in the outbound request.
- The receiver uses these to set `InputProvenance` (`inbound.ts` line 139–142).
- Headers `X-XGW-Correlation-Id` and `X-XGW-Source-Gateway` are also set (lines 193–194). Note: these headers are set but **not consumed** by the receiver. They could be removed or used for auditing.

### 4.2 Response Handling — ✅

- HTTP status codes are mapped correctly (401, 403, 504, other).
- `res.json()` failures gracefully fall back to the status text.
- AbortError from timeout is correctly distinguished from other errors.

### 4.3 HTTPS Warning — ✅ Non-blocking

**Location:** `outbound.ts` lines 95–99

```typescript
if (!peer.url.startsWith("https://")) {
  process.stderr.write(`[xgw] outbound request to peer ${gwName} uses insecure URL: ${peer.url}\n`);
}
```

- Warns but does not block. Appropriate for dev/testing environments where HTTP is expected.
- **Test coverage:** Confirmed by `sessions-xgw.test.ts` "logs a stderr warning when outbound peer URL uses http://".

### 4.4 Timeout for Outbound Fetch — ⚠️ Tight Coupling

**Location:** `outbound.ts` lines 189–190

```typescript
timer = setTimeout(() => ctrl.abort(), Math.min(timeoutSec * 1000 + 5000, 125000));
```

- The fetch timeout is `timeoutSeconds + 5 seconds`, capped at 125s.
- This means a 30-second request timeout becomes a 35-second HTTP deadline, while the remote may take up to 30 seconds for `waitForRun`. The extra 5 seconds covers HTTP overhead. This is reasonable but tight under high load.

---

## 5. Code Quality

### 5.1 Type Safety — ✅ Generally good

- `XgwInboundRequest` and `XgwInboundResponse` types are well-defined.
- All runtime type checks use `typeof` guards on `unknown` values.
- **Issue:** The `XgwCallbackRequest` type (line 75 in `types.ts`) is defined but **never imported or used** in the runtime code. It's dead code. Same for `XgwInboundRequest` — it's imported by name in `types.ts` exports but runtime code parses raw `Record<string, unknown>` instead of using the type.

### 5.2 Consistency — ⚠️ Two timestamp validation implementations

As noted in §1.3:

- `handleXgwHook` (line 397): `if (Math.abs(nowSec - timestamp) > 300)`
- `handleXgwCallback` (line 643): `validateTimestamp(timestamp)`

Both implement the same 5-minute window but in different ways. The callback path also checks `if (timestamp && ...)` while the main hook path validates even when timestamp is 0. For the main hook, a timestamp of 0 is always rejected (since 0 != nowSec), which is correct. For callbacks, a timestamp of 0 **passes** the timestamp check (since `0 && !validateTimestamp(0)` evaluates to `false && ... = false`). A callback with `timestamp: 0` would only be rejected for a missing nonce if no nonce check exists. This is a minor inconsistency.

### 5.3 Config Loading — ⚠️ Inconsistent Config Access Patterns

- `inbound.ts` uses two different config loading approaches:
  - `getXgwConfig()` (line 60): calls `loadConfig()` from `../../config/config.js`, returns `cfg?.fleet?.crossGateway`
  - `getAcceptedTokens()` (line 67): calls `loadConfig()` from `../../config/config.js`, returns `cfg?.fleet?.crossGateway?.acceptedTokens`
- Both re-read the config file on every call. For the auth path (hot path), this is unnecessary IO on every request.
- `outbound.ts` `getXgwConfig` (line 70) takes a `cfg: OpenClawConfig` parameter and does a simple property access — no file IO.
- **Recommendation:** Pass the config snapshot through from the request handler rather than re-loading the file on each request. The `handleXgwHook` already reads config at line 333; use that snapshot for downstream calls.

### 5.4 Dead Code

| Symbol                    | Location         | Notes                                                                      |
| ------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `XgwInboundRequest`       | `types.ts:34–44` | Defined but never used — runtime uses `Record<string, unknown>`            |
| `XgwCallbackRequest`      | `types.ts:75–83` | Defined but never used — runtime uses `Record<string, unknown>`            |
| `XGW_HOOK_PATH`           | `types.ts:93`    | Defined but not imported/used in `server-http.ts` (hardcoded path instead) |
| `XGW_CALLBACK_PATH`       | `types.ts:98`    | Same — hardcoded in `server-http.ts`                                       |
| `XGW_DISPATCHER_KEY`      | `types.ts:103`   | Exported but not imported anywhere outside `types.ts`                      |
| `_sourceSessionKey` param | `inbound.ts:446` | Prefixed with `_` (unused) in `handleAsyncCallbackOutbound`                |

### 5.5 Test Coverage — ⚠️ Gaps

The tests are comprehensive but have some gaps:

| Scenario                                        | Status     | Notes                                                             |
| ----------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| XGW disabled (503)                              | ✅ Covered | Both `/hooks/xgw` and `/hooks/xgw/callback`                       |
| Invalid auth (401)                              | ✅ Covered | Missing header, bad token                                         |
| Nonce replay (409)                              | ✅ Covered | First request records, second rejects                             |
| Timestamp expiry (400)                          | ✅ Covered | 301-second-old timestamp                                          |
| Capacity exceeded (503)                         | ✅ Covered | Pre-saturated exposure table                                      |
| Peer scoping (403)                              | ✅ Covered | Wrong peer on exposed session                                     |
| Expired callback (410)                          | ✅ Covered | Pre-expired pendingCallback                                       |
| Async fire-and-forget                           | ✅ Covered | Response accepted, no local state                                 |
| Async callback failure                          | ✅ Covered | First attempt fails, no crash                                     |
| Corrupt state recovery                          | ✅ Covered | Logs warning, starts fresh                                        |
| HTTPS warning                                   | ✅ Covered | `sessions-xgw.test.ts`                                            |
| **Timeout in dispatchDirect**                   | ⚠️ Partial | Covers timeout but only verifies error is swallowed               |
| **spawnWorker subagent failure**                | ❌ Missing | No test for `getSubagent() === null`                              |
| **extractReply failure modes**                  | ❌ Missing | No test for missing agent messages, malformed content             |
| **`readJsonBody` edge cases**                   | ⚠️ Partial | Tests invalid JSON, too-large, but not request body timeout (408) |
| **Callback handler with missing correlationId** | ❌ Missing | Early return path                                                 |
| **Callback handler with invalid status value**  | ❌ Missing | The `VALID_STATUS` check path                                     |
| **notifyExpiredCallbacks**                      | ❌ Missing | The periodic prune/notify cycle                                   |
| **pruneExpired**                                | ❌ Missing | The pruning logic directly                                        |
| **Multi-peer token auth**                       | ❌ Missing | Two different peers with different tokens                         |

### 5.6 General Code Quality Notes

- `sendJson` is defined twice: once in `inbound.ts` (line 255) and once in `server-http.ts` (line 144). They differ slightly in content-type (`application/json` vs `application/json; charset=utf-8`). Minor nit.
- The `GATEWAY_SUBAGENT_SYMBOL` approach (line 56 of `inbound.ts`) is clever for avoiding circular dependencies but introduces a runtime dependency on correct initialization order. If `initXgw` is called before the gateway sets the symbol, all XGW requests fail with "internal error." There's no guard or warning for this during startup.

---

## 6. Remaining Issues, Bugs, and Improvements

### 🔴 Bug: `_sourceSessionKey` is Unused in `handleAsyncCallbackOutbound`

**Location:** `inbound.ts` line 446

```typescript
async function handleAsyncCallbackOutbound(
  runId: string,
  sessionKey: string,
  correlationId: string,
  timeoutMs: number,
  peer: string,
  _sourceSessionKey: string, // ← prefixed with _ = unused
): Promise<void> {
```

The parameter receives `sourceSessionKey || "unknown"` from line 380 but is never used inside the function. The callback payload does not include the source session key (it sends `correlationId`, `sessionKey`, `status`, `reply`/`error`). This value might be useful to include in the callback payload for the caller to correlate back, or the parameter should be removed.

### 🟡 Bug: `getExposure` uses seconds for expiry comparison, may be inconsistent

**Location:** `state.ts` lines 197–206

```typescript
export function getExposure(sessionKey: string): XgwExposureEntry | undefined {
  const entry = exposureTable.get(sessionKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt < Date.now() / 1000) {
    exposureTable.delete(key);
    return undefined;
  }
```

Wait — there's a **variable name bug** here! The function parameter is `sessionKey` but the delete call references `key` which is not defined in this scope. Actually, let me re-read:

```typescript
for (const [key, entry] of exposureTable.entries()) {
  if (entry.expiresAt < now) {
    exposureTable.delete(key);
  }
}
```

That's in `pruneExpired`. Let me re-check `getExposure`:

```typescript
if (entry.expiresAt < Date.now() / 1000) {
  exposureTable.delete(sessionKey);  // uses parameter, not key
```

Actually, that's correct — it uses the function parameter `sessionKey`. No bug here. My mistake in the initial read.

### 🟡 Issue: `dispatchDirect` uses `randomUUID()` for `idempotencyKey`

**Location:** `inbound.ts` line 231

```typescript
idempotencyKey: `xgw:${sessionKey}:${randomUUID()}`,
```

Every call to `dispatchDirect` generates a unique idempotencyKey, which means there's no deduplication for repeat requests to the same session. This may be intentional (each request is a new message) but is worth noting — if a peer sends the same message twice due to a network retry, two separate sub-agent runs will spawn.

### 🟡 Issue: `spawnWorker` also uses `randomUUID()` for `idempotencyKey`

**Location:** `inbound.ts` line 160

```typescript
idempotencyKey: `xgw:${correlationId}:${randomUUID()}`,
```

Same concern — the `correlationId` in the key prefix should be enough for deduplication, but appending `randomUUID()` makes it non-deduplicable. If the peer retries a dispatch with the same `correlationId`, a second worker session spawns.

### 🟡 Issue: `handleAsyncCallbackOutbound` fires and forgets with `.catch(() => {})`

**Location:** `inbound.ts` line 383

```typescript
void handleAsyncCallbackOutbound(...).catch(() => {
  // errors logged internally
});
```

This is correct for fire-and-forget, but the catch handler is a no-op. Errors inside `handleAsyncCallbackOutbound` (e.g., `subagent.run` failure, `postCallbackWithRetry` failure) are already handled internally and logged to stderr/console.error. The outer `.catch` is a safety net but provides no additional value. Consider removing it or adding a more informative log.

### 🟡 Improvement: `resolveEnvValue` should validate env var names

**Location:** `utils.ts`

```typescript
export function resolveEnvValue(val: string): string {
  if (val.startsWith("${") && val.endsWith("}")) {
    const envVar = val.slice(2, -1);
    const envVal = process.env[envVar];
    ...
  }
  return val;
}
```

No validation of the env var name. An input like `${../etc/passwd}` would try to access `process.env["../etc/passwd"]` which is harmless but confusing. A simple regex guard (`^[A-Za-z_][A-Za-z0-9_]+$`) would prevent accidental issues.

### 🟡 Improvement: `postCallbackWithRetry` generates a new nonce each time

**Location:** `outbound.ts` line 47

The callback payload is constructed once and passed to `postCallbackWithRetry` as a parameter. But looking at `inbound.ts` line 501:

```typescript
const callbackPayload: Record<string, unknown> = {
  correlationId,
  sessionKey,
  nonce: randomUUID(),
  timestamp: Math.floor(Date.now() / 1000),
};
```

The nonce is generated **before** calling `postCallbackWithRetry`, so all 3 retry attempts use the same nonce. After the first attempt (which may fail for network reasons, not auth), the peer records that nonce. If the retry succeeds, the peer will reject with 409 "duplicate nonce".

**This is a real bug.** Each retry should generate a fresh nonce, OR the callback endpoint should not reject nonces from the same peer with the same correlationId.

Wait — looking more carefully: `handleAsyncCallbackOutbound` builds the payload once with one nonce, then passes it to `postCallbackWithRetry`. The retry loop in `postCallbackWithRetry` re-sends the exact same body. So retries 2 and 3 send the same nonce that was already consumed by retry 1.

**Fix:** Move the nonce generation into the retry loop, or have `postCallbackWithRetry` refresh the nonce on each attempt.

### 🔴 Bug: `postCallbackWithRetry` nonce reuse on retries

This is the same issue as above, but confirming it's a real problem:

1. First POST sends nonce `N1`
2. Network error (not a 409 response) → retry after 5s
3. Second POST sends nonce `N1` again
4. Peer has already recorded `N1` from attempt 1 → **409 duplicate nonce**
5. Third retry also fails with 409

This means **any retry that doesn't fail immediately will consume its own nonce and block itself**. The retry mechanism is effectively dead for transient network failures.

**Recommended fix:** In `postCallbackWithRetry`, refresh both `nonce` and `timestamp` in the payload on each retry attempt:

```typescript
for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
  if (attempt > 0) {
    // Refresh nonce and timestamp for replay-protected endpoints
    if ("nonce" in payload) {
      payload.nonce = randomUUID();
    }
    if ("timestamp" in payload) {
      payload.timestamp = Math.floor(Date.now() / 1000);
    }
    await delay(RETRY_DELAYS_MS[attempt - 1] ?? 5_000);
  }
  // ... fetch ...
}
```

### 🟡 Improvement: `maxConcurrent` check counts all exposure entries, not just active sessions

**Location:** `inbound.ts` line 118

```typescript
if (getActiveSessionCount() >= maxConcurrent) {
  return { ok: false, status: "capacity_exceeded", error: "capacity exceeded" };
}
```

`getActiveSessionCount` counts all non-expired entries in the exposure table. This includes entries for sessions that were spawned but where the worker has already completed. The exposure table has a TTL (default 300s), so stale-but-unexpired entries block new sessions unnecessarily. Consider distinguishing between "active worker running" and "exposure granted".

### 🟡 Improvement: No rate limiting on XGW endpoints

The XGW endpoints (`/hooks/xgw`, `/hooks/xgw/callback`) are **not** passed through the hooks auth rate limiter that protects the standard hook endpoints. An attacker with a valid peer token can flood the XGW endpoints without rate limiting. Nonce tracking provides some protection (10,000 entries per peer), but this is not a rate limit — it's a replay prevention mechanism. A peer whose token is leaked could theoretically send 20,000 requests/sec (2 new nonces per request with different timestamps).

### 🟢 Good: Clean async callback ownership split

The design correctly separates caller and receiver responsibilities:

- Caller: owns pendingCallback state, creates it before dispatch, handles delivery into caller's session
- Receiver: stateless callback dispatcher, just runs worker and POSTs result

This is demonstrated in the tests and is a clean architectural decision.

---

## Summary

| Category            | Rating        | Key Findings                                                                                                                              |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Security            | 🟢 Good       | Token auth, nonce replay, peer scoping all solid. Inbound HTTPS warning exists but outbound HTTP is allowed.                              |
| Error Handling      | 🟢 Good       | Comprehensive coverage. Best-effort persistence is acceptable for this use case.                                                          |
| Async Callback Flow | 🟡 Needs Work | Caller-side ownership is correct. Retry/backoff is sound but **nonce reuse on retries is a real bug**.                                    |
| Outbound Dispatch   | 🟢 Good       | Caller identity propagation works. Response handling and timeout are reasonable.                                                          |
| Code Quality        | 🟡 Needs Work | Dead types, timestamp validation duplication, two config access patterns.                                                                 |
| Test Coverage       | 🟡 Needs Work | Good coverage of happy paths and auth rejection. Missing tests for subagent failure, notification cycle, multi-peer auth, and edge cases. |

### Must-Fix Before Merge

1. **🔴 Nonce reuse on callback retries** — `postCallbackWithRetry` re-sends the same nonce on each attempt, which will be rejected as a duplicate after the first attempt. Move nonce generation into the retry loop.

### Should-Fix (High Priority)

2. **🟡 Deduplicate timestamp validation** — Use `validateTimestamp()` for both main hook and callback paths.
3. **🟡 Unused `_sourceSessionKey` parameter** — Remove or use it in the callback payload.
4. **🟡 IdempotencyKey uses randomUUID** — Consider using a deterministic key based on correlationId to allow deduplication.

### Nice-to-Have (Lower Priority)

5. 🟢 Clean up dead types (`XgwInboundRequest`, `XgwCallbackRequest`). Could be kept as documentation but add `@deprecated` comments if not used.
6. 🟢 Add rate limiting to XGW endpoints.
7. 🟢 Atomic state persistence (write to temp file + rename).
8. 🟢 Add missing tests for subagent failure, callback notification cycle, multi-peer auth with different tokens.
9. 🟢 Validate env var names in `resolveEnvValue`.
10. 🟢 Add startup validation: warn if `getSubagent()` is null when `initXgw` runs.
