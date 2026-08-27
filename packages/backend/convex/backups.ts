import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptSecret, encryptSecret } from "./data/secrets_crypto";
import { base64UrlDecode, bytesToHex } from "./lib/crypto_utils";
import { assertOwnerDataWriteAllowed } from "./owner_lifecycle";
import { r2 } from "./r2_files";
import { requireBoundedString } from "./shared_validators";

const BACKUP_KEY_BYTES = 32;
const MAX_DEVICE_ID_LENGTH = 200;
const MAX_HOSTNAME_LENGTH = 200;
const MAX_SNAPSHOT_ID_LENGTH = 200;
// A prepare/finalize request performs multiple indexed reads and up to two
// writes per missing object. Keep the public transaction below a proven-safe
// bound instead of accepting 10k rows that Convex cannot commit atomically.
const MAX_OBJECT_BATCH_SIZE = 256;
const MAX_LIST_LIMIT = 100;
const MAX_BACKUP_KEYS_PER_OWNER = 64;
const MAX_OBJECT_CIPHERTEXT_VARIANTS = 64;
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 60 * 60;
/** R2 component upload URLs default to 15 minutes; keep a full safety margin. */
export const BACKUP_UPLOAD_AUTHORITY_MS = 20 * 60_000;
/**
 * Cap on the number of "isLatest=true" manifest rows we'll consider when
 * recording a new latest snapshot. By invariant this is 0 or 1; the cap is a
 * safety bound so a previously-corrupted state with multiple "latest" rows
 * can still be repaired without scanning the table unbounded.
 */
const MAX_LATEST_MANIFEST_REPAIR_BATCH = 32;

const sha256HexPattern = /^[a-f0-9]{64}$/;
const snapshotIdPattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/u;

const uploadObjectValidator = v.object({
  objectId: v.string(),
  ciphertextSha256: v.string(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
});

const uploadedObjectValidator = v.object({
  objectId: v.string(),
  ciphertextSha256: v.string(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
  r2Key: v.string(),
});

const manifestPayloadValidator = v.object({
  r2Key: v.string(),
  ciphertextSha256: v.string(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
});

const manifestUploadMetadataValidator = v.object({
  ciphertextSha256: v.string(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
});

const backupSummaryValidator = v.object({
  snapshotId: v.string(),
  originalSnapshotId: v.optional(v.string()),
  snapshotHash: v.string(),
  sourceDeviceId: v.string(),
  sourceHostname: v.optional(v.string()),
  createdAt: v.number(),
  entryCount: v.number(),
  objectCount: v.number(),
  isLatest: v.boolean(),
});

const manifestDownloadPlanValidator = v.object({
  snapshot: backupSummaryValidator,
  /** Key for decrypting this immutable historical snapshot. */
  keyBase64Url: v.string(),
  /** Sole current key that the desktop must retain for its next upload. */
  uploadKeyBase64Url: v.string(),
  uploadKeyFingerprint: v.string(),
  manifest: v.object({
    downloadUrl: v.string(),
    r2Key: v.string(),
    ciphertextSha256: v.optional(v.string()),
    plaintextSha256: v.string(),
    plaintextSize: v.number(),
    algorithm: v.string(),
    ivBase64Url: v.string(),
    authTagBase64Url: v.string(),
  }),
});

const objectDownloadValidator = v.object({
  objectId: v.string(),
  downloadUrl: v.string(),
  r2Key: v.string(),
  ciphertextSha256: v.optional(v.string()),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
});

const keyEscrowStatusValidator = v.union(
  v.null(),
  v.object({
    keyBase64Url: v.string(),
    keyFingerprint: v.string(),
    updatedAt: v.number(),
  }),
);

const keyEnsureResultValidator = v.object({
  status: v.union(
    v.literal("created"),
    v.literal("matched"),
    v.literal("mismatch"),
  ),
  keyFingerprint: v.string(),
  updatedAt: v.number(),
  remoteKeyBase64Url: v.optional(v.string()),
});

const prepareUploadResultValidator = v.union(
  v.object({
    status: v.literal("already_finalized"),
    keyFingerprint: v.string(),
    snapshotId: v.string(),
  }),
  v.object({
    status: v.literal("prepared"),
    keyFingerprint: v.string(),
    existingObjectIds: v.array(v.string()),
    missingObjects: v.array(
      v.object({
        objectId: v.string(),
        r2Key: v.string(),
        uploadUrl: v.string(),
      }),
    ),
    manifest: v.object({
      r2Key: v.string(),
      uploadUrl: v.string(),
    }),
  }),
);

const finalizeUploadResultValidator = v.object({
  snapshotId: v.string(),
  isLatest: v.boolean(),
});

const trimRequired = (
  value: string,
  fieldName: string,
  maxLength: number,
): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} is required.`,
    });
  }
  requireBoundedString(trimmed, fieldName, maxLength);
  return trimmed;
};

const requireSha256Hex = (value: string, fieldName: string): string => {
  const normalized = trimRequired(value, fieldName, 64).toLowerCase();
  if (!sha256HexPattern.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be a 64-character sha256 hex string.`,
    });
  }
  return normalized;
};

const requireSnapshotId = (value: string): string => {
  const snapshotId = trimRequired(value, "snapshotId", MAX_SNAPSHOT_ID_LENGTH);
  if (
    !snapshotIdPattern.test(snapshotId) ||
    snapshotId === "." ||
    snapshotId === ".."
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "snapshotId must be a safe opaque path segment.",
    });
  }
  return snapshotId;
};

const requireKeyBase64Url = (value: string): string => {
  const trimmed = trimRequired(value, "keyBase64Url", 256);
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(trimmed);
  } catch {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Backup key must be valid base64url.",
    });
  }
  if (decoded.byteLength !== BACKUP_KEY_BYTES) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Backup key must be 32 bytes.",
    });
  }
  return trimmed;
};

const requireMatchingKeyFingerprint = async (
  keyBase64Url: string,
  suppliedFingerprint: string,
): Promise<string> => {
  const keyBytes = new Uint8Array(base64UrlDecode(keyBase64Url));
  const digest = await crypto.subtle.digest("SHA-256", keyBytes);
  const derived = bytesToHex(new Uint8Array(digest));
  const normalized = requireSha256Hex(suppliedFingerprint, "keyFingerprint");
  if (derived !== normalized) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Backup key fingerprint does not match the supplied key.",
    });
  }
  return normalized;
};

const sanitizeLimit = (value: number | undefined) => {
  if (value === undefined) {
    return 50;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `limit must be between 1 and ${MAX_LIST_LIMIT}.`,
    });
  }
  return value;
};

