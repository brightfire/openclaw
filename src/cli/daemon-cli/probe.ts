import type { OpenClawConfig } from "../../config/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { withProgress } from "../progress.js";

type GatewayStatusProbeKind = "connect" | "read";

const probeGatewayModuleLoader = createLazyImportLoader(() => import("../../gateway/probe.js"));

async function loadProbeGatewayModule(): Promise<typeof import("../../gateway/probe.js")> {
  return await probeGatewayModuleLoader.load();
}

function resolveProbeFailureMessage(result: {
  error?: string | null;
  close?: { code: number; reason: string } | null;
}): string {
  const closeHint = result.close
    ? `gateway closed (${result.close.code}): ${result.close.reason}`
    : null;
  if (closeHint && (!result.error || result.error === "timeout")) {
    return closeHint;
  }
  return result.error ?? closeHint ?? "gateway probe failed";
}

function isAuthFailure(result: {
  error?: string | null;
  close?: { code: number; reason: string } | null;
}): boolean {
  if (result.close?.code === 1008) {
    return true;
  }
  const msg = (result.error ?? result.close?.reason ?? "").toLowerCase();
  return msg.includes("unauthorized") || msg.includes("401");
}

function isLoopbackUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

/**
 * HTTP health-check fallback for loopback trusted-proxy deployments where
 * the WS probe is rejected (no token auth configured alongside trusted-proxy).
 * Uses the unauthenticated /ready endpoint to confirm the gateway is alive.
 */
async function httpHealthFallback(
  wsUrl: string,
  timeoutMs: number,
): Promise<{ ok: boolean; ready?: boolean }> {
  try {
    const parsed = new URL(wsUrl);
    const httpScheme = parsed.protocol === "wss:" ? "https:" : "http:";
    const httpUrl = `${httpScheme}//${parsed.host}/ready`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 2000));
    try {
      const resp = await fetch(httpUrl, { signal: controller.signal });
      if (resp.ok || resp.status === 503) {
        // 200 = ready, 503 = alive but not ready yet — either way, gateway is reachable
        const body = await resp.json().catch(() => null);
        return { ok: true, ready: body?.ready === true };
      }
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false };
  }
}

export async function probeGatewayStatus(opts: {
  url: string;
  token?: string;
  password?: string;
  config?: OpenClawConfig;
  tlsFingerprint?: string;
  timeoutMs: number;
  preauthHandshakeTimeoutMs?: number;
  json?: boolean;
  requireRpc?: boolean;
  configPath?: string;
}) {
  const kind = (opts.requireRpc ? "read" : "connect") satisfies GatewayStatusProbeKind;
  try {
    const result = await withProgress(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () => {
        const { probeGateway } = await loadProbeGatewayModule();
        const probeOpts = {
          url: opts.url,
          auth: {
            token: opts.token,
            password: opts.password,
          },
          tlsFingerprint: opts.tlsFingerprint,
          ...(opts.preauthHandshakeTimeoutMs !== undefined
            ? { preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs }
            : {}),
          timeoutMs: opts.timeoutMs,
          includeDetails: false,
        };
        if (opts.requireRpc) {
          const { callGateway } = await import("../../gateway/call.js");
          await callGateway({
            url: opts.url,
            token: opts.token,
            password: opts.password,
            tlsFingerprint: opts.tlsFingerprint,
            ...(opts.config ? { config: opts.config } : {}),
            method: "status",
            timeoutMs: opts.timeoutMs,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
          });
          const authProbe = await probeGateway(probeOpts).catch(() => null);
          return { ok: true as const, authProbe };
        }
        return await probeGateway(probeOpts);
      },
    );
    const auth = "auth" in result ? result.auth : result.authProbe?.auth;
    if (result.ok) {
      return {
        ok: true,
        kind,
        capability:
          kind === "read"
            ? auth?.capability && auth.capability !== "unknown"
              ? auth.capability
              : "read_only"
            : auth?.capability,
        auth,
      } as const;
    }

    // When the WS probe fails with an auth error on a loopback URL, fall back
    // to an HTTP /ready check.  This handles trusted-proxy deployments where
    // loopback WS connections are rejected because no token auth is configured
    // alongside the proxy.  The HTTP health endpoints are unauthenticated.
    if (isAuthFailure(result) && isLoopbackUrl(opts.url)) {
      const health = await httpHealthFallback(opts.url, opts.timeoutMs);
      if (health.ok) {
        return { ok: true, kind, httpFallback: true, ready: health.ready } as const;
      }
    }

    return {
      ok: false,
      kind,
      capability: auth?.capability,
      auth,
      error: resolveProbeFailureMessage(result),
    } as const;
  } catch (err) {
    return {
      ok: false,
      kind,
      error: formatErrorMessage(err),
    } as const;
  }
}
