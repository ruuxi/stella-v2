import { ConvexError } from "convex/values";

export const C8_DEV_DEPLOYMENT = "dev:impartial-crab-34" as const;
export const C8_DEV_CLOUD_URL =
  "https://impartial-crab-34.convex.cloud" as const;
export const C8_DEV_SITE_URL = "https://impartial-crab-34.convex.site" as const;
export const C8_RETIRED_WRITES_ENV =
  "STELLA_C8_RETIRED_WRITES_DISABLED" as const;
export const C8_RETIRED_WRITES_VALUE = "1" as const;
export const C8_DESTRUCTIVE_CONFIRMATION =
  "DELETE C8 DATA FROM impartial-crab-34" as const;

type C8Environment = Readonly<{
  CONVEX_CLOUD_URL?: string;
  CONVEX_SITE_URL?: string;
  STELLA_C8_RETIRED_WRITES_DISABLED?: string;
}>;

export const getC8WriterCutoverStatus = (env: C8Environment) => ({
  cloudUrlMatches: env.CONVEX_CLOUD_URL === C8_DEV_CLOUD_URL,
  siteUrlMatches: env.CONVEX_SITE_URL === C8_DEV_SITE_URL,
  retiredWritesDisabled:
    env.STELLA_C8_RETIRED_WRITES_DISABLED === C8_RETIRED_WRITES_VALUE,
});

export const assertC8CleanupDeployment = (env: C8Environment): void => {
  const status = getC8WriterCutoverStatus(env);
  if (!status.cloudUrlMatches || !status.siteUrlMatches) {
    throw new ConvexError({
      code: "C8_CLEANUP_WRONG_DEPLOYMENT",
      message:
        "The c8 cleanup is restricted to the impartial-crab-34 development deployment.",
    });
  }
  if (!status.retiredWritesDisabled) {
    throw new ConvexError({
      code: "C8_CLEANUP_WRITERS_NOT_DISABLED",
      message:
        "The c8 cleanup requires the durable retired-writer cutover marker.",
    });
  }
};

/**
 * Retire writers only inside the explicitly armed development cutover. An
 * absent marker leaves production, local development, and ordinary tests
 * unchanged; a present-but-invalid marker fails closed.
 */
export const assertC8RetiredSurfaceUnavailable = (
  surface: string,
  env: C8Environment = process.env,
): void => {
  if (env.STELLA_C8_RETIRED_WRITES_DISABLED === undefined) return;
  if (env.STELLA_C8_RETIRED_WRITES_DISABLED !== C8_RETIRED_WRITES_VALUE) {
    throw new ConvexError({
      code: "C8_RETIRED_WRITER_MARKER_INVALID",
      message: `Retired ${surface} writes have an invalid c8 cutover marker.`,
    });
  }
  assertC8CleanupDeployment(env);
  throw new ConvexError({
    code: "FEATURE_RETIRED",
    message: `${surface} is retired and unavailable.`,
  });
};
