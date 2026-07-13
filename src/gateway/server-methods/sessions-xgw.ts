/**
 * Cross-gateway dispatch interception for sessions.send.
 *
 * When a session key starts with `@`, this handler routes the request
 * to the target gateway via XGW instead of local session dispatch.
 */

import { randomUUID } from "node:crypto";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";
import { runAgentStep } from "../../agents/tools/agent-step.js";
import {
  buildAgentToAgentReplyContext,
  isReplySkip,
  resolvePingPongTurns,
} from "../../agents/tools/sessions-send-helpers.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
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

  const gwName = rawKey.slice(1, slashIdx);
  const remoteKey = rawKey.slice(slashIdx + 1);

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

  const activeCfg = params.context.getRuntimeConfig();
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

  // Circular self-send detection: reject if target gateway is ourselves.
  const selfGwName = (activeCfg as { fleet?: { crossGateway?: { gatewayName?: string } } })?.fleet
    ?.crossGateway?.gatewayName;
  if (selfGwName && gwName === selfGwName) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "circular send: cannot send to self"),
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
  const isMultiTurn = (p as { multiTurn?: unknown }).multiTurn === true;

  // multiTurn and async are mutually exclusive
  if (isMultiTurn && isAsync) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "multiTurn and async are mutually exclusive"),
    );
    return;
  }

  const callbackTimeoutMs =
    typeof (p as { callbackTimeoutMs?: unknown }).callbackTimeoutMs === "number"
      ? (p as { callbackTimeoutMs: number }).callbackTimeoutMs
      : 600_000;
  const callbackTimeoutSeconds = Math.max(1, Math.floor(callbackTimeoutMs / 1000));

  let preCorrelationId: string | undefined;
  if (isAsync) {
    // Pre-generate a correlationId so we can create the pending record before dispatch.
    const xgwCfgForAsync = getXgwConfig(activeCfg);
    if (getActiveCallbackCount() >= (xgwCfgForAsync.maxPendingAsync ?? 20)) {
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

  // Multi-turn ping-pong: fire the loop and return the first reply immediately.
  if (isMultiTurn && result.status === "ok" && result.reply) {
    void runCrossGatewayMultiTurnLoop({
      gwName,
      remoteSessionKey: result.sessionKey ?? remoteKey,
      firstReply: result.reply,
      callerSessionKey,
      callerChannel,
      cfg: activeCfg,
      timeoutSeconds: Math.floor(timeoutMs / 1000),
    });
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

/**
 * Multi-turn cross-gateway ping-pong loop.
 *
 * After the initial XGW send returns the first remote reply, this loop:
 *   1. Feeds the remote reply into the local requester session (runAgentStep)
 *   2. If the local agent replies (non-empty, non-REPLY_SKIP), POSTs it back
 *      to the remote worker session via xgwOutboundDispatch.
 *   3. Repeats until REPLY_SKIP, empty reply, remote error, or turn cap.
 *
 * Runs fire-and-forget (same as local A2A's runSessionsSendA2AFlow).
 * No announce step — the remote agent's channel is not ours to post to.
 */
async function runCrossGatewayMultiTurnLoop(params: {
  gwName: string;
  remoteSessionKey: string;
  firstReply: string;
  callerSessionKey: string;
  callerChannel: string;
  cfg: OpenClawConfig;
  timeoutSeconds: number;
}): Promise<void> {
  const maxTurns = resolvePingPongTurns(params.cfg);
  if (maxTurns <= 0) {
    return;
  }

  let incomingReply = params.firstReply;

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Step 1: Feed remote reply into local requester session
    const replyContext = buildAgentToAgentReplyContext({
      requesterSessionKey: params.callerSessionKey,
      requesterChannel: params.callerChannel,
      targetSessionKey: `@${params.gwName}/${params.remoteSessionKey}`,
      currentRole: "requester",
      turn,
      maxTurns,
    });

    const localReply = await runAgentStep({
      sessionKey: params.callerSessionKey,
      message: incomingReply,
      extraSystemPrompt: replyContext,
      timeoutMs: params.timeoutSeconds * 1000,
      lane: AGENT_LANE_NESTED,
      sourceSessionKey: `@${params.gwName}/${params.remoteSessionKey}`,
      sourceChannel: "xgw",
      sourceTool: "sessions_send",
    });

    // Step 2: Check for REPLY_SKIP or empty from local agent
    if (!localReply || isReplySkip(localReply)) {
      break;
    }

    // Step 3: POST local reply back to remote worker session (direct dispatch)
    // Reuse the cfg snapshot captured at handler entry rather than re-reading
    // ambient config inside the multi-turn loop.
    const remoteResult = await xgwOutboundDispatch(
      params.gwName,
      params.remoteSessionKey,
      localReply,
      params.cfg,
      { timeoutSeconds: params.timeoutSeconds },
    );

    // Step 4: Check remote result
    if (remoteResult.status !== "ok" || !remoteResult.reply) {
      // Network failure, remote error, or empty reply — stop the loop
      break;
    }

    // Step 5: Check for REPLY_SKIP from remote agent
    if (isReplySkip(remoteResult.reply)) {
      break;
    }

    incomingReply = remoteResult.reply;
  }

  // No announce step for cross-gateway — the remote agent's channel is not ours to post to.
}
