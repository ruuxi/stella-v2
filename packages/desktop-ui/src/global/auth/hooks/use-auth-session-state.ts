import { useMemo } from "react";
import { useDesktopAuthSession } from "@/global/auth/services/auth-session";
import { resolveAuthSessionCacheScope } from "@/global/auth/lib/auth-session-scope";

type AuthSessionUser = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  isAnonymous?: boolean | null;
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

export function useAuthSessionState() {
  const session = useDesktopAuthSession();
  const sessionData = session.data as AuthSessionData;
  const user = sessionData?.user ?? null;
  const hasSession = Boolean(sessionData);
  const isAnonymous = user?.isAnonymous === true;
  const hasConnectedAccount = hasSession && !isAnonymous;
  const cacheScope = resolveAuthSessionCacheScope(sessionData);

  return useMemo(
    () => ({
      user,
      hasSession,
      isAnonymous,
      hasConnectedAccount,
      isLoading: Boolean(session.isPending),
      cacheScope,
      identityRevision: session.identityRevision,
    }),
    [
      cacheScope,
      hasConnectedAccount,
      hasSession,
      isAnonymous,
      session.identityRevision,
      session.isPending,
      user,
    ],
  );
}
