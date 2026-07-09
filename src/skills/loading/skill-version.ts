// Skill prompt versions are deterministic content markers for model-visible skill catalogs.
// The hash covers every file in the skill directory (paths + contents) so that adding,
// removing, or renaming support files (assets/, examples/, templates/, scripts/) changes
// the version even when SKILL.md itself is unchanged.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

// The same ignore-file names respected by the skill-discovery traversal in session.ts.
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function buildIgnoreMatcher(rootDir: string): IgnoreMatcher {
  const ig = ignore();
  // Always skip hidden entries and dependency trees, matching the discovery rules in
  // loadSkillsFromDirInternal (session.ts). These are unconditional because no skill
  // root should version-hash its own node_modules or .git internals.
  ig.add([".*", "node_modules/"]);
  for (const name of IGNORE_FILE_NAMES) {
    const filePath = path.join(rootDir, name);
    try {
      ig.add(fs.readFileSync(filePath, "utf-8"));
    } catch {
      // File absent — skip.
    }
  }
  return ig;
}

function walkFiles(dir: string, rootDir: string, ig: IgnoreMatcher): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(rootDir, path.join(dir, entry.name));
    const relPosix = rel.split(path.sep).join("/");
    const checkPath = entry.isDirectory() ? `${relPosix}/` : relPosix;
    if (ig.ignores(checkPath)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, rootDir, ig));
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
  const ig = buildIgnoreMatcher(skillDir);
  const allFiles = walkFiles(skillDir, skillDir, ig)
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
