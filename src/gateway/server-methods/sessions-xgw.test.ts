import { describe, expect, it, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.fn();
const mockResolveMainSessionKey = vi.fn();
const mockXgwOutboundDispatch = vi.fn();
const mockGetXgwConfig = vi.fn();
const mockSetPendingCallback = vi.fn();
const mockSaveState = vi.fn();
const mockGetActiveCallbackCount = vi.fn(() => 0);
const mockRunAgentStep = vi.fn();
const mockResolvePingPongTurns = vi.fn(() => 5);
const mockBuildAgentToAgentReplyContext = vi.fn(() => "reply context");
const mockIsReplySkip = vi.fn((text?: string) => (text ?? "").trim() === "REPLY_SKIP");

vi.mock("../../config/io.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../agents/tools/agent-step.js", () => ({
  runAgentStep: mockRunAgentStep,
}));

vi.mock("../../agents/tools/sessions-send-helpers.js", () => ({
  resolvePingPongTurns: mockResolvePingPongTurns,
  buildAgentToAgentReplyContext: mockBuildAgentToAgentReplyContext,
  isReplySkip: mockIsReplySkip,
}));

vi.mock("../../agents/lanes.js", () => ({
  AGENT_LANE_NESTED: "nested",
}));

vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKey: mockResolveMainSessionKey,
}));

vi.mock("../xgw/outbound.js", () => ({
  xgwOutboundDispatch: mockXgwOutboundDispatch,
  getXgwConfig: mockGetXgwConfig,
}));

vi.mock("../xgw/state.js", () => ({
  setPendingCallback: mockSetPendingCallback,
  saveState: mockSaveState,
  getActiveCallbackCount: mockGetActiveCallbackCount,
}));

const { handleCrossGatewayDispatch } = await import("./sessions-xgw.js");

