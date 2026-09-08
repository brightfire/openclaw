// Verifies bundled plugin activation declarations and Gateway startup resolution.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listRepoBundledPluginManifests } from "./bundled-plugin-metadata.test-support.js";
import { resolveGatewayStartupPluginIdsFromRegistry } from "./gateway-startup-plugin-ids.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

const EXPECTED_BUNDLED_STARTUP_PLUGIN_IDS = [
  "acpx",
  "active-memory",
  "anthropic",
  "bonjour",
  "browser",
  "canvas",
  "cua-computer",
  "device-pair",
  "diagnostics-otel",
  "diagnostics-prometheus",
  "diffs",
  "diffs-language-pack",
  "file-transfer",
  "geolocation",
  "google-meet",
  "imap",
  "linux-node",
  "llm-task",
  "lobster",
  "logbook",
  "memory-wiki",
  "ollama",
  "openai",
  "opencode",
  "openshell",
  "policy",
  "reef",
  "talk-voice",
  "teams-meetings",
  "visitor-access",
  "voice-call",
  "webhooks",
  "workboard",
  "zoom-meetings",
] as const;
const EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_PLUGIN_IDS = [
  "acpx",
  "anthropic",
  "browser",
  "canvas",
  "cua-computer",
  "device-pair",
  "file-transfer",
  "geolocation",
  "google-meet",
  "linux-node",
  "memory-core",
  "ollama",
  "openai",
  "opencode",
  "talk-voice",
  "teams-meetings",
  "xai",
  "zoom-meetings",
] as const;

function createRepoBundledManifestRegistry(): PluginManifestRegistry {
  return {
    plugins: listRepoBundledPluginManifests().map(({ manifest, dirName }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      enabledByDefault: manifest.enabledByDefault === true ? true : undefined,
      enabledByDefaultOnPlatforms: manifest.enabledByDefaultOnPlatforms,
      kind: manifest.kind,
      channels: manifest.channels ?? [],
      providers: manifest.providers ?? [],
      cliBackends: manifest.cliBackends ?? [],
      syntheticAuthRefs: manifest.syntheticAuthRefs ?? [],
      nonSecretAuthMarkers: manifest.nonSecretAuthMarkers ?? [],
      skills: manifest.skills ?? [],
      origin: "bundled",
      rootDir: path.join(repoRoot, "extensions", dirName),
      source: path.join(repoRoot, "extensions", dirName, "index.ts"),
      manifestPath: path.join(repoRoot, "extensions", dirName, "openclaw.plugin.json"),
      activation: manifest.activation,
      setup: manifest.setup,
      hooks: [],
      contracts: manifest.contracts,
    })),
    diagnostics: [],
  };
}

function hasPluginKind(record: PluginManifestRecord, kind: string): boolean {
  return Array.isArray(record.kind) ? record.kind.includes(kind as never) : record.kind === kind;
}

function createInstalledPluginRecordForManifest(
  record: PluginManifestRecord,
): InstalledPluginIndexRecord {
  return {
    pluginId: record.id,
    manifestPath: record.manifestPath,
    manifestHash: `test-${record.id}`,
    source: record.source,
    rootDir: record.rootDir,
    origin: record.origin,
    enabled: record.enabledByDefault === true,
    ...(record.enabledByDefault === true ? { enabledByDefault: true } : {}),
    ...(record.enabledByDefaultOnPlatforms?.length
      ? { enabledByDefaultOnPlatforms: record.enabledByDefaultOnPlatforms }
      : {}),
    startup: {
      sidecar: record.activation?.onStartup === true,
      memory: hasPluginKind(record, "memory"),
      agentHarnesses: [
        ...new Set([...(record.activation?.onAgentHarnesses ?? []), ...record.cliBackends]),
      ].toSorted((left, right) => left.localeCompare(right)),
    },
    compat: [],
  };
}

function createInstalledPluginIndexForManifests(
  manifestRegistry: PluginManifestRegistry,
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: manifestRegistry.plugins.map(createInstalledPluginRecordForManifest),
    diagnostics: [],
  };
}

describe("bundled plugin activation", () => {
  it("declares explicit startup activation on all bundled plugin manifests", () => {
    const startupPluginIds: string[] = [];

    for (const entry of listRepoBundledPluginManifests()) {
      expect(typeof entry.manifest.activation?.onStartup).toBe("boolean");
      if (entry.manifest.activation?.onStartup === true) {
        startupPluginIds.push(entry.manifest.id);
      }
    }

    expect(startupPluginIds.toSorted((left, right) => left.localeCompare(right))).toEqual(
      EXPECTED_BUNDLED_STARTUP_PLUGIN_IDS,
    );
  });

  it("scopes Voice Call CLI activation to the voicecall command", () => {
    const entry = listRepoBundledPluginManifests().find(
      ({ manifest }) => manifest.id === "voice-call",
    );

    expect(entry?.manifest.commandAliases).toStrictEqual([{ name: "voicecall" }]);
    expect(entry?.manifest.activation?.onCommands).toStrictEqual(["voicecall"]);
  });

  it("keeps Workboard CLI ownership separate from its slash command", () => {
    const entry = listRepoBundledPluginManifests().find(
      ({ manifest }) => manifest.id === "workboard",
    );

    expect(entry?.manifest.commandAliases).toStrictEqual([{ name: "workboard" }]);
    expect(entry?.manifest.activation?.onCommands).toStrictEqual(["workboard"]);
  });

  it("scopes Codex CLI activation to the codex command", () => {
    const entry = listRepoBundledPluginManifests().find(({ manifest }) => manifest.id === "codex");

    expect(entry?.manifest.activation?.onCommands).toStrictEqual(["codex"]);
  });

  it("keeps empty-config Gateway startup narrower than declared startup sidecars", () => {
    const manifestRegistry = createRepoBundledManifestRegistry();
    const index = createInstalledPluginIndexForManifests(manifestRegistry);

    expect(
      resolveGatewayStartupPluginIdsFromRegistry({
        config: {},
        env: {},
        index,
        manifestRegistry,
        platform: "linux",
      }),
    ).toEqual(EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_PLUGIN_IDS);
  });

  it("auto-starts Bonjour for empty-config macOS Gateway startup", () => {
    const manifestRegistry = createRepoBundledManifestRegistry();
    const index = createInstalledPluginIndexForManifests(manifestRegistry);

    expect(
      resolveGatewayStartupPluginIdsFromRegistry({
        config: {},
        env: process.env,
        index,
        manifestRegistry,
        platform: "darwin",
      }),
    ).toContain("bonjour");
  });

  it("starts Bonjour when explicitly enabled", () => {
    const manifestRegistry = createRepoBundledManifestRegistry();
    const index = createInstalledPluginIndexForManifests(manifestRegistry);

    expect(
      resolveGatewayStartupPluginIdsFromRegistry({
        config: { plugins: { entries: { bonjour: { enabled: true } } } },
        env: process.env,
        index,
        manifestRegistry,
        platform: "linux",
      }),
    ).toContain("bonjour");
  });
});
