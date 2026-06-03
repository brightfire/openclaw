import fs from "node:fs";
import path from "node:path";
import type { MsgContext } from "../../auto-reply/templating.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import { buildArchiveStoreEntry } from "./archive-entry.js";
import { enforceSessionDiskBudget, type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  dropSessionStoreObjectCache,
  getSerializedSessionStore,
  isSessionStoreCacheEnabled,
  setSerializedSessionStore,
  takeMutableSessionStoreCache,
  writeSessionStoreCache,
} from "./store-cache.js";
import { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
import { loadSessionStore, normalizeSessionStore } from "./store-load.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import { runExclusiveSessionStoreWrite } from "./store-writer.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
  getSessionStoreWriterQueueSizeForTest,
} from "./store-writer-state.js";
export { withSessionStoreWriterForTest } from "./store-writer.js";
export { loadSessionStore } from "./store-load.js";
export { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";

const log = createSubsystemLogger("sessions/store");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;
let trajectoryCleanupRuntimePromise: Promise<typeof import("../../trajectory/cleanup.js")> | null =
  null;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function loadTrajectoryCleanupRuntime() {
  trajectoryCleanupRuntimePromise ??= import("../../trajectory/cleanup.js");
  return trajectoryCleanupRuntimePromise;
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStore(params.storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    return resolved.existing?.updatedAt;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Session Store Pruning, Capping & File Rotation
// ============================================================================

export type SessionMaintenanceApplyReport = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
};

export {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
};
export type { ResolvedSessionMaintenanceConfig, SessionMaintenanceWarning };

type SaveSessionStoreOptions = {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /**
   * Session keys that are allowed to drop persisted ACP metadata during this update.
   * All other updates preserve existing `entry.acp` blocks when callers replace the
   * whole session entry without carrying ACP state forward.
   */
  allowDropAcpMetaSessionKeys?: string[];
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  /** Optional callback with maintenance stats after a save. */
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  /** Optional overrides used by maintenance commands. */
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
};

function updateSessionStoreWriteCaches(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): void {
  const fileStat = getFileStatSnapshot(params.storePath);
  setSerializedSessionStore(params.storePath, params.serialized);
  if (!isSessionStoreCacheEnabled()) {
    dropSessionStoreObjectCache(params.storePath);
    return;
  }
  writeSessionStoreCache({
    storePath: params.storePath,
    store: params.store,
    mtimeMs: fileStat?.mtimeMs,
    sizeBytes: fileStat?.sizeBytes,
    serialized: params.serialized,
  });
}

function loadMutableSessionStoreForWriter(storePath: string): Record<string, SessionEntry> {
  if (isSessionStoreCacheEnabled()) {
    const currentFileStat = getFileStatSnapshot(storePath);
    const cached = takeMutableSessionStoreCache({
      storePath,
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
    });
    if (cached) {
      return cached;
    }
  }
  return loadSessionStore(storePath, { skipCache: true, clone: false });
}

function resolveMutableSessionStoreKey(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): string | undefined {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(store, trimmed)) {
    return trimmed;
  }
  const normalized = normalizeStoreSessionKey(trimmed);
  if (Object.prototype.hasOwnProperty.call(store, normalized)) {
    return normalized;
  }
  return Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
}

function collectAcpMetadataSnapshot(
  store: Record<string, SessionEntry>,
): Map<string, NonNullable<SessionEntry["acp"]>> {
  const snapshot = new Map<string, NonNullable<SessionEntry["acp"]>>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (entry?.acp) {
      snapshot.set(sessionKey, entry.acp);
    }
  }
  return snapshot;
}

