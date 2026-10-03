import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";

const CLOUD_APP_OPERATION_DAILY_LIMIT = 200;

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

export {
  CLOUD_APP_OPERATION_DAILY_LIMIT,
  nextUtcMidnight,
  toUtcDay,
};
