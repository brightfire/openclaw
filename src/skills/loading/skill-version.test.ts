// Tests for computeSkillPromptVersion — verifies that the hash covers the full skill
// directory, not just SKILL.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSkillPromptVersion } from "./skill-version.js";

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-version-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function writeFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

describe("computeSkillPromptVersion", () => {
  it("returns a sha256: prefixed 16-char hex string", () => {
    const dir = makeTempDir();
    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Test skill\n---\n# Test\n");

    const version = computeSkillPromptVersion(dir);

    expect(version).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("is deterministic: same directory contents produce the same hash", () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();

    const content = "---\nname: test\ndescription: Test\n---\n# Test\n";
    writeFile(dir1, "SKILL.md", content);
    writeFile(dir2, "SKILL.md", content);

    expect(computeSkillPromptVersion(dir1)).toBe(computeSkillPromptVersion(dir2));
  });

  it("changes when SKILL.md content changes", () => {
    const dir = makeTempDir();
    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Test skill\n---\n# Test\n");
    const v1 = computeSkillPromptVersion(dir);

    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Updated skill\n---\n# Test\n");
    const v2 = computeSkillPromptVersion(dir);

    expect(v1).not.toBe(v2);
  });

  it("changes when a non-SKILL.md file is added to the directory", () => {
    const dir = makeTempDir();
    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Test skill\n---\n# Test\n");
    const v1 = computeSkillPromptVersion(dir);

    writeFile(dir, "assets/diagram.png", "fake-image-bytes");
    const v2 = computeSkillPromptVersion(dir);

    expect(v1).not.toBe(v2);
  });

  it("changes when a support file content changes", () => {
    const dir = makeTempDir();
    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Test skill\n---\n# Test\n");
    writeFile(dir, "examples/basic.md", "# Basic example\n");
    const v1 = computeSkillPromptVersion(dir);

    writeFile(dir, "examples/basic.md", "# Updated example\n");
    const v2 = computeSkillPromptVersion(dir);

    expect(v1).not.toBe(v2);
  });

  it("changes when a file is renamed, even if content is the same", () => {
    const dir = makeTempDir();
    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Test skill\n---\n# Test\n");
    writeFile(dir, "templates/old-name.md", "# Template content\n");
    const v1 = computeSkillPromptVersion(dir);

    fs.rmSync(path.join(dir, "templates", "old-name.md"));
    writeFile(dir, "templates/new-name.md", "# Template content\n");
    const v2 = computeSkillPromptVersion(dir);

    expect(v1).not.toBe(v2);
  });

  it("changes when a file is removed", () => {
    const dir = makeTempDir();
    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Test skill\n---\n# Test\n");
    writeFile(dir, "scripts/helper.sh", "#!/bin/bash\necho hello\n");
    const v1 = computeSkillPromptVersion(dir);

    fs.rmSync(path.join(dir, "scripts", "helper.sh"));
    const v2 = computeSkillPromptVersion(dir);

    expect(v1).not.toBe(v2);
  });

  it("handles a directory with only SKILL.md (no support files)", () => {
    const dir = makeTempDir();
    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Test skill\n---\n# Test\n");

    const version = computeSkillPromptVersion(dir);

    expect(version).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("covers nested support file trees recursively", () => {
    const dir = makeTempDir();
    writeFile(dir, "SKILL.md", "---\nname: test\ndescription: Test skill\n---\n# Test\n");
    writeFile(dir, "assets/images/logo.png", "png-bytes");
    writeFile(dir, "assets/images/banner.png", "png-bytes-2");
    writeFile(dir, "examples/advanced/step1.md", "step 1");
    const v1 = computeSkillPromptVersion(dir);

    writeFile(dir, "examples/advanced/step2.md", "step 2");
    const v2 = computeSkillPromptVersion(dir);

    expect(v1).not.toBe(v2);
  });

  it("produces the same hash regardless of filesystem readdir order (sort stability)", () => {
    // Write files in two directories with the same content but names that may sort
    // differently depending on insertion order.
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();

    const files = [
      ["SKILL.md", "---\nname: test\ndescription: Test skill\n---\n"],
      ["assets/z-file.md", "z content"],
      ["assets/a-file.md", "a content"],
      ["examples/b.md", "b content"],
    ] as const;

    for (const [rel, content] of files) {
      writeFile(dir1, rel, content);
    }
    // Write in reverse order to dir2 to test determinism against insertion order
    for (const [rel, content] of [...files].reverse()) {
      writeFile(dir2, rel, content);
    }

    expect(computeSkillPromptVersion(dir1)).toBe(computeSkillPromptVersion(dir2));
  });
});
