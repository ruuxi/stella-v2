export type AuthIdentityIntent = "anonymous" | "connected";

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
      status: "anonymous_required";
      identityIntent: "anonymous" | null;
      reason: "first_install" | "explicit_sign_out" | "anonymous_rejected";
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

export const getAuthSessionIdentityIntent = (
  session: unknown,
): AuthIdentityIntent | null => {
  if (!session || typeof session !== "object") return null;
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;
  const id = (user as { id?: unknown }).id;
  if (typeof id !== "string" || !id.trim()) return null;
  return (user as { isAnonymous?: unknown }).isAnonymous === true
    ? "anonymous"
    : "connected";
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
    case "anonymous_required":
      return null;
  }
};

export const canBootstrapAnonymous = (snapshot: AuthSessionSnapshot): boolean =>
  snapshot.status === "anonymous_required";

export const resolveAuthSessionObservation = <Session>(args: {
  observation: AuthSessionObservation<Session>;
  identityIntent: AuthIdentityIntent | null;
  staleSession: Session | null;
  anonymousReason?:
    | "first_install"
    | "explicit_sign_out"
    | "anonymous_rejected";
}): AuthSessionSnapshot<Session> => {
  const { observation, staleSession } = args;
  if (observation.kind === "authenticated") {
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

  return {
    status: "anonymous_required",
    identityIntent: args.identityIntent,
    reason:
      args.anonymousReason ??
      (args.identityIntent === "anonymous"
        ? "anonymous_rejected"
        : "first_install"),
  };
};

export const resolveMissingCredentialSnapshot = <Session>(args: {
  identityIntent: AuthIdentityIntent | null;
  staleSession: Session | null;
  anonymousReason?: "first_install" | "explicit_sign_out";
}): AuthSessionSnapshot<Session> => {
  if (args.identityIntent === "connected") {
    return {
      status: "reauth_required",
      identityIntent: "connected",
      staleSession: args.staleSession,
      reason: "credential_missing",
    };
  }
  return {
    status: "anonymous_required",
    identityIntent: args.identityIntent,
    reason:
      args.anonymousReason ??
      (args.identityIntent === "anonymous"
        ? "explicit_sign_out"
        : "first_install"),
  };
};
