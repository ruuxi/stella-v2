import { defineTable } from "convex/server";
import { v } from "convex/values";

export const cloudOutboxSchema = {
  /**
   * Idempotency receipts for `POST /api/cloud/outbox`
   * (`@stella/contracts/turn-plane/outbox`). One row per applied
   * (kind, key); a redelivery of the same event is answered as a duplicate
   * without touching the projection it already wrote.
   */
  cloud_outbox_receipts: defineTable({
    kind: v.string(),
    key: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    createdAt: v.number(),
  })
    .index("by_kind_and_key", ["kind", "key"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),
};
