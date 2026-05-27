"use node";

import { createHash, randomUUID } from "node:crypto";
import { ConvexError, Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { requireSensitiveUserIdAction } from "../auth";
import { r2 } from "../r2_files";
import { enforceActionRateLimit, RATE_STANDARD } from "../lib/rate_limits";
import {
  store_release_source_pack_ref_validator,
  store_release_source_pack_validator,
} from "../schema/store";
import { requireBoundedString } from "../shared_validators";

const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const SOURCE_PACK_INLINE_BYTES = 650_000;
const SOURCE_PACK_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SOURCE_PACK_URL_EXPIRES_SECONDS = 5 * 60;

type StoreReleaseSourcePack = Infer<typeof store_release_source_pack_validator>;
type StoreReleaseSourcePackRef = Infer<
  typeof store_release_source_pack_ref_validator
>;
type StoreReleaseWithSourcePack = {
  sourcePack?: StoreReleaseSourcePack;
  sourcePackRef?: StoreReleaseSourcePackRef;
} | null;

const normalizePackageId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "packageId", 64);
  if (!PACKAGE_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Package ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const safeKeySegment = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || "unknown";

const requireSha256 = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "sourcePackRef.sha256 must be a sha256 digest.",
    });
  }
  return normalized;
};

const requireSourcePackSize = (sizeBytes: number): number => {
  if (
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= SOURCE_PACK_INLINE_BYTES ||
    sizeBytes > SOURCE_PACK_MAX_UPLOAD_BYTES
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `R2 source packs must be larger than ${SOURCE_PACK_INLINE_BYTES} bytes and at most ${SOURCE_PACK_MAX_UPLOAD_BYTES} bytes.`,
    });
  }
  return sizeBytes;
};

const sourcePackR2Prefix = (ownerId: string, packageId: string): string =>
  `store/source-packs/${safeKeySegment(ownerId)}/${packageId}`;

const hashBytes = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const fetchSourcePackRefText = async (ref: {
  r2Key: string;
  sha256: string;
  sizeBytes: number;
}): Promise<string> => {
  const url = await r2.getUrl(ref.r2Key, {
    expiresIn: SOURCE_PACK_URL_EXPIRES_SECONDS,
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new ConvexError({
      code: "SOURCE_PACK_UNAVAILABLE",
      message: `Could not read source pack from R2 (${response.status}).`,
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== ref.sizeBytes) {
    throw new ConvexError({
      code: "SOURCE_PACK_INTEGRITY_FAILED",
      message: "Source pack size does not match its recorded metadata.",
    });
  }
  if (hashBytes(bytes) !== ref.sha256) {
    throw new ConvexError({
      code: "SOURCE_PACK_INTEGRITY_FAILED",
      message: "Source pack hash does not match its recorded metadata.",
    });
  }
  return new TextDecoder().decode(bytes);
};

export const prepareSourcePackUpload = action({
  args: {
    packageId: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
  },
  returns: v.object({
    ref: store_release_source_pack_ref_validator,
    uploadUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "store_source_pack_prepare_upload",
      ownerId,
      RATE_STANDARD,
      "Too many source-pack uploads. Please wait before publishing again.",
    );
    const packageId = normalizePackageId(args.packageId);
    const sha256 = requireSha256(args.sha256);
    const sizeBytes = requireSourcePackSize(args.sizeBytes);
    const shortHash = sha256.slice("sha256:".length, "sha256:".length + 16);
    const r2Key = `${sourcePackR2Prefix(ownerId, packageId)}/${shortHash}-${randomUUID()}.json`;
    const upload = await r2.generateUploadUrl(r2Key);
    return {
      ref: {
        kind: "r2" as const,
        r2Key,
        sha256,
        sizeBytes,
      },
      uploadUrl: upload.url,
    };
  },
});

export const validateSourcePackRef = internalAction({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    ref: store_release_source_pack_ref_validator,
  },
  returns: store_release_source_pack_validator,
  handler: async (_ctx, args): Promise<StoreReleaseSourcePack> => {
    const packageId = normalizePackageId(args.packageId);
    const expectedPrefix = `${sourcePackR2Prefix(args.ownerId, packageId)}/`;
    if (!args.ref.r2Key.startsWith(expectedPrefix)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "sourcePackRef does not belong to this package.",
      });
    }
    requireSha256(args.ref.sha256);
    requireSourcePackSize(args.ref.sizeBytes);
    const text = await fetchSourcePackRefText(args.ref);
    try {
      return JSON.parse(text);
    } catch {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Uploaded source pack is not valid JSON.",
      });
    }
  },
});

export const deleteSourcePackRef = internalAction({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    ref: store_release_source_pack_ref_validator,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const packageId = normalizePackageId(args.packageId);
    const expectedPrefix = `${sourcePackR2Prefix(args.ownerId, packageId)}/`;
    if (!args.ref.r2Key.startsWith(expectedPrefix)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "sourcePackRef does not belong to this package.",
      });
    }
    await r2.deleteObject(ctx, args.ref.r2Key).catch((error) => {
      console.warn(
        "[store-source-packs] failed to delete rejected source pack:",
        error,
      );
    });
    return null;
  },
});

export const getReleaseSourcePack = action({
  args: {
    packageId: v.string(),
    releaseNumber: v.number(),
  },
  returns: v.union(store_release_source_pack_validator, v.null()),
  handler: async (ctx, args): Promise<StoreReleaseSourcePack | null> => {
    const identity = await ctx.auth.getUserIdentity();
    const release: StoreReleaseWithSourcePack = await ctx.runQuery(
      internal.data.store_packages.getReadableReleaseForSourcePackInternal,
      {
        packageId: args.packageId,
        releaseNumber: args.releaseNumber,
        ...(identity?.tokenIdentifier
          ? { callerOwnerId: identity.tokenIdentifier }
          : {}),
      },
    );
    if (!release) return null;
    if (release.sourcePack) return release.sourcePack;
    if (!release.sourcePackRef) return null;
    const text = await fetchSourcePackRefText(release.sourcePackRef);
    try {
      return JSON.parse(text);
    } catch {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Stored source pack is not valid JSON.",
      });
    }
  },
});
