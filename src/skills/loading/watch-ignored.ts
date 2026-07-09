// Shared ignore rules for skill directory traversal and file-system watching.
// Both the version hasher (skill-version.ts) and the skills watcher (runtime/refresh.ts)
// must exclude the same set of paths so that a file change either both affects the hash
// AND triggers a watcher refresh, or neither. Keeping this list in one place prevents
// the two surfaces from drifting out of sync.

/**
 * Regex patterns for paths that should be excluded from skill discovery, version
 * hashing, and file-system watching. Matches directory or file segments anywhere in a
 * path (platform-independent, handles both `/` and `\` separators).
 */
export const SKILLS_IGNORED_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Build artifacts and generated output
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  // Python virtual environments and caches
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
];

/**
 * Maximum directory depth the skills watcher observes below a grouped-skills root
 * (i.e. a directory named "skills"). Used by both the watcher and the version hasher
 * so the hash surface never covers files deeper than chokidar can detect a change to.
 */
export const SKILL_VERSION_MAX_DEPTH = 6;

/**
 * Maximum directory depth the skills watcher observes below a configured-root extraDir
 * that is NOT a grouped-skills root (i.e. not named "skills"). Must stay equal to
 * `CONFIGURED_ROOT_WATCH_DEPTH` in `src/skills/runtime/refresh.ts`.
 */
export const SKILL_VERSION_CONFIGURED_ROOT_MAX_DEPTH = 2;

/**
 * Monotonic schema version for the skill-snapshot hash algorithm. Increment this
 * whenever the content or semantics of `computeSkillPromptVersion` change in a way
 * that makes old `<version>` strings incomparable to new ones. A persisted snapshot
 * carrying a different `hashSchemaVersion` is always rebuilt rather than reused.
 *
 * History:
 *   1 — directory-wide support-file hash (PR #136). Replaces SKILL.md-only hashing.
 */
export const SKILL_HASH_SCHEMA_VERSION = 1;

/**
 * Gitignore-style patterns derived from SKILLS_IGNORED_PATH_PATTERNS for use with the
 * `ignore` npm package. Each entry matches the corresponding segment at any depth.
 */
// These patterns must remain a strict subset of SKILLS_IGNORED_PATH_PATTERNS above.
// Do NOT use catch-all dotfile patterns (e.g. ".*") here: the skills watcher only
// excludes the specific directories listed above, so a catch-all would drop legitimate
// dot-prefixed support files (e.g. `.env.example`, `.config/template.json`) from the
// hash while still delivering watcher refresh events for them — producing a stale
// `<version>` that never changes even though the agent should re-read the skill.
export const SKILLS_IGNORED_IGNORE_PATTERNS: string[] = [
  // Explicit dot-directory excludes matching SKILLS_IGNORED_PATH_PATTERNS:
  ".git/",
  ".cache/",
  ".venv/",
  ".mypy_cache/",
  ".pytest_cache/",
  // Non-dot excludes:
  "node_modules/",
  "dist/",
  "build/",
  "venv/",
  "__pycache__/",
];
