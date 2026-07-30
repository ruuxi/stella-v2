export type AuthSessionIdentity =
  | {
      user?: {
        id?: string | null;
        isAnonymous?: boolean | null;
      } | null;
      session?: {
        id?: string | null;
      } | null;
    }
  | null
  | undefined;

export type AuthUserIdentity = NonNullable<AuthSessionIdentity>["user"];

export function isAnonymousAuthUser(user: AuthUserIdentity): boolean {
  return user?.isAnonymous === true;
}

export function isConnectedAccountUser(user: AuthUserIdentity): boolean {
  return Boolean(user) && user?.isAnonymous !== true;
}

export function requireResolvedAuthIdentity(isPending: boolean): void {
  if (isPending) {
    throw new Error("Still checking your current Stella session. Try again.");
  }
}

export function allowsAutomaticAnonymousBootstrap(pathname: string): boolean {
  const onLogin = pathname === "/login" || pathname.startsWith("/login/");
  const onAuthCallback = pathname === "/auth" || pathname.startsWith("/auth/");
  return !onLogin && !onAuthCallback;
}

/**
 * Local pointers into cloud-owned data must follow the immutable Better Auth
 * user id. Email and name can change, and the session id rotates.
 */
export function resolveAuthSessionCacheScope(
  session: AuthSessionIdentity,
): string {
  if (!session) return "signed-out";
  const userId = session.user?.id?.trim();
  const fallbackSessionId = session.session?.id?.trim() || "unknown";
  return session.user?.isAnonymous === true
    ? `anonymous:${userId || fallbackSessionId}`
    : `account:${userId || fallbackSessionId}`;
}

/**
 * Convex authentication must refresh even when Better Auth returns to a
 * previously seen user. Include the session id and anonymous state so account
 * links and A → B → A/session-rotation transitions each get a fresh identity
 * revision instead of reusing a cached confirmation.
 */
export function resolveAuthSessionIdentityKey(
  session: AuthSessionIdentity,
): string {
  const sessionId = session?.session?.id?.trim() || "none";
  const anonymous =
    session?.user?.isAnonymous === true ? "anonymous" : "account";
  return `${resolveAuthSessionCacheScope(session)}:${anonymous}:session:${sessionId}`;
}

export type AuthIdentityRevision = {
  identityKey: string | null;
  revision: number;
};

export function advanceAuthIdentityRevision(
  current: AuthIdentityRevision,
  session: AuthSessionIdentity,
): AuthIdentityRevision {
  const identityKey = resolveAuthSessionIdentityKey(session);
  if (identityKey === current.identityKey) return current;
  return {
    identityKey,
    revision: current.revision + 1,
  };
}

let observedAuthIdentityRevision: AuthIdentityRevision = {
  identityKey: null,
  revision: 0,
};

/**
 * Process-lifetime identity nonce shared by the auth provider and conversation
 * controller. Keeping it outside either React subtree prevents a remount from
 * reusing an earlier A-account confirmation after an A → B → A transition.
 */
export function observeAuthIdentityRevision(
  session: AuthSessionIdentity,
): AuthIdentityRevision {
  observedAuthIdentityRevision = advanceAuthIdentityRevision(
    observedAuthIdentityRevision,
    session,
  );
  return observedAuthIdentityRevision;
}

export function resolveCloudConversationIdentityGate(args: {
  expectedSubject: string;
  sessionIsPending: boolean;
  convexIsLoading: boolean;
  convexIsAuthenticated: boolean;
  identityConfirmed: boolean;
}): { canUseOwnerData: boolean; isLoading: boolean } {
  const canUseOwnerData =
    Boolean(args.expectedSubject) &&
    !args.sessionIsPending &&
    !args.convexIsLoading &&
    args.convexIsAuthenticated &&
    args.identityConfirmed;
  return {
    canUseOwnerData,
    // Signed-out mobile sessions automatically bootstrap anonymously. Until an
    // exact Convex subject is confirmed there is no local conversation fallback.
    isLoading: !canUseOwnerData,
  };
}

/**
 * Account-bound bridge credentials are usable only after a concrete,
 * non-anonymous identity has resolved. The returned scope changes across
 * account switches so long-lived consumers (notably CarPlay) can discard an
 * old account's in-memory pairing before loading the next one.
 */
export function resolveAccountBoundBridgeScope(
  session: AuthSessionIdentity,
  isPending: boolean,
): string | null {
  if (isPending || !isConnectedAccountUser(session?.user)) return null;
  const userId = session?.user?.id?.trim();
  const sessionId = session?.session?.id?.trim();
  return `account:${userId || sessionId || "unknown"}`;
}
