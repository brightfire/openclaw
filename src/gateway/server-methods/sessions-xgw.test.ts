import { describe, expect, it, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.fn();
const mockResolveMainSessionKey = vi.fn();
const mockXgwOutboundDispatch = vi.fn();
const mockGetXgwConfig = vi.fn();

vi.mock("../../config/io.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKey: mockResolveMainSessionKey,
}));

vi.mock("../xgw/outbound.js", () => ({
  xgwOutboundDispatch: mockXgwOutboundDispatch,
  getXgwConfig: mockGetXgwConfig,
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
      context: {} as never,
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
      params: { key: "@ember/skynet", message: "ping", timeoutMs: 9500, idempotencyKey: "idem-1" },
      respond,
      context: {} as never,
    });

    // Without an explicit callerSessionKey, falls back to resolveMainSessionKey
    expect(mockXgwOutboundDispatch).toHaveBeenCalledWith(
      "ember",
      "skynet",
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
        sessionKey: "@ember/skynet",
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
        key: "@ember/skynet",
        message: "hi",
        callerSessionKey: "agent:main:subagent:abc",
        callerChannel: "slack",
      },
      respond,
      context: {} as never,
    });

    expect(mockXgwOutboundDispatch).toHaveBeenCalledWith(
      "ember",
      "skynet",
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
        key: "@ember/skynet",
        message: "test",
        idempotencyKey: "local-idem-key",
      },
      respond,
      context: {} as never,
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
      params: { key: "@ember/skynet", message: "seq test" },
      respond,
      context: {} as never,
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
      params: { key: "@ember/skynet", message: "no seq" },
      respond,
      context: {} as never,
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
      params: { key: "@ember/skynet", message: "ping" },
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "gateway timeout: ember" }),
    );
  });
});
