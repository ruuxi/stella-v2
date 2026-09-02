import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

/**
 * Execution placement now lives in the cloud-builder's owner gate Durable
 * Object (`@stella/contracts/turn-plane/placement`): it owns the dispatch
 * row, the device presence sockets, the offer window and the claim handoff.
 * Convex keeps one read-only projection, fed by `dispatch.updated` outbox
 * events, so the activity UI can list what ran where.
 */

export const executionIngressValidator = v.union(
  v.literal("desktop"),
  v.literal("mobile"),
  v.literal("browser"),
  v.literal("cloud"),
  v.literal("schedule"),
);

export const executionRequestKindValidator = v.union(
  v.literal("chat"),
  v.literal("agent"),
);

export const executionSubjectValidator = v.union(
  v.literal("portable"),
  v.literal("computer"),
  v.literal("cloud"),
);

export const executionPlacementValidator = v.union(
  v.literal("computer"),
  v.literal("cloud"),
);

export const executionTargetModeValidator = v.union(
  v.literal("automatic"),
  v.literal("cloud"),
  v.literal("device"),
);

export type ExecutionPlacement = Infer<typeof executionPlacementValidator>;

export const executionCapabilityValidator = v.union(
  v.literal("chat"),
  v.literal("agent"),
  v.literal("computer-use"),
  v.literal("local-files"),
  v.literal("local-apps"),
  // A build that can resolve the dispatch payload's drive-path attachments.
  // Gating on a capability rather than a protocol bump keeps a desktop that
  // predates attachments eligible for every turn that has none.
  v.literal("attachments"),
);

export type ExecutionCapability = Infer<typeof executionCapabilityValidator>;

/** Mirrors `DispatchState` in `@stella/contracts/turn-plane/placement`. */
export const executionDispatchStateValidator = v.union(
  v.literal("offering"),
  v.literal("computer_claimed"),
  v.literal("computer_accepted"),
  v.literal("computer_running"),
  v.literal("cloud_committed"),
  v.literal("cloud_running"),
  v.literal("cancel_pending"),
  v.literal("reconciliation_required"),
  v.literal("blocked"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
);

export const executionPlacementSchema = {
  /**
   * Projection of the owner gate's dispatch rows: one row per dispatchId,
   * holding the highest `revision` Convex has seen. Delivery is at-least-once
   * and may reorder, so every apply is revision-fenced. Nothing in Convex
   * routes on this table — it exists to render the activity list.
   */
  cloud_dispatches: defineTable({
    dispatchId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    idempotencyKey: v.string(),
    kind: executionRequestKindValidator,
    ingress: executionIngressValidator,
    subject: executionSubjectValidator,
    requestedTargetMode: v.optional(executionTargetModeValidator),
    requestedExecutorDeviceId: v.optional(v.string()),
    conversationId: v.string(),
    parentTurnId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    state: executionDispatchStateValidator,
    placement: v.optional(executionPlacementValidator),
    executorDeviceId: v.optional(v.string()),
    executorPresenceSessionId: v.optional(v.string()),
    /** Monotonic per dispatch. A lower revision than the stored one is dropped. */
    revision: v.number(),
    fallbackReason: v.optional(v.string()),
    cancelRequestId: v.optional(v.string()),
    cancelReason: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    cloudTurnId: v.optional(v.string()),
    cloudThreadId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dispatchId", ["dispatchId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_conversationId", ["conversationId"]),
};
