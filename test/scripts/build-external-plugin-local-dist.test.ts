import { describe, expect, it } from "vitest";
import {
  buildExternalPluginLocalDist,
  listExternalPluginLocalDistPackageDirs,
} from "../../scripts/build-external-plugin-local-dist.mts";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "../../scripts/lib/bundled-plugin-build-entries.mjs";

describe("external plugin local dist build", () => {
  it("selects every externalized first-party plugin behind a package exclusion", () => {
    const packageDirs = listExternalPluginLocalDistPackageDirs();

    // All plugins are bundled into the core tarball (bundledDist: true), so none
    // are externalized for separate local dist builds.
    expect(packageDirs).toHaveLength(0);
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
