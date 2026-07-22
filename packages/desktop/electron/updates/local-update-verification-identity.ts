export const LOCAL_UPDATE_VERIFICATION_APP_ID =
  "com.stella.v2.updateverification";
export const LOCAL_UPDATE_VERIFICATION_PRODUCT_NAME =
  "Stella V2 Update Verification";

export type LocalUpdateVerificationIdentity = {
  isPackaged: boolean;
  appName: string;
  bundleId: string;
  packageMarker: boolean;
  packageBundleId: string;
};

export type LocalUpdateVerificationUpdater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  disableWebInstaller: boolean;
  setFeedURL: (options: {
    provider: "generic";
    url: string;
    channel: "latest-v2";
    useMultipleRangeRequest: boolean;
  }) => void;
};

export const assertLocalUpdateVerificationRequest = (
  identity: LocalUpdateVerificationIdentity,
  feedValue: string,
): string => {
  if (
    !identity.isPackaged ||
    identity.appName !== LOCAL_UPDATE_VERIFICATION_PRODUCT_NAME ||
    identity.bundleId !== LOCAL_UPDATE_VERIFICATION_APP_ID ||
    !identity.packageMarker ||
    identity.packageBundleId !== LOCAL_UPDATE_VERIFICATION_APP_ID
  ) {
    throw new Error(
      "Local updater verification is restricted to the packaged verification-only application identity.",
    );
  }

  const feed = new URL(feedValue);
  if (
    feed.protocol !== "http:" ||
    feed.hostname !== "127.0.0.1" ||
    !feed.pathname.startsWith("/desktop-v2/")
  ) {
    throw new Error(
      "Local updater verification requires a 127.0.0.1 /desktop-v2/ feed.",
    );
  }
  return feed.toString().replace(/\/$/, "");
};

export const configureLocalUpdateVerificationUpdater = (
  updater: LocalUpdateVerificationUpdater,
  feedUrl: string,
): void => {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableWebInstaller = true;
  updater.setFeedURL({
    provider: "generic",
    url: feedUrl,
    channel: "latest-v2",
    useMultipleRangeRequest: false,
  });
  updater.allowDowngrade = false;
};
