/**
 * Cross-gateway dispatch interception for sessions.send.
 *
 * When a session key starts with `@`, this handler routes the request
 * to the target gateway via XGW instead of local session dispatch.
 */

import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config/io.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { errorShape } from "../protocol/index.js";
import { ErrorCodes } from "../protocol/index.js";
import { xgwOutboundDispatch, getXgwConfig } from "../xgw/outbound.js";
import { getActiveCallbackCount, setPendingCallback, saveState } from "../xgw/state.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export async function handleCrossGatewayDispatch(params: {
  params: Record<string, unknown>;
  respond: RespondFn;
  context: GatewayRequestContext;
}): Promise<void> {
  const p = params.params;
  const rawKey = (p as { key?: unknown })?.key as string;

  // Parse @gateway/sessionKey format
  const slashIdx = rawKey.indexOf("/");
  if (slashIdx < 2) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Invalid cross-gateway key. Use @gateway-name/session-key",
      ),
    );
    return;
  }

  const gwName = rawKey.substring(1, slashIdx);
  const remoteKey = rawKey.substring(slashIdx + 1);

  if (!gwName || !remoteKey) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Cross-gateway key requires both gateway name and session key",
      ),
    );
    return;
  }

  const message = (p as { message?: unknown }).message;
  if (typeof message !== "string" || !message.trim()) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "message is required"));
    return;
  }

  const activeCfg = loadConfig();
  const xgwCfg = getXgwConfig(activeCfg);
  if (!xgwCfg.enabled) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "Cross-gateway messaging is not enabled"),
    );
    return;
  }

  const peers = xgwCfg.peers as Record<string, { url?: string; token?: string }> | undefined;
  const peer = peers?.[gwName];
  if (!peer || !peer.url) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Unknown gateway: ${gwName}`),
    );
    return;
  }
  if (!peer.token) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `No token configured for gateway: ${gwName}`),
    );
    return;
  }

  const timeoutMs =
    typeof (p as { timeoutMs?: unknown }).timeoutMs === "number"
      ? (p as { timeoutMs: number }).timeoutMs
      : 30_000;

  // Use the actual caller's session key if provided; fall back to the main session.
  // Callers can pass callerSessionKey (and optionally callerChannel) as extra params
  // alongside the standard sessions.send fields for cross-gateway requests.
  const callerSessionKey =
    normalizeOptionalString((p as { callerSessionKey?: unknown }).callerSessionKey) ??
    resolveMainSessionKey(activeCfg);
  const callerChannel =
    normalizeOptionalString((p as { callerChannel?: unknown }).callerChannel) ?? "gateway_rpc";

  // Async mode: caller-side creates the pendingCallback record before dispatching.
  const isAsync = (p as { async?: unknown }).async === true;
  const callbackTimeoutMs =
    typeof (p as { callbackTimeoutMs?: unknown }).callbackTimeoutMs === "number"
      ? (p as { callbackTimeoutMs: number }).callbackTimeoutMs
      : 600_000;
  const callbackTimeoutSeconds = Math.max(1, Math.floor(callbackTimeoutMs / 1000));

  let preCorrelationId: string | undefined;
  if (isAsync) {
    // Pre-generate a correlationId so we can create the pending record before dispatch.
    const xgwCfgForAsync = getXgwConfig(activeCfg);
    if (getActiveCallbackCount() >= (xgwCfgForAsync.maxPendingAsync ?? 100)) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Too many pending async callbacks"),
      );
      return;
    }

    preCorrelationId = randomUUID();
    const now = Date.now() / 1000;
    setPendingCallback(preCorrelationId, {
      sourceSessionKey: callerSessionKey,
      allowedPeer: gwName,
      createdAt: now,
      expiresAt: now + callbackTimeoutSeconds,
      status: "pending",
    });
    saveState();
  }

  const result = await xgwOutboundDispatch(gwName, remoteKey, message.trim(), activeCfg, {
    timeoutSeconds: Math.floor(timeoutMs / 1000),
    agentSessionKey: callerSessionKey,
    agentChannel: callerChannel,
    ...(isAsync && preCorrelationId
      ? {
          async: true as const,
          callbackTimeoutSeconds,
          correlationId: preCorrelationId,
        }
      : {}),
  });

  if (result.status === "error" || result.status === "forbidden") {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "Cross-gateway request failed"),
    );
    return;
  }

  if (result.status === "timeout") {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.AGENT_TIMEOUT, result.error || "Gateway timeout"),
    );
    return;
  }

  // For async dispatches, return the accepted status immediately.
  if (isAsync || result.status === "accepted") {
    const correlationId = result.correlationId ?? preCorrelationId;
    params.respond(
      true,
      {
        status: "accepted",
        correlationId,
        sessionKey: rawKey,
        remoteSessionKey: result.sessionKey,
        reply: null,
      },
      undefined,
    );
    return;
  }

  // Use the actual runId returned by the remote dispatch rather than fabricating
  // one from the idempotency key. Fall back to the idempotency key only if the
  // remote did not return a runId.
  const idempotencyKey = normalizeOptionalString(
    (p as { idempotencyKey?: unknown }).idempotencyKey,
  );
  const runId = result.runId ?? idempotencyKey;

  // Use the message sequence from the remote reply if available; do not hardcode 1.
  const remoteMessageSeq = typeof result.messageSeq === "number" ? result.messageSeq : undefined;

  params.respond(
    true,
    {
      ...(runId !== undefined ? { runId } : {}),
      ...(remoteMessageSeq !== undefined ? { messageSeq: remoteMessageSeq } : {}),
      status: result.status ?? "ok",
      sessionKey: rawKey,
      remoteSessionKey: result.sessionKey,
      reply: result.reply,
    },
    undefined,
  );
}
