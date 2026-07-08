"use node";

import { createHash, randomUUID } from "node:crypto";
import { signR2Put } from "../lib/r2_sigv4";
import { ConvexError, v } from "convex/values";
import { action } from "../_generated/server";
import { requireConnectedUserIdAction } from "../auth";
import {
  RATE_STANDARD,
  enforceActionRateLimit,
} from "../lib/rate_limits";
import { requireBoundedString } from "../shared_validators";

const DEFAULT_BUCKET = "stella-emotes";
const DEFAULT_PREFIX = "user-pets";
const DEFAULT_PUBLIC_BASE =
  "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev";
const MAX_PET_ID = 64;
const PET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const uploadTargetValidator = v.object({
  key: v.string(),
  publicUrl: v.string(),
  putUrl: v.string(),
  headers: v.record(v.string(), v.string()),
});

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "SERVER_MISCONFIGURED",
      message: `Missing ${name} for pet uploads.`,
    });
  }
  return value;
};

const normalizePetId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "petId", MAX_PET_ID);
  if (!PET_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Pet ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const normalizeSha256 = (value: string, fieldName: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be a SHA-256 hex digest.`,
    });
  }
  return normalized;
};

const normalizePrefix = (value: string | undefined): string =>
  (value?.trim() || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");

const sha256Hex = (data: string): string =>
  createHash("sha256").update(data).digest("hex");

export const createUploadUrl = action({
  args: {
    petId: v.string(),
    spritesheetSha256: v.string(),
    previewSha256: v.optional(v.string()),
    contentType: v.optional(v.string()),
  },
  returns: v.object({
    uploadId: v.string(),
    spritesheet: uploadTargetValidator,
    preview: v.optional(uploadTargetValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "userPets.createUploadUrl",
      ownerId,
      RATE_STANDARD,
    );
    const petId = normalizePetId(args.petId);
    const contentType = args.contentType?.trim() || "image/webp";
    if (contentType !== "image/webp") {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Pet spritesheets must be uploaded as image/webp.",
      });
    }
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
    const endpoint = requireEnv("R2_ENDPOINT");
    const bucket =
      process.env.R2_PETS_BUCKET?.trim() ||
      process.env.R2_EMOJI_BUCKET?.trim() ||
      DEFAULT_BUCKET;
    const prefix = normalizePrefix(process.env.R2_PETS_PREFIX);
    const publicBase = (
      process.env.R2_PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE
    ).replace(/\/+$/, "");
    const uploadId = randomUUID();
    const ownerKey = sha256Hex(ownerId).slice(0, 24);
    const baseKey = `${prefix}/${ownerKey}/${petId}/${uploadId}`;
    const makeTarget = (filename: string, payloadHash: string) => {
      const key = `${baseKey}/${filename}`;
      const signed = signR2Put({
        accessKeyId,
        secretAccessKey,
        endpoint,
        bucket,
        key,
        payloadHash,
        contentType,
        cacheControl: CACHE_CONTROL,
      });
      return {
        key,
        publicUrl: `${publicBase}/${key}`,
        putUrl: signed.putUrl,
        headers: signed.headers,
      };
    };
    const spritesheet = makeTarget(
      "spritesheet.webp",
      normalizeSha256(args.spritesheetSha256, "spritesheetSha256"),
    );
    const preview = args.previewSha256
      ? makeTarget(
          "preview.webp",
          normalizeSha256(args.previewSha256, "previewSha256"),
        )
      : undefined;
    return {
      uploadId,
      spritesheet,
      ...(preview ? { preview } : {}),
    };
  },
});
