import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { resolveBuilderEndpoint } from "./lib/builder_turns";
import { publishHomeContextRef } from "./lib/cloud_home_context_updates";

const ownerArgs = { ownerId: v.string(), ownerGeneration: v.string() };
const pendingRef = makeFunctionReference<"query", { ownerId: string; ownerGeneration: string }, number | null>("cloud_home_context:pending");
const deliveredRef = makeFunctionReference<"mutation", { ownerId: string; ownerGeneration: string; revision: number }, null>("cloud_home_context:delivered");
export const pending = internalQuery({ args: ownerArgs, returns: v.union(v.number(), v.null()), handler: async (ctx, args) => {
  const row = await ctx.db.query("cloud_home_context_updates").withIndex("by_ownerId_and_ownerGeneration", q => q.eq("ownerId", args.ownerId).eq("ownerGeneration", args.ownerGeneration)).unique();
  return row && row.revision > row.deliveredRevision ? row.revision : null;
} });
export const delivered = internalMutation({ args: { ...ownerArgs, revision: v.number() }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.query("cloud_home_context_updates").withIndex("by_ownerId_and_ownerGeneration", q => q.eq("ownerId", args.ownerId).eq("ownerGeneration", args.ownerGeneration)).unique();
  if (row) await ctx.db.patch(row._id, { deliveredRevision: Math.max(row.deliveredRevision, Math.min(args.revision, row.revision)), pending: args.revision < row.revision });
  return null;
} });
export const publish = internalAction({ args: ownerArgs, returns: v.null(), handler: async (ctx, args) => {
  const revision = await ctx.runQuery(pendingRef, args);
  if (revision === null) return null;
  try {
    const endpoint = resolveBuilderEndpoint();
    if (!endpoint) throw new Error("Builder unavailable");
    const response = await fetch(`${endpoint.url}/internal/owners/home-context/changed`, {
      method: "POST", headers: { authorization: `Bearer ${endpoint.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ ...args, revision }), signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("Context notification not acknowledged");
    await ctx.runMutation(deliveredRef, { ...args, revision });
  } catch {
    await ctx.scheduler.runAfter(5_000, publishHomeContextRef, args);
  }
  return null;
} });

export const retryPending = internalMutation({ args: {}, returns: v.null(), handler: async ctx => {
  const now = Date.now();
  const rows = await ctx.db.query("cloud_home_context_updates").withIndex("by_pending_and_retryAt", q => q.eq("pending", true).lte("retryAt", now)).take(100);
  for (const row of rows) {
    await ctx.db.patch(row._id, { retryAt: now + 60_000 });
    await ctx.scheduler.runAfter(0, publishHomeContextRef, { ownerId: row.ownerId, ownerGeneration: row.ownerGeneration });
  }
  return null;
} });
