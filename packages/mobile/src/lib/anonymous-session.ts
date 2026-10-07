type SessionResult = {
  data?: { user: { id: string; isAnonymous?: boolean | null } } | null;
  error?: { message?: string } | null;
};

/** Resume the current owner before creating an account-free session. */
export function createAnonymousSessionStarter({
  getSession,
  createSession,
}: {
  getSession: () => Promise<SessionResult>;
  createSession: () => Promise<SessionResult>;
}) {
  let pending: Promise<SessionResult> | null = null;

  return (): Promise<SessionResult> => {
    if (!pending) {
      pending = (async () => {
        const current = await getSession();
        // A failed lookup does not establish that the credential is invalid.
        // Preserve it and let the user retry instead of replacing their owner.
        if (current.error || current.data?.user) return current;
        return await createSession();
      })().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
