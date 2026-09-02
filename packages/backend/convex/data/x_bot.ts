import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { x_bot_exchange_validator } from "../schema/x_bot";

const X_BOT_PAGE_RUN_LIMIT = 20;

export const x_bot_page_run_validator = v.object({
  id: v.string(),
  mentionId: v.string(),
  replyId: v.string(),
  summonerUsername: v.string(),
  posterUsername: v.string(),
  headline: v.string(),
  reply: v.string(),
  exchanges: v.array(x_bot_exchange_validator),
  imageUrl: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

export const recordXBotRun = internalMutation({
  args: {
    handle: v.string(),
    mentionId: v.string(),
    parentId: v.string(),
    replyId: v.string(),
    summonerUsername: v.string(),
    posterUsername: v.string(),
    headline: v.string(),
    reply: v.string(),
    exchanges: v.array(x_bot_exchange_validator),
    imageStorageId: v.optional(v.id("_storage")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("x_bot_runs")
      .withIndex("by_mentionId", (q) => q.eq("mentionId", args.mentionId))
      .unique();
    const row = {
      handle: args.handle.toLowerCase(),
      handleDisplay: args.handle,
      mentionId: args.mentionId,
      parentId: args.parentId,
      replyId: args.replyId,
      summonerUsername: args.summonerUsername,
      posterUsername: args.posterUsername,
      headline: args.headline,
      reply: args.reply,
      exchanges: args.exchanges,
      imageStorageId: args.imageStorageId,
      createdAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("x_bot_runs", row);
    }
    return null;
  },
});

export const listXBotRunsByHandle = query({
  args: { handle: v.string() },
  returns: v.object({
    handle: v.union(v.string(), v.null()),
    runs: v.array(x_bot_page_run_validator),
  }),
  handler: async (ctx, args) => {
    const handle = args.handle.trim().replace(/^@/, "").toLowerCase();
    const rows = await ctx.db
      .query("x_bot_runs")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .order("desc")
      .take(X_BOT_PAGE_RUN_LIMIT);
    const runs = [];
    for (const row of rows) {
      runs.push({
        id: row._id,
        mentionId: row.mentionId,
        replyId: row.replyId,
        summonerUsername: row.summonerUsername,
        posterUsername: row.posterUsername,
        headline: row.headline,
        reply: row.reply,
        exchanges: row.exchanges,
        imageUrl: row.imageStorageId
          ? await ctx.storage.getUrl(row.imageStorageId)
          : null,
        createdAt: row.createdAt,
      });
    }
    return {
      handle: rows[0]?.handleDisplay ?? null,
      runs,
    };
  },
});
