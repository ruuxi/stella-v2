export const appSdkSessionOwnsCurrentApp = (args: {
  tokenOwnerId: string;
  currentAppOwnerId: string | null;
  sourceOwnerFenced: boolean;
}): boolean =>
  !args.sourceOwnerFenced &&
  args.currentAppOwnerId !== null &&
  args.tokenOwnerId === args.currentAppOwnerId;
