"use node";

import { createHash, randomUUID } from "node:crypto";
import { signR2Put } from "../lib/r2_sigv4";
import { ConvexError, v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireConnectedUserIdAction } from "../auth";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { EXTERNAL_MEDIA_PRESIGNED_BARRIER_MS } from "../account_external_media_store";
import { RATE_STANDARD, enforceActionRateLimit } from "../lib/rate_limits";
import { requireConfiguredRawR2MediaTarget } from "../lib/raw_r2_media_target";
import { requireBoundedString } from "../shared_validators";

const DEFAULT_PREFIX = "emoji-packs";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAX_PACK_ID = 64;
const SHEET_COUNT = 3;
const PACK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

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
      message: `Missing ${name} for emoji pack uploads.`,
    });
  }
  return value;
};

const normalizePackId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "packId", MAX_PACK_ID);
  if (!PACK_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Pack ID must use lowercase letters, numbers, hyphens, or underscores.",
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
    packId: v.string(),
    sheetSha256s: v.array(v.string()),
    contentType: v.optional(v.string()),
  },
  returns: v.object({
    uploadId: v.string(),
    ownerGeneration: v.string(),
    sheets: v.array(uploadTargetValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserIdAction(ctx);
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    await enforceActionRateLimit(
      ctx,
      "emojiPacks.createUploadUrl",
      ownerId,
      RATE_STANDARD,
    );
    const packId = normalizePackId(args.packId);
    if (args.sheetSha256s.length !== SHEET_COUNT) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Emoji packs must upload exactly ${SHEET_COUNT} sheets.`,
      });
    }
    const contentType = args.contentType?.trim() || "image/webp";
    if (contentType !== "image/webp") {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Emoji pack sheets must be uploaded as image/webp.",
      });
    }
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
    const endpoint = requireEnv("R2_ENDPOINT");
    const { bucket, publicBase } =
      requireConfiguredRawR2MediaTarget("Emoji pack uploads");
    const prefix = normalizePrefix(process.env.R2_EMOJI_PREFIX);
    const uploadId = randomUUID();
    const ownerKey = sha256Hex(ownerId).slice(0, 24);
    const baseKey = `${prefix}/${ownerKey}/${packId}/${uploadId}`;
    const descriptors = args.sheetSha256s.map((sha, index) => {
      const key = `${baseKey}/sheet-${index + 1}.webp`;
      return {
        objectRole: `sheet-${index + 1}`,
        storageKind: "raw-r2" as const,
        bucket,
        key,
        payloadHash: normalizeSha256(sha, `sheetSha256s[${index}]`),
        publicUrl: `${publicBase}/${key}`,
      };
    });
    const now = Date.now();
    const uploadExpiresAt = now + EXTERNAL_MEDIA_PRESIGNED_BARRIER_MS;
    await ctx.runMutation(
      internal.account_external_media_store.reserveExternalMediaUploadInternal,
      {
        ownerId,
        ownerGeneration,
        uploadId,
        uploadExpiresAt,
        objects: descriptors.map((descriptor) => ({
          objectRole: descriptor.objectRole,
          storageKind: descriptor.storageKind,
          bucket: descriptor.bucket,
          r2Key: descriptor.key,
          payloadSha256: descriptor.payloadHash,
          publicUrl: descriptor.publicUrl,
        })),
        now,
      },
    );
    await ctx.runMutation(
      internal.account_external_media_store
        .assertExternalMediaUploadDispatchInternal,
      { ownerId, ownerGeneration, uploadId, now: Date.now() },
    );
    const sheets = descriptors.map((descriptor) => {
      const signed = signR2Put({
        accessKeyId,
        secretAccessKey,
        endpoint,
        bucket,
        key: descriptor.key,
        payloadHash: descriptor.payloadHash,
        contentType,
        cacheControl: CACHE_CONTROL,
      });
      return {
        key: descriptor.key,
        publicUrl: descriptor.publicUrl,
        putUrl: signed.putUrl,
        headers: signed.headers,
      };
    });
    return { uploadId, ownerGeneration, sheets };
  },
});
