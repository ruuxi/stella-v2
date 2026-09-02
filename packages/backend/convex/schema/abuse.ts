import { defineTable } from "convex/server";
import { v } from "convex/values";
import { identityLevelValidator } from "../lib/identity_level";

export const riskWindowValidator = v.union(v.literal("1h"), v.literal("24h"));

const appIntegrityPurposeValidator = v.union(
  v.literal("anonymous-sign-in"),
  v.literal("magic-link"),
);

const appIntegrityPlatformValidator = v.union(
  v.literal("ios"),
  v.literal("android"),
  v.literal("web"),
);

export const abuseSchema = {
  owner_origins: defineTable({
    ownerId: v.string(),
    deviceKeyHash: v.optional(v.string()),
    ipHash: v.optional(v.string()),
    networkClass: v.optional(v.string()),
    emailDomain: v.optional(v.string()),
    platform: v.optional(appIntegrityPlatformValidator),
    identityLevel: identityLevelValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_deviceKeyHash_createdAt", ["deviceKeyHash", "createdAt"])
    .index("by_ipHash_createdAt", ["ipHash", "createdAt"])
    .index("by_ipHash_identityLevel_createdAt", [
      "ipHash",
      "identityLevel",
      "createdAt",
    ])
    .index("by_ipHash_networkClass_createdAt", [
      "ipHash",
      "networkClass",
      "createdAt",
    ])
    .index("by_networkClass_createdAt", ["networkClass", "createdAt"]),

  app_integrity_nonces: defineTable({
    nonce: v.string(),
    purpose: appIntegrityPurposeValidator,
    createdAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_nonce", ["nonce"])
    .index("by_expiresAt", ["expiresAt"]),

  app_attest_keys: defineTable({
    keyId: v.string(),
    publicKey: v.string(),
    signCount: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
  }).index("by_keyId", ["keyId"]),

  owner_daily_counters: defineTable({
    ownerId: v.string(),
    kind: v.string(),
    day: v.string(),
    count: v.number(),
  }).index("by_owner_kind_day", ["ownerId", "kind", "day"]),

  owner_risk_signals: defineTable({
    ownerId: v.string(),
    window: riskWindowValidator,
    requests: v.number(),
    chargedMicroCents: v.number(),
    mints: v.number(),
    hostingRequests: v.number(),
    distinctIps: v.number(),
    ipHashes: v.array(v.string()),
    distinctConversations: v.number(),
    conversationIds: v.array(v.string()),
    failedRequests: v.number(),
    sybilFlags: v.number(),
    score: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_window", ["ownerId", "window"])
    .index("by_window_score", ["window", "score"])
    .index("by_window_chargedMicroCents", ["window", "chargedMicroCents"])
    .index("by_window_requests", ["window", "requests"])
    .index("by_window_mints", ["window", "mints"])
    .index("by_updatedAt", ["updatedAt"]),
};
