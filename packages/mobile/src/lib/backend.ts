import { useEffect, useState } from "react";
import type {
  ViewArgs,
  ViewName,
  ViewResult,
} from "@stella/contracts/backend/api";
import {
  BackendClient,
  stableStringify,
  type BackendRequestError,
} from "@stella/contracts/backend/client";
import { env } from "../config/env";
import { getAuthToken } from "./auth-token";

/**
 * The app's one connection to the Stella backend worker: calls over HTTP and
 * live views over a single socket, authorized with the same JWT as every
 * other cloud request.
 */
let cachedClient: BackendClient | null = null;

export function getBackendClient(): BackendClient {
  if (cachedClient) return cachedClient;
  if (!env.backendUrl) {
    throw new Error("EXPO_PUBLIC_STELLA_BACKEND_URL is not configured.");
  }
  cachedClient = new BackendClient({
    baseUrl: env.backendUrl,
    getToken: (options) =>
      getAuthToken(options?.force ? { forceRefresh: true } : undefined),
  });
  return cachedClient;
}

/** Reconnect as the current account, e.g. after sign-in or sign-out. */
export function reconnectBackend(): void {
  cachedClient?.reconnect();
}

/** A view's current value, read once. */
export function readBackendView<K extends ViewName>(
  view: K,
  args: ViewArgs<K>,
): Promise<ViewResult<K>> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const settle = (finish: () => void) => {
      if (done) return;
      done = true;
      unsubscribe?.();
      finish();
    };
    unsubscribe = getBackendClient().watch(
      view,
      args,
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
    // The value may already have arrived synchronously.
    if (done) unsubscribe();
  });
}

/** Subscribe to a backend view; `"skip"` holds off. Undefined while loading. */
export function useBackendView<K extends ViewName>(
  view: K,
  args: ViewArgs<K> | "skip",
): { value: ViewResult<K> | undefined; error: BackendRequestError | undefined } {
  const key = args === "skip" ? null : `${view}\u0000${stableStringify(args)}`;
  const [state, setState] = useState<{
    key: string | null;
    value?: ViewResult<K>;
    error?: BackendRequestError;
  }>({ key: null });
  useEffect(() => {
    setState({ key });
    if (args === "skip" || key === null) return;
    return getBackendClient().watch(
      view,
      args,
      (value) => setState({ key, value }),
      (error) => setState((previous) => ({ ...previous, key, error })),
    );
    // `key` captures `args`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, view]);
  const current = state.key === key ? state : { key };
  return { value: current.value, error: current.error };
}
