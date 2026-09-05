/**
 * Shared gateway-mode plumbing for the provider adapters.
 *
 * The Stella model gateway's managed lane is request/response: the adapter
 * sends `stream: false` and receives ONE complete
 * provider-native JSON object, which it then converts into the streaming
 * event protocol the agent loop consumes. Detection is purely by baseUrl
 * (`<gatewayOrigin>/v1/relay`), so a missing or renamed header can never
 * silently route a capability token to a direct provider.
 */
import {
  GATEWAY_REQUEST_ID_HEADER,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
  isGatewayRelayBaseUrl,
} from "@stella/contracts/gateway/api";

export { isGatewayRelayBaseUrl };

/**
 * Explicit per-request timeout for a gateway completion. The gateway holds
 * the connection open while it streams from the provider internally, so the
 * client has to wait as long as one managed completion may legitimately
 * take; the gateway's own ceiling is the hard upper bound.
 */
export const GATEWAY_REQUEST_TIMEOUT_MS = Math.min(
  30 * 60 * 1000,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
);

/** Fresh idempotency id for exactly one physical gateway request. */
export const newGatewayRequestId = (): string =>
  (globalThis as { crypto?: Crypto }).crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

/** Per-attempt headers a gateway request must carry. */
export const gatewayRequestHeaders = (): Record<string, string> => ({
  [GATEWAY_REQUEST_ID_HEADER]: newGatewayRequestId(),
});

/** Header names the adapter mints per physical request; static copies are dropped. */
export const isPerRequestIdentityHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  return lower === "idempotency-key" || lower === GATEWAY_REQUEST_ID_HEADER;
};
