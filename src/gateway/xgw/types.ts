/**
 * Cross-Gateway (XGW) shared types for OpenClaw.
 *
 * Implements the design from ~/.openclaw/projects/cross-gateway-xgw/DESIGN.md
 * and the proven implementation in ~/.openclaw/extensions/skynet/index.ts.
 */

/**
 * Fleet XGW configuration section.
 */
export interface XgwConfig {
  enabled?: boolean;
  /** This gateway's name (e.g. "aster", "ember"). */
  gatewayName?: string;
  /** Agent ID to use for cross-gateway worker sessions (default: "skynet"). */
  agentId?: string;
  /** Max simultaneous XGW sessions per gateway. */
  maxConcurrent?: number;
  /** Max pending async callbacks per gateway. */
  maxPendingAsync?: number;
  /** Inbound tokens mapped to peer identities. */
  acceptedTokens?: Record<string, string>;
  /** Peer gateway configurations. */
  peers?: Record<string, XgwPeerConfig>;
  /** Receptionist session key (for dispatcher routing). */
  receptionist?: { sessionKey?: string };
}

export interface XgwPeerConfig {
  /** Peer gateway URL (e.g. "http://10.18.32.20:18789"). */
  url?: string;
  /** Token to authenticate outbound requests to this peer. */
  token?: string;
}

/**
 * Inbound XGW request body.
 */
export interface XgwInboundRequest {
  sessionKey: string;
  message: string;
  sourceSessionKey: string;
  sourceChannel?: string;
  correlationId: string;
  nonce: string;
  timestamp: number;
  timeoutSeconds?: number;
  multiTurn?: boolean;
  async?: boolean;
  callbackTimeoutSeconds?: number;
  replyBack?: boolean;
}

/**
 * Inbound XGW response.
 */
export interface XgwInboundResponse {
  ok: boolean;
  runId?: string;
  status?: string;
  sessionKey?: string;
  reply?: string | null;
  error?: string;
  correlationId?: string;
}

/**
 * Async callback request body.
 */
export interface XgwCallbackRequest {
  correlationId: string;
  sessionKey: string;
  status: "ok" | "error" | "timeout" | "cancelled";
  reply?: string;
  error?: string;
  nonce: string;
  timestamp: number;
}

/**
 * Exposure table entry for dispatcher-spawned worker sessions.
 */
export interface XgwExposureEntry {
  correlationId: string;
  allowedPeer: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Pending async callback record.
 */
export interface XgwPendingCallback {
  sourceSessionKey: string;
  allowedPeer: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "delivered" | "expired";
}

/**
 * Outbound dispatch result.
 */
export interface XgwOutboundResult {
  runId: string;
  status: string;
  reply?: string | null;
  sessionKey?: string;
  error?: string;
}

/**
 * Session key prefix used by the XGW dispatcher.
 */
export const XGW_SESSION_PREFIX = "xgw:";

/**
 * HTTP path for the inbound XGW endpoint.
 */
export const XGW_HOOK_PATH = "/hooks/xgw";

/**
 * HTTP path for XGW callback delivery.
 */
export const XGW_CALLBACK_PATH = "/hooks/xgw/callback";

/**
 * Configured XGW session key for agents to use as a cross-gateway entry point.
 * e.g. "@ember/skynet" -> gateway=ember, sessionKey=skynet
 */
export const XGW_DISPATCHER_KEY = "skynet";
