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
    // Absent for plain-chat and spawned-agent turns; required only when the
    // turn targets a mini app (build/operation lanes).
    appId: v.optional(v.string()),
    prompt: v.string(),
    status: v.string(),
    lane: v.optional(v.string()),
    terminalKind: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    resultJson: v.optional(v.string()),
    // "chat" (orchestrator in the DO), "build" (legacy app build), or
    // "agent" (spawned general agent in a sandbox). Absent on legacy rows.
    kind: v.optional(v.string()),
    agentType: v.optional(v.string()),
    // Spawn placement for kind "agent" turns: drive | app:<slug> |
    // project:<name> | stella | computer.
    workspace: v.optional(v.string()),
    threadId: v.optional(v.string()),
    parentTurnId: v.optional(v.string()),
    // Wake/lifecycle turns the UI must not render as user messages.
    hidden: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_turnId", ["turnId"])
    .index("by_sessionId_and_createdAt", ["sessionId", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    // Quota gates count per-lane: chat rows outnumber build rows by up to
    // 20x, so a mixed-lane window can't bound a per-lane count.
    .index("by_ownerId_and_lane_and_createdAt", ["ownerId", "lane", "createdAt"])
    .index("by_conversationId_and_createdAt", ["conversationId", "createdAt"])
    .index("by_threadId_and_createdAt", ["threadId", "createdAt"]),

  // Canonical conversation transcript for cloud-executed chat. One row per
  // AgentMessage (user/assistant/toolResult), ordered by seq within a
  // conversation. The orchestrator DO reconstructs its loop context from
  // these rows — Convex is the source of truth, the DO only buffers.
  cloud_messages: defineTable({
    conversationId: v.string(),
    ownerId: v.string(),
    seq: v.number(),
    role: v.string(),
    payloadJson: v.string(),
    turnId: v.string(),
    hidden: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_conversationId_and_seq", ["conversationId", "seq"])
    .index("by_turnId", ["turnId"]),

  // Short-lived per-turn credentials. Only the SHA-256 hash is stored; the
  // raw token travels to the executor and authenticates relay model calls
  // and event/message callbacks for exactly one turn.
  cloud_turn_tokens: defineTable({
    tokenHash: v.string(),
    ownerId: v.string(),
    turnId: v.string(),
    agentType: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"]),

  // Durable spawned-agent threads (cloud analog of the desktop runtime's
  // agent threads). One row per spawn_agent call from the cloud orchestrator.
  cloud_agent_threads: defineTable({
    threadId: v.string(),
    ownerId: v.string(),
    conversationId: v.string(),
    parentTurnId: v.string(),
    description: v.string(),
    workspace: v.string(),
    agentType: v.string(),
    status: v.string(),
    resultJson: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_threadId", ["threadId"])
    .index("by_conversationId_and_updatedAt", ["conversationId", "updatedAt"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

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

  cloud_app_operations: defineTable({
    appId: v.string(),
    ownerId: v.string(),
    manifestJson: v.string(),
    sizeBytes: v.number(),
    updatedAt: v.number(),
  }).index("by_appId", ["appId"]),

  cloud_app_op_invocations: defineTable({
    invocationId: v.string(),
    appId: v.string(),
    ownerId: v.string(),
    turnId: v.string(),
    name: v.string(),
    argsJson: v.string(),
    status: v.string(),
    resultJson: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_invocationId", ["invocationId"])
    .index("by_appId_and_status_and_createdAt", ["appId", "status", "createdAt"])
    .index("by_turnId", ["turnId"]),

  cloud_failure_alerts: defineTable({
    windowStartedAt: v.number(),
    windowEndedAt: v.number(),
    failureCount: v.number(),
    threshold: v.number(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    summary: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_createdAt", ["createdAt"]),
};
