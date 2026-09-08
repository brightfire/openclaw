// Schema-level coverage for the persistent-sessionMode + sessionKey pairing
// rule on hook mappings. Mirrors the request-side validation in
// hooks-request-handler; both surfaces refuse persistent without a stable key
// to prevent the silent fall-through to a generated hook:<uuid> session.
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

function buildHooksConfig(mapping: Record<string, unknown>) {
  return {
    hooks: {
      enabled: true,
      token: "secret",
      mappings: [mapping],
    },
  };
}

describe("HookMappingSchema sessionMode + sessionKey pairing", () => {
  it("accepts persistent + sessionKey", () => {
    const result = OpenClawSchema.safeParse(
      buildHooksConfig({
        id: "ok-static",
        match: { path: "linear" },
        action: "agent",
        sessionMode: "persistent",
        sessionKey: "hook:linear:fixed",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts persistent + templated sessionKey", () => {
    const result = OpenClawSchema.safeParse(
      buildHooksConfig({
        id: "ok-templated",
        match: { path: "gmail" },
        action: "agent",
        sessionMode: "persistent",
        sessionKey: "hook:gmail:{{messages[0].id}}",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects persistent without sessionKey", () => {
    const result = OpenClawSchema.safeParse(
      buildHooksConfig({
        id: "bad-no-key",
        match: { path: "linear" },
        action: "agent",
        sessionMode: "persistent",
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((entry) => entry.message.includes("sessionKey"));
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/persistent.*sessionKey/);
    }
  });

  it("rejects persistent with whitespace-only sessionKey", () => {
    // renderOptional()/normalizeOptionalString() downstream trim sessionKey
    // and treat whitespace-only as absent. The parent superRefine checks
    // !sessionKey?.trim() the same way, so a whitespace-only key is treated
    // as absent and the mapping is rejected at load time.
    const result = OpenClawSchema.safeParse(
      buildHooksConfig({
        id: "bad-whitespace-key",
        match: { path: "linear" },
        action: "agent",
        sessionMode: "persistent",
        sessionKey: "   ",
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((entry) => entry.message.includes("sessionKey"));
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/persistent.*sessionKey/);
    }
  });

  it("accepts isolated without sessionKey", () => {
    const result = OpenClawSchema.safeParse(
      buildHooksConfig({
        id: "isolated-no-key",
        match: { path: "linear" },
        action: "agent",
        sessionMode: "isolated",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts persistent mapping with hooks.defaultSessionKey", () => {
    const result = OpenClawSchema.safeParse({
      hooks: {
        enabled: true,
        token: "secret",
        defaultSessionKey: "hook:card-update",
        mappings: [
          {
            id: "ok-default-key",
            match: { path: "linear" },
            action: "agent",
            sessionMode: "persistent",
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts mappings without sessionMode (defaults to isolated downstream)", () => {
    const result = OpenClawSchema.safeParse(
      buildHooksConfig({
        id: "no-mode",
        match: { path: "linear" },
        action: "agent",
      }),
    );
    expect(result.success).toBe(true);
  });
});
