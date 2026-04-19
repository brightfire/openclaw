import { describe, expect, it } from "vitest";
import {
  canonicalizePayload,
  generateXgwKeypair,
  signXgwRequest,
  verifyXgwSignature,
} from "./signing.js";

describe("XGW Ed25519 signing", () => {
  const keypair = generateXgwKeypair();
  const keypair2 = generateXgwKeypair();

  const method = "POST";
  const path = "/xgateway";
  const timestamp = 1776216000;
  const nonce = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const bodyBytes = Buffer.from(JSON.stringify({ sessionKey: "receptionist", message: "hello" }));

  describe("generateXgwKeypair", () => {
    it("produces base64-encoded keys", () => {
      expect(keypair.publicKey).toBeTruthy();
      expect(keypair.privateKey).toBeTruthy();
      // Verify they're valid base64
      expect(() => Buffer.from(keypair.publicKey, "base64")).not.toThrow();
      expect(() => Buffer.from(keypair.privateKey, "base64")).not.toThrow();
    });

    it("produces unique keypairs", () => {
      expect(keypair.publicKey).not.toBe(keypair2.publicKey);
      expect(keypair.privateKey).not.toBe(keypair2.privateKey);
    });
  });

  describe("canonicalizePayload", () => {
    it("produces correct format", () => {
      const result = canonicalizePayload(method, path, timestamp, nonce, bodyBytes);
      const lines = result.split("\n");
      expect(lines).toHaveLength(6);
      expect(lines[0]).toBe("XGW-SIGN-V1");
      expect(lines[1]).toBe(String(timestamp));
      expect(lines[2]).toBe(nonce);
      expect(lines[3]).toBe(method);
      expect(lines[4]).toBe(path);
      // Line 5 is sha256 hex of body
      expect(lines[5]).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("signXgwRequest / verifyXgwSignature", () => {
    it("sign/verify round-trip succeeds", () => {
      const sig = signXgwRequest(keypair.privateKey, method, path, timestamp, nonce, bodyBytes);
      expect(sig).toBeTruthy();

      const trustedKeys = { aster: keypair.publicKey };
      const result = verifyXgwSignature(
        "aster", sig, method, path, timestamp, nonce, bodyBytes, trustedKeys,
      );
      expect(result).toBe("aster");
    });

    it("rejects tampered body", () => {
      const sig = signXgwRequest(keypair.privateKey, method, path, timestamp, nonce, bodyBytes);
      const tamperedBody = Buffer.from(JSON.stringify({ sessionKey: "receptionist", message: "tampered" }));

      const trustedKeys = { aster: keypair.publicKey };
      const result = verifyXgwSignature(
        "aster", sig, method, path, timestamp, nonce, tamperedBody, trustedKeys,
      );
      expect(result).toBeNull();
    });

    it("rejects wrong signer", () => {
      const sig = signXgwRequest(keypair.privateKey, method, path, timestamp, nonce, bodyBytes);

      // Use keypair2's public key for "aster" — signature was made with keypair1's private key
      const trustedKeys = { aster: keypair2.publicKey };
      const result = verifyXgwSignature(
        "aster", sig, method, path, timestamp, nonce, bodyBytes, trustedKeys,
      );
      expect(result).toBeNull();
    });

    it("rejects unknown signer", () => {
      const sig = signXgwRequest(keypair.privateKey, method, path, timestamp, nonce, bodyBytes);

      const trustedKeys = { aster: keypair.publicKey };
      const result = verifyXgwSignature(
        "unknown-peer", sig, method, path, timestamp, nonce, bodyBytes, trustedKeys,
      );
      expect(result).toBeNull();
    });

    it("rejects tampered timestamp", () => {
      const sig = signXgwRequest(keypair.privateKey, method, path, timestamp, nonce, bodyBytes);

      const trustedKeys = { aster: keypair.publicKey };
      const result = verifyXgwSignature(
        "aster", sig, method, path, timestamp + 1, nonce, bodyBytes, trustedKeys,
      );
      expect(result).toBeNull();
    });

    it("rejects tampered nonce", () => {
      const sig = signXgwRequest(keypair.privateKey, method, path, timestamp, nonce, bodyBytes);

      const trustedKeys = { aster: keypair.publicKey };
      const result = verifyXgwSignature(
        "aster", sig, method, path, timestamp, "different-nonce", bodyBytes, trustedKeys,
      );
      expect(result).toBeNull();
    });

    it("rejects tampered path", () => {
      const sig = signXgwRequest(keypair.privateKey, method, path, timestamp, nonce, bodyBytes);

      const trustedKeys = { aster: keypair.publicKey };
      const result = verifyXgwSignature(
        "aster", sig, method, "/xgateway/callback", timestamp, nonce, bodyBytes, trustedKeys,
      );
      expect(result).toBeNull();
    });
  });
});