function preserveExistingAcpMetadata(params: {
  previousAcpByKey: Map<string, NonNullable<SessionEntry["acp"]>>;
  nextStore: Record<string, SessionEntry>;
  allowDropSessionKeys?: string[];
}): void {
  const allowDrop = new Set(
    (params.allowDropSessionKeys ?? []).map((key) => normalizeStoreSessionKey(key)),
  );
  for (const [previousKey, previousAcp] of params.previousAcpByKey.entries()) {
    const normalizedKey = normalizeStoreSessionKey(previousKey);
    if (allowDrop.has(normalizedKey)) {
      continue;
    }
    const nextKey = resolveMutableSessionStoreKey(params.nextStore, previousKey);
    if (!nextKey) {
      continue;
    }
    const nextEntry = params.nextStore[nextKey];
    if (!nextEntry || nextEntry.acp) {
      continue;
    }
    params.nextStore[nextKey] = {
      ...nextEntry,
      acp: previousAcp,
    };
  }
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  normalizeSessionStore(store);

  if (!opts?.skipMaintenance) {
    // Resolve maintenance config once (avoids repeated getRuntimeConfig() calls).
    const maintenance = opts?.maintenanceConfig
      ? { ...opts.maintenanceConfig, ...opts?.maintenanceOverride }
      : { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
    const shouldWarnOnly = maintenance.mode === "warn";
    const beforeCount = Object.keys(store).length;
    const forceMaintenance = opts?.maintenanceOverride !== undefined;
    const shouldRunEntryMaintenance = shouldRunSessionEntryMaintenance({
      entryCount: beforeCount,
      maxEntries: maintenance.maxEntries,
      force: forceMaintenance,
    });

    if (shouldWarnOnly) {
      const activeSessionKey = opts?.activeSessionKey?.trim();
      if (activeSessionKey && shouldRunEntryMaintenance) {
        const warning = getActiveSessionMaintenanceWarning({
          store,
          activeSessionKey,
          pruneAfterMs: maintenance.pruneAfterMs,
          maxEntries: maintenance.maxEntries,
        });
        if (warning) {
          log.warn("session maintenance would evict active session; skipping enforcement", {
            activeSessionKey: warning.activeSessionKey,
            wouldPrune: warning.wouldPrune,
            wouldCap: warning.wouldCap,
            pruneAfterMs: warning.pruneAfterMs,
            maxEntries: warning.maxEntries,
          });
          await opts?.onWarn?.(warning);
        }
      }
      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: true,
        log,
      });
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: Object.keys(store).length,
        pruned: 0,
        capped: 0,
        diskBudget,
      });
    } else {
      const preserveSessionKeys = opts?.activeSessionKey
        ? new Set([opts.activeSessionKey])
        : undefined;
      // Prune stale entries and cap total count before serializing.
      const removedSessionFiles = new Map<string, string | undefined>();
      const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
        onPruned: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
        preserveKeys: preserveSessionKeys,
      });
      const countAfterPrune = Object.keys(store).length;
      const shouldRunCapMaintenance =
        forceMaintenance ||
        shouldRunSessionEntryMaintenance({
          entryCount: countAfterPrune,
          maxEntries: maintenance.maxEntries,
        });
      const capped = shouldRunCapMaintenance
        ? capEntryCount(store, maintenance.maxEntries, {
            onCapped: ({ entry }) => {
              rememberRemovedSessionFile(removedSessionFiles, entry);
            },
            preserveKeys: preserveSessionKeys,
          })
        : 0;
      const archivedDirs = new Set<string>();
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedForDeletedSessions = await archiveRemovedSessionTranscripts({
        removedSessionFiles,
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      if (removedSessionFiles.size > 0) {
        const { removeRemovedSessionTrajectoryArtifacts } = await loadTrajectoryCleanupRuntime();
        await removeRemovedSessionTrajectoryArtifacts({
          removedSessionFiles,
          referencedSessionIds,
          storePath,
          restrictToStoreDir: true,
        });
      }
      for (const archivedDir of archivedForDeletedSessions) {
        archivedDirs.add(archivedDir);
      }
      if (archivedDirs.size > 0 || maintenance.resetArchiveRetentionMs != null) {
        const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
        const targetDirs =
          archivedDirs.size > 0 ? [...archivedDirs] : [path.dirname(path.resolve(storePath))];
        await cleanupArchivedSessionTranscripts({
          directories: targetDirs,
          olderThanMs: maintenance.pruneAfterMs,
          reason: "deleted",
        });
        if (maintenance.resetArchiveRetentionMs != null) {
          await cleanupArchivedSessionTranscripts({
            directories: targetDirs,
            olderThanMs: maintenance.resetArchiveRetentionMs,
            reason: "reset",
          });
        }
      }

      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: false,
        log,
      });
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: Object.keys(store).length,
        pruned,
        capped,
        diskBudget,
      });
    }
  }

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  if (getSerializedSessionStore(storePath) === json) {
    updateSessionStoreWriteCaches({ storePath, store, serialized: json });
    return;
  }

  // Windows: keep retry semantics because rename can fail while readers hold locks.
  if (process.platform === "win32") {
    for (let i = 0; i < 5; i++) {
      try {
        await writeSessionStoreAtomic({ storePath, store, serialized: json });
        return;
      } catch (err) {
        const code = getErrorCode(err);
        if (code === "ENOENT") {
          return;
        }
        if (i < 4) {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          continue;
        }
        // Final attempt failed - skip this save. The writer queue ensures
        // the next save will retry with fresh data. Log for diagnostics.
        log.warn(`atomic write failed after 5 attempts: ${storePath}`);
      }
    }
    return;
  }

  try {
    await writeSessionStoreAtomic({ storePath, store, serialized: json });
  } catch (err) {
    const code = getErrorCode(err);

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await writeSessionStoreAtomic({ storePath, store, serialized: json });
      } catch (err2) {
        const code2 = getErrorCode(err2);
        if (code2 === "ENOENT") {
          return;
        }
        throw err2;
      }
      return;
    }

    throw err;
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  await runExclusiveSessionStoreWrite(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store, opts);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts?: SaveSessionStoreOptions,
): Promise<T> {
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const previousAcpByKey = collectAcpMetadataSnapshot(store);

    // Snapshot entries with sessionIds before the mutator runs so we can
    // detect sessionId changes and archive the old entry automatically.
    // Skip archive keys themselves (they contain `:archived:`).
    const previousEntries = new Map<string, SessionEntry>();
    for (const [key, entry] of Object.entries(store)) {
      if (entry?.sessionId && !key.includes(":archived:")) {
        previousEntries.set(key, { ...entry });
      }
    }

    const result = await mutator(store);

    // Detect ghost promotions: a sessionId X is "ghost-promoted" into a
    // canonical key when a legacy alias (e.g. "agent:ops:MAIN") and the
    // canonical key ("agent:ops:work") simultaneously carry X — typically
    // produced by `migrateAndPruneGatewaySessionStoreKey` mid-transition.
    // When the mutator prunes the alias AND rotates the canonical key in the
    // same transaction, the canonical key never owned X as real history;
    // archiving it would surface a duplicate ghost rather than a real prior
    // session.
    //
    // To distinguish ghost promotion from a legitimate rollover that happens
    // to coincide with unrelated alias cleanup, we require BOTH conditions
    // per sessionId: (1) the sessionId appeared in `previousEntries` under at
    // least TWO distinct keys, and (2) at least one of those keys was pruned
    // by the mutator. In real lazy rollover, the predecessor sessionId
    // belongs only to the rotating canonical key — no other key carried it —
    // so this set stays empty and archive fires normally.
    const previousKeysBySessionId = new Map<string, Set<string>>();
    for (const [key, oldEntry] of previousEntries) {
      if (!oldEntry.sessionId) {
        continue;
      }
      let keys = previousKeysBySessionId.get(oldEntry.sessionId);
      if (!keys) {
        keys = new Set<string>();
        previousKeysBySessionId.set(oldEntry.sessionId, keys);
      }
      keys.add(key);
    }
    const ghostPromotedSessionIds = new Set<string>();
    for (const [sessionId, keys] of previousKeysBySessionId) {
      if (keys.size < 2) {
        continue;
      }
      let prunedAny = false;
      for (const key of keys) {
        if (!store[key]) {
          prunedAny = true;
          break;
        }
      }
      if (prunedAny) {
        ghostPromotedSessionIds.add(sessionId);
      }
    }

    // Detect sessionId changes and create archive entries for old sessions.
    for (const [key, oldEntry] of previousEntries) {
      const newEntry = store[key];
      if (newEntry?.sessionId && newEntry.sessionId !== oldEntry.sessionId) {
        // Skip archiving when the old sessionId was ghost-promoted (shared by
        // a now-pruned legacy alias and the canonical key). Those entries
        // were never authoritative history and should not surface as
        // archived sessions.
        if (ghostPromotedSessionIds.has(oldEntry.sessionId)) {
          continue;
        }
        // Determine the archive reason:
        // - "deleted": the entry is being marked as archived (explicit deletion)
        // - "reset": the entry still exists with a new sessionId and is not
        //   archived (e.g. daily auto-reset or session rollover)
        const reason = newEntry.archived ? "deleted" : "reset";
        const { archiveKey, archiveEntry } = buildArchiveStoreEntry(key, oldEntry, reason);
        if (!store[archiveKey]) {
          store[archiveKey] = archiveEntry;
        }
      }
    }

    preserveExistingAcpMetadata({
      previousAcpByKey,
      nextStore: store,
      allowDropSessionKeys: opts?.allowDropAcpMetaSessionKeys,
    });
    await saveSessionStoreUnlocked(storePath, store, opts);
    return result;
  });
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return String((error as { code?: unknown }).code);
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

