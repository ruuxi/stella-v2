import { BackendClient } from "@stella/contracts/backend/client";
import { getConvexToken } from "@/global/auth/services/auth-token";

/**
 * The renderer's one connection to the Stella backend worker: calls over
 * HTTP and live views over a single socket. The URL is public build-time
 * config, like the Convex URL it replaces.
 */
export const backendUrl = (
  (import.meta.env.VITE_STELLA_BACKEND_URL as string | undefined) ?? ""
)
  .trim()
  .replace(/\/+$/, "");

if (!backendUrl) {
  console.warn(
    "VITE_STELLA_BACKEND_URL is not set; cloud-backed features remain unavailable until this build is configured.",
  );
}

/** `wss://` twin of `backendUrl`, for the conversation socket. */
export const backendSocketUrl = backendUrl.replace(/^http/, "ws");

export const backendClient = new BackendClient({
  baseUrl: backendUrl || "http://127.0.0.1:8787",
  getToken: (options) =>
    getConvexToken(options?.force ? { forceRefresh: true } : {}),
});

let accountEpoch = 0;
let accountKey: string | null = null;
const epochListeners = new Set<() => void>();

/**
 * Point the backend at the signed-in account. When the account changes the
 * socket reconnects with the new token and every view resubscribes from
 * scratch, so nothing from the previous account is shown under the new one.
 */
export const setBackendAccount = (key: string | null): void => {
  if (key === accountKey) return;
  accountKey = key;
  accountEpoch += 1;
  backendClient.reconnect();
  for (const listener of epochListeners) listener();
};

export const subscribeBackendAccount = (listener: () => void): (() => void) => {
  epochListeners.add(listener);
  return () => epochListeners.delete(listener);
};

export const readBackendAccountEpoch = (): number => accountEpoch;
