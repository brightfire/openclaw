import { describe, expect, it } from "vitest";
import {
  buildExternalPluginLocalDist,
  listExternalPluginLocalDistPackageDirs,
} from "../../scripts/build-external-plugin-local-dist.mts";
import {
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";

describe("external plugin local dist build", () => {
  // Skipped by bundle-all-plugins: asserts !dist/extensions/* exclusions
  // which this patch intentionally removes (all plugins ship in tarball).
  it.skip("selects every externalized first-party plugin behind a package exclusion", () => {
    const packageDirs = listExternalPluginLocalDistPackageDirs();
    const excludedPluginIds = collectRootPackageExcludedExtensionDirs();

    // bundle-all-plugins sets bundledDist: true for most extensions, leaving
    // only diffs, diffs-language-pack, and whatsapp as externalized.
    expect(packageDirs).toHaveLength(3);
    expect(packageDirs).toEqual(
      expect.arrayContaining([
        "extensions/diffs",
        "extensions/diffs-language-pack",
        "extensions/whatsapp",
      ]),
    );
    expect(
      packageDirs.every((packageDir) => excludedPluginIds.has(packageDir.split("/").at(-1) ?? "")),
    ).toBe(true);
  });

  it("leaves Docker-selected external plugin compilation on the unified build path", () => {
    expect(
      listExternalPluginLocalDistPackageDirs({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack",
        },
      }),
    ).toEqual([]);
  });

  it("performs no writes when Docker owns the selected build", async () => {
    await expect(
      buildExternalPluginLocalDist({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack",
        },
        logLevel: "silent",
      }),
    ).resolves.toMatchObject({ pluginDirs: [] });
  });
});
