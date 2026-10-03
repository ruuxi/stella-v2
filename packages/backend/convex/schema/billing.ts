import { defineTable } from "convex/server";
import { v } from "convex/values";

export const billingSchema = {
  billing_model_prices: defineTable({
    model: v.string(),
    source: v.string(),
    sourceProvider: v.string(),
    sourceModelId: v.string(),
    inputPerMillionUsd: v.number(),
    outputPerMillionUsd: v.number(),
    cacheReadPerMillionUsd: v.number(),
    cacheWritePerMillionUsd: v.number(),
    reasoningPerMillionUsd: v.number(),
    /**
     * Input modalities advertised by models.dev (or its fallback). Optional
     * because pre-existing rows pre-date the modality sync; readers default
     * to ["text"] when missing so unknown models drop images at the gateway
     * boundary instead of being silently forwarded as data URLs.
     */
    modalitiesInput: v.optional(v.array(v.string())),
    /** Output modalities advertised by models.dev. Defaults to ["text"]. */
    modalitiesOutput: v.optional(v.array(v.string())),
    sourceUpdatedAt: v.string(),
    syncedAt: v.number(),
  })
    .index("by_model", ["model"])
    .index("by_syncedAt", ["syncedAt"]),
};
