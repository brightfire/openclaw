/**
 * Inbound XGW endpoint handler.
 *
 * POST /xgateway — Dispatch a cross-gateway message into a session.
 * POST /xgateway/callback — Deliver an async callback result.
 *
 * This module contains the core logic previously distributed across the Skynet
 * plugin (~/.openclaw/extensions/receptionist/) and fleet-upgrade hot-patches.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../../config/io.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  SubagentGetSessionMessagesResult,
  SubagentRunParams,
  SubagentRunResult,
  SubagentWaitParams,
  SubagentWaitResult,
} from "../../plugins/runtime/types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { postCallbackWithRetry } from "./outbound.js";
import {
  checkNonce,
  getActiveSessionCount,
  getExposure,
  getPendingCallback,
  getPendingCallbackEntries,
  loadState,
  markCallbackDelivered,
  markCallbackExpired,
  pruneExpired,
  refreshExposure,
  removeExposure,
  saveState,
  setExposure,
  validateTimestamp,
} from "./state.js";
import type { XgwConfig, XgwInboundResponse } from "./types.js";
import { XGW_SESSION_PREFIX } from "./types.js";
import { resolveEnvValue } from "./utils.js";

// ── Agent dispatch ──────────────────────────────────────────────────

// We import these dynamically to avoid circular dependencies with the
// embedded runner. The actual gateway imports setGatewaySubagentRuntime
// during startup.
const GATEWAY_SUBAGENT_SYMBOL = Symbol.for("openclaw.plugin.gatewaySubagentRuntime");

type XgwMessageBlock = { type: string; text?: string };
type XgwSessionMessage = { role?: string; content?: string | XgwMessageBlock[] };

interface SubagentRuntime {
  run(
    args: SubagentRunParams & {
      channel?: string;
      inputProvenance?: InputProvenance;
      agentId?: string;
    },
  ): Promise<SubagentRunResult>;
  waitForRun(args: SubagentWaitParams): Promise<SubagentWaitResult>;
  getSessionMessages(args: {
    sessionKey: string;
    limit?: number;
  }): Promise<SubagentGetSessionMessagesResult>;
  deleteSession(args: { sessionKey: string; deleteTranscript?: boolean }): Promise<void>;
}

function getSubagent(): SubagentRuntime | null {
  const state = (globalThis as Record<symbol, unknown>)[GATEWAY_SUBAGENT_SYMBOL] as
    | { subagent?: SubagentRuntime }
    | undefined;
  return state?.subagent ?? null;
}

// ── Config helpers ──────────────────────────────────────────────────

function getXgwConfig(): XgwConfig {
  try {
    const cfg = getRuntimeConfig() as { fleet?: { crossGateway?: XgwConfig } } | undefined;
    return cfg?.fleet?.crossGateway ?? {};
  } catch {
    return {};
  }
}

function getAcceptedTokens(): Record<string, string> {
  try {
    const cfg = getRuntimeConfig() as { fleet?: { crossGateway?: XgwConfig } } | undefined;
    return cfg?.fleet?.crossGateway?.acceptedTokens ?? {};
  } catch {
    return {};
  }
}

// ── Auth ────────────────────────────────────────────────────────────

function authenticateXgwToken(token: string): string | null {
  const tokens = getAcceptedTokens();
  const tokenBuf = Buffer.from(token);
  for (const [peer, known] of Object.entries(tokens)) {
    const knownBuf = Buffer.from(resolveEnvValue(known));
    if (tokenBuf.length === knownBuf.length && timingSafeEqual(tokenBuf, knownBuf)) {
      return peer;
    }
  }
  return null;
}

// ── Dispatcher: spawn worker session ────────────────────────────────

async function spawnWorker(
  correlationId: string,
  message: string,
  sourceSessionKey: string,
  sourceChannel: string | undefined,
  peer: string,
  cfg: XgwConfig,
): Promise<XgwInboundResponse> {
  const agentId = cfg.agentId ?? undefined;
  const subagent = getSubagent();
  if (!subagent) {
    return { ok: false, status: "error", error: "internal error" };
  }

  const sessionKey = `${XGW_SESSION_PREFIX}${correlationId}`;
  const maxConcurrent = cfg.maxConcurrent ?? 10;

  // Check capacity
  if (getActiveSessionCount() >= maxConcurrent) {
    return { ok: false, status: "capacity_exceeded", error: "capacity exceeded" };
  }

  // Register in exposure table
  const now = Date.now() / 1000;
  const ttl = cfg.exposureTtlSeconds ?? 300;
  setExposure(sessionKey, {
    correlationId,
    allowedPeer: peer,
    createdAt: now,
    expiresAt: now + ttl,
  });
  saveState();

  const sourceIdentity = `[Cross-gateway message from ${peer}${sourceSessionKey ? "/" + sourceSessionKey : ""}]`;
  const inputProv: InputProvenance = {
    kind: "inter_session",
    sourceSessionKey: sourceSessionKey || `${peer}:unknown`,
    sourceChannel: sourceChannel || "xgw",
    sourceTool: "sessions_send",
  };

  try {
    const { runId } = await subagent.run({
      message,
      sessionKey,
      idempotencyKey: `xgw:${correlationId}:${randomUUID()}`,
      deliver: false,
      channel: "internal",
      lane: "nested",
      extraSystemPrompt: sourceIdentity,
      inputProvenance: inputProv,
      agentId,
    });
    return { ok: true, runId, status: "ok", sessionKey };
  } catch {
    removeExposure(sessionKey);
    saveState();
    return { ok: false, status: "error", error: "internal error" };
  }
}

async function dispatchDirect(
  sessionKey: string,
  message: string,
  peer: string,
  timeoutSeconds: number,
  cfg: XgwConfig,
): Promise<XgwInboundResponse> {
  const exposure = getExposure(sessionKey);
  if (!exposure) {
    return { ok: false, status: "forbidden", error: "session not accessible" };
  }
  if (exposure.allowedPeer !== peer) {
    return { ok: false, status: "forbidden", error: "session not accessible" };
  }

  // Refresh expiry
  const ttl = cfg.exposureTtlSeconds ?? 300;
  refreshExposure(sessionKey, ttl);
  saveState();

  const subagent = getSubagent();
  if (!subagent) {
    return { ok: false, status: "error", error: "internal error" };
  }

  try {
    const { runId } = await subagent.run({
      message,
      sessionKey,
      idempotencyKey: `xgw:${sessionKey}:${randomUUID()}`,
      deliver: false,
      channel: "internal",
      lane: "nested",
    });

    await subagent.waitForRun({ runId, timeoutMs: timeoutSeconds * 1000 });

    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 1 });
    const lastMsg = messages?.[0] as XgwSessionMessage | undefined;
    const reply =
      lastMsg?.role === "assistant"
        ? typeof lastMsg.content === "string"
          ? lastMsg.content
          : Array.isArray(lastMsg.content)
            ? lastMsg.content
                .filter((b): b is XgwMessageBlock => b.type === "text")
                .map((b) => b.text ?? "")
                .join("\n")
            : ""
        : "";

    return { ok: true, runId, status: "ok", sessionKey, reply: reply || undefined };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message?.includes("timeout");
    return {
      ok: false,
      status: isTimeout ? "timeout" : "error",
      error: "internal error",
    };
  }
}

/**
 * Read the last assistant reply from a session.
 */
