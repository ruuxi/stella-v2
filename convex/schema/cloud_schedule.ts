import { defineTable } from "convex/server";
import { v } from "convex/values";

export const cloudScheduleSchema = {
  // Owner-scoped scheduled cloud chat turns. A Convex cron sweeps
  // by_status_and_nextRunAt every minute and dispatches due rows through the
  // shared chat-turn entry; the orchestrator's Schedule tool reads and writes
  // these rows over the authenticated HTTP surface.
  cloud_scheduled_turns: defineTable({
    scheduleId: v.string(),
    ownerId: v.string(),
    // Absent until the first fire creates the conversation the schedule
    // reports into; from then on every fire lands in the same thread.
    conversationId: v.optional(v.string()),
    prompt: v.string(),
    // Serialized LocalCronSchedule (packages/contracts/scheduling.ts):
    // {kind:"at",atMs} | {kind:"every",everyMs,anchorMs?} | {kind:"cron",expr,tz?}
    schedule: v.string(),
    nextRunAt: v.number(),
    lastRunAt: v.optional(v.number()),
    // "active" | "paused" | "done"
    status: v.string(),
    description: v.string(),
    // Why the most recent fire did not run, and how many fires in a row have
    // failed. A schedule that is quietly dropping its runs looks identical to
    // a healthy one without these, since nextRunAt advances either way.
    lastError: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
    failureCount: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scheduleId", ["scheduleId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_conversationId_and_ownerId_and_updatedAt", [
      "conversationId",
      "ownerId",
      "updatedAt",
    ])
    .index("by_status_and_nextRunAt", ["status", "nextRunAt"]),
};
