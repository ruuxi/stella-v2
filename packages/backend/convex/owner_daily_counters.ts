import { ConvexError, v } from "convex/values";
import type { SubscriptionPlan } from "./lib/billing_plans";
import { internalMutation, type MutationCtx } from "./_generated/server";

const TTS_DAILY_DEFAULTS: Readonly<Record<SubscriptionPlan, number>> = {
  free: 60_000,
  go: 300_000,
  pro: 1_000_000,
};

const CLOUD_APP_OPERATION_DAILY_LIMIT = 200;
const X_BOT_AUTHOR_DAILY_LIMIT = 10;
const X_BOT_GLOBAL_DAILY_LIMIT = 500;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

const toUtcDay = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

const nextUtcMidnight = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
};

const requireCounterAmount = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Daily counter amount must be a non-negative integer.",
    });
  }
  return value;
};

const readPositiveIntegerEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
};

const resolveOwnerPlan = async (
  ctx: MutationCtx,
  ownerId: string,
): Promise<SubscriptionPlan> => {
  const profile = await ctx.db
    .query("billing_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  return profile && ACTIVE_SUBSCRIPTION_STATUSES.has(profile.subscriptionStatus)
    ? profile.activePlan
    : "free";
};

type DailyCounterResult = {
  allowed: boolean;
  count: number;
  limit: number;
  retryAt: number;
};

const consumeDailyCounter = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    kind: string;
    amount: number;
    limit: number;
    now: number;
  },
): Promise<DailyCounterResult> => {
  const amount = requireCounterAmount(args.amount);
  const day = toUtcDay(args.now);
  const existing = await ctx.db
    .query("owner_daily_counters")
    .withIndex("by_owner_kind_day", (q) =>
      q.eq("ownerId", args.ownerId).eq("kind", args.kind).eq("day", day),
    )
    .unique();
  const count = Math.max(0, Math.floor(existing?.count ?? 0));
  if (count + amount > args.limit) {
    return {
      allowed: false,
      count,
      limit: args.limit,
      retryAt: nextUtcMidnight(args.now),
    };
  }
  const nextCount = count + amount;
  if (existing) {
    await ctx.db.patch(existing._id, { count: nextCount });
  } else {
    await ctx.db.insert("owner_daily_counters", {
      ownerId: args.ownerId,
      kind: args.kind,
      day,
      count: nextCount,
    });
  }
  return {
    allowed: true,
    count: nextCount,
    limit: args.limit,
    retryAt: nextUtcMidnight(args.now),
  };
};

const dailyCounterResultValidator = v.object({
  allowed: v.boolean(),
  count: v.number(),
  limit: v.number(),
  retryAt: v.number(),
});

export const consumeTtsDailyCharactersInternal = internalMutation({
  args: {
    ownerId: v.string(),
    characters: v.number(),
    now: v.number(),
  },
  returns: dailyCounterResultValidator,
  handler: async (ctx, args) => {
    const plan = await resolveOwnerPlan(ctx, args.ownerId);
    const limit = readPositiveIntegerEnv(
      `STELLA_TTS_DAILY_CHARS_${plan.toUpperCase()}`,
      TTS_DAILY_DEFAULTS[plan],
    );
    return await consumeDailyCounter(ctx, {
      ownerId: args.ownerId,
      kind: "tts_chars",
      amount: args.characters,
      limit,
      now: args.now,
    });
  },
});

export const consumeCloudAppOperationDailyInternal = internalMutation({
  args: { ownerId: v.string(), now: v.number() },
  returns: dailyCounterResultValidator,
  handler: async (ctx, args) =>
    await consumeDailyCounter(ctx, {
      ownerId: args.ownerId,
      kind: "cloud_app_operation_router",
      amount: 1,
      limit: CLOUD_APP_OPERATION_DAILY_LIMIT,
      now: args.now,
    }),
});

export const consumeXBotDailyAllowanceInternal = internalMutation({
  args: { authorId: v.string(), now: v.number() },
  returns: v.object({
    allowed: v.boolean(),
    scope: v.union(v.literal("author"), v.literal("global"), v.null()),
    retryAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const day = toUtcDay(args.now);
    const authorOwnerId = `x-author:${args.authorId}`;
    const globalOwnerId = "x-global";
    const [author, global] = await Promise.all([
      ctx.db
        .query("owner_daily_counters")
        .withIndex("by_owner_kind_day", (q) =>
          q
            .eq("ownerId", authorOwnerId)
            .eq("kind", "x_bot_mentions")
            .eq("day", day),
        )
        .unique(),
      ctx.db
        .query("owner_daily_counters")
        .withIndex("by_owner_kind_day", (q) =>
          q
            .eq("ownerId", globalOwnerId)
            .eq("kind", "x_bot_mentions")
            .eq("day", day),
        )
        .unique(),
    ]);
    const retryAt = nextUtcMidnight(args.now);
    if ((author?.count ?? 0) >= X_BOT_AUTHOR_DAILY_LIMIT) {
      return { allowed: false, scope: "author" as const, retryAt };
    }
    if ((global?.count ?? 0) >= X_BOT_GLOBAL_DAILY_LIMIT) {
      return { allowed: false, scope: "global" as const, retryAt };
    }
    if (author) {
      await ctx.db.patch(author._id, { count: author.count + 1 });
    } else {
      await ctx.db.insert("owner_daily_counters", {
        ownerId: authorOwnerId,
        kind: "x_bot_mentions",
        day,
        count: 1,
      });
    }
    if (global) {
      await ctx.db.patch(global._id, { count: global.count + 1 });
    } else {
      await ctx.db.insert("owner_daily_counters", {
        ownerId: globalOwnerId,
        kind: "x_bot_mentions",
        day,
        count: 1,
      });
    }
    return { allowed: true, scope: null, retryAt };
  },
});

export {
  CLOUD_APP_OPERATION_DAILY_LIMIT,
  TTS_DAILY_DEFAULTS,
  X_BOT_AUTHOR_DAILY_LIMIT,
  X_BOT_GLOBAL_DAILY_LIMIT,
  nextUtcMidnight,
  toUtcDay,
};