async function extractReply(sessionKey: string): Promise<string | undefined> {
  const subagent = getSubagent();
  if (!subagent) {
    return undefined;
  }

  try {
    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const msg = messages[i] as XgwSessionMessage | undefined;
      if (!msg || msg.role !== "assistant") {
        continue;
      }
      if (typeof msg.content === "string") {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((b): b is XgwMessageBlock => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
      }
    }
  } catch {
    // swallow — caller handles missing reply
  }
  return undefined;
}

// ── HTTP Helpers ────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{
  ok: boolean;
  value?: Record<string, unknown>;
  error?: string;
}> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        resolve({ ok: false, error: "payload too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      resolve({ ok: false, error: "read error" });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "request body timeout" });
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<
          string,
          unknown
        >;
        resolve({ ok: true, value });
      } catch {
        resolve({ ok: false, error: "invalid JSON" });
      }
    });
  });
}

// ── Main handler: POST /xgateway ───────────────────────────────────

export async function handleXgwHook(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    return false;
  }

  // Check enabled
  if (getXgwConfig().enabled !== true) {
    sendJson(res, 503, {
      ok: false,
      status: "error",
      error: "cross-gateway messaging is not enabled",
    });
    return true;
  }

  // Parse auth header
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    sendJson(res, 401, { ok: false, status: "error", error: "unauthorized" });
    return true;
  }
  const token = authHeader.slice(7).trim();
  const peer = authenticateXgwToken(token);
  if (!peer) {
    sendJson(res, 401, { ok: false, status: "error", error: "unauthorized" });
    return true;
  }

  const cfg = getXgwConfig();

  // Circular self-send detection: reject if the authenticated peer is ourselves.
  const selfName = cfg.gatewayName;
  if (selfName && peer === selfName) {
    sendJson(res, 400, { ok: false, status: "error", error: "circular send: cannot send to self" });
    return true;
  }

  // Parse body
  const body = await readJsonBody(req, 1048576);
  if (!body.ok) {
    const st =
      body.error === "payload too large" ? 413 : body.error === "request body timeout" ? 408 : 400;
    sendJson(res, st, {
      ok: false,
      status: "error",
      error: st === 413 ? "payload too large" : body.error,
    });
    return true;
  }
  const p = body.value as Record<string, unknown>;

  // Extract and validate fields
  const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
  const message = typeof p.message === "string" ? p.message.trim() : "";
  const sourceSessionKey = typeof p.sourceSessionKey === "string" ? p.sourceSessionKey : "";
  const sourceChannel = typeof p.sourceChannel === "string" ? p.sourceChannel : undefined;
  const correlationId = p.correlationId as string | undefined;
  const nonce = p.nonce as string | undefined;
  const timestamp = typeof p.timestamp === "number" ? p.timestamp : 0;
  const timeoutSeconds =
    typeof p.timeoutSeconds === "number" && Number.isFinite(p.timeoutSeconds)
      ? Math.min(120, Math.max(1, Math.floor(p.timeoutSeconds)))
      : 30;
  const isAsync = p.async === true;
  const isMultiTurn = p.multiTurn === true;

  // async=true and multiTurn=true are mutually exclusive (DESIGN.md §4.4);
  // multi-turn loop runs on the sending gateway, not here (DESIGN.md §4.3).
  if (!correlationId || !correlationId.length) {
    sendJson(res, 400, {
      ok: false,
      status: "error",
      error: "missing required field: correlationId",
    });
    return true;
  }
  if (!nonce || !nonce.length) {
    sendJson(res, 400, { ok: false, status: "error", error: "missing required field: nonce" });
    return true;
  }

  if (isAsync && isMultiTurn) {
    sendJson(res, 400, {
      ok: false,
      status: "error",
      error: "async and multiTurn are mutually exclusive",
    });
    return true;
  }

  if (!sessionKey || !message) {
    sendJson(res, 400, { ok: false, status: "error", error: "sessionKey and message required" });
    return true;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > 300) {
    sendJson(res, 400, { ok: false, status: "error", error: "request expired" });
    return true;
  }
  if (!checkNonce(peer, nonce)) {
    sendJson(res, 409, { ok: false, status: "error", error: "duplicate nonce" });
    return true;
  }

  // === Dispatcher path: sessionKey === "receptionist" ===
  if (sessionKey === "receptionist") {
    // Spawn new worker
    const result = await spawnWorker(
      correlationId,
      message,
      sourceSessionKey || "unknown",
      sourceChannel,
      peer,
      cfg,
    );

    if (!result.ok) {
      const httpStatus = result.status === "capacity_exceeded" ? 503 : 500;
      sendJson(res, httpStatus, result as unknown as Record<string, unknown>);
      return true;
    }

    // Async: register pending callback, return immediately, dispatch in background
    if (isAsync) {
      const cbTimeout =
        typeof p.callbackTimeoutSeconds === "number" && Number.isFinite(p.callbackTimeoutSeconds)
          ? Math.min(3600, Math.max(1, Math.floor(p.callbackTimeoutSeconds)))
          : 600;

      sendJson(res, 200, {
        ok: true,
        status: "accepted",
        correlationId,
        sessionKey: result.sessionKey,
      });

      // Fire-and-forget: wait for worker, extract reply, POST callback back to caller.
      // The caller (Gateway A) owns the pendingCallback record — we just deliver.
      void handleAsyncCallbackOutbound(
        result.runId!,
        result.sessionKey!,
        correlationId,
        cbTimeout * 1000,
        peer,
      ).catch(() => {
        // errors logged internally
      });
      return true;
    }

    // Sync: wait for run, extract reply
    try {
      const subagent = getSubagent();
      if (subagent) {
        await subagent.waitForRun({ runId: result.runId!, timeoutMs: timeoutSeconds * 1000 });
      }
    } catch {
      sendJson(res, 504, {
        ok: false,
        status: "timeout",
        error: "request timed out",
        sessionKey: result.sessionKey,
      });
      return true;
    }

    const reply = await extractReply(result.sessionKey!);
    sendJson(res, 200, {
      ok: true,
      runId: result.runId,
      status: "ok",
      sessionKey: result.sessionKey,
      reply: reply ?? null,
    });
    return true;
  }

  // === Direct session dispatch (xgw:<correlationId>) ===
  if (sessionKey.startsWith(XGW_SESSION_PREFIX)) {
    const result = await dispatchDirect(sessionKey, message, peer, timeoutSeconds, cfg);
    if (!result.ok) {
      const httpStatus = result.status === "timeout" ? 504 : 403;
      sendJson(res, httpStatus, result as unknown as Record<string, unknown>);
    } else {
      sendJson(res, 200, result as unknown as Record<string, unknown>);
    }
    return true;
  }

  // Unknown session key
  sendJson(res, 400, { ok: false, status: "error", error: "unknown session key" });
  return true;
}

