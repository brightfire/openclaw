/**
 * XGW outbound dispatch helper.
 *
 * Called from the modified sessions.send flow when a sessionKey starts with `@`.
 * Posts an HTTP request to the target gateway's /hooks/xgw endpoint.
 */

import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { XgwConfig, XgwOutboundResult } from "./types.js";

/**
 * Resolve ${ENV_VAR} syntax to the actual environment variable value.
 */
function resolveEnvValue(val: string): string {
  if (val.startsWith("${") && val.endsWith("}")) {
    const envVar = val.slice(2, -1);
    const envVal = process.env[envVar];
    if (envVal !== undefined && envVal !== "") {
      return envVal;
    }
    // Log warning if available; otherwise silent fallback
    if (typeof process !== "undefined" && typeof process.stderr !== "undefined") {
      try {
        process.stderr.write(`[xgw] unresolved env var \${${envVar}}, using literal\n`);
      } catch {
        // swallow
      }
    }
  }
  return val;
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

  // Resolve special session key aliases
  let targetKey = remoteKey;
  if (remoteKey === "receptionist") {
    targetKey = xgwCfg.receptionist?.sessionKey ?? "agent:receptionist:main";
  }

  const corrId = randomUUID();
  const nonce = randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  const timeoutSec =
    typeof opts?.timeoutSeconds === "number" && Number.isFinite(opts.timeoutSeconds)
      ? Math.min(120, Math.max(1, Math.floor(opts.timeoutSeconds)))
      : 30;

  const reqBody = {
    sessionKey: targetKey,
    message,
    sourceSessionKey: opts?.agentSessionKey ?? "",
    sourceChannel: opts?.agentChannel ?? "",
    correlationId: corrId,
    nonce,
    timestamp: ts,
    timeoutSeconds: timeoutSec,
    replyBack: true,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), Math.min(timeoutSec * 1000 + 5000, 125000));

    const res = await fetch(`${baseUrl}/hooks/xgw`, {
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
        error: `HTTP ${res.status}: ${(data as { error?: string } | null)?.error ?? res.statusText}`,
      };
    }

    if ((data as { ok?: boolean } | null)?.ok) {
      return {
        runId: (data as { runId?: string } | null)?.runId ?? corrId,
        status: (data as { status?: string } | null)?.status ?? "ok",
        reply: (data as { reply?: string | null } | null)?.reply ?? null,
        sessionKey: (data as { sessionKey?: string } | null)?.sessionKey ?? targetKey,
      };
    }

    return {
      runId: corrId,
      status: "error",
      error: (data as { error?: string } | null)?.error ?? "cross-gateway request failed",
    };
  } catch (err) {
    if (timer) {clearTimeout(timer);}
    const msg =
      (err as { name?: string } | null)?.name === "AbortError"
        ? `cross-gateway unreachable: ${gwName}`
        : `cross-gateway error (${gwName}): ${err instanceof Error ? err.message : String(err)}`;
    return { runId: corrId, status: "error", error: msg };
  }
}
