import { useQuery } from "convex/react";
import { cloudApi } from "@/features/cloud/cloud-api";
import { useAuthSessionState } from "./use-auth-session-state";
import { useCloudConversationSession } from "./use-cloud-conversation-session";

export type OwnershipMigrationStatusValue =
  | "pending"
  | "running"
  | "failed"
  | "complete"
  | null
  | undefined;

/**
 * Pure decision for `useOwnershipMigrationInProgress`, exported for tests.
 *
 * "In progress" means the sign-in dialog should stay open in its finishing
 * state. That covers the whole window between the account becoming connected
 * and the anonymous→account ownership transfer reaching a verdict:
 *
 * - the cloud session is still re-confirming the new identity
 *   (`sessionIsLoading`), so the status cannot be asked yet;
 * - the status query has been asked but has not answered (`undefined`);
 * - the transfer is `pending` or `running`.
 *
 * A `failed` transfer is NOT in progress: the root layout replaces the shell
 * with its retry screen, and the dialog must get out of the way. Likewise
 * anything short of a connected account is not in progress — anonymous users
 * never migrate, and a failed auth bootstrap has nothing to wait for.
 */
export const resolveOwnershipMigrationInProgress = (args: {
  hasConnectedAccount: boolean;
  sessionIsLoading: boolean;
  isCloudConversationReady: boolean;
  status: OwnershipMigrationStatusValue;
}): boolean => {
  if (!args.hasConnectedAccount) return false;
  if (args.sessionIsLoading) return true;
  if (!args.isCloudConversationReady) return false;
  if (args.status === undefined) return true;
  return args.status === "pending" || args.status === "running";
};

/**
 * Whether a just-signed-in account is still waiting for its anonymous data
 * to be moved over. The sign-in dialog uses this to hold its finishing state
 * until the transfer lands, so the shell behind it is never swapped for a
 * placeholder and never shows a half-migrated conversation list to a user
 * who has nothing else to look at.
 *
 * Subscribes to the same status query as the root layout; Convex dedupes
 * identical subscriptions so this adds no extra round-trip.
 */
export function useOwnershipMigrationInProgress(): boolean {
  const { hasConnectedAccount } = useAuthSessionState();
  const { isCloudConversationReady, isLoading: sessionIsLoading } =
    useCloudConversationSession();
  const migration = useQuery(
    cloudApi.getMyOwnershipMigrationStatus,
    isCloudConversationReady && hasConnectedAccount ? {} : "skip",
  );
  return resolveOwnershipMigrationInProgress({
    hasConnectedAccount,
    sessionIsLoading,
    isCloudConversationReady,
    status:
      migration === undefined
        ? undefined
        : ((migration?.status ?? null) as OwnershipMigrationStatusValue),
  });
}