const requireBatchSize = (size: number, fieldName: string) => {
  if (size > MAX_OBJECT_BATCH_SIZE) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} exceeds the maximum batch size of ${MAX_OBJECT_BATCH_SIZE}.`,
    });
  }
};

const encodeKeyPart = (value: string) => encodeURIComponent(value);

type CiphertextMetadata = {
  ciphertextSha256: string;
  plaintextSha256: string;
  plaintextSize: number;
  algorithm: string;
  ivBase64Url: string;
  authTagBase64Url: string;
};

const ciphertextBinding = async (metadata: CiphertextMetadata) => {
  const encoded = new TextEncoder().encode(
    JSON.stringify([
      metadata.ciphertextSha256,
      metadata.plaintextSha256,
      metadata.plaintextSize,
      metadata.algorithm,
      metadata.ivBase64Url,
      metadata.authTagBase64Url,
    ]),
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)),
  );
};

const getObjectR2Key = (
  ownerId: string,
  keyFingerprint: string,
  objectId: string,
  ciphertextSha256: string,
) =>
  `backups/${encodeKeyPart(ownerId)}/keys/${keyFingerprint}/objects/${objectId}/${ciphertextSha256}.bin`;

const getManifestR2KeyPrefix = (
  ownerId: string,
  keyFingerprint: string,
  snapshotId: string,
) =>
  `backups/${encodeKeyPart(ownerId)}/keys/${keyFingerprint}/manifests/${encodeKeyPart(snapshotId)}/`;

const getManifestR2Key = (
  ownerId: string,
  keyFingerprint: string,
  snapshotId: string,
  uploadAttemptId: string,
  ciphertextSha256: string,
) =>
  `${getManifestR2KeyPrefix(ownerId, keyFingerprint, snapshotId)}${uploadAttemptId}-${ciphertextSha256}.bin`;

type BackupUploadReservationKind = "object" | "manifest";

const getBackupUploadReservation = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  r2Key: string,
) =>
  await ctx.db
    .query("backup_upload_reservations")
    .withIndex("by_ownerId_and_r2Key", (q) =>
      q.eq("ownerId", ownerId).eq("r2Key", r2Key),
    )
    .unique();

const reserveBackupUpload = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    keyFingerprint: string;
    kind: BackupUploadReservationKind;
    snapshotId: string;
    objectId?: string;
    r2Key: string;
    ciphertextBinding: string;
    now: number;
  },
): Promise<number> => {
  const requestedUploadExpiresAt = args.now + BACKUP_UPLOAD_AUTHORITY_MS;
  const existing = await getBackupUploadReservation(
    ctx,
    args.ownerId,
    args.r2Key,
  );
  if (existing) {
    if (
      existing.keyFingerprint !== args.keyFingerprint ||
      existing.kind !== args.kind ||
      existing.objectId !== args.objectId ||
      existing.ciphertextBinding !== args.ciphertextBinding
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Backup upload key is already reserved for another object.",
      });
    }
    if (
      existing.ownerGeneration !== args.ownerGeneration &&
      existing.uploadExpiresAt > args.now
    ) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message:
          "A backup upload from an older account-data generation is still active.",
      });
    }
    // A content-addressed object reservation is intentionally shared across
    // concurrent snapshots. Never shorten an already-issued PUT authority;
    // the final object row inherits the maximum expiry before this reservation
    // is consumed.
    const uploadExpiresAt = Math.max(
      existing.uploadExpiresAt,
      requestedUploadExpiresAt,
    );
    await ctx.db.patch(existing._id, {
      ownerGeneration: args.ownerGeneration,
      keyFingerprint: args.keyFingerprint,
      snapshotId: args.snapshotId,
      uploadExpiresAt,
      updatedAt: args.now,
    });
    return uploadExpiresAt;
  }
  await ctx.db.insert("backup_upload_reservations", {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    keyFingerprint: args.keyFingerprint,
    kind: args.kind,
    snapshotId: args.snapshotId,
    ...(args.objectId ? { objectId: args.objectId } : {}),
    r2Key: args.r2Key,
    ciphertextBinding: args.ciphertextBinding,
    uploadExpiresAt: requestedUploadExpiresAt,
    createdAt: args.now,
    updatedAt: args.now,
  });
  return requestedUploadExpiresAt;
};

const toBackupSummary = (record: {
  snapshotId: string;
  originalSnapshotId?: string;
  snapshotHash: string;
  sourceDeviceId: string;
  sourceHostname?: string;
  createdAt: number;
  entryCount: number;
  objectCount: number;
  isLatest: boolean;
}) => ({
  snapshotId: record.snapshotId,
  originalSnapshotId: record.originalSnapshotId,
  snapshotHash: record.snapshotHash,
  sourceDeviceId: record.sourceDeviceId,
  sourceHostname: record.sourceHostname,
  createdAt: record.createdAt,
  entryCount: record.entryCount,
  objectCount: record.objectCount,
  isLatest: record.isLatest,
});

const requireRegisteredDevice = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  deviceId: string,
) => {
  const { generation: ownerGeneration } = await assertOwnerDataWriteAllowed(
    ctx,
    ownerId,
  );
  const [ownerMigrations, incomingPending, incomingRunning] = await Promise.all(
    [
      ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
          q.eq("fromOwnerId", ownerId),
        )
        .take(2),
      ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
          q.eq("toOwnerId", ownerId).eq("status", "pending"),
        )
        .take(1),
      ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
          q.eq("toOwnerId", ownerId).eq("status", "running"),
        )
        .take(1),
    ],
  );
  if (ownerMigrations.length > 1) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_CONFLICT",
      message: "Duplicate account-link migrations require repair.",
    });
  }
  if (ownerMigrations[0] && ownerMigrations[0].status !== "failed") {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_ACTIVE",
      message: "Backups are unavailable while this account is being linked.",
    });
  }
  if (incomingPending.length > 0 || incomingRunning.length > 0) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_ACTIVE",
      message: "Backups are unavailable while account data is being linked.",
    });
  }
  const normalizedDeviceId = trimRequired(
    deviceId,
    "deviceId",
    MAX_DEVICE_ID_LENGTH,
  );
  const device = await ctx.db
    .query("devices")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", normalizedDeviceId),
    )
    .unique();
  if (!device) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "This device is not registered for the signed-in account.",
    });
  }
  if (device.ownerGeneration !== ownerGeneration) {
    throw new ConvexError({
      code: "OWNER_DATA_GENERATION_STALE",
      message:
        "This device registration predates the current account-data generation.",
    });
  }
  return { deviceId: normalizedDeviceId, ownerGeneration };
};

const listKeyEscrowRecords = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
) => {
  const rows = await ctx.db
    .query("backup_key_escrows")
    .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
    .take(MAX_BACKUP_KEYS_PER_OWNER + 1);
  if (rows.length > MAX_BACKUP_KEYS_PER_OWNER) {
    throw new ConvexError({
      code: "CONFLICT",
      message: "This account has too many backup encryption keys.",
    });
  }
  return rows;
};

const getKeyEscrowByFingerprint = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  keyFingerprint: string,
) =>
  await ctx.db
    .query("backup_key_escrows")
    .withIndex("by_ownerId_and_keyFingerprint", (q) =>
      q.eq("ownerId", ownerId).eq("keyFingerprint", keyFingerprint),
    )
    .unique();

const getCurrentKeyEscrowRecord = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  ownerGeneration: string,
) => {
  const explicit = await ctx.db
    .query("backup_key_escrows")
    .withIndex("by_ownerId_and_isCurrent", (q) =>
      q.eq("ownerId", ownerId).eq("isCurrent", true),
    )
    .take(2);
  if (explicit.length > 1) {
    throw new ConvexError({
      code: "CONFLICT",
      message: "This account has multiple current backup encryption keys.",
    });
  }
  const rows =
    explicit.length === 1 ? explicit : await listKeyEscrowRecords(ctx, ownerId);
  const current = explicit[0] ?? (rows.length === 1 ? rows[0] : null);
  if (!current) {
    if (rows.length > 1) {
      throw new ConvexError({
        code: "CONFLICT",
        message:
          "This account has no unambiguous current backup encryption key.",
      });
    }
    return null;
  }
  if (current.ownerGeneration !== ownerGeneration) {
    throw new ConvexError({
      code: "OWNER_DATA_GENERATION_STALE",
      message: "The backup key predates the current account-data generation.",
    });
  }
  return current;
};

/**
 * Bounded rollout normalization for owners whose backups predate generation,
 * key-group, and PUT-expiry metadata. It is safe only when exactly one escrow
 * can identify every legacy ciphertext. Multi-key ambiguity fails closed.
 */
export const normalizeLegacyBackupOwnerInternal = internalMutation({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const { ownerGeneration } = await requireRegisteredDevice(
      ctx,
      ownerId,
      args.deviceId,
    );
    const [escrows, objectSets, manifestSets] = await Promise.all([
      listKeyEscrowRecords(ctx, ownerId),
      Promise.all([
        ctx.db
          .query("backup_objects")
          .withIndex("by_ownerId_and_keyFingerprint_and_createdAt", (q) =>
            q.eq("ownerId", ownerId).eq("keyFingerprint", undefined),
          )
          .take(MAX_OBJECT_BATCH_SIZE + 1),
        ctx.db
          .query("backup_objects")
          .withIndex("by_ownerId_and_ownerGeneration_and_createdAt", (q) =>
            q.eq("ownerId", ownerId).eq("ownerGeneration", undefined),
          )
          .take(MAX_OBJECT_BATCH_SIZE + 1),
        ctx.db
          .query("backup_objects")
          .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
            q.eq("ownerId", ownerId).eq("uploadExpiresAt", undefined),
          )
          .take(MAX_OBJECT_BATCH_SIZE + 1),
      ]),
      Promise.all([
        ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_keyFingerprint_and_createdAt", (q) =>
            q.eq("ownerId", ownerId).eq("keyFingerprint", undefined),
          )
          .take(MAX_OBJECT_BATCH_SIZE + 1),
        ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_ownerGeneration_and_createdAt", (q) =>
            q.eq("ownerId", ownerId).eq("ownerGeneration", undefined),
          )
          .take(MAX_OBJECT_BATCH_SIZE + 1),
        ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
            q.eq("ownerId", ownerId).eq("uploadExpiresAt", undefined),
          )
          .take(MAX_OBJECT_BATCH_SIZE + 1),
      ]),
    ]);
    const objectCandidates = [
      ...new Map(
        objectSets.flat().map((row) => [String(row._id), row] as const),
      ).values(),
    ];
    const manifestCandidates = [
      ...new Map(
        manifestSets.flat().map((row) => [String(row._id), row] as const),
      ).values(),
    ];
    const hasLegacyRows =
      objectCandidates.length > 0 || manifestCandidates.length > 0;
    if (hasLegacyRows && escrows.length !== 1) {
      throw new ConvexError({
        code: "CONFLICT",
        message:
          "Legacy backups cannot be assigned safely without exactly one encryption key.",
      });
    }
    const escrow = escrows.length === 1 ? escrows[0] : null;
    if (!escrow) return { hasMore: false };
    if (
      escrow.ownerGeneration !== undefined &&
      escrow.ownerGeneration !== ownerGeneration
    ) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message: "The backup key predates the current account-data generation.",
      });
    }
    const keyFingerprint = requireSha256Hex(
      escrow.keyFingerprint,
      "keyFingerprint",
    );
    const now = Date.now();
    if (
      escrow.ownerGeneration === undefined ||
      escrow.isCurrent !== true ||
      escrow.keyFingerprint !== keyFingerprint
    ) {
      await ctx.db.patch(escrow._id, {
        ownerGeneration,
        keyFingerprint,
        isCurrent: true,
        updatedAt: now,
      });
    }
    const boundedObjects = objectCandidates.slice(0, MAX_OBJECT_BATCH_SIZE);
    const boundedManifests = manifestCandidates.slice(0, MAX_OBJECT_BATCH_SIZE);
    for (const row of [...boundedObjects, ...boundedManifests]) {
      if (
        (row.ownerGeneration !== undefined &&
          row.ownerGeneration !== ownerGeneration) ||
        (row.keyFingerprint !== undefined &&
          row.keyFingerprint !== keyFingerprint)
      ) {
        throw new ConvexError({
          code: "OWNER_DATA_GENERATION_STALE",
          message:
            "Legacy backup metadata conflicts with the current account-data generation or key.",
        });
      }
      await ctx.db.patch(row._id, {
        ownerGeneration,
        keyFingerprint,
        uploadExpiresAt:
          row.uploadExpiresAt ?? now + BACKUP_UPLOAD_AUTHORITY_MS,
      });
    }
    return {
      hasMore:
        objectCandidates.length > MAX_OBJECT_BATCH_SIZE ||
        manifestCandidates.length > MAX_OBJECT_BATCH_SIZE ||
        objectSets.some((rows) => rows.length > MAX_OBJECT_BATCH_SIZE) ||
        manifestSets.some((rows) => rows.length > MAX_OBJECT_BATCH_SIZE),
    };
  },
});

const resolveBackupKeyGroup = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  ownerGeneration: string,
  keyFingerprint: string | undefined,
) => {
  if (keyFingerprint !== undefined) {
    const normalized = requireSha256Hex(keyFingerprint, "keyFingerprint");
    const escrow = await getKeyEscrowByFingerprint(ctx, ownerId, normalized);
    if (!escrow) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Backup encryption key not found for this snapshot.",
      });
    }
    if (escrow.ownerGeneration !== ownerGeneration) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message: "The backup key predates the current account-data generation.",
      });
    }
    return { keyFingerprint: normalized, escrow };
  }

  // Rows written before backup key groups existed can only be normalized when
  // exactly one escrow exists. Guessing the current key in a multi-key account
  // could hand out ciphertext under the wrong decryption authority.
  const escrows = await listKeyEscrowRecords(ctx, ownerId);
  if (escrows.length !== 1) {
    throw new ConvexError({
      code: "CONFLICT",
      message: "A legacy backup has ambiguous encryption-key ownership.",
    });
  }
  const escrow = escrows[0];
  if (escrow.ownerGeneration !== ownerGeneration) {
    throw new ConvexError({
      code: "OWNER_DATA_GENERATION_STALE",
      message: "The backup key predates the current account-data generation.",
    });
  }
  return { keyFingerprint: escrow.keyFingerprint, escrow };
};

const getManifestRecord = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  snapshotId: string,
) =>
  await ctx.db
    .query("backup_manifests")
    .withIndex("by_ownerId_and_snapshotId", (q) =>
      q.eq("ownerId", ownerId).eq("snapshotId", snapshotId),
    )
    .unique();

const getObjectRecordsForKey = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  keyFingerprint: string,
  objectId: string,
) => {
  const exact = await ctx.db
    .query("backup_objects")
    .withIndex("by_ownerId_and_keyFingerprint_and_objectId", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("keyFingerprint", keyFingerprint)
        .eq("objectId", objectId),
    )
    .take(MAX_OBJECT_CIPHERTEXT_VARIANTS + 1);
  if (exact.length > MAX_OBJECT_CIPHERTEXT_VARIANTS) {
    throw new ConvexError({
      code: "CONFLICT",
      message: "A backup object has too many ciphertext variants.",
    });
  }
  if (exact.length > 1) {
    const [canonical, ...variants] = exact;
    if (
      variants.some(
        (row) =>
          row.plaintextSha256 !== canonical.plaintextSha256 ||
          row.plaintextSize !== canonical.plaintextSize,
      )
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "A backup object has incompatible key-group variants.",
      });
    }
  }
  return exact;
};

const getObjectRecord = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  keyFingerprint: string,
  objectId: string,
  allowLegacy: boolean,
) => {
  const exact = await getObjectRecordsForKey(
    ctx,
    ownerId,
    keyFingerprint,
    objectId,
  );
  if (exact[0]) return exact[0];
  if (!allowLegacy) return null;

  const legacy = await ctx.db
    .query("backup_objects")
    .withIndex("by_ownerId_and_keyFingerprint_and_objectId", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("keyFingerprint", undefined)
        .eq("objectId", objectId),
    )
    .take(2);
  if (legacy.length === 1) {
    const acrossKeyGroups = await ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_objectId", (q) =>
        q.eq("ownerId", ownerId).eq("objectId", objectId),
      )
      .take(2);
    if (acrossKeyGroups.length === 1) return legacy[0];
  }
  if (legacy.length > 0) {
    throw new ConvexError({
      code: "CONFLICT",
      message: "A legacy backup object has ambiguous encryption-key ownership.",
    });
  }
  return null;
};

export const assertDeviceOwnedInternal = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
  },
  returns: v.object({
    deviceId: v.string(),
    ownerGeneration: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    return await requireRegisteredDevice(ctx, ownerId, args.deviceId);
  },
});

type KeyEscrowStatus = {
  keyBase64Url: string;
  keyFingerprint: string;
  updatedAt: number;
} | null;

export const getKeyEscrowStatusInternal = internalAction({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
  },
  returns: keyEscrowStatusValidator,
  handler: async (ctx, args): Promise<KeyEscrowStatus> => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const row: {
      ownerGeneration: string;
      encryptedKey: string;
      keyFingerprint: string;
      updatedAt: number;
    } | null = await ctx.runQuery(internal.backups.getKeyEscrowRowInternal, {
      ownerId,
      deviceId: args.deviceId,
    });
    if (!row) {
      return null;
    }
    await ctx.runMutation(
      internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
      { ownerId, ownerGeneration: row.ownerGeneration },
    );
    return {
      keyBase64Url: await decryptSecret(row.encryptedKey),
      keyFingerprint: row.keyFingerprint,
      updatedAt: row.updatedAt,
    };
  },
});

export const getKeyEscrowRowInternal = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      ownerGeneration: v.string(),
      encryptedKey: v.string(),
      keyFingerprint: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const { ownerGeneration } = await requireRegisteredDevice(
      ctx,
      ownerId,
      args.deviceId,
    );
    const row = await getCurrentKeyEscrowRecord(ctx, ownerId, ownerGeneration);
    if (!row) {
      return null;
    }
    return {
      ownerGeneration,
      encryptedKey: row.encryptedKey,
      keyFingerprint: row.keyFingerprint,
      updatedAt: row.updatedAt,
    };
  },
});

export const ensureKeyEscrowInternal = internalMutation({
  args: {
    ownerId: v.string(),
    sourceDeviceId: v.string(),
    keyBase64Url: v.string(),
    keyFingerprint: v.string(),
  },
  returns: keyEnsureResultValidator,
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const { deviceId: sourceDeviceId, ownerGeneration } =
      await requireRegisteredDevice(ctx, ownerId, args.sourceDeviceId);
    const keyBase64Url = requireKeyBase64Url(args.keyBase64Url);
    const keyFingerprint = await requireMatchingKeyFingerprint(
      keyBase64Url,
      args.keyFingerprint,
    );
    const now = Date.now();
    const [keys, exact, current] = await Promise.all([
      listKeyEscrowRecords(ctx, ownerId),
      getKeyEscrowByFingerprint(ctx, ownerId, keyFingerprint),
      getCurrentKeyEscrowRecord(ctx, ownerId, ownerGeneration),
    ]);
    if (exact && exact.ownerGeneration !== ownerGeneration) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message: "The backup key predates the current account-data generation.",
      });
    }
    if (keys.length === 0) {
      const encryptedPayload = await encryptSecret(keyBase64Url);
      await ctx.db.insert("backup_key_escrows", {
        ownerId,
        ownerGeneration,
        encryptedKey: JSON.stringify(encryptedPayload),
        keyFingerprint,
        isCurrent: true,
        keyVersion: encryptedPayload.keyVersion,
        sourceDeviceId,
        createdAt: now,
        updatedAt: now,
      });
      return {
        status: "created" as const,
        keyFingerprint,
        updatedAt: now,
      };
    }
    if (!current && exact) {
      await ctx.db.patch(exact._id, { isCurrent: true, updatedAt: now });
      return {
        status: "matched" as const,
        keyFingerprint,
        updatedAt: now,
      };
    }
    if (!current) {
      throw new ConvexError({
        code: "CONFLICT",
        message:
          "This account has no unambiguous current backup encryption key.",
      });
    }
    if (current.keyFingerprint === keyFingerprint) {
      if (current.isCurrent !== true) {
        await ctx.db.patch(current._id, { isCurrent: true, updatedAt: now });
      }
      return {
        status: "matched" as const,
        keyFingerprint,
        updatedAt: current.isCurrent === true ? current.updatedAt : now,
      };
    }

    return {
      status: "mismatch" as const,
      keyFingerprint: current.keyFingerprint,
      updatedAt: current.updatedAt,
      remoteKeyBase64Url: await decryptSecret(current.encryptedKey),
    };
  },
});

export const prepareUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    sourceDeviceId: v.string(),
    snapshotId: v.string(),
    snapshotHash: v.string(),
    createdAt: v.number(),
    objects: v.array(uploadObjectValidator),
    manifest: manifestUploadMetadataValidator,
  },
  returns: prepareUploadResultValidator,
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const { deviceId: sourceDeviceId, ownerGeneration } =
      await requireRegisteredDevice(ctx, ownerId, args.sourceDeviceId);
    const snapshotId = requireSnapshotId(args.snapshotId);
    const snapshotHash = requireSha256Hex(args.snapshotHash, "snapshotHash");
    if (!Number.isFinite(args.createdAt) || args.createdAt <= 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "createdAt must be a positive timestamp.",
      });
    }
    requireBatchSize(args.objects.length, "objects");

    const validatedObjects = await Promise.all(
      args.objects.map(async (object) => {
        const objectId = requireSha256Hex(object.objectId, "objectId");
        const ciphertextSha256 = requireSha256Hex(
          object.ciphertextSha256,
          "ciphertextSha256",
        );
        const plaintextSha256 = requireSha256Hex(
          object.plaintextSha256,
          "plaintextSha256",
        );
        const algorithm = trimRequired(object.algorithm, "algorithm", 50);
        const ivBase64Url = trimRequired(
          object.ivBase64Url,
          "ivBase64Url",
          128,
        );
        const authTagBase64Url = trimRequired(
          object.authTagBase64Url,
          "authTagBase64Url",
          128,
        );
        if (
          !Number.isFinite(object.plaintextSize) ||
          object.plaintextSize < 0
        ) {
          throw new ConvexError({
            code: "INVALID_ARGUMENT",
            message: "plaintextSize must be a non-negative number.",
          });
        }
        const metadata = {
          ciphertextSha256,
          plaintextSha256,
          plaintextSize: object.plaintextSize,
          algorithm,
          ivBase64Url,
          authTagBase64Url,
        };
        return {
          objectId,
          ...metadata,
          ciphertextBinding: await ciphertextBinding(metadata),
        };
      }),
    );
    if (
      new Set(validatedObjects.map((object) => object.objectId)).size !==
      validatedObjects.length
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Backup upload objects must be unique.",
      });
    }

    const manifestMetadata = {
      ciphertextSha256: requireSha256Hex(
        args.manifest.ciphertextSha256,
        "manifest.ciphertextSha256",
      ),
      plaintextSha256: requireSha256Hex(
        args.manifest.plaintextSha256,
        "manifest.plaintextSha256",
      ),
      plaintextSize: args.manifest.plaintextSize,
      algorithm: trimRequired(
        args.manifest.algorithm,
        "manifest.algorithm",
        50,
      ),
      ivBase64Url: trimRequired(
        args.manifest.ivBase64Url,
        "manifest.ivBase64Url",
        128,
      ),
      authTagBase64Url: trimRequired(
        args.manifest.authTagBase64Url,
        "manifest.authTagBase64Url",
        128,
      ),
    };
    if (
      !Number.isFinite(manifestMetadata.plaintextSize) ||
      manifestMetadata.plaintextSize < 0
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "manifest.plaintextSize must be a non-negative number.",
      });
    }
    const manifestCiphertextBinding = await ciphertextBinding(manifestMetadata);

    const currentKey = await getCurrentKeyEscrowRecord(
      ctx,
      ownerId,
      ownerGeneration,
    );
    if (!currentKey) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Create a backup encryption key before uploading a backup.",
      });
    }
    const keyFingerprint = currentKey.keyFingerprint;
    if (currentKey.isCurrent !== true) {
      await ctx.db.patch(currentKey._id, { isCurrent: true });
    }

    const existingManifest = await getManifestRecord(ctx, ownerId, snapshotId);
    if (existingManifest) {
      if (
        existingManifest.ownerGeneration !== ownerGeneration ||
        existingManifest.keyFingerprint !== keyFingerprint
      ) {
        throw new ConvexError({
          code: "OWNER_DATA_GENERATION_STALE",
          message:
            "The existing backup snapshot predates the current owner or key generation.",
        });
      }
      if (
        existingManifest.snapshotHash !== snapshotHash ||
        existingManifest.sourceDeviceId !== sourceDeviceId ||
        existingManifest.createdAt !== args.createdAt
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Backup snapshot id is already finalized with other data.",
        });
      }
      return {
        status: "already_finalized" as const,
        keyFingerprint,
        snapshotId,
      };
    }

    const existingRecords = await Promise.all(
      validatedObjects.map(async (object) => {
        const variants = await getObjectRecordsForKey(
          ctx,
          ownerId,
          keyFingerprint,
          object.objectId,
        );
        for (const variant of variants) {
          if (variant.ownerGeneration !== ownerGeneration) {
            throw new ConvexError({
              code: "OWNER_DATA_GENERATION_STALE",
              message:
                "A backup object predates the current account-data generation.",
            });
          }
        }
        return (
          variants.find(
            (variant) =>
              variant.ciphertextSha256 === object.ciphertextSha256 &&
              variant.plaintextSha256 === object.plaintextSha256 &&
              variant.plaintextSize === object.plaintextSize &&
              variant.algorithm === object.algorithm &&
              variant.ivBase64Url === object.ivBase64Url &&
              variant.authTagBase64Url === object.authTagBase64Url,
          ) ?? null
        );
      }),
    );

    const existingObjectIds: string[] = [];
    const missingObjectsMetadata: typeof validatedObjects = [];
    validatedObjects.forEach((object, index) => {
      if (existingRecords[index]) {
        existingObjectIds.push(object.objectId);
      } else {
        missingObjectsMetadata.push(object);
      }
    });

    const now = Date.now();
    const missingObjects = [];
    for (const object of missingObjectsMetadata) {
      const r2Key = getObjectR2Key(
        ownerId,
        keyFingerprint,
        object.objectId,
        object.ciphertextSha256,
      );
      // Commit the exact owner/generation locator in this transaction before
      // the presigned PUT can be observed by the caller.
      await reserveBackupUpload(ctx, {
        ownerId,
        ownerGeneration,
        keyFingerprint,
        kind: "object",
        snapshotId,
        objectId: object.objectId,
        r2Key,
        ciphertextBinding: object.ciphertextBinding,
        now,
      });
      const upload = await r2.generateUploadUrl(r2Key);
      missingObjects.push({
        objectId: object.objectId,
        r2Key,
        uploadUrl: upload.url,
      });
    }

    const uploadAttemptId = crypto.randomUUID().replaceAll("-", "");
    const manifestR2Key = getManifestR2Key(
      ownerId,
      keyFingerprint,
      snapshotId,
      uploadAttemptId,
      manifestMetadata.ciphertextSha256,
    );
    await reserveBackupUpload(ctx, {
      ownerId,
      ownerGeneration,
      keyFingerprint,
      kind: "manifest",
      snapshotId,
      r2Key: manifestR2Key,
      ciphertextBinding: manifestCiphertextBinding,
      now,
    });
    const manifestUpload = await r2.generateUploadUrl(manifestR2Key);

    return {
      status: "prepared" as const,
      keyFingerprint,
      existingObjectIds,
      missingObjects,
      manifest: {
        r2Key: manifestR2Key,
        uploadUrl: manifestUpload.url,
      },
    };
  },
});

export const finalizeUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    sourceDeviceId: v.string(),
    snapshotId: v.string(),
    snapshotHash: v.string(),
    createdAt: v.number(),
    sourceHostname: v.optional(v.string()),
    version: v.number(),
    entryCount: v.number(),
    objectCount: v.number(),
    markLatest: v.optional(v.boolean()),
    manifest: manifestPayloadValidator,
    uploadedObjects: v.array(uploadedObjectValidator),
  },
  returns: finalizeUploadResultValidator,
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const { deviceId: sourceDeviceId, ownerGeneration } =
      await requireRegisteredDevice(ctx, ownerId, args.sourceDeviceId);
    const snapshotId = requireSnapshotId(args.snapshotId);
    const snapshotHash = requireSha256Hex(args.snapshotHash, "snapshotHash");
    const sourceHostname = args.sourceHostname
      ? trimRequired(args.sourceHostname, "sourceHostname", MAX_HOSTNAME_LENGTH)
      : undefined;
    if (!Number.isFinite(args.createdAt) || args.createdAt <= 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "createdAt must be a positive timestamp.",
      });
    }
    if (!Number.isInteger(args.entryCount) || args.entryCount < 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "entryCount must be a non-negative integer.",
      });
    }
    if (!Number.isInteger(args.objectCount) || args.objectCount < 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "objectCount must be a non-negative integer.",
      });
    }
    requireBatchSize(args.uploadedObjects.length, "uploadedObjects");
    const now = Date.now();

    const currentKey = await getCurrentKeyEscrowRecord(
      ctx,
      ownerId,
      ownerGeneration,
    );
    if (!currentKey) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Backup encryption key not found for this account.",
      });
    }
    const keyFingerprint = currentKey.keyFingerprint;
    if (currentKey.isCurrent !== true) {
      await ctx.db.patch(currentKey._id, { isCurrent: true });
    }

    const manifestMetadata = {
      ciphertextSha256: requireSha256Hex(
        args.manifest.ciphertextSha256,
        "manifest.ciphertextSha256",
      ),
      plaintextSha256: requireSha256Hex(
        args.manifest.plaintextSha256,
        "manifest.plaintextSha256",
      ),
      plaintextSize: args.manifest.plaintextSize,
      algorithm: trimRequired(
        args.manifest.algorithm,
        "manifest.algorithm",
        50,
      ),
      ivBase64Url: trimRequired(
        args.manifest.ivBase64Url,
        "manifest.ivBase64Url",
        128,
      ),
      authTagBase64Url: trimRequired(
        args.manifest.authTagBase64Url,
        "manifest.authTagBase64Url",
        128,
      ),
    };
    const manifestR2Key = trimRequired(
      args.manifest.r2Key,
      "manifest.r2Key",
      1000,
    );
    const expectedManifestPrefix = getManifestR2KeyPrefix(
      ownerId,
      keyFingerprint,
      snapshotId,
    );
    if (
      !manifestR2Key.startsWith(expectedManifestPrefix) ||
      !manifestR2Key.endsWith(`-${manifestMetadata.ciphertextSha256}.bin`)
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Backup manifest key does not match this owner and snapshot.",
      });
    }
    if (
      !Number.isFinite(manifestMetadata.plaintextSize) ||
      manifestMetadata.plaintextSize < 0
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "manifest.plaintextSize must be a non-negative number.",
      });
    }
    const manifestCiphertextBinding = await ciphertextBinding(manifestMetadata);

    const validatedObjects = await Promise.all(
      args.uploadedObjects.map(async (object) => {
        const objectId = requireSha256Hex(object.objectId, "objectId");
        const ciphertextSha256 = requireSha256Hex(
          object.ciphertextSha256,
          "ciphertextSha256",
        );
        const plaintextSha256 = requireSha256Hex(
          object.plaintextSha256,
          "plaintextSha256",
        );
        const r2Key = trimRequired(object.r2Key, "r2Key", 1000);
        if (
          r2Key !==
          getObjectR2Key(ownerId, keyFingerprint, objectId, ciphertextSha256)
        ) {
          throw new ConvexError({
            code: "INVALID_ARGUMENT",
            message: "Backup object key does not match this owner and object.",
          });
        }
        const algorithm = trimRequired(object.algorithm, "algorithm", 50);
        const ivBase64Url = trimRequired(
          object.ivBase64Url,
          "ivBase64Url",
          128,
        );
        const authTagBase64Url = trimRequired(
          object.authTagBase64Url,
          "authTagBase64Url",
          128,
        );
        if (
          !Number.isFinite(object.plaintextSize) ||
          object.plaintextSize < 0
        ) {
          throw new ConvexError({
            code: "INVALID_ARGUMENT",
            message: "plaintextSize must be a non-negative number.",
          });
        }
        const metadata = {
          ciphertextSha256,
          plaintextSha256,
          plaintextSize: object.plaintextSize,
          algorithm,
          ivBase64Url,
          authTagBase64Url,
        };
        return {
          objectId,
          r2Key,
          ...metadata,
          ciphertextBinding: await ciphertextBinding(metadata),
        };
      }),
    );
    if (
      new Set(validatedObjects.map((object) => object.objectId)).size !==
      validatedObjects.length
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Finalized backup objects must be unique.",
      });
    }

    const existingObjectRecords = await Promise.all(
      validatedObjects.map((object) =>
        ctx.db
          .query("backup_objects")
          .withIndex("by_ownerId_and_r2Key", (q) =>
            q.eq("ownerId", ownerId).eq("r2Key", object.r2Key),
          )
          .unique(),
      ),
    );
    const objectReservations = await Promise.all(
      validatedObjects.map((object) =>
        getBackupUploadReservation(ctx, ownerId, object.r2Key),
      ),
    );
    const manifestReservation = await getBackupUploadReservation(
      ctx,
      ownerId,
      manifestR2Key,
    );

    for (const [index, object] of validatedObjects.entries()) {
      const existing = existingObjectRecords[index];
      const reservation = objectReservations[index];
      if (
        reservation &&
        (reservation.ownerGeneration !== ownerGeneration ||
          reservation.keyFingerprint !== keyFingerprint ||
          reservation.kind !== "object" ||
          reservation.objectId !== object.objectId ||
          reservation.r2Key !== object.r2Key ||
          reservation.ciphertextBinding !== object.ciphertextBinding)
      ) {
        throw new ConvexError({
          code: "OWNER_DATA_GENERATION_STALE",
          message: "Backup object upload reservation is no longer current.",
        });
      }
      if (existing) {
        if (existing.ownerGeneration !== ownerGeneration) {
          throw new ConvexError({
            code: "OWNER_DATA_GENERATION_STALE",
            message:
              "A backup object predates the current account-data generation.",
          });
        }
        if (
          (existing.keyFingerprint !== undefined &&
            existing.keyFingerprint !== keyFingerprint) ||
          existing.ciphertextSha256 !== object.ciphertextSha256 ||
          existing.plaintextSha256 !== object.plaintextSha256 ||
          existing.plaintextSize !== object.plaintextSize ||
          existing.algorithm !== object.algorithm ||
          existing.ivBase64Url !== object.ivBase64Url ||
          existing.authTagBase64Url !== object.authTagBase64Url ||
          existing.r2Key !== object.r2Key
        ) {
          throw new ConvexError({
            code: "CONFLICT",
            message: `Remote backup object ${object.objectId} already exists with different metadata.`,
          });
        }
        if (reservation || existing.keyFingerprint === undefined) {
          await ctx.db.patch(existing._id, {
            ownerGeneration,
            keyFingerprint,
            ...(reservation
              ? {
                  uploadExpiresAt: Math.max(
                    existing.uploadExpiresAt ?? 0,
                    reservation.uploadExpiresAt,
                  ),
                }
              : {}),
          });
        }
        if (reservation) {
          await ctx.db.delete(reservation._id);
        }
        continue;
      }
      if (!reservation) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message:
            "Backup object was not prepared under a durable upload reservation.",
        });
      }
      await ctx.db.insert("backup_objects", {
        ownerId,
        ownerGeneration,
        keyFingerprint,
        objectId: object.objectId,
        r2Key: object.r2Key,
        uploadExpiresAt: reservation.uploadExpiresAt,
        algorithm: object.algorithm,
        ciphertextSha256: object.ciphertextSha256,
        plaintextSha256: object.plaintextSha256,
        plaintextSize: object.plaintextSize,
        ivBase64Url: object.ivBase64Url,
        authTagBase64Url: object.authTagBase64Url,
        sourceDeviceId,
        createdAt: now,
      });
      await ctx.db.delete(reservation._id);
    }

    const shouldMarkLatest = args.markLatest ?? true;
    if (
      manifestReservation &&
      (manifestReservation.ownerGeneration !== ownerGeneration ||
        manifestReservation.keyFingerprint !== keyFingerprint ||
        manifestReservation.kind !== "manifest" ||
        manifestReservation.objectId !== undefined ||
        manifestReservation.snapshotId !== snapshotId ||
        manifestReservation.r2Key !== manifestR2Key ||
        manifestReservation.ciphertextBinding !== manifestCiphertextBinding)
    ) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message: "Backup manifest upload reservation is no longer current.",
      });
    }
    const existingManifest = await getManifestRecord(ctx, ownerId, snapshotId);
    if (existingManifest) {
      if (existingManifest.ownerGeneration !== ownerGeneration) {
        throw new ConvexError({
          code: "OWNER_DATA_GENERATION_STALE",
          message:
            "The backup manifest predates the current account-data generation.",
        });
      }
      if (
        (existingManifest.keyFingerprint !== undefined &&
          existingManifest.keyFingerprint !== keyFingerprint) ||
        existingManifest.manifestCiphertextSha256 !==
          manifestMetadata.ciphertextSha256 ||
        existingManifest.snapshotHash !== snapshotHash ||
        existingManifest.sourceDeviceId !== sourceDeviceId ||
        existingManifest.sourceHostname !== sourceHostname ||
        existingManifest.manifestR2Key !== args.manifest.r2Key ||
        existingManifest.manifestAlgorithm !== manifestMetadata.algorithm ||
        existingManifest.manifestPlaintextSha256 !==
          manifestMetadata.plaintextSha256 ||
        existingManifest.manifestPlaintextSize !==
          manifestMetadata.plaintextSize ||
        existingManifest.manifestIvBase64Url !== manifestMetadata.ivBase64Url ||
        existingManifest.manifestAuthTagBase64Url !==
          manifestMetadata.authTagBase64Url ||
        existingManifest.entryCount !== args.entryCount ||
        existingManifest.objectCount !== args.objectCount ||
        existingManifest.version !== args.version ||
        existingManifest.createdAt !== args.createdAt
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message:
            "Remote backup snapshot already exists with different metadata.",
        });
      }
      if (manifestReservation) {
        await ctx.db.patch(existingManifest._id, {
          uploadExpiresAt: Math.max(
            existingManifest.uploadExpiresAt ?? 0,
            manifestReservation.uploadExpiresAt,
          ),
        });
        await ctx.db.delete(manifestReservation._id);
      }
      return {
        snapshotId,
        isLatest: existingManifest.isLatest,
      };
    } else if (!manifestReservation) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message:
          "Backup manifest was not prepared under a durable upload reservation.",
      });
    }

    if (shouldMarkLatest) {
      // Bounded read: by invariant only the most recent snapshot carries
      // `isLatest=true`, but we cap the read so a corrupted state with
      // multiple "latest" rows can still be repaired without blowing the
      // mutation transaction limits.
      const currentLatest = await ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_isLatest", (q) =>
          q.eq("ownerId", ownerId).eq("isLatest", true),
        )
        .take(MAX_LATEST_MANIFEST_REPAIR_BATCH);
      await Promise.all(
        currentLatest.map(async (row) => {
          if (row.snapshotId !== snapshotId) {
            await ctx.db.patch(row._id, {
              isLatest: false,
              updatedAt: now,
            });
          }
        }),
      );
    }

    await ctx.db.insert("backup_manifests", {
      ownerId,
      ownerGeneration,
      keyFingerprint,
      snapshotId,
      snapshotHash,
      sourceDeviceId,
      sourceHostname,
      manifestR2Key,
      uploadExpiresAt: manifestReservation.uploadExpiresAt,
      manifestAlgorithm: manifestMetadata.algorithm,
      manifestCiphertextSha256: manifestMetadata.ciphertextSha256,
      manifestPlaintextSha256: manifestMetadata.plaintextSha256,
      manifestPlaintextSize: manifestMetadata.plaintextSize,
      manifestIvBase64Url: manifestMetadata.ivBase64Url,
      manifestAuthTagBase64Url: manifestMetadata.authTagBase64Url,
      entryCount: args.entryCount,
      objectCount: args.objectCount,
      isLatest: shouldMarkLatest,
      version: args.version,
      createdAt: args.createdAt,
      updatedAt: now,
    });
    await ctx.db.delete(manifestReservation._id);

    return {
      snapshotId,
      isLatest: shouldMarkLatest,
    };
  },
});

export const listBackupsForOwnerInternal = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    sourceDeviceId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(backupSummaryValidator),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const { ownerGeneration } = await requireRegisteredDevice(
      ctx,
      ownerId,
      args.deviceId,
    );
    const limit = sanitizeLimit(args.limit);
    const sourceDeviceId = args.sourceDeviceId?.trim();
    const rows = sourceDeviceId
      ? await ctx.db
          .query("backup_manifests")
          .withIndex(
            "by_ownerId_and_ownerGeneration_and_sourceDeviceId_and_createdAt",
            (q) =>
              q
                .eq("ownerId", ownerId)
                .eq("ownerGeneration", ownerGeneration)
                .eq("sourceDeviceId", sourceDeviceId),
          )
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_ownerGeneration_and_createdAt", (q) =>
            q.eq("ownerId", ownerId).eq("ownerGeneration", ownerGeneration),
          )
          .order("desc")
          .take(limit);
    return rows.map(toBackupSummary);
  },
});

export const getManifestRecordInternal = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    snapshotId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      ownerGeneration: v.string(),
      encryptedKey: v.string(),
      keyFingerprint: v.string(),
      keyUpdatedAt: v.number(),
      uploadEncryptedKey: v.string(),
      uploadKeyFingerprint: v.string(),
      snapshotId: v.string(),
      originalSnapshotId: v.optional(v.string()),
      snapshotHash: v.string(),
      sourceDeviceId: v.string(),
      sourceHostname: v.optional(v.string()),
      createdAt: v.number(),
      entryCount: v.number(),
      objectCount: v.number(),
      isLatest: v.boolean(),
      manifestR2Key: v.string(),
      manifestAlgorithm: v.string(),
      manifestCiphertextSha256: v.optional(v.string()),
      manifestPlaintextSha256: v.string(),
      manifestPlaintextSize: v.number(),
      manifestIvBase64Url: v.string(),
      manifestAuthTagBase64Url: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const { ownerGeneration } = await requireRegisteredDevice(
      ctx,
      ownerId,
      args.deviceId,
    );
    const snapshotId = requireSnapshotId(args.snapshotId);
    const row = await getManifestRecord(ctx, ownerId, snapshotId);
    if (!row) {
      return null;
    }
    if (row.ownerGeneration !== ownerGeneration) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message:
          "The backup manifest predates the current account-data generation.",
      });
    }
    const { keyFingerprint, escrow } = await resolveBackupKeyGroup(
      ctx,
      ownerId,
      ownerGeneration,
      row.keyFingerprint,
    );
    const uploadEscrow = await getCurrentKeyEscrowRecord(
      ctx,
      ownerId,
      ownerGeneration,
    );
    if (!uploadEscrow) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "This account has no current backup upload key.",
      });
    }
    return {
      ownerGeneration,
      encryptedKey: escrow.encryptedKey,
      keyFingerprint,
      keyUpdatedAt: escrow.updatedAt,
      uploadEncryptedKey: uploadEscrow.encryptedKey,
      uploadKeyFingerprint: uploadEscrow.keyFingerprint,
      snapshotId: row.snapshotId,
      originalSnapshotId: row.originalSnapshotId,
      snapshotHash: row.snapshotHash,
      sourceDeviceId: row.sourceDeviceId,
      sourceHostname: row.sourceHostname,
      createdAt: row.createdAt,
      entryCount: row.entryCount,
      objectCount: row.objectCount,
      isLatest: row.isLatest,
      manifestR2Key: row.manifestR2Key,
      manifestAlgorithm: row.manifestAlgorithm,
      manifestCiphertextSha256: row.manifestCiphertextSha256,
      manifestPlaintextSha256: row.manifestPlaintextSha256,
      manifestPlaintextSize: row.manifestPlaintextSize,
      manifestIvBase64Url: row.manifestIvBase64Url,
      manifestAuthTagBase64Url: row.manifestAuthTagBase64Url,
    };
  },
});

type ManifestRecordResult = {
  ownerGeneration: string;
  encryptedKey: string;
  keyFingerprint: string;
  keyUpdatedAt: number;
  uploadEncryptedKey: string;
  uploadKeyFingerprint: string;
  snapshotId: string;
  originalSnapshotId?: string;
  snapshotHash: string;
  sourceDeviceId: string;
  sourceHostname?: string;
  createdAt: number;
  entryCount: number;
  objectCount: number;
  isLatest: boolean;
  manifestR2Key: string;
  manifestAlgorithm: string;
  manifestCiphertextSha256?: string;
  manifestPlaintextSha256: string;
  manifestPlaintextSize: number;
  manifestIvBase64Url: string;
  manifestAuthTagBase64Url: string;
};

type ObjectRecordResult = {
  objectId: string;
  r2Key: string;
  ciphertextSha256?: string;
  plaintextSha256: string;
  plaintextSize: number;
  algorithm: string;
  ivBase64Url: string;
  authTagBase64Url: string;
};

type ManifestDownloadPlan = {
  snapshot: ReturnType<typeof toBackupSummary>;
  keyBase64Url: string;
  uploadKeyBase64Url: string;
  uploadKeyFingerprint: string;
  manifest: {
    downloadUrl: string;
    r2Key: string;
    ciphertextSha256?: string;
    plaintextSha256: string;
    plaintextSize: number;
    algorithm: string;
    ivBase64Url: string;
    authTagBase64Url: string;
  };
};

export const getManifestDownloadPlanInternal = internalAction({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    snapshotId: v.string(),
  },
  returns: manifestDownloadPlanValidator,
  handler: async (ctx, args): Promise<ManifestDownloadPlan> => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const manifest: ManifestRecordResult | null = await ctx.runQuery(
      internal.backups.getManifestRecordInternal,
      { ownerId, deviceId: args.deviceId, snapshotId: args.snapshotId },
    );
    if (!manifest) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Backup manifest not found.",
      });
    }
    await ctx.runMutation(
      internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
      { ownerId, ownerGeneration: manifest.ownerGeneration },
    );
    const key: KeyEscrowStatus = {
      keyBase64Url: await decryptSecret(manifest.encryptedKey),
      keyFingerprint: manifest.keyFingerprint,
      updatedAt: manifest.keyUpdatedAt,
    };
    return {
      snapshot: toBackupSummary(manifest),
      keyBase64Url: key.keyBase64Url,
      uploadKeyBase64Url: await decryptSecret(manifest.uploadEncryptedKey),
      uploadKeyFingerprint: manifest.uploadKeyFingerprint,
      manifest: {
        downloadUrl: await r2.getUrl(manifest.manifestR2Key, {
          expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
        }),
        r2Key: manifest.manifestR2Key,
        ciphertextSha256: manifest.manifestCiphertextSha256,
        plaintextSha256: manifest.manifestPlaintextSha256,
        plaintextSize: manifest.manifestPlaintextSize,
        algorithm: manifest.manifestAlgorithm,
        ivBase64Url: manifest.manifestIvBase64Url,
        authTagBase64Url: manifest.manifestAuthTagBase64Url,
      },
    };
  },
});

export const getObjectRecordsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    snapshotId: v.string(),
    objectIds: v.array(v.string()),
  },
  returns: v.object({
    ownerGeneration: v.string(),
    objects: v.array(
      v.object({
        objectId: v.string(),
        r2Key: v.string(),
        ciphertextSha256: v.optional(v.string()),
        plaintextSha256: v.string(),
        plaintextSize: v.number(),
        algorithm: v.string(),
        ivBase64Url: v.string(),
        authTagBase64Url: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const { ownerGeneration } = await requireRegisteredDevice(
      ctx,
      ownerId,
      args.deviceId,
    );
    const snapshotId = requireSnapshotId(args.snapshotId);
    const manifest = await getManifestRecord(ctx, ownerId, snapshotId);
    if (!manifest) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Backup manifest not found.",
      });
    }
    if (manifest.ownerGeneration !== ownerGeneration) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message:
          "The backup manifest predates the current account-data generation.",
      });
    }
    const { keyFingerprint } = await resolveBackupKeyGroup(
      ctx,
      ownerId,
      ownerGeneration,
      manifest.keyFingerprint,
    );
    requireBatchSize(args.objectIds.length, "objectIds");
    const uniqueObjectIds = [
      ...new Set(
        args.objectIds.map((value) => requireSha256Hex(value, "objectId")),
      ),
    ];
    const rows = await Promise.all(
      uniqueObjectIds.map((objectId) =>
        getObjectRecord(
          ctx,
          ownerId,
          keyFingerprint,
          objectId,
          manifest.keyFingerprint === undefined,
        ),
      ),
    );
    const objects = uniqueObjectIds.map((objectId, index) => {
      const row = rows[index];
      if (!row) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: `Backup object ${objectId} not found.`,
        });
      }
      if (row.ownerGeneration !== ownerGeneration) {
        throw new ConvexError({
          code: "OWNER_DATA_GENERATION_STALE",
          message:
            "A backup object predates the current account-data generation.",
        });
      }
      return {
        objectId: row.objectId,
        r2Key: row.r2Key,
        ciphertextSha256: row.ciphertextSha256,
        plaintextSha256: row.plaintextSha256,
        plaintextSize: row.plaintextSize,
        algorithm: row.algorithm,
        ivBase64Url: row.ivBase64Url,
        authTagBase64Url: row.authTagBase64Url,
      };
    });
    return { ownerGeneration, objects };
  },
});

export const getObjectDownloadPlanInternal = internalAction({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    snapshotId: v.string(),
    objectIds: v.array(v.string()),
  },
  returns: v.array(objectDownloadValidator),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const authorized: {
      ownerGeneration: string;
      objects: ObjectRecordResult[];
    } = await ctx.runQuery(internal.backups.getObjectRecordsInternal, {
      ownerId,
      deviceId: args.deviceId,
      snapshotId: args.snapshotId,
      objectIds: args.objectIds,
    });
    await ctx.runMutation(
      internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
      { ownerId, ownerGeneration: authorized.ownerGeneration },
    );
    return await Promise.all(
      authorized.objects.map(async (object: ObjectRecordResult) => ({
        objectId: object.objectId,
        downloadUrl: await r2.getUrl(object.r2Key, {
          expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
        }),
        r2Key: object.r2Key,
        ciphertextSha256: object.ciphertextSha256,
        plaintextSha256: object.plaintextSha256,
        plaintextSize: object.plaintextSize,
        algorithm: object.algorithm,
        ivBase64Url: object.ivBase64Url,
        authTagBase64Url: object.authTagBase64Url,
      })),
    );
  },
});
