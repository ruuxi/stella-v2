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
import { assertC8RetiredSurfaceUnavailable } from "../lib/c8_retired_surface";

const DEFAULT_PREFIX = "user-pets";
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
    ownerGeneration: v.string(),
    spritesheet: uploadTargetValidator,
    preview: v.optional(uploadTargetValidator),
  }),
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Custom pet uploads");
    const ownerId = await requireConnectedUserIdAction(ctx);
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
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
    const { bucket, publicBase } = requireConfiguredRawR2MediaTarget({
      bucketEnv: "R2_PETS_BUCKET",
      purpose: "Pet uploads",
    });
    const prefix = normalizePrefix(process.env.R2_PETS_PREFIX);
    const uploadId = randomUUID();
    const ownerKey = sha256Hex(ownerId).slice(0, 24);
    const baseKey = `${prefix}/${ownerKey}/${petId}/${uploadId}`;
    const makeDescriptor = (
      objectRole: string,
      filename: string,
      payloadHash: string,
    ) => {
      const key = `${baseKey}/${filename}`;
      return {
        objectRole,
        storageKind: "raw-r2" as const,
        bucket,
        key,
        payloadHash,
        publicUrl: `${publicBase}/${key}`,
      };
    };
    const spritesheetDescriptor = makeDescriptor(
      "spritesheet",
      "spritesheet.webp",
      normalizeSha256(args.spritesheetSha256, "spritesheetSha256"),
    );
    const previewDescriptor = args.previewSha256
      ? makeDescriptor(
          "preview",
          "preview.webp",
          normalizeSha256(args.previewSha256, "previewSha256"),
        )
      : undefined;
    const descriptors = [
      spritesheetDescriptor,
      ...(previewDescriptor ? [previewDescriptor] : []),
    ];
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
    const signTarget = (descriptor: (typeof descriptors)[number]) => {
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
    };
    const spritesheet = signTarget(spritesheetDescriptor);
    const preview = previewDescriptor
      ? signTarget(previewDescriptor)
      : undefined;
    return {
      uploadId,
      ownerGeneration,
      spritesheet,
      ...(preview ? { preview } : {}),
    };
  },
});
