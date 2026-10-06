import { fetch as expoFetch } from "expo/fetch";
import {
  buildDeviceRequestChallenge,
  deviceRequestPath,
  type DeviceRequestErrorCode,
  type DeviceRequestMethod,
} from "@stella/contracts/turn-plane/device-requests";
import { getAuthToken } from "./auth-token";
import { resolveExecutionBuilderOrigin } from "./execution-placement";
import { phonePairingProofHeaders, sha256HexUtf8 } from "./phone-pair-proof";
import type { StoredPhoneAccess } from "./phone-access";

/**
 * A paired phone's request to one of the owner's computers, relayed by the
 * cloud over that computer's presence connection
 * (`@stella/contracts/turn-plane/device-requests`). The cloud streams the
 * computer's answer straight through and keeps none of it.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

export const DEVICE_OFFLINE_MESSAGE =
  "Your computer is offline. Open Stella on it, then try again.";

export class DeviceRequestError extends Error {
  readonly code: DeviceRequestErrorCode | "network";
  readonly status: number;
  constructor(
    message: string,
    code: DeviceRequestErrorCode | "network",
    status: number,
  ) {
    super(message);
    this.name = "DeviceRequestError";
    this.code = code;
    this.status = status;
  }
}

export const isDeviceOfflineError = (error: unknown): boolean =>
  error instanceof DeviceRequestError && error.code === "device_offline";

export const isDeviceNotFoundError = (error: unknown): boolean =>
  error instanceof DeviceRequestError && error.code === "not_found";

const createRequestId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `dr:${uuid}`;
  return `dr:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
};

const messageForCode: Partial<Record<DeviceRequestErrorCode, string>> = {
  device_offline: DEVICE_OFFLINE_MESSAGE,
  device_busy: "Your computer is busy. Try again in a moment.",
  timeout: "Your computer took too long to answer. Try again.",
  too_large: "That file is too large to open on your phone.",
};

const readError = async (
  response: { status: number; text: () => Promise<string> },
): Promise<DeviceRequestError> => {
  let code: DeviceRequestErrorCode = "failed";
  let message = "Your computer could not answer that request.";
  try {
    const parsed = JSON.parse(await response.text()) as {
      error?: { code?: unknown; message?: unknown } | string;
    };
    const detail = parsed?.error;
    if (detail && typeof detail === "object") {
      if (typeof detail.code === "string") {
        code = detail.code as DeviceRequestErrorCode;
      }
      if (typeof detail.message === "string" && detail.message.trim()) {
        message = detail.message.trim();
      }
    } else if (typeof detail === "string" && detail.trim()) {
      message = detail.trim();
    }
  } catch {
    // Keep the generic copy.
  }
  return new DeviceRequestError(
    messageForCode[code] ?? message,
    code,
    response.status,
  );
};

/**
 * Ask `access.desktopDeviceId` for something. Resolves with the response body
 * and its content type; rejects with a `DeviceRequestError`.
 */
export const requestDevice = async (
  access: StoredPhoneAccess,
  method: DeviceRequestMethod,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ bytes: Uint8Array; contentType: string }> => {
  const requestId = createRequestId();
  // The worker re-serializes `params` with JSON.stringify before checking the
  // proof, so the hash covers exactly that string.
  const paramsJson = JSON.stringify(params);
  const challenge = buildDeviceRequestChallenge({
    requestId,
    method,
    paramsHash: sha256HexUtf8(paramsJson),
  });
  const origin = await resolveExecutionBuilderOrigin();
  const token = await getAuthToken();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (options?.signal?.aborted) controller.abort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let response: Awaited<ReturnType<typeof expoFetch>>;
    try {
      response = await expoFetch(`${origin}${deviceRequestPath(access.desktopDeviceId)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...phonePairingProofHeaders(access, challenge),
        },
        body: JSON.stringify({ requestId, method, params }),
        signal: controller.signal,
      });
    } catch {
      if (options?.signal?.aborted) {
        const aborted = new Error("Request cancelled.");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw new DeviceRequestError(
        timedOut
          ? "Your computer took too long to answer. Try again."
          : "Couldn't reach Stella's cloud. Check your connection and try again.",
        timedOut ? "timeout" : "network",
        0,
      );
    }
    if (!response.ok) throw await readError(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      contentType:
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        "application/octet-stream",
    };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onAbort);
  }
};

export const decodeUtf8 = (bytes: Uint8Array): string => {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
};

/** A device request whose answer is JSON. */
export const requestDeviceJson = async <T>(
  access: StoredPhoneAccess,
  method: DeviceRequestMethod,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> => {
  const { bytes } = await requestDevice(access, method, params, options);
  try {
    return JSON.parse(decodeUtf8(bytes)) as T;
  } catch {
    throw new DeviceRequestError(
      "Your computer sent an answer Stella couldn't read.",
      "failed",
      200,
    );
  }
};
