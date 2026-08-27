export type MobileAuthSession = {
  user?: { id?: string | null } | null;
  session?: { id?: string | null } | null;
} | null;

export type CloudConversationIdentity = {
  accountScope: string;
  expectedSubject: string;
  identityKey: string;
  revision: number;
};

let observedIdentityKey: string | null = null;
let observedRevision = 0;

/**
 * Returns the immutable owner scope and a process-monotonic auth revision.
 *
 * The session id is intentionally part of identityKey: A -> B -> A and token
 * rotation must both force a fresh Convex identity proof before any prior
 * conversation/socket state can be reused.
 */
export const observeCloudConversationIdentity = (
  session: MobileAuthSession,
): CloudConversationIdentity | null => {
  const userId = session?.user?.id?.trim() ?? "";
  if (!userId) return null;
  const sessionId = session?.session?.id?.trim() || "unknown";
  const identityKey = `account:${userId}:session:${sessionId}`;
  if (identityKey !== observedIdentityKey) {
    observedIdentityKey = identityKey;
    observedRevision += 1;
  }
  return {
    accountScope: `account:${userId}`,
    expectedSubject: userId,
    identityKey,
    revision: observedRevision,
  };
};

/** Test-only reset for the process-lifetime revision clock. */
export const resetCloudConversationIdentityForTests = (): void => {
  observedIdentityKey = null;
  observedRevision = 0;
};
