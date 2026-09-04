// Computes the test shard matrix using upstream's own ci-node-test-plan.mts.
// Same computation as upstream CI's preflight — same shard counts, runner
// assignments, and timeouts. When upstream changes their test split, this
// automatically follows.
//
// MUST be run from the repo root (like upstream's preflight does).
//
// Usage: cd <repo-root> && node --import tsx scripts/bf/build-stable/compute-test-matrix.mjs

import { resolve } from "node:path";

const planPath = resolve(process.cwd(), "scripts/lib/ci-node-test-plan.mts");
const nodeTestPlan = await import(planPath);

const createNodeTestPlan =
  typeof nodeTestPlan.createNodeTestShardBundles === "function"
    ? nodeTestPlan.createNodeTestShardBundles
    : nodeTestPlan.createNodeTestShards;

if (typeof createNodeTestPlan !== "function") {
  throw new Error("CI target does not export a supported Node test shard planner");
}

// Full suite: no changed paths, standard GitHub-hosted runner backend.
// This matches upstream CI's non-PR (push/dispatch) behavior.
const shards = await createNodeTestPlan({
  runnerBackend: "github",
});

// Format as matrix-compatible entries
// Map Blacksmith runner classes to standard GitHub-hosted runners.
// Upstream CI falls back to ubuntu-24.04 for non-openclaw repos; we do
// the same since brightfire/openclaw uses standard GitHub runners.
const runnerMap = {
  "blacksmith-4vcpu-ubuntu-2404": "ubuntu-24.04",
  "blacksmith-8vcpu-ubuntu-2404": "ubuntu-24.04",
  "blacksmith-16vcpu-ubuntu-2404": "ubuntu-24.04",
  "blacksmith-12vcpu-macos-26": "macos-14",
};

const matrix = shards.map((shard) => ({
  shard_name: shard.shardName ?? shard.checkName,
  configs: JSON.stringify(shard.configs ?? []),
  runner: runnerMap[shard.runner] ?? shard.runner ?? "ubuntu-24.04",
  timeout_minutes: shard.timeoutMinutes ?? 30,
  env: JSON.stringify(shard.env ?? {}),
  include_patterns: JSON.stringify(shard.includePatterns ?? []),
  requires_dist: shard.requiresDist ?? false,
}));

console.log(JSON.stringify(matrix));
