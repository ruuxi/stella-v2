const SHA256_HEX = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const ownerAppBuildRoot = (ownerHash: string): string => {
  if (!SHA256_HEX.test(ownerHash)) {
    throw new Error("Invalid app-build owner hash.");
  }
  return `builds/${ownerHash}`;
};

export const ownerAppBuildPrefix = (
  ownerHash: string,
  buildId: string,
): string => {
  if (!BUILD_ID.test(buildId)) {
    throw new Error("Invalid app-build id.");
  }
  return `${ownerAppBuildRoot(ownerHash)}/${buildId}`;
};

export const isOwnerAppBuildPrefix = (
  prefix: string,
  ownerHash: string,
): boolean => {
  let root: string;
  try {
    root = ownerAppBuildRoot(ownerHash);
  } catch {
    return false;
  }
  return (
    prefix.startsWith(`${root}/`) &&
    BUILD_ID.test(prefix.slice(root.length + 1))
  );
};

/**
 * A lost/5xx/overload response is ambiguous: Convex may have committed the
 * idempotent build row before the response disappeared, so the worker must
 * replay the callback and retain the bytes. A received permanent 4xx proves
 * that this callback did not commit and the transient prefix can be swept.
 */
export const appBuildCallbackDisposition = (
  status?: number,
): "accepted" | "cleanup" | "retry" => {
  if (status !== undefined && status >= 200 && status < 300) {
    return "accepted";
  }
  if (
    status === undefined ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  ) {
    return "retry";
  }
  return "cleanup";
};

/**
 * Recovery markers are retired only after the whole R2 prefix is confirmed
 * empty. Returning false leaves the marker intact for the next alarm/purge.
 */
export const retireTransientAppBuild = async (args: {
  sweep: () => Promise<{ done: boolean }>;
  clearRecovery: () => Promise<void>;
}): Promise<boolean> => {
  const swept = await args.sweep();
  if (!swept.done) return false;
  await args.clearRecovery();
  return true;
};
