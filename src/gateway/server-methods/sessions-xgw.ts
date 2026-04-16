/**
 * Cross-gateway dispatch interception for sessions.send.
 *
 * When a session key starts with `@`, this handler routes the request
 * to the target gateway via XGW instead of local session dispatch.
 */

import type { GatewayRequestContext, RespondFn } from "./types.js";
import { errorShape } from "../protocol/index.js";
import { ErrorCodes } from "../protocol/index.js";
import { xgwOutboundDispatch, getXgwConfig } from "../xgw/outbound.js";
import { loadConfig } from "../../config/io.js";
import { resolveMainSessionKey } from "../../config/sessions.js";

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
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "message is required"),
    );
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

  const peers = xgwCfg.peers as
    | Record<string, { url?: string; token?: string }>
    | undefined;
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

  const mainSessionKey = resolveMainSessionKey(activeCfg);

  const result = await xgwOutboundDispatch(
    gwName,
    remoteKey,
    message.trim(),
    activeCfg,
    {
      timeoutSeconds: Math.floor(timeoutMs / 1000),
      agentSessionKey: mainSessionKey,
      agentChannel: "gateway_rpc",
    },
  );

  if (result.status === "error" || result.status === "forbidden") {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, result.error),
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

  const idempotencyKey = (p as { idempotencyKey?: unknown }).idempotencyKey;
  const runId = typeof idempotencyKey === "string" ? idempotencyKey : undefined;

  params.respond(
    true,
    {
      runId,
      messageSeq: 1,
      status: result.status || "ok",
      sessionKey: rawKey,
      remoteSessionKey: result.sessionKey,
      reply: result.reply,
    },
    undefined,
  );
}
