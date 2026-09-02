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

export const ownerEnforcementStatusValidator = v.union(
  v.literal("ok"),
  v.literal("challenged"),
  v.literal("throttled"),
  v.literal("suspended"),
);

export const ownerEnforcementValidator = v.object({
  status: ownerEnforcementStatusValidator,
  until: v.optional(v.number()),
  reason: v.optional(v.string()),
});

export const gatewaySchema = {
  /**
   * Idempotency receipts for model-gateway usage events
   * (`POST /api/gateway/usage`). One row per gateway request id: the first
   * ingest bills and settles its grant; replays are duplicates.
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

  gateway_capability_grants: defineTable({
    jti: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    audience: managedModelAudienceValidator,
    budgetMicroCents: v.number(),
    maxRequests: v.optional(v.number()),
    issuedAt: v.number(),
    expiresAt: v.number(),
    settledMicroCents: v.number(),
    settledRequests: v.number(),
    released: v.boolean(),
  })
    .index("by_jti", ["jti"])
    .index("by_owner_released", ["ownerId", "released"])
    .index("by_released_expires", ["released", "expiresAt"]),

  owner_enforcement: defineTable({
    ownerId: v.string(),
    status: ownerEnforcementStatusValidator,
    until: v.optional(v.number()),
    reason: v.string(),
    actor: v.string(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),
};
