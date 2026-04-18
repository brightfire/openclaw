/**
 * Ed25519 request signing and verification for XGW cross-gateway messaging.
 *
 * Implements the signature scheme from DESIGN.md §10.3:
 * - Payload canonicalization: XGW-SIGN-V1\n<ts>\n<nonce>\n<method>\n<path>\n<body-sha256-hex>
 * - Ed25519 signatures using Node.js built-in crypto
 * - Key format: PKCS8 DER (private), SPKI DER (public), base64-encoded
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

const SIGN_VERSION = "XGW-SIGN-V1";

/**
 * Build the canonical payload string for signing/verification.
 */
export function canonicalizePayload(
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  bodyBytes: Buffer,
): string {
  const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
  return `${SIGN_VERSION}\n${timestamp}\n${nonce}\n${method}\n${path}\n${bodyHash}`;
}

/**
 * Sign an XGW request.
 *
 * @param privateKeyB64 - Base64-encoded PKCS8 DER Ed25519 private key
 * @param method - HTTP method (e.g. "POST")
 * @param path - Request path (e.g. "/xgateway")
 * @param timestamp - Unix timestamp (seconds)
 * @param nonce - Request nonce (UUID)
 * @param bodyBytes - Raw request body bytes
 * @returns Base64-encoded Ed25519 signature
 */
export function signXgwRequest(
  privateKeyB64: string,
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  bodyBytes: Buffer,
): string {
  const payload = canonicalizePayload(method, path, timestamp, nonce, bodyBytes);

  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });

  const sig = sign(null, Buffer.from(payload), key);
  return sig.toString("base64");
}

/**
 * Verify an XGW request signature.
 *
 * @param signerName - Declared signer identity (from X-XGW-Signer header)
 * @param signatureB64 - Base64-encoded Ed25519 signature
 * @param method - HTTP method
 * @param path - Request path
 * @param timestamp - Unix timestamp (seconds)
 * @param nonce - Request nonce
 * @param bodyBytes - Raw request body bytes
 * @param trustedKeys - Map of peer name → base64 SPKI DER public key
 * @returns Authenticated peer name, or null if verification fails
 */
export function verifyXgwSignature(
  signerName: string,
  signatureB64: string,
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  bodyBytes: Buffer,
  trustedKeys: Record<string, string>,
): string | null {
  const pubKeyB64 = trustedKeys[signerName];
  if (!pubKeyB64) return null;

  try {
    const payload = canonicalizePayload(method, path, timestamp, nonce, bodyBytes);

    const key = createPublicKey({
      key: Buffer.from(pubKeyB64, "base64"),
      format: "der",
      type: "spki",
    });

    const valid = verify(
      null,
      Buffer.from(payload),
      key,
      Buffer.from(signatureB64, "base64"),
    );
    return valid ? signerName : null;
  } catch {
    return null;
  }
}

/**
 * Generate a new Ed25519 keypair for XGW authentication.
 *
 * @returns Object with base64-encoded public key (SPKI DER) and private key (PKCS8 DER)
 */
export function generateXgwKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}
