import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";

const mockFetch = vi.fn();
const { mockLoadConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/config.js")>(
    "../../config/config.js",
  );
  return {
    ...actual,
    loadConfig: mockLoadConfig,
  };
});

import { clearGatewaySubagentRuntime, setGatewaySubagentRuntime } from "../../plugins/runtime/index.js";
import {
  AUTH_NONE,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "../server-http.test-harness.js";
import { withTempConfig } from "../test-temp-config.js";

// Pre-warm the lazy dynamic import so it resolves synchronously (as a cached
// microtask) during request dispatch.  Without this, the first `import()`
// inside `getXgwHttpModule()` takes at least one full event-loop turn, racing
// against the `setImmediate` in `createStreamingRequest` that emits the
// request body — causing `readJsonBody` to miss the data/end events.
import "./inbound.js";

function createStreamingRequest(params: {
  path: string;
  authorization: string;
  body: Record<string, unknown>;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = params.path;
  req.headers = {
    host: "localhost:18789",
    authorization: params.authorization,
    "content-type": "application/json",
  };
  req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(params.body)));
    req.emit("end");
  });
  return req;
}

function createSubagentRuntime() {
  return {
    run: vi.fn(async () => ({ runId: "run-1" })),
    waitForRun: vi.fn(async () => ({ status: "completed" })),
    getSessionMessages: vi.fn(async () => ({
      messages: [{ role: "assistant", content: "hello from remote worker" }],
    })),
    deleteSession: vi.fn(async () => {}),
  };
}

describe("gateway XGW HTTP routes", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockLoadConfig.mockReturnValue({
      fleet: {
        crossGateway: {
          enabled: true,
          acceptedTokens: { ember: "peer-secret" },
          peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
          exposureTtlSeconds: 300,
        },
      },
    });
  });

  afterEach(() => {
    clearGatewaySubagentRuntime();
    vi.unstubAllGlobals();
    mockFetch.mockReset();
    mockLoadConfig.mockReset();
  });

  it("serves POST /hooks/xgw through the core gateway server", async () => {
    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);

    await withTempConfig({
      prefix: "xgw-http-hook",
      cfg: {
        gateway: { trustedProxies: [] },
        fleet: {
          crossGateway: {
            enabled: true,
            acceptedTokens: { ember: "peer-secret" },
            peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
            exposureTtlSeconds: 300,
          },
        },
      },
      run: async () => {
        await withGatewayServer({
          prefix: "xgw-http-hook",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/hooks/xgw",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "skynet",
                message: "ping from peer",
                sourceSessionKey: "agent:main",
                sourceChannel: "gateway_rpc",
                correlationId: "corr-1",
                nonce: "nonce-1",
                timestamp: Math.floor(Date.now() / 1000),
                timeoutSeconds: 1,
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            if (res.statusCode !== 200) {
              throw new Error(`unexpected status ${res.statusCode}: ${getBody()}`);
            }
            expect(res.statusCode).toBe(200);
            expect(JSON.parse(getBody())).toEqual({
              ok: true,
              runId: "run-1",
              status: "ok",
              sessionKey: "xgw:corr-1",
              reply: "hello from remote worker",
            });
            expect(subagent.run).toHaveBeenCalledWith(
              expect.objectContaining({
                message: "ping from peer",
                sessionKey: "xgw:corr-1",
                deliver: false,
                channel: "internal",
              }),
            );
          },
        });
      },
    });
  });

  it("serves POST /hooks/xgw/callback through the core gateway server", async () => {
    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);

    await withTempConfig({
      prefix: "xgw-http-callback",
      cfg: {
        gateway: { trustedProxies: [] },
        fleet: {
          crossGateway: {
            enabled: true,
            acceptedTokens: { ember: "peer-secret" },
            peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
          },
        },
      },
      run: async () => {
        const stateModule = await import("./state.js");
        stateModule.setPendingCallback("corr-2", {
          sourceSessionKey: "agent:main",
          allowedPeer: "ember",
          createdAt: Date.now() / 1000,
          expiresAt: Date.now() / 1000 + 600,
          status: "pending",
        });

        await withGatewayServer({
          prefix: "xgw-http-callback",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/hooks/xgw/callback",
              authorization: "Bearer peer-secret",
              body: {
                correlationId: "corr-2",
                sessionKey: "xgw:corr-2",
                status: "ok",
                reply: "async reply",
                nonce: "nonce-2",
                timestamp: Math.floor(Date.now() / 1000),
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            if (res.statusCode !== 200) {
              throw new Error(`unexpected status ${res.statusCode}: ${getBody()}`);
            }
            expect(res.statusCode).toBe(200);
            expect(JSON.parse(getBody())).toEqual({ ok: true, status: "delivered" });
            expect(subagent.run).toHaveBeenCalledWith(
              expect.objectContaining({
                sessionKey: "xgw:agent:main",
                deliver: true,
                channel: "internal",
              }),
            );
          },
        });
      },
    });
  });
});
