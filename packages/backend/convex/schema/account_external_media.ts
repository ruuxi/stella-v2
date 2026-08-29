import { defineTable } from "convex/server";
import { v } from "convex/values";

export const accountExternalMediaStorageKindValidator = v.union(
  v.literal("raw-r2"),
  v.literal("component-r2"),
);

export const accountExternalMediaStateValidator = v.union(
  v.literal("reserved"),
  v.literal("committed"),
  v.literal("external_deleted"),
);

/**
 * Only `emoji_pack` is still written. `user_pet` and `store_release` stay
 * readable because deployed rows still carry them and Convex validates a
 * document against this union on read: narrowing the union before those rows
 * are purged would make an owner's remaining media locators unreadable, which
 * is exactly the inventory account deletion needs to walk.
 */
export const accountExternalMediaSourceKindValidator = v.union(
  v.literal("user_pet"),
  v.literal("emoji_pack"),
  v.literal("store_release"),
);

/**
 * Durable exact-object inventory for account-owned public media.
 *
 * A row is inserted before a PUT credential is issued (or before a server
 * upload begins). It is intentionally retained after publication and through
 * ambiguous deletion outcomes. Account deletion removes the external object
 * first, the owning product row second, and this locator last.
 */
export const accountExternalMediaSchema = {
  account_external_media_objects: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    uploadId: v.string(),
    objectRole: v.string(),
    storageKind: accountExternalMediaStorageKindValidator,
    /** Raw-R2 uploads carry the exact bucket used when the URL was issued. */
    bucket: v.optional(v.string()),
    r2Key: v.string(),
    payloadSha256: v.string(),
    publicUrl: v.optional(v.string()),
    state: accountExternalMediaStateValidator,
    /**
     * Full write-authority barrier, not merely the nominal client timeout.
     * Destructive flows do not delete a reserved key until this has elapsed.
     */
    uploadExpiresAt: v.number(),
    sourceKind: v.optional(accountExternalMediaSourceKindValidator),
    sourceId: v.optional(v.string()),
    sourceKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_uploadId", ["ownerId", "uploadId"])
    .index("by_ownerId_and_uploadId_and_objectRole", [
      "ownerId",
      "uploadId",
      "objectRole",
    ])
    .index("by_ownerId_and_r2Key", ["ownerId", "r2Key"])
    .index("by_ownerId_and_sourceKey", ["ownerId", "sourceKey"])
    .index("by_ownerId_and_state_and_uploadExpiresAt", [
      "ownerId",
      "state",
      "uploadExpiresAt",
    ]),
};
