/**
 * Unit tests for skillVersion and triggerSummary fields on the skill.used diagnostic event.
 * DEV-318: https://linear.app/brightfire/issue/DEV-318
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticSkillUsedEvent,
} from "../infra/diagnostic-events.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(actual.getGlobalHookRunner),
  };
});

beforeEach(() => {
  resetDiagnosticEventsForTest();
});
afterEach(() => {
  resetDiagnosticEventsForTest();
});

async function collectSkillUsedEvents(
  run: () => Promise<void>,
): Promise<DiagnosticSkillUsedEvent[]> {
  const events: DiagnosticSkillUsedEvent[] = [];
  const stop = onInternalDiagnosticEvent((evt) => {
    if (evt.type === "skill.used") {
      events.push(evt as DiagnosticSkillUsedEvent);
    }
  });
  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  try {
    await run();
    await flush();
  } finally {
    stop();
  }
  return events;
}

describe("skill.used diagnostic event — skillVersion field", () => {
  it("includes skillVersion when the matched skill has a promptVersion (read activation)", async () => {
    const workspaceDir = "/tmp/openclaw-skill-version-read";
    const skillBaseDir = path.join(workspaceDir, ".agents", "skills", "versioned-skill");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");

    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "versioned-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "versioned-skill",
            description: "A skill with a version",
            filePath: skillFilePath,
            baseDir: skillBaseDir,
            source: "workspace",
            promptVersion: "sha256:abc123def456",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    const events = await collectSkillUsedEvents(() =>
      tool.execute(
        "call-1",
        { path: path.join(".agents", "skills", "versioned-skill", "SKILL.md") },
        undefined,
        undefined,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0].skillVersion).toBe("sha256:abc123def456");
    expect(events[0].activation).toBe("read");
  });

  it("omits skillVersion when the matched skill has no promptVersion (read activation)", async () => {
    const workspaceDir = "/tmp/openclaw-skill-version-unversioned";
    const skillBaseDir = path.join(workspaceDir, ".agents", "skills", "unversioned-skill");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");

    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "unversioned-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "unversioned-skill",
            description: "A skill without a version",
            filePath: skillFilePath,
            baseDir: skillBaseDir,
            source: "workspace",
            // no promptVersion
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    const events = await collectSkillUsedEvents(() =>
      tool.execute(
        "call-2",
        { path: path.join(".agents", "skills", "unversioned-skill", "SKILL.md") },
        undefined,
        undefined,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0].skillVersion).toBeUndefined();
    expect(events[0].activation).toBe("read");
  });

  it("includes skillVersion for command activation when the skill is in the snapshot", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "my_tool", execute } as any, {
      agentId: "main",
      skillCommand: {
        commandName: "launch_sequence",
        skillName: "versioned-cmd-skill",
        skillSource: "workspace",
        toolName: "my_tool",
      },
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "versioned-cmd-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "versioned-cmd-skill",
            description: "Command skill with version",
            filePath: "/skills/versioned-cmd-skill/SKILL.md",
            baseDir: "/skills/versioned-cmd-skill",
            source: "workspace",
            promptVersion: "sha256:deadbeef0000",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    const events = await collectSkillUsedEvents(() =>
      tool.execute("call-3", {}, undefined, undefined),
    );

    expect(events).toHaveLength(1);
    expect(events[0].skillVersion).toBe("sha256:deadbeef0000");
    expect(events[0].activation).toBe("command");
  });

  it("omits skillVersion for command activation when the skill is not in the snapshot", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "my_tool", execute } as any, {
      agentId: "main",
      skillCommand: {
        commandName: "do_thing",
        skillName: "no-snapshot-skill",
        skillSource: "workspace",
        toolName: "my_tool",
      },
      // no skillsSnapshot — version lookup falls back gracefully
      loopDetection: { enabled: false },
    });

    const events = await collectSkillUsedEvents(() =>
      tool.execute("call-4", {}, undefined, undefined),
    );

    expect(events).toHaveLength(1);
    expect(events[0].skillVersion).toBeUndefined();
    expect(events[0].activation).toBe("command");
  });
});

describe("skill.used diagnostic event — triggerSummary field", () => {
  it("populates triggerSummary with the commandName for command activation", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "my_tool", execute } as any, {
      skillCommand: {
        commandName: "run_audit",
        skillName: "audit-skill",
        skillSource: "workspace",
        toolName: "my_tool",
      },
      loopDetection: { enabled: false },
    });

    const events = await collectSkillUsedEvents(() =>
      tool.execute("call-5", {}, undefined, undefined),
    );

    expect(events).toHaveLength(1);
    expect(events[0].triggerSummary).toBe("run_audit");
  });

  it("truncates triggerSummary at 200 chars when commandName exceeds the limit", async () => {
    const longCommandName = "x".repeat(250);
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "my_tool", execute } as any, {
      skillCommand: {
        commandName: longCommandName,
        skillName: "long-name-skill",
        skillSource: "workspace",
        toolName: "my_tool",
      },
      loopDetection: { enabled: false },
    });

    const events = await collectSkillUsedEvents(() =>
      tool.execute("call-6", {}, undefined, undefined),
    );

    expect(events).toHaveLength(1);
    const summary = events[0].triggerSummary;
    expect(summary).toBeDefined();
    expect(summary!.length).toBe(200);
    expect(summary).toBe("x".repeat(200));
  });

  it("omits triggerSummary for read activation (path is PII-sensitive)", async () => {
    const workspaceDir = "/tmp/openclaw-skill-trigger-read";
    const skillBaseDir = path.join(workspaceDir, ".agents", "skills", "pii-check-skill");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");

    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "pii-check-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "pii-check-skill",
            description: "Skill for PII check",
            filePath: skillFilePath,
            baseDir: skillBaseDir,
            source: "workspace",
            promptVersion: "sha256:aabbccdd",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    const events = await collectSkillUsedEvents(() =>
      tool.execute(
        "call-7",
        { path: path.join(".agents", "skills", "pii-check-skill", "SKILL.md") },
        undefined,
        undefined,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0].triggerSummary).toBeUndefined();
    // Confirm path and workspace dir are not leaked into the event
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("SKILL.md");
    expect(serialized).not.toContain(workspaceDir);
  });

  it("omits triggerSummary when commandName is absent", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "my_tool", execute } as any, {
      skillCommand: {
        // commandName intentionally absent
        commandName: "",
        skillName: "no-command-skill",
        skillSource: "workspace",
        toolName: "my_tool",
      },
      loopDetection: { enabled: false },
    });

    const events = await collectSkillUsedEvents(() =>
      tool.execute("call-8", {}, undefined, undefined),
    );

    expect(events).toHaveLength(1);
    expect(events[0].triggerSummary).toBeUndefined();
  });
});
