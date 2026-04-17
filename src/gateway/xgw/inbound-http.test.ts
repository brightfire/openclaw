import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
const { mockLoadConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: mockLoadConfig,
  };
});

import {
  clearGatewaySubagentRuntime,
  setGatewaySubagentRuntime,
} from "../../plugins/runtime/index.js";
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
  const getSessionMessages = vi.fn(async () => ({
    messages: [{ role: "assistant", content: "hello from remote worker" }],
  }));
  return {
    run: vi.fn(async () => ({ runId: "run-1" })),
    waitForRun: vi.fn(async () => ({ status: "ok" as const })),
    getSessionMessages,
    getSession: vi.fn(async () => ({
      messages: [{ role: "assistant", content: "hello from remote worker" }],
    })),
    deleteSession: vi.fn(async () => {}),
  };
}

describe("gateway XGW HTTP routes", () => {
  let tempHomeDir: string;

  beforeEach(async () => {
    vi.useRealTimers();
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "xgw-home-"));
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    vi.stubGlobal("fetch", mockFetch);
    mockLoadConfig.mockReturnValue({
      fleet: {
        crossGateway: {
          enabled: true,
          acceptedTokens: { ember: "peer-secret", other: "other-secret" },
          peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
          exposureTtlSeconds: 300,
        },
      },
    });
    const stateModule = await import("./state.js");
    stateModule.loadState();
    stateModule.pruneExpired();
  });

  afterEach(() => {
    clearGatewaySubagentRuntime();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    mockFetch.mockReset();
    mockLoadConfig.mockReset();
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
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

  it("dispatches directly to an exposed xgw session and returns the sync reply", async () => {
    const subagent = createSubagentRuntime();
    subagent.getSessionMessages.mockResolvedValue({
      messages: [{ role: "assistant", content: "follow-up reply" }],
    });
    setGatewaySubagentRuntime(subagent);

    await withTempConfig({
      prefix: "xgw-http-direct",
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
        const stateModule = await import("./state.js");
        stateModule.setExposure("xgw:corr-direct", {
          correlationId: "corr-direct",
          allowedPeer: "ember",
          createdAt: Date.now() / 1000,
          expiresAt: Date.now() / 1000 + 60,
        });

        await withGatewayServer({
          prefix: "xgw-http-direct",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/hooks/xgw",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "xgw:corr-direct",
                message: "follow-up",
                sourceSessionKey: "agent:main",
                nonce: "nonce-direct",
                timestamp: Math.floor(Date.now() / 1000),
                timeoutSeconds: 1,
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(200);
            expect(JSON.parse(getBody())).toEqual({
              ok: true,
              runId: "run-1",
              status: "ok",
              sessionKey: "xgw:corr-direct",
              reply: "follow-up reply",
            });
            expect(subagent.run).toHaveBeenCalledWith(
              expect.objectContaining({
                sessionKey: "xgw:corr-direct",
                message: "follow-up",
                deliver: false,
              }),
            );
            expect(subagent.waitForRun).toHaveBeenCalledWith({ runId: "run-1", timeoutMs: 1000 });
          },
        });
      },
    });
  });

  it("returns 403 when a peer targets an exposed xgw session owned by another peer", async () => {
    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);

    await withTempConfig({
      prefix: "xgw-http-forbidden",
      cfg: {
        gateway: { trustedProxies: [] },
        fleet: {
          crossGateway: {
            enabled: true,
            acceptedTokens: { ember: "peer-secret", other: "other-secret" },
            peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
            exposureTtlSeconds: 300,
          },
        },
      },
      run: async () => {
        const stateModule = await import("./state.js");
        stateModule.setExposure("xgw:corr-private", {
          correlationId: "corr-private",
          allowedPeer: "ember",
          createdAt: Date.now() / 1000,
          expiresAt: Date.now() / 1000 + 60,
        });

        await withGatewayServer({
          prefix: "xgw-http-forbidden",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/hooks/xgw",
              authorization: "Bearer other-secret",
              body: {
                sessionKey: "xgw:corr-private",
                message: "steal session",
                sourceSessionKey: "agent:main",
                nonce: "nonce-forbidden",
                timestamp: Math.floor(Date.now() / 1000),
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(403);
            expect(JSON.parse(getBody())).toEqual({
              ok: false,
              status: "forbidden",
              error: "session not accessible",
            });
            expect(subagent.run).not.toHaveBeenCalled();
          },
        });
      },
    });
  });

  it("returns 403 for nonexistent exposed xgw sessions", async () => {
    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);

    await withTempConfig({
      prefix: "xgw-http-missing",
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
        await withGatewayServer({
          prefix: "xgw-http-missing",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/hooks/xgw",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "xgw:does-not-exist",
                message: "ping",
                sourceSessionKey: "agent:main",
                nonce: "nonce-missing",
                timestamp: Math.floor(Date.now() / 1000),
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(403);
            expect(JSON.parse(getBody())).toEqual({
              ok: false,
              status: "forbidden",
              error: "session not accessible",
            });
          },
        });
      },
    });
  });

  it("registers async callbacks, persists restart-safe state, and marks outbound delivery complete", async () => {
    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: vi.fn(async () => "") });

    await withTempConfig({
      prefix: "xgw-http-async-persist",
      cfg: {
        gateway: { trustedProxies: [] },
        fleet: {
          crossGateway: {
            enabled: true,
            acceptedTokens: { ember: "peer-secret" },
            peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
            exposureTtlSeconds: 300,
            maxPendingAsync: 5,
          },
        },
      },
      run: async () => {
        const stateModule = await import("./state.js");

        await withGatewayServer({
          prefix: "xgw-http-async-persist",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/hooks/xgw",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "skynet",
                message: "ping async",
                sourceSessionKey: "agent:main",
                sourceChannel: "gateway_rpc",
                correlationId: "corr-async",
                nonce: "nonce-async",
                timestamp: Math.floor(Date.now() / 1000),
                async: true,
                callbackTimeoutSeconds: 60,
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(200);
            expect(JSON.parse(getBody())).toEqual({
              ok: true,
              status: "accepted",
              correlationId: "corr-async",
              sessionKey: "xgw:corr-async",
            });
          },
        });

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        const pending = stateModule.getPendingCallback("corr-async");
        expect(pending).toMatchObject({
          sourceSessionKey: "agent:main",
          allowedPeer: "ember",
          status: "delivered",
          resultStatus: "ok",
          targetSessionKey: "xgw:corr-async",
        });
        expect(pending?.deliveredAt).toEqual(expect.any(Number));
        expect(mockFetch).toHaveBeenCalledWith(
          "http://ember.local/hooks/xgw/callback",
          expect.objectContaining({ method: "POST" }),
        );

        const persisted = JSON.parse(fs.readFileSync(stateModule.getStateFile(), "utf-8")) as {
          pendingCallbacks?: Record<string, Record<string, unknown>>;
        };
        expect(persisted.pendingCallbacks?.["corr-async"]).toMatchObject({
          status: "delivered",
          resultStatus: "ok",
          targetSessionKey: "xgw:corr-async",
        });

        stateModule.loadState();
        expect(stateModule.getPendingCallback("corr-async")).toMatchObject({
          status: "delivered",
          resultStatus: "ok",
        });
      },
    });
  });

  it("keeps failed outbound callback deliveries pending across reload and prunes expired callbacks", async () => {
    const nowMs = Date.parse("2026-04-16T21:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);
    mockFetch.mockResolvedValue({ ok: false, status: 502, text: vi.fn(async () => "bad gateway") });

    await withTempConfig({
      prefix: "xgw-http-async-reload",
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

        await withGatewayServer({
          prefix: "xgw-http-async-reload",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/hooks/xgw",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "skynet",
                message: "ping async",
                sourceSessionKey: "agent:main",
                correlationId: "corr-reload",
                nonce: "nonce-reload",
                timestamp: Math.floor(Date.now() / 1000),
                async: true,
                callbackTimeoutSeconds: 60,
              },
            });

            const { res } = createResponse();
            await dispatchRequest(server, req, res);
            expect(res.statusCode).toBe(200);
          },
        });

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(stateModule.getPendingCallback("corr-reload")).toMatchObject({
          status: "pending",
          lastDeliveryError: expect.stringContaining("status=502"),
          targetSessionKey: "xgw:corr-reload",
        });

        stateModule.loadState();
        expect(stateModule.getPendingCallback("corr-reload")).toMatchObject({
          status: "pending",
          lastDeliveryError: expect.stringContaining("status=502"),
        });

        nowSpy.mockReturnValue(nowMs + 61_000);
        stateModule.pruneExpired();
        expect(stateModule.getPendingCallback("corr-reload")).toMatchObject({
          status: "expired",
          resultStatus: "timeout",
        });

        nowSpy.mockReturnValue(nowMs + (61 + 3601) * 1000);
        stateModule.pruneExpired();
        expect(stateModule.getPendingCallback("corr-reload")).toBeUndefined();
      },
    });

    nowSpy.mockRestore();
  });

  it("expires stale xgw exposure before dispatch and returns 403", async () => {
    const nowMs = Date.parse("2026-04-16T21:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);

    await withTempConfig({
      prefix: "xgw-http-expired",
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
        stateModule.setExposure("xgw:corr-expired", {
          correlationId: "corr-expired",
          allowedPeer: "ember",
          createdAt: Date.now() / 1000 - 120,
          expiresAt: Date.now() / 1000 - 1,
        });

        await withGatewayServer({
          prefix: "xgw-http-expired",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/hooks/xgw",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "xgw:corr-expired",
                message: "ping",
                sourceSessionKey: "agent:main",
                nonce: "nonce-expired",
                timestamp: Math.floor(Date.now() / 1000),
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(403);
            expect(JSON.parse(getBody())).toEqual({
              ok: false,
              status: "forbidden",
              error: "session not accessible",
            });
            expect(subagent.run).not.toHaveBeenCalled();
          },
        });
      },
    });

    nowSpy.mockRestore();
  });
});
