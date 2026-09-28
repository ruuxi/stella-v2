export type CloudConversationSessionGate = {
  hasSession: boolean;
  sessionIsLoading: boolean;
  convexIsAuthenticated: boolean;
  convexIsLoading: boolean;
  hasExpectedSubject: boolean;
  authBootstrapReady: boolean;
  authBootstrapFailed: boolean;
};

export const resolveCloudConversationSession = (
  args: CloudConversationSessionGate & {
    identityConfirmed: boolean;
    identityIsLoading: boolean;
  },
): { isCloudConversationReady: boolean; isLoading: boolean } => {
  const isCloudConversationReady =
    args.authBootstrapReady &&
    !args.authBootstrapFailed &&
    args.hasSession &&
    args.convexIsAuthenticated &&
    args.hasExpectedSubject &&
    args.identityConfirmed;
  return {
    isCloudConversationReady,
    isLoading:
      !args.authBootstrapFailed &&
      (!args.authBootstrapReady ||
        args.sessionIsLoading ||
        args.convexIsLoading ||
        args.identityIsLoading ||
        isCloudConversationReady === false),
  };
};

export type OwnershipMigrationStatus =
  | "pending"
  | "running"
  | "failed"
  | "complete";

/**
 * The root layout subscribes to the migration status as soon as Convex holds
 * a token, in parallel with the session identity confirmation. Only a
 * confirmed session may act on the result: until then it reads as not yet
 * loaded, and a query failure throws only once the session is confirmed,
 * exactly when a subscription gated on readiness would have thrown.
 */
export const readPrefetchedOwnershipMigration = <T>(
  result: T | Error | undefined,
  isCloudConversationReady: boolean,
): T | undefined => {
  if (!isCloudConversationReady) return undefined;
  if (result instanceof Error) throw result;
  return result;
};

export const resolveOwnershipMigrationGate = (
  status: OwnershipMigrationStatus | null | undefined,
  isCloudConversationReady: boolean,
): {
  isLoading: boolean;
  isPending: boolean;
  isFailed: boolean;
  canSelectConversation: boolean;
} => {
  const isLoading = isCloudConversationReady && status === undefined;
  const isPending = status === "pending" || status === "running";
  const isFailed = status === "failed";
  return {
    isLoading,
    isPending,
    isFailed,
    canSelectConversation:
      isCloudConversationReady && !isLoading && !isPending && !isFailed,
  };
};
