import { internalMutation } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { hashSha256Hex } from "./lib/crypto_utils";

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

const webhookRateLimiter = new RateLimiter(components.rateLimiter);

// ---------------------------------------------------------------------------
// Internal Mutations
// ---------------------------------------------------------------------------

// Spread a single logical webhook bucket across several rate-limiter documents.
// A "fixed window" limit is otherwise backed by ONE doc per (name, key); under
// concurrent webhook bursts every request reads+writes that same doc, so they
// serialize into a storm of OCC write conflicts (observed on prod: ~189
// conflicts on a single `rateLimits` doc via `consumeWebhookRateLimit`). The
// rate-limiter component divides the configured rate across `shards` and picks
// a shard per request (checking two and taking the roomier one once there are
// enough shards), turning that hot doc into N cooler docs and largely removing
// the contention. We keep each shard holding a meaningful number of tokens so
// bursty-but-uneven traffic isn't falsely throttled, and never let the shard
// count exceed `limit` (a shard's per-request capacity is `rate / shards`,
// which must stay >= 1 or every request would be rejected).
const MAX_RATE_LIMIT_SHARDS = 8;
const MIN_TOKENS_PER_SHARD = 5;

export const resolveShardCount = (limit: number): number => {
  const byBudget = Math.floor(limit / MIN_TOKENS_PER_SHARD);
  return Math.max(1, Math.min(MAX_RATE_LIMIT_SHARDS, byBudget));
};

export const consumeWebhookRateLimit = internalMutation({
  args: {
    scope: v.string(),
    key: v.string(),
    limit: v.number(),
    windowMs: v.number(),
    blockMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
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
  },
});
