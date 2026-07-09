// Skill prompt versions are deterministic content markers for model-visible skill catalogs.
// The hash covers every file in the skill directory (paths + contents) so that adding,
// removing, or renaming support files (assets/, examples/, templates/, scripts/) changes
// the version even when SKILL.md itself is unchanged.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Directories excluded from the skill-version hash. These either contain
// generated/dependency files that are not part of the prompt contract, or are
// conventionally ignored by traversal tools.
const SKIP_DIRS = new Set(["node_modules", ".git", ".pnpm", ".yarn"]);

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Hash a single standalone skill file (not a SKILL.md directory root).
 * Used when skillPaths points directly at a .md file — hashing dirname would
 * incorrectly include every sibling file under the parent directory.
 */
export function computeSkillFileVersion(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(path.basename(filePath));
  hash.update("\0");
  hash.update(fs.readFileSync(filePath));
  hash.update("\0");
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

export function computeSkillPromptVersion(skillDir: string): string {
  const allFiles = walkFiles(skillDir)
    .map((f) => path.relative(skillDir, f))
    .toSorted();
  const hash = crypto.createHash("sha256");
  for (const rel of allFiles) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(skillDir, rel)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}
