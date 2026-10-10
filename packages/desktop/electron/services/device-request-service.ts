/**
 * Answers a paired phone's request relayed by the cloud over this computer's
 * presence socket (`@stella/contracts/turn-plane/device-requests`). The
 * runtime host frames the answer; this decides it, under the same remote
 * policy the IPC handlers apply (`display-handlers`, `office-preview-handlers`,
 * `voice-handlers`).
 */

import type {
  DeviceRequestErrorCode,
  DeviceRequestMethod,
} from "@stella/contracts/turn-plane/device-requests";
import {
  deviceFileMissingMessage,
  type DeviceFileMissingReason,
} from "@stella/contracts/device-files";
import { REMOTE_VIEW_DENIAL_PREFIX } from "../ipc/display-handlers.js";

export type DeviceRequestHandlers = {
  readFile: (payload: {
    filePath?: unknown;
    conversationId?: unknown;
  }) => Promise<
    | {
        missing: true;
        mimeType: string;
        path: string;
        reason?: DeviceFileMissingReason;
      }
    | { missing: false; bytes: Uint8Array; mimeType: string }
  >;
  renderOfficePreview: (payload: {
    filePath?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
  }) => Promise<string>;
  voiceConfig: (payload: Record<string, unknown>) => Promise<unknown>;
  voiceExecuteTool: (payload: Record<string, unknown>) => Promise<unknown>;
};

export type DeviceRequestAnswer =
  | { ok: true; contentType: string; bodyBase64: string }
  | { ok: false; code: DeviceRequestErrorCode; message: string };

const json = (value: unknown): DeviceRequestAnswer => ({
  ok: true,
  contentType: "application/json",
  bodyBase64: Buffer.from(JSON.stringify(value ?? null), "utf8").toString(
    "base64",
  ),
});

const failure = (error: unknown): DeviceRequestAnswer => {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "Your computer could not answer that request.";
  // The read policy's refusals carry this prefix; everything else is a
  // failure of the computer, not a decision.
  const forbidden =
    message.startsWith(REMOTE_VIEW_DENIAL_PREFIX) ||
    message.includes("from mobile is limited") ||
    message.includes("cloud workspace") ||
    message.includes("only supports:");
  return {
    ok: false,
    code: forbidden ? "forbidden" : "failed",
    message: message.slice(0, 500),
  };
};

export const serveDeviceRequest = async (
  handlers: DeviceRequestHandlers | null,
  request: {
    method: DeviceRequestMethod;
    params: Record<string, unknown>;
  },
): Promise<DeviceRequestAnswer> => {
  if (!handlers) {
    return {
      ok: false,
      code: "failed",
      message: "Stella on your computer is still starting. Try again in a moment.",
    };
  }
  try {
    switch (request.method) {
      case "file.read": {
        const result = await handlers.readFile({
          filePath: request.params.filePath,
          conversationId: request.params.conversationId,
        });
        if (result.missing) {
          return {
            ok: false,
            code: "not_found",
            message: deviceFileMissingMessage(result.reason, result.path),
          };
        }
        return {
          ok: true,
          contentType: result.mimeType,
          bodyBase64: Buffer.from(
            result.bytes.buffer,
            result.bytes.byteOffset,
            result.bytes.byteLength,
          ).toString("base64"),
        };
      }
      case "officePreview.render": {
        const html = await handlers.renderOfficePreview({
          filePath: request.params.filePath,
          sessionId: request.params.sessionId,
          conversationId: request.params.conversationId,
        });
        return {
          ok: true,
          contentType: "text/html; charset=utf-8",
          bodyBase64: Buffer.from(html, "utf8").toString("base64"),
        };
      }
      case "voice.config":
        return json(await handlers.voiceConfig(request.params));
      case "voice.executeTool":
        return json(await handlers.voiceExecuteTool(request.params));
      default:
        return { ok: false, code: "bad_request", message: "Unknown request." };
    }
  } catch (error) {
    return failure(error);
  }
};
