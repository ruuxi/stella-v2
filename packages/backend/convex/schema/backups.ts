import { defineTable } from "convex/server";
import { v } from "convex/values";

export const backupsSchema = {
  backup_key_escrows: defineTable({
    ownerId: v.string(),
    /** Exact owner-data generation that owns this escrow. */
    ownerGeneration: v.optional(v.string()),
    encryptedKey: v.string(),
    keyFingerprint: v.string(),
    /** Exactly one escrow per owner is the upload key. Missing is legacy. */
    isCurrent: v.optional(v.boolean()),
    keyVersion: v.number(),
    sourceDeviceId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_keyFingerprint", ["ownerId", "keyFingerprint"])
    .index("by_ownerId_and_isCurrent", ["ownerId", "isCurrent"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  backup_objects: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.optional(v.string()),
    /** Encryption-key group that can decrypt this ciphertext. */
    keyFingerprint: v.optional(v.string()),
    objectId: v.string(),
    r2Key: v.string(),
    /** Full lifetime of the last presigned PUT issued for this exact key. */
    uploadExpiresAt: v.optional(v.number()),
    algorithm: v.string(),
    /** Exact encrypted bytes identity. Missing is a pre-rollout legacy row. */
    ciphertextSha256: v.optional(v.string()),
    plaintextSha256: v.string(),
    plaintextSize: v.number(),
    ivBase64Url: v.string(),
    authTagBase64Url: v.string(),
    sourceDeviceId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_objectId", ["ownerId", "objectId"])
    .index("by_ownerId_and_keyFingerprint_and_objectId", [
      "ownerId",
      "keyFingerprint",
      "objectId",
    ])
    .index("by_ownerId_and_keyFingerprint_and_createdAt", [
      "ownerId",
      "keyFingerprint",
      "createdAt",
    ])
    .index("by_ownerId_and_r2Key", ["ownerId", "r2Key"])
    .index("by_r2Key", ["r2Key"])
    .index("by_ownerId_and_uploadExpiresAt", ["ownerId", "uploadExpiresAt"])
    .index("by_ownerId_and_ownerGeneration_and_createdAt", [
      "ownerId",
      "ownerGeneration",
      "createdAt",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  backup_manifests: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.optional(v.string()),
    /** Encryption-key group for the manifest and all referenced objects. */
    keyFingerprint: v.optional(v.string()),
    snapshotId: v.string(),
    /** Original id retained when migration aliases a destination collision. */
    originalSnapshotId: v.optional(v.string()),
    snapshotHash: v.string(),
    sourceDeviceId: v.string(),
    sourceHostname: v.optional(v.string()),
    manifestR2Key: v.string(),
    /** Full lifetime of the last presigned PUT issued for this exact key. */
    uploadExpiresAt: v.optional(v.number()),
    manifestAlgorithm: v.string(),
    /** Exact encrypted manifest bytes identity. Missing is legacy. */
    manifestCiphertextSha256: v.optional(v.string()),
    manifestPlaintextSha256: v.string(),
    manifestPlaintextSize: v.number(),
    manifestIvBase64Url: v.string(),
    manifestAuthTagBase64Url: v.string(),
    entryCount: v.number(),
    objectCount: v.number(),
    isLatest: v.boolean(),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_snapshotId", ["ownerId", "snapshotId"])
    .index("by_ownerId_and_manifestR2Key", ["ownerId", "manifestR2Key"])
    .index("by_manifestR2Key", ["manifestR2Key"])
    .index("by_ownerId_and_uploadExpiresAt", ["ownerId", "uploadExpiresAt"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_ownerId_and_ownerGeneration_and_createdAt", [
      "ownerId",
      "ownerGeneration",
      "createdAt",
    ])
    .index("by_ownerId_and_keyFingerprint_and_createdAt", [
      "ownerId",
      "keyFingerprint",
      "createdAt",
    ])
    .index("by_ownerId_and_isLatest", ["ownerId", "isLatest"])
    .index("by_ownerId_and_sourceDeviceId_and_createdAt", [
      "ownerId",
      "sourceDeviceId",
      "createdAt",
    ])
    .index("by_ownerId_and_ownerGeneration_and_sourceDeviceId_and_createdAt", [
      "ownerId",
      "ownerGeneration",
      "sourceDeviceId",
      "createdAt",
    ]),

  /**
   * Exact component-R2 locators committed before a presigned backup PUT is
   * returned. Finalize consumes each reservation into the corresponding
   * backup row in one transaction; account deletion retains it until the URL
   * is expired and physical absence has been confirmed.
   *
   * Object keys are content-addressed by
   * `(ownerId, keyFingerprint, objectId)`, so one live reservation may safely
   * cover concurrent snapshots requesting the same immutable key-group object.
   * `snapshotId` is the most recent requesting snapshot for diagnostics;
   * object finalization is authorized by the exact
   * owner/generation/keyFingerprint/objectId/r2Key tuple and consumes the
   * shared reservation.
   */
  backup_upload_reservations: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    keyFingerprint: v.string(),
    kind: v.union(v.literal("object"), v.literal("manifest")),
    snapshotId: v.string(),
    objectId: v.optional(v.string()),
    r2Key: v.string(),
    /** Hash of the exact ciphertext + encryption metadata tuple. */
    ciphertextBinding: v.optional(v.string()),
    uploadExpiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_r2Key", ["ownerId", "r2Key"])
    .index("by_r2Key", ["r2Key"])
    .index("by_ownerId_and_uploadExpiresAt", ["ownerId", "uploadExpiresAt"])
    .index("by_ownerId_and_snapshotId", ["ownerId", "snapshotId"]),

  /**
   * Crash-safe raw-R2 sweep state for backup keys written before upload
   * reservations existed. A purge or account-link operation first publishes
   * this row, waits out every historical presigned PUT, then walks only the
   * server-derived legacy object/manifest prefixes. The row survives action
   * retries until the corresponding tracked backup drain is complete.
   */
  backup_legacy_r2_sweeps: defineTable({
    protocolVersion: v.number(),
    revision: v.number(),
    scopeKey: v.string(),
    kind: v.union(v.literal("migration"), v.literal("purge")),
    operationId: v.string(),
    sourceOwnerId: v.string(),
    sourceOwnerGeneration: v.string(),
    destinationOwnerId: v.optional(v.string()),
    destinationOwnerGeneration: v.optional(v.string()),
    planRevision: v.optional(v.number()),
    notBefore: v.number(),
    legacyRowFenceComplete: v.boolean(),
    legacyRowFenceTargetIndex: v.number(),
    goal: v.union(v.literal("preserve_refs"), v.literal("empty")),
    phase: v.union(
      v.literal("cleanup"),
      v.literal("verify"),
      v.literal("ready"),
    ),
    targetIndex: v.number(),
    startAfter: v.optional(v.string()),
    verifyDirty: v.boolean(),
    listedCount: v.number(),
    deletedCount: v.number(),
    protectedCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scopeKey", ["scopeKey"])
    .index("by_sourceOwnerId", ["sourceOwnerId"])
    .index("by_sourceOwnerId_and_kind", ["sourceOwnerId", "kind"])
    .index("by_destinationOwnerId", ["destinationOwnerId"])
    .index("by_destinationOwnerId_and_kind", ["destinationOwnerId", "kind"]),
};
