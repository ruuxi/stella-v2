import { BoundedBodyError, readBoundedRequestText } from "./bounded-body.js";

const KiB = 1024;
const MiB = 1024 * KiB;

export const CLOUD_BUILDER_BODY_LIMITS = {
  tinyControl: 64 * KiB,
  control: 1 * MiB,
  turn: 2 * MiB,
  conversationAppend: 5 * MiB,
  localTurnFinish: 17 * MiB,
  // This route currently carries JSON inside JSON (`userMessageJson`). Keep the
  // outer request well below the isolate ceiling because buffering, UTF-8
  // decoding, and both JSON parses coexist transiently. Restoring the prior
  // 64 MiB product limit requires a streaming/direct-body protocol.
  localTurnBegin: 8 * MiB,
} as const;

/** Public JWT-authenticated routes that buffer JSON in a conversation DO. */
export const publicJsonBodyLimit = (
  method: string,
  pathname: string,
): number | null => {
  if (method !== "POST") return null;
  if (/^\/conversations\/[^/]+\/turns$/u.test(pathname)) {
    return CLOUD_BUILDER_BODY_LIMITS.turn;
  }
  if (/^\/conversations\/[^/]+\/journal$/u.test(pathname)) {
    return CLOUD_BUILDER_BODY_LIMITS.conversationAppend;
  }
  if (pathname === "/owners/me/dispatches") {
    return CLOUD_BUILDER_BODY_LIMITS.turn;
  }
  if (/^\/owners\/me\/dispatches\/[^/]+\/cancel$/u.test(pathname)) {
    return CLOUD_BUILDER_BODY_LIMITS.tinyControl;
  }
  const localTurn = pathname.match(
    /^\/conversations\/[^/]+\/local-turns\/(begin|finish)$/u,
  );
  if (localTurn?.[1] === "begin") {
    return CLOUD_BUILDER_BODY_LIMITS.localTurnBegin;
  }
  if (localTurn?.[1] === "finish") {
    return CLOUD_BUILDER_BODY_LIMITS.localTurnFinish;
  }
  return null;
};

/**
 * Server-to-server routes that consume or forward a buffered JSON body.
 * Unknown and bodyless routes stay unconsumed so a 404 cannot be turned into
 * an unauthenticated request-body sink.
 */
export const serviceJsonBodyLimit = (
  method: string,
  pathname: string,
): number | null => {
  if (method !== "POST" || pathname === "/m0/echo") return null;
  if (/^\/sessions\/[^/]+\/(turns|cancel)$/u.test(pathname)) {
    return pathname.endsWith("/turns")
      ? CLOUD_BUILDER_BODY_LIMITS.turn
      : CLOUD_BUILDER_BODY_LIMITS.tinyControl;
  }
  if (
    /^\/conversations\/[^/]+\/(cards|purge|cancel)$/u.test(pathname) ||
    /^\/internal\/dev-acceptance\/conversations\/[^/]+\/probe$/u.test(
      pathname,
    ) ||
    pathname === "/owners/purge/begin" ||
    pathname === "/owners/purge/release" ||
    pathname === "/owners/memory-wipe" ||
    pathname === "/routes/activate" ||
    pathname === "/routes/suspend" ||
    pathname === "/internal/owners/activity/register" ||
    pathname === "/internal/owners/activity/unregister" ||
    pathname === "/internal/owners/snapshot-changed"
  ) {
    return CLOUD_BUILDER_BODY_LIMITS.tinyControl;
  }
  if (
    pathname === "/internal/conversation-edits/run" ||
    pathname === "/internal/owners/transfer-product-state" ||
    pathname === "/internal/owners/transfer-ack" ||
    /^\/internal\/conversations\/[^/]+\/transfer-owner$/u.test(pathname)
  ) {
    return CLOUD_BUILDER_BODY_LIMITS.control;
  }
  if (pathname === "/owners/purge") {
    return CLOUD_BUILDER_BODY_LIMITS.conversationAppend;
  }
  if (
    pathname === "/internal/interactions/status" ||
    pathname === "/internal/interactions/live-view" ||
    pathname === "/internal/interactions/session-transfer-capability" ||
    pathname === "/internal/interactions/session-transfer" ||
    pathname === "/internal/interactions/decision" ||
    pathname === "/internal/owners/profile/reset"
  ) {
    return CLOUD_BUILDER_BODY_LIMITS.tinyControl;
  }
  return null;
};

/**
 * Buffer and validate one JSON request while retaining its exact bytes for a
 * downstream Durable Object. Chunked requests are counted as they stream; the
 * Content-Length header is only an early rejection hint, never authority.
 */
export const bufferBoundedJsonRequest = async (
  request: Request,
  maxBytes: number,
): Promise<Request> => {
  const body = await readBoundedRequestText(request, maxBytes, {
    requireBody: true,
  });
  try {
    JSON.parse(body);
  } catch {
    throw new BoundedBodyError("invalid_json");
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    redirect: request.redirect,
  });
};

export const boundedBodyStatus = (error: unknown): 400 | 413 | null =>
  error instanceof BoundedBodyError
    ? error.reason === "too_large"
      ? 413
      : 400
    : null;
