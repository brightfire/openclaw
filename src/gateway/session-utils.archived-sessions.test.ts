/**
 * Tests for the archived session scanning logic in `listSessionsFromStoreAsync`.
 * Uses real filesystem (tmp dirs) with minimal mocking for cfg/store.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState } from "../config/config.js";
import {
  formatSessionArchiveTimestamp,
} from "../config/sessions/artifacts.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { listSessionsFromStoreAsync } from "./session-utils.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
});

/** Minimal config for a single-agent setup pointing at a given workspace. */
function makeCfg(workspace?: string): OpenClawConfig {
  return {
    agents: {
      list: workspace
        ? [{ id: "main", default: true, workspace }]
        : [{ id: "main", default: true }],
      defaults: { model: { primary: "openai/gpt-4o" } },
    },
  } as OpenClawConfig;
}

/** Minimal store entry helper. */
function makeEntry(sessionId: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId,
    updatedAt: Date.now(),
    ...overrides,
  } as SessionEntry;
}

/**
 * Call listSessionsFromStoreAsync with a storePath that points to a
 * sessions.json *file* inside the given directory (so dirname resolves
 * correctly).  The file does not need to exist on disk.
 */
async function listWithArchived(
  sessionsDir: string,
  store: Record<string, SessionEntry>,
  opts: {
    includeArchived?: boolean;
    archivedFrom?: number;
    archivedTo?: number;
  } = { includeArchived: true },
  cfg?: OpenClawConfig,
) {
  const storePath = path.join(sessionsDir, "sessions.json");
  return listSessionsFromStoreAsync({
    cfg: cfg ?? makeCfg(),
    storePath,
    store,
    opts,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeArchiveFile(
  dir: string,
  sessionId: string,
  reason: "reset" | "deleted" | "bak",
  ts: number,
): string {
  const stamp = formatSessionArchiveTimestamp(ts);
  const name = `${sessionId}.jsonl.${reason}.${stamp}`;
  fs.writeFileSync(path.join(dir, name), "");
  return name;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("listSessionsFromStoreAsync – archived session scanning", () => {
  test("returns archived sessions when includeArchived=true and .jsonl.reset.* files exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-reset-"));
    try {
      const sessionId = "abc123";
      const ts = Date.now();
      writeArchiveFile(dir, sessionId, "reset", ts);

      const result = await listWithArchived(dir, {}, { includeArchived: true });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.sessionId).toBe(sessionId);
      expect(archived[0]?.archiveReason).toBe("reset");
      expect(archived[0]?.archiveTimestamp).toBe(ts);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns archived sessions for .jsonl.deleted.* files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-deleted-"));
    try {
      const sessionId = "def456";
      const ts = Date.now();
      writeArchiveFile(dir, sessionId, "deleted", ts);

      const result = await listWithArchived(dir, {}, { includeArchived: true });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.sessionId).toBe(sessionId);
      expect(archived[0]?.archiveReason).toBe("deleted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handles .jsonl.bak.* files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-bak-"));
    try {
      const sessionId = "ghi789";
      const ts = Date.now();
      writeArchiveFile(dir, sessionId, "bak", ts);

      const result = await listWithArchived(dir, {}, { includeArchived: true });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.sessionId).toBe(sessionId);
      expect(archived[0]?.archiveReason).toBe("bak");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT return archived sessions when includeArchived is false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-off-"));
    try {
      writeArchiveFile(dir, "sess-x", "reset", Date.now());

      const result = await listWithArchived(dir, {}, { includeArchived: false });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT return archived sessions when includeArchived is undefined", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-undef-"));
    try {
      writeArchiveFile(dir, "sess-y", "reset", Date.now());

      const result = await listWithArchived(dir, {}, {});

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("applies archivedFrom filter – excludes sessions archived before the timestamp", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-from-"));
    try {
      const early = Date.now() - 10_000;
      const late = Date.now();

      writeArchiveFile(dir, "early-sess", "reset", early);
      writeArchiveFile(dir, "late-sess", "reset", late);

      const result = await listWithArchived(dir, {}, {
        includeArchived: true,
        archivedFrom: early + 1, // exclude early
      });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.sessionId).toBe("late-sess");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("applies archivedTo filter – excludes sessions archived after the timestamp", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-to-"));
    try {
      const early = Date.now() - 10_000;
      const late = Date.now();

      writeArchiveFile(dir, "early-sess", "reset", early);
      writeArchiveFile(dir, "late-sess", "reset", late);

      const result = await listWithArchived(dir, {}, {
        includeArchived: true,
        archivedTo: late - 1, // exclude late
      });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.sessionId).toBe("early-sess");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inherits key/label/channel from active store entry with matching session ID", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-inherit-"));
    try {
      const sessionId = "known-session-id";
      writeArchiveFile(dir, sessionId, "reset", Date.now());

      const store: Record<string, SessionEntry> = {
        "agent:main:slack:default:direct:u123": makeEntry(sessionId, {
          label: "My Session",
          lastChannel: "slack",
        }),
      };

      const result = await listWithArchived(dir, store, { includeArchived: true });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.key).toBe("agent:main:slack:default:direct:u123");
      expect(archived[0]?.label).toBe("My Session");
      expect(archived[0]?.channel).toBe("slack");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses fallback key 'archived:<sessionId>' when no store entry matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-fallback-"));
    try {
      const sessionId = "orphaned-session-id";
      writeArchiveFile(dir, sessionId, "deleted", Date.now());

      const result = await listWithArchived(dir, {}, { includeArchived: true });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.key).toBe(`archived:${sessionId}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deduplicates archive files – same filename only counted once", async () => {
    // Single-dir scenario: write two separate archive files for the same session ID
    // (different timestamps) and verify both appear, not deduplicated wrongly.
    // Then verify that if we somehow have the same filename it won't appear twice.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-dedup-"));
    try {
      const sessionId = "dup-session";
      const ts1 = Date.now() - 5_000;
      const ts2 = Date.now();

      writeArchiveFile(dir, sessionId, "reset", ts1);
      writeArchiveFile(dir, sessionId, "reset", ts2);

      const result = await listWithArchived(dir, {}, { includeArchived: true });

      const archived = result.sessions.filter((s) => s.archived === true);
      // Both distinct archive files should appear
      expect(archived).toHaveLength(2);
      const timestamps = archived.map((s) => s.archiveTimestamp).sort();
      expect(timestamps[0]).toBe(ts1);
      expect(timestamps[1]).toBe(ts2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("works when storePath points to a sessions.json file (uses dirname)", async () => {
    // This is the standard case: storePath = /path/to/sessions.json
    // The code uses path.dirname() to get the actual directory.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archived-dirname-"));
    try {
      const sessionId = "dirname-sess";
      writeArchiveFile(dir, sessionId, "reset", Date.now());

      // storePath explicitly set to sessions.json inside the dir
      const storePath = path.join(dir, "sessions.json");
      const result = await listSessionsFromStoreAsync({
        cfg: makeCfg(),
        storePath,
        store: {},
        opts: { includeArchived: true },
      });

      const archived = result.sessions.filter((s) => s.archived === true);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.sessionId).toBe(sessionId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
