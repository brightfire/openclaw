// Skill prompt versions are deterministic content markers for model-visible skill catalogs.
// The hash covers every file in the skill directory (paths + contents) so that adding,
// removing, or renaming support files (assets/, examples/, templates/, scripts/) changes
// the version even when SKILL.md itself is unchanged.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export function computeSkillPromptVersion(skillDir: string): string {
  const allFiles = walkFiles(skillDir)
    .map((f) => path.relative(skillDir, f))
    .sort();
  const hash = crypto.createHash("sha256");
  for (const rel of allFiles) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(skillDir, rel)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}
