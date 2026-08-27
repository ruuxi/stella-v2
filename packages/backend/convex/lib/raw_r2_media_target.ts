import { ConvexError } from "convex/values";

type RawR2BucketEnv = "R2_PETS_BUCKET" | "R2_EMOJI_BUCKET";
type RawR2PublicBaseEnv =
  | "R2_PETS_PUBLIC_BASE_URL"
  | "R2_EMOJI_PUBLIC_BASE_URL";

type RawR2MediaTarget = {
  bucket: string;
  publicBase: string;
};

type RawR2MediaTargets = {
  pets: RawR2MediaTarget;
  emoji: RawR2MediaTarget;
};

const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const DEVELOPMENT_BUCKET_MARKER = /(?:^|-)dev(?:-|$)/u;
const DEVELOPMENT_HOST_MARKER =
  /(?:^|[.-])(?:dev|development|preview|staging|test)(?:[.-]|$)/u;

const TARGET_ENV = {
  pets: {
    bucket: "R2_PETS_BUCKET",
    publicBase: "R2_PETS_PUBLIC_BASE_URL",
  },
  emoji: {
    bucket: "R2_EMOJI_BUCKET",
    publicBase: "R2_EMOJI_PUBLIC_BASE_URL",
  },
} as const satisfies Record<
  keyof RawR2MediaTargets,
  { bucket: RawR2BucketEnv; publicBase: RawR2PublicBaseEnv }
>;

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
 * Resolve the complete pet + emoji authority pair in one operation. Requiring
 * both pairs prevents a partially migrated deployment from silently routing
 * one product through the other product's bucket or public origin.
 */
export const requireConfiguredRawR2MediaTargets = (
  purpose: string,
): RawR2MediaTargets => {
  const pets = {
    bucket: requireDevelopmentBucket(TARGET_ENV.pets.bucket, purpose),
    publicBase: requireDevelopmentPublicBase(
      TARGET_ENV.pets.publicBase,
      purpose,
    ),
  };
  const emoji = {
    bucket: requireDevelopmentBucket(TARGET_ENV.emoji.bucket, purpose),
    publicBase: requireDevelopmentPublicBase(
      TARGET_ENV.emoji.publicBase,
      purpose,
    ),
  };

  if (pets.bucket === emoji.bucket) {
    return configurationError(
      `${purpose} requires distinct R2_PETS_BUCKET and R2_EMOJI_BUCKET values.`,
    );
  }
  if (pets.publicBase === emoji.publicBase) {
    return configurationError(
      `${purpose} requires distinct R2_PETS_PUBLIC_BASE_URL and R2_EMOJI_PUBLIC_BASE_URL origins.`,
    );
  }

  return { pets, emoji };
};

/**
 * Resolve the authority target for owner-authored raw R2 media.
 *
 * There is deliberately no production-looking fallback and no cross-product
 * bucket fallback. This development-only integration must name each exact
 * bucket and the distinct public origin authorized to serve that bucket.
 */
export const requireConfiguredRawR2MediaTarget = (args: {
  bucketEnv: RawR2BucketEnv;
  purpose: string;
}): { bucket: string; publicBase: string } => {
  const targets = requireConfiguredRawR2MediaTargets(args.purpose);
  return args.bucketEnv === TARGET_ENV.pets.bucket
    ? targets.pets
    : targets.emoji;
};
