import { useEffect } from "react";
import { useConvexAuth } from "convex/react";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { setBackendAccount } from "@/platform/backend/backend-client";
import { useOwnerIdentity } from "@/platform/backend/use-owner-identity";
import { useAuthBootstrapState } from "../DesktopConvexAuthProvider";
import {
  resolveCloudConversationSession,
  type CloudConversationSessionGate,
} from "../lib/cloud-conversation-session";
import { useAuthSessionState } from "./use-auth-session-state";
import { reportCloudReadiness } from "@/features/cloud/cloud-readiness-timing";

/**
 * The one authority predicate for conversation storage and routing.
 *
 * Both anonymous and connected Better Auth sessions own cloud conversations.
 * There is deliberately no signed-out/local fallback: while automatic
 * anonymous auth or token exchange is incomplete, conversation selection
 * remains in a loading state.
 *
 * The identity proof is the backend's own answer: `owner.identity` returns
 * the owner it verified from the current token, and selection waits until
 * that is the account the renderer expects.
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
  const accountKey =
    shouldConfirmIdentity && ownerSubject
      ? `${ownerSubject}\u0000${session.identityRevision}`
      : null;
  useEffect(() => {
    if (!session.isLoading) setBackendAccount(accountKey);
  }, [accountKey, session.isLoading]);
  const { identity } = useOwnerIdentity(accountKey);
  const identityConfirmed = Boolean(
    identity && ownerSubject && identity.ownerId === ownerSubject,
  );
  const sessionGate: CloudConversationSessionGate = {
    hasSession: session.hasSession,
    sessionIsLoading: session.isLoading,
    convexIsAuthenticated: convex.isAuthenticated,
    convexIsLoading: convex.isLoading,
    hasExpectedSubject: Boolean(expectedSubject),
    authBootstrapReady: authBootstrap.status === "ready",
    authBootstrapFailed: authBootstrap.status === "failed",
  };
  const mode = resolveCloudConversationSession({
    ...sessionGate,
    identityConfirmed,
    identityIsLoading: shouldConfirmIdentity && identity === undefined,
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
    if (identityConfirmed) {
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
    sessionGate,
    accountScope: session.cacheScope,
    expectedSubject,
    ownerSubject,
    /** The verified owner's generation, once the identity is confirmed. */
    ownerGeneration: identityConfirmed ? (identity?.ownerGeneration ?? null) : null,
    identityRevision: session.identityRevision,
    error: authBootstrap.error,
    authBootstrapStatus: authBootstrap.status,
    retryAuthBootstrap: authBootstrap.retryAuthBootstrap,
  };
}
