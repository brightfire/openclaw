import { afterEach, describe, expect, test } from "vitest";
import { resetSubagentRegistryForTests } from "../agents/subagent-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { listSessionsFromStoreAsync } from "./session-utils.js";

/**
 * Tests for the `key` filter on `sessions.list`.
 *
 * The filter is a strict equality match against the canonical storage key.
 * It plays two distinct roles:
 *
 *  - On the primary entry pass it scopes the result to the one live row whose
 *    canonical key equals `opts.key`.
 *  - On the archived twin pass (gated behind `includeArchived: true`) it scopes
 *    the result to twins whose original key prefix (`<key>:archived:<sessionId>`)
 *    equals `opts.key`, so a single call returns the full lineage of one
 *    session — the live row plus every archived twin from prior resets/deletes.
 */

const baseCfg = {
  session: { mainKey: "main" },
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;

function makeMixedStore(): Record<string, SessionEntry> {
  const now = Date.now();
  return {
    "agent:main:work": {
      sessionId: "sess-work-live",
      updatedAt: now,
      displayName: "Work",
    } as SessionEntry,
    "agent:main:personal": {
      sessionId: "sess-personal-live",
      updatedAt: now - 1000,
      displayName: "Personal",
    } as SessionEntry,
    "agent:main:slack:dm:U123": {
      sessionId: "sess-slack-live",
      updatedAt: now - 2000,
      displayName: "Slack DM",
    } as SessionEntry,
    "agent:main:work:archived:sess-work-older": {
      sessionId: "sess-work-older",
      updatedAt: now - 5000,
      archived: true,
      archivedAt: now - 5000,
      archivedReason: "reset",
    } as SessionEntry,
    "agent:main:work:archived:sess-work-oldest": {
      sessionId: "sess-work-oldest",
      updatedAt: now - 10_000,
      archived: true,
      archivedAt: now - 10_000,
      archivedReason: "deleted",
    } as SessionEntry,
    "agent:main:personal:archived:sess-personal-old": {
      sessionId: "sess-personal-old",
      updatedAt: now - 7000,
      archived: true,
      archivedAt: now - 7000,
      archivedReason: "reset",
    } as SessionEntry,
  };
}

describe("listSessionsFromStore key filter", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    resetAgentRunContextForTest();
  });

  test("returns only the live entry whose canonical key matches", async () => {
    const result = await listSessionsFromStoreAsync({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store: makeMixedStore(),
      opts: { key: "agent:main:work" },
    });

    expect(result.sessions.map((s) => s.key)).toEqual(["agent:main:work"]);
    expect(result.sessions[0].sessionId).toBe("sess-work-live");
    expect(result.sessions[0].archived).toBeUndefined();
  });

  test("returns an empty result when no live entry matches", async () => {
    const result = await listSessionsFromStoreAsync({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store: makeMixedStore(),
      opts: { key: "agent:main:does-not-exist" },
    });

    expect(result.sessions).toHaveLength(0);
  });

  test("does not surface archived twins on the primary pass when key matches a live entry", async () => {
    // Without includeArchived, only the primary live row should appear, even
    // though archived twins for the same canonical key exist in the store.
    const result = await listSessionsFromStoreAsync({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store: makeMixedStore(),
      opts: { key: "agent:main:work" },
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].archived).toBeUndefined();
    expect(result.sessions[0].key).toBe("agent:main:work");
  });

  test("includeArchived: true with key returns the live entry plus its archived twins", async () => {
    const result = await listSessionsFromStoreAsync({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store: makeMixedStore(),
      opts: { key: "agent:main:work", includeArchived: true },
    });

    // Three rows: one primary + two archived twins, all keyed off
    // `agent:main:work` (twins are emitted under their original key).
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions.every((s) => s.key === "agent:main:work")).toBe(true);

    const archived = result.sessions.filter((s) => s.archived === true);
    const live = result.sessions.filter((s) => s.archived !== true);
    expect(live).toHaveLength(1);
    expect(live[0].sessionId).toBe("sess-work-live");
    expect(new Set(archived.map((s) => s.sessionId))).toEqual(
      new Set(["sess-work-older", "sess-work-oldest"]),
    );
  });

  test("includeArchived: true with key does not bleed in twins from other canonical keys", async () => {
    const result = await listSessionsFromStoreAsync({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store: makeMixedStore(),
      opts: { key: "agent:main:work", includeArchived: true },
    });

    // The personal-archive twin must not appear in the work lineage.
    const sessionIds = result.sessions.map((s) => s.sessionId);
    expect(sessionIds).not.toContain("sess-personal-old");
    expect(sessionIds).not.toContain("sess-personal-live");
    expect(sessionIds).not.toContain("sess-slack-live");
  });

  test("includeArchived: true with key but no matching live entry still returns matching twins", async () => {
    // Edge case: live entry was removed but archived twins remain. The lineage
    // should still surface so callers can recover history.
    const store = makeMixedStore();
    delete store["agent:main:work"];

    const result = await listSessionsFromStoreAsync({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { key: "agent:main:work", includeArchived: true },
    });

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.every((s) => s.archived === true)).toBe(true);
    expect(result.sessions.every((s) => s.key === "agent:main:work")).toBe(true);
    expect(new Set(result.sessions.map((s) => s.sessionId))).toEqual(
      new Set(["sess-work-older", "sess-work-oldest"]),
    );
  });

  test("key filter composes with archivedFrom/archivedTo window", async () => {
    const store = makeMixedStore();
    // Pick an archivedAt cutoff that excludes the oldest twin (sess-work-oldest at now-10s)
    // but keeps the more recent one (sess-work-older at now-5s).
    const cutoff = (store["agent:main:work:archived:sess-work-older"].archivedAt ?? 0) - 100;

    const result = await listSessionsFromStoreAsync({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        key: "agent:main:work",
        includeArchived: true,
        archivedFrom: cutoff,
      },
    });

    const archived = result.sessions.filter((s) => s.archived === true);
    expect(archived.map((s) => s.sessionId)).toEqual(["sess-work-older"]);
  });

  test("empty key filter is treated as unset and returns all live entries", async () => {
    const result = await listSessionsFromStoreAsync({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store: makeMixedStore(),
      opts: { key: "" as unknown as string },
    });

    // Three live entries; archived twins are gated behind includeArchived.
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions.every((s) => s.archived !== true)).toBe(true);
  });
});
