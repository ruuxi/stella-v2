import { useConvexAuth } from "convex/react";
import { useAuthSessionState } from "./use-auth-session-state";

/**
 * The one authority predicate for conversation storage and routing.
 *
 * Better Auth can maintain an anonymous Convex identity. That is useful for
 * other product surfaces, but it must never select cloud conversation mode:
 * the desktop runtime and the route would otherwise disagree about which
 * transcript owns a turn.
 */
export function useCloudMode() {
  const convex = useConvexAuth();
  const session = useAuthSessionState();
  return {
    cloudMode: session.hasConnectedAccount && convex.isAuthenticated,
    isLoading: session.isLoading || convex.isLoading,
    accountScope: session.cacheScope,
  };
}
