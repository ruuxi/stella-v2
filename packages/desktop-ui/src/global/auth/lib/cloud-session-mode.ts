export const resolveCloudSessionMode = (args: {
  hasSession: boolean;
  sessionIsLoading: boolean;
  convexIsAuthenticated: boolean;
  convexIsLoading: boolean;
  hasExpectedSubject: boolean;
  identityConfirmed: boolean;
  identityIsLoading: boolean;
  authBootstrapReady: boolean;
  authBootstrapFailed: boolean;
}): { cloudMode: boolean; isLoading: boolean } => {
  const cloudMode =
    args.authBootstrapReady &&
    !args.authBootstrapFailed &&
    args.hasSession &&
    args.convexIsAuthenticated &&
    args.hasExpectedSubject &&
    args.identityConfirmed;
  return {
    cloudMode,
    isLoading:
      !args.authBootstrapFailed &&
      (!args.authBootstrapReady ||
        args.sessionIsLoading ||
        args.convexIsLoading ||
        args.identityIsLoading ||
        cloudMode === false),
  };
};

export type OwnershipMigrationStatus =
  | "pending"
  | "running"
  | "failed"
  | "complete";

export const resolveOwnershipMigrationGate = (
  status: OwnershipMigrationStatus | null | undefined,
  cloudMode: boolean,
): {
  isLoading: boolean;
  isPending: boolean;
  isFailed: boolean;
  canSelectConversation: boolean;
} => {
  const isLoading = cloudMode && status === undefined;
  const isPending = status === "pending" || status === "running";
  const isFailed = status === "failed";
  return {
    isLoading,
    isPending,
    isFailed,
    canSelectConversation: cloudMode && !isLoading && !isPending && !isFailed,
  };
};
