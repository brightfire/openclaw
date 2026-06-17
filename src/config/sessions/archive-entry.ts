import type { SessionArchiveReason } from "./artifacts.js";
import type { SessionEntry } from "./types.js";

/**
 * Build the archive key and entry for a session that is being replaced.
 * Pure function — no side effects. Use inside an existing `updateSessionStore`
 * callback when you already hold the writer lock.
 */
export function buildArchiveStoreEntry(
  sessionKey: string,
  entry: SessionEntry,
  reason: SessionArchiveReason,
): { archiveKey: string; archiveEntry: SessionEntry } {
  const archiveKey = `${sessionKey}:archived:${entry.sessionId}`;
  const now = Date.now();
  return {
    archiveKey,
    archiveEntry: {
      ...entry,
      archived: true,
      archivedAt: now,
      archivedReason: reason,
    },
  };
}
