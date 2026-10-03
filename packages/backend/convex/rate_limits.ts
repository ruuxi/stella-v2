import { internalMutation, type MutationCtx } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { hashSha256Hex } from "./lib/crypto_utils";

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

const webhookRateLimiter = new RateLimiter(components.rateLimiter);

const AUTH_IP_RATE_LIMITS = {
  anonymous: { rate: 20, periodMs: 24 * 60 * 60_000 },
  magic_link: { rate: 10, periodMs: 60 * 60_000 },
} as const;

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
//
// Low limits (6-14: anonymous/owner synthesis, music, tunnel tokens, voice
// sessions) used to collapse to one or two shards, and the onboarding burst of
// concurrent synthesis calls kept one doc hot. They now get three shards: the
// smallest count at which the component checks two shards and borrows across
// them, so a request is only refused when both sampled shards are drained.
// Tradeoff: the ceiling stays exact-or-lower (shard budgets sum to `limit` and
// no shard ever grants past its share), but a caller can be refused a little
// before `limit` when its tokens sit in the unsampled shard. That is the
// conservative direction. Limits below 6 stay on one exact doc: dedup
// (limit 1) must be exact, and magic-link/sensitive buckets are human-rate.
const MAX_RATE_LIMIT_SHARDS = 8;
const MIN_TOKENS_PER_SHARD = 5;
const LOW_LIMIT_SHARDS = 3;
const MIN_TOKENS_PER_LOW_LIMIT_SHARD = 2;

export const resolveShardCount = (limit: number): number => {
  const byBudget = Math.floor(limit / MIN_TOKENS_PER_SHARD);
  if (byBudget >= LOW_LIMIT_SHARDS) {
    return Math.min(MAX_RATE_LIMIT_SHARDS, byBudget);
  }
  return limit >= LOW_LIMIT_SHARDS * MIN_TOKENS_PER_LOW_LIMIT_SHARD
    ? LOW_LIMIT_SHARDS
    : 1;
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

// The fixed-window logic behind the `internalMutation` below.
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

export const consumeAuthIpRateLimit = internalMutation({
  args: {
    kind: v.union(v.literal("anonymous"), v.literal("magic_link")),
    key: v.string(),
  },
  returns: v.object({ allowed: v.boolean(), retryAfterMs: v.number() }),
  handler: async (ctx, args) => {
    const config = AUTH_IP_RATE_LIMITS[args.kind];
    const hashedKey = await hashSha256Hex(`auth:${args.kind}:${args.key}`);
    const status = await webhookRateLimiter.limit(
      ctx,
      `auth:${args.kind}`,
      {
        key: hashedKey,
        config: {
          kind: "token bucket",
          rate: config.rate,
          period: config.periodMs,
          capacity: config.rate,
        },
      },
    );
    return status.ok
      ? { allowed: true, retryAfterMs: 0 }
      : {
          allowed: false,
          retryAfterMs: Math.max(1_000, status.retryAfter),
        };
  },
});
