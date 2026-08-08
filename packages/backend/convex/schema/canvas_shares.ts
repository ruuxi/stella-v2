import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Published "canvas share" documents: a self-contained generated HTML doc
 * uploaded to the `stella-canvas-shares` R2 bucket and served publicly at an
 * unguessable slug. The row is the source of truth for ownership and expiry;
 * the R2 object is what the serving Worker actually returns. Deleting the R2
 * object (revoke / expiry / account deletion) is what makes a share 404.
 */
const canvasShareFields = {
  /** 128-bit CSPRNG, base64url (~22 chars). Public, unguessable. */
  slug: v.string(),
  /** Owner's connected user id (tokenIdentifier). */
  ownerUserId: v.string(),
  /** R2 object key, e.g. `shares/<slug>.html`. */
  r2Key: v.string(),
  /** Optional human-facing title supplied at publish time. */
  title: v.optional(v.string()),
  createdAt: v.number(),
  /** Epoch ms after which the share is treated as gone (default +90d). */
  expiresAt: v.number(),
  /** True once the owner revokes; the row is retained for auditing. */
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
