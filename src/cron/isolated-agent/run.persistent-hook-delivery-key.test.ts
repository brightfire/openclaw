// Regression coverage: cron runtime delivery resolution must derive the session
// key from sessionTarget for persistent hook jobs (sessionKey unset), matching
// delivery-preview/announce paths, so implicit/"last" replies route to the hook
// session rather than the main session's last channel.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeAnnounceLastPlan() {
  return {
    requested: true,
    mode: "announce",
    channel: "last",
  };
}

function makeParams(job: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: job as never,
    message: "send a message",
    sessionKey: "cron:hook-job",
  };
}

function getResolveDeliveryTargetSessionKey(): unknown {
  const call = (resolveDeliveryTargetMock.mock.calls as unknown[][])[0];
  if (!call) {
    throw new Error("expected resolveDeliveryTarget to be called");
  }
  const jobPayload = call[2];
  if (typeof jobPayload !== "object" || jobPayload === null) {
    throw new Error("expected resolveDeliveryTarget job payload to be an object");
  }
  return (jobPayload as { sessionKey?: unknown }).sessionKey;
}

describe("runCronIsolatedAgentTurn persistent hook delivery session key", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it('derives the delivery session key from sessionTarget "session:<key>" when sessionKey is unset', async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceLastPlan());

    await runCronIsolatedAgentTurn(
      makeParams({
        id: "hook-job",
        name: "Persistent Hook Job",
        schedule: { kind: "every", everyMs: 60_000 },
        // Persistent hook mapping: target carries the session, sessionKey unset.
        sessionTarget: "session:hook-foo",
        sessionKey: undefined,
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "announce", channel: "last" },
      }),
    );

    expect(resolveDeliveryTargetMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    // Bug fix: must be the derived "hook-foo", not undefined (which would fall
    // back to the main session's last channel).
    expect(getResolveDeliveryTargetSessionKey()).toBe("hook-foo");
  });

  it("passes through an explicit sessionKey for non-persistent (isolated) targets", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceLastPlan());

    await runCronIsolatedAgentTurn(
      makeParams({
        id: "isolated-job",
        name: "Isolated Job",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        sessionKey: "explicit-key",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "announce", channel: "last" },
      }),
    );

    expect(resolveDeliveryTargetMock).toHaveBeenCalledTimes(1);
    expect(getResolveDeliveryTargetSessionKey()).toBe("explicit-key");
  });
});
