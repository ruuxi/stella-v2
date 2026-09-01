export const resolveCloudConversationSession = (args: {
  hasSession: boolean;
  sessionIsLoading: boolean;
  convexIsAuthenticated: boolean;
  convexIsLoading: boolean;
  hasExpectedSubject: boolean;
  identityConfirmed: boolean;
  identityIsLoading: boolean;
  authBootstrapReady: boolean;
  authBootstrapFailed: boolean;
}): { isCloudConversationReady: boolean; isLoading: boolean } => {
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
