import { ConvexError } from "convex/values";

type RawR2BucketEnv = "R2_EMOJI_BUCKET";
type RawR2PublicBaseEnv = "R2_EMOJI_PUBLIC_BASE_URL";

type RawR2MediaTarget = {
  bucket: string;
  publicBase: string;
};

const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const DEVELOPMENT_BUCKET_MARKER = /(?:^|-)dev(?:-|$)/u;
const DEVELOPMENT_HOST_MARKER =
  /(?:^|[.-])(?:dev|development|preview|staging|test)(?:[.-]|$)/u;

const EMOJI_TARGET_ENV = {
  bucket: "R2_EMOJI_BUCKET",
  publicBase: "R2_EMOJI_PUBLIC_BASE_URL",
} as const satisfies { bucket: RawR2BucketEnv; publicBase: RawR2PublicBaseEnv };

const configurationError = (message: string): never => {
  throw new ConvexError({
    code: "SERVER_MISCONFIGURED",
    message,
  });
};

const requireExactEnv = (
  envName: RawR2BucketEnv | RawR2PublicBaseEnv,
  purpose: string,
): string => {
  const raw = process.env[envName];
  if (!raw || raw !== raw.trim()) {
    return configurationError(
      `${purpose} requires an exact ${envName} development configuration.`,
    );
  }
  return raw;
};

const requireDevelopmentBucket = (
  envName: RawR2BucketEnv,
  purpose: string,
): string => {
  const bucket = requireExactEnv(envName, purpose);
  if (!BUCKET_PATTERN.test(bucket)) {
    return configurationError(`${purpose} has an invalid ${envName}.`);
  }
  if (!DEVELOPMENT_BUCKET_MARKER.test(bucket)) {
    return configurationError(
      `${purpose} requires ${envName} to name an explicitly development-only bucket.`,
    );
  }
  return bucket;
};

const requireDevelopmentPublicBase = (
  envName: RawR2PublicBaseEnv,
  purpose: string,
): string => {
  const value = requireExactEnv(envName, purpose);
  let publicOrigin: URL;
  try {
    publicOrigin = new URL(value);
  } catch {
    return configurationError(`${purpose} has an invalid ${envName}.`);
  }
  const hostname = publicOrigin.hostname.toLowerCase();
  const developmentOrigin =
    hostname.endsWith(".r2.dev") || DEVELOPMENT_HOST_MARKER.test(hostname);
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.username ||
    publicOrigin.password ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search ||
    publicOrigin.hash ||
    value !== publicOrigin.origin ||
    !developmentOrigin
  ) {
    return configurationError(
      `${purpose} requires ${envName} to be an exact development HTTPS origin.`,
    );
  }
  return publicOrigin.origin;
};

/**
 * Resolve the authority target for owner-authored raw R2 media.
 *
 * There is deliberately no production-looking fallback and no fallback onto
 * the legacy shared public base. This development-only integration must name
 * the exact bucket and the distinct public origin authorized to serve it.
 */
export const requireConfiguredRawR2MediaTarget = (
  purpose: string,
): RawR2MediaTarget => ({
  bucket: requireDevelopmentBucket(EMOJI_TARGET_ENV.bucket, purpose),
  publicBase: requireDevelopmentPublicBase(
    EMOJI_TARGET_ENV.publicBase,
    purpose,
  ),
});
