/**
 * XGW state management: nonces, exposure table, pending callbacks.
 * Handles persistence to ~/.openclaw/state/xgw-async.json.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { XgwExposureEntry, XgwPendingCallback } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────

const MAX_NONCES = 10_000;
const TIMESTAMP_WINDOW_SEC = 300; // 5 minutes
const EXPIRED_PRUNE_BUFFER_SEC = 3600; // 1 hour dead zone for callback pruning

// ── State ───────────────────────────────────────────────────────────

// noncesByPeer: peer -> [nonce, ...]
const noncesByPeer = new Map<string, string[]>();

// sessionKey (xgw:<correlationId>) -> entry
const exposureTable = new Map<string, XgwExposureEntry>();

// correlationId -> record
const pendingCallbacks = new Map<string, XgwPendingCallback>();

function isValidPendingStatus(status: unknown): status is XgwPendingCallback["status"] {
  return status === "pending" || status === "delivered" || status === "expired";
}

function sanitizePendingCallback(rawEntry: unknown): XgwPendingCallback | null {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return null;
  }
  const entry = rawEntry as Record<string, unknown>;
  if (
    typeof entry.sourceSessionKey !== "string" ||
    typeof entry.allowedPeer !== "string" ||
    typeof entry.createdAt !== "number" ||
    typeof entry.expiresAt !== "number" ||
    !isValidPendingStatus(entry.status)
  ) {
    return null;
  }

  const sanitized: XgwPendingCallback = {
    sourceSessionKey: entry.sourceSessionKey,
    allowedPeer: entry.allowedPeer,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    status: entry.status,
  };

  if (typeof entry.targetSessionKey === "string" && entry.targetSessionKey.trim()) {
    sanitized.targetSessionKey = entry.targetSessionKey;
  }
  if (typeof entry.deliveredAt === "number") {
    sanitized.deliveredAt = entry.deliveredAt;
  }
  if (
    entry.resultStatus === "ok" ||
    entry.resultStatus === "error" ||
    entry.resultStatus === "timeout" ||
    entry.resultStatus === "cancelled"
  ) {
    sanitized.resultStatus = entry.resultStatus;
  }
  if (typeof entry.lastDeliveryAttemptAt === "number") {
    sanitized.lastDeliveryAttemptAt = entry.lastDeliveryAttemptAt;
  }
  if (typeof entry.lastDeliveryError === "string") {
    sanitized.lastDeliveryError = entry.lastDeliveryError;
  }

  return sanitized;
}

// ── File persistence ───────────────────────────────────────────────

export function getStateDir(): string {
  return path.join(os.homedir(), ".openclaw", "state");
}

export function getStateFile(): string {
  return path.join(getStateDir(), "xgw-async.json");
}

export function loadState(): void {
  try {
    const filePath = getStateFile();
    if (!fs.existsSync(filePath)) {
      return;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, Record<string, unknown> | undefined>;
    const nowSec = Math.floor(Date.now() / 1000);

    pendingCallbacks.clear();
    exposureTable.clear();

    if (data.pendingCallbacks) {
      for (const [corrId, rawEntry] of Object.entries(data.pendingCallbacks)) {
        const entry = sanitizePendingCallback(rawEntry);
        if (!entry) {
          continue;
        }
        if (entry.status === "expired") {
          if (entry.expiresAt > nowSec - EXPIRED_PRUNE_BUFFER_SEC) {
            pendingCallbacks.set(corrId, entry);
          }
          continue;
        }
        if (entry.expiresAt > nowSec) {
          pendingCallbacks.set(corrId, entry);
        }
      }
    }

    if (data.exposureTable) {
      for (const [key, rawEntry] of Object.entries(data.exposureTable)) {
        const entry = rawEntry as XgwExposureEntry | undefined;
        if (entry && entry.expiresAt > nowSec) {
          exposureTable.set(key, entry);
        }
      }
    }
  } catch (err) {
    // corrupt or missing — start fresh
    process.stderr.write(
      `[xgw] loadState failed (corrupt or missing state file), starting fresh: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

export function saveState(): void {
  try {
    const dir = getStateDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = {
      pendingCallbacks: Object.fromEntries(pendingCallbacks.entries()),
      exposureTable: Object.fromEntries(exposureTable.entries()),
    };
    fs.writeFileSync(getStateFile(), JSON.stringify(data, null, 2));
  } catch (err) {
    // best-effort persistence; no fsync guarantees
    process.stderr.write(
      `[xgw] saveState failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ── Nonce tracking (per-peer FIFO eviction) ────────────────────────

export function checkNonce(peer: string, nonce: string): boolean {
  let nonces = noncesByPeer.get(peer);
  if (!nonces) {
    nonces = [];
    noncesByPeer.set(peer, nonces);
  }
  if (nonces.includes(nonce)) {
    return false;
  }
  if (nonces.length >= MAX_NONCES) {
    nonces.shift();
  }
  nonces.push(nonce);
  return true;
}

export function validateTimestamp(ts: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= TIMESTAMP_WINDOW_SEC;
}

// ── Exposure table ──────────────────────────────────────────────────

export function getExposure(sessionKey: string): XgwExposureEntry | undefined {
  const entry = exposureTable.get(sessionKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt < Date.now() / 1000) {
    exposureTable.delete(sessionKey);
    return undefined;
  }
  return entry;
}

export function setExposure(sessionKey: string, entry: XgwExposureEntry): void {
  exposureTable.set(sessionKey, entry);
}

export function refreshExposure(sessionKey: string, ttlSeconds: number): void {
  const entry = exposureTable.get(sessionKey);
  if (entry) {
    entry.expiresAt = Date.now() / 1000 + ttlSeconds;
  }
}

export function removeExposure(sessionKey: string): void {
  exposureTable.delete(sessionKey);
}

export function getActiveSessionCount(): number {
  const now = Date.now() / 1000;
  let count = 0;
  for (const [, entry] of exposureTable.entries()) {
    if (entry.expiresAt >= now) {
      count++;
    }
  }
  return count;
}

// ── Pending callbacks ───────────────────────────────────────────────

export function getPendingCallback(correlationId: string): XgwPendingCallback | undefined {
  return pendingCallbacks.get(correlationId);
}

export function setPendingCallback(correlationId: string, entry: XgwPendingCallback): void {
  pendingCallbacks.set(correlationId, entry);
}

export function markCallbackExpired(correlationId: string): void {
  const entry = pendingCallbacks.get(correlationId);
  if (entry && entry.status !== "expired") {
    entry.status = "expired";
    entry.resultStatus ??= "timeout";
  }
}

export function notePendingCallbackDeliveryAttempt(
  correlationId: string,
  details?: { error?: string },
): void {
  const entry = pendingCallbacks.get(correlationId);
  if (!entry) {
    return;
  }
  entry.lastDeliveryAttemptAt = Date.now() / 1000;
  entry.lastDeliveryError = details?.error;
}

export function getPendingCallbackEntries(): [string, XgwPendingCallback][] {
  return Array.from(pendingCallbacks.entries());
}

export function getActiveCallbackCount(): number {
  let count = 0;
  for (const [, entry] of pendingCallbacks.entries()) {
    if (entry.status === "pending") {
      count++;
    }
  }
  return count;
}

export function markCallbackDelivered(
  correlationId: string,
  details?: {
    resultStatus?: XgwPendingCallback["resultStatus"];
    targetSessionKey?: string;
  },
): void {
  const entry = pendingCallbacks.get(correlationId);
  if (entry && entry.status === "pending") {
    entry.status = "delivered";
    entry.deliveredAt = Date.now() / 1000;
    entry.resultStatus = details?.resultStatus ?? entry.resultStatus;
    entry.targetSessionKey = details?.targetSessionKey ?? entry.targetSessionKey;
    entry.lastDeliveryError = undefined;
    entry.lastDeliveryAttemptAt ??= entry.deliveredAt;
  }
}

// ── Pruning ────────────────────────────────────────────────────────

export function pruneExpired(): void {
  const now = Date.now() / 1000;

  for (const [key, entry] of exposureTable.entries()) {
    if (entry.expiresAt < now) {
      exposureTable.delete(key);
    }
  }

  for (const [corrId, entry] of pendingCallbacks.entries()) {
    if (entry.status === "pending" && entry.expiresAt < now) {
      entry.status = "expired";
      entry.resultStatus ??= "timeout";
    }
    if (entry.expiresAt < now - EXPIRED_PRUNE_BUFFER_SEC) {
      pendingCallbacks.delete(corrId);
    }
  }

  saveState();
}
