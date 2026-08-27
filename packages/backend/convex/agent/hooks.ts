import { internalMutation, internalQuery } from '../_generated/server'
import type { ActionCtx, MutationCtx } from '../_generated/server'
import { components, internal } from '../_generated/api'
import { v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import { RateLimiter } from '@convex-dev/rate-limiter'
import { persistManagedUsage } from '../billing'

const chatRateLimiter = new RateLimiter(components.rateLimiter)

export type AfterChatParams = {
  ownerId: string
  conversationId: Id<'conversations'>
  agentType: string
  modelString: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  durationMs: number
  success: boolean
  fallbackUsed?: boolean
}

export type AfterToolParams = {
  ownerId: string
  conversationId: Id<'conversations'>
  agentType: string
  toolName: string
  durationMs: number
  success: boolean
}

const CHAT_RATE_LIMIT = 30
const CHAT_RATE_WINDOW_MS = 60_000
const USAGE_ROLLUP_BUCKET_MS = 60_000

type UsageRollupDelta = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  requestCount?: number
  toolCallCount?: number
}

const toRollupCount = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.floor(value))
}

const addUsageRollup = async (
  ctx: MutationCtx,
  ownerId: string,
  createdAt: number,
  delta: UsageRollupDelta,
) => {
  const bucketStartMs =
    Math.floor(createdAt / USAGE_ROLLUP_BUCKET_MS) * USAGE_ROLLUP_BUCKET_MS
  const existing = await ctx.db
    .query('usage_rollups')
    .withIndex('by_ownerId_and_bucketStartMs', (q) =>
      q.eq('ownerId', ownerId).eq('bucketStartMs', bucketStartMs),
    )
    .unique()
  const inputTokens = toRollupCount(delta.inputTokens)
  const outputTokens = toRollupCount(delta.outputTokens)
  const totalTokens = toRollupCount(delta.totalTokens)
  const requestCount = toRollupCount(delta.requestCount)
  const toolCallCount = toRollupCount(delta.toolCallCount)

  if (existing) {
    await ctx.db.patch(existing._id, {
      inputTokens: existing.inputTokens + inputTokens,
      outputTokens: existing.outputTokens + outputTokens,
      totalTokens: existing.totalTokens + totalTokens,
      requestCount: existing.requestCount + requestCount,
      toolCallCount: existing.toolCallCount + toolCallCount,
      updatedAt: createdAt,
    })
    return
  }

  await ctx.db.insert('usage_rollups', {
    ownerId,
    bucketStartMs,
    inputTokens,
    outputTokens,
    totalTokens,
    requestCount,
    toolCallCount,
    updatedAt: createdAt,
  })
}

export const checkChatRateLimit = internalMutation({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const status = await chatRateLimiter.limit(
      ctx,
      `chat:rate:${CHAT_RATE_LIMIT}:${CHAT_RATE_WINDOW_MS}`,
      {
        key: args.ownerId,
        config: {
          kind: 'fixed window',
          rate: CHAT_RATE_LIMIT,
          period: CHAT_RATE_WINDOW_MS,
        },
      },
    )

    if (status.ok) {
      return { allowed: true }
    }

    return {
      allowed: false,
      reason:
        'Rate limit exceeded. Please wait before sending another message.',
      retryAfterMs: Math.max(1_000, status.retryAfter ?? CHAT_RATE_WINDOW_MS),
    }
  },
})

export async function afterChat(
  ctx: ActionCtx,
  params: AfterChatParams,
): Promise<void> {

  await ctx.scheduler.runAfter(0, internal.agent.hooks.logUsage, {
    ownerId: params.ownerId,
    conversationId: params.conversationId,
    agentType: params.agentType,
    model: params.modelString,
    inputTokens: params.usage?.inputTokens,
    outputTokens: params.usage?.outputTokens,
    totalTokens: params.usage?.totalTokens,
    durationMs: params.durationMs,
    success: params.success,
    fallbackUsed: params.fallbackUsed,
  })
}

export async function afterToolExecution(
  ctx: ActionCtx,
  params: AfterToolParams,
): Promise<void> {

  await ctx.scheduler.runAfter(0, internal.agent.hooks.logToolExecution, {
    ownerId: params.ownerId,
    conversationId: params.conversationId,
    agentType: params.agentType,
    toolName: params.toolName,
    durationMs: params.durationMs,
    success: params.success,
  })
}

export const logUsage = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id('conversations'),
    agentType: v.string(),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    durationMs: v.number(),
    success: v.boolean(),
    fallbackUsed: v.optional(v.boolean()),
    toolCalls: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now()
    await persistManagedUsage(ctx, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.totalTokens,
      durationMs: args.durationMs,
      success: args.success,
      fallbackUsed: args.fallbackUsed,
      toolCalls: args.toolCalls,
    })
    await addUsageRollup(ctx, args.ownerId, createdAt, {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens:
        args.totalTokens ?? (args.inputTokens ?? 0) + (args.outputTokens ?? 0),
      requestCount: 1,
    })
    return null
  },
})

export const logToolExecution = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id('conversations'),
    agentType: v.string(),
    toolName: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now()

    await ctx.db.insert('usage_logs', {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      model: `tool:${args.toolName}`,
      durationMs: args.durationMs,
      success: args.success,
      createdAt,
    })
    await addUsageRollup(ctx, args.ownerId, createdAt, { toolCallCount: 1 })
    return null
  },
})

export const logProxyUsage = internalMutation({
  args: {
    ownerId: v.string(),
    agentType: v.string(),
    model: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    estimateFromRequest: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now()
    await persistManagedUsage(ctx, {
      ownerId: args.ownerId,
      agentType: `proxy:${args.agentType}`,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: (args.inputTokens ?? 0) + (args.outputTokens ?? 0),
      durationMs: args.durationMs,
      success: args.success,
    })
    await addUsageRollup(ctx, args.ownerId, createdAt, {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: (args.inputTokens ?? 0) + (args.outputTokens ?? 0),
      requestCount: 1,
    })
    return null
  },
})

export const getOwnerUsage = internalQuery({
  args: {
    ownerId: v.string(),
    nowMs: v.number(),
    windowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const windowMs = args.windowMs ?? 24 * 60 * 60 * 1000
    const since = args.nowMs - windowMs

    const sinceBucket =
      Math.floor(since / USAGE_ROLLUP_BUCKET_MS) * USAGE_ROLLUP_BUCKET_MS
    const maxBuckets = Math.min(
      2000,
      Math.ceil(windowMs / USAGE_ROLLUP_BUCKET_MS) + 2,
    )
    const rollups = await ctx.db
      .query('usage_rollups')
      .withIndex('by_ownerId_and_bucketStartMs', (q) =>
        q.eq('ownerId', args.ownerId).gte('bucketStartMs', sinceBucket),
      )
      .take(maxBuckets)

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalTokens = 0
    let requestCount = 0
    let toolCallCount = 0

    for (const rollup of rollups) {
      totalInputTokens += rollup.inputTokens
      totalOutputTokens += rollup.outputTokens
      totalTokens += rollup.totalTokens
      requestCount += rollup.requestCount
      toolCallCount += rollup.toolCallCount
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      requestCount,
      toolCallCount,
    }
  },
})
