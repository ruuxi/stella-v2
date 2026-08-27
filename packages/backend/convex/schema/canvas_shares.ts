import { defineTable } from "convex/server";
import { v } from "convex/values";

const canvasShareFields = {

  slug: v.string(),

  ownerUserId: v.string(),

  r2Key: v.string(),

  title: v.optional(v.string()),
  createdAt: v.number(),

  expiresAt: v.number(),

  revoked: v.boolean(),
};

export const canvas_share_validator = v.object({
  _id: v.id("canvas_shares"),
  _creationTime: v.number(),
  ...canvasShareFields,
});

export const canvasSharesSchema = {
  canvas_shares: defineTable(canvasShareFields)
    .index("by_slug", ["slug"])
    .index("by_ownerUserId", ["ownerUserId"])
    .index("by_expiresAt", ["expiresAt"]),
};
