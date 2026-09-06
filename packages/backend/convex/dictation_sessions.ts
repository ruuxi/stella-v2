import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { runPeekManagedModelAllowance } from "./billing";

export const remainingAllowance = internalQuery({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) =>
    (await runPeekManagedModelAllowance(ctx, args)).remainingMicroCents,
});

export const receipt = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    sessionId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ maxMs: v.number(), fallbackCostMicroCents: v.number() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", args.sessionId))
      .unique();
    if (!row) return null;
    if (
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    )
      throw new Error("Dictation settlement lost exact attempt authority.");
    if (
      row.billing?.kind !== "managed_usage" ||
      row.billing.agentType !== "service:dictation"
    )
      return null;
    return {
      maxMs: row.providerDeadlineAt - row.createdAt,
      fallbackCostMicroCents: row.billing.fallbackCostMicroCents,
    };
  },
});