describe("handleCrossGatewayDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ fleet: { crossGateway: { enabled: true } } });
    mockGetXgwConfig.mockReturnValue({
      enabled: true,
      peers: { ember: { url: "http://ember.local", token: "secret" } },
    });
    mockResolveMainSessionKey.mockReturnValue("agent:main");
  });

  it("rejects malformed @gateway keys", async () => {
    const respond = vi.fn();

    await handleCrossGatewayDispatch({
      params: { key: "@bad", message: "hello" },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(mockXgwOutboundDispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("Invalid cross-gateway key") }),
    );
  });

  it("dispatches to configured peer and returns remote reply payload", async () => {
    const respond = vi.fn();
    mockXgwOutboundDispatch.mockResolvedValue({
      runId: "corr-1",
      status: "ok",
      sessionKey: "xgw:abc123",
      reply: "remote pong",
    });

    await handleCrossGatewayDispatch({
      params: {
        key: "@ember/receptionist",
        message: "ping",
        timeoutMs: 9500,
        idempotencyKey: "idem-1",
      },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    // Without an explicit callerSessionKey, falls back to resolveMainSessionKey
    expect(mockXgwOutboundDispatch).toHaveBeenCalledWith(
      "ember",
      "receptionist",
      "ping",
      expect.any(Object),
      {
        timeoutSeconds: 9,
        agentSessionKey: "agent:main",
        agentChannel: "gateway_rpc",
      },
    );
    // runId comes from the remote result (corr-1), not the idempotency key
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        runId: "corr-1",
        status: "ok",
        sessionKey: "@ember/receptionist",
        remoteSessionKey: "xgw:abc123",
        reply: "remote pong",
      },
      undefined,
    );
  });

  it("uses callerSessionKey and callerChannel from params when provided", async () => {
    const respond = vi.fn();
    mockXgwOutboundDispatch.mockResolvedValue({
      runId: "corr-3",
      status: "ok",
      sessionKey: "xgw:abc456",
      reply: "pong",
    });

    await handleCrossGatewayDispatch({
      params: {
        key: "@ember/receptionist",
        message: "hi",
        callerSessionKey: "agent:main:subagent:abc",
        callerChannel: "slack",
      },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(mockXgwOutboundDispatch).toHaveBeenCalledWith(
      "ember",
      "receptionist",
      "hi",
      expect.any(Object),
      {
        timeoutSeconds: 30,
        agentSessionKey: "agent:main:subagent:abc",
        agentChannel: "slack",
      },
    );
    // resolveMainSessionKey should NOT be called when callerSessionKey is provided
    expect(mockResolveMainSessionKey).not.toHaveBeenCalled();
  });

  it("uses remote runId over idempotency key in response", async () => {
    const respond = vi.fn();
    mockXgwOutboundDispatch.mockResolvedValue({
      runId: "remote-run-42",
      status: "ok",
      sessionKey: "xgw:session1",
      reply: "done",
    });

    await handleCrossGatewayDispatch({
      params: {
        key: "@ember/receptionist",
        message: "test",
        idempotencyKey: "local-idem-key",
      },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "remote-run-42" }),
      undefined,
    );
  });

  it("includes messageSeq in response when returned by remote", async () => {
    const respond = vi.fn();
    mockXgwOutboundDispatch.mockResolvedValue({
      runId: "corr-5",
      status: "ok",
      sessionKey: "xgw:session2",
      reply: "ack",
      messageSeq: 7,
    });

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "seq test" },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageSeq: 7 }),
      undefined,
    );
  });

  it("omits messageSeq from response when not returned by remote", async () => {
    const respond = vi.fn();
    mockXgwOutboundDispatch.mockResolvedValue({
      runId: "corr-6",
      status: "ok",
      sessionKey: "xgw:session3",
      reply: "ack",
    });

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "no seq" },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    const call = (respond as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(true);
    expect(call[1]).not.toHaveProperty("messageSeq");
  });

  it("maps remote timeout to AGENT_TIMEOUT error", async () => {
    const respond = vi.fn();
    mockXgwOutboundDispatch.mockResolvedValue({
      runId: "corr-2",
      status: "timeout",
      error: "gateway timeout: ember",
    });

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "ping" },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "gateway timeout: ember" }),
    );
  });

  // ── Caller-side async ownership tests ──────────────────────────────────────

  it("creates caller-side pendingCallback record before dispatching async request", async () => {
    const respond = vi.fn();
    mockXgwOutboundDispatch.mockResolvedValue({
      runId: "corr-async-1",
      status: "accepted",
      sessionKey: "xgw:corr-async-1",
      correlationId: "corr-async-1",
      reply: null,
    });

    await handleCrossGatewayDispatch({
      params: {
        key: "@ember/receptionist",
        message: "async task",
        async: true,
        callbackTimeoutMs: 120_000,
        callerSessionKey: "agent:main:subagent:abc",
        callerChannel: "slack",
      },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    // Caller must have created the pending record BEFORE dispatching
    expect(mockSetPendingCallback).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sourceSessionKey: "agent:main:subagent:abc",
        allowedPeer: "ember",
        status: "pending",
      }),
    );
    expect(mockSaveState).toHaveBeenCalled();

    // outbound dispatch must include async=true
    expect(mockXgwOutboundDispatch).toHaveBeenCalledWith(
      "ember",
      "receptionist",
      "async task",
      expect.any(Object),
      expect.objectContaining({
        async: true,
        callbackTimeoutSeconds: 120,
      }),
    );

    // Response must be accepted status with null reply
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "accepted",
        reply: null,
        sessionKey: "@ember/receptionist",
      }),
      undefined,
    );
  });

  it("delivers callback result directly to sourceSessionKey without xgw: prefix", async () => {
    // This test verifies the corrected callback delivery path: sourceSessionKey is
    // used directly, without fabricating an 'xgw:<sourceSessionKey>' prefix.
    // The actual delivery logic lives in handleXgwCallback in inbound.ts;
    // here we verify that setPendingCallback is called with the correct
    // sourceSessionKey so delivery will reach the right session.
    const respond = vi.fn();
    mockXgwOutboundDispatch.mockResolvedValue({
      runId: "corr-delivery",
      status: "accepted",
      sessionKey: "xgw:corr-delivery",
      correlationId: "corr-delivery",
      reply: null,
    });

    await handleCrossGatewayDispatch({
      params: {
        key: "@ember/receptionist",
        message: "deliver test",
        async: true,
        callerSessionKey: "agent:main:slack:channel:abc123",
        callerChannel: "slack",
      },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    // The pending record must store the real caller session key (no xgw: prefix).
    const setPendingCall = mockSetPendingCallback.mock.calls[0];
    expect(setPendingCall).toBeDefined();
    const [, pendingEntry] = setPendingCall as [string, { sourceSessionKey: string }];
    expect(pendingEntry.sourceSessionKey).toBe("agent:main:slack:channel:abc123");
    expect(pendingEntry.sourceSessionKey).not.toMatch(/^xgw:/);
  });

  it("rejects async dispatch when pending callback capacity is exceeded", async () => {
    const respond = vi.fn();
    mockGetActiveCallbackCount.mockReturnValue(100);
    mockGetXgwConfig.mockReturnValue({
      enabled: true,
      maxPendingAsync: 100,
      peers: { ember: { url: "http://ember.local", token: "secret" } },
    });

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "overflow", async: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(mockSetPendingCallback).not.toHaveBeenCalled();
    expect(mockXgwOutboundDispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("pending async callbacks") }),
    );
  });

  it("logs a stderr warning when outbound peer URL uses http:// instead of https://", async () => {
    // xgwOutboundDispatch is mocked at the module level in this file, so we call the
    // real implementation directly to verify the http-warning path.
    const { xgwOutboundDispatch: realDispatch } =
      await vi.importActual<typeof import("../xgw/outbound.js")>("../xgw/outbound.js");

    const mockFetchLocal = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        runId: "r1",
        status: "ok",
        sessionKey: "xgw:s1",
        reply: "pong",
      }),
    });
    vi.stubGlobal("fetch", mockFetchLocal);

    const stderrMessages: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((msg: unknown) => {
      stderrMessages.push(String(msg));
      return true;
    });

    try {
      await realDispatch(
        "ember",
        "receptionist",
        "ping",
        {
          fleet: {
            crossGateway: {
              enabled: true,
              peers: { ember: { url: "http://ember.local", token: "secret" } },
            },
          },
        } as never,
        { timeoutSeconds: 5 },
      );
    } finally {
      stderrSpy.mockRestore();
      vi.unstubAllGlobals();
    }

    expect(stderrMessages.some((m) => m.includes("insecure URL"))).toBe(true);
  });

  it("rejects dispatch when cross-gateway is disabled", async () => {
    const respond = vi.fn();
    mockGetXgwConfig.mockReturnValue({ enabled: false, peers: {} });

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "ping" },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(mockXgwOutboundDispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not enabled") }),
    );
  });

  // ── Circular self-send detection ───────────────────────────────────────────

  it("rejects dispatch when target gateway is self (circular send)", async () => {
    const respond = vi.fn();
    mockLoadConfig.mockReturnValue({
      fleet: { crossGateway: { enabled: true, gatewayName: "ember" } },
    });
    mockGetXgwConfig.mockReturnValue({
      enabled: true,
      gatewayName: "ember",
      peers: { ember: { url: "http://ember.local", token: "secret" } },
    });

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "ping" },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(mockXgwOutboundDispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("circular send") }),
    );
  });

  // ── multiTurn + async mutual exclusivity ──────────────────────────────────

  it("rejects when both multiTurn and async are true", async () => {
    const respond = vi.fn();

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "ping", multiTurn: true, async: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    expect(mockXgwOutboundDispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("mutually exclusive") }),
    );
  });

  // ── Multi-turn loop tests ─────────────────────────────────────────────────

  it("multi-turn basic: fires loop and returns first reply immediately", async () => {
    const respond = vi.fn();
    mockResolvePingPongTurns.mockReturnValue(3);
    mockXgwOutboundDispatch
      // initial dispatch
      .mockResolvedValueOnce({
        runId: "run-1",
        status: "ok",
        sessionKey: "xgw:corr-mt",
        reply: "remote reply 1",
      })
      // turn 1 follow-up
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:corr-mt",
        reply: "remote reply 2",
      })
      // turn 2 follow-up
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:corr-mt",
        reply: "remote reply 3",
      })
      // turn 3 follow-up
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:corr-mt",
        reply: "remote reply 4",
      });
    mockRunAgentStep.mockResolvedValue("local reply");

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "start", multiTurn: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    // First reply is returned immediately
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "ok",
        reply: "remote reply 1",
        remoteSessionKey: "xgw:corr-mt",
      }),
      undefined,
    );

    // Allow the fire-and-forget loop to complete
    await new Promise((r) => {
      setImmediate(r);
    });
    await new Promise((r) => {
      setImmediate(r);
    });

    // runAgentStep called once per turn (up to maxTurns=3)
    expect(mockRunAgentStep).toHaveBeenCalledTimes(3);
    // outbound dispatch: 1 initial + 3 follow-ups
    expect(mockXgwOutboundDispatch).toHaveBeenCalledTimes(4);
  });

  it("multi-turn stops when local agent returns REPLY_SKIP", async () => {
    const respond = vi.fn();
    mockResolvePingPongTurns.mockReturnValue(5);
    mockXgwOutboundDispatch
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:corr-skip-local",
        reply: "remote reply 1",
      })
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:corr-skip-local",
        reply: "remote reply 2",
      });
    mockRunAgentStep.mockResolvedValueOnce("local reply 1").mockResolvedValueOnce("REPLY_SKIP"); // stop on turn 2

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "start", multiTurn: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    await new Promise((r) => {
      setImmediate(r);
    });
    await new Promise((r) => {
      setImmediate(r);
    });

    // Only 2 local turns (REPLY_SKIP on turn 2 stops before sending)
    expect(mockRunAgentStep).toHaveBeenCalledTimes(2);
    // 1 initial + 1 follow-up (turn 1). Turn 2 local returns REPLY_SKIP, so no 3rd dispatch.
    expect(mockXgwOutboundDispatch).toHaveBeenCalledTimes(2);
  });

  it("multi-turn stops when remote agent returns REPLY_SKIP", async () => {
    const respond = vi.fn();
    mockResolvePingPongTurns.mockReturnValue(5);
    mockXgwOutboundDispatch
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:corr-skip-remote",
        reply: "remote reply 1",
      })
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:corr-skip-remote",
        reply: "REPLY_SKIP", // remote stops
      });
    mockRunAgentStep.mockResolvedValue("local reply");

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "start", multiTurn: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    await new Promise((r) => {
      setImmediate(r);
    });
    await new Promise((r) => {
      setImmediate(r);
    });

    // 1 local turn ran (turn 1), then remote returned REPLY_SKIP
    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
    // 1 initial + 1 follow-up
    expect(mockXgwOutboundDispatch).toHaveBeenCalledTimes(2);
  });

  it("multi-turn enforces turn cap", async () => {
    const respond = vi.fn();
    mockResolvePingPongTurns.mockReturnValue(2); // cap at 2
    mockXgwOutboundDispatch.mockResolvedValue({
      status: "ok",
      sessionKey: "xgw:corr-cap",
      reply: "remote reply",
    });
    mockRunAgentStep.mockResolvedValue("local reply");

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "start", multiTurn: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    await new Promise((r) => {
      setImmediate(r);
    });
    await new Promise((r) => {
      setImmediate(r);
    });

    // Exactly 2 turns
    expect(mockRunAgentStep).toHaveBeenCalledTimes(2);
    // 1 initial + 2 follow-ups
    expect(mockXgwOutboundDispatch).toHaveBeenCalledTimes(3);
  });

  it("multi-turn stops on remote error mid-loop", async () => {
    const respond = vi.fn();
    mockResolvePingPongTurns.mockReturnValue(5);
    mockXgwOutboundDispatch
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:corr-err",
        reply: "remote reply 1",
      })
      .mockResolvedValueOnce({
        status: "error", // remote error on turn 1 follow-up
        error: "something went wrong",
      });
    mockRunAgentStep.mockResolvedValue("local reply");

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "start", multiTurn: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    await new Promise((r) => {
      setImmediate(r);
    });
    await new Promise((r) => {
      setImmediate(r);
    });

    // 1 local turn ran before remote error
    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
    // 1 initial + 1 follow-up that errored
    expect(mockXgwOutboundDispatch).toHaveBeenCalledTimes(2);
  });

  it("multi-turn stops when local agent returns undefined (timeout)", async () => {
    const respond = vi.fn();
    mockResolvePingPongTurns.mockReturnValue(5);
    mockXgwOutboundDispatch.mockResolvedValueOnce({
      status: "ok",
      sessionKey: "xgw:corr-undef",
      reply: "remote reply 1",
    });
    mockRunAgentStep.mockResolvedValue(undefined); // timeout/undefined

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "start", multiTurn: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    await new Promise((r) => {
      setImmediate(r);
    });
    await new Promise((r) => {
      setImmediate(r);
    });

    // 1 local step ran, returned undefined → loop stops
    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
    // Only initial dispatch, no follow-up
    expect(mockXgwOutboundDispatch).toHaveBeenCalledTimes(1);
  });

  it("multi-turn does not fire loop when first remote reply is empty", async () => {
    const respond = vi.fn();
    mockResolvePingPongTurns.mockReturnValue(5);
    mockXgwOutboundDispatch.mockResolvedValueOnce({
      status: "ok",
      sessionKey: "xgw:corr-empty",
      reply: undefined, // no reply
    });
    mockRunAgentStep.mockResolvedValue("local reply");

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "start", multiTurn: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    await new Promise((r) => {
      setImmediate(r);
    });
    await new Promise((r) => {
      setImmediate(r);
    });

    // No loop fired — remote reply was empty
    expect(mockRunAgentStep).not.toHaveBeenCalled();
    expect(mockXgwOutboundDispatch).toHaveBeenCalledTimes(1);
  });

  it("multi-turn dispatches follow-ups to the remote session key from first reply", async () => {
    const respond = vi.fn();
    mockResolvePingPongTurns.mockReturnValue(1);
    mockXgwOutboundDispatch
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:worker-abc",
        reply: "remote reply 1",
      })
      .mockResolvedValueOnce({
        status: "ok",
        sessionKey: "xgw:worker-abc",
        reply: "remote reply 2",
      });
    mockRunAgentStep.mockResolvedValue("local reply");

    await handleCrossGatewayDispatch({
      params: { key: "@ember/receptionist", message: "start", multiTurn: true },
      respond,
      context: { getRuntimeConfig: mockLoadConfig } as never,
    });

    await new Promise((r) => {
      setImmediate(r);
    });
    await new Promise((r) => {
      setImmediate(r);
    });

    // Follow-up should go to the worker session key returned in first reply
    expect(mockXgwOutboundDispatch).toHaveBeenNthCalledWith(
      2,
      "ember",
      "xgw:worker-abc", // not "receptionist"
      "local reply",
      expect.any(Object),
      expect.any(Object),
    );
  });
});
