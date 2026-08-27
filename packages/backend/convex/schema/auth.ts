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
    .index("by_ownerId_and_provider_and_updatedAt", ["ownerId", "provider", "updatedAt"])
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

  // Tombstones for Better Auth sessions killed by `revokeActiveSessions`.
  //
  // Real revocation is the deletion of the Better Auth `session` row: once it
  // is gone, `/api/auth/convex/token` stops minting and the holder is locked
  // out. But Convex verifies a JWT against JWKS alone, so a token already
  // minted stays cryptographically valid until it expires. These rows cover
  // exactly that in-flight window and are pruned once `expiresAt` passes.
  //
  // Keyed on `sessionId` and NOT on the `iat` claim: Convex's `customJwt`
  // provider decodes with biscuit, whose `RegisteredClaims` consumes `iat`
  // before custom claims are extracted, so `iat` never reaches
  // `UserIdentity`. `sessionId` is a non-registered claim and does survive —
  // verified against a live deployment, see `docs/auth-revocation.md`.
  auth_revoked_sessions: defineTable({
    ownerId: v.string(),
    sessionId: v.string(),
    revokedAt: v.number(),
    // Wall-clock ms after which this tombstone is worthless: any JWT naming
    // this session has expired on its own by then.
    expiresAt: v.number(),
  })
    .index("by_ownerId_and_sessionId", ["ownerId", "sessionId"])
    .index("by_expiresAt", ["expiresAt"]),

  auth_link_requests: defineTable({
    email: v.string(),
    requestId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
    ),
    // base64url(SHA-256(claimSecret)). The client generates `claimSecret`,
    // keeps it in memory, and must present it to /api/auth/link/claim.
    // Knowing `requestId` alone is therefore not enough to take the session.
    claimHash: v.string(),
    // AES-GCM(bearer token) under BETTER_AUTH_SECRET. Never plaintext at
    // rest, and deleted on first successful claim.
    tokenEnc: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    claimAttempts: v.optional(v.number()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_email_and_createdAt", ["email", "createdAt"]),
};
