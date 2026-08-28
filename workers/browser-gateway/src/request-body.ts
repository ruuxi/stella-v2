import { GatewayError } from "./errors.js";
import { MAX_REQUEST_BYTES } from "./protocol.js";

export const readJsonBody = async (request: Request): Promise<unknown> => {
  if (request.method !== "POST") {
    throw new GatewayError("method_not_allowed", 405);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new GatewayError("bad_request", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new GatewayError("bad_request", 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new GatewayError(
      "bad_request",
      bytes.byteLength > MAX_REQUEST_BYTES ? 413 : 400,
    );
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw new GatewayError("bad_request", 400);
  }
};
