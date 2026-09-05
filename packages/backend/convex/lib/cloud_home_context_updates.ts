import { makeFunctionReference } from "convex/server";
import type { MutationCtx } from "../_generated/server";

export const publishHomeContextRef = makeFunctionReference<"action", { ownerId: string; ownerGeneration: string }, null>("cloud_home_context:publish");

/** Change and notification debt commit atomically with the canonical write. */
export async function homeContextChanged(ctx: MutationCtx, ownerId: string, ownerGeneration: string) {
  const row = await ctx.db.query("cloud_home_context_updates")
    .withIndex("by_ownerId_and_ownerGeneration", q => q.eq("ownerId", ownerId).eq("ownerGeneration", ownerGeneration)).unique();
  if (row) await ctx.db.patch(row._id, { revision: row.revision + 1, pending: true, retryAt: Date.now() + 60_000 });
  else await ctx.db.insert("cloud_home_context_updates", { ownerId, ownerGeneration, revision: 1, deliveredRevision: 0, pending: true, retryAt: Date.now() + 60_000 });
  // At-least-once scheduler delivery; publish retries transport failures.
  await ctx.scheduler.runAfter(0, publishHomeContextRef, { ownerId, ownerGeneration });
}
