export type CloudConversationSessionGate = {
  hasSession: boolean;
  sessionIsLoading: boolean;
  authIsAuthenticated: boolean;
  authIsLoading: boolean;
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
    args.authIsAuthenticated &&
    args.hasExpectedSubject &&
    args.identityConfirmed;
  return {
    isCloudConversationReady,
    isLoading:
      !args.authBootstrapFailed &&
      (!args.authBootstrapReady ||
        args.sessionIsLoading ||
        args.authIsLoading ||
        args.identityIsLoading ||
        isCloudConversationReady === false),
  };
};
