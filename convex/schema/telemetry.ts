import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const telemetrySchema = {
  usage_logs: defineTable({
    ownerId: v.string(),
    conversationId: v.id('conversations'),
    agentType: v.string(),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteInputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costMicroCents: v.optional(v.number()),
    billingPlan: v.optional(
      v.union(
        v.literal('free'),
        v.literal('go'),
        v.literal('pro'),
        v.literal('plus'),
        v.literal('ultra'),
        v.literal('max'),
      ),
    ),
    durationMs: v.number(),
    success: v.boolean(),
    fallbackUsed: v.optional(v.boolean()),
    toolCalls: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_ownerId_and_createdAt', ['ownerId', 'createdAt'])
    .index('by_conversationId_and_createdAt', ['conversationId', 'createdAt']),

  usage_rollups: defineTable({
    ownerId: v.string(),
    bucketStartMs: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
    requestCount: v.number(),
    toolCallCount: v.number(),
    updatedAt: v.number(),
  }).index('by_ownerId_and_bucketStartMs', ['ownerId', 'bucketStartMs']),
}
