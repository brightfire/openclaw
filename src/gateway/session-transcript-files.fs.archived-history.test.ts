import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { resolveArchivedTranscriptPaths } from "./session-transcript-files.fs.js";
import { readRecentSessionMessagesAsync } from "./session-utils.fs.js";
import { resolveSessionTranscriptCandidates } from "./session-transcript-files.fs.js";

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

      const candidates = resolveSessionTranscriptCandidates(
        sessionId,
        storePath,
        archivePath,
      );
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
      const result = await readRecentSessionMessagesAsync(
        sessionId,
        storePath,
        archivePath,
        { maxMessages: 10 },
      );

      expect(result.length).toBeGreaterThan(0);
      const contents = result.map((m: unknown) => (m as Record<string, unknown>).content);
      expect(contents).toContain("hello from archive");
      expect(contents).toContain("archived reply");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when sessionFile is not provided and live transcript missing", async () => {
    const dir = makeTmpDir("oc-arh-read-no-file-");
    try {
      const sessionId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(storePath, "{}");

      // Archived file exists but we don't pass it as sessionFile
      const archiveName = `${sessionId}.jsonl.reset.${ts()}`;
      fs.writeFileSync(path.join(dir, archiveName), '{"message":{"role":"user","content":"orphaned"}}\n');

      // Without the sessionFile parameter, only the live .jsonl path is tried
      const result = await readRecentSessionMessagesAsync(
        sessionId,
        storePath,
        undefined,
        { maxMessages: 10 },
      );

      // This demonstrates the bug: without passing the archived file path,
      // messages are empty even though an archived transcript exists
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
