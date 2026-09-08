// Shared repo-level bundled plugin fixtures for the bundled metadata and
// activation tests. Exports are consumed by those test files only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect } from "vitest";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";
import { collectBundledChannelConfigsCore } from "./bundled-channel-config-metadata.js";
import {
  listBundledPluginMetadata,
  resolveBundledPluginGeneratedPath,
} from "./bundled-plugin-metadata.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";
import {
  getPackageManifestMetadata,
  loadPluginManifest,
  type PackageManifest,
} from "./manifest.js";

type BundledPluginMetadata = ReturnType<typeof listBundledPluginMetadata>[number];

export function expectTestOnlyArtifactsExcluded(artifacts: readonly string[]) {
  artifacts.forEach((artifact) => {
    expect(artifact).not.toMatch(/^test-/);
    expect(artifact).not.toContain(".test-");
    expect(artifact).not.toMatch(/\.test\.js$/);
  });
}

export function expectGeneratedPathResolution(tempRoot: string, expectedRelativePath: string) {
  expect(
    resolveBundledPluginGeneratedPath(
      tempRoot,
      {
        source: "./plugin/index.ts",
        built: "plugin/index.js",
      },
      undefined,
    ),
  ).toBe(path.join(tempRoot, expectedRelativePath));
}

export function expectPluginScopedGeneratedPathResolution(
  tempRoot: string,
  pluginDirName: string,
  expectedRelativePath: string,
) {
  expect(
    resolveBundledPluginGeneratedPath(
      tempRoot,
      {
        source: "./index.ts",
        built: "index.js",
      },
      pluginDirName,
    ),
  ).toBe(path.join(tempRoot, expectedRelativePath));
}

export function expectArtifactPresence(
  artifacts: readonly string[] | undefined,
  params: { contains?: readonly string[]; excludes?: readonly string[] },
) {
  if (params.contains) {
    for (const artifact of params.contains) {
      expect(artifacts).toContain(artifact);
    }
  }
  if (params.excludes) {
    for (const artifact of params.excludes) {
      expect(artifacts).not.toContain(artifact);
    }
  }
}

let repoBundledPluginMetadataCache: readonly BundledPluginMetadata[] | undefined;
let repoBundledPluginManifestsCache:
  | ReturnType<typeof listRepoBundledPluginManifestsUncached>
  | undefined;
const repoBundledChannelConfigsCache = new Map<
  string,
  ReturnType<typeof collectBundledChannelConfigsCore>
>();

export function listRepoBundledPluginMetadata(): readonly BundledPluginMetadata[] {
  repoBundledPluginMetadataCache ??= listBundledPluginMetadata({
    rootDir: repoRoot,
    includeSyntheticChannelConfigs: false,
  });
  return repoBundledPluginMetadataCache;
}

export function listRepoBundledPluginManifestsUncached() {
  const bundledPluginsDir = path.join(repoRoot, "extensions");
  return listRepoBundledPluginManifestDirs().flatMap((dirName) => {
    const result = loadPluginManifest(path.join(bundledPluginsDir, dirName), false);
    return result.ok ? [{ dirName, manifest: result.manifest }] : [];
  });
}

function listRepoBundledPluginManifestDirs(): string[] {
  const externalDirs = listExternalRepoBundledPluginManifestDirs();
  if (externalDirs) {
    return externalDirs;
  }
  const bundledPluginsDir = path.join(repoRoot, "extensions");
  return fs
    .readdirSync(bundledPluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function listExternalRepoBundledPluginManifestDirs(): string[] | null {
  const manifestFiles =
    listGitRepoBundledPluginManifestFiles() ?? listFindRepoBundledPluginManifestFiles();
  if (!manifestFiles) {
    return null;
  }
  return manifestFiles
    .flatMap((file) => {
      const match = /^extensions\/([^/]+)\/openclaw\.plugin\.json$/u.exec(file);
      return match?.[1] ? [match[1]] : [];
    })
    .toSorted();
}

function listGitRepoBundledPluginManifestFiles(): string[] | null {
  return listGitTrackedFiles({ repoRoot, pathspecs: "extensions/*/openclaw.plugin.json" });
}

function listFindRepoBundledPluginManifestFiles(): string[] | null {
  const result = spawnSync(
    "find",
    [
      path.join(repoRoot, "extensions"),
      "-maxdepth",
      "2",
      "-type",
      "f",
      "-name",
      "openclaw.plugin.json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => toRepoRelativePath(repoRoot, file))
    .toSorted();
}

export function listRepoBundledPluginManifests() {
  repoBundledPluginManifestsCache ??= listRepoBundledPluginManifestsUncached();
  return repoBundledPluginManifestsCache;
}

function readPackageManifest(pluginDir: string): PackageManifest | undefined {
  const packagePath = path.join(pluginDir, "package.json");
  return fs.existsSync(packagePath)
    ? (JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest)
    : undefined;
}

export function collectRootPackageExcludedExtensionDirsForTest(): readonly string[] {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    files?: unknown;
  };
  if (!Array.isArray(packageJson.files)) {
    return [];
  }
  return packageJson.files
    .flatMap((entry) => {
      if (typeof entry !== "string") {
        return [];
      }
      const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
      return match?.[1] ? [match[1]] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

export function collectRepoBundledChannelConfigsForTest(dirName: string) {
  const cached = repoBundledChannelConfigsCache.get(dirName);
  if (cached) {
    return cached;
  }
  const pluginDir = path.join(repoRoot, "extensions", dirName);
  const manifest = loadPluginManifest(pluginDir, false);
  if (!manifest.ok) {
    throw toLintErrorObject(manifest.error, "Non-Error thrown");
  }
  const configs = collectBundledChannelConfigsCore({
    pluginDir,
    manifest: manifest.manifest,
    packageManifest: getPackageManifestMetadata(readPackageManifest(pluginDir)),
  });
  repoBundledChannelConfigsCache.set(dirName, configs);
  return configs;
}
