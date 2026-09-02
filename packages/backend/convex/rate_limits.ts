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

// Reusable core so the same fixed-window logic can run either as its own
// `internalMutation` (below) or inline inside a combined gate mutation that
// wants to collapse several pre-checks into a single transaction/commit
// (see `lib/gate_and_meter.ts`). Behaviour is identical either way.
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
