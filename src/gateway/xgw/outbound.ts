/**
 * XGW outbound dispatch helper.
 *
 * Called from the modified sessions.send flow when a sessionKey starts with `@`.
 * Posts an HTTP request to the target gateway's /xgateway endpoint.
 */

import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { XgwConfig, XgwOutboundResult } from "./types.js";
import { resolveEnvValue } from "./utils.js";

/** Delay helper. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface CallbackPostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * POST a callback result to the calling gateway at /xgateway/callback.
 * Retries up to 3 times with exponential backoff: 5s, 15s, 45s.
 *
 * @param peerUrl - Base URL of the calling gateway peer
 * @param outboundToken - Bearer token for the calling peer
 * @param payload - Callback body to POST
 * @returns ok: true on success, ok: false with error after all retries exhausted
 */
export async function postCallbackWithRetry(
  peerUrl: string,
  outboundToken: string,
  payload: Record<string, unknown>,
): Promise<CallbackPostResult> {
  const callbackUrl = `${peerUrl.replace(/\/+$/, "")}/xgateway/callback`;
  const MAX_ATTEMPTS = 3;
  // Delays: 5s, 15s, 45s (5 * 3^(n-1))
  const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? 5_000);
    }
    // Refresh nonce and timestamp on each attempt so the remote gateway
    // doesn't reject retries as duplicate-nonce (409).
    const effectivePayload = {
      ...payload,
      nonce: randomUUID(),
      timestamp: Math.floor(Date.now() / 1000),
    };
    try {
      const resp = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${outboundToken}`,
        },
        body: JSON.stringify(effectivePayload),
      });
      if (resp.ok) {
        return { ok: true, status: resp.status };
      }
      const bodyText = await resp.text().catch(() => "");
      lastError = `status=${resp.status} body=${bodyText.slice(0, 200)}`;
      process.stderr.write(
        `[xgw] callback POST attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${lastError}\n`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[xgw] callback POST attempt ${attempt + 1}/${MAX_ATTEMPTS} error: ${lastError}\n`,
      );
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Extract the XGW config section from the gateway config.
 */
export function getXgwConfig(cfg: OpenClawConfig): XgwConfig {
  return (cfg.fleet?.crossGateway ?? {}) as XgwConfig;
}

/**
 * Dispatch a cross-gateway message to a peer gateway.
 *
 * @param gwName - Peer gateway name (e.g. "ember")
 * @param remoteKey - Session key on the remote gateway
 * @param message - Message to send
 * @param params - Optional params (timeoutSeconds, etc.)
 * @param cfg - Gateway config
 * @param opts - Optional metadata (agentSessionKey, agentChannel)
 */
export async function xgwOutboundDispatch(
  gwName: string,
  remoteKey: string,
  message: string,
  cfg: OpenClawConfig,
  opts?: {
    timeoutSeconds?: number;
    agentSessionKey?: string;
    agentChannel?: string;
    async?: boolean;
    callbackTimeoutSeconds?: number;
    correlationId?: string;
  },
): Promise<XgwOutboundResult> {
  const xgwCfg = getXgwConfig(cfg);
  const peers = xgwCfg.peers ?? {};
  const peer = peers[gwName];

  if (!peer || !peer.url) {
    return {
      runId: randomUUID(),
      status: "error",
      error: `unknown gateway: ${gwName}`,
    };
  }

  const token = peer.token;
  if (!token) {
    return {
      runId: randomUUID(),
      status: "error",
      error: `no token configured for gateway: ${gwName}`,
    };
  }

  const baseUrl = peer.url.replace(/\/+$/, "");

  // Warn if the peer URL is not using HTTPS (but don't block the request).
  if (!peer.url.startsWith("https://")) {
    process.stderr.write(
      `[xgw] outbound request to peer ${gwName} uses insecure URL: ${peer.url}\n`,
    );
  }

  const targetKey = remoteKey;

  const corrId = opts?.correlationId ?? randomUUID();
  const nonce = randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  const timeoutSec =
    typeof opts?.timeoutSeconds === "number" && Number.isFinite(opts.timeoutSeconds)
      ? Math.min(120, Math.max(1, Math.floor(opts.timeoutSeconds)))
      : 30;

  const reqBody: Record<string, unknown> = {
    sessionKey: targetKey,
    message,
    sourceSessionKey: opts?.agentSessionKey ?? "",
    sourceChannel: opts?.agentChannel ?? "",
    correlationId: corrId,
    nonce,
    timestamp: ts,
    timeoutSeconds: timeoutSec,
  };

  if (opts?.async) {
    reqBody.async = true;
    if (typeof opts.callbackTimeoutSeconds === "number") {
      reqBody.callbackTimeoutSeconds = opts.callbackTimeoutSeconds;
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), Math.min(timeoutSec * 1000 + 5000, 125000));

    const res = await fetch(`${baseUrl}/xgateway`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolveEnvValue(token)}`,
        "Content-Type": "application/json",
        "X-XGW-Correlation-Id": corrId,
        "X-XGW-Source-Gateway": xgwCfg.gatewayName ?? "unknown",
      },
      body: JSON.stringify(reqBody),
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;

    if (!res.ok) {
      if (res.status === 401) {
        return { runId: corrId, status: "error", error: "cross-gateway unauthorized" };
      }
      if (res.status === 403) {
        return { runId: corrId, status: "forbidden", error: `session not exposed on ${gwName}` };
      }
      if (res.status === 504) {
        return { runId: corrId, status: "timeout", error: `gateway timeout: ${gwName}` };
      }
      return {
        runId: corrId,
        status: "error",
        error: `HTTP ${res.status}: ${
          typeof data?.error === "string" ? data.error : res.statusText
        }`,
      };
    }

    if (data?.ok === true) {
      const remoteRunId = typeof data.runId === "string" && data.runId ? data.runId : corrId;
      const remoteStatus = typeof data.status === "string" && data.status ? data.status : "ok";
      const remoteReply =
        typeof data.reply === "string" ? data.reply : data.reply === null ? null : null;
      const remoteSessionKey =
        typeof data.sessionKey === "string" && data.sessionKey ? data.sessionKey : targetKey;
      const remoteMessageSeq = typeof data.messageSeq === "number" ? data.messageSeq : undefined;
      const result: XgwOutboundResult = {
        runId: remoteRunId,
        status: remoteStatus,
        reply: remoteReply,
        sessionKey: remoteSessionKey,
        correlationId: corrId,
        ...(remoteMessageSeq !== undefined ? { messageSeq: remoteMessageSeq } : {}),
      };
      return result;
    }

    return {
      runId: corrId,
      status: "error",
      error: typeof data?.error === "string" ? data.error : "cross-gateway request failed",
    };
  } catch (err) {
    if (timer) {
      clearTimeout(timer);
    }
    const msg =
      (err as { name?: string } | null)?.name === "AbortError"
        ? `cross-gateway unreachable: ${gwName}`
        : `cross-gateway error (${gwName}): ${err instanceof Error ? err.message : String(err)}`;
    return { runId: corrId, status: "error", error: msg };
  }
}
