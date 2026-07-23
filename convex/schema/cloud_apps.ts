import { defineTable } from "convex/server";
import { v } from "convex/values";

export const cloudAppsSchema = {
  cloud_conversations: defineTable({
    conversationId: v.string(),
    ownerId: v.string(),
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  cloud_apps: defineTable({
    appId: v.string(),
    ownerId: v.string(),
    slug: v.string(),
    title: v.string(),
    status: v.string(),
    activeBuildId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_appId", ["appId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_slug", ["slug"]),

  cloud_app_builds: defineTable({
    buildId: v.string(),
    appId: v.string(),
    ownerId: v.string(),
    status: v.string(),
    artifactPrefix: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    slug: v.optional(v.string()),
    metricsJson: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_buildId", ["buildId"])
    .index("by_appId_and_createdAt", ["appId", "createdAt"]),

  agent_turns: defineTable({
    turnId: v.string(),
    sessionId: v.string(),
    ownerId: v.string(),
    conversationId: v.optional(v.string()),
    appId: v.string(),
    prompt: v.string(),
    status: v.string(),
    terminalKind: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    resultJson: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_turnId", ["turnId"])
    .index("by_sessionId_and_createdAt", ["sessionId", "createdAt"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_conversationId_and_createdAt", ["conversationId", "createdAt"]),

  agent_events: defineTable({
    turnId: v.string(),
    sessionId: v.string(),
    seq: v.number(),
    kind: v.string(),
    payloadJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_turnId_and_seq", ["turnId", "seq"])
    .index("by_sessionId_and_createdAt", ["sessionId", "createdAt"]),

  cloud_app_storage: defineTable({
    appId: v.string(),
    ownerId: v.string(),
    userId: v.string(),
    key: v.string(),
    valueJson: v.string(),
    sizeBytes: v.number(),
    updatedAt: v.number(),
  })
    .index("by_appId_and_userId_and_key", ["appId", "userId", "key"])
    .index("by_appId_and_userId", ["appId", "userId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),
};