/**
 * Fire-and-forget outbound async callback delivery (receiver side).
 *
 * Waits for the local worker session to complete, extracts its reply, then
 * POSTs the callback result back to the calling gateway at /xgateway/callback
 * with exponential-backoff retry.  The receiver does NOT own a pendingCallback
 * record — the caller (Gateway A) created that record locally before dispatching.
 */
async function handleAsyncCallbackOutbound(
  runId: string,
  sessionKey: string,
  correlationId: string,
  timeoutMs: number,
  peer: string,
): Promise<void> {
  const subagent = getSubagent();
  if (!subagent) {
    return;
  }

  let workerTimedOut = false;
  try {
    const waitResult = await subagent.waitForRun({ runId, timeoutMs });
    if (waitResult?.status === "timeout") {
      workerTimedOut = true;
    }
  } catch {
    workerTimedOut = true;
  }

  let reply: string | undefined;
  let resultStatus: "ok" | "timeout" | "error" = "ok";
  let resultError: string | undefined;

  if (workerTimedOut) {
    resultStatus = "timeout";
    resultError = `Worker timed out after ${Math.floor(timeoutMs / 1000)}s`;
  } else {
    reply = await extractReply(sessionKey);
    if (!reply) {
      resultStatus = "error";
      resultError = "Worker completed but no reply was produced";
    }
  }

  const cfg = getXgwConfig();
  const peers = cfg.peers ?? {};
  const peerCfg = peers[peer];
  const outboundToken = peerCfg?.token ? resolveEnvValue(peerCfg.token) : "";
  const peerUrl = peerCfg?.url ?? "";

  const callbackPayload: Record<string, unknown> = {
    correlationId,
    sessionKey,
    nonce: randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
  };

  if (resultStatus === "timeout") {
    callbackPayload.status = "timeout";
    callbackPayload.error = resultError ?? "Worker timed out";
  } else if (resultStatus === "error") {
    callbackPayload.status = "error";
    callbackPayload.error = resultError ?? "";
  } else {
    callbackPayload.status = "ok";
    callbackPayload.reply = reply ?? "";
  }

  const result = await postCallbackWithRetry(peerUrl, outboundToken, callbackPayload);

  if (!result.ok) {
    process.stderr.write(
      `[xgw] callback delivery permanently failed for ${correlationId} after retries: ${result.error ?? "unknown"}
`,
    );
    // Caller-side record will be pruned/expired by the caller's own pruner.
  }
}

