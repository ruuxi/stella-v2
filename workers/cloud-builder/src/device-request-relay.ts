/**
 * The owner gate's half of a paired phone's request to one of the owner's
 * computers (`packages/contracts/turn-plane/device-requests.ts`).
 *
 * The phone's HTTP request stays open while the computer answers over its
 * presence socket; each response frame is written straight into that open
 * response. Nothing is buffered beyond the stream's own queue and nothing is
 * stored: when the request ends, so does every byte of it.
 *
 * Pending requests live in memory only. That is sound because the phone's
 * open request keeps this Durable Object resident: if the object goes away,
 * the request it was serving went with it.
 */

import {
  DEVICE_REQUEST_ERROR_STATUS,
  DEVICE_REQUEST_IDLE_TIMEOUT_MS,
  DEVICE_REQUEST_LIMITS,
  deviceRequestStartTimeoutMs,
  type DeviceRequestDeviceFrame,
  type DeviceRequestErrorCode,
  type DeviceRequestMethod,
  type DeviceRequestServerFrame,
} from "@stella/contracts/turn-plane/device-requests";

type Pending = {
  requestId: string;
  deviceId: string;
  method: DeviceRequestMethod;
  socket: WebSocket;
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set until the computer starts answering. */
  resolveStart: ((response: Response) => void) | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
};

export type DeviceRequestRelayHost = {
  /** The device's one proven presence socket, when it is online. */
  liveSocket: (deviceId: string) => WebSocket | null;
  send: (socket: WebSocket, frame: DeviceRequestServerFrame) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
};

const noStore = { "cache-control": "no-store" } as const;

export const deviceRequestErrorResponse = (
  code: DeviceRequestErrorCode,
  message: string,
): Response =>
  Response.json(
    { error: { code, message } },
    { status: DEVICE_REQUEST_ERROR_STATUS[code], headers: noStore },
  );

