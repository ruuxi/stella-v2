import { defineTable } from "convex/server";
import { v } from "convex/values";

export const promptsSchema = {
  prompts: defineTable({
    promptId: v.string(),
    content: v.string(),
    sha256: v.string(),
    sourceRevision: v.string(),
    updatedAt: v.number(),
  }).index("by_promptId", ["promptId"]),
};
