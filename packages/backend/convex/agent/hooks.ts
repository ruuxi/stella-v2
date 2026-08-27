/**
 * Internal hook system — centralized lifecycle hooks for chat infrastructure.
 *
 * Provides rate limiting, historical usage reads, and tool-execution audit at
 * well-defined lifecycle points. Managed-provider billing is deliberately not
 * exposed here: each physical provider receipt owns its exact charge.
 */
import { internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { assertOwnerMigrationWriteAllowed } from "../auth";

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

const chatRateLimiter = new RateLimiter(components.rateLimiter);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AfterToolParams = {
  ownerId: string;
  /** Captured when the tool was admitted, before it can produce output. */
  ownerGeneration: string;
  conversationId: Id<"conversations">;
  agentType: string;
  toolName: string;
  durationMs: number;
  success: boolean;
};

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

// 30 requests per minute per owner
const CHAT_RATE_LIMIT = 30;
const CHAT_RATE_WINDOW_MS = 60_000;
const USAGE_ROLLUP_BUCKET_MS = 60_000;

type UsageRollupDelta = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requestCount?: number;
  toolCallCount?: number;
};

const toRollupCount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

const addUsageRollup = async (
  ctx: MutationCtx,
  ownerId: string,
  createdAt: number,
  delta: UsageRollupDelta,
) => {
  const bucketStartMs =
    Math.floor(createdAt / USAGE_ROLLUP_BUCKET_MS) * USAGE_ROLLUP_BUCKET_MS;
  const existing = await ctx.db
    .query("usage_rollups")
    .withIndex("by_ownerId_and_bucketStartMs", (q) =>
      q.eq("ownerId", ownerId).eq("bucketStartMs", bucketStartMs),
    )
    .unique();
  const inputTokens = toRollupCount(delta.inputTokens);
  const outputTokens = toRollupCount(delta.outputTokens);
  const totalTokens = toRollupCount(delta.totalTokens);
  const requestCount = toRollupCount(delta.requestCount);
  const toolCallCount = toRollupCount(delta.toolCallCount);

  if (existing) {
    await ctx.db.patch(existing._id, {
      inputTokens: existing.inputTokens + inputTokens,
      outputTokens: existing.outputTokens + outputTokens,
      totalTokens: existing.totalTokens + totalTokens,
      requestCount: existing.requestCount + requestCount,
      toolCallCount: existing.toolCallCount + toolCallCount,
      updatedAt: createdAt,
    });
    return;
  }

  await ctx.db.insert("usage_rollups", {
    ownerId,
    bucketStartMs,
    inputTokens,
    outputTokens,
    totalTokens,
    requestCount,
    toolCallCount,
    updatedAt: createdAt,
  });
};

export const checkChatRateLimit = internalMutation({
  args: {
    ownerId: v.string(),
  },
  returns: v.union(
    v.object({ allowed: v.literal(true) }),
    v.object({
      allowed: v.literal(false),
      reason: v.string(),
      retryAfterMs: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const status = await chatRateLimiter.limit(
      ctx,
      `chat:rate:${CHAT_RATE_LIMIT}:${CHAT_RATE_WINDOW_MS}`,
      {
        key: args.ownerId,
        config: {
          kind: "fixed window",
          rate: CHAT_RATE_LIMIT,
          period: CHAT_RATE_WINDOW_MS,
        },
      },
    );

    if (status.ok) {
      return { allowed: true as const };
    }

    return {
      allowed: false as const,
      reason:
        "Rate limit exceeded. Please wait before sending another message.",
      retryAfterMs: Math.max(1_000, status.retryAfter ?? CHAT_RATE_WINDOW_MS),
    };
  },
});

// ---------------------------------------------------------------------------
// afterToolExecution — lightweight tool audit
// ---------------------------------------------------------------------------

/**
 * Fire afterToolExecution hook. Uses scheduler to log asynchronously
 * so it doesn't add latency to the tool call path.
 */
export async function afterToolExecution(
  ctx: ActionCtx,
  params: AfterToolParams,
): Promise<void> {
  // Fire-and-forget — don't block the tool response
  await ctx.scheduler.runAfter(0, internal.agent.hooks.logToolExecution, {
    ownerId: params.ownerId,
    ownerGeneration: params.ownerGeneration,
    conversationId: params.conversationId,
    agentType: params.agentType,
    toolName: params.toolName,
    durationMs: params.durationMs,
    success: params.success,
  });
}

// ---------------------------------------------------------------------------
// Internal Mutations (called via ctx.runMutation / ctx.scheduler.runAfter)
// ---------------------------------------------------------------------------

export const logToolExecution = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.id("conversations"),
    agentType: v.string(),
    toolName: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const createdAt = Date.now();
    // Tool execution can finish after a reset has reopened the owner. Keep
    // this direct writer in the same lifecycle/migration-fenced transaction
    // as its usage-log and rollup writes.
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    // Lightweight logging — insert a minimal usage_logs entry for tool tracking.
    // Using the same table avoids schema sprawl; toolName is stored in the model field.
    await ctx.db.insert("usage_logs", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      model: `tool:${args.toolName}`,
      durationMs: args.durationMs,
      success: args.success,
      createdAt,
    });
    await addUsageRollup(ctx, args.ownerId, createdAt, { toolCallCount: 1 });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

/**
 * Get aggregated usage for an owner over a recent time window.
 *
 * `nowMs` must be supplied by the caller (typically `Date.now()` from an
 * action / httpAction). Computing it inside the query handler would defeat
 * Convex's reactive cache — every subscriber would re-run on every read.
 */
export const getOwnerUsage = internalQuery({
  args: {
    ownerId: v.string(),
    nowMs: v.number(),
    windowMs: v.optional(v.number()),
  },
  returns: v.object({
    totalInputTokens: v.number(),
    totalOutputTokens: v.number(),
    totalTokens: v.number(),
    requestCount: v.number(),
    toolCallCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const windowMs = args.windowMs ?? 24 * 60 * 60 * 1000; // 24h default
    const since = args.nowMs - windowMs;

    const sinceBucket =
      Math.floor(since / USAGE_ROLLUP_BUCKET_MS) * USAGE_ROLLUP_BUCKET_MS;
    const maxBuckets = Math.min(
      2000,
      Math.ceil(windowMs / USAGE_ROLLUP_BUCKET_MS) + 2,
    );
    const rollups = await ctx.db
      .query("usage_rollups")
      .withIndex("by_ownerId_and_bucketStartMs", (q) =>
        q.eq("ownerId", args.ownerId).gte("bucketStartMs", sinceBucket),
      )
      .take(maxBuckets);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let requestCount = 0;
    let toolCallCount = 0;

    for (const rollup of rollups) {
      totalInputTokens += rollup.inputTokens;
      totalOutputTokens += rollup.outputTokens;
      totalTokens += rollup.totalTokens;
      requestCount += rollup.requestCount;
      toolCallCount += rollup.toolCallCount;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      requestCount,
      toolCallCount,
    };
  },
});
