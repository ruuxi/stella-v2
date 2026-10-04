import { BoundedBodyError, readBoundedRequestText } from "./bounded-body.js";

const KiB = 1024;
const MiB = 1024 * KiB;

export const CLOUD_BUILDER_BODY_LIMITS = {
  tinyControl: 64 * KiB,
  turn: 2 * MiB,
  conversationAppend: 5 * MiB,
  localTurnFinish: 17 * MiB,
  // This route currently carries JSON inside JSON (`userMessageJson`). Keep the
  // outer request well below the isolate ceiling because buffering, UTF-8
  // decoding, and both JSON parses coexist transiently. Restoring the prior
  // 64 MiB product limit requires a streaming/direct-body protocol.
  localTurnBegin: 8 * MiB,
} as const;

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
