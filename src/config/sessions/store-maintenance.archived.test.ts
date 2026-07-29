import { describe, expect, it } from "vitest";
import { compactExpiredArchivedEntries } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "test-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("compactExpiredArchivedEntries", () => {
  it("removes archived entries older than retention window", () => {
    const now = Date.now();
    const retentionMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const store: Record<string, SessionEntry> = {
      "agent:main:active": makeEntry({ sessionId: "active-1" }),
      "agent:main:archived:old-session": makeEntry({
        sessionId: "old-session",
        archived: true,
        archivedAt: now - retentionMs - 1000, // expired
        archivedReason: "reset",
      }),
      "agent:main:archived:recent-session": makeEntry({
        sessionId: "recent-session",
        archived: true,
        archivedAt: now - 1000, // still within retention
        archivedReason: "deleted",
      }),
    };

    const removed = compactExpiredArchivedEntries(store, retentionMs, { log: false });

    expect(removed).toBe(1);
    expect(store["agent:main:active"]).toBeDefined();
    expect(store["agent:main:archived:old-session"]).toBeUndefined();
    expect(store["agent:main:archived:recent-session"]).toBeDefined();
  });

  it("does not remove non-archived entries", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:active": makeEntry({
        sessionId: "active-1",
        updatedAt: now - 100 * 24 * 60 * 60 * 1000, // very old but not archived
      }),
    };

    const removed = compactExpiredArchivedEntries(store, 1000, { log: false });

    expect(removed).toBe(0);
    expect(store["agent:main:active"]).toBeDefined();
  });

  it("removes all expired archived entries", () => {
    const now = Date.now();
    const retentionMs = 1000;
    const store: Record<string, SessionEntry> = {
      "key:archived:a": makeEntry({
        archived: true,
        archivedAt: now - 2000,
        archivedReason: "reset",
      }),
      "key:archived:b": makeEntry({
        archived: true,
        archivedAt: now - 3000,
        archivedReason: "deleted",
      }),
    };

    const removed = compactExpiredArchivedEntries(store, retentionMs, { log: false });

    expect(removed).toBe(2);
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("returns 0 when store is empty", () => {
    const store: Record<string, SessionEntry> = {};
    const removed = compactExpiredArchivedEntries(store, 1000, { log: false });
    expect(removed).toBe(0);
  });

  it("skips archived entries without archivedAt", () => {
    const store: Record<string, SessionEntry> = {
      "key:archived:a": makeEntry({
        archived: true,
        // No archivedAt
        archivedReason: "reset",
      }),
    };

    const removed = compactExpiredArchivedEntries(store, 1000, { log: false });

    expect(removed).toBe(0);
    expect(store["key:archived:a"]).toBeDefined();
  });
});
