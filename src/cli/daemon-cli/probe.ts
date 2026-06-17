// Gateway status probe helper used by `gateway status` service diagnostics.
import type { OpenClawConfig } from "../../config/types.js";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { withProgress } from "../progress.js";

type GatewayStatusProbeKind = "connect" | "read";
type GatewayStatusRequireRpcProbeResult = {
  ok: true;
  authProbe: GatewayProbeResult | null;
};
type GatewayStatusProbeResult = GatewayProbeResult | GatewayStatusRequireRpcProbeResult;

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

function resolveGatewayStatusProbeDetails(result: GatewayStatusProbeResult) {
  return "authProbe" in result ? result.authProbe : result;
}

function readRuntimeVersionFromStatusPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const runtimeVersion = (payload as { runtimeVersion?: unknown }).runtimeVersion;
  return typeof runtimeVersion === "string" && runtimeVersion.trim().length > 0
    ? runtimeVersion.trim()
    : null;
}

/** Probe Gateway connectivity or read-capability status with optional RPC verification. */
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
  allowRpcConfigCredentials?: boolean;
  configPath?: string;
}) {
  const kind = (opts.requireRpc ? "read" : "connect") satisfies GatewayStatusProbeKind;
  try {
    let statusRuntimeVersion: string | null = null;
    const result = await withProgress<GatewayStatusProbeResult>(
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
          const allowRpcConfigCredentials = opts.allowRpcConfigCredentials !== false;
          if (!allowRpcConfigCredentials && !opts.token && !opts.password) {
            throw new Error(
              "gateway status RPC skipped because configured gateway credentials are disabled for this status request",
            );
          }
          const { callGateway } = await import("../../gateway/call.js");
          const statusPayload = await callGateway({
            url: opts.url,
            token: opts.token,
            password: opts.password,
            tlsFingerprint: opts.tlsFingerprint,
            ...(allowRpcConfigCredentials && opts.config ? { config: opts.config } : {}),
            method: "status",
            timeoutMs: opts.timeoutMs,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
          });
          statusRuntimeVersion = readRuntimeVersionFromStatusPayload(statusPayload);
          const authProbe = await probeGateway(probeOpts).catch(() => null);
          return { ok: true as const, authProbe };
        }
        return await probeGateway(probeOpts);
      },
    );
    const probeDetails = resolveGatewayStatusProbeDetails(result);
    const auth = probeDetails?.auth;
    const server = probeDetails?.server;
    const serverSummary = server ? { server } : {};
    const version = server?.version ?? ("authProbe" in result ? statusRuntimeVersion : null);
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
        ...serverSummary,
        ...(version != null ? { version } : {}),
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
      ...serverSummary,
      ...(version != null ? { version } : {}),
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
