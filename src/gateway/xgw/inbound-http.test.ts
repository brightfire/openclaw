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
    getRuntimeConfig: mockLoadConfig,
  };
});

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    loadConfig: mockLoadConfig,
    getRuntimeConfig: mockLoadConfig,
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

  it("serves POST /xgateway through the core gateway server", async () => {
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
              path: "/xgateway",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "receptionist",
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

  it("serves POST /xgateway/callback through the core gateway server", async () => {
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
              path: "/xgateway/callback",
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
            // Callback is delivered directly to sourceSessionKey — no xgw: prefix fabrication.
            expect(subagent.run).toHaveBeenCalledWith(
              expect.objectContaining({
                sessionKey: "agent:main",
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
              path: "/xgateway",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "xgw:corr-direct",
                message: "follow-up",
                sourceSessionKey: "agent:main",
                correlationId: "corr-direct",
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
              path: "/xgateway",
              authorization: "Bearer other-secret",
              body: {
                sessionKey: "xgw:corr-private",
                message: "steal session",
                sourceSessionKey: "agent:main",
                correlationId: "corr-forbidden-" + Date.now(),
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
              path: "/xgateway",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "xgw:does-not-exist",
                message: "ping",
                sourceSessionKey: "agent:main",
                correlationId: "corr-missing-session",
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

  it("accepts async requests and POSTs callback to the calling peer (receiver-side, no local state)", async () => {
    // In the new ownership model, the RECEIVER (Gateway B) does NOT create a
    // pendingCallback record. It just runs the worker and POSTs the result back
    // to the caller via /xgateway/callback.
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
              path: "/xgateway",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "receptionist",
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

        // Let the fire-and-forget async callback handler complete
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        await new Promise((resolve) => {
          setImmediate(resolve);
        });

        // Receiver should NOT have created a local pendingCallback record.
        // The caller (ember) owns the pending record, not the receiver.
        expect(stateModule.getPendingCallback("corr-async")).toBeUndefined();

        // Receiver SHOULD have POSTed the callback back to the calling peer.
        expect(mockFetch).toHaveBeenCalledWith(
          "http://ember.local/xgateway/callback",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining("corr-async"),
          }),
        );
      },
    });
  });

  it("on first failed outbound callback delivery, receiver does not crash and has no local state", async () => {
    // The RECEIVER does not track pendingCallback state. When the callback POST
    // fails on the first attempt, postCallbackWithRetry will retry in the
    // background (with 5s, 15s delays). Here we just verify the receiver
    // does not crash and does not create local state, and that the first
    // callback attempt was attempted at the correct URL.
    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);
    // Only fail the first attempt; simulate immediate resolution for the test.
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));
    // Subsequent attempts (retries) should be intercepted too
    mockFetch.mockResolvedValue({ ok: false, status: 502, text: vi.fn(async () => "bad gateway") });

    await withTempConfig({
      prefix: "xgw-http-async-fail",
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
          prefix: "xgw-http-async-fail",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/xgateway",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "receptionist",
                message: "ping async",
                sourceSessionKey: "agent:main",
                correlationId: "corr-fail",
                nonce: "nonce-fail",
                timestamp: Math.floor(Date.now() / 1000),
                async: true,
                callbackTimeoutSeconds: 60,
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            // Response is 200-accepted regardless of callback delivery
            expect(res.statusCode).toBe(200);
            expect(JSON.parse(getBody())).toMatchObject({
              ok: true,
              status: "accepted",
              correlationId: "corr-fail",
            });
          },
        });

        // Receiver has no local pending record — caller owns that
        expect(stateModule.getPendingCallback("corr-fail")).toBeUndefined();

        // Let the first async callback attempt happen
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        await new Promise((resolve) => {
          setImmediate(resolve);
        });

        // At least the first callback attempt was made to the caller's URL
        expect(mockFetch).toHaveBeenCalledWith(
          "http://ember.local/xgateway/callback",
          expect.objectContaining({ method: "POST" }),
        );

        // Receiver still has no local state
        expect(stateModule.getPendingCallback("corr-fail")).toBeUndefined();
      },
    });
  });

  it("returns 400 when authenticated peer matches gatewayName (circular self-send)", async () => {
    setGatewaySubagentRuntime(createSubagentRuntime());

    // Configure so that the gateway's own name is "ember" and the peer token
    // maps to "ember" — i.e., a request arrives claiming to be from ourselves.
    mockLoadConfig.mockReturnValue({
      fleet: {
        crossGateway: {
          enabled: true,
          gatewayName: "ember", // our own name
          acceptedTokens: { ember: "peer-secret" },
          peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
          exposureTtlSeconds: 300,
        },
      },
    });

    await withTempConfig({
      prefix: "xgw-http-self-send",
      cfg: {
        gateway: { trustedProxies: [] },
        fleet: {
          crossGateway: {
            enabled: true,
            gatewayName: "ember",
            acceptedTokens: { ember: "peer-secret" },
            peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
            exposureTtlSeconds: 300,
          },
        },
      },
      run: async () => {
        await withGatewayServer({
          prefix: "xgw-http-self-send",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/xgateway",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "receptionist",
                message: "hello from myself",
                sourceSessionKey: "agent:main",
                nonce: "nonce-self-send-abc123",
                timestamp: Math.floor(Date.now() / 1000),
                timeoutSeconds: 1,
              },
            });

            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(400);
            expect(JSON.parse(getBody())).toEqual({
              ok: false,
              status: "error",
              error: "circular send: cannot send to self",
            });
          },
        });
      },
    });
  });

  it("returns 400 when both async and multiTurn are true", async () => {
    setGatewaySubagentRuntime(createSubagentRuntime());

    await withTempConfig({
      prefix: "xgw-http-multiturn-reject",
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
          prefix: "xgw-http-multiturn-reject",
          resolvedAuth: AUTH_NONE,
          run: async (server) => {
            const req = createStreamingRequest({
              path: "/xgateway",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "xgw:test",
                message: "ping",
                sourceSessionKey: "agent:main",
                correlationId: "corr-mt-test",
                nonce: "nonce-mt",
                timestamp: Math.floor(Date.now() / 1000),
                async: true,
                multiTurn: true,
              },
            });

            const { res: resp, getBody } = createResponse();
            await dispatchRequest(server, req, resp);

            expect(resp.statusCode).toBe(400);
            expect(JSON.parse(getBody())).toEqual({
              ok: false,
              status: "error",
              error: "async and multiTurn are mutually exclusive",
            });
          },
        });
      },
    });
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
              path: "/xgateway",
              authorization: "Bearer peer-secret",
              body: {
                sessionKey: "xgw:corr-expired",
                message: "ping",
                sourceSessionKey: "agent:main",
                correlationId: "corr-expired-test",
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

  // ─── Auth rejection ───────────────────────────────────────────────────────

  it("returns 401 when no authorization header is present", async () => {
    await withGatewayServer({
      prefix: "xgw-no-auth-hdr",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = new EventEmitter() as IncomingMessage;
        req.method = "POST";
        req.url = "/xgateway";
        req.headers = { host: "localhost:18789", "content-type": "application/json" };
        req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
        setImmediate(() => {
          req.emit(
            "data",
            Buffer.from(JSON.stringify({ sessionKey: "receptionist", message: "ping" })),
          );
          req.emit("end");
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(401);
        expect(JSON.parse(getBody())).toEqual({
          ok: false,
          status: "error",
          error: "unauthorized",
        });
      },
    });
  });

  it("returns 401 when bearer token is invalid", async () => {
    await withGatewayServer({
      prefix: "xgw-bad-bearer",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer wrong-token",
          body: {
            sessionKey: "receptionist",
            message: "ping",
            nonce: "nonce-badbearer-zzz",
            timestamp: Math.floor(Date.now() / 1000),
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(401);
        expect(JSON.parse(getBody())).toEqual({
          ok: false,
          status: "error",
          error: "unauthorized",
        });
      },
    });
  });

  // ─── Input validation ────────────────────────────────────────────────────

  it("returns 400 for invalid JSON body", async () => {
    await withGatewayServer({
      prefix: "xgw-bad-json",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = new EventEmitter() as IncomingMessage;
        req.method = "POST";
        req.url = "/xgateway";
        req.headers = {
          host: "localhost:18789",
          authorization: "Bearer peer-secret",
          "content-type": "application/json",
        };
        req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
        setImmediate(() => {
          req.emit("data", Buffer.from("this is not json {{{}}} at all"));
          req.emit("end");
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(getBody());
        expect(body.ok).toBe(false);
      },
    });
  });

  it("returns 400 for missing sessionKey", async () => {
    await withGatewayServer({
      prefix: "xgw-missing-sk",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer peer-secret",
          body: {
            // sessionKey intentionally omitted
            message: "hello",
            correlationId: "corr-missing-sk-testval",
            nonce: "nonce-missing-sk-testval",
            timestamp: Math.floor(Date.now() / 1000),
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(getBody())).toEqual({
          ok: false,
          status: "error",
          error: "sessionKey and message required",
        });
      },
    });
  });

  it("returns 400 for missing correlationId", async () => {
    await withGatewayServer({
      prefix: "xgw-missing-corrid",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer peer-secret",
          body: {
            sessionKey: "receptionist",
            message: "hello",
            // correlationId intentionally omitted
            nonce: "nonce-missing-corrid",
            timestamp: Math.floor(Date.now() / 1000),
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(getBody())).toEqual({
          ok: false,
          status: "error",
          error: "missing required field: correlationId",
        });
      },
    });
  });

  it("returns 400 for missing nonce", async () => {
    await withGatewayServer({
      prefix: "xgw-missing-nonce",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer peer-secret",
          body: {
            sessionKey: "receptionist",
            message: "hello",
            correlationId: "corr-missing-nonce-test",
            // nonce intentionally omitted
            timestamp: Math.floor(Date.now() / 1000),
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(getBody())).toEqual({
          ok: false,
          status: "error",
          error: "missing required field: nonce",
        });
      },
    });
  });

  it("returns 413 when payload exceeds the 1 MB body size limit", async () => {
    await withGatewayServer({
      prefix: "xgw-large-payload",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = new EventEmitter() as IncomingMessage;
        req.method = "POST";
        req.url = "/xgateway";
        req.headers = {
          host: "localhost:18789",
          authorization: "Bearer peer-secret",
          "content-type": "application/json",
        };
        req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
        // readJsonBody calls req.destroy() when the limit is exceeded
        (req as unknown as { destroy: () => void }).destroy = () => {};
        setImmediate(() => {
          // 1 MiB + 1 byte exceeds the limit
          req.emit("data", Buffer.alloc(1048577, 65 /* 'A' */));
          req.emit("end");
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(413);
        expect(JSON.parse(getBody())).toEqual({
          ok: false,
          status: "error",
          error: "payload too large",
        });
      },
    });
  });

  // ─── Enforcement ─────────────────────────────────────────────────────────

  it("returns 503 when XGW is disabled", async () => {
    mockLoadConfig.mockReturnValue({ fleet: { crossGateway: { enabled: false } } });

    await withGatewayServer({
      prefix: "xgw-disabled-enforcement",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        // /xgateway should return 503
        const req1 = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer peer-secret",
          body: {},
        });
        const resp1 = createResponse();
        await dispatchRequest(server, req1, resp1.res);
        expect(resp1.res.statusCode).toBe(503);

        // /xgateway/callback should also return 503
        const req2 = createStreamingRequest({
          path: "/xgateway/callback",
          authorization: "Bearer peer-secret",
          body: {},
        });
        const resp2 = createResponse();
        await dispatchRequest(server, req2, resp2.res);
        expect(resp2.res.statusCode).toBe(503);
      },
    });
  });

  it("returns 503 when maxConcurrent is exceeded", async () => {
    const subagent = createSubagentRuntime();
    setGatewaySubagentRuntime(subagent);

    mockLoadConfig.mockReturnValue({
      fleet: {
        crossGateway: {
          enabled: true,
          acceptedTokens: { ember: "peer-secret" },
          peers: { ember: { url: "http://ember.local", token: "peer-secret" } },
          exposureTtlSeconds: 300,
          maxConcurrent: 1,
        },
      },
    });

    const stateModule = await import("./state.js");
    // Pre-saturate the exposure table so getActiveSessionCount() >= maxConcurrent
    stateModule.setExposure("xgw:slot-taken", {
      correlationId: "slot-taken",
      allowedPeer: "ember",
      createdAt: Date.now() / 1000,
      expiresAt: Date.now() / 1000 + 600,
    });

    await withGatewayServer({
      prefix: "xgw-max-conc",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer peer-secret",
          body: {
            sessionKey: "receptionist",
            message: "ping",
            sourceSessionKey: "agent:main",
            correlationId: "corr-overflow",
            nonce: "nonce-max-conc-test-abc",
            timestamp: Math.floor(Date.now() / 1000),
            timeoutSeconds: 1,
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({
          ok: false,
          status: "capacity_exceeded",
          error: "capacity exceeded",
        });
        expect(subagent.run).not.toHaveBeenCalled();
      },
    });
  });

  // ─── Nonce / timestamp validation ────────────────────────────────────────

  it("returns 409 when a nonce is replayed by the same peer", async () => {
    await withGatewayServer({
      prefix: "xgw-nonce-replay",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const replayNonce = "nonce-replay-unique-aaabbbccc";
        const ts = Math.floor(Date.now() / 1000);

        // First request: nonce is fresh; session doesn't exist → 403 (nonce is recorded)
        const req1 = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer peer-secret",
          body: {
            sessionKey: "xgw:replay-test-nonexistent",
            message: "first",
            sourceSessionKey: "agent:main",
            correlationId: "corr-replay-test-1",
            nonce: replayNonce,
            timestamp: ts,
          },
        });
        const resp1 = createResponse();
        await dispatchRequest(server, req1, resp1.res);
        expect(resp1.res.statusCode).toBe(403); // session not accessible — nonce recorded

        // Second request with same nonce → 409 duplicate nonce
        const req2 = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer peer-secret",
          body: {
            sessionKey: "xgw:replay-test-nonexistent",
            message: "second",
            sourceSessionKey: "agent:main",
            correlationId: "corr-replay-test-2",
            nonce: replayNonce,
            timestamp: ts,
          },
        });
        const resp2 = createResponse();
        await dispatchRequest(server, req2, resp2.res);
        expect(resp2.res.statusCode).toBe(409);
        expect(JSON.parse(resp2.getBody())).toEqual({
          ok: false,
          status: "error",
          error: "duplicate nonce",
        });
      },
    });
  });

  it("returns 400 when timestamp is older than 5 minutes", async () => {
    await withGatewayServer({
      prefix: "xgw-old-ts",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createStreamingRequest({
          path: "/xgateway",
          authorization: "Bearer peer-secret",
          body: {
            sessionKey: "receptionist",
            message: "ping",
            correlationId: "corr-stale-timestamp",
            nonce: "nonce-stale-timestamp-qqqrrr",
            timestamp: Math.floor(Date.now() / 1000) - 301, // 5 min + 1 sec old
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(getBody())).toEqual({
          ok: false,
          status: "error",
          error: "request expired",
        });
      },
    });
  });

  // ─── Callback paths ──────────────────────────────────────────────────────

  it("returns 403 when callback is posted by the wrong peer", async () => {
    const stateModule = await import("./state.js");
    stateModule.setPendingCallback("corr-wrong-cb-peer", {
      sourceSessionKey: "agent:main",
      allowedPeer: "ember", // only ember may deliver
      createdAt: Date.now() / 1000,
      expiresAt: Date.now() / 1000 + 600,
      status: "pending",
    });

    await withGatewayServer({
      prefix: "xgw-cb-wrong-peer",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        // Post callback using "other" peer token (other-secret), not "ember"
        const req = createStreamingRequest({
          path: "/xgateway/callback",
          authorization: "Bearer other-secret",
          body: {
            correlationId: "corr-wrong-cb-peer",
            status: "ok",
            reply: "unauthorized payload",
            nonce: "nonce-wrong-cb-peer-xyz123",
            timestamp: Math.floor(Date.now() / 1000),
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(403);
        expect(JSON.parse(getBody())).toEqual({ ok: false, error: "unauthorized" });
      },
    });
  });

  it("returns 200 already_delivered when the same callback correlationId is posted twice", async () => {
    const stateModule = await import("./state.js");
    // Pre-mark the callback as already delivered
    stateModule.setPendingCallback("corr-double-deliver", {
      sourceSessionKey: "agent:main",
      allowedPeer: "ember",
      createdAt: Date.now() / 1000,
      expiresAt: Date.now() / 1000 + 600,
      status: "delivered",
      deliveredAt: Date.now() / 1000 - 5,
    });

    await withGatewayServer({
      prefix: "xgw-cb-idempotent",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createStreamingRequest({
          path: "/xgateway/callback",
          authorization: "Bearer peer-secret",
          body: {
            correlationId: "corr-double-deliver",
            status: "ok",
            reply: "already done",
            nonce: "nonce-double-deliver-qqqzzz",
            timestamp: Math.floor(Date.now() / 1000),
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ok: true, status: "already_delivered" });
      },
    });
  });

  it("returns 410 when callback has expired", async () => {
    const stateModule = await import("./state.js");
    stateModule.setPendingCallback("corr-cb-past-expiry", {
      sourceSessionKey: "agent:main",
      allowedPeer: "ember",
      createdAt: Date.now() / 1000 - 700,
      expiresAt: Date.now() / 1000 - 1, // expired 1 second ago
      status: "pending",
    });

    await withGatewayServer({
      prefix: "xgw-cb-expired",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createStreamingRequest({
          path: "/xgateway/callback",
          authorization: "Bearer peer-secret",
          body: {
            correlationId: "corr-cb-past-expiry",
            status: "ok",
            reply: "too late",
            nonce: "nonce-expired-cb-pastexpiry",
            timestamp: Math.floor(Date.now() / 1000),
          },
        });

        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(410);
        expect(JSON.parse(getBody())).toEqual({ ok: false, error: "callback expired" });
      },
    });
  });

  // ─── Misc ─────────────────────────────────────────────────────────────────

  it("recovers from a corrupt state file on startup", async () => {
    const stateModule = await import("./state.js");

    // Use the module's own getStateDir() so the path always matches what loadState reads.
    const stateDir = stateModule.getStateDir();
    const stateFile = stateModule.getStateFile();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, "{corrupt json {{{");

    const stderrMessages: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((msg: unknown) => {
      stderrMessages.push(String(msg));
      return true;
    });
    try {
      // loadState must not throw on a corrupt file
      expect(() => stateModule.loadState()).not.toThrow();
    } finally {
      stderrSpy.mockRestore();
    }

    // loadState should log a warning about the corrupt file
    expect(stderrMessages.some((m) => m.includes("loadState failed"))).toBe(true);
  });

  it("resolveEnvValue resolves ${ENV_VAR} tokens to environment variable values", async () => {
    const { resolveEnvValue } = await import("./utils.js");

    process.env.XGW_TEST_RESOLVE_TOKEN = "resolved-from-env";
    try {
      expect(resolveEnvValue("${XGW_TEST_RESOLVE_TOKEN}")).toBe("resolved-from-env");
    } finally {
      delete process.env.XGW_TEST_RESOLVE_TOKEN;
    }

    // Missing env var falls back to the literal string
    expect(resolveEnvValue("${XGW_NONEXISTENT_VAR_QWERTYYYYY}")).toBe(
      "${XGW_NONEXISTENT_VAR_QWERTYYYYY}",
    );

    // Plain strings pass through unchanged
    expect(resolveEnvValue("static-token")).toBe("static-token");
  });
});