export async function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted" | "reset";
  restrictToStoreDir?: boolean;
}): Promise<Set<string>> {
  const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
  const archivedDirs = new Set<string>();
  for (const [sessionId, sessionFile] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    const archived = archiveSessionTranscripts({
      sessionId,
      storePath: params.storePath,
      sessionFile,
      reason: params.reason,
      restrictToStoreDir: params.restrictToStoreDir,
    });
    for (const archivedPath of archived) {
      archivedDirs.add(path.dirname(archivedPath));
    }
  }
  return archivedDirs;
}

async function writeSessionStoreAtomic(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): Promise<void> {
  await writeTextAtomic(params.storePath, params.serialized, { mode: 0o600 });
  updateSessionStoreWriteCaches({
    storePath: params.storePath,
    store: params.store,
    serialized: params.serialized,
  });
}

async function persistResolvedSessionEntry(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  resolved: ReturnType<typeof resolveSessionStoreEntry>;
  next: SessionEntry;
}): Promise<SessionEntry> {
  params.store[params.resolved.normalizedKey] = params.next;
  for (const legacyKey of params.resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  await saveSessionStoreUnlocked(params.storePath, params.store, {
    activeSessionKey: params.resolved.normalizedKey,
  });
  return params.next;
}

/**
 * Patch metadata on an existing session entry without participating in
 * archive snapshotting. This bypasses the sessionId-change detection in
 * `updateSessionStore` — which is fine because callers only patch
 * metadata fields (label, model, thinkingLevel, etc.), never sessionIds.
 */
export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing) {
      return null;
    }
    const patch = await update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
    });
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await updateSessionStore(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      const existing = resolved.existing;
      const patch = deriveSessionMetaPatch({
        ctx,
        sessionKey: resolved.normalizedKey,
        existing,
        groupResolution: params.groupResolution,
      });
      if (!patch) {
        if (existing && resolved.legacyKeys.length > 0) {
          store[resolved.normalizedKey] = existing;
          for (const legacyKey of resolved.legacyKeys) {
            delete store[legacyKey];
          }
        }
        return existing ?? null;
      }
      if (!existing && !createIfMissing) {
        return null;
      }
      const next = existing
        ? // Inbound metadata updates must not refresh activity timestamps;
          // idle reset evaluation relies on updatedAt from actual session turns.
          mergeSessionEntryPreserveActivity(existing, patch)
        : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return next;
    },
    { activeSessionKey: normalizeStoreSessionKey(sessionKey) },
  );
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing && !createIfMissing) {
      return null;
    }
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      channel,
      to,
      accountId,
      threadId,
    });
    const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
    const explicitDeliveryContext = params.deliveryContext;
    const explicitThreadFromDeliveryContext =
      explicitDeliveryContext != null &&
      Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
        ? explicitDeliveryContext.threadId
        : undefined;
    const explicitThreadValue =
      explicitThreadFromDeliveryContext ??
      (threadId != null && threadId !== "" ? threadId : undefined);
    const explicitRouteProvided = Boolean(
      explicitContext?.channel ||
      explicitContext?.to ||
      inlineContext?.channel ||
      inlineContext?.to,
    );
    const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
    const fallbackContext = clearThreadFromFallback
      ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
      : deliveryContextFromSession(existing);
    const merged = mergeDeliveryContext(mergedInput, fallbackContext);
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        channel: merged?.channel,
        to: merged?.to,
        accountId: merged?.accountId,
        threadId: merged?.threadId,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          sessionKey: resolved.normalizedKey,
          existing,
          groupResolution: params.groupResolution,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      deliveryContext: normalized.deliveryContext,
      lastChannel: normalized.lastChannel,
      lastTo: normalized.lastTo,
      lastAccountId: normalized.lastAccountId,
      lastThreadId: normalized.lastThreadId,
    };
    // Route updates must not refresh activity timestamps; idle/daily reset
    // evaluation relies on updatedAt from actual session turns (#49515).
    const next = mergeSessionEntryPreserveActivity(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
    });
  });
}
