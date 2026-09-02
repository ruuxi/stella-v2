import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Mirrors `MANAGED_MODEL_AUDIENCES` in `@stella/contracts/gateway/capability`. */
export const managedModelAudienceValidator = v.union(
  v.literal("anonymous"),
  v.literal("free"),
  v.literal("go"),
  v.literal("pro"),
  v.literal("go_fallback"),
  v.literal("pro_fallback"),
);

export const gatewaySchema = {
  /**
   * Idempotency receipts for model-gateway usage events
   * (`POST /api/gateway/usage`). One row per gateway request id: the first
   * ingest bills (or counts, for anonymous trials); replays are duplicates.
   */
  gateway_usage_receipts: defineTable({
    requestId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    /** What the gateway charged against the capability budget, in micro-cents. */
    chargedMicroCents: v.number(),
    createdAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),
};
