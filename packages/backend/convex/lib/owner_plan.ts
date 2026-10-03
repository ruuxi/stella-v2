import { v } from "convex/values";
import { internalMutation, type QueryCtx } from "../_generated/server";

/**
 * The owner's plan as their billing ledger on cloud-builder last reported
 * it. Billing lives in the owner's object; it pushes the plan and whether
 * the owner pays whenever either changes, for the plan quotas and identity
 * ladder that still run in Convex. Goes when those move.
 */

export type SubscriptionPlan = "free" | "go" | "pro";

const readRow = async (ctx: Pick<QueryCtx, "db">, ownerId: string) =>
  await ctx.db
    .query("owner_billing_plans")
    .withIndex("by_ownerId", (query) => query.eq("ownerId", ownerId))
    .unique();

/** The plan plus whether the owner's usage is unlimited (test and staff accounts). */
export const readOwnerBillingPlan = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<{ plan: SubscriptionPlan; unlimited: boolean }> => {
  const row = await readRow(ctx, ownerId);
  return { plan: row?.plan ?? "free", unlimited: row?.unlimited === true };
};

export const readOwnerPaying = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<boolean> => (await readRow(ctx, ownerId))?.paying === true;

export const setOwnerBillingPlanInternal = internalMutation({
  args: {
    ownerId: v.string(),
    plan: v.union(v.literal("free"), v.literal("go"), v.literal("pro")),
    paying: v.boolean(),
    unlimited: v.boolean(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await readRow(ctx, args.ownerId);
    if (existing) {
      await ctx.db.patch(existing._id, {
        plan: args.plan,
        paying: args.paying,
        unlimited: args.unlimited,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("owner_billing_plans", {
        ownerId: args.ownerId,
        plan: args.plan,
        paying: args.paying,
        unlimited: args.unlimited,
        updatedAt: args.now,
      });
    }
    return null;
  },
});
