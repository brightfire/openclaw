import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArchiveStoreEntry } from "./archive-entry.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
  updateSessionStore,
} from "./store.js";
import type { SessionEntry } from "./types.js";

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "test-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("buildArchiveStoreEntry", () => {
  it("builds correct archive key and entry for reset reason", () => {
    const entry = makeEntry({ sessionId: "abc-123" });
    const { archiveKey, archiveEntry } = buildArchiveStoreEntry("agent:main:main", entry, "reset");

    expect(archiveKey).toBe("agent:main:main:archived:abc-123");
    expect(archiveEntry.archived).toBe(true);
    expect(archiveEntry.archivedReason).toBe("reset");
    expect(archiveEntry.archivedAt).toBeTypeOf("number");
    expect(archiveEntry.archivedAt).toBeGreaterThan(0);
    expect(archiveEntry.sessionId).toBe("abc-123");
  });

  it("builds correct archive key for rollover reason", () => {
    const entry = makeEntry({ sessionId: "def-456" });
    const { archiveKey, archiveEntry } = buildArchiveStoreEntry(
      "agent:main:explicit:xyz",
      entry,
      "reset",
    );

    expect(archiveKey).toBe("agent:main:explicit:xyz:archived:def-456");
    expect(archiveEntry.archivedReason).toBe("reset");
  });

  it("preserves all original entry fields", () => {
    const entry = makeEntry({
      sessionId: "orig-id",
      updatedAt: 1000,
      thinkingLevel: "high",
      label: "my-label",
    });
    const { archiveEntry } = buildArchiveStoreEntry("key", entry, "deleted");

    expect(archiveEntry.sessionId).toBe("orig-id");
    expect(archiveEntry.updatedAt).toBe(1000);
    expect(archiveEntry.thinkingLevel).toBe("high");
    expect(archiveEntry.label).toBe("my-label");
    expect(archiveEntry.archived).toBe(true);
    expect(archiveEntry.archivedReason).toBe("deleted");
  });
});

describe("sessions.delete inline archive via buildArchiveStoreEntry", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    clearSessionStoreCacheForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-delete-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an archived copy when a session is deleted via store mutation", async () => {
    const initialStore: Record<string, SessionEntry> = {
      "agent:main:slack:direct:u1": makeEntry({
        sessionId: "sess-to-delete",
        label: "doomed",
      }),
    };
    fs.writeFileSync(storePath, JSON.stringify(initialStore, null, 2), "utf-8");

    // Simulate the sessions.delete handler: build archive entry, insert it, delete the original.
    await updateSessionStore(storePath, (store) => {
      const primaryKey = "agent:main:slack:direct:u1";
      const currentEntry = store[primaryKey];
      if (currentEntry) {
        const { archiveKey, archiveEntry } = buildArchiveStoreEntry(
          primaryKey,
          currentEntry,
          "deleted",
        );
        store[archiveKey] = archiveEntry;
        delete store[primaryKey];
      }
    });
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();

    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;

    // Original entry should be gone
    expect(raw["agent:main:slack:direct:u1"]).toBeUndefined();

    // Archived entry should exist
    const archiveKey = "agent:main:slack:direct:u1:archived:sess-to-delete";
    expect(raw[archiveKey]).toBeDefined();
    expect(raw[archiveKey].archived).toBe(true);
    expect(raw[archiveKey].archivedReason).toBe("deleted");
    expect(raw[archiveKey].sessionId).toBe("sess-to-delete");
    expect(raw[archiveKey].label).toBe("doomed");
    expect(raw[archiveKey].archivedAt).toBeTypeOf("number");
  });
});

describe("updateSessionStore automatic archiving", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    clearSessionStoreCacheForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-entry-test-"));
    storePath = path.join(tmpDir, "sessions.json");
    // Write an initial store with one active entry
    const initialStore: Record<string, SessionEntry> = {
      "agent:main:main": makeEntry({ sessionId: "active-session" }),
    };
    fs.writeFileSync(storePath, JSON.stringify(initialStore, null, 2), "utf-8");
  });

  afterEach(async () => {
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("automatically archives when sessionId changes via updateSessionStore", async () => {
    await updateSessionStore(storePath, (store) => {
      store["agent:main:main"] = makeEntry({ sessionId: "new-session" });
    });
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();

    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
    const archiveKey = "agent:main:main:archived:active-session";
    expect(raw[archiveKey]).toBeDefined();
    expect(raw[archiveKey].archived).toBe(true);
    expect(raw[archiveKey].archivedReason).toBe("reset");
    expect(raw[archiveKey].sessionId).toBe("active-session");
    // New entry should be present
    expect(raw["agent:main:main"].sessionId).toBe("new-session");
  });

  it("does not archive when sessionId stays the same", async () => {
    await updateSessionStore(storePath, (store) => {
      store["agent:main:main"] = makeEntry({
        sessionId: "active-session",
        label: "updated-label",
      });
    });
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();

    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
    const archiveKeys = Object.keys(raw).filter((k) => k.includes(":archived:"));
    expect(archiveKeys).toHaveLength(0);
  });

  it("does not re-archive existing archive entries", async () => {
    // Pre-populate with an archive entry
    const initialStore: Record<string, SessionEntry> = {
      "agent:main:main": makeEntry({ sessionId: "current" }),
      "agent:main:main:archived:old": makeEntry({
        sessionId: "old",
        archived: true,
        archivedAt: 1000,
        archivedReason: "reset",
      }),
    };
    fs.writeFileSync(storePath, JSON.stringify(initialStore, null, 2), "utf-8");
    clearSessionStoreCacheForTest();

    await updateSessionStore(storePath, (store) => {
      store["agent:main:main"] = makeEntry({ sessionId: "newest" });
    });
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();

    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
    // Should have the old archive entry untouched and a new one for "current"
    expect(raw["agent:main:main:archived:old"]).toBeDefined();
    expect(raw["agent:main:main:archived:current"]).toBeDefined();
    expect(raw["agent:main:main:archived:current"].archivedReason).toBe("reset");
    // Should NOT have created a double-archive entry
    const doubleArchiveKeys = Object.keys(raw).filter(
      (k) => (k.match(/:archived:/g) || []).length > 1,
    );
    expect(doubleArchiveKeys).toHaveLength(0);
  });

  it("preserves old entry data in the archive", async () => {
    const now = Date.now();
    const initialStore: Record<string, SessionEntry> = {
      "agent:main:main": makeEntry({
        sessionId: "to-archive",
        updatedAt: now - 1000,
        thinkingLevel: "high",
        label: "important-session",
      }),
    };
    fs.writeFileSync(storePath, JSON.stringify(initialStore, null, 2), "utf-8");
    clearSessionStoreCacheForTest();

    await updateSessionStore(storePath, (store) => {
      store["agent:main:main"] = makeEntry({ sessionId: "replacement" });
    });
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();

    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
    const archived = raw["agent:main:main:archived:to-archive"];
    expect(archived).toBeDefined();
    expect(archived.sessionId).toBe("to-archive");
    expect(archived.updatedAt).toBe(now - 1000);
    expect(archived.thinkingLevel).toBe("high");
    expect(archived.label).toBe("important-session");
    expect(archived.archived).toBe(true);
  });
});
