import { defineTable } from "convex/server";
import { v } from "convex/values";

export const cloudBrowserInteractionKindValidator = v.union(
  v.literal("login_takeover"),
  v.literal("device_code"),
);

export const cloudBrowserInteractionStateValidator = v.union(
  v.literal("pending"),
  v.literal("human_control"),
  v.literal("resuming"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("expired"),
  v.literal("failed"),
);

export const cloudBrowserResumeResultValidator = v.union(
  v.literal("approved"),
  v.literal("canceled"),
  v.literal("expired"),
  v.literal("failed"),
);

export const cloudBrowserResumeReceiptValidator = v.object({
  schemaVersion: v.literal(1),
  interactionId: v.string(),
  interactionRevision: v.number(),
  profileId: v.string(),
  profileEpoch: v.number(),
  toolCallId: v.string(),
  requestDigest: v.string(),
  result: cloudBrowserResumeResultValidator,
  safeMessage: v.string(),
});

export const cloudBrowserSchema = {
  /**
   * Secret-free control projection for one browser handoff. Browser profile
   * bytes, cookies, DOM, device-code values, Live View URLs, and human-entered
   * fields live only in the private Browser Gateway.
   */
  cloud_browser_interactions: defineTable({
    interactionId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    threadId: v.string(),
    /** Physical turn that yielded `waiting_for_user`. */
    turnId: v.string(),
    attemptGeneration: v.number(),
    toolCallId: v.string(),
    requestDigest: v.string(),
    /** Fixed to `default` in the first accepted product slice. */
    profileId: v.string(),
    /** Gateway-owned profile epoch observed when this interaction was made. */
    profileEpoch: v.number(),
    kind: cloudBrowserInteractionKindValidator,
    state: cloudBrowserInteractionStateValidator,
    displayOrigin: v.string(),
    displayTitle: v.optional(v.string()),
    revision: v.number(),
    expiresAt: v.number(),
    /** Hash of the exact waiting event bytes, so a replay must match. */
    suspensionEventPayloadHash: v.string(),
    decision: v.optional(v.union(v.literal("done"), v.literal("cancel"))),
    decisionRequestId: v.optional(v.string()),
    decisionBaseRevision: v.optional(v.number()),
    resolution: v.optional(cloudBrowserResumeResultValidator),
    safeMessage: v.optional(v.string()),
    /** Fresh physical turn created to append the tool result and continue. */
    resumeTurnId: v.optional(v.string()),
    resumeAttemptGeneration: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_interactionId", ["interactionId"])
    .index("by_ownerId_and_interactionId", ["ownerId", "interactionId"])
    .index("by_ownerId_and_state_and_createdAt", [
      "ownerId",
      "state",
      "createdAt",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_turnId_and_requestDigest", ["turnId", "requestDigest"])
    .index("by_resumeTurnId", ["resumeTurnId"]),
};
