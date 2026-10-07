import { useEffect } from "react";
import { setBackendAccount } from "@/platform/backend/backend-client";
import { useOwnerIdentity } from "@/platform/backend/use-owner-identity";
import { useAuthBootstrapState, useAuthState } from "../BackendAuthProvider";
import {
  resolveCloudConversationSession,
  type CloudConversationSessionGate,
} from "../lib/cloud-conversation-session";
import { useAuthSessionState } from "./use-auth-session-state";
import { reportCloudReadiness } from "@/features/cloud/cloud-readiness-timing";

/**
 * The one authority predicate for conversation storage and routing.
 *
 * A signed-in Better Auth session owns cloud conversations. There is
 * deliberately no signed-out fallback: while the session or token exchange is
 * incomplete, conversation selection remains in a loading state, and a
 * signed-out shell has no cloud conversations at all.
 *
 * The identity proof is the backend's own answer: `owner.identity` returns
 * the owner it verified from the current token, and selection waits until
 * that is the account the renderer expects.
 */
export function useCloudConversationSession() {
  const auth = useAuthState();
  const session = useAuthSessionState();
  const authBootstrap = useAuthBootstrapState();
  const expectedSubject = session.user?.id?.trim() || null;
  // The backend's owner id is the Better Auth user id (the JWT's `sub`).
  const ownerSubject = expectedSubject;
  const shouldConfirmIdentity = Boolean(
    authBootstrap.status === "ready" &&
      !session.isLoading &&
      session.hasSession &&
      expectedSubject &&
      auth.isAuthenticated,
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
    authIsAuthenticated: auth.isAuthenticated,
    authIsLoading: auth.isLoading,
    hasExpectedSubject: Boolean(expectedSubject),
    authBootstrapReady: authBootstrap.status === "ready",
    authBootstrapFailed: authBootstrap.status === "failed",
    authBootstrapSignedOut: authBootstrap.status === "signed_out",
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
    if (!auth.isLoading && auth.isAuthenticated) {
      reportCloudReadiness("cloud.auth-ready", { outcome: "success" });
    }
    if (identityConfirmed) {
      reportCloudReadiness("cloud.identity-confirmed", { outcome: "success" });
    }
    if (mode.isCloudConversationReady) {
      reportCloudReadiness("cloud.conversation-ready", { outcome: "success" });
    }
  }, [
    authBootstrap.status,
    auth.isAuthenticated,
    auth.isLoading,
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
