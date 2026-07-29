---
name: cross-gateway
description: >
  Use when the user asks about cross-gateway messaging, talking to agents on
  other gateways or instances, fleet communication, @gateway/ addressing,
  dispatching to remote peers, or receiving async results from a remote agent.
---

# Cross-Gateway Messaging (XGW)

## What It Is

`sessions_send` with a session key starting with `@` dispatches to a remote fleet peer
instead of a local session. The gateway handles wire transport and auth transparently
— the agent just calls `sessions_send` with an `@gateway/session-key`.

## Addressing

```
@<gatewayId>/<remoteSessionKey>
```

- `gatewayId` — the peer's short name as configured in `fleet.crossGateway.peers`
  (e.g. `ember`, `aster`, `forge`)
- `remoteSessionKey` — the session key on the remote gateway

**Dispatcher entry point** (new conversation):

```
@ember/receptionist
```

**Direct session** (follow-up to an existing worker):

```
@ember/receptionist:abc123
```

Use the dispatcher entry point to start a conversation. Use the direct session key
returned in the response to continue it.

## Peer Discovery

Available peers are configured in `fleet.crossGateway.peers`. Ask the operator which gateways are online if you don't have config access.
If the key is missing or `enabled` is false, cross-gateway messaging is disabled.

## Modes

### Sync (default)

Blocks until the remote agent replies. Returns the reply and a `sessionKey` you can use
for follow-up turns.

```json
{
  "sessionKey": "@ember/receptionist",
  "message": "What is the deploy status?"
}
```

No extra params needed. The gateway waits for the remote agent to reply (configurable via `timeoutMs`).

### Async

Fires and forgets. The remote agent works independently; the result is pushed back to
your session as a new message when it completes (your turn ends, resumes later).

```json
{
  "sessionKey": "@ember/receptionist",
  "message": "Analyze Q1 revenue data in detail",
  "async": true
}
```

Tool result acknowledges immediately:

```
Async request accepted by ember (correlation: xgw-abc123).
The remote agent is working. Your turn will resume when results arrive.
```

Your session is yielded. When the remote agent finishes, the gateway injects the result
as a new message to resume your turn.

**`async` and `multiTurn` are mutually exclusive** — passing both returns a 400 error.

### Multi-Turn (follow-up)

After a sync call returns, the response includes a remote `sessionKey`
(e.g. `receptionist:abc123`). Prefix it with `@gateway/` to send follow-up messages to the
same worker session:

```json
{
  "sessionKey": "@ember/receptionist:abc123",
  "message": "What about the previous release?"
}
```

The worker session is kept alive for a short TTL after each exchange.
If it has expired, send a new request to `@ember/receptionist` to start a fresh session.

## First Response

The sync response always includes a `sessionKey` for the spawned worker:

```json
{
  "ok": true,
  "sessionKey": "receptionist:abc123",
  "reply": "Deploy is at 80%, ETA 10 minutes."
}
```

Store `receptionist:abc123` and prefix it with `@ember/` for direct follow-up turns.

## Security

Each peer has a dedicated bearer token configured in `fleet.crossGateway.peers[name].token`.
The gateway injects the token automatically — the agent never sees or manages it.
Configure peers with HTTPS URLs for security.

## Example: Messaging Ember's Main Agent

```json
{
  "sessionKey": "@ember/receptionist",
  "message": "Summarize the latest build logs for the c2-warehouse project."
}
```

Response:

```json
{
  "sessionKey": "receptionist:f3a9c2",
  "reply": "The latest build completed at 14:32 UTC with 0 errors..."
}
```

Follow-up:

```json
{
  "sessionKey": "@ember/receptionist:f3a9c2",
  "message": "Which models took the longest?"
}
```

## Error Reference

| Status      | Meaning                                     |
| ----------- | ------------------------------------------- |
| `error`     | Gateway unreachable, unknown peer, no token |
| `forbidden` | Session not exposed or expired              |
| `timeout`   | Remote gateway did not reply in time        |

On `forbidden`, send a fresh request to `@gateway/receptionist` to start a new session.
