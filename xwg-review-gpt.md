# XGW code review

Design reviewed: `/home/openclaw/.openclaw/workspace/projects/cross-gateway-xgw/DESIGN.md`
Code reviewed against `stable/v2026.4.14`.

## Executive summary

This implementation is **not yet faithful to the v5.1 design**. The inbound/outbound plumbing exists and the tests cover a few happy paths, but there are several material spec deviations and a few security/behavior bugs that should block rollout.

### Highest-risk findings

1. **Async callback ownership is reversed and locally persisted on the wrong gateway**. The receiver stores `pendingCallbacks` and later calls back to the original sender using that same local record, which is the opposite of the design. This breaks the intended authorization model and restart semantics. See `src/gateway/xgw/inbound.ts:417-461`, `src/gateway/xgw/inbound.ts:527-638`, versus design §4.4.1 / §4.4.3 / §12.
2. **Direct-session enumeration leaks exist**. Unexposed or expired sessions return `404 not_found` / `unknown session key` instead of the required indistinguishable `403 session not accessible`. See `src/gateway/xgw/inbound.ts:199-205`, `491-500`, tests in `src/gateway/xgw/inbound-http.test.ts:367-412`, design §5 and §10.4.
3. **Outbound dispatch always impersonates the main session, not the actual caller session**. Cross-gateway sends lose session identity and cannot support per-session async resume correctly. See `src/gateway/server-methods/sessions-xgw.ts:99-110`; design §4.2, §4.4.1, §7.2.
4. **Async retries are missing**. Design requires 3 callback POST retries with exponential backoff (5s, 15s, 45s). Current code tries once and leaves the callback pending. See `src/gateway/xgw/inbound.ts:602-631`; design §4.4.4.
5. **Several required validations/features are unimplemented**: `async && multiTurn` mutual exclusion, multi-turn cross-gateway loop, max pending async default (spec 20, code 100), max callback payload size 64KB, HTTPS enforcement, circular-send protection, dedicated `skynet` agent selection/defaulting. See details below.

## Spec compliance review

## 1. Dispatcher/session model

### What matches

- Addressing shape `@gateway/sessionKey` is implemented on outbound intercept. `src/gateway/server-methods/sessions.ts:453-462`, `src/gateway/server-methods/sessions-xgw.ts:23-50`
- Dispatcher entry key is effectively `skynet` for spawned workers. `src/gateway/xgw/inbound.ts:399-409`
- Spawned worker sessions are exposed with peer scoping and TTL. `src/gateway/xgw/inbound.ts:149-158`, `src/gateway/xgw/state.ts:186-195`

### Deviations

- **Worker session prefix is `xgw:` not `skynet:`**, contrary to design §3.1 and §5. `src/gateway/xgw/types.ts:122`, `src/gateway/xgw/inbound.ts:141`
- There is still a **receptionist fallback path** even though design v5.1 explicitly replaced the receptionist model with dispatcher-only routing. `src/gateway/xgw/types.ts:27-28`, `src/gateway/xgw/inbound.ts:108-110`, `504-516`, `src/gateway/xgw/outbound.ts:85-89`, config types in `src/config/types.gateway.ts:465-468, 483-485`
- The design says dispatcher-spawned sessions should use the dedicated `skynet` agent config (§6). I do not see `agentId` applied when spawning the worker. `subagent.run(...)` in `src/gateway/xgw/inbound.ts:168-178` does not pass an agent selection field. Unless the runtime infers this elsewhere, inbound work is not guaranteed to run under the `skynet` agent.

## 2. Wire protocol / endpoint naming

### Deviations

- Design specifies `/hooks/skynet` and `/hooks/skynet/callback`. Implementation uses `/hooks/xgw` and `/hooks/xgw/callback`. `src/gateway/xgw/types.ts:127-132`, `src/gateway/server-http.ts:234-236, 569-580`
- Header names differ from design examples (`X-Skynet-Correlation-Id` vs `X-XGW-Correlation-Id`). This is lower risk, but still a protocol drift. `src/gateway/xgw/outbound.ts:118-123`

If the design was intentionally renamed post-doc, update the design. Otherwise this is a compatibility break.

## 3. Auth, peer identity, replay protection

### What matches

