/**
 * This computer's half of a paired phone's request, relayed by the owner gate
 * over the presence socket (`@stella/contracts/turn-plane/device-requests`).
 *
 * The app answers the request (it owns the file-access policy and the voice
 * runtime); this module only frames the answer: a `response.start`, the body
 * in base64 chunks small enough for a presence frame, then `response.end`.
 */

import {
  DEVICE_REQUEST_LIMITS,
  isDeviceRequestMethod,
  type DeviceRequestDeviceFrame,
  type DeviceRequestErrorCode,
  type DeviceRequestMethod,
} from "@stella/contracts/turn-plane/device-requests";

export type DeviceRequestAnswer =
  | {
      ok: true;
      contentType: string;
      /** The response body, base64-encoded. */
      bodyBase64: string;
    }
  | { ok: false; code: DeviceRequestErrorCode; message: string };

export type ServeDeviceRequest = (request: {
  method: DeviceRequestMethod;
  params: Record<string, unknown>;
  mobileDeviceId: string;
}) => Promise<DeviceRequestAnswer>;

const ERROR_CODES = new Set<DeviceRequestErrorCode>([
  "device_offline",
  "device_busy",
  "timeout",
  "forbidden",
  "not_found",
  "too_large",
  "bad_request",
  "unauthorized",
  "failed",
]);

/** Keep each chunk's base64 a multiple of 4 so every chunk decodes alone. */
const CHUNK_BASE64_CHARS =
  Math.floor((DEVICE_REQUEST_LIMITS.chunkBytes * 4) / 3 / 4) * 4;

export class DeviceRequestServer {
  private readonly canceled = new Set<string>();
  private readonly active = new Set<string>();

  constructor(
    private readonly options: {
      serve: ServeDeviceRequest | undefined;
      send: (frame: DeviceRequestDeviceFrame) => boolean;
      log: (message: string, error?: unknown) => void;
    },
  ) {}

  cancel(requestId: string): void {
    if (this.active.has(requestId)) this.canceled.add(requestId);
  }

  /** Answer one request without blocking the socket's frame loop. */
  handle(frame: {
    requestId: string;
    method: unknown;
    paramsJson: string;
    mobileDeviceId: string;
  }): void {
    const requestId = frame.requestId;
    if (typeof requestId !== "string" || !requestId || this.active.has(requestId)) {
      return;
    }
    this.active.add(requestId);
    void this.answer(frame)
      .catch((error) => {
        this.options.log("A phone request could not be answered.", error);
        this.fail(requestId, "failed", "Your computer could not answer that request.");
      })
      .finally(() => {
        this.active.delete(requestId);
        this.canceled.delete(requestId);
      });
  }

  private fail(requestId: string, code: DeviceRequestErrorCode, message: string) {
    this.options.send({ type: "response.error", requestId, code, message });
  }

  private async answer(frame: {
    requestId: string;
    method: unknown;
    paramsJson: string;
    mobileDeviceId: string;
  }): Promise<void> {
    const { requestId } = frame;
    if (!this.options.serve) {
      this.fail(requestId, "failed", "This version of Stella can't answer phone requests.");
      return;
    }
    if (!isDeviceRequestMethod(frame.method)) {
      this.fail(requestId, "bad_request", "Unknown request.");
      return;
    }
    let params: unknown;
    try {
      params = JSON.parse(frame.paramsJson);
    } catch {
      params = null;
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      this.fail(requestId, "bad_request", "Malformed request.");
      return;
    }
    const answer = await this.options.serve({
      method: frame.method,
      params: params as Record<string, unknown>,
      mobileDeviceId: frame.mobileDeviceId,
    });
    if (this.canceled.has(requestId)) return;
    if (!answer.ok) {
      this.fail(
        requestId,
        ERROR_CODES.has(answer.code) ? answer.code : "failed",
        answer.message,
      );
      return;
    }
    const body = answer.bodyBase64;
    const sizeBytes = Math.floor((body.length * 3) / 4) -
      (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
    if (sizeBytes > DEVICE_REQUEST_LIMITS.responseBytes) {
      this.fail(requestId, "too_large", "That file is too large to open on your phone.");
      return;
    }
    if (
      !this.options.send({
        type: "response.start",
        requestId,
        contentType: answer.contentType,
        sizeBytes,
      })
    ) {
      return;
    }
    for (let offset = 0; offset < body.length; offset += CHUNK_BASE64_CHARS) {
      if (this.canceled.has(requestId)) return;
      const sent = this.options.send({
        type: "response.chunk",
        requestId,
        data: body.slice(offset, offset + CHUNK_BASE64_CHARS),
      });
      if (!sent) return;
      // Yield between chunks so a large file never starves the socket's
      // pings or the dispatch frames sharing it.
      if ((offset / CHUNK_BASE64_CHARS) % 16 === 15) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.options.send({ type: "response.end", requestId });
  }
}
