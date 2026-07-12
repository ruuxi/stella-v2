import { defineTable } from "convex/server";
import { v } from "convex/values";

export const relayResumeStatusValidator = v.union(
  v.literal("streaming"),
  v.literal("completed"),
  v.literal("incomplete"),
  v.literal("failed"),
  v.literal("error"),
  v.literal("canceled"),
  v.literal("upstream_eof"),
  v.literal("truncated"),
);

export const relayResumeSchema = {
  stella_relay_response_streams: defineTable({
    relayRequestId: v.string(),
    ownerId: v.string(),
    provider: v.string(),
    model: v.string(),
    status: relayResumeStatusValidator,
    upstreamStatus: v.optional(v.number()),
    upstreamRequestId: v.optional(v.string()),
    responseId: v.optional(v.string()),
    lastEventType: v.optional(v.string()),
    lastResponseStatus: v.optional(v.string()),
    lastSequence: v.number(),
    eventCount: v.number(),
    storedBytes: v.number(),
    nextChunkIndex: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
    hardExpiresAt: v.number(),
  })
    .index("by_relayRequestId", ["relayRequestId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),

  stella_relay_response_chunks: defineTable({
    relayRequestId: v.string(),
    chunkIndex: v.number(),
    firstSequence: v.number(),
    lastSequence: v.number(),
    events: v.array(
      v.object({
        sequence: v.number(),
        frame: v.string(),
      }),
    ),
    storedBytes: v.number(),
    createdAt: v.number(),
    hardExpiresAt: v.number(),
  })
    .index("by_relayRequestId_and_chunkIndex", ["relayRequestId", "chunkIndex"])
    .index("by_relayRequestId_and_lastSequence", [
      "relayRequestId",
      "lastSequence",
    ])
    .index("by_hardExpiresAt", ["hardExpiresAt"]),

  stella_relay_response_leases: defineTable({
    leaseId: v.string(),
    relayRequestId: v.string(),
    ownerId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_leaseId", ["leaseId"])
    .index("by_relayRequestId_and_expiresAt", ["relayRequestId", "expiresAt"])
    .index("by_ownerId_and_expiresAt", ["ownerId", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),

  stella_relay_cancellation_intents: defineTable({
    relayRequestId: v.string(),
    ownerId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_relayRequestId", ["relayRequestId"])
    .index("by_ownerId_and_expiresAt", ["ownerId", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),

  stella_relay_response_quotas: defineTable({
    scopeKey: v.string(),
    streamCount: v.number(),
    storedBytes: v.number(),
    updatedAt: v.number(),
  }).index("by_scopeKey", ["scopeKey"]),

  stella_relay_resume_cleanup_state: defineTable({
    key: v.string(),
    lastSweepAt: v.number(),
    lastSuccessfulSweepAt: v.optional(v.number()),
    oldestObservedExpiredAt: v.optional(v.number()),
    lastObservedLagMs: v.number(),
    consecutiveFailures: v.number(),
    lastFailureAt: v.optional(v.number()),
    lastFailureCode: v.optional(v.string()),
    lastDeletedDocuments: v.number(),
    lastDeletedBytes: v.number(),
  }).index("by_key", ["key"]),
};
