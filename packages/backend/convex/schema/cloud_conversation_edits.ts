import { defineTable } from "convex/server";
import { v } from "convex/values";
import { cloudExecutionSelectionValidator } from "../lib/cloud_execution";

export const cloudConversationEditsSchema = {
  /**
   * Durable control-plane receipt and, for a not-yet-published fork, the only
   * locator for its target DO. Message content never enters Convex.
   */
  cloud_conversation_edits: defineTable({
    operationId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    kind: v.union(v.literal("fork"), v.literal("rewind")),
    state: v.union(
      v.literal("preparing"),
      v.literal("complete"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    sourceConversationId: v.string(),
    targetConversationId: v.optional(v.string()),
    throughSeq: v.number(),
    expectedEpoch: v.number(),
    expectedLastSeq: v.number(),
    activeTurnPolicy: v.optional(
      v.union(v.literal("conflict"), v.literal("cancel")),
    ),
    title: v.optional(v.string()),
    sourceCreatedAt: v.optional(v.number()),
    targetCreatedAt: v.optional(v.number()),
    execution: v.optional(cloudExecutionSelectionValidator),
    sourceEpoch: v.optional(v.number()),
    previousEpoch: v.optional(v.number()),
    nextEpoch: v.optional(v.number()),
    resultLastSeq: v.optional(v.number()),
    lastPreview: v.optional(v.string()),
    lastRole: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operationId", ["operationId"])
    .index("by_ownerId_and_requestId", ["ownerId", "requestId"])
    .index("by_ownerId_and_state_and_updatedAt", [
      "ownerId",
      "state",
      "updatedAt",
    ])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_targetConversationId_and_updatedAt", [
      "ownerId",
      "targetConversationId",
      "updatedAt",
    ])
    .index("by_sourceConversationId_and_updatedAt", [
      "sourceConversationId",
      "updatedAt",
    ])
    .index("by_sourceConversationId_and_ownerId_and_updatedAt", [
      "sourceConversationId",
      "ownerId",
      "updatedAt",
    ])
    .index("by_targetConversationId_and_updatedAt", [
      "targetConversationId",
      "updatedAt",
    ])
    .index("by_targetConversationId_and_ownerId_and_updatedAt", [
      "targetConversationId",
      "ownerId",
      "updatedAt",
    ]),
};
