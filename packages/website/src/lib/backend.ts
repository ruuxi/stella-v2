"use client";

import { useEffect, useState } from "react";
import type { ViewArgs, ViewName, ViewResult } from "@stella/contracts/backend/api";
import { BackendClient, stableStringify } from "@stella/contracts/backend/client";
import { getAuthToken } from "./auth-token";
import { isBackendConfigured, readBackendUrl } from "./backend-url";

/**
 * The site's connection to the Stella backend worker (calls over HTTP, live
 * views over one socket), authorized with the backend's sign-in JWT.
 */

let cachedClient: BackendClient | null = null;

export { isBackendConfigured };

export function getBackendClient(): BackendClient {
  if (cachedClient) return cachedClient;
  const baseUrl = readBackendUrl();
  if (!baseUrl) throw new Error("NEXT_PUBLIC_STELLA_BACKEND_URL is not configured.");
  cachedClient = new BackendClient({
    baseUrl,
    getToken: (options) =>
      getAuthToken(options?.force ? { forceRefresh: true } : undefined),
  });
  return cachedClient;
}

/** A live backend view's value; `"skip"` holds off. Undefined while loading. */
export function useBackendValue<K extends ViewName>(
  view: K,
  args: ViewArgs<K> | "skip",
): ViewResult<K> | undefined {
  const key = args === "skip" ? null : `${view}\u0000${stableStringify(args)}`;
  const [state, setState] = useState<{ key: string | null; value?: ViewResult<K> }>({
    key: null,
  });
  useEffect(() => {
    setState({ key });
    if (args === "skip" || key === null || !isBackendConfigured()) return;
    return getBackendClient().watch(view, args, (value) => setState({ key, value }), () => {});
    // `key` captures `args`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, view]);
  return state.key === key ? state.value : undefined;
}
