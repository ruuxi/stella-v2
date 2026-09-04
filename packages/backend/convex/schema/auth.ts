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
  // `UserIdentity`. `sessionId` is a non-registered claim and does survive.
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
    status: v.union(v.literal("pending"), v.literal("completed")),
    /**
     * Validated Convex owner identities captured from the authenticated send
     * and verified Better Auth completion paths. Never persist the anonymous
     * bearer token or cookie: the owner id is sufficient to bind the transfer.
     * These remain optional while pre-migration rows can still exist.
     */
    fromOwnerId: v.optional(v.string()),
    /** Better Auth source locator retained only through linked cleanup. */
    fromAuthUserId: v.optional(v.string()),
    /** Lifecycle generation captured when the source principal is bound. */
    fromOwnerGeneration: v.optional(v.string()),
    toOwnerId: v.optional(v.string()),
    /** Lifecycle generation captured when the destination cookie is bound. */
    toOwnerGeneration: v.optional(v.string()),
    ownershipMigrationId: v.optional(v.id("auth_owner_migrations")),
    /**
     * base64url(SHA-256(claimSecret)). The client generates `claimSecret`,
     * keeps it in memory, and must present it to /api/auth/link/claim.
     * Knowing `requestId` alone is therefore not enough to take the session.
     *
     * Optional only so in-flight rows written before this migration still
     * validate. `claimLinkRequest` treats an absent hash as unclaimable, so a
     * legacy row can never yield a credential.
     */
    claimHash: v.optional(v.string()),
    /**
     * AES-GCM(bearer token) under `BETTER_AUTH_SECRET`. Never plaintext at
     * rest, and deleted on the first successful claim.
     */
    tokenEnc: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    claimAttempts: v.optional(v.number()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_email_and_createdAt", ["email", "createdAt"])
    .index("by_fromOwnerId_and_createdAt", ["fromOwnerId", "createdAt"])
    .index("by_toOwnerId_and_createdAt", ["toOwnerId", "createdAt"])
    .index("by_ownershipMigrationId", ["ownershipMigrationId"]),

  auth_browser_handoffs: defineTable({
    requestId: v.string(),
    provider: v.literal("google"),
    fromOwnerId: v.string(),
    // Optional only for rolling-schema compatibility. Consume rejects rows
    // without a canonical generation instead of treating them as current.
    fromOwnerGeneration: v.optional(v.string()),
    returnOrigin: v.string(),
    returnTo: v.string(),
    status: v.union(v.literal("pending"), v.literal("consumed")),
    expiresAt: v.number(),
    createdAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_requestId", ["requestId"])
    .index("by_fromOwnerId", ["fromOwnerId"])
    .index("by_expiresAt", ["expiresAt"]),

  auth_owner_migrations: defineTable({
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
    /**
     * Better Auth locator for the successfully linked anonymous principal.
     * It survives only until a permanent source delete job has durably taken
     * ownership of both product-data and auth-row cleanup.
     */
    sourceAuthUserId: v.optional(v.string()),
    sourceAuthUserEmail: v.optional(v.string()),
    sourceAuthDeletionOperationId: v.optional(v.string()),
    sourceAuthDeletionState: v.optional(
      v.union(v.literal("pending"), v.literal("started")),
    ),
    sourceAuthDeletionStartedAt: v.optional(v.number()),
    /**
     * Source remote turns are cancelled and retired before any conversation
     * ownership moves. The cursor makes the legacy owner-unbound inventory
     * crash-resumable; only aggregate, non-content evidence survives the row
     * deletion so ambiguous provider work is never rebound to the destination.
     */
    remoteTurnConversationCursor: v.optional(v.string()),
    remoteTurnConversationScanComplete: v.optional(v.boolean()),
    remoteTurnRetiredCount: v.optional(v.number()),
    remoteTurnProviderDispatchCount: v.optional(v.number()),
    remoteTurnOutcomeDigest: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("failed"),
      v.literal("complete"),
    ),
    leaseId: v.optional(v.string()),
    /** Monotonic ABA fence; optional for rows created before this rollout. */
    leaseGeneration: v.optional(v.number()),
    /** Owner-lifecycle generations captured when the transfer is published. */
    fromOwnerGeneration: v.optional(v.string()),
    toOwnerGeneration: v.optional(v.string()),
    /** Version of the immutable external-transfer plan/control protocol. */
    planRevision: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    watchdogId: v.optional(v.id("_scheduled_functions")),
    lastError: v.optional(v.string()),
    /**
     * Temporary cross-purge receipt. When destination teardown cascades a
     * permanent purge of the anonymous source, the A -> B row must survive
     * until A's durable purge job reaches `complete`; otherwise a lost action
     * response could let B finish while source residue still exists.
     */
    sourcePurgeDependency: v.optional(
      v.object({
        sourceOperationId: v.string(),
        sourceGeneration: v.string(),
        destinationOperationId: v.string(),
        destinationGeneration: v.string(),
      }),
    ),
    /**
     * Crash-safe cursor for owner-hash storage and the cloud product tables.
     * Missing means the first stage so in-flight migrations from a rolling
     * deployment resume by transferring, never by silently skipping it.
     */
    cloudProductStage: v.optional(
      v.union(
        v.literal("owner-namespaces"),
        v.literal("apps"),
        v.literal("projects"),
        v.literal("core"),
        v.literal("complete"),
      ),
    ),
    /**
     * Worker copy receipt retained until Convex projection commit is durably
     * acknowledged. `ready` becomes true in the same mutation as the final
     * projection write, closing the copy -> projection -> ack crash windows.
     */
    externalTransferAck: v.optional(
      v.object({
        ready: v.boolean(),
        transferOperationId: v.string(),
        transferPlanFingerprint: v.string(),
        migrationId: v.string(),
        leaseId: v.string(),
        leaseGeneration: v.number(),
        fromOwnerGeneration: v.string(),
        toOwnerGeneration: v.string(),
        stage: v.string(),
        planRevision: v.number(),
      }),
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
    ])
    .index("by_status_sourceAuthDeletionState_updatedAt", [
      "status",
      "sourceAuthDeletionState",
      "updatedAt",
    ]),

  /**
   * Permanent source revocation after an operational migration row is erased
   * by reset/account deletion. The domain-separated digest is deliberately the
   * only application field: no raw owner ids, destination binding, lifecycle
   * generations, transfer receipts, errors, or activity timestamps survive.
   */
  auth_owner_migration_tombstones: defineTable({
    sourceOwnerDigest: v.string(),
  }).index("by_sourceOwnerDigest", ["sourceOwnerDigest"]),

  /**
   * Durable handoff from Better Auth's synchronous beforeDelete hook to the
   * resumable whole-stack purge. If the hook/action response is lost, the
   * completed delete job still has the exact component-user locator needed to
   * remove authentication rows. This row is deleted only after the Better Auth
   * user is confirmed absent.
   */
  auth_account_deletion_finalizers: defineTable({
    ownerId: v.string(),
    authUserId: v.string(),
    // Better Auth verification rows can be keyed by email rather than user id.
    // Preserve the exact locator until the finalizer confirms those rows gone.
    authUserEmail: v.optional(v.string()),
    /** Component-row creation cutoff used by the legacy verification sweep. */
    authRowsCreatedBefore: v.number(),
    legacyVerificationCursor: v.optional(v.string()),
    legacyVerificationComplete: v.boolean(),
    operationId: v.string(),
    generation: v.string(),
    phase: v.union(v.literal("waiting_for_purge"), v.literal("ready")),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_authUserId", ["authUserId"])
    .index("by_phase_and_nextAttemptAt", ["phase", "nextAttemptAt"]),
};