- Bearer token auth is constant-time compared. `src/gateway/xgw/inbound.ts:114-123`
- Peer identity is derived from token, not from request body. `src/gateway/xgw/inbound.ts:348-350`, `657-659`
- Nonce replay protection exists and is scoped by authenticated peer. `src/gateway/xgw/state.ts:151-165`
- Timestamp validation exists with a 5-minute window. `src/gateway/xgw/state.ts:167-170`, `src/gateway/xgw/inbound.ts:389-396`, `692-704`
- Nonce FIFO cap is 10,000 per peer, matching design §10.2. `src/gateway/xgw/state.ts:13, 160-163`

### Problems

- **Nonce table has no timestamp/window eviction, only FIFO count eviction.** Design says nonces are tracked for the 5-minute window. Current implementation can reject a nonce reused hours later if volume is low enough that the nonce stays in the 10k FIFO. `src/gateway/xgw/state.ts:19-20`, `151-165`
- **Inbound request validation silently auto-fills missing `correlationId` and `nonce` instead of rejecting malformed requests.** Design marks both as required. `src/gateway/xgw/inbound.ts:376-377`
- **No HTTPS enforcement on outbound peer URLs**, despite design §10.1 saying all cross-gateway comms must use HTTPS. `src/gateway/xgw/outbound.ts:83, 116`; tests and types even use `http://` examples.
- The receiver trusts `sourceSessionKey` metadata, as the design allows, but because outbound always sends the main session key (see below), the resulting provenance is consistently wrong.

## 4. Session exposure and enumeration prevention

### What matches

- Exposures are peer-scoped. `src/gateway/xgw/inbound.ts:203-205`
- Exposure TTL refresh on direct activity exists. `src/gateway/xgw/inbound.ts:207-210`
- Exposure table is persisted and restored. `src/gateway/xgw/state.ts:120-126, 139-143`

### Problems

- **Enumeration prevention is violated.** Design requires both non-existent and unexposed sessions to return the same `403 session not accessible`. Current code returns:
  - `404 not_found / unknown session key` for absent or expired exposure entries. `src/gateway/xgw/inbound.ts:199-202, 495-497`
  - `403 forbidden / session not accessible` for wrong peer. `src/gateway/xgw/inbound.ts:203-205`
- Tests codify the wrong behavior by expecting `404` for nonexistent/expired sessions. `src/gateway/xgw/inbound-http.test.ts:367-412`, `583-634`

This is a direct security regression vs design §5 and §10.4.

## 5. Async flow, callback authorization, persistence

This is the biggest design mismatch.

### Design requirement

The **calling gateway** should create and persist `pendingCallbacks[correlationId]`, because that gateway is waiting for the remote result and must authorize the later callback. The **receiving gateway** should just run the worker and POST the result back. See design §4.4.1 steps 2 and 6, §4.4.3, §12.1.

### Actual implementation

When inbound `/hooks/xgw` receives `async=true`, the **receiving gateway**:

- spawns the worker,
- stores `pendingCallbacks` locally,
- waits for the worker locally,
- POSTs a callback back to the authenticated peer,
- marks its own local callback record delivered.

See `src/gateway/xgw/inbound.ts:417-461` and `527-638`.

### Why this is wrong

- It inverts callback ownership. The gateway waiting to resume the original caller session never creates the authoritative callback authorization record described in design §4.4.3.
- Restart semantics are wrong. Persisting `pendingCallbacks` on the worker-side gateway does not help the caller resume after a restart; the caller-side gateway is the one that needs the record. Current persistence tests only prove the worker-side sender can remember its own attempt history. `src/gateway/xgw/inbound-http.test.ts:415-579`
- The callback handler then tries to deliver to `pending.sourceSessionKey`, but since this record is stored on the worker-side gateway, that `sourceSessionKey` is for a session on the _other_ gateway. To work around that mismatch, the callback endpoint fabricates `xgw:${pending.sourceSessionKey}` if the session key does not already look like an xgw/hook key. `src/gateway/xgw/inbound.ts:754-758`
- That fabricated key is not part of the design and is very likely wrong for ordinary sessions. It attempts delivery into a synthetic local session key like `xgw:agent:main`, not the actual waiting source session described by the design.

### Additional async issues

