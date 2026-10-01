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
