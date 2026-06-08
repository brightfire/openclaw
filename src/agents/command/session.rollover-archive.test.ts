import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
  updateSessionStore,
} from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveSession } from "./session.js";

vi.mock("../../config/sessions/store-load.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/store-load.js")>();
  return {
    ...actual,
    loadSessionStore: (storePath: string): Record<string, SessionEntry> => {
      try {
        return JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
      } catch {
        return {};
      }
    },
  };
});

vi.mock("../bootstrap-cache.js", () => ({
  clearBootstrapSnapshotOnSessionRollover: () => {},
}));

async function withTempStore<T>(
  initial: Record<string, SessionEntry>,
  run: (storePath: string) => Promise<T> | T,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-rollover-archive-"));
  const storePath = path.join(dir, "sessions.json");
  await fsp.writeFile(storePath, JSON.stringify(initial, null, 2));
  try {
    return await run(storePath);
  } finally {
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe("resolveSession rollover archiving", () => {
  afterEach(async () => {
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();
  });

  it("resolveSession signals a rollover, and updateSessionStore archives it", async () => {
    const oldSessionId = "old-session-id-1234";
    const sessionKey = "agent:main:main";
    const staleUpdatedAt = Date.now() - 60 * 60 * 1000; // 1 hour ago

    const existingEntry: SessionEntry = {
      sessionId: oldSessionId,
      updatedAt: staleUpdatedAt,
      model: "test-model",
    };

    await withTempStore({ [sessionKey]: existingEntry }, async (storePath) => {
      const cfg = {
        session: {
          store: storePath,
          mainKey: "main",
          reset: {
            idleMinutes: 5, // 5-minute idle → session is stale since updatedAt is 1h ago
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveSession({
        cfg,
        to: "main",
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(oldSessionId);

      // Archiving now happens automatically when the new sessionId is persisted
      // via updateSessionStore — simulate what the caller does:
      clearSessionStoreCacheForTest();
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = {
          ...store[sessionKey],
          sessionId: result.sessionId,
          updatedAt: Date.now(),
        };
      });
      await drainSessionStoreWriterQueuesForTest();
      clearSessionStoreCacheForTest();

      const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
      const archiveKey = `${sessionKey}:archived:${oldSessionId}`;
      const archived = raw[archiveKey];
      expect(archived).toBeDefined();
      expect(archived?.archived).toBe(true);
      expect(archived?.archivedReason).toBe("reset");
      expect(archived?.archivedAt).toBeTypeOf("number");
      expect(archived?.sessionId).toBe(oldSessionId);
      expect(archived?.model).toBe("test-model");
    });
  });

  it("does not archive when the session is fresh (no rollover)", async () => {
    const sessionId = "fresh-session-id";
    const sessionKey = "agent:main:main";

    const freshEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now() - 1000, // 1 second ago — well within idle window
    };

    await withTempStore({ [sessionKey]: freshEntry }, (storePath) => {
      const cfg = {
        session: {
          store: storePath,
          mainKey: "main",
          reset: {
            idleMinutes: 60,
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveSession({
        cfg,
        to: "main",
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe(sessionId);

      // No archived entries should exist
      const archivedKeys = Object.keys(result.sessionStore ?? {}).filter((k) =>
        k.includes(":archived:"),
      );
      expect(archivedKeys).toHaveLength(0);
    });
  });

  it("does not archive when there is no existing session entry", async () => {
    await withTempStore({}, (storePath) => {
      const cfg = {
        session: {
          store: storePath,
          mainKey: "main",
          reset: {
            idleMinutes: 5,
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveSession({
        cfg,
        to: "main",
      });

      expect(result.isNewSession).toBe(true);

      // No archived entries
      const archivedKeys = Object.keys(result.sessionStore ?? {}).filter((k) =>
        k.includes(":archived:"),
      );
      expect(archivedKeys).toHaveLength(0);
    });
  });

  it("does not archive when an explicit sessionId is provided (not a rollover)", async () => {
    const existingSessionId = "existing-session";
    const sessionKey = "agent:main:main";

    const staleEntry: SessionEntry = {
      sessionId: existingSessionId,
      updatedAt: Date.now() - 60 * 60 * 1000,
    };

    await withTempStore({ [sessionKey]: staleEntry }, (storePath) => {
      const cfg = {
        session: {
          store: storePath,
          mainKey: "main",
          reset: {
            idleMinutes: 5,
          },
        },
      } as unknown as OpenClawConfig;

      // When sessionId is explicitly provided, isNewSession is false
      const result = resolveSession({
        cfg,
        to: "main",
        sessionId: "explicit-provided-id",
      });

      expect(result.isNewSession).toBe(false);

      // No archived entries because isNewSession is false
      const archivedKeys = Object.keys(result.sessionStore ?? {}).filter((k) =>
        k.includes(":archived:"),
      );
      expect(archivedKeys).toHaveLength(0);
    });
  });
});
