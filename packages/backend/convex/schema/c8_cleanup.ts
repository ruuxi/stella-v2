import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Temporary Phase-1 cutover receipt. It is deliberately schema-backed so a
 * worker restart cannot bypass the full presigned-upload quiet period.
 */
export const c8CleanupSchema = {
  c8_cleanup_cutover: defineTable({
    key: v.literal("c8-retired-writers"),
    deployment: v.literal("dev:impartial-crab-34"),
    cloudUrl: v.literal("https://impartial-crab-34.convex.cloud"),
    siteUrl: v.literal("https://impartial-crab-34.convex.site"),
    markerValue: v.literal("1"),
    armedAt: v.number(),
    barrierMs: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
};
