import { GatewayError } from "./errors.js";
import { MAX_REQUEST_BYTES } from "./protocol.js";

const readBoundedBytes = async (request: Request): Promise<Uint8Array> => {
  if (!request.body) throw new GatewayError("bad_request", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        await reader.cancel("request body too large").catch(() => undefined);
        throw new GatewayError("bad_request", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const readJsonBody = async (request: Request): Promise<unknown> => {
  if (request.method !== "POST") {
    throw new GatewayError("method_not_allowed", 405);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new GatewayError("bad_request", 415);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new GatewayError("bad_request", 400);
    }
    if (declaredLength > MAX_REQUEST_BYTES) {
      throw new GatewayError("bad_request", 413);
    }
  }
  const bytes = await readBoundedBytes(request);
  if (bytes.byteLength < 2) {
    throw new GatewayError("bad_request", 400);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw new GatewayError("bad_request", 400);
  }
};
