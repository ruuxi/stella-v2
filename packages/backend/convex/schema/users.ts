import { defineTable } from "convex/server";
import { v } from "convex/values";

export const usersSchema = {
  user_preferences: defineTable({
    ownerId: v.string(),
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_key", ["ownerId", "key"])
    .index("by_key", ["key"]),

  user_counters: defineTable({
    ownerId: v.string(),
    conversationCount: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

};
