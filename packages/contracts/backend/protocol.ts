/**
 * The Stella backend's client protocol: one RPC route for calls and one
 * socket for live views, both on the backend worker's origin.
 *
 * A call runs once and returns. A view is a read the client subscribes to;
 * the owner's Durable Object reruns every open view after each write and
 * pushes the ones whose value changed. There is no dependency tracking: views
 * are SQLite reads inside one object, so rerunning them is cheaper than
 * deciding which ones could have changed.
 *
 *   POST /api/rpc/<name>   body `{ args }` → `RpcResponse`
 *   GET  /owners/me/live   WebSocket, subprotocol `LIVE_SUBPROTOCOL`
 *
 * Both authenticate with the user's JWT: `Authorization: Bearer` for calls,
 * and the `stella.token.<jwt>` subprotocol offer for the socket (browsers and
 * React Native cannot set WebSocket headers, and URLs get logged).
 */

export const RPC_PATH_PREFIX = "/api/rpc/";
export const LIVE_PATH = "/owners/me/live";
export const LIVE_SUBPROTOCOL = "stella.live.v1";
/** Prefix of the subprotocol offer that carries the JWT. */
export const LIVE_TOKEN_SUBPROTOCOL_PREFIX = "stella.token.";

export const rpcPath = (name: string): string =>
  `${RPC_PATH_PREFIX}${encodeURIComponent(name)}`;

export type BackendErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "INTERNAL";

export type BackendError = {
  code: BackendErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** A domain-specific discriminator clients branch on, e.g. `owner_generation_stale`. */
  reason?: string;
};

/** The owner reset or deleted their data after the caller read its generation. */
export const OWNER_GENERATION_STALE = "owner_generation_stale";

export type RpcResponse<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: BackendError };

/** HTTP status for an RPC error, so proxies and logs see the right class. */
export const rpcErrorStatus = (code: BackendErrorCode): number => {
  switch (code) {
    case "BAD_REQUEST":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "UNAVAILABLE":
      return 503;
    case "INTERNAL":
      return 500;
  }
};

export type LiveClientFrame =
  | { t: "sub"; id: string; view: string; args: unknown }
  | { t: "unsub"; id: string }
  /** A fresh JWT for a socket whose token is about to expire. */
  | { t: "auth"; token: string }
  | { t: "ping" };

export type LiveServerFrame =
  | { t: "value"; id: string; value: unknown }
  | { t: "error"; id: string; error: BackendError }
  /** Send a fresh token with an `auth` frame before `expiresAtMs`. */
  | { t: "reauth"; expiresAtMs: number }
  | { t: "pong" };

/** Socket close codes the client acts on. */
export const LIVE_CLOSE = {
  /** The token expired or was rejected: get a new one, then reconnect. */
  unauthenticated: 4401,
  /** Malformed frames; reconnecting with the same client won't help. */
  protocol: 4400,
  /** Server-side failure; reconnect with backoff. */
  internal: 4500,
} as const;

export const LIVE_MAX_FRAME_BYTES = 64 * 1024;
export const LIVE_MAX_SUBSCRIPTIONS = 128;
