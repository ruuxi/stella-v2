import { defineTable } from "convex/server";
import { v } from "convex/values";

export const cloudConnectorConnectStateValidator = v.union(
  v.literal("pending"),
  v.literal("connecting"),
  v.literal("connected"),
  v.literal("declined"),
  v.literal("canceled"),
  v.literal("expired"),
);

export const cloudConnectorConnectSchema = {
  /**
   * One inline connect card a cloud orchestrator turn is waiting on: the
   * cloud twin of the desktop's `connector-connect:request` IPC. The turn
   * holds its `connector_status` call open while every signed-in client
   * renders the pending row; the user's answer finishes the account-level
   * Composio connection (or declines) and the row settles.
   */
  cloud_connector_connect_requests: defineTable({
    requestId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    integrationId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    iconUrl: v.optional(v.string()),
    category: v.optional(v.string()),
    reason: v.optional(v.string()),
    state: cloudConnectorConnectStateValidator,
    revision: v.number(),
    expiresAt: v.number(),
    decisionRequestId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_requestId", ["requestId"])
    .index("by_ownerId_and_requestId", ["ownerId", "requestId"])
    .index("by_ownerId_and_state_and_createdAt", [
      "ownerId",
      "state",
      "createdAt",
    ])
    .index("by_turnId_and_integrationId", ["turnId", "integrationId"]),
};
