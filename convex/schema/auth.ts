import { defineTable } from "convex/server";
import { v } from "convex/values";
import { optionalJsonValueValidator } from "../shared_validators";

export const authSchema = {
  secrets: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    label: v.string(),
    encryptedValue: v.string(),
    keyVersion: v.number(),
    status: v.string(),
    metadata: optionalJsonValueValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_provider_and_updatedAt", [
      "ownerId",
      "provider",
      "updatedAt",
    ])
    .index("by_keyVersion", ["keyVersion"]),

  secret_access_audit: defineTable({
    ownerId: v.string(),
    secretId: v.id("secrets"),
    toolName: v.string(),
    requestId: v.string(),
    status: v.string(),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_secretId_and_createdAt", ["secretId", "createdAt"]),

  // Per-account session-revocation marker. A row exists only after the user
  // calls `revokeActiveSessions`; absence means "no revocations on file".
  // `assertSensitiveSessionPolicy` rejects any JWT whose `iat` claim is older
  // than `minIssuedAtSec`. This is the only mechanism for invalidating
  // outstanding tokens — by design we don't carry a separate version counter
  // since `iat`/`minIssuedAtSec` already covers the same semantics.
  auth_session_policies: defineTable({
    ownerId: v.string(),
    minIssuedAtSec: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  auth_link_requests: defineTable({
    email: v.string(),
    requestId: v.string(),
    status: v.union(v.literal("pending"), v.literal("completed")),
    /**
     * Validated Convex owner identities captured from the authenticated send
     * and verified Better Auth completion paths. Never persist the anonymous
     * bearer token or cookie: the owner id is sufficient to bind the transfer.
     */
    fromOwnerId: v.optional(v.string()),
    toOwnerId: v.optional(v.string()),
    ownershipMigrationId: v.optional(v.id("auth_owner_migrations")),
    ott: v.optional(v.string()),
    sessionCookie: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_email_and_createdAt", ["email", "createdAt"]),

  auth_owner_migrations: defineTable({
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("failed"),
      v.literal("complete"),
    ),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    watchdogId: v.optional(v.id("_scheduled_functions")),
    lastError: v.optional(v.string()),
    /**
     * Crash-safe cursor for owner-hash storage and the cloud product tables.
     * Missing means the first stage so in-flight migrations from a rolling
     * deployment resume by transferring, never by silently skipping it.
     */
    cloudProductStage: v.optional(
      v.union(
        v.literal("owner-namespaces"),
        v.literal("apps"),
        v.literal("interior"),
        v.literal("projects"),
        v.literal("core"),
        v.literal("complete"),
      ),
    ),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_fromOwnerId_and_toOwnerId", ["fromOwnerId", "toOwnerId"])
    .index("by_fromOwnerId_and_updatedAt", ["fromOwnerId", "updatedAt"])
    .index("by_toOwnerId_and_updatedAt", ["toOwnerId", "updatedAt"])
    .index("by_toOwnerId_and_status_and_updatedAt", [
      "toOwnerId",
      "status",
      "updatedAt",
    ]),
};
