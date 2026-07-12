import { defineTable } from "convex/server";
import { v } from "convex/values";

export const relayResumeStatusValidator = v.union(
  v.literal("streaming"),
  v.literal("completed"),
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
    upstreamStatus: v.number(),
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
    expiresAt: v.number(),
  })
    .index("by_relayRequestId_and_chunkIndex", ["relayRequestId", "chunkIndex"])
    .index("by_expiresAt", ["expiresAt"]),
};
