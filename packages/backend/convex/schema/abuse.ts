import { defineTable } from "convex/server";
import { v } from "convex/values";
import { identityLevelValidator } from "../lib/identity_level";

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
};
