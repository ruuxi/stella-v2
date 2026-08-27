import { api } from "@/convex/api";
import { usePersistentConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { useAuthSessionState } from "./use-auth-session-state";

type CurrentUser = {
  email?: string;
  name?: string;
  isAnonymous?: boolean;
} | null | undefined;

export function useCurrentUser(): { user: CurrentUser; hasConnectedAccount: boolean } {
  const { cacheScope, hasConnectedAccount } = useAuthSessionState();
  const user = usePersistentConvexOneShot(
    api.auth.getCurrentUser,
    hasConnectedAccount ? {} : "skip",
    {
      scope: cacheScope,
      ttlMs: 24 * 60 * 60 * 1000,
    },
  ) as CurrentUser;
  return { user, hasConnectedAccount };
}
