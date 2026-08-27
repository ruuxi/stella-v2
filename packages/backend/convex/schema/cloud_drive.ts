import { defineTable } from "convex/server";
import { v } from "convex/values";

export const cloudDriveSchema = {
  // The per-user cloud drive. One row per file; `path` is the drive-relative
  // POSIX path with no leading slash (e.g. "reports/q3.xlsx"). Bytes live in
  // R2 under the owner's hashed Drive prefix and are never inlined here.
  // New byte-bearing rows point at immutable upload/write-generation keys;
  // legacy/workspace-only rows may still carry the deterministic path key.
  cloud_drive_files: defineTable({
    ownerId: v.string(),
    path: v.string(),
    r2Key: v.string(),
    name: v.string(),
    sizeBytes: v.number(),
    contentType: v.string(),
    // Who wrote the bytes that are there now. Changes on every write.
    source: v.string(),
    // Where the file came from, which is not the same question: an upload the
    // agent has since edited reads `source: "agent"`, `origin: "upload"`. Only
    // `origin` decides whether the overwrite protection applies, so protection
    // survives a legitimate edit instead of expiring after the first one.
    // Monotonic towards "upload" and never patched back down; absent on rows
    // written before the field existed, which read as their `source` until the
    // next write, which freezes that same answer into the field before
    // replacing `source`.
    origin: v.optional(v.string()),
    // The write that last touched this row, as `<turnId>:<batchKey>`. A
    // produced-files batch redelivered after its response was lost re-sends
    // the version token it read before the first attempt — which that attempt
    // has already superseded — so this is what tells the row's own writer
    // apart from a second one and keeps the redelivery from being diverted to
    // an "(agent copy)" sibling. Absent for writes that carry no batch key:
    // uploads, the desktop, the sweep.
    writeKey: v.optional(v.string()),
    // The immutable upload generation that installed this row. It lets a
    // retried finalize prove it already committed without confusing a newer
    // upload for the same logical path.
    uploadId: v.optional(v.string()),
    updatedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_path", ["ownerId", "path"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    // Replacement cleanup must prove an immutable object key is no longer
    // named by any row before deleting its bytes.
    .index("by_r2Key", ["r2Key"]),

  // Running per-owner totals so a quota check costs one document read instead
  // of a scan over every file row. Written in the same transaction as every
  // drive row insert/patch/delete, so it can never disagree with the rows by
  // more than an out-of-band deletion.
  cloud_drive_usage: defineTable({
    ownerId: v.string(),
    fileCount: v.number(),
    totalBytes: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  // Presigned uploads that have not been finalized yet. R2's signed PUT
  // carries no content-length condition, so the size the client claimed is
  // only a promise; this row is what makes it enforceable at finalize and what
  // lets the sweep reclaim an upload that was abandoned (or deliberately
  // oversized) after the bytes already landed. The same table also retains
  // durable cleanup work until R2 deletion succeeds; successful finalize turns
  // the staging claim into cleanup because its signed PUT cannot be revoked.
  cloud_drive_uploads: defineTable({
    ownerId: v.string(),
    path: v.string(),
    r2Key: v.string(),
    // Random, client-opaque upload generation. New uploads never reuse an R2
    // key, so an old signed PUT cannot overwrite current bytes.
    uploadId: v.optional(v.string()),
    /** Owner-data generation that authorized this delayed upload. */
    ownerGeneration: v.optional(v.string()),
    // `pending` is a live presigned upload. `cleanup` is durable GC work for
    // staging, rejected-finalize, replaced, or deleted immutable objects.
    status: v.optional(v.string()),
    cleanupLeaseId: v.optional(v.string()),
    cleanupLeaseExpiresAt: v.optional(v.number()),
    claimedBytes: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_ownerId_and_path", ["ownerId", "path"])
    .index("by_ownerId_and_uploadId", ["ownerId", "uploadId"])
    .index("by_uploadId", ["uploadId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Tombstones for deleted drive files. A drive file is hydrated into the
  // sandbox workspace and the workspace is checkpointed, so deleting the row
  // and the R2 object leaves a readable copy behind on every later turn.
  // Convex stays the truth: the row is gone, and this is the record that lets
  // the next turn's sync tell the executor which paths to remove from the
  // workspace it just restored. Pruned by the drive sweep after
  // `DRIVE_TOMBSTONE_TTL_MS`.
  cloud_drive_deletions: defineTable({
    ownerId: v.string(),
    path: v.string(),
    deletedAt: v.number(),
  })
    .index("by_ownerId_and_deletedAt", ["ownerId", "deletedAt"])
    .index("by_ownerId_and_path", ["ownerId", "path"])
    .index("by_deletedAt", ["deletedAt"]),
};
