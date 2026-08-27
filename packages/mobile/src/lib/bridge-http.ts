import { isUnknownBridgeChannelError } from "./bridge-envelope";

export class BridgeEndpointUnavailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Desktop bridge endpoint unavailable (HTTP ${status}).`);
    this.name = "BridgeEndpointUnavailableError";
    this.status = status;
  }
}

export const readBridgeJsonBody = async (
  response: Response,
): Promise<unknown> => {
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new BridgeEndpointUnavailableError(response.status);
  }
  const trimmed = text.trim();
  const contentType = (
    response.headers?.get?.("content-type") ?? ""
  ).toLowerCase();
  const looksJson =
    contentType.includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (!looksJson) {
    throw new BridgeEndpointUnavailableError(response.status);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new BridgeEndpointUnavailableError(response.status);
  }
};

export const readBridgeErrorMessage = async (
  response: Response,
  fallback?: string,
): Promise<string> => {
  const fallbackMessage =
    fallback ?? `Desktop bridge request failed (HTTP ${response.status}).`;
  try {
    const parsed = await readBridgeJsonBody(response);
    if (parsed && typeof parsed === "object") {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "string" && error.trim()) {
        return error.trim();
      }
    }
  } catch {

  }
  return fallbackMessage;
};

export const isBridgeEndpointMissingError = (error: unknown): boolean => {
  if (error instanceof BridgeEndpointUnavailableError) return true;
  if (error instanceof Error && error.name === "BridgeEndpointUnavailableError") {
    return true;
  }
  return isUnknownBridgeChannelError(error);
};

export const fetchBridgeChallengeBody = async (
  baseUrl: string,
  desktopDeviceId: string,
  fetchFn: (url: string) => Promise<Response> = (url) =>
    fetch(url, { method: "GET" }),
): Promise<unknown> => {
  const scoped = await fetchFn(
    `${baseUrl}/bridge/challenge?d=${encodeURIComponent(desktopDeviceId)}`,
  );
  if (scoped.ok) {
    try {
      return await readBridgeJsonBody(scoped);
    } catch {

    }
  }
  const bare = await fetchFn(`${baseUrl}/bridge/challenge`);
  if (!bare.ok) {
    throw new Error(
      await readBridgeErrorMessage(bare, "Desktop bridge request failed."),
    );
  }
  return await readBridgeJsonBody(bare);
};

export const isRawJsonParseErrorMessage = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("json parse") ||
    (lower.includes("unexpected") &&
      (lower.includes("token") || lower.includes("character")) &&
      lower.includes("json")) ||
    /unexpected (character|token|end of (json )?input)/i.test(message)
  );
};
