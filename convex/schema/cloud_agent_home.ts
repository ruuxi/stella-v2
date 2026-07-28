import { defineTable } from "convex/server";
import { v } from "convex/values";

export const cloudAgentHomeSchema = {
  // Registry of the owner's memory documents. The bytes live in R2 under
  // agent-home/<sha256(ownerId)>/memories/<name> and are read and written by
  // the orchestrator DO through its AGENT_HOME bucket binding; Convex keeps
  // the canonical record that a document exists, how large it is, and when it
  // last changed, so Recall and the UI never have to list a bucket.
  cloud_agent_home_docs: defineTable({
    ownerId: v.string(),
    // "MEMORY.md" | "memory_map.md" | "profile.md"
    name: v.string(),
    r2Key: v.string(),
    sizeBytes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_name", ["ownerId", "name"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),
};
