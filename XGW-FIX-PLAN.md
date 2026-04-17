# XGW Fix Plan

> Based on combined Opus + GPT 5.4 code reviews of `feature/xgw-cross-gateway-full` vs `DESIGN.md`

---

## Chunk 1 — Security Fixes (Blockers)

**Priority: Critical. These must land before any production rollout.**

### 1.1 Session enumeration — both nonexistent and wrong-peer return 403

**Files:** `src/gateway/xgw/inbound.ts` (dispatchDirect, receptionist path), `src/gateway/xgw/inbound-http.test.ts`

- `dispatchDirect` should return the same response (`403`, `status: "forbidden"`, `error: "session not accessible"`) for both missing exposure and wrong-peer
- Fix tests that currently assert `404` — rewrite to assert `403` for nonexistent/expired sessions
- Apply same fix in the receptionist routing path if kept

### 1.2 Missing `enabled` check on inbound handlers

**Files:** `src/gateway/xgw/inbound.ts` (`handleXgwHook`, `handleXgwCallback`)

- Reject with `503`/`XGW_DISABLED` if `xgwCfg.enabled !== true` at the top of both handlers
- Add tests for the disabled path

---

## Chunk 2 — Async Callback Architecture Redesign

**Priority: Critical. The largest gap vs the design. Requires the most refactoring.**

### 2.1 Invert async ownership model

**Files:** `src/gateway/xgw/inbound.ts`, `src/gateway/server-methods/sessions-xgw.ts`, `src/gateway/xgw/outbound.ts`, `src/gateway/xgw/state.ts`

Per design, the flow should be:

| Step | Who                         | What                                                                                          |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | Caller session on Gateway A | Sends `@gatewayB/skynet` via local `sessions_send`                                            |
| 2    | Gateway A outbound          | Creates `pendingCallbacks[correlationId]` locally with `sourceSessionKey` of the caller       |
| 3    | Gateway A outbound          | POSTs to Gateway B `/hooks/xgw` with async=true                                               |
| 4    | Gateway B inbound           | Spawns worker, does **not** create pending record                                             |
| 5    | Gateway B inbound           | Waits for worker, POSTs callback to Gateway A `/hooks/xgw/callback`                           |
| 6    | Gateway A callback handler  | Finds local `pendingCallbacks[corrId]`, delivers reply to `sourceSessionKey`, marks delivered |

Changes needed:

- **outbound.ts / sessions-xgw.ts:** Create `pendingCallbacks` entry locally before dispatching async requests
- **inbound.ts (`handleXgwHook`):** Remove `setPendingCallback` for inbound async requests — the caller owns the pending record, not the receiver
- **inbound.ts (`handleAsyncCallback`):** Simplify — just wait for worker and POST callback back (no local pending state)
- **inbound.ts (`handleXgwCallback`):** Remove the `xgw:` prefix fabrication — use `pending.sourceSessionKey` directly as-is. The source session is a real local session (the one that initiated the cross-gateway send).
- **outbound.ts:** Implement callback retry with exponential backoff (3 attempts: 5s, 15s, 45s)
- **state.ts:** `pendingCallbacks` lifecycle changes — records are now on caller-side, not receiver-side

### 2.2 Callback retry with backoff

**Files:** `src/gateway/xgw/inbound.ts` (handleAsyncCallback)

- Retry POST up to 3 times on failure: delays 5s, 15s, 45s
- On final failure: log error, expire the callback, mark as failed in state

### 2.3 Timeout push to waiting session

**Files:** `src/gateway/xgw/state.ts` (pruneExpired), `src/gateway/xgw/inbound.ts`

- When `pruneExpired` transitions a pending callback to `expired`, push a timeout message into the `sourceSessionKey` session so the waiting agent isn't stuck
- Use `getSubagent().run({ sessionKey: sourceSessionKey, deliver: true, message: "Cross-gateway callback timed out" })`

---

## Chunk 3 — Outbound Dispatch Fixes

**Priority: Critical. Broken provenance breaks async resume and multi-turn.**

### 3.1 Pass actual caller session identity

**Files:** `src/gateway/server-methods/sessions-xgw.ts`

- Replace `resolveMainSessionKey(activeCfg)` in `sourceSessionKey` and `sourceChannel` fields with the actual session key that called `sessions_send`
- Extract session key from the gateway request context for the `sessions.send` tool call
- This requires threading the real session key through `handleCrossGatewayDispatch`

### 3.2 Clean up response extraction

**Files:** `src/gateway/server-methods/sessions-xgw.ts`, `src/gateway/xgw/outbound.ts`

- Replace `as unknown as Record<string, unknown>` casts with proper type guards
- Use the actual `runId` from remote response instead of fabricating from `idempotencyKey`
- Don't hardcode `messageSeq: 1` — use the actual message sequence from the remote reply

### 3.3 HTTPS enforcement

**Files:** `src/gateway/xgw/outbound.ts`

- Reject peer URLs that don't start with `https://` (or at minimum log a strong warning)
- Document this requirement in DESIGN.md if we choose to defer

---

## Chunk 4 — Spec-Compliant Naming & Cleanup

**Priority: Important. Protocol drift makes docs/code confusing.**

### 4.1 Consistent naming

