export type AuthIdentityIntent = "connected";

export type SignedOutReason = "first_install" | "explicit_sign_out";

export type AuthSessionError = {
  kind: "network" | "http" | "malformed" | "ipc";
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
};

export type AuthSessionSnapshot<Session = unknown> =
  | {
      status: "authenticated";
      identityIntent: AuthIdentityIntent;
      session: Session;
    }
  | {
      status: "unknown";
      identityIntent: AuthIdentityIntent | null;
      staleSession: Session | null;
      error: AuthSessionError;
    }
  | {
      status: "reauth_required";
      identityIntent: "connected";
      staleSession: Session | null;
      reason: "credential_missing" | "session_rejected";
    }
  | {
      status: "signed_out";
      identityIntent: null;
      reason: SignedOutReason;
    };

export type AuthSessionObservation<Session = unknown> =
  | { kind: "authenticated"; session: Session }
  | { kind: "no_session" }
  | { kind: "rejected" }
  | { kind: "unknown"; error: AuthSessionError };

const INVALID_SESSION_CODES = new Set([
  "UNAUTHORIZED",
  "INVALID_SESSION",
  "INVALID_SESSION_TOKEN",
  "INVALID_TOKEN",
  "SESSION_EXPIRED",
  "SESSION_NOT_FOUND",
]);

export const isRecognizedAuthRejection = (args: {
  status: number | undefined;
  code: string | undefined;
}): boolean =>
  args.status === 401 &&
  Boolean(args.code && INVALID_SESSION_CODES.has(args.code.toUpperCase()));

/**
 * A session created by the retired anonymous sign-in. It is never a usable
 * identity; its credential is kept only so a sign-in can upgrade that user
 * in place and keep their history.
 */
export const isLegacyAnonymousSession = (session: unknown): boolean => {
  if (!session || typeof session !== "object") return false;
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") return false;
  return (user as { isAnonymous?: unknown }).isAnonymous === true;
};

export const getAuthSessionIdentityIntent = (
  session: unknown,
): AuthIdentityIntent | null => {
  if (!session || typeof session !== "object") return null;
  if (isLegacyAnonymousSession(session)) return null;
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;
  const id = (user as { id?: unknown }).id;
  if (typeof id !== "string" || !id.trim()) return null;
  return "connected";
};

export const getAuthSnapshotSession = <Session>(
  snapshot: AuthSessionSnapshot<Session>,
): Session | null => {
  switch (snapshot.status) {
    case "authenticated":
      return snapshot.session;
    case "unknown":
    case "reauth_required":
      return snapshot.staleSession;
    case "signed_out":
      return null;
  }
};

const signedOut = <Session>(
  reason: SignedOutReason,
): AuthSessionSnapshot<Session> => ({
  status: "signed_out",
  identityIntent: null,
  reason,
});

export const resolveAuthSessionObservation = <Session>(args: {
  observation: AuthSessionObservation<Session>;
  identityIntent: AuthIdentityIntent | null;
  staleSession: Session | null;
  signedOutReason?: SignedOutReason;
}): AuthSessionSnapshot<Session> => {
  const { observation, staleSession } = args;
  if (observation.kind === "authenticated") {
    if (isLegacyAnonymousSession(observation.session)) {
      return signedOut(args.signedOutReason ?? "first_install");
    }
    const observedIntent = getAuthSessionIdentityIntent(observation.session);
    if (!observedIntent) {
      return {
        status: "unknown",
        identityIntent: args.identityIntent,
        staleSession,
        error: {
          kind: "malformed",
          message: "The auth service returned a session without an identity.",
        },
      };
    }
    return {
      status: "authenticated",
      identityIntent: observedIntent,
      session: observation.session,
    };
  }

  if (observation.kind === "unknown") {
    return {
      status: "unknown",
      identityIntent: args.identityIntent,
      staleSession,
      error: observation.error,
    };
  }

  if (args.identityIntent === "connected") {
    return {
      status: "reauth_required",
      identityIntent: "connected",
      staleSession,
      reason: "session_rejected",
    };
  }

  return signedOut(args.signedOutReason ?? "first_install");
};

export const resolveMissingCredentialSnapshot = <Session>(args: {
  identityIntent: AuthIdentityIntent | null;
  staleSession: Session | null;
  signedOutReason?: SignedOutReason;
}): AuthSessionSnapshot<Session> => {
  if (args.identityIntent === "connected") {
    return {
      status: "reauth_required",
      identityIntent: "connected",
      staleSession: args.staleSession,
      reason: "credential_missing",
    };
  }
  return signedOut(args.signedOutReason ?? "first_install");
};
