import { defineTable } from "convex/server";
import { v } from "convex/values";

export const feedbackSchema = {
  user_feedback: defineTable({
    message: v.string(),
    createdAt: v.number(),
    appVersion: v.optional(v.string()),
    platform: v.optional(v.string()),
  }).index("by_createdAt", ["createdAt"]),
};
