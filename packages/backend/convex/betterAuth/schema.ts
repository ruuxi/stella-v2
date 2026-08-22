/**
 * Better Auth component schema. Mirrors `@convex-dev/better-auth` with two
 * app-specific deltas: the anonymous-user scan index and non-secret JWKS
 * rotation control records. Private keys remain only in Better Auth's `jwks`
 * table and are never copied into rotation metadata.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { tables } from "./generatedTables";

export default defineSchema({
  ...tables,
  user: tables.user.index("isAnonymous_updatedAt", ["isAnonymous", "updatedAt"]),
  jwksRotation: defineTable({
    operationId: v.string(),
    state: v.union(
      v.literal("prepared"),
      v.literal("active"),
      v.literal("rolled_back"),
      v.literal("retired"),
    ),
    previousKeyId: v.id("jwks"),
    newKeyId: v.id("jwks"),
    createdAt: v.number(),
    updatedAt: v.number(),
    activatedAt: v.optional(v.number()),
    rolledBackAt: v.optional(v.number()),
    retireAfter: v.optional(v.number()),
    retirementTargetKeyId: v.optional(v.id("jwks")),
    retiredAt: v.optional(v.number()),
  })
    .index("by_operationId", ["operationId"])
    .index("by_state", ["state"]),
});
