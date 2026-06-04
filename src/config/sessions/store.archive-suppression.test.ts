// Regression tests for the archive-suppression refinement in
// `updateSessionStore`. Three scenarios must all hold simultaneously:
//
//   1. Plain lazy rollover: canonical key rotates sessionId, no aliases
//      involved. MUST archive.
//   2. Lazy rollover with concurrent UNRELATED alias prune: canonical key
//      rotates X→Y while an alias carrying a DIFFERENT sessionId Z gets
//      pruned. MUST still archive X.
//   3. Ghost promotion + rotation (PR #73's original scenario): canonical
//      key and a legacy alias both carry sessionId X (the alias was
//      ghost-promoted into the canonical key earlier). The mutator prunes
//      the alias AND rotates the canonical to Y in the same transaction.
//      MUST NOT archive X (it was never the canonical key's real history).
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
  updateSessionStore,
} from "./store.js";
import type { SessionEntry } from "./types.js";

vi.mock("./store-load.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store-load.js")>();
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

async function withTempStore<T>(
  initial: Record<string, SessionEntry>,
  run: (storePath: string) => Promise<T> | T,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-suppression-"));
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

describe("updateSessionStore archive suppression refinement", () => {
  afterEach(async () => {
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();
  });

  it("scenario 1: plain lazy rollover archives the predecessor sessionId", async () => {
    const canonicalKey = "agent:main:main";
    const oldSessionId = crypto.randomUUID();
    const initial: SessionEntry = {
      sessionId: oldSessionId,
      updatedAt: Date.now() - 24 * 60 * 60 * 1000,
      sessionStartedAt: Date.now() - 24 * 60 * 60 * 1000,
    };
    await withTempStore({ [canonicalKey]: initial }, async (storePath) => {
      const newSessionId = crypto.randomUUID();
      await updateSessionStore(storePath, (store) => {
        store[canonicalKey] = {
          ...store[canonicalKey],
          sessionId: newSessionId,
          updatedAt: Date.now(),
        };
      });
      await drainSessionStoreWriterQueuesForTest();
      clearSessionStoreCacheForTest();

      const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
      const archiveKey = `${canonicalKey}:archived:${oldSessionId}`;
      expect(raw[archiveKey]).toBeDefined();
      expect(raw[archiveKey]?.sessionId).toBe(oldSessionId);
      expect(raw[archiveKey]?.archivedReason).toBe("reset");
    });
  });

  it("scenario 2: lazy rollover with unrelated alias prune still archives the canonical predecessor", async () => {
    const canonicalKey = "agent:main:main";
    const unrelatedAliasKey = "agent:main:slack:default:direct:u01legacy";
    const canonicalOldSessionId = crypto.randomUUID();
    const aliasSessionId = crypto.randomUUID(); // intentionally DIFFERENT from canonical

    const initialCanonical: SessionEntry = {
      sessionId: canonicalOldSessionId,
      updatedAt: Date.now() - 24 * 60 * 60 * 1000,
      sessionStartedAt: Date.now() - 24 * 60 * 60 * 1000,
    };
    const initialAlias: SessionEntry = {
      sessionId: aliasSessionId,
      updatedAt: Date.now() - 24 * 60 * 60 * 1000,
      sessionStartedAt: Date.now() - 24 * 60 * 60 * 1000,
    };

    await withTempStore(
      { [canonicalKey]: initialCanonical, [unrelatedAliasKey]: initialAlias },
      async (storePath) => {
        const newSessionId = crypto.randomUUID();
        await updateSessionStore(storePath, (store) => {
          delete store[unrelatedAliasKey];
          store[canonicalKey] = {
            ...store[canonicalKey],
            sessionId: newSessionId,
            updatedAt: Date.now(),
          };
        });
        await drainSessionStoreWriterQueuesForTest();
        clearSessionStoreCacheForTest();

        const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
        const archiveKey = `${canonicalKey}:archived:${canonicalOldSessionId}`;
        // Canonical's predecessor sessionId is real history. Archive it.
        expect(raw[archiveKey]).toBeDefined();
        expect(raw[archiveKey]?.sessionId).toBe(canonicalOldSessionId);
        // The unrelated alias's sessionId is not canonical history. Don't
        // archive it under the canonical key.
        const wrongArchiveKey = `${canonicalKey}:archived:${aliasSessionId}`;
        expect(raw[wrongArchiveKey]).toBeUndefined();
      },
    );
  });

  it("scenario 3: ghost-promoted sessionId is NOT archived when the alias is pruned in the same mutation as the canonical rotation", async () => {
    // PR #73's scenario: legacy alias + canonical both share the same
    // sessionId due to a ghost promotion. Mutator prunes alias AND rotates
    // the canonical. The shared sessionId should NOT be archived under the
    // canonical key.
    const canonicalKey = "agent:ops:work";
    const aliasKey = "agent:ops:MAIN";
    const ghostSessionId = crypto.randomUUID();

    const sharedEntry: SessionEntry = {
      sessionId: ghostSessionId,
      updatedAt: Date.now() - 1000, // recent — ghost was just promoted
      sessionStartedAt: Date.now() - 1000,
    };

    await withTempStore(
      { [canonicalKey]: sharedEntry, [aliasKey]: { ...sharedEntry } },
      async (storePath) => {
        const newSessionId = crypto.randomUUID();
        await updateSessionStore(storePath, (store) => {
          delete store[aliasKey];
          store[canonicalKey] = {
            ...store[canonicalKey],
            sessionId: newSessionId,
            updatedAt: Date.now(),
          };
        });
        await drainSessionStoreWriterQueuesForTest();
        clearSessionStoreCacheForTest();

        const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
        const archiveKey = `${canonicalKey}:archived:${ghostSessionId}`;
        expect(raw[canonicalKey]?.sessionId).toBe(newSessionId);
        expect(raw[archiveKey]).toBeUndefined();
      },
    );
  });

  it("scenario 4 (regression): plain alias prune with NO canonical rotation does not create an archive", async () => {
    const canonicalKey = "agent:main:main";
    const aliasKey = "agent:main:MAIN";
    const sharedSessionId = crypto.randomUUID();
    const shared: SessionEntry = {
      sessionId: sharedSessionId,
      updatedAt: Date.now() - 1000,
      sessionStartedAt: Date.now() - 1000,
    };
    await withTempStore(
      { [canonicalKey]: shared, [aliasKey]: { ...shared } },
      async (storePath) => {
        await updateSessionStore(storePath, (store) => {
          delete store[aliasKey];
          // Canonical does NOT rotate.
        });
        await drainSessionStoreWriterQueuesForTest();
        clearSessionStoreCacheForTest();
        const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
        const archiveKey = `${canonicalKey}:archived:${sharedSessionId}`;
        expect(raw[archiveKey]).toBeUndefined();
        expect(raw[canonicalKey]?.sessionId).toBe(sharedSessionId);
      },
    );
  });
});
