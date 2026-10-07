import { useMemo } from "react";
import { useAuthSessionState } from "./use-auth-session-state";

type CurrentUser = {
  email?: string;
  name?: string;
} | null | undefined;

/**
 * The signed-in account's profile, read from the session main verified
 * (`auth:getSession`). Only connected accounts have one to show.
 */
export function useCurrentUser(): { user: CurrentUser; hasConnectedAccount: boolean } {
  const { user, hasConnectedAccount } = useAuthSessionState();
  return useMemo(() => {
    if (!hasConnectedAccount || !user) return { user: null, hasConnectedAccount };
    return {
      user: {
        ...(user.email ? { email: user.email } : {}),
        ...(user.name ? { name: user.name } : {}),
      },
      hasConnectedAccount,
    };
  }, [hasConnectedAccount, user]);
}