- **No retry/backoff** for callback delivery. `src/gateway/xgw/inbound.ts:602-631`
- **Status handling bug:** timeout callbacks are built as `status: "error"` because the branch `if (resultStatus === "error" || resultError)` catches timeout cases first. `src/gateway/xgw/inbound.ts:583-589`
- **Callback endpoint returns 200 delivery_failed on local delivery errors**, explicitly to suppress peer retries. Design says retry should be safe/idempotent; this behavior makes transient local delivery failures non-recoverable. `src/gateway/xgw/inbound.ts:779-787`
- **No explicit timeout message is pushed by the caller-side gateway when callback timeout elapses**, because caller-side tracking is not implemented per design §4.4.4.
- **Default max pending async differs from spec.** Design says 20, code uses 100 in handler fallback. `src/gateway/xgw/inbound.ts:425`, design §12.
- **Payload size limit differs from spec.** Design says max callback payload 64KB. Both handlers accept 1MB. `src/gateway/xgw/inbound.ts:358, 665`

## 6. Outbound dispatch / `@gateway/` handling

### What matches

- `sessions.send` intercepts `@gateway/...` keys before local dispatch. `src/gateway/server-methods/sessions.ts:453-462`
- Peer config resolution and token lookup exist. `src/gateway/server-methods/sessions-xgw.ts:62-92`, `src/gateway/xgw/outbound.ts:62-81`
- Sync timeout is capped server-side to 120s. `src/gateway/xgw/outbound.ts:94-97`, `src/gateway/xgw/inbound.ts:379-382`

### Problems

- **Caller session identity is lost.** `handleCrossGatewayDispatch` always uses `resolveMainSessionKey(activeCfg)` instead of the actual session key supplied to `sessions.send`. `src/gateway/server-methods/sessions-xgw.ts:99-110`
  - This breaks provenance.
  - It breaks async callback resume, because the remote side never knows which local session actually initiated the request.
  - It means two different sessions on the same gateway appear identical remotely.
- **Returned `runId` is fake-ish.** The RPC response uses caller-provided `idempotencyKey` as `runId` if present, otherwise undefined, instead of the correlation/run identifiers returned by remote dispatch. `src/gateway/server-methods/sessions-xgw.ts:131-143`
- **`messageSeq: 1` is hard-coded** for all cross-gateway replies. `src/gateway/server-methods/sessions-xgw.ts:138`
- **Network abort maps to `cross-gateway unreachable` but status remains generic `error`**, while design distinguishes unreachable/timeout cases more explicitly. `src/gateway/xgw/outbound.ts:163-169`
- **replyBack field is sent but unused**. `src/gateway/xgw/outbound.ts:108`; no meaningful handling on inbound.

## 7. Multi-turn behavior

### Missing

Design §4.3 requires cross-gateway multi-turn using the existing ping-pong loop semantics, with turn caps and `REPLY_SKIP` termination.

Current state:

- Types mention `multiTurn`. `src/gateway/xgw/types.ts:50`
- Inbound/outbound do not implement it.
- There is no validation that `async=true` and `multiTurn=true` are mutually exclusive, despite design requiring a 400 validation error. `src/gateway/xgw/inbound.ts:383`, and no check after extraction.

This is a clear missing major feature.

## 8. Error handling / crash recovery

### Good

- State file corruption is tolerated by starting fresh. `src/gateway/xgw/state.ts:128-130`
- Exposure and pending callback state are saved on most mutations. `src/gateway/xgw/inbound.ts:158, 187, 210, 442, 600, 619, 629, 638, 722, 778`
- Startup init loads, prunes, and schedules periodic pruning. `src/gateway/xgw/inbound.ts:799-806`

### Problems

- **`initXgw()` is not wired from the reviewed files**. I only see route registration in `server-http.ts`; I do not see startup code calling `initXgw()` in the reviewed diff. If not called elsewhere, state persistence/pruning never initializes.
- **Spawn failure leaves a zero-TTL exposure entry behind** rather than removing it. `src/gateway/xgw/inbound.ts:180-187`
- **Timeout/error paths do not clean up or terminate worker sessions**. That may be acceptable if TTL handles exposure cleanup, but the design implies expired sessions should not remain addressable and stale sessions should not accumulate.
- **Synchronous dispatcher timeout returns 504 but leaves exposure alive**, allowing follow-up to a worker whose original run may still be active. `src/gateway/xgw/inbound.ts:464-477`
- **`loadState()` clears exposure and pending maps but not the nonce table**, so test/runtime reload behavior for nonces is inconsistent. `src/gateway/xgw/state.ts:99-100`.

## 9. Code quality / type safety

### Issues