// ── Callback handler: POST /xgateway/callback ─────────────────────

export async function handleXgwCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    return false;
  }

  // Check enabled
  if (getXgwConfig().enabled !== true) {
    sendJson(res, 503, {
      ok: false,
      status: "error",
      error: "cross-gateway messaging is not enabled",
    });
    return true;
  }

  // Auth
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }
  const token = authHeader.slice(7).trim();
  const peer = authenticateXgwToken(token);
  if (!peer) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }

  // Parse body
  const body = await readJsonBody(req, 1048576);
  if (!body.ok) {
    const st = body.error === "payload too large" ? 413 : 400;
    sendJson(res, st, { ok: false, error: st === 413 ? "payload too large" : body.error });
    return true;
  }
  const p = body.value as Record<string, unknown>;

  const correlationId = typeof p.correlationId === "string" ? p.correlationId : "";
  const reply = typeof p.reply === "string" ? p.reply : "";
  const status = typeof p.status === "string" ? p.status : "ok";
  const errorMsg = typeof p.error === "string" ? p.error : "";
  const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
  const nonce = typeof p.nonce === "string" ? p.nonce : "";
  const timestamp = p.timestamp as number | undefined;

  if (!correlationId) {
    sendJson(res, 400, { ok: false, error: "missing correlationId" });
    return true;
  }

  const VALID_STATUS = ["ok", "error", "timeout", "cancelled"];
  if (!VALID_STATUS.includes(status)) {
    sendJson(res, 400, { ok: false, error: `invalid status: ${status}` });
    return true;
  }

  if (timestamp !== undefined && !validateTimestamp(timestamp)) {
    sendJson(res, 410, { ok: false, error: "request expired" });
    return true;
  }

  if (!nonce) {
    sendJson(res, 400, { ok: false, error: "missing nonce" });
    return true;
  }
  if (!checkNonce(peer, nonce)) {
    sendJson(res, 409, { ok: false, error: "duplicate nonce" });
    return true;
  }

  const pending = getPendingCallback(correlationId);
  if (!pending) {
    // Could have been pruned
    sendJson(res, 403, { ok: false, error: "unauthorized" });
    return true;
  }

  // Already delivered — idempotent
  if (pending.status === "delivered") {
    sendJson(res, 200, { ok: true, status: "already_delivered" });
    return true;
  }

  // Expired
  if (pending.status === "expired" || pending.expiresAt < Date.now() / 1000) {
    markCallbackExpired(correlationId);
    saveState();
    sendJson(res, 410, { ok: false, error: "callback expired" });
    return true;
  }

  // Verify peer (only the peer that initiated the async request can deliver)
  if (pending.allowedPeer !== peer) {
    sendJson(res, 403, { ok: false, error: "unauthorized" });
    return true;
  }

  // Deliver the callback result into the waiting session
  const subagent = getSubagent();
  if (!subagent) {
    sendJson(res, 500, { ok: false, error: "internal error" });
    return true;
  }

  const msgLines: string[] = [];
  msgLines.push(`**Cross-gateway async result from @${peer}**`);
  msgLines.push(`Correlation: ${correlationId}`);
  msgLines.push(`Status: ${status}`);
  if (errorMsg) {
    msgLines.push(`Error: ${errorMsg}`);
  }
  if (reply) {
    msgLines.push("");
    msgLines.push(reply);
  }

  try {
    // Deliver directly to the sourceSessionKey — no xgw: prefix fabrication.
    // The caller created the pendingCallback record with the real caller session key.
    await subagent.run({
      message: msgLines.join("\n"),
      sessionKey: pending.sourceSessionKey,
      idempotencyKey: `xgw:callback:${correlationId}:${randomUUID()}`,
      deliver: true,
      channel: "internal",
    });

    // Mark delivered and refresh exposure for follow-up
    markCallbackDelivered(correlationId, {
      resultStatus: status as "ok" | "error" | "timeout" | "cancelled",
      targetSessionKey: sessionKey || pending.targetSessionKey,
    });
    if (sessionKey) {
      refreshExposure(sessionKey, getXgwConfig().exposureTtlSeconds ?? 300);
    } else if (pending.targetSessionKey) {
      refreshExposure(pending.targetSessionKey, getXgwConfig().exposureTtlSeconds ?? 300);
    }
    saveState();
  } catch (err) {
    process.stderr.write(
      `[xgw] callback delivery failed for ${correlationId}: ${formatErrorMessage(err)}
`,
    );
    // Return 200 to prevent peer retries that would also fail
    sendJson(res, 200, { ok: true, status: "delivery_failed" });
    return true;
  }

  sendJson(res, 200, { ok: true, status: "delivered" });
  return true;
}

