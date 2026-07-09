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

// Support files larger than this are included in the hash via filename + size only,
// not their full contents, to avoid buffering large assets (images, archives, etc.)
// on every skill load. SKILL.md itself is always small (bounded by maxSkillFileBytes).
const MAX_CONTENT_HASH_BYTES = 512 * 1024; // 512 KiB

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

function walkFiles(
  dir: string,
  rootDir: string,
  ig: IgnoreMatcher,
  // Tracks real paths of visited directories to prevent infinite recursion through
  // symlink cycles (e.g. a support symlink pointing at the skill root or an ancestor).
  visited: Set<string> = new Set(),
  // Real path of the skill root; symlinked directories resolving outside this boundary
  // are skipped so that `assets -> ..` or similar cannot pull in unrelated workspace files.
  rootRealPath = "",
): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable support directory (permissions, race, etc.) — skip rather than aborting
    // the entire skill load. Matches the same tolerance used for file reads below.
    return results;
  }
  for (const entry of entries) {
    const rel = path.relative(rootDir, path.join(dir, entry.name));
    const relPosix = rel.split(path.sep).join("/");
    const checkPath = entry.isDirectory() ? `${relPosix}/` : relPosix;
    if (ig.ignores(checkPath)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // Follow symlinks so that symlinked SKILL.md or support files are included.
      // Matches the same resolution used in loadSkillsFromDirInternal (session.ts).
      try {
        const stats = fs.statSync(full);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        // Broken symlink — skip.
        continue;
      }
    }
    if (isDirectory) {
      // Resolve the real path before recursing so symlink cycles are detected.
      let realFull: string;
      try {
        realFull = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (visited.has(realFull)) {
        continue;
      }
      // Reject symlinks that escape the skill root (e.g. `assets -> ..`).
      // rootRealPath is empty only for non-symlink subdirs of the root itself, which
      // are fine to recurse into unconditionally.
      if (
        rootRealPath &&
        realFull !== rootRealPath &&
        !realFull.startsWith(rootRealPath + path.sep)
      ) {
        continue;
      }
      visited.add(realFull);
      results.push(...walkFiles(full, rootDir, ig, visited, rootRealPath));
    } else if (isFile) {
      // For symlinked files, apply the same root boundary as symlinked directories
      // so that `assets/secret -> /path/outside/root` cannot be read during hashing.
      if (entry.isSymbolicLink() && rootRealPath) {
        let realFull: string;
        try {
          realFull = fs.realpathSync(full);
        } catch {
          continue;
        }
        if (realFull !== rootRealPath && !realFull.startsWith(rootRealPath + path.sep)) {
          continue;
        }
      }
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
  // Seed visited with the skill root's real path so a symlink directly back to the
  // root is caught before the first recursive descent.
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(skillDir);
  } catch {
    rootRealPath = path.resolve(skillDir);
  }
  const visited = new Set([rootRealPath]);
  // Normalize to POSIX separators before sorting and hashing so the version is
  // identical across OS (Windows path.relative() returns backslash-separated paths).
  const allFiles = walkFiles(skillDir, skillDir, ig, visited, rootRealPath)
    .map((f) => path.relative(skillDir, f).split(path.sep).join("/"))
    .toSorted();
  const hash = crypto.createHash("sha256");
  for (const rel of allFiles) {
    const absPath = path.join(skillDir, ...rel.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      // File disappeared between walkFiles() and here — skip.
      continue;
    }
    hash.update(rel);
    hash.update("\0");
    if (stat.size <= MAX_CONTENT_HASH_BYTES) {
      let content: Buffer;
      try {
        content = fs.readFileSync(absPath);
      } catch {
        // Became unreadable after stat — fall through to size-only contribution.
        hash.update(String(stat.size));
        hash.update("\0");
        continue;
      }
      hash.update(content);
    } else {
      // Large support file: contribute filename + size so presence/rename changes
      // the version without buffering the full asset into memory.
      hash.update(String(stat.size));
    }
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}
