import { getConvexToken } from "@/global/auth/services/auth-token";
import { backendUrl } from "@/platform/backend/backend-client";

/**
 * A request to one of the backend's voice routes that is not a JSON call
 * (SDP and audio bodies), with the user's bearer token. Throws on a non-OK
 * response with the backend's message.
 */
export const voiceBackendFetch = async (
  path: string,
  init: { body: BodyInit; contentType: string; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<Response> => {
  if (!backendUrl) throw new Error("VITE_STELLA_BACKEND_URL is not set.");
  const token = await getConvexToken();
  if (!token) throw new Error("Sign in to Stella to use voice.");
  const response = await fetch(`${backendUrl}${path}`, {
    method: "POST",
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": init.contentType,
    },
    body: init.body,
    signal: init.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let message = detail.trim();
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // Not JSON; keep the text.
    }
    throw new Error(`Voice request failed (${response.status})${message ? `: ${message}` : ""}`);
  }
  return response;
};
