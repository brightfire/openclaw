#!/usr/bin/env node

// Temporarily narrows CHANGELOG.md to packaged release notes for npm tarballs.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG_PATH = "CHANGELOG.md";
const PACKAGE_JSON_PATH = "package.json";
const BACKUP_PATH = path.join(".artifacts", "package-changelog", "CHANGELOG.md.prepack-backup");
const MAX_PACKAGED_CHANGELOG_BYTES = 500 * 1024;
const MIN_RELEASE_SECTION_BODY_BYTES = 32;
const UNRELEASED_HEADING = "Unreleased";
const RELEASE_HEADING_PATTERN =
  /^##\s+([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:(?:-(?:alpha|beta)\.[1-9][0-9]*)|(?:-[1-9][0-9]*))?)(?:\s+.*)?$/u;
const RELEASE_VERSION_PATTERN =
  /^([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*)(?:(?:-(?:alpha|beta)\.[1-9][0-9]*)|(?:-[1-9][0-9]*))?$/u;
const PRERELEASE_VERSION_PATTERN =
  /^([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*)-(?:alpha|beta)\.[1-9][0-9]*$/u;

/**
 * Resolves acceptable changelog headings for a package version.
 */
export function resolvePackageChangelogVersions(packageVersion) {
  const match = RELEASE_VERSION_PATTERN.exec(packageVersion);
  if (!match) {
    throw new Error(
      `Unsupported OpenClaw package version for changelog packaging: ${packageVersion}`,
    );
  }
  if (PRERELEASE_VERSION_PATTERN.test(packageVersion)) {
    // Alpha/beta prerelease: accept the exact version, the base version, or Unreleased.
    return [packageVersion, match[1], UNRELEASED_HEADING];
  }
  if (packageVersion !== match[1]) {
    // Brightfire numeric-suffix build (e.g. 2026.6.8-1): accept the exact
    // version or the upstream base version. The upstream changelog entry
    // covers this build — no separate entry is needed.
    return [packageVersion, match[1]];
  }
  return [packageVersion];
}

function splitLines(content) {
  return content.replace(/^\uFEFF/u, "").split(/\r?\n/u);
}

function parseLevelTwoHeading(line) {
  const releaseMatch = RELEASE_HEADING_PATTERN.exec(line);
  if (releaseMatch) {
    return releaseMatch[1];
  }
  return /^##\s+Unreleased(?:\s+.*)?$/u.test(line) ? UNRELEASED_HEADING : null;
}

function findLevelTwoHeadings(lines) {
  return lines.flatMap((line, index) => {
    const version = parseLevelTwoHeading(line);
    return version ? [{ index, version }] : [];
  });
}

function extractPreamble(lines, firstHeadingIndex) {
  return lines.slice(0, firstHeadingIndex).join("\n").trimEnd();
}

/**
 * Extracts the current release changelog section for package publishing.
 */
export function extractCurrentPackageChangelog(content, packageVersion) {
  const targetVersions = resolvePackageChangelogVersions(packageVersion);
  const lines = splitLines(content);
  const headings = findLevelTwoHeadings(lines);
  const heading = targetVersions
    .map((version) => headings.find((entry) => entry.version === version))
    .find((entry) => entry !== undefined);
  if (!heading) {
    throw new Error(
      `CHANGELOG.md does not contain a release section for ${targetVersions.join(" or ")}.`,
    );
  }
  const nextHeading = headings.find((entry) => entry.index > heading.index);
  const firstLevelTwoHeadingIndex = lines.findIndex((line) => line.startsWith("## "));
  const preamble = extractPreamble(lines, firstLevelTwoHeadingIndex);
  const releaseSection = lines
    .slice(heading.index, nextHeading?.index ?? lines.length)
