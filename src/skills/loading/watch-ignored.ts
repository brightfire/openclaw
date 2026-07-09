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
 * Maximum directory depth the skills watcher observes below a skill root.
 * `walkFiles` in skill-version.ts uses this as a recursion cap so the version hash
 * never covers files deeper than what the watcher can detect a change to.
 */
export const SKILL_VERSION_MAX_DEPTH = 6;

/**
 * Gitignore-style patterns derived from SKILLS_IGNORED_PATH_PATTERNS for use with the
 * `ignore` npm package. Each entry matches the corresponding segment at any depth.
 */
export const SKILLS_IGNORED_IGNORE_PATTERNS: string[] = [
  ".*",
  "node_modules/",
  "dist/",
  "build/",
  "venv/",
  "__pycache__/",
];
