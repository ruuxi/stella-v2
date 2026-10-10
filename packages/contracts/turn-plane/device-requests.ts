/**
 * Requests a paired phone makes of one of the owner's computers, relayed by
 * the cloud over that computer's presence socket.
 *
 *   phone --HTTP--> worker --> owner gate --presence socket--> computer
 *   phone <-stream-- worker <-- owner gate <--response frames-- computer
 *
 * The owner gate never stores what passes through: the computer's response
 * frames are written straight into the phone's open HTTP response.
 *
 * Authority: the phone's user JWT names the owner, and a pairing proof (the
 * same HMAC scheme as a placement submit, see `pairing-proof.ts`) binds the
 * request to one paired (phone, computer) pair. The challenge commits to the
 * request id, method and params, so a proof cannot be replayed for another
 * file. The computer applies its own file-access policy on top.
 */

import { sha256Hex } from "./pairing-proof.js";

export const DEVICE_REQUEST_METHODS = [
  /**
   * `{ filePath, conversationId, variant? }` -> the file's bytes, typed by
   * extension. `variant: "thumbnail"` asks for a small JPEG of an image
   * instead; a computer that cannot make one sends the file itself.
   */
  "file.read",
  /** `{ filePath, conversationId }` or `{ sessionId, conversationId }` -> HTML. */
  "officePreview.render",
  /** `{ conversationId }` -> the computer's voice instructions and tools. */
  "voice.config",
  /** A realtime voice tool call -> its result. */
  "voice.executeTool",
] as const;

export type DeviceRequestMethod = (typeof DEVICE_REQUEST_METHODS)[number];

export const isDeviceRequestMethod = (
  value: unknown,
): value is DeviceRequestMethod =>
  typeof value === "string" &&
  (DEVICE_REQUEST_METHODS as readonly string[]).includes(value);

export const deviceRequestPath = (deviceId: string): string =>
  `/owners/me/devices/${encodeURIComponent(deviceId)}/requests`;

export const DEVICE_REQUEST_LIMITS = {
  requestId: 128,
  /** The JSON params a phone may send. */
  paramsBytes: 32 * 1024,
  /** The most bytes one response may carry through the cloud. */
  responseBytes: 32 * 1024 * 1024,
  /** Raw bytes per presence frame; base64 keeps the frame under 64 KiB. */
  chunkBytes: 32 * 1024,
  /** Requests one computer serves at once. */
  concurrentPerDevice: 4,
} as const;

/** How long the gate waits for the computer to start answering. */
export const deviceRequestStartTimeoutMs = (
  method: DeviceRequestMethod,
): number =>
  method === "voice.executeTool"
    ? 120_000
    : method === "officePreview.render"
      ? 45_000
      : 30_000;

/** How long the gate waits between response chunks once one has started. */
export const DEVICE_REQUEST_IDLE_TIMEOUT_MS = 30_000;

export type DeviceRequestBody = {
  requestId: string;
  method: DeviceRequestMethod;
  params: Record<string, unknown>;
};

export const DEVICE_REQUEST_CHALLENGE_VERSION = "device-request-v1" as const;

/** The pairing-proof challenge for one device request. */
export const buildDeviceRequestChallenge = (input: {
  requestId: string;
  method: DeviceRequestMethod;
  /** Lowercase hex sha256 of the exact params JSON sent. */
  paramsHash: string;
}): string =>
  [
    DEVICE_REQUEST_CHALLENGE_VERSION,
    input.requestId,
    input.method,
    input.paramsHash,
  ].join(":");

export const deviceRequestParamsHash = (paramsJson: string): Promise<string> =>
  sha256Hex(paramsJson);

/**
 * Error codes a device request can end with. The HTTP status carries the
 * class; the code lets the phone say exactly what happened.
 */
export type DeviceRequestErrorCode =
  /** The computer has no live presence socket. HTTP 503. */
  | "device_offline"
  /** The computer is already serving its share of requests. HTTP 429. */
  | "device_busy"
  /** The computer did not answer in time. HTTP 504. */
  | "timeout"
  /** The computer's policy refused the request. HTTP 403. */
  | "forbidden"
  /** The file is gone. HTTP 404. */
  | "not_found"
  /** The response would exceed `DEVICE_REQUEST_LIMITS.responseBytes`. HTTP 413. */
  | "too_large"
  | "bad_request"
  | "unauthorized"
  /** The computer tried and failed. HTTP 502. */
  | "failed";

export const DEVICE_REQUEST_ERROR_STATUS: Readonly<
  Record<DeviceRequestErrorCode, number>
> = {
  device_offline: 503,
  device_busy: 429,
  timeout: 504,
  forbidden: 403,
  not_found: 404,
  too_large: 413,
  bad_request: 400,
  unauthorized: 401,
  failed: 502,
};

/** Server -> computer, on the presence socket. */
export type DeviceRequestServerFrame =
  | {
      type: "request";
      requestId: string;
      method: DeviceRequestMethod;
      paramsJson: string;
      /** Which paired phone asked, for the computer's logs. */
      mobileDeviceId: string;
    }
  /** The phone went away or the gate gave up; stop sending. */
  | { type: "request.cancel"; requestId: string };

/** Computer -> server, on the presence socket. */
export type DeviceRequestDeviceFrame =
  | {
      type: "response.start";
      requestId: string;
      contentType: string;
      /** Total bytes the body will carry, when known. */
      sizeBytes?: number;
    }
  | { type: "response.chunk"; requestId: string; data: string }
  | { type: "response.end"; requestId: string }
  | {
      type: "response.error";
      requestId: string;
      code: DeviceRequestErrorCode;
      message: string;
    };
