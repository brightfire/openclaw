// Skill prompt versions are deterministic content markers for model-visible skill catalogs.
// The hash covers every file in the skill directory (paths + contents) so that adding,
// removing, or renaming support files (assets/, examples/, templates/, scripts/) changes
// the version even when SKILL.md itself is unchanged.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { SKILL_VERSION_MAX_DEPTH, SKILLS_IGNORED_IGNORE_PATTERNS } from "./watch-ignored.js";

// The same ignore-file names respected by the skill-discovery traversal in session.ts.
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

// Chunk size for streaming large support files into the hash. Keeps peak allocation
// bounded regardless of individual file size while preserving content accuracy.
const HASH_CHUNK_BYTES = 64 * 1024; // 64 KiB

/**
 * Stream a file into `hash` in fixed-size chunks so that large assets are content-hashed
 * without buffering the whole file into memory. Returns false if the file was unreadable.
 */
function hashFileStreamed(hash: crypto.Hash, absPath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(absPath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buf, 0, HASH_CHUNK_BYTES, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

type IgnoreMatcher = ReturnType<typeof ignore>;

function buildIgnoreMatcher(rootDir: string): IgnoreMatcher {
  const ig = ignore();
  // Load user ignore files first so the hard excludes added below always win.
  // The `ignore` library applies rules in order with later rules taking precedence;
  // adding SKILLS_IGNORED_IGNORE_PATTERNS last ensures a `.gitignore` with a negating
  // `!node_modules/` or `!.cache/` cannot re-include those paths.
  for (const name of IGNORE_FILE_NAMES) {
    const filePath = path.join(rootDir, name);
    try {
      ig.add(fs.readFileSync(filePath, "utf-8"));
    } catch {
      // File absent — skip.
    }
  }
  // Hard excludes applied after user rules so they cannot be negated.
  ig.add(SKILLS_IGNORED_IGNORE_PATTERNS);
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
  // Remaining recursion depth. Capped at SKILL_VERSION_MAX_DEPTH so the hash surface
  // stays aligned with the watcher's bounded depth — files deeper than the watcher
  // can observe would be hashed but never trigger a refresh on change.
  depth = SKILL_VERSION_MAX_DEPTH,
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
      if (depth <= 0) {
        continue;
      }
      results.push(...walkFiles(full, rootDir, ig, visited, rootRealPath, depth - 1));
    } else if (isFile) {
      // Apply out-of-root boundary to all symlinked files, with one narrow exception:
      // a symlinked SKILL.md directly in the skill root may point at a shared instruction
      // file outside the root (loadSkillsFromDirInternal follows and accepts it, so the
      // version hash must cover it). Every other symlinked file — including other root-level
      // ones — must resolve inside the root to prevent credential/config file reads.
      const isSkillMdRoot = dir === rootDir && entry.name === "SKILL.md";
      if (entry.isSymbolicLink() && rootRealPath && !isSkillMdRoot) {
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

export function computeSkillPromptVersion(
  skillDir: string,
  /**
   * Max directory depth to walk below `skillDir`. Defaults to `SKILL_VERSION_MAX_DEPTH`.
   * Callers that know the remaining watched depth (e.g. the skill is 2 levels below the
   * skills root, leaving GROUPED_SKILLS_WATCH_DEPTH - 2 observable levels inside it)
   * should pass a tighter value so the hash surface never exceeds what the watcher sees.
   */
  maxDepth = SKILL_VERSION_MAX_DEPTH,
): string {
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
  const allFiles = walkFiles(skillDir, skillDir, ig, visited, rootRealPath, maxDepth)
    .map((f) => path.relative(skillDir, f).split(path.sep).join("/"))
    .toSorted();
  const hash = crypto.createHash("sha256");
  for (const rel of allFiles) {
    const absPath = path.join(skillDir, ...rel.split("/"));
    hash.update(rel);
    hash.update("\0");
    // Stream the file content in chunks so peak memory is bounded by HASH_CHUNK_BYTES
    // regardless of file size, while still detecting content changes in large assets.
    if (!hashFileStreamed(hash, absPath)) {
      // File became unreadable after stat (TOCTOU race) — skip this file entirely so
      // a transient unreadable asset does not abort the whole skill-version computation.
      continue;
    }
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}
