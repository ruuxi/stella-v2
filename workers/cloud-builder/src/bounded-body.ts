export type BoundedBodyFailure =
  | "invalid_content_length"
  | "too_large"
  | "missing_body"
  | "invalid_utf8"
  | "invalid_json";

export class BoundedBodyError extends Error {
  readonly reason: BoundedBodyFailure;

  constructor(reason: BoundedBodyFailure) {
    super(`Request body rejected: ${reason}.`);
    this.name = "BoundedBodyError";
    this.reason = reason;
  }
}

const assertLimit = (maxBytes: number): void => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Request body limit is invalid.");
  }
};

/**
 * Read a request body without trusting Content-Length as the only bound.
 *
 * Workers have considerably less isolate memory than the largest accepted
 * HTTP request. Every caller that intends to buffer a body must therefore
 * stop the stream as soon as its own route limit is crossed.
 */
export const readBoundedRequestBytes = async (
  request: Request,
  maxBytes: number,
  options: Readonly<{ requireBody?: boolean }> = {},
): Promise<Uint8Array> => {
  assertLimit(maxBytes);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new BoundedBodyError("invalid_content_length");
    }
    if (parsed > maxBytes) throw new BoundedBodyError("too_large");
  }
  if (!request.body) {
    if (options.requireBody) throw new BoundedBodyError("missing_body");
    return new Uint8Array();
  }

  return await readBoundedStreamBytes(request.body, maxBytes);
};

/**
 * Consume a stream into memory only while it stays inside an explicit bound.
 * This is shared by request ingress, bounded upstream responses, and the few
 * R2 metadata transforms that genuinely need random access to the body.
 */
export const readBoundedStreamBytes = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> => {
  assertLimit(maxBytes);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader
          .cancel("request body limit exceeded")
          .catch(() => undefined);
        throw new BoundedBodyError("too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const readBoundedResponseBytes = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> => {
  assertLimit(maxBytes);
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new BoundedBodyError("invalid_content_length");
    }
    if (parsed > maxBytes) throw new BoundedBodyError("too_large");
  }
  if (!response.body) return new Uint8Array();
  return await readBoundedStreamBytes(response.body, maxBytes);
};

export const readBoundedRequestText = async (
  request: Request,
  maxBytes: number,
  options: Readonly<{ requireBody?: boolean }> = {},
): Promise<string> => {
  const bytes = await readBoundedRequestBytes(request, maxBytes, options);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw new BoundedBodyError("invalid_utf8");
  }
};

export const readBoundedRequestJson = async (
  request: Request,
  maxBytes: number,
): Promise<unknown> => {
  const text = await readBoundedRequestText(request, maxBytes, {
    requireBody: true,
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundedBodyError("invalid_json");
  }
};
