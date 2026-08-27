import { internalMutation, type MutationCtx } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { hashSha256Hex } from "./lib/crypto_utils";

const webhookRateLimiter = new RateLimiter(components.rateLimiter);

const MAX_RATE_LIMIT_SHARDS = 8;
const MIN_TOKENS_PER_SHARD = 5;

export const resolveShardCount = (limit: number): number => {
  const byBudget = Math.floor(limit / MIN_TOKENS_PER_SHARD);
  return Math.max(1, Math.min(MAX_RATE_LIMIT_SHARDS, byBudget));
};

export type WebhookRateLimitArgs = {
  scope: string;
  key: string;
  limit: number;
  windowMs: number;
  blockMs?: number;
};

export type WebhookRateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
};

export const runConsumeWebhookRateLimit = async (
  ctx: MutationCtx,
  args: WebhookRateLimitArgs,
): Promise<WebhookRateLimitResult> => {
  const limit = Math.max(1, Math.floor(args.limit));
  const periodMs = Math.max(1_000, Math.floor(args.windowMs), Math.floor(args.blockMs ?? 0));
  const shards = resolveShardCount(limit);
  const hashedKey = await hashSha256Hex(`${args.scope}:${args.key}`);
  const status = await webhookRateLimiter.limit(ctx, `webhook:${args.scope}:${limit}:${periodMs}`, {
    key: hashedKey,
    config: { kind: "fixed window", rate: limit, period: periodMs, shards },
  });

  return status.ok
    ? { allowed: true, retryAfterMs: 0 }
    : { allowed: false, retryAfterMs: Math.max(1_000, status.retryAfter ?? periodMs) };
};

export const consumeWebhookRateLimit = internalMutation({
  args: {
    scope: v.string(),
    key: v.string(),
    limit: v.number(),
    windowMs: v.number(),
    blockMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => await runConsumeWebhookRateLimit(ctx, args),
});
