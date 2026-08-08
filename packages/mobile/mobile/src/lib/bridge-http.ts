/**
 * Hardened response parsing for the desktop-bridge HTTP client (pure — no
 * Expo imports, tested under `bun test`).
 *
 * Version skew is the normal state for real users: a new phone routinely
 * talks to a pre-380 desktop that doesn't route `/bridge/file`,
 * `/bridge/upload`, `?d=`-scoped challenges or the `mobile:hello` channel.
 * Those requests don't fail cleanly — the desktop's authenticated catch-all
 * answers unrouted paths with the renderer's index.html (HTTP 200,
 * text/html), and Cloudflare answers a down tunnel with HTML error pages —
 * so a naive `response.json()` throws a raw "JSON Parse error: Unexpected
 * character: <" that used to surface verbatim in the chat. Every bridge
 * parse site goes through these helpers instead: non-JSON bodies become a
 * structured `BridgeEndpointUnavailableError` that capability gates treat as
 * a demote-to-legacy signal, never a user-visible parse error.
 */
import { isUnknownBridgeChannelError } from "./bridge-envelope";

export class BridgeEndpointUnavailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Desktop bridge endpoint unavailable (HTTP ${status}).`);
    this.name = "BridgeEndpointUnavailableError";
    this.status = status;
  }
}

/**
 * Read a response body as JSON without ever letting a raw parse error
 * escape. Lenient on content-type (some proxies mislabel JSON) but strict on
 * shape: anything that doesn't parse becomes BridgeEndpointUnavailableError.
 */
export const readBridgeJsonBody = async (
  response: Response,
): Promise<unknown> => {
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new BridgeEndpointUnavailableError(response.status);
  }
  const trimmed = text.trim();
  const contentType = (
    response.headers?.get?.("content-type") ?? ""
  ).toLowerCase();
  const looksJson =
    contentType.includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (!looksJson) {
    throw new BridgeEndpointUnavailableError(response.status);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new BridgeEndpointUnavailableError(response.status);
  }
};

/**
 * Extract a human-readable error from a failed bridge response. HTML/garbage
 * bodies (Cloudflare error pages, catch-all index.html) yield the status
 * fallback instead of raw markup or a parse error.
 */
export const readBridgeErrorMessage = async (
  response: Response,
  fallback?: string,
): Promise<string> => {
  const fallbackMessage =
    fallback ?? `Desktop bridge request failed (HTTP ${response.status}).`;
  try {
    const parsed = await readBridgeJsonBody(response);
    if (parsed && typeof parsed === "object") {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "string" && error.trim()) {
        return error.trim();
      }
    }
  } catch {
    // fall through
  }
  return fallbackMessage;
};

/**
 * True when a failure means "the desktop doesn't have this endpoint/channel"
 * — the signal to demote a negotiated capability and fall back to the legacy
 * path silently. Covers explicit channel rejections from the IPC whitelist
 * and the unrouted-path/error-page shapes above.
 */
export const isBridgeEndpointMissingError = (error: unknown): boolean => {
  if (error instanceof BridgeEndpointUnavailableError) return true;
  if (error instanceof Error && error.name === "BridgeEndpointUnavailableError") {
    return true;
  }
  return isUnknownBridgeChannelError(error);
};

/**
 * Fetch a bridge challenge with version-skew fallback. New desktops route
 * the `?d=<desktopDeviceId>` form (opaque 404 on mismatch, no id/key leak to
 * scanners); pre-380 desktops match `/bridge/challenge` by exact URL, so the
 * `?d=` form falls through to their authenticated catch-all (401 JSON, or an
 * HTML page behind some edges). On any non-JSON/non-OK answer to the scoped
 * form we retry the legacy bare URL once — the caller's device-id check on
 * the parsed body still rejects wrong desktops.
 *
 * `fetchFn` is injectable so the exact skew sequences are unit-testable.
 */
export const fetchBridgeChallengeBody = async (
  baseUrl: string,
  desktopDeviceId: string,
  fetchFn: (url: string) => Promise<Response> = (url) =>
    fetch(url, { method: "GET" }),
): Promise<unknown> => {
  const scoped = await fetchFn(
    `${baseUrl}/bridge/challenge?d=${encodeURIComponent(desktopDeviceId)}`,
  );
  if (scoped.ok) {
    try {
      return await readBridgeJsonBody(scoped);
    } catch {
      // fall through to the bare retry
    }
  }
  const bare = await fetchFn(`${baseUrl}/bridge/challenge`);
  if (!bare.ok) {
    throw new Error(
      await readBridgeErrorMessage(bare, "Desktop bridge request failed."),
    );
  }
  return await readBridgeJsonBody(bare);
};

/**
 * True when a message looks like a raw JSON parse failure (Hermes: "JSON
 * Parse error: Unexpected character: <"; V8: "Unexpected token < in JSON").
 * Used as a last-resort net so no such message ever reaches the user.
 */
export const isRawJsonParseErrorMessage = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("json parse") ||
    (lower.includes("unexpected") &&
      (lower.includes("token") || lower.includes("character")) &&
      lower.includes("json")) ||
    /unexpected (character|token|end of (json )?input)/i.test(message)
  );
};
