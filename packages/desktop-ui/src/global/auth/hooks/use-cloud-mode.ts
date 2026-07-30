import { useConvexAuth, useQuery } from "convex/react";
import { cloudApi } from "@/features/cloud/cloud-api";
import { useAuthBootstrapState } from "../DesktopConvexAuthProvider";
import { resolveCloudSessionMode } from "../lib/cloud-session-mode";
import { useAuthSessionState } from "./use-auth-session-state";

/**
 * The one authority predicate for conversation storage and routing.
 *
 * Both anonymous and connected Better Auth sessions own cloud conversations.
 * There is deliberately no signed-out/local fallback: while automatic
 * anonymous auth or Convex token exchange is incomplete, conversation
 * selection remains in a loading state.
 */
export function useCloudMode() {
  const convex = useConvexAuth();
  const session = useAuthSessionState();
  const authBootstrap = useAuthBootstrapState();
  const expectedSubject = session.user?.id?.trim() || null;
  const shouldConfirmIdentity = Boolean(
    !session.isLoading &&
      session.hasSession &&
      expectedSubject &&
      convex.isAuthenticated,
  );
  const identityConfirmed = useQuery(
    cloudApi.confirmMySessionIdentity,
    shouldConfirmIdentity && expectedSubject
      ? {
          expectedSubject,
          identityRevision: session.identityRevision,
        }
      : "skip",
  );
  const mode = resolveCloudSessionMode({
    hasSession: session.hasSession,
    sessionIsLoading: session.isLoading,
    convexIsAuthenticated: convex.isAuthenticated,
    convexIsLoading: convex.isLoading,
    hasExpectedSubject: Boolean(expectedSubject),
    identityConfirmed: identityConfirmed === true,
    identityIsLoading: shouldConfirmIdentity && identityConfirmed === undefined,
    authBootstrapFailed: authBootstrap.status === "failed",
  });
  return {
    ...mode,
    accountScope: session.cacheScope,
    error: authBootstrap.error,
    retryAuthBootstrap: authBootstrap.retryAuthBootstrap,
  };
}
