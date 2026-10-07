import { useMemo } from "react";
import { useDesktopAuthSession } from "@/global/auth/services/auth-session";
import { resolveAuthSessionCacheScope } from "@/global/auth/lib/auth-session-scope";

type AuthSessionUser = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
} | null;

type AuthSessionData =
  | {
      user?: AuthSessionUser;
      session?: {
        id?: string | null;
      } | null;
    }
  | null
  | undefined;

/** An account is signed in. Readable outside React. */
export const isConnectedAccountSession = (data: unknown): boolean =>
  Boolean(data);

export function useAuthSessionState() {
  const session = useDesktopAuthSession();
  const sessionData = session.data as AuthSessionData;
  const user = sessionData?.user ?? null;
  const hasSession = Boolean(sessionData);
  const hasConnectedAccount = isConnectedAccountSession(sessionData);
  const cacheScope = resolveAuthSessionCacheScope(sessionData);

  return useMemo(
    () => ({
      user,
      hasSession,
      hasConnectedAccount,
      isLoading: Boolean(session.isPending),
      cacheScope,
      identityRevision: session.identityRevision,
    }),
    [
      cacheScope,
      hasConnectedAccount,
      hasSession,
      session.identityRevision,
      session.isPending,
      user,
    ],
  );
}
