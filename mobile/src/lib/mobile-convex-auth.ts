import { useCallback, useLayoutEffect, useMemo } from "react";
import { authClient } from "./auth-client";
import { observeAuthIdentityRevision } from "./auth-identity";
import { clearCachedToken, getConvexToken } from "./auth-token";

/**
 * Identity-scoped Convex auth hook.
 *
 * The upstream Better Auth provider retains its cached JWT when only the
 * Better Auth session id changes. That can authenticate Convex briefly as the
 * previous account after an A → B switch. This hook clears the token cache
 * before Convex's passive setAuth effect runs, and its callback identity forces
 * ConvexProviderWithAuth to install a fresh auth configuration.
 */
export function useMobileConvexAuth() {
  const session = authClient.useSession();
  const identityKey =
    observeAuthIdentityRevision(session.data).identityKey ?? "signed-out";

  useLayoutEffect(() => {
    clearCachedToken();
  }, [identityKey]);

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken = false,
    }: { forceRefreshToken?: boolean } = {}) =>
      await getConvexToken({
        forceRefresh: forceRefreshToken,
        identityKey,
      }),
    [identityKey],
  );

  return useMemo(
    () => ({
      isLoading: Boolean(session.isPending),
      isAuthenticated: Boolean(session.data),
      fetchAccessToken,
    }),
    [fetchAccessToken, session.data, session.isPending],
  );
}
