import { useEffect } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { cloudApi } from "@/features/cloud/cloud-api";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { useAuthBootstrapState } from "../DesktopConvexAuthProvider";
import { resolveCloudConversationSession } from "../lib/cloud-conversation-session";
import { useAuthSessionState } from "./use-auth-session-state";
import { reportCloudReadiness } from "@/features/cloud/cloud-readiness-timing";

/**
 * The one authority predicate for conversation storage and routing.
 *
 * Both anonymous and connected Better Auth sessions own cloud conversations.
 * There is deliberately no signed-out/local fallback: while automatic
 * anonymous auth or Convex token exchange is incomplete, conversation
 * selection remains in a loading state.
 */
export function useCloudConversationSession() {
  const convex = useConvexAuth();
  const session = useAuthSessionState();
  const authBootstrap = useAuthBootstrapState();
  const expectedSubject = session.user?.id?.trim() || null;
  const tokenIssuer = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  const ownerSubject =
    tokenIssuer && expectedSubject ? `${tokenIssuer}|${expectedSubject}` : null;
  const shouldConfirmIdentity = Boolean(
    authBootstrap.status === "ready" &&
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
  const mode = resolveCloudConversationSession({
    hasSession: session.hasSession,
    sessionIsLoading: session.isLoading,
    convexIsAuthenticated: convex.isAuthenticated,
    convexIsLoading: convex.isLoading,
    hasExpectedSubject: Boolean(expectedSubject),
    identityConfirmed: identityConfirmed === true,
    identityIsLoading: shouldConfirmIdentity && identityConfirmed === undefined,
    authBootstrapReady: authBootstrap.status === "ready",
    authBootstrapFailed: authBootstrap.status === "failed",
  });
  useEffect(() => {
    if (authBootstrap.status === "ready") {
      reportCloudReadiness("cloud.auth-bootstrap-ready", {
        outcome: "success",
      });
    }
    if (!session.isLoading && session.hasSession) {
      reportCloudReadiness("cloud.session-ready", { outcome: "success" });
    }
    if (!convex.isLoading && convex.isAuthenticated) {
      reportCloudReadiness("cloud.convex-auth-ready", { outcome: "success" });
    }
    if (identityConfirmed === true) {
      reportCloudReadiness("cloud.identity-confirmed", { outcome: "success" });
    }
    if (mode.isCloudConversationReady) {
      reportCloudReadiness("cloud.conversation-ready", { outcome: "success" });
    }
  }, [
    authBootstrap.status,
    convex.isAuthenticated,
    convex.isLoading,
    identityConfirmed,
    mode.isCloudConversationReady,
    session.hasSession,
    session.isLoading,
  ]);
  return {
    ...mode,
    accountScope: session.cacheScope,
    expectedSubject,
    ownerSubject,
    identityRevision: session.identityRevision,
    error: authBootstrap.error,
    authBootstrapStatus: authBootstrap.status,
    retryAuthBootstrap: authBootstrap.retryAuthBootstrap,
  };
}
