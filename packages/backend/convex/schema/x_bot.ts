import { defineTable } from "convex/server";
import { v } from "convex/values";

export const x_bot_exchange_validator = v.object({
  user: v.string(),
  stella: v.string(),
});

// One row per reply the X bot posted. `handle` is the lowercased X username
// the plan is addressed to (the summoner, or the original poster when one of
// our promoter accounts did the summoning); the website renders
// stella.sh/x/<handle> from these rows.
export const xBotSchema = {
  x_bot_runs: defineTable({
    handle: v.string(),
    handleDisplay: v.string(),
    mentionId: v.string(),
    parentId: v.string(),
    replyId: v.string(),
    summonerUsername: v.string(),
    posterUsername: v.string(),
    headline: v.string(),
    reply: v.string(),
    exchanges: v.array(x_bot_exchange_validator),
    imageStorageId: v.optional(v.id("_storage")),
    createdAt: v.number(),
  })
    .index("by_handle", ["handle", "createdAt"])
    .index("by_mentionId", ["mentionId"]),
};