- `src/gateway/xgw/types.ts` says it “implements the design” but still bakes in receptionist config and `xgw:` naming, both of which conflict with the design. `src/gateway/xgw/types.ts:1-5, 27-28, 122`
- `XgwConfig` in `src/gateway/xgw/types.ts` omits `exposureTtlSeconds`, but `inbound.ts` reads it repeatedly. This works only because the interface extends the gateway config type indirectly, but it is confusing and easy to break. `src/gateway/xgw/types.ts:13`, use sites `src/gateway/xgw/inbound.ts:151, 208, 774, 776`
- `dispatchDirect` uses `getSessionMessages({ limit: 1 })` and assumes the newest returned message is the assistant reply. Depending on ordering semantics, this may pick the wrong message. `src/gateway/xgw/inbound.ts:229-243`
- There are several `as unknown as Record<string, unknown>` casts in HTTP responses that hide mismatches instead of expressing a concrete response type. `src/gateway/xgw/inbound.ts:413, 497, 499, 511, 513`
- `replyBack` and receptionist aliasing look like leftover migration code and should be removed if v5.1 is the target.

## 10. Test coverage gaps

The current tests are good smoke tests for route plumbing, but they also lock in some incorrect behavior.

### Existing tests that encode spec drift

- Expect `404` for missing/expired direct sessions, contrary to anti-enumeration requirement. `src/gateway/xgw/inbound-http.test.ts:367-412`, `583-634`
- Async persistence tests validate the wrong ownership model by asserting the receiver-side pending record is created and marked delivered. `src/gateway/xgw/inbound-http.test.ts:415-579`

### Missing tests

1. Reject `async=true` with `multiTurn=true` as `400`.
2. Multi-turn happy path and turn-cap behavior.
3. Callback wrong-peer rejection with an existing correlation record.
4. Callback idempotency after successful delivery (`already_delivered`).
5. Callback timeout status preserved as `timeout` instead of being collapsed to `error`.
6. Retry/backoff behavior for transient callback POST failures.
7. Enforcement of `maxPendingAsync` default and 64KB callback payload limit.
8. Actual caller session key propagation on outbound dispatch.
9. HTTPS-only peer URL enforcement, if that remains a spec requirement.
10. Dedicated `skynet` agent selection on spawned worker runs.
11. Circular-send rejection for synchronous ping-pong loops.
12. Restart recovery on the **caller side** for async pending callbacks.

## Missing items from spec

These appear unimplemented or only partially implemented:

- Multi-turn cross-gateway loop (§4.3)
- `async`/`multiTurn` mutual exclusion validation (§4.4)
- Caller-side `pendingCallbacks` ownership and persistence (§4.4.1, §4.4.3, §12.1)
- Callback retry with exponential backoff 5s/15s/45s (§4.4.4)
- Caller-side timeout wake-up message on callback expiry (§4.4.4)
- Canonical `skynet:` worker session naming (§3.1, §5)
- Dedicated `skynet` agent config/default prompt enforcement (§6)
- HTTPS requirement enforcement (§10.1)
- Enumeration-safe 403 behavior for both unexposed and nonexistent sessions (§5, §10.4)
- Circular-send protection for synchronous looped reply-backs (§11)
- Max pending async default = 20 and callback payload cap = 64KB (§12)

## Recommendations

### Blockers before rollout

1. **Rework async ownership to match the design.**
   - Outbound `sessions.send(@gateway/...)` on the calling gateway must create the pending callback record locally before POSTing.
   - The receiving gateway should not create local pending callback records for inbound async requests.
   - The callback endpoint should resume the actual waiting local session key, not synthesize `xgw:${sourceSessionKey}`.
2. **Fix direct-session enumeration.** Return `403 session not accessible` for both unknown and unauthorized direct session access.
3. **Pass the actual calling session key/channel through outbound dispatch.** Do not always use `resolveMainSessionKey()`.
4. **Remove or justify receptionist fallback and `xgw:` naming.** If v5.1 is authoritative, switch to `skynet:` and dispatcher-only.
5. **Implement retry/backoff and correct timeout status handling** for callback delivery.

### Important follow-ups

6. Add validation for `async && multiTurn` and either implement multi-turn or explicitly defer it in the design and code.
7. Enforce or clearly document the HTTPS requirement.
8. Add tests around wrong-peer callbacks, idempotency, caller-side persistence, and dedicated agent selection.

## Bottom line

This is a solid start for route interception and basic worker dispatch, but it is **not yet spec-complete and not yet safe enough** for the design as written. The async architecture and enumeration behavior are the two biggest correctness/security gaps.
