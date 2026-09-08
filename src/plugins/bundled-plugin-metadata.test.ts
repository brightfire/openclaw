// Verifies bundled plugin metadata generation and import boundaries.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import {
  listBundledPluginMetadata,
  resolveBundledPluginGeneratedPath,
} from "./bundled-plugin-metadata.js";
import {
  collectRepoBundledChannelConfigsForTest,
  collectRootPackageExcludedExtensionDirsForTest,
  expectArtifactPresence,
  expectGeneratedPathResolution,
  expectPluginScopedGeneratedPathResolution,
  expectTestOnlyArtifactsExcluded,
  listRepoBundledPluginManifestsUncached,
  listRepoBundledPluginMetadata,
} from "./bundled-plugin-metadata.test-support.js";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
  pluginTestRepoRoot as repoRoot,
  writeJson,
} from "./generated-plugin-test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { writeBundledRuntimeSidecarPathBaseline } from "./runtime-sidecar-paths-baseline.js";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "./runtime-sidecar-paths.js";

const BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS = 300_000;

installGeneratedPluginTempRootCleanup();

describe("bundled plugin metadata", () => {
  beforeAll(() => {
    listRepoBundledPluginMetadata();
    collectRepoBundledChannelConfigsForTest("discord");
    collectRepoBundledChannelConfigsForTest("tlon");
  });

  it("lists bundled plugin manifests without scanning extension directories in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const manifests = listRepoBundledPluginManifestsUncached();

      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every((entry) => entry.dirName.length > 0)).toBe(true);
    });
  });

  it(
    "matches the runtime metadata snapshot",
    { timeout: BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS },
    () => {
      expect(listRepoBundledPluginMetadata()).toEqual(
        listBundledPluginMetadata({
          includeSyntheticChannelConfigs: false,
        }),
      );
    },
  );

  it(
    "matches the checked-in runtime sidecar path baseline",
    { timeout: BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS },
    async () => {
      await expect(
        writeBundledRuntimeSidecarPathBaseline({ repoRoot, check: true }),
      ).resolves.toMatchObject({ changed: false });
    },
  );

  it("excludes non-packaged QA sidecars from the packaged runtime sidecar baseline", () => {
    expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(
      "dist/extensions/qa-channel/runtime-api.js",
    );
    expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain("dist/extensions/qa-lab/runtime-api.js");
  });

  it("excludes root-package-excluded plugin sidecars from the packaged runtime sidecar baseline", () => {
    for (const pluginDir of collectRootPackageExcludedExtensionDirsForTest()) {
      expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(`dist/extensions/${pluginDir}/index.js`);
      expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(
        `dist/extensions/${pluginDir}/runtime-api.js`,
      );
      expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(
        `dist/extensions/${pluginDir}/runtime-setter-api.js`,
      );
    }
  });

  it("captures setup-entry metadata for bundled channel plugins", () => {
    const discord = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "discord");
    expect(discord?.source).toEqual({ source: "./index.ts", built: "index.js" });
    expect(discord?.setupSource).toEqual({ source: "./setup-entry.ts", built: "setup-entry.js" });
    expectArtifactPresence(discord?.publicSurfaceArtifacts, {
      contains: ["api.js", "runtime-api.js", "session-key-api.js"],
      excludes: ["test-api.js"],
    });
    expectArtifactPresence(discord?.runtimeSidecarArtifacts, {
      contains: ["runtime-api.js"],
    });
    expect(discord?.manifest.id).toBe("discord");
    const discordChannelConfig = collectRepoBundledChannelConfigsForTest("discord")?.discord as
      | { schema?: { type?: unknown } }
      | undefined;
    expect(discordChannelConfig?.schema?.type).toBe("object");
  });

  it("keeps Slack's doctor contract sidecar on the bundled public surface", () => {
    const slack = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "slack");
    expectArtifactPresence(slack?.publicSurfaceArtifacts, {
      contains: ["doctor-contract-api.js"],
    });
  });

  it("keeps Memory Core's health checks on a narrow public surface", () => {
    const memoryCore = listRepoBundledPluginMetadata().find(
      (entry) => entry.dirName === "memory-core",
    );
    expectArtifactPresence(memoryCore?.publicSurfaceArtifacts, {
      contains: ["doctor-health-api.js"],
    });
  });

  it("keeps iMessage message-tool discovery on a narrow public surface", () => {
    const imessage = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "imessage");
    expectArtifactPresence(imessage?.publicSurfaceArtifacts, {
      contains: ["message-tool-api.js"],
    });
  });

  it("keeps Slack's narrow runtime-setter sidecar on the bundled public surface", () => {
    // Regression for #69317: the bundled channel entry now points its
    // runtime.specifier at runtime-setter-api.js to avoid loading the full
    // runtime-api barrel during register(). The setter file must therefore
    // be discoverable as part of Slack's public surface.
    const slack = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "slack");
    expectArtifactPresence(slack?.publicSurfaceArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
  });

  it("keeps Telegram's narrow runtime setter on the bundled runtime sidecar surface", () => {
    const telegram = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "telegram");
    expectArtifactPresence(telegram?.publicSurfaceArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
    expectArtifactPresence(telegram?.runtimeSidecarArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
  });

  it("keeps Discord's narrow runtime setter on the bundled runtime sidecar surface", () => {
    const discord = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "discord");
    expectArtifactPresence(discord?.publicSurfaceArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
    expectArtifactPresence(discord?.runtimeSidecarArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
  });

  it("keeps QA runner discovery on narrow bundled runtime sidecars", () => {
    const runnerPlugins = listRepoBundledPluginMetadata().filter(
      (entry) => (entry.manifest.qaRunners?.length ?? 0) > 0,
    );
    expect(runnerPlugins.length).toBeGreaterThan(0);

    for (const plugin of runnerPlugins) {
      expectArtifactPresence(plugin?.publicSurfaceArtifacts, {
        contains: ["qa-runner-api.js"],
      });
      expectArtifactPresence(plugin?.runtimeSidecarArtifacts, {
        contains: ["qa-runner-api.js"],
      });
    }
  });

  it("loads tlon channel config metadata from the lightweight schema surface", () => {
    const tlonChannelConfig = collectRepoBundledChannelConfigsForTest("tlon")?.tlon as
      | { schema?: { type?: unknown } }
      | undefined;
    expect(tlonChannelConfig?.schema?.type).toBe("object");
  });

  it("keeps bundled persisted-auth metadata on channel package manifests", () => {
    const whatsapp = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "whatsapp");
    expect(whatsapp?.packageManifest?.channel?.persistedAuthState).toEqual({
      specifier: "./auth-presence",
      exportName: "hasAnyWhatsAppAuth",
    });

    const matrix = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "matrix");
    expect(matrix?.packageManifest?.channel?.persistedAuthState).toEqual({
      specifier: "./auth-presence",
      exportName: "hasAnyMatrixAuth",
    });
  });

  it("keeps Matrix's narrow runtime-setter sidecar on the bundled public surface", () => {
    const matrix = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "matrix");
    expectArtifactPresence(matrix?.publicSurfaceArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
  });

  it("keeps bundled configured-state env metadata on channel package manifests", () => {
    const configuredChannels = listRepoBundledPluginMetadata()
      .filter((entry) => ["discord", "irc", "slack", "telegram"].includes(entry.dirName))
      .map((entry) => ({
        dir: entry.dirName,
        configuredState: entry.packageManifest?.channel?.configuredState,
      }));
    expect(configuredChannels).toEqual([
      {
        dir: "discord",
        configuredState: {
          env: {
            anyOf: ["DISCORD_BOT_TOKEN"],
          },
        },
      },
      {
        dir: "irc",
        configuredState: {
          env: {
            allOf: ["IRC_HOST", "IRC_NICK"],
          },
        },
      },
      {
        dir: "slack",
        configuredState: {
          env: {
            anyOf: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
          },
          specifier: "./configured-state",
          exportName: "hasConfiguredSlackChannelState",
        },
      },
      {
        dir: "telegram",
        configuredState: {
          env: {
            anyOf: ["TELEGRAM_BOT_TOKEN"],
          },
        },
      },
    ]);
  });

  it("excludes test-only public surface artifacts", () => {
    listRepoBundledPluginMetadata().forEach((entry) =>
      expectTestOnlyArtifactsExcluded(entry.publicSurfaceArtifacts ?? []),
    );
  });

  it("keeps config schemas on all bundled plugin manifests", () => {
    for (const entry of listRepoBundledPluginMetadata()) {
      const { configSchema } = entry.manifest;
      if (configSchema === null) {
        throw new Error(`expected ${entry.manifest.id} config schema`);
      }
      expect(typeof configSchema).toBe("object");
      expect(Array.isArray(configSchema)).toBe(false);
    }
  });

  it("prefers built generated paths when present and falls back to source paths", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-metadata-");
    const pluginRoot = path.join(tempRoot, "extensions", "plugin");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "plugin");

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export {};\n", "utf8");
    expectGeneratedPathResolution(tempRoot, path.join("extensions", "plugin", "index.ts"));

    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(path.join(distPluginRoot, "index.js"), "export {};\n", "utf8");
    expectGeneratedPathResolution(tempRoot, path.join("dist", "extensions", "plugin", "index.js"));
  });

  it("uses dist-runtime generated paths before source fallback when packaged dist is absent", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-runtime-metadata-");
    const pluginRoot = path.join(tempRoot, "extensions", "plugin");
    const runtimePluginRoot = path.join(tempRoot, "dist-runtime", "extensions", "plugin");

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(runtimePluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(runtimePluginRoot, "index.js"), "export {};\n", "utf8");

    expectGeneratedPathResolution(
      tempRoot,
      path.join("dist-runtime", "extensions", "plugin", "index.js"),
    );
  });

  it("resolves plugin-local generated entry paths when the plugin dir is provided", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-metadata-local-");
    const pluginRoot = path.join(tempRoot, "extensions", "alpha");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "alpha");

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export {};\n", "utf8");
    expectPluginScopedGeneratedPathResolution(
      tempRoot,
      "alpha",
      path.join("extensions", "alpha", "index.ts"),
    );

    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(path.join(distPluginRoot, "index.js"), "export {};\n", "utf8");
    expectPluginScopedGeneratedPathResolution(
      tempRoot,
      "alpha",
      path.join("dist", "extensions", "alpha", "index.js"),
    );
  });

  it("keeps generated entry path resolution inside bundled plugin roots", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-path-contained-");
    const sourcePluginRoot = path.join(tempRoot, "extensions", "alpha");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "alpha");
    const absoluteEscape = path.join(tempRoot, "absolute.js");
    const absolutePluginEntry = path.join(sourcePluginRoot, "index.ts");

    fs.mkdirSync(sourcePluginRoot, { recursive: true });
    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(absolutePluginEntry, "export {};\n", "utf8");
    fs.writeFileSync(path.join(tempRoot, "extensions", "escape.ts"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(tempRoot, "dist", "extensions", "escape.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(absoluteEscape, "export {};\n", "utf8");

    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: absolutePluginEntry,
          built: absolutePluginEntry,
        },
        "alpha",
      ),
    ).toBe(absolutePluginEntry);
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: "../escape.ts",
          built: "../escape.js",
        },
        "alpha",
      ),
    ).toBeNull();
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: absoluteEscape,
          built: absoluteEscape,
        },
        "alpha",
      ),
    ).toBeNull();
  });

  it("scans direct plugin-tree overrides and resolves generated paths from that scan dir", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-direct-tree-");
    const pluginsDir = path.join(tempRoot, "bundled-plugins");
    const pluginRoot = path.join(pluginsDir, "alpha");

    writeJson(path.join(pluginRoot, "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
      },
    });
    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      channels: ["alpha"],
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export const source = true;\n", "utf8");
    expect(
      listBundledPluginMetadata({
        rootDir: tempRoot,
        scanDir: pluginsDir,
      }).map((entry) => entry.manifest.id),
    ).toEqual(["alpha"]);
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: "./index.ts",
          built: "index.js",
        },
        "alpha",
        pluginsDir,
      ),
    ).toBe(path.join(pluginRoot, "index.ts"));
  });

  it("reflects bundled manifest edits in the next lifecycle generation", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-fresh-");
    const pluginRoot = path.join(tempRoot, "extensions", "alpha");

    writeJson(path.join(pluginRoot, "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
      },
    });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export const source = true;\n", "utf8");
    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      name: "Before",
      configSchema: { type: "object" },
    });

    expect(listBundledPluginMetadata({ rootDir: tempRoot })[0]?.manifest.name).toBe("Before");

    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      name: "After",
      configSchema: { type: "object" },
    });
    clearPluginMetadataLifecycleCaches();

    expect(listBundledPluginMetadata({ rootDir: tempRoot })[0]?.manifest.name).toBe("After");
  });

  it("prefers direct scan-dir overrides over nested dist artifacts within the same override root", () => {
    const pluginsDir = createGeneratedPluginTempRoot("openclaw-bundled-plugin-direct-priority-");
    const pluginRoot = path.join(pluginsDir, "alpha");
    const nestedDistPluginRoot = path.join(pluginsDir, "dist", "extensions", "alpha");

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(nestedDistPluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const source = true;\n", "utf8");
    fs.writeFileSync(
      path.join(nestedDistPluginRoot, "index.js"),
      "export const built = true;\n",
      "utf8",
    );

    expect(
      resolveBundledPluginGeneratedPath(
        pluginsDir,
        {
          source: "./index.ts",
          built: "index.js",
        },
        "alpha",
        pluginsDir,
      ),
    ).toBe(path.join(pluginRoot, "index.js"));
  });

  it("merges runtime channel schema metadata with manifest-owned channel config fields", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-channel-configs-");

    writeJson(path.join(tempRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
        channel: {
          id: "alpha",
          label: "Alpha Root Label",
          blurb: "Alpha Root Description",
          preferOver: ["alpha-legacy"],
        },
      },
    });
    writeJson(path.join(tempRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      channels: ["alpha"],
      configSchema: { type: "object" },
      channelConfigs: {
        alpha: {
          schema: { type: "object", properties: { stale: { type: "boolean" } } },
          label: "Manifest Label",
          uiHints: {
            "channels.alpha.explicitOnly": {
              help: "manifest hint",
            },
          },
        },
      },
    });
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "index.ts"),
      "export {};\n",
      "utf8",
    );
    fs.mkdirSync(path.join(tempRoot, "extensions", "alpha", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "src", "config-schema.js"),
      [
        "export const AlphaChannelConfigSchema = {",
        "  schema: {",
        "    type: 'object',",
        "    properties: { generated: { type: 'string' } },",
        "  },",
        "  uiHints: {",
        "    'channels.alpha.generatedOnly': { help: 'generated hint' },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: tempRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toEqual({
      schema: {
        type: "object",
        properties: {
          generated: { type: "string" },
        },
      },
      label: "Manifest Label",
      description: "Alpha Root Description",
      preferOver: ["alpha-legacy"],
      uiHints: {
        "channels.alpha.generatedOnly": { help: "generated hint" },
        "channels.alpha.explicitOnly": { help: "manifest hint" },
      },
    });
  });

  it("captures top-level public surface artifacts without duplicating the primary entrypoints", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-public-artifacts-");

    writeJson(path.join(tempRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
      },
    });
    writeJson(path.join(tempRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "index.ts"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "setup-entry.ts"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(path.join(tempRoot, "extensions", "alpha", "api.ts"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "runtime-api.ts"),
      "export {};\n",
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: tempRoot });
    const firstEntry = entries[0] as
      | {
          publicSurfaceArtifacts?: string[];
          runtimeSidecarArtifacts?: string[];
        }
      | undefined;
    expect(firstEntry?.publicSurfaceArtifacts).toEqual(["api.js", "runtime-api.js"]);
    expect(firstEntry?.runtimeSidecarArtifacts).toEqual(["runtime-api.js"]);
  });

  it("loads channel config metadata from built public surfaces in dist-only roots", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-dist-config-");
    const distRoot = path.join(tempRoot, "dist");

    writeJson(path.join(distRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
        channel: {
          id: "alpha",
          label: "Alpha Root Label",
          blurb: "Alpha Root Description",
        },
      },
    });
    writeJson(path.join(distRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      configSchema: {
        type: "object",
        properties: {},
      },
      channels: ["alpha"],
      channelConfigs: {
        alpha: {
          schema: { type: "object", properties: { stale: { type: "boolean" } } },
          uiHints: {
            "channels.alpha.explicitOnly": {
              help: "manifest hint",
            },
          },
        },
      },
    });
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "index.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "channel-config-api.js"),
      [
        "export const AlphaChannelConfigSchema = {",
        "  schema: {",
        "    type: 'object',",
        "    properties: { built: { type: 'string' } },",
        "  },",
        "  uiHints: {",
        "    'channels.alpha.generatedOnly': { help: 'built hint' },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: distRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toEqual({
      schema: {
        type: "object",
        properties: {
          built: { type: "string" },
        },
      },
      label: "Alpha Root Label",
      description: "Alpha Root Description",
      uiHints: {
        "channels.alpha.generatedOnly": { help: "built hint" },
        "channels.alpha.explicitOnly": { help: "manifest hint" },
      },
    });
  });

  it("does not probe broad runtime public surfaces for channel config metadata", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-dist-config-runtime-");
    const distRoot = path.join(tempRoot, "dist");
    const markerPath = path.join(tempRoot, "runtime-api-loaded");

    writeJson(path.join(distRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
        channel: {
          id: "alpha",
          label: "Alpha Root Label",
          blurb: "Alpha Root Description",
        },
      },
    });
    writeJson(path.join(distRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      configSchema: {
        type: "object",
        properties: {},
      },
      channels: ["alpha"],
      channelConfigs: {
        alpha: {
          schema: { type: "object", properties: { manifest: { type: "boolean" } } },
        },
      },
    });
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "index.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "runtime-api.js"),
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded", "utf8");`,
        "export const AlphaChannelConfigSchema = {",
        "  schema: { type: 'object', properties: { runtimeApi: { type: 'string' } } },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "api.js"),
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded", "utf8");`,
        "export const AlphaChannelConfigSchema = {",
        "  schema: { type: 'object', properties: { api: { type: 'string' } } },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: distRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toEqual({
      schema: {
        type: "object",
        properties: {
          manifest: { type: "boolean" },
        },
      },
      label: "Alpha Root Label",
      description: "Alpha Root Description",
    });
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