const decodeBase64 = (data: string): Uint8Array | null => {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

const OFFLINE_MESSAGE =
  "Your computer is offline. Open Stella on it and try again.";

export class DeviceRequestRelay {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly host: DeviceRequestRelayHost) {}

  /** Relay one request to `deviceId` and resolve with the phone's response. */
  async open(input: {
    deviceId: string;
    mobileDeviceId: string;
    requestId: string;
    method: DeviceRequestMethod;
    paramsJson: string;
  }): Promise<Response> {
    const socket = this.host.liveSocket(input.deviceId);
    if (!socket) return deviceRequestErrorResponse("device_offline", OFFLINE_MESSAGE);
    if (this.pending.has(input.requestId)) {
      return deviceRequestErrorResponse("bad_request", "That request id is already in use.");
    }
    let inFlight = 0;
    for (const entry of this.pending.values()) {
      if (entry.deviceId === input.deviceId) inFlight += 1;
    }
    if (inFlight >= DEVICE_REQUEST_LIMITS.concurrentPerDevice) {
      return deviceRequestErrorResponse(
        "device_busy",
        "Your computer is busy with other requests. Try again in a moment.",
      );
    }
    return await new Promise<Response>((resolve) => {
      const entry: Pending = {
        requestId: input.requestId,
        deviceId: input.deviceId,
        method: input.method,
        socket,
        bytes: 0,
        timer: null,
        resolveStart: resolve,
        controller: null,
      };
      this.pending.set(input.requestId, entry);
      this.arm(entry, deviceRequestStartTimeoutMs(input.method));
      this.host.send(socket, {
        type: "request",
        requestId: input.requestId,
        method: input.method,
        paramsJson: input.paramsJson,
        mobileDeviceId: input.mobileDeviceId,
      });
    });
  }

  /** A response frame from `deviceId`'s presence socket. */
  onFrame(socket: WebSocket, deviceId: string, frame: DeviceRequestDeviceFrame): void {
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    const entry = this.pending.get(requestId);
    // A frame for a request this socket was not asked (or one already over)
    // is dropped: a device can only answer what it was sent.
    if (!entry || entry.deviceId !== deviceId || entry.socket !== socket) return;
    switch (frame.type) {
      case "response.start": {
        if (!entry.resolveStart) return;
        const declared = typeof frame.sizeBytes === "number" ? frame.sizeBytes : 0;
        if (declared > DEVICE_REQUEST_LIMITS.responseBytes) {
          this.fail(entry, "too_large", "That file is too large to open on your phone.");
          return;
        }
        const contentType =
          typeof frame.contentType === "string" && frame.contentType.trim()
            ? frame.contentType.trim().slice(0, 200)
            : "application/octet-stream";
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            entry.controller = controller;
          },
          cancel: () => {
            // The phone went away mid-stream.
            this.finish(entry);
            this.host.send(entry.socket, { type: "request.cancel", requestId: entry.requestId });
          },
        });
        const resolve = entry.resolveStart;
        entry.resolveStart = null;
        this.arm(entry, DEVICE_REQUEST_IDLE_TIMEOUT_MS);
        resolve(
          new Response(stream, {
            status: 200,
            headers: {
              ...noStore,
              "content-type": contentType,
              ...(declared > 0 ? { "x-stella-size-bytes": String(declared) } : {}),
            },
          }),
        );
        return;
      }
      case "response.chunk": {
        if (entry.resolveStart || !entry.controller) return;
        const bytes = typeof frame.data === "string" ? decodeBase64(frame.data) : null;
        if (!bytes) {
          this.fail(entry, "failed", "Your computer sent a damaged response.");
          return;
        }
        entry.bytes += bytes.byteLength;
        if (entry.bytes > DEVICE_REQUEST_LIMITS.responseBytes) {
          this.fail(entry, "too_large", "That file is too large to open on your phone.");
          return;
        }
        entry.controller.enqueue(bytes);
        this.arm(entry, DEVICE_REQUEST_IDLE_TIMEOUT_MS);
        return;
      }
      case "response.end": {
        if (entry.resolveStart) {
          // An empty body that never started: answer it as empty.
          entry.resolveStart(new Response(null, { status: 200, headers: noStore }));
          entry.resolveStart = null;
        } else {
          try {
            entry.controller?.close();
          } catch {
            // Already closed by a cancel.
          }
        }
        this.finish(entry);
        return;
      }
      case "response.error": {
        const code =
          typeof frame.code === "string" && frame.code in DEVICE_REQUEST_ERROR_STATUS
            ? frame.code
            : "failed";
        const message =
          typeof frame.message === "string" && frame.message.trim()
            ? frame.message.trim().slice(0, 500)
            : "Your computer could not answer that request.";
        this.fail(entry, code, message, false);
        return;
      }
    }
  }

  /** The device's socket closed: everything it was answering ends now. */
  onDeviceGone(deviceId: string, socket?: WebSocket): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.deviceId !== deviceId) continue;
      if (socket && entry.socket !== socket) continue;
      this.fail(entry, "device_offline", OFFLINE_MESSAGE, false);
    }
  }

  private arm(entry: Pending, ms: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.fail(entry, "timeout", "Your computer took too long to answer.");
    }, ms);
  }

  private finish(entry: Pending): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.pending.delete(entry.requestId);
  }

  /**
   * End a request with an error: a JSON error when nothing was sent yet, a
   * broken stream otherwise. `tellDevice` asks the computer to stop sending.
   */
  private fail(
    entry: Pending,
    code: DeviceRequestErrorCode,
    message: string,
    tellDevice = true,
  ): void {
    if (!this.pending.has(entry.requestId)) return;
    this.finish(entry);
    this.host.log("device_request_failed", {
      deviceId: entry.deviceId,
      method: entry.method,
      code,
      started: !entry.resolveStart,
      bytes: entry.bytes,
    });
    if (entry.resolveStart) {
      entry.resolveStart(deviceRequestErrorResponse(code, message));
      entry.resolveStart = null;
    } else {
      try {
        entry.controller?.error(new Error(message));
      } catch {
        // Already closed.
      }
    }
    if (tellDevice) {
      this.host.send(entry.socket, { type: "request.cancel", requestId: entry.requestId });
    }
  }
}
