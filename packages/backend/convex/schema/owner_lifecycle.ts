import { defineTable } from "convex/server";
import { v } from "convex/values";

export const ownerLifecycleStateValidator = v.union(
  v.literal("open"),
  v.literal("resetting"),
  v.literal("deleting"),
);

export const ownerPurgeModeValidator = v.union(
  v.literal("reset"),
  v.literal("delete"),
);

export const ownerPurgeStageValidator = v.union(
  v.literal("core"),
  v.literal("cloud"),
  v.literal("complete"),
);

export const ownerLifecycleSchema = {
  /**
   * The transaction-plane half of reset/account deletion.
   *
   * Rows deliberately survive a successful reset in `open` state. The
   * generation changes at both edges of a reset, so a callback authorized
   * before the reset cannot commit after the account is reopened. Deletion
   * rows remain in `deleting` state as a minimal resurrection tombstone.
   */
  cloud_owner_lifecycles: defineTable({
    ownerId: v.string(),
    generation: v.string(),
    state: ownerLifecycleStateValidator,
    operationId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  /**
   * Durable retry cursor for the destructive workflow. A pass may be retried
   * from the beginning of its current stage because every drain is idempotent;
   * keeping the stage and lease durable prevents an action timeout from leaving
   * a temporary reset fence active forever.
   */
  cloud_owner_purge_jobs: defineTable({
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    mode: ownerPurgeModeValidator,
    stage: ownerPurgeStageValidator,
    attempts: v.number(),
    nextRetryAt: v.number(),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    // Generation returned by the cloud-builder owner fence. Persisting it
    // lets a killed core action resume/release the exact fence it opened.
    externalGeneration: v.optional(v.string()),
    // Reset/delete must discover pre-owner-binding remote-turn attempts by
    // walking the owner's conversations before any conversation row can be
    // deleted. The cursor is durable so a crash cannot restart an unbounded
    // legacy scan forever; the per-conversation active-attempt guard remains
    // the final deletion backstop after this scan completes.
    remoteTurnConversationCursor: v.optional(v.string()),
    remoteTurnConversationScanComplete: v.optional(v.boolean()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_operationId", ["operationId"])
    .index("by_stage_and_nextRetryAt", ["stage", "nextRetryAt"]),
};