// ── Expired callback notification ──────────────────────────────────

/**
 * Push a timeout notification to the sourceSessionKey for any pending callbacks
 * that have expired since the last prune cycle.
 */
async function notifyExpiredCallbacks(): Promise<void> {
  const subagent = getSubagent();
  if (!subagent) {
    return;
  }

  const now = Date.now() / 1000;
  for (const [correlationId, entry] of getPendingCallbackEntries()) {
    if (entry.status === "pending" && entry.expiresAt < now) {
      // Mark expired first so we don't retry on the next cycle
      markCallbackExpired(correlationId);
      try {
        await subagent.run({
          message: "[Cross-gateway callback timed out]",
          sessionKey: entry.sourceSessionKey,
          idempotencyKey: `xgw:timeout:${correlationId}:${randomUUID()}`,
          deliver: true,
          channel: "internal",
        });
      } catch {
        // best-effort: if delivery fails, the session may already be gone
      }
    }
  }
  saveState();
}

// ── Initialization ──────────────────────────────────────────────────

// ── Lifecycle ───────────────────────────────────────────────────────

let pruneInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Called during gateway startup to initialize XGW state.
 */
export function initXgw(): void {
  loadState();
  pruneExpired();
  saveState();
  // Periodic prune + expired callback notification every 60s
  pruneInterval = setInterval(() => {
    void notifyExpiredCallbacks()
      .then(() => pruneExpired())
      .catch(() => pruneExpired());
  }, 60_000);
}

/**
 * Called during gateway shutdown to clean up XGW resources.
 */
export function shutdownXgw(): void {
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
  }
}
