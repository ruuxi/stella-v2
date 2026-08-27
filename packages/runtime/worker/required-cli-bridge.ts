export const afterRequiredCliBridgeReady = async <T>(
  startBridge: () => Promise<void>,
  buildReadyResult: () => T,
): Promise<T> => {
  await startBridge();
  return buildReadyResult();
};

export const connectorActionBrokerAvailability = (
  platform: NodeJS.Platform,
): { supported: true } | { supported: false; reason: string } =>
  platform === "win32"
    ? {
        supported: false,
        reason:
          "Secure connector action brokering is unavailable on Windows until a current-user named-pipe ACL is supported.",
      }
    : { supported: true };
