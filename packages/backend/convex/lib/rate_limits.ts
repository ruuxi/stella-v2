import { RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { components, internal } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";

const sharedRateLimiter = new RateLimiter(components.rateLimiter);

export type RateLimitConfig = {

  rate: number;

  periodMs: number;
};

const DEFAULT_RATE_LIMIT_MESSAGE =
  "Too many requests. Please try again in a moment.";

const buildRateLimitError = (message: string, retryAfterMs?: number) =>
  new ConvexError({
    code: "RATE_LIMITED",
    message,
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
  });

export const enforceMutationRateLimit = async (
  ctx: MutationCtx,
  scope: string,
  key: string,
  config: RateLimitConfig,
  message?: string,
): Promise<void> => {
  const rate = Math.max(1, Math.floor(config.rate));
  const periodMs = Math.max(1_000, Math.floor(config.periodMs));
  const status = await sharedRateLimiter.limit(ctx, scope, {
    key,
    config: { kind: "fixed window", rate, period: periodMs },
  });
  if (!status.ok) {
    throw buildRateLimitError(
      message ?? DEFAULT_RATE_LIMIT_MESSAGE,
      status.retryAfter,
    );
  }
};

export const enforceActionRateLimit = async (
  ctx: ActionCtx,
  scope: string,
  key: string,
  config: RateLimitConfig,
  message?: string,
): Promise<void> => {
  const rate = Math.max(1, Math.floor(config.rate));
  const periodMs = Math.max(1_000, Math.floor(config.periodMs));
  const result = await ctx.runMutation(
    internal.rate_limits.consumeWebhookRateLimit,
    {
      scope,
      key,
      limit: rate,
      windowMs: periodMs,
      blockMs: periodMs,
    },
  );
  if (!result.allowed) {
    throw buildRateLimitError(
      message ?? DEFAULT_RATE_LIMIT_MESSAGE,
      result.retryAfterMs,
    );
  }
};

export const RATE_HOT_PATH: RateLimitConfig = { rate: 120, periodMs: 10_000 };

export const RATE_STANDARD: RateLimitConfig = { rate: 30, periodMs: 10_000 };

export const RATE_SETTINGS: RateLimitConfig = { rate: 60, periodMs: 60_000 };

export const RATE_EXPENSIVE: RateLimitConfig = { rate: 30, periodMs: 60_000 };

export const RATE_SHOPIFY_SEARCH: RateLimitConfig = { rate: 8, periodMs: 60_000 };

export const RATE_VERY_EXPENSIVE: RateLimitConfig = { rate: 10, periodMs: 60_000 };

export const RATE_SENSITIVE: RateLimitConfig = { rate: 5, periodMs: 60_000 };
