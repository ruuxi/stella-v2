import { ConvexError } from "convex/values";

/**
 * R2 destination for generated emoji-pack assets.
 *
 * Bucket and public base URL are a *pair*: objects are written to the bucket
 * over the S3 endpoint, and the rows we persist reference them through the
 * public base. Configuring one without the other silently produces rows whose
 * `publicUrl` points at an origin that never serves the bytes we just wrote,
 * so the two are validated together instead of defaulting independently.
 *
 * Deployments either take the built-in pair wholesale or override both.
 * There is deliberately no per-field fallback and no compatibility read of
 * any retired bucket variable.
 */

/** Built-in pair. Only used when neither override is set. */
const BUILT_IN_BUCKET = "stella-emotes";
const BUILT_IN_PUBLIC_BASE =
  "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev";
const DEFAULT_PREFIX = "emoji-packs";

export type EmojiPackR2Destination = {
  bucket: string;
  publicBase: string;
  prefix: string;
};

const misconfigured = (message: string): never => {
  throw new ConvexError({ code: "SERVER_MISCONFIGURED", message });
};

const normalizePrefix = (value: string | undefined): string =>
  (value?.trim() || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");

export const resolveEmojiPackR2Destination = (): EmojiPackR2Destination => {
  const bucket = process.env.R2_EMOJI_BUCKET?.trim();
  const publicBase = process.env.R2_PUBLIC_BASE_URL?.trim();
  const prefix = normalizePrefix(process.env.R2_EMOJI_PREFIX);

  if (bucket && !publicBase) {
    misconfigured(
      "R2_EMOJI_BUCKET is set but R2_PUBLIC_BASE_URL is not. Emoji pack rows would reference an origin that does not serve the bucket; set both or neither.",
    );
  }
  if (publicBase && !bucket) {
    misconfigured(
      "R2_PUBLIC_BASE_URL is set but R2_EMOJI_BUCKET is not. Emoji pack rows would reference an origin that does not serve the bucket; set both or neither.",
    );
  }
  if (!bucket || !publicBase) {
    return {
      bucket: BUILT_IN_BUCKET,
      publicBase: BUILT_IN_PUBLIC_BASE,
      prefix,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(publicBase);
  } catch {
    return misconfigured("R2_PUBLIC_BASE_URL must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    misconfigured("R2_PUBLIC_BASE_URL must be an absolute http(s) URL.");
  }

  return {
    bucket,
    publicBase: publicBase.replace(/\/+$/, ""),
    prefix,
  };
};