**Files:** All XGW files

Decide: stick with `xgw/*` or rename to `skynet/*` per design spec. If we rename:

- Endpoint paths: `/hooks/xgw` → `/hooks/skynet`
- Session prefix: `xgw:` → `skynet:`
- Header names: `X-XGW-*` → `X-Skynet-*`
- State file: `xgw-async.json` → `skynet-async.json`
- Constant: `XGW_SESSION_PREFIX` → `SKYNET_SESSION_PREFIX`
- Type names: `XgwInboundRequest` → `SkynetInboundRequest` (or keep `Xgw*` if `xgw` is the new convention)

If we keep `xgw` as the internal name, update DESIGN.md to match and document the mapping.

### 4.2 Remove dead code

**Files:** `src/gateway/xgw/inbound.ts`, `src/gateway/xgw/types.ts`

- Remove receptionist routing path from inbound handler (not in v5.1 spec, and never works — exposure table has no receptionist entries)
- Remove `XgwReceptionistConfig` from config types
- Remove `replyBack` field from `XgwInboundRequest` (sent but never read)
- Remove dead `XGW-Correlation-Id` header outbound field if not used for anything

### 4.3 Dedicated skynet agent enforcement

**Files:** `src/gateway/xgw/inbound.ts` (`spawnWorker`)

- Pass `agentId: cfg.agentId ?? "skynet"` to `subagent.run()` so worker sessions use the correct agent config
- Add a default `skynet` agent system prompt in code if no explicit agent config exists (see DESIGN.md §6)

---

## Chunk 5 — Missing Feature: Multi-Turn

**Priority: Important but can be deferred. Depends on async ownership (Chunk 2).**

### 5.1 Async/multiTurn mutual exclusion

**Files:** `src/gateway/xgw/inbound.ts`

- Validate: if `async && multiTurn`, return 400

### 5.2 Multi-turn loop implementation

**Files:** `src/gateway/xgw/inbound.ts`, `src/gateway/xgw/outbound.ts`

This is significant new work. Requires:

- Keeping the cross-gateway session open for multiple ping-pong turns
- Turn cap enforcement
- `REPLY_SKIP` termination protocol
- Circular send detection (reject looped replies in sync mode)

Recommend deferring MVP — mark as TODO with the validation in place.

---

## Chunk 6 — Test Suite Expansion

**Priority: Important. Current tests encode wrong behavior and miss critical paths.**

**Files:** `src/gateway/xgw/inbound-http.test.ts`, `src/gateway/server-methods/sessions-xgw.test.ts`

New tests needed:

| Test                                                      | Depends on Chunk |
| --------------------------------------------------------- | ---------------- |
| Auth rejection (invalid/missing token → 401)              | 1                |
| Nonce replay rejection                                    | 1                |
| Timestamp expiry (>5 min)                                 | 1                |
| XGW disabled → 503                                        | 1                |
| 403 for both nonexistent andwrong-peer sessions (not 404) | 1                |
| maxConcurrent enforcement (503)                           | —                |
| Payload too large → 413                                   | —                |
| Invalid JSON body → 400                                   | —                |
| Missing required fields → 400                             | —                |
| Callback expiry → 410                                     | 2                |
| Callback wrong peer → 403                                 | 2                |
| Callback idempotency (already delivered → 200)            | 2                |
| Callback retry on transient failure                       | 2                |
| Timeout push to waiting session                           | 2                |
| Outbound dispatch unit test (real caller key)             | 3                |
| HTTPS URL rejection                                       | 3                |
| async && multiTurn → 400                                  | 5                |
| Corrupt state file recovery                               | —                |
| `resolveEnvValue` edge cases                              | —                |

---

## Execution Plan

| Chunk                     | Scope                                    | Parallelizable with                           | Estimated effort |
| ------------------------- | ---------------------------------------- | --------------------------------------------- | ---------------- |
| **1 — Security**          | Small, focused, no architectural changes | 2, 3                                          | 1 agent, ~15 min |
| **2 — Async redesign**    | Large, architectural, touches 4 files    | — (must finish before 5, 6)                   | 1 agent, ~30 min |
| **3 — Outbound dispatch** | Medium, touches 3 files                  | 1 (but not 2, since 2 changes outbound too)   | 1 agent, ~15 min |
| **4 — Naming & cleanup**  | Medium, mostly refactoring               | 1, but should wait for 2 (naming conventions) | 1 agent, ~15 min |
| **5 — Multi-turn**        | Deferred (validation only for now)       | —                                             | TBD              |
| **6 — Tests**             | Depends on all above                     | — (runs after chunks land)                    | 1 agent, ~20 min |

**Recommended order:**

1. Chunks 1 and 3 in parallel (no overlap, both are focused fixes)
2. Chunk 2 (async redesign — largest and most interdependent)
3. Chunk 4 (naming & cleanup — easier after architectural changes are stable)
4. Chunk 6 (tests — after everything else is fixed so tests encode correct behavior)
5. Chunk 5 (multi-turn — deferred MVP)

---

## DESIGN.md updates needed (after all chunks)

- Update to match actual implementation (or vice versa)
- Document any intentional deviations from the original v5.1 spec
- Clarify endpoint naming convention (`xgw` vs `skynet`)
