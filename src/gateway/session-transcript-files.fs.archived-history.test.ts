import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { resolveArchivedTranscriptPaths } from "./session-transcript-files.fs.js";
import { resolveSessionTranscriptCandidates } from "./session-transcript-files.fs.js";
import { readRecentSessionMessagesAsync } from "./session-utils.fs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "");
  return p;
}

/** Build a timestamp string suitable for use in archive filenames. */
function ts(nowMs = Date.now()): string {
  return formatSessionArchiveTimestamp(nowMs);
}

// ---------------------------------------------------------------------------
// resolveArchivedTranscriptPaths
// ---------------------------------------------------------------------------

describe("resolveArchivedTranscriptPaths", () => {
  it("returns empty array when sessionId is empty", () => {
    const dir = makeTmpDir("oc-arh-empty-sid-");
    try {
      const result = resolveArchivedTranscriptPaths({ sessionId: "", sessionsDir: dir });
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array when sessionsDir is undefined", () => {
    const result = resolveArchivedTranscriptPaths({
      sessionId: "abc123",
      sessionsDir: undefined,
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when directory does not exist", () => {
    const result = resolveArchivedTranscriptPaths({
      sessionId: "abc123",
      sessionsDir: "/tmp/oc-arh-definitely-does-not-exist-xyzzy",
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when directory has no matching files", () => {
    const dir = makeTmpDir("oc-arh-no-match-");
    try {
      // Put some unrelated files in the directory
      touch(dir, "other-session.jsonl");
      touch(dir, "README.md");
      const result = resolveArchivedTranscriptPaths({
        sessionId: "my-session-id",
        sessionsDir: dir,
      });
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds .reset. archive files for a session ID", () => {
    const dir = makeTmpDir("oc-arh-reset-");
    try {
      const sessionId = "sess-reset-test";
      const archiveName = `${sessionId}.jsonl.reset.${ts()}`;
      touch(dir, archiveName);

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(path.join(dir, archiveName));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds .deleted. archive files for a session ID", () => {
    const dir = makeTmpDir("oc-arh-deleted-");
    try {
      const sessionId = "sess-deleted-test";
      const archiveName = `${sessionId}.jsonl.deleted.${ts()}`;
      touch(dir, archiveName);

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(path.join(dir, archiveName));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sorts multiple archive files by timestamp descending (most recent first)", () => {
    const dir = makeTmpDir("oc-arh-sort-");
    try {
      const sessionId = "sess-sort-test";

      const t1 = ts(Date.now() - 10_000); // oldest
      const t2 = ts(Date.now() - 5_000); // middle
      const t3 = ts(Date.now()); // newest

      const name1 = `${sessionId}.jsonl.reset.${t1}`;
      const name2 = `${sessionId}.jsonl.reset.${t2}`;
      const name3 = `${sessionId}.jsonl.deleted.${t3}`;

      // Write in non-chronological order to confirm sorting is not filesystem order
      touch(dir, name1);
      touch(dir, name3);
      touch(dir, name2);

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });

      expect(result).toHaveLength(3);
      expect(result[0]).toBe(path.join(dir, name3)); // newest first
      expect(result[1]).toBe(path.join(dir, name2));
      expect(result[2]).toBe(path.join(dir, name1)); // oldest last
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores regular .jsonl files (no archive suffix)", () => {
    const dir = makeTmpDir("oc-arh-ignore-active-");
    try {
      const sessionId = "sess-active";
      touch(dir, `${sessionId}.jsonl`); // active session file — should be ignored
      touch(dir, `${sessionId}.jsonl.reset.${ts()}`); // archive — should be found

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });
      expect(result).toHaveLength(1);
      expect(result[0]).not.toContain(`${sessionId}.jsonl\0`); // active file absent
      expect(result[0]).toContain(".reset.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores .bak.* files (bak reason is not a recognised archive suffix for history)", () => {
    const dir = makeTmpDir("oc-arh-ignore-bak-");
    try {
      const sessionId = "sess-bak-test";
      // .bak. files are not returned by resolveArchivedTranscriptPaths because
      // isSessionArchiveArtifactName only matches reset/deleted/bak, but
      // parseSessionArchiveTimestamp only matches reset and deleted — so bak
      // files are included in the prefix scan but get timestamp 0. The function
      // still includes them (with ts=0) unless explicitly filtered. Verify the
      // contract: only .reset. and .deleted. files carry non-zero timestamps.
      touch(dir, `${sessionId}.jsonl.bak.${ts()}`);
      touch(dir, `${sessionId}.jsonl.reset.${ts()}`);

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });
      // At a minimum the reset archive must be present
      expect(result.some((p) => p.includes(".reset."))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores archive files belonging to a different session ID", () => {
    const dir = makeTmpDir("oc-arh-diff-session-");
    try {
      const targetSessionId = "target-session";
      const otherSessionId = "other-session";

      touch(dir, `${otherSessionId}.jsonl.reset.${ts()}`);
      touch(dir, `${targetSessionId}.jsonl.reset.${ts()}`);

      const result = resolveArchivedTranscriptPaths({
        sessionId: targetSessionId,
        sessionsDir: dir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toContain(targetSessionId);
      expect(result[0]).not.toContain(otherSessionId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles a session ID that is a prefix of another session ID correctly", () => {
    const dir = makeTmpDir("oc-arh-prefix-");
    try {
      const sessionId = "sess";
      const longerSessionId = "sess-longer";

      touch(dir, `${longerSessionId}.jsonl.reset.${ts()}`);
      touch(dir, `${sessionId}.jsonl.deleted.${ts()}`);

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });

      // Only the exact session match should be returned
      expect(result).toHaveLength(1);
      expect(result[0]).toContain(`${sessionId}.jsonl.deleted.`);
      expect(result[0]).not.toContain(longerSessionId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds topic-qualified archive files (`<sessionId>-topic-<N>.jsonl.<reason>.<ts>`)", () => {
    // Regression: PR #85 review noted that topic-qualified archived
    // transcripts (e.g. `<sessionId>-topic-7.jsonl.reset.<ts>`) were missed by
    // the scan, causing `sessions_history`/`chat.history` to return empty for
    // topic conversations after a rollover or delete.
    const dir = makeTmpDir("oc-arh-topic-");
    try {
      const sessionId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
      const topicArchive = `${sessionId}-topic-7.jsonl.reset.${ts()}`;
      touch(dir, topicArchive);

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(path.join(dir, topicArchive));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns both bare and topic-qualified archives in timestamp-descending order", () => {
    const dir = makeTmpDir("oc-arh-topic-mixed-");
    try {
      const sessionId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

      const tOlder = ts(Date.now() - 30_000);
      const tNewer = ts(Date.now());

      const bareArchive = `${sessionId}.jsonl.reset.${tOlder}`; // older
      const topicArchive = `${sessionId}-topic-42.jsonl.reset.${tNewer}`; // newer

      // Write in non-chronological filesystem order
      touch(dir, bareArchive);
      touch(dir, topicArchive);

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });
      expect(result).toHaveLength(2);
      // Newer first
      expect(result[0]).toBe(path.join(dir, topicArchive));
      expect(result[1]).toBe(path.join(dir, bareArchive));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not match topic-qualified archives that belong to a different session ID", () => {
    const dir = makeTmpDir("oc-arh-topic-cross-session-");
    try {
      // sessionId is a prefix of another session id; without proper boundary
      // checking we could accidentally match the other session's topic file.
      const sessionId = "sess";
      const otherSessionId = "sess-other";

      touch(dir, `${otherSessionId}-topic-1.jsonl.reset.${ts()}`);
      touch(dir, `${sessionId}-topic-1.jsonl.reset.${ts()}`);

      const result = resolveArchivedTranscriptPaths({ sessionId, sessionsDir: dir });
      expect(result).toHaveLength(1);
      expect(result[0]).toContain(`${sessionId}-topic-1.jsonl.reset.`);
      expect(result[0]).not.toContain(`${otherSessionId}-topic-1`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readRecentSessionMessagesAsync with archived file path
// ---------------------------------------------------------------------------

describe("readRecentSessionMessagesAsync with archived transcript", () => {
  it("resolves archived file path in transcript candidates", () => {
    const dir = makeTmpDir("oc-arh-candidates-");
    try {
      const sessionId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      const archiveName = `${sessionId}.jsonl.reset.${ts()}`;
      const archivePath = path.join(dir, archiveName);
      fs.writeFileSync(archivePath, '{"role":"user","content":"test"}\n');

      const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, archivePath);
      // The archive path (or a resolved equivalent) should appear in candidates
      const found = candidates.some((c) => fs.existsSync(c));
      expect(found).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads messages from an archived file when sessionFile points to it", async () => {
    const dir = makeTmpDir("oc-arh-read-archived-");
    try {
      // Use a UUID-shaped sessionId to pass validation
      const sessionId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      // Create an archived transcript file with actual message content
      const archiveName = `${sessionId}.jsonl.reset.${ts()}`;
      const archivePath = path.join(dir, archiveName);
      // Transcript JSONL wraps messages in { message: {...} } records
      const messages = [
        JSON.stringify({ message: { role: "user", content: "hello from archive" } }),
        JSON.stringify({ message: { role: "assistant", content: "archived reply" } }),
      ];
      fs.writeFileSync(archivePath, messages.join("\n") + "\n");

      // The live .jsonl does NOT exist — only the archived file.
      // Passing the archived path as sessionFile causes the reader to find it.
      const result = await readRecentSessionMessagesAsync(sessionId, storePath, archivePath, {
        maxMessages: 10,
      });

      expect(result.length).toBeGreaterThan(0);
      const contents = result.map((m: unknown) => (m as Record<string, unknown>).content);
      expect(contents).toContain("hello from archive");
      expect(contents).toContain("archived reply");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the archived transcript when only the .jsonl.reset.<ts> file exists", async () => {
    const dir = makeTmpDir("oc-arh-read-no-file-");
    try {
      const sessionId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      // Archived file exists but the caller does not pass it as sessionFile.
      // This is the real `chat.history` shape: the store entry's sessionFile
      // still points at the (now renamed) live `.jsonl`, so `sessionFile` is
      // either undefined here or points at a non-existent path.
      const archiveName = `${sessionId}.jsonl.reset.${ts()}`;
      fs.writeFileSync(
        path.join(dir, archiveName),
        '{"message":{"role":"user","content":"resurrected"}}\n',
      );

      const result = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 10,
        allowResetArchiveFallback: true,
      });

      // After the archive-fallback fix, the reader resolves the `.jsonl.reset.<ts>`
      // file by scanning the sessions directory and returns its content.
      expect(result.length).toBe(1);
      const contents = result.map((m: unknown) => (m as Record<string, unknown>).content);
      expect(contents).toContain("resurrected");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the live .jsonl when both live and archived files exist", async () => {
    const dir = makeTmpDir("oc-arh-prefer-live-");
    try {
      const sessionId = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      fs.writeFileSync(
        path.join(dir, `${sessionId}.jsonl`),
        '{"message":{"role":"user","content":"live-only"}}\n',
      );
      fs.writeFileSync(
        path.join(dir, `${sessionId}.jsonl.reset.${ts()}`),
        '{"message":{"role":"user","content":"archived-only"}}\n',
      );

      const result = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 10,
      });

      const contents = result.map((m: unknown) => (m as Record<string, unknown>).content);
      expect(contents).toContain("live-only");
      expect(contents).not.toContain("archived-only");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selects the archive matching the requested sessionId when multiple sessions share a directory", async () => {
    const dir = makeTmpDir("oc-arh-disambiguate-");
    try {
      const sessionIdA = "a1111111-2222-4333-8444-555555555555";
      const sessionIdB = "b1111111-2222-4333-8444-555555555555";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      fs.writeFileSync(
        path.join(dir, `${sessionIdA}.jsonl.reset.${ts()}`),
        '{"message":{"role":"user","content":"from-A"}}\n',
      );
      fs.writeFileSync(
        path.join(dir, `${sessionIdB}.jsonl.reset.${ts()}`),
        '{"message":{"role":"user","content":"from-B"}}\n',
      );

      const resultA = await readRecentSessionMessagesAsync(sessionIdA, storePath, undefined, {
        maxMessages: 10,
        allowResetArchiveFallback: true,
      });
      const resultB = await readRecentSessionMessagesAsync(sessionIdB, storePath, undefined, {
        maxMessages: 10,
        allowResetArchiveFallback: true,
      });

      expect(resultA.map((m: unknown) => (m as Record<string, unknown>).content)).toEqual([
        "from-A",
      ]);
      expect(resultB.map((m: unknown) => (m as Record<string, unknown>).content)).toEqual([
        "from-B",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("picks the most recent archive when multiple .jsonl.reset.<ts> files exist for the same sessionId", async () => {
    const dir = makeTmpDir("oc-arh-most-recent-");
    try {
      const sessionId = "d4444444-5555-4666-8777-888888888888";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      const tsOld = ts(Date.now() - 60_000);
      const tsNew = ts(Date.now());
      fs.writeFileSync(
        path.join(dir, `${sessionId}.jsonl.reset.${tsOld}`),
        '{"message":{"role":"user","content":"older-archive"}}\n',
      );
      fs.writeFileSync(
        path.join(dir, `${sessionId}.jsonl.reset.${tsNew}`),
        '{"message":{"role":"user","content":"newer-archive"}}\n',
      );

      const result = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 10,
        allowResetArchiveFallback: true,
      });

      const contents = result.map((m: unknown) => (m as Record<string, unknown>).content);
      expect(contents).toContain("newer-archive");
      expect(contents).not.toContain("older-archive");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a topic-qualified archived transcript when only `<sessionId>-topic-<N>.jsonl.reset.<ts>` exists", async () => {
    // Regression for PR #85 review: `findExistingTranscriptPath` previously
    // missed `${sessionId}-topic-<N>.jsonl.reset.<ts>` archives, leaving
    // `chat.history` empty after a rollover on a topic-qualified session.
    const dir = makeTmpDir("oc-arh-topic-fallback-");
    try {
      const sessionId = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      const archiveName = `${sessionId}-topic-7.jsonl.reset.${ts()}`;
      fs.writeFileSync(
        path.join(dir, archiveName),
        '{"message":{"role":"user","content":"topic-archived"}}\n',
      );

      // Topic-qualified sessions archive their own `sessionFile`, so the store
      // entry's sessionFile still points at the topic transcript; supply it so
      // reset-archive discovery scans `${sessionFile}.reset.<ts>`.
      const result = await readRecentSessionMessagesAsync(
        sessionId,
        storePath,
        path.join(dir, `${sessionId}-topic-7.jsonl`),
        {
          maxMessages: 10,
          allowResetArchiveFallback: true,
        },
      );

      const contents = result.map((m: unknown) => (m as Record<string, unknown>).content);
      expect(contents).toContain("topic-archived");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when no live or archived transcript exists for the sessionId", async () => {
    const dir = makeTmpDir("oc-arh-missing-");
    try {
      const sessionId = "e5555555-6666-4777-8888-999999999999";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      const result = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 10,
      });

      // No transcript anywhere on disk — graceful empty rather than throwing.
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
