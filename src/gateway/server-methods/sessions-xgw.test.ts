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
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        runId: "idem-1",
        messageSeq: 1,
        status: "ok",
        sessionKey: "@ember/skynet",
        remoteSessionKey: "xgw:abc123",
        reply: "remote pong",
      },
      undefined,
    );
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
