/**
 * Ownership migration for anonymous → real account linking.
 *
 * When an anonymous user signs in with a real identity, all owner-scoped
 * data must be transferred to the new ownerId. This module performs that
 * migration in batches to stay within Convex mutation limits.
 *
 * Each per-table migration is its own typed `internalMutation` so we keep the
 * `ctx.db.query` builder fully typed (no `as any` / `_id: any`). The
 * orchestrator action below walks the table list and re-invokes each batch
 * mutation until it returns `hasMore: false`.
 */

import Stripe from "stripe";
import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { hashSha256Hex } from "./lib/crypto_utils";
import {
  hashStripeBillingLocator,
  hashStripeDeletedOperationTuple,
  hashStripeRetainedLocatorSet,
  stripeHistoricalResultShape,
} from "./lib/billing_deletion";
import {
  ensureLegacyStripeOperationPhysicalReceiptProvenance,
  hasExactStripeOperationResolutionProofSet,
  hasStripePhysicalReceiptCapacityForInsert,
  hasCleanIdleStripeOperationTransport,
  hasCleanLegacyStripeOperationTransport,
  hasCurrentStripeOperationIntegrity,
  hasLegacyStripeOperationIntegrityVersion,
  hasMatchingStripeManualResolutionProof,
  hasValidStripeRetainedLocatorProof,
  hasValidStripeOperationStateLocators,
  moveStripeOperationResolutionProofs,
  STRIPE_RECEIPT_INTEGRITY_VERSION,
} from "./lib/stripe_operation_integrity";
import { composioUserIdForOwner } from "./lib/composio_identity";
import {
  assertSensitiveSessionPolicy,
  getConnectedUserIdOrNull,
  requireConnectedUserIdentity,
  tokenIdentifierForBetterAuthUserId,
} from "./auth";
import { enforceMutationRateLimit, RATE_SENSITIVE } from "./lib/rate_limits";
import {
  canceledPendingUploadCleanupDelays,
  driveFileOwnershipPatch,
  importedAgentHomeDocumentName,
  importedAgentHomePrefix,
  importedDrivePath,
  importedInteriorPrefix,
  importedOwnerScopedKey,
  importedProjectSlug,
  importedSkillSlug,
  isOwnershipMigrationBlockedMessage,
  mergeBillingUsageWindows,
  migratedSourceAuthDeletionOperationId,
  ownershipMigrationSourceDigest,
  ownershipMigrationTransientStateDisposition,
  shouldAdvanceOwnerNamespaceStage,
  workspaceTransferResolutionsMatch,
} from "./lib/auth_migration_paths";
import {
  assertOwnerDataAccessActive,
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
} from "./owner_lifecycle";
import { ownerPurgeModeValidator } from "./schema/owner_lifecycle";
import {
  createManagedDispatchRequestFingerprint,
  managedDispatchOutcomeRequiresQuiescence,
} from "./lib/managed_dispatch";
import {
  finalizeManagedDispatchBillingFromReceipt,
  managedDispatchHasPendingBilling,
} from "./billing";
import { quiesceOwnerComposioSessionProvisioning } from "./composio_session_dispatch";
import {
  quiesceOwnerStripeOperations,
  hasValidatedStripeMetadataTransferAuthority,
  hasValidLateStripeCleanupRowProof,
  resolvePinnedStripeCustomerAuthorityKey,
  stripeResolutionAuditHash,
  stripeCustomerAuthorityIdempotencyKey,
  type StripeOperationQuiescenceResult,
} from "./stripe_operation_dispatch";

const BATCH_SIZE = 500;
const REMOTE_TURN_MIGRATION_BATCH = 32;
const REMOTE_TURN_CONVERSATION_PAGE = 12;
const REMOTE_TURN_PER_CONVERSATION_BATCH = 8;
const REMOTE_TURN_PROVIDER_DEADLINE_MS = 60_000;
const REMOTE_TURN_QUIESCENCE_GRACE_MS = 30_000;
const SAFE_COMPOSIO_USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/u;
const STRIPE_API_VERSION = "2026-05-27.dahlia";
const STRIPE_METADATA_TRANSFER_TIMEOUT_MS = 30_000;
const STRIPE_METADATA_TRANSFER_GRACE_MS = 15_000;

const ownerArgs = { fromOwnerId: v.string(), toOwnerId: v.string() } as const;
const prepareOwnerArgs = {
  ...ownerArgs,
  sourceAuthUserId: v.optional(v.string()),
  sourceAuthUserEmail: v.optional(v.string()),
} as const;
const leaseArgs = {
  leaseId: v.string(),
  leaseGeneration: v.number(),
  leaseNow: v.number(),
} as const;
const leasedOwnerArgs = { ...ownerArgs, ...leaseArgs } as const;
const hasMoreReturn = v.object({ hasMore: v.boolean() });
const ownerMigrationPurgeArgs = {
  ownerId: v.string(),
  operationId: v.string(),
  generation: v.string(),
  leaseId: v.string(),
  mode: ownerPurgeModeValidator,
} as const;

const isFullPage = (rows: readonly unknown[]) => rows.length === BATCH_SIZE;
const OWNERSHIP_MIGRATION_BLOCKED_PREFIX = "ownership_migration_blocked:";

const purgeMigratedSourceOwnerRef = makeFunctionReference<
  "action",
  { ownerId: string; operationId: string; generation: string },
  null
>("account_deletion:purgeOwnerCloudData");
const finalizeMigratedSourceIdentityRef = makeFunctionReference<
  "action",
  { migrationId: Id<"auth_owner_migrations"> },
  null
>("auth_migration:finalizeMigratedSourceIdentityInternal");
const listPendingMigratedSourceIdentityDeletionsRef = makeFunctionReference<
  "query",
  { limit?: number },
  Array<Id<"auth_owner_migrations">>
>("auth_migration:listPendingMigratedSourceIdentityDeletionsInternal");
const blockOwnershipMigration = (reason: string): never => {
  throw new Error(`${OWNERSHIP_MIGRATION_BLOCKED_PREFIX} ${reason}`);
};

const convexErrorCode = (error: unknown): string | null =>
  error instanceof ConvexError &&
  typeof error.data === "object" &&
  error.data !== null &&
  typeof (error.data as { code?: unknown }).code === "string"
    ? ((error.data as { code: string }).code ?? null)
    : null;

const safeMigrationStatusError = (
  outcome: "pending" | "failed" | "complete",
): string | undefined =>
  outcome === "failed"
    ? "Account linking stopped because source and destination data could not be merged safely."
    : outcome === "pending"
      ? "Account data is still moving and will retry automatically."
      : undefined;

type OwnerIds = { fromOwnerId: string; toOwnerId: string };
type OwnershipMigrationPreparation = OwnerIds & {
  sourceAuthUserId?: string;
  sourceAuthUserEmail?: string;
};
type OwnershipLease = OwnerIds & {
  leaseId: string;
  leaseGeneration: number;
  leaseNow: number;
};

type MigrationOwnerGenerations = {
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
};

const throwOwnershipDestinationConflict = (
  fromOwnerId: string,
  existingToOwnerId: string,
): never => {
  throw new ConvexError({
    code: "OWNERSHIP_MIGRATION_CONFLICT",
    message: `The anonymous identity is already bound to a different account (${fromOwnerId} -> ${existingToOwnerId}).`,
  });
};

const hasMinimizedOwnershipSourceTombstone = async (
  ctx: QueryCtx | MutationCtx,
  fromOwnerId: string,
): Promise<boolean> => {
  const sourceOwnerDigest = await ownershipMigrationSourceDigest(fromOwnerId);
  const rows = await ctx.db
    .query("auth_owner_migration_tombstones")
    .withIndex("by_sourceOwnerDigest", (q) =>
      q.eq("sourceOwnerDigest", sourceOwnerDigest),
    )
    .take(1);
  return rows.length > 0;
};

const throwOwnershipSourceAlreadyMigrated = (): never => {
  throw new ConvexError({
    code: "OWNERSHIP_MIGRATED",
    message:
      "This anonymous identity was already linked and cannot start another ownership migration.",
  });
};

const readMigrationOwnerGenerations = async (
  ctx: QueryCtx | MutationCtx,
  args: OwnerIds,
): Promise<MigrationOwnerGenerations> => {
  const [from, to] = await Promise.all([
    assertOwnerDataWriteAllowed(ctx, args.fromOwnerId),
    assertOwnerDataWriteAllowed(ctx, args.toOwnerId),
  ]);
  return {
    fromOwnerGeneration: from.generation,
    toOwnerGeneration: to.generation,
  };
};

const assertMigrationOwnerGenerations = async (
  ctx: QueryCtx | MutationCtx,
  migration: Pick<
    Doc<"auth_owner_migrations">,
    "fromOwnerId" | "toOwnerId" | "fromOwnerGeneration" | "toOwnerGeneration"
  >,
): Promise<void> => {
  if (!migration.fromOwnerGeneration || !migration.toOwnerGeneration) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_GENERATION_UNBOUND",
      message: "This ownership migration predates lifecycle fencing.",
    });
  }
  await Promise.all([
    assertOwnerDataWriteAllowed(
      ctx,
      migration.fromOwnerId,
      migration.fromOwnerGeneration,
    ),
    assertOwnerDataWriteAllowed(
      ctx,
      migration.toOwnerId,
      migration.toOwnerGeneration,
    ),
  ]);
};

const loadSingleSourceMigration = async (
  ctx: QueryCtx | MutationCtx,
  args: OwnerIds,
): Promise<Doc<"auth_owner_migrations"> | null> => {
  const sourceRows = await ctx.db
    .query("auth_owner_migrations")
    .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
      q.eq("fromOwnerId", args.fromOwnerId),
    )
    .take(2);
  const competing = sourceRows.find((row) => row.toOwnerId !== args.toOwnerId);
  if (competing) {
    throwOwnershipDestinationConflict(args.fromOwnerId, competing.toOwnerId);
  }
  if (sourceRows.length > 1) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_CONFLICT",
      message: "Duplicate ownership migration rows require repair.",
    });
  }
  return sourceRows[0] ?? null;
};

const requireActiveOwnershipMigrationLease = async (
  ctx: MutationCtx,
  args: OwnershipLease,
): Promise<Doc<"auth_owner_migrations">> => {
  const migration = await loadSingleSourceMigration(ctx, args);
  if (
    !migration ||
    migration.status !== "running" ||
    migration.leaseId !== args.leaseId ||
    migration.leaseGeneration !== args.leaseGeneration ||
    (migration.leaseExpiresAt ?? 0) <= args.leaseNow
  ) {
    throw new ConvexError({
      code: "STALE_OWNERSHIP_MIGRATION_LEASE",
      message: "This ownership migration attempt no longer owns the lease.",
    });
  }
  await assertMigrationOwnerGenerations(ctx, migration);
  return migration;
};

// ---------------------------------------------------------------------------
// Per-table batch mutations.
//
// Each one stays inside the schema's strong typing for `ctx.db.patch` so we
// don't need a `db.patch as unknown as ...` widening — the compiler proves
// that `{ ownerId }` is a valid partial patch for each table.
// ---------------------------------------------------------------------------

export const migrateConversationsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    if (migration.remoteTurnConversationScanComplete !== true) {
      throw new ConvexError({
        code: "REMOTE_TURN_MIGRATION_NOT_QUIESCENT",
        message:
          "Remote execution must be cancelled and retired before conversation ownership moves.",
      });
    }
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserPreferencesBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    // (ownerId, key) is looked up with `.unique()` elsewhere. Preserve a
    // colliding source value under a deterministic imported key rather than
    // replacing the destination or silently deleting anonymous content.
    for (const row of rows) {
      const existing = await ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("key", row.key),
        )
        .unique();
      if (existing) {
        let importedKey: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedOwnerScopedKey(
            row.key,
            String(row._id),
            attempt,
          );
          const occupied = await ctx.db
            .query("user_preferences")
            .withIndex("by_ownerId_and_key", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("key", candidate),
            )
            .unique();
          if (!occupied) {
            importedKey = candidate;
            break;
          }
        }
        if (!importedKey) {
          blockOwnershipMigration(
            `No collision-safe imported key is available for preference "${row.key}".`,
          );
        }
        await ctx.db.patch(row._id, {
          ownerId: args.toOwnerId,
          key:
            importedKey ??
            blockOwnershipMigration(
              `No collision-safe imported key is available for preference "${row.key}".`,
            ),
        });
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateAuthSessionPoliciesBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("auth_revoked_sessions")
      .withIndex("by_ownerId_and_sessionId", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    // Tombstones are unique per (ownerId, sessionId) and
    // `isSessionRevokedInDb` reads them with `.unique()`. If the target owner
    // already carries a tombstone for the same session, keep the stronger
    // (later-expiring) one and drop the source row rather than creating a
    // duplicate that would make the lookup throw.
    for (const row of rows) {
      const existing = await ctx.db
        .query("auth_revoked_sessions")
        .withIndex("by_ownerId_and_sessionId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("sessionId", row.sessionId),
        )
        .unique();
      if (existing) {
        if (row.expiresAt > existing.expiresAt) {
          await ctx.db.patch(existing._id, {
            expiresAt: row.expiresAt,
            revokedAt: Math.max(existing.revokedAt, row.revokedAt),
          });
        }
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateSecretsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("secrets")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateSecretAccessAuditBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("secret_access_audit")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserIntegrationsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    // (ownerId, provider) is looked up with `.unique()` elsewhere. There is no
    // lossless merge for two independent provider configurations, so preserve
    // both by failing closed instead of choosing one silently.
    for (const row of rows) {
      const existing = await ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("provider", row.provider),
        )
        .unique();
      if (existing) {
        blockOwnershipMigration(
          `Both identities contain a ${row.provider} integration configuration.`,
        );
      }
      let config = row.config;
      if (row.mode === "composio") {
        const hasStoredPrincipal = config.composioUserId !== undefined;
        const storedPrincipal =
          typeof config.composioUserId === "string"
            ? config.composioUserId.trim()
            : "";
        if (
          hasStoredPrincipal &&
          (!storedPrincipal || !SAFE_COMPOSIO_USER_ID.test(storedPrincipal))
        ) {
          blockOwnershipMigration(
            `The ${row.provider} Composio principal is invalid.`,
          );
        }
        if (!storedPrincipal) {
          config = {
            ...config,
            // Preserve the pre-migration provider namespace. Re-deriving from
            // the destination owner would point cleanup at the wrong user.
            composioUserId: await composioUserIdForOwner(args.fromOwnerId),
          };
        }
      }
      await ctx.db.patch(row._id, { ownerId: args.toOwnerId, config });
    }
    return { hasMore: isFullPage(rows) };
  },
});

/**
 * Move hash-minimized Composio operator audits only after both principals'
 * provider-create attempts have quiesced. Attempt ids are globally random and
 * are the immutable audit identity, so any destination collision fails closed
 * instead of coalescing evidence from two owners.
 */
export const migrateComposioSessionProvisioningResolutionsBatch =
  internalMutation({
    args: leasedOwnerArgs,
    returns: hasMoreReturn,
    handler: async (ctx: MutationCtx, args) => {
      const migration = await requireActiveOwnershipMigrationLease(ctx, args);
      const toOwnerGeneration = migration.toOwnerGeneration;
      if (!toOwnerGeneration) {
        blockOwnershipMigration(
          "Composio resolution migration is missing the destination owner generation.",
        );
      }
      const rows = await ctx.db
        .query("composio_session_provisioning_resolutions")
        .withIndex("by_ownerId_and_resolvedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(BATCH_SIZE);
      for (const row of rows) {
        const sameAttempt = await ctx.db
          .query("composio_session_provisioning_resolutions")
          .withIndex("by_attemptId", (q) => q.eq("attemptId", row.attemptId))
          .take(2);
        if (sameAttempt.some((candidate) => candidate._id !== row._id)) {
          blockOwnershipMigration(
            "Both identities contain a Composio operator audit with the same attempt id.",
          );
        }
        await ctx.db.patch(row._id, {
          ownerId: args.toOwnerId,
          ownerGeneration:
            toOwnerGeneration ??
            blockOwnershipMigration(
              "Composio resolution migration is missing the destination owner generation.",
            ),
        });
      }
      return { hasMore: isFullPage(rows) };
    },
  });

export const migrateUsageLogsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("usage_logs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateConnectorTurnPayloadsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateAgentsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("agents")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      const existing = await ctx.db
        .query("agents")
        .withIndex("by_ownerId_and_id", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("id", row.id),
        )
        .unique();
      if (existing) {
        blockOwnershipMigration(
          `Both identities contain an agent with id "${row.id}".`,
        );
      }
      await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaJobsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const toOwnerGeneration = migration.toOwnerGeneration!;
    const rows = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      if (
        !["succeeded", "failed", "canceled"].includes(row.status) ||
        (row.submissionState !== undefined &&
          !["submitted", "failed", "canceled"].includes(row.submissionState))
      ) {
        blockOwnershipMigration(
          "A media job or its private submission is still in flight. Finish or cancel it before retrying account linking.",
        );
      }
      const existing = row.clientRequestKey
        ? await ctx.db
            .query("media_jobs")
            .withIndex("by_ownerId_and_clientRequestKey", (q) =>
              q
                .eq("ownerId", args.toOwnerId)
                .eq("clientRequestKey", row.clientRequestKey),
            )
            .unique()
        : null;
      // Preserve both historical jobs, but keep only the destination row as
      // the canonical reattachment target when owner linking collides.
      await ctx.db.patch(row._id, {
        ownerId: args.toOwnerId,
        ownerGeneration: toOwnerGeneration,
        ...(existing
          ? { clientRequestKey: undefined, clientRequestHash: undefined }
          : {}),
      });
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaRequestCancellationsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const toOwnerGeneration = migration.toOwnerGeneration!;
    const rows = await ctx.db
      .query("media_request_cancellations")
      .withIndex("by_ownerId_and_clientRequestKey", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      const existing = await ctx.db
        .query("media_request_cancellations")
        .withIndex("by_ownerId_and_clientRequestKey", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("clientRequestKey", row.clientRequestKey),
        )
        .unique();
      if (existing) {
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: toOwnerGeneration,
        });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaJobLogsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const toOwnerGeneration = migration.toOwnerGeneration!;
    const rows = await ctx.db
      .query("media_job_logs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) =>
        ctx.db.patch(row._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: toOwnerGeneration,
        }),
      ),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserCountersBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

/**
 * Fashion is available to anonymous identities, so account linking must keep
 * its durable profile and shopping state. The staged order preserves checkout
 * references before cart rows move. Entity-key collisions merge the same
 * logical item instead of silently discarding either owner's quantity or
 * newest metadata.
 */
export const migrateFashionBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const checkout = (
      await ctx.db
        .query("fashion_checkout_sessions")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (checkout) {
      await ctx.db.patch(checkout._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const cart = (
      await ctx.db
        .query("fashion_cart_items")
        .withIndex("by_ownerId_and_addedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (cart) {
      const destination = await ctx.db
        .query("fashion_cart_items")
        .withIndex("by_ownerId_and_variantId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("variantId", cart.variantId),
        )
        .unique();
      if (destination) {
        await ctx.db.patch(destination._id, {
          quantity: destination.quantity + cart.quantity,
          addedAt: Math.min(destination.addedAt, cart.addedAt),
          ...(destination.checkoutSessionId
            ? {}
            : cart.checkoutSessionId
              ? { checkoutSessionId: cart.checkoutSessionId }
              : {}),
        });
        await ctx.db.delete(cart._id);
      } else {
        await ctx.db.patch(cart._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const like = (
      await ctx.db
        .query("fashion_likes")
        .withIndex("by_ownerId_and_likedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (like) {
      const destination = await ctx.db
        .query("fashion_likes")
        .withIndex("by_ownerId_and_variantId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("variantId", like.variantId),
        )
        .unique();
      if (destination) {
        if (like.likedAt > destination.likedAt) {
          await ctx.db.patch(destination._id, {
            productId: like.productId,
            title: like.title,
            imageUrl: like.imageUrl,
            productUrl: like.productUrl,
            merchantOrigin: like.merchantOrigin,
            priceCents: like.priceCents,
            currency: like.currency,
            vendor: like.vendor,
            likedAt: like.likedAt,
          });
        }
        await ctx.db.delete(like._id);
      } else {
        await ctx.db.patch(like._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const outfit = (
      await ctx.db
        .query("fashion_outfits")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (outfit) {
      await ctx.db.patch(outfit._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const profile = await ctx.db
      .query("fashion_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (profile) {
      const destination = await ctx.db
        .query("fashion_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) {
        const importedStyle =
          profile.stylePreferences &&
          profile.stylePreferences !== destination.stylePreferences
            ? [
                destination.stylePreferences,
                `Imported anonymous preferences: ${profile.stylePreferences}`,
              ]
                .filter(Boolean)
                .join("\n")
            : destination.stylePreferences;
        await ctx.db.patch(destination._id, {
          displayName: destination.displayName ?? profile.displayName,
          gender: destination.gender ?? profile.gender,
          sizes: { ...(profile.sizes ?? {}), ...(destination.sizes ?? {}) },
          stylePreferences: importedStyle,
          hasBodyPhoto: destination.hasBodyPhoto || profile.hasBodyPhoto,
          bodyPhotoMimeType:
            destination.bodyPhotoMimeType ?? profile.bodyPhotoMimeType,
          bodyPhotoUpdatedAt: Math.max(
            destination.bodyPhotoUpdatedAt ?? 0,
            profile.bodyPhotoUpdatedAt ?? 0,
          ),
          updatedAt: Math.max(destination.updatedAt, profile.updatedAt),
        });
        await ctx.db.delete(profile._id);
      } else {
        await ctx.db.patch(profile._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    return { hasMore: false };
  },
});

const MAX_EXTERNAL_MEDIA_OBJECTS_PER_SOURCE = 8;
type ExternalMediaSourceKind = "emoji_pack";

const migrateCommittedExternalMediaLocators = async (
  ctx: MutationCtx,
  args: OwnerIds & {
    sourceKind: ExternalMediaSourceKind;
    sourceId: string;
    toOwnerGeneration: string;
    now: number;
    requireLocator: boolean;
  },
): Promise<boolean> => {
  const sourceKey = `${args.sourceKind}:${args.sourceId}`;
  const rows = await ctx.db
    .query("account_external_media_objects")
    .withIndex("by_ownerId_and_sourceKey", (q) =>
      q.eq("ownerId", args.fromOwnerId).eq("sourceKey", sourceKey),
    )
    .take(MAX_EXTERNAL_MEDIA_OBJECTS_PER_SOURCE + 1);
  if (rows.length > MAX_EXTERNAL_MEDIA_OBJECTS_PER_SOURCE) {
    blockOwnershipMigration(
      "An external-media source has too many durable object locators.",
    );
  }
  if (args.requireLocator && rows.length === 0) {
    blockOwnershipMigration(
      "Owned media is missing its exact durable object inventory.",
    );
  }
  if (
    rows.some(
      (row) =>
        row.state !== "committed" ||
        row.sourceKind !== args.sourceKind ||
        row.sourceId !== args.sourceId ||
        row.sourceKey !== sourceKey,
    )
  ) {
    blockOwnershipMigration(
      "Owned media has an incomplete or inconsistent external object locator.",
    );
  }
  if (rows.some((row) => row.uploadExpiresAt > args.now)) {
    return false;
  }
  for (const row of rows) {
    const collisions = await ctx.db
      .query("account_external_media_objects")
      .withIndex("by_ownerId_and_r2Key", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("r2Key", row.r2Key),
      )
      .take(2);
    if (collisions.some((collision) => collision._id !== row._id)) {
      blockOwnershipMigration(
        "Both identities reference the same external media object through different inventories.",
      );
    }
    await ctx.db.patch(row._id, {
      ownerId: args.toOwnerId,
      ownerGeneration: args.toOwnerGeneration,
      updatedAt: Date.now(),
    });
  }
  return true;
};

/**
 * Emoji packs and their exact external-object locators move in one
 * transaction. Raw keys remain immutable; only deletion authority changes.
 */
export const migrateAccountExternalMediaContentBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const toOwnerGeneration = migration.toOwnerGeneration!;
    const pack = (
      await ctx.db
        .query("emoji_packs")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (pack) {
      const collision = await ctx.db
        .query("emoji_packs")
        .withIndex("by_ownerId_and_packId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("packId", pack.packId),
        )
        .unique();
      if (collision && collision._id !== pack._id) {
        blockOwnershipMigration(
          `Both identities own an emoji pack with id "${pack.packId}".`,
        );
      }
      const locatorsReady = await migrateCommittedExternalMediaLocators(ctx, {
        ...args,
        sourceKind: "emoji_pack",
        sourceId: String(pack._id),
        toOwnerGeneration,
        now: args.leaseNow,
        requireLocator: true,
      });
      if (!locatorsReady) return { hasMore: true };
      await ctx.db.patch(pack._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const orphan = (
      await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("state", "committed"),
        )
        .take(1)
    )[0];
    if (orphan) {
      if (orphan.uploadExpiresAt > args.leaseNow) {
        return { hasMore: true };
      }
      const collisions = await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_r2Key", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("r2Key", orphan.r2Key),
        )
        .take(2);
      if (collisions.some((collision) => collision._id !== orphan._id)) {
        blockOwnershipMigration(
          "An orphan external media locator collides at the destination.",
        );
      }
      await ctx.db.patch(orphan._id, {
        ownerId: args.toOwnerId,
        ownerGeneration: toOwnerGeneration,
        updatedAt: Date.now(),
      });
      return { hasMore: true };
    }
    const externalDeleted = (
      await ctx.db
        .query("account_external_media_objects")
        .withIndex("by_ownerId_and_state_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("state", "external_deleted"),
        )
        .take(1)
    )[0];
    if (externalDeleted) {
      blockOwnershipMigration(
        "External media deletion is incomplete and must reconcile before account linking.",
      );
    }
    return { hasMore: false };
  },
});

export const migrateXTokensBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const token = await ctx.db
      .query("x_oauth_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (!token) return { hasMore: false };
    const destination = await ctx.db
      .query("x_oauth_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .unique();
    if (destination && destination._id !== token._id) {
      blockOwnershipMigration(
        "Both identities have an X account connection. Disconnect one before retrying account linking.",
      );
    }
    await ctx.db.patch(token._id, {
      ownerId: args.toOwnerId,
      ownerGeneration: migration.toOwnerGeneration!,
    });
    return { hasMore: true };
  },
});

/**
 * Stripe operation receipts are replay authority, not disposable audit rows.
 * Move one quiescent source receipt at a time while preserving its exact
 * provider idempotency keys, so a lost response cannot turn account linking
 * into a second customer, Checkout session, or portal session.
 */
const isUnencumberedFreeBillingProfile = (
  profile: Doc<"billing_profiles">,
  allowedCustomerId: string,
): boolean =>
  profile.activePlan === "free" &&
  (profile.usageMode === undefined || profile.usageMode === "default") &&
  profile.subscriptionStatus === "none" &&
  (!profile.stripeCustomerId ||
    profile.stripeCustomerId === allowedCustomerId) &&
  !profile.stripeSubscriptionId &&
  !profile.stripePriceId &&
  !profile.defaultPaymentMethodId &&
  !profile.paymentMethodBrand &&
  !profile.paymentMethodLast4 &&
  profile.currentPeriodStart === 0 &&
  profile.currentPeriodEnd === 0 &&
  profile.cancelAtPeriodEnd === false;

const recoveredStripeCustomerPatch = (
  stripeCustomerId: string,
  now: number,
) => ({
  stripeCustomerId,
  stripeCustomerUpdatedAt: undefined,
  stripeCustomerEventId: undefined,
  stripeCustomerTerminal: false,
  stripeSubscriptionId: "",
  stripeSubscriptionUpdatedAt: undefined,
  stripeSubscriptionEventId: undefined,
  stripeSubscriptionTerminal: false,
  updatedAt: now,
});

const hasAnyStripeLateResultField = (
  operation: Doc<"billing_stripe_operations">,
): boolean =>
  operation.lateResultConflictStep !== undefined ||
  operation.lateResultConflictAttemptId !== undefined ||
  operation.lateResultRequestFingerprint !== undefined ||
  operation.lateResultIdempotencyKey !== undefined ||
  operation.lateResultProviderDeadlineAt !== undefined ||
  operation.lateResultReconcileClaimId !== undefined ||
  operation.lateResultStripeCustomerId !== undefined ||
  operation.lateResultStripeCheckoutSessionId !== undefined ||
  operation.lateResultStripePortalSessionId !== undefined ||
  operation.lateResultConflictAt !== undefined ||
  operation.lateResultConflictQuiescentAfterAt !== undefined;

const stripeMetadataTransferShape = (
  operation: Doc<"billing_stripe_operations">,
): "clean" | "active" | "malformed" => {
  const hasTarget =
    operation.stripeCustomerMetadataTransferToOwnerId !== undefined;
  const hasAttempt =
    operation.stripeCustomerMetadataTransferAttemptId !== undefined;
  const hasKey =
    operation.stripeCustomerMetadataTransferIdempotencyKey !== undefined;
  const hasDeadline =
    operation.stripeCustomerMetadataTransferProviderDeadlineAt !== undefined;
  const hasQuiescence =
    operation.stripeCustomerMetadataTransferQuiescentAfterAt !== undefined;
  const hasDebt =
    operation.stripeCustomerMetadataTransferDebtReason !== undefined;
  const hasAnyTupleField =
    hasTarget ||
    hasAttempt ||
    hasKey ||
    hasDeadline ||
    hasQuiescence ||
    hasDebt;
  if (operation.stripeCustomerMetadataTransferState === "may_have_dispatched") {
    return hasTarget && hasAttempt && hasKey && hasDeadline && hasQuiescence
      ? "active"
      : "malformed";
  }
  if (
    operation.stripeCustomerMetadataTransferState === "idle" ||
    operation.stripeCustomerMetadataTransferState === undefined
  ) {
    return hasAnyTupleField ? "malformed" : "clean";
  }
  return "malformed";
};

const ensureStripeOperationPhysicalHistory = async (
  ctx: MutationCtx,
  operation: Doc<"billing_stripe_operations">,
  now: number,
) => {
  const historicalResultShape = stripeHistoricalResultShape(operation);
  if (historicalResultShape === "malformed") {
    blockOwnershipMigration(
      "A Stripe operation contains malformed physical receipt history.",
    );
  }
  if (historicalResultShape === "clean") return;
  const tupleHash = await hashStripeDeletedOperationTuple({
    operationId: operation.operationId,
    attemptId: operation.lastStripeAttemptId!,
    step: operation.lastStripeStep!,
    requestFingerprint: operation.lastStripeRequestFingerprint!,
    idempotencyKey: operation.lastStripeIdempotencyKey!,
    providerDeadlineAt: operation.lastStripeProviderDeadlineAt!,
  });
  const rows = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
    .take(2);
  if (
    rows.length > 1 ||
    (rows[0] && rows[0].operationId !== operation.operationId)
  ) {
    blockOwnershipMigration(
      "A Stripe physical receipt is duplicated or belongs to another operation.",
    );
  }
  if (!rows[0]) {
    if (
      hasCurrentStripeOperationIntegrity(operation) ||
      !hasLegacyStripeOperationIntegrityVersion(operation) ||
      !hasValidStripeOperationStateLocators(operation) ||
      !hasCleanLegacyStripeOperationTransport(operation)
    ) {
      blockOwnershipMigration(
        "A Stripe physical receipt is missing and cannot be inferred from current operation state.",
      );
    }
    if (
      !(await hasStripePhysicalReceiptCapacityForInsert(
        ctx,
        operation.operationId,
      ))
    ) {
      blockOwnershipMigration(
        "A Stripe operation exceeds the physical receipt safety bound.",
      );
    }
    await ctx.db.insert("billing_stripe_physical_receipts", {
      operationId: operation.operationId,
      tupleHash,
      createdAt: now,
    });
  }
};

/**
 * Retained-resource audits are owner-scoped deletion fences. They therefore
 * move with their authoritative operation in the same transaction as the
 * operation owner, including the set hash that commits every marker's owner
 * scope. Preflight passes omit `toOwnerId` and only validate the source proof.
 */
const assertOrMoveAttachedStripeRetentionProof = async (
  ctx: MutationCtx,
  operation: Doc<"billing_stripe_operations">,
  args: {
    fromOwnerId: string;
    toOwnerId?: string;
    now: number;
  },
) => {
  const receipts = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_operationId", (q) =>
      q.eq("operationId", operation.operationId),
    )
    .take(257);
  if (receipts.length > 256) {
    blockOwnershipMigration(
      "A Stripe operation exceeds the retained-proof migration safety bound.",
    );
  }
  const sourceOwnerHash = await ownershipMigrationSourceDigest(
    args.fromOwnerId,
  );
  const destinationOwnerHash = args.toOwnerId
    ? await ownershipMigrationSourceDigest(args.toOwnerId)
    : undefined;
  for (const receipt of receipts) {
    if (receipt.cleanupResolutionId === undefined) continue;
    const resolutionId = receipt.cleanupResolutionId.trim();
    if (!resolutionId || receipt.deletionCleanupTerminalized === true) {
      blockOwnershipMigration(
        "A Stripe retained-resource receipt is malformed.",
      );
    }
    const [resolutions, retainedLocators] = await Promise.all([
      ctx.db
        .query("billing_stripe_late_cleanup_resolutions")
        .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
        .take(2),
      ctx.db
        .query("billing_stripe_retained_locators")
        .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
        .take(3),
    ]);
    if (
      resolutions.length !== 1 ||
      retainedLocators.length === 0 ||
      retainedLocators.length > 2 ||
      retainedLocators.some((row) => row.ownerHash !== sourceOwnerHash) ||
      !(
        await Promise.all(
          retainedLocators.map(
            async (row) => await hasValidStripeRetainedLocatorProof(ctx, row),
          ),
        )
      ).every(Boolean)
    ) {
      blockOwnershipMigration(
        "A Stripe retained-resource audit is missing or changed.",
      );
    }
    if (!destinationOwnerHash) continue;
    for (const row of retainedLocators) {
      const [destinationCleanupRows, destinationDeletionRows] =
        await Promise.all([
          ctx.db
            .query("billing_stripe_late_cleanup_locators")
            .withIndex("by_ownerHash_and_locatorHash", (q) =>
              q
                .eq("ownerHash", destinationOwnerHash)
                .eq("locatorHash", row.locatorHash),
            )
            .take(3),
          ctx.db
            .query("billing_owner_deletion_locators")
            .withIndex("by_ownerId_and_locatorHash", (q) =>
              q
                .eq("ownerId", args.toOwnerId!)
                .eq("locatorHash", row.locatorHash),
            )
            .take(3),
        ]);
      if (
        destinationCleanupRows.some(
          (candidate) => candidate.cleanupClaimId !== undefined,
        ) ||
        destinationDeletionRows.some(
          (candidate) => candidate.providerClaimId !== undefined,
        )
      ) {
        throw new ConvexError({
          code: "STRIPE_OPERATION_NOT_QUIESCENT",
          message:
            "A destination Stripe deletion claim still owns provider authority.",
        });
      }
    }
    const movedLocators = retainedLocators.map((row) => ({
      locatorKind: row.locatorKind,
      locatorHash: row.locatorHash,
      ownerHash: destinationOwnerHash,
    }));
    const sourceLocatorSetHash =
      await hashStripeRetainedLocatorSet(retainedLocators);
    const locatorSetHash = await hashStripeRetainedLocatorSet(movedLocators);
    const systemResolutionId = `retained-fence-${receipt.tupleHash}`;
    let movedSystemEvidenceHash: string | undefined;
    if (resolutionId === systemResolutionId) {
      const [expectedSystemResolverHash, expectedSystemEvidenceHash] =
        await Promise.all([
          stripeResolutionAuditHash(
            "operator",
            "system-retained-locator-fence",
          ),
          stripeResolutionAuditHash(
            "evidence",
            `inherited-locator-set:${sourceLocatorSetHash}`,
          ),
        ]);
      if (
        resolutions[0]!.resolvedByHash !== expectedSystemResolverHash ||
        resolutions[0]!.evidenceHash !== expectedSystemEvidenceHash
      ) {
        blockOwnershipMigration(
          "A system-derived Stripe retained-resource audit is missing or changed.",
        );
      }
      movedSystemEvidenceHash = await stripeResolutionAuditHash(
        "evidence",
        `inherited-locator-set:${locatorSetHash}`,
      );
    }
    for (const row of retainedLocators) {
      await ctx.db.patch(row._id, {
        ownerHash: destinationOwnerHash,
      });
    }
    await ctx.db.patch(resolutions[0]!._id, {
      locatorSetHash,
      ...(movedSystemEvidenceHash
        ? { evidenceHash: movedSystemEvidenceHash }
        : {}),
    });
  }
};

/**
 * A late callback may publish deletion debt after metadata has moved at Stripe
 * but before the local migration commit. Preparation waits for pre-existing
 * debt. The commit path instead revalidates unclaimed rows under the source
 * operation and moves their cleanup-owner scope atomically with that
 * operation, while preserving the immutable first-provider owner hash.
 */
const assertOrMoveAttachedStripePendingCleanup = async (
  ctx: MutationCtx,
  operation: Doc<"billing_stripe_operations">,
  args: {
    fromOwnerId: string;
    toOwnerId?: string;
    now: number;
  },
) => {
  const receipts = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_operationId", (q) =>
      q.eq("operationId", operation.operationId),
    )
    .take(257);
  if (receipts.length > 256) {
    blockOwnershipMigration(
      "A Stripe operation exceeds the cleanup migration safety bound.",
    );
  }
  const sourceOwnerHash = await ownershipMigrationSourceDigest(
    args.fromOwnerId,
  );
  const destinationOwnerHash = args.toOwnerId
    ? await ownershipMigrationSourceDigest(args.toOwnerId)
    : undefined;
  for (const receipt of receipts) {
    const cleanupRows = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", receipt.tupleHash))
      .take(3);
    if (cleanupRows.length === 0) continue;
    if (!destinationOwnerHash) {
      throw new ConvexError({
        code: "STRIPE_OPERATION_NOT_QUIESCENT",
        message: "A Stripe operation still owns pending cleanup authority.",
      });
    }
    if (
      cleanupRows.length > 2 ||
      cleanupRows.some(
        (row) =>
          row.ownerHash !== sourceOwnerHash || row.cleanupClaimId !== undefined,
      ) ||
      !(
        await Promise.all(
          cleanupRows.map(
            async (row) => await hasValidLateStripeCleanupRowProof(ctx, row),
          ),
        )
      ).every(Boolean)
    ) {
      throw new ConvexError({
        code: "STRIPE_OPERATION_NOT_QUIESCENT",
        message:
          "A Stripe cleanup claim or malformed cleanup row still owns provider authority.",
      });
    }
    for (const row of cleanupRows) {
      await ctx.db.patch(row._id, {
        ownerHash: destinationOwnerHash,
        updatedAt: args.now,
      });
    }
  }
};

const assertStripeMetadataTransferPreflight = async (
  ctx: MutationCtx,
  args: OwnershipLease,
  operation: Doc<"billing_stripe_operations">,
  moveCleanupToOwnerId?: string,
) => {
  await ensureStripeOperationPhysicalHistory(ctx, operation, args.leaseNow);
  await assertOrMoveAttachedStripeRetentionProof(ctx, operation, {
    fromOwnerId: args.fromOwnerId,
    now: args.leaseNow,
  });
  await assertOrMoveAttachedStripePendingCleanup(ctx, operation, {
    fromOwnerId: args.fromOwnerId,
    ...(moveCleanupToOwnerId ? { toOwnerId: moveCleanupToOwnerId } : {}),
    now: args.leaseNow,
  });
  if (
    !(await ensureLegacyStripeOperationPhysicalReceiptProvenance(
      ctx,
      operation,
    ))
  ) {
    blockOwnershipMigration(
      "A Stripe operation contains unproven physical receipt authority.",
    );
  }
  if (!(await hasExactStripeOperationResolutionProofSet(ctx, operation))) {
    blockOwnershipMigration(
      "A Stripe operation contains stale or conflicting resolution authority.",
    );
  }
  const pendingLateResult = await ctx.db
    .query("billing_stripe_late_results")
    .withIndex("by_operationId_and_createdAt", (q) =>
      q.eq("operationId", operation.operationId),
    )
    .first();
  if (pendingLateResult) {
    throw new ConvexError({
      code: "STRIPE_OPERATION_NOT_QUIESCENT",
      message: "A Stripe operation still has an unresolved physical result.",
    });
  }
  const metadataTransferShape = stripeMetadataTransferShape(operation);
  if (metadataTransferShape === "malformed") {
    blockOwnershipMigration(
      "A Stripe customer metadata transfer receipt is malformed.",
    );
  }
  if (operation.stripeCustomerMetadataTransferDebtReason !== undefined) {
    blockOwnershipMigration(
      "A Stripe customer metadata transfer requires audited operator resolution.",
    );
  }
  if (
    metadataTransferShape === "active" &&
    !(await hasValidatedStripeMetadataTransferAuthority(ctx, operation))
  ) {
    blockOwnershipMigration(
      "A Stripe customer metadata transfer lacks current physical authority.",
    );
  }
  if (!hasValidStripeOperationStateLocators(operation)) {
    blockOwnershipMigration(
      "A Stripe operation contains invalid provider-result locators.",
    );
  }
  if (
    operation.terminalizedByManualResolutionId !== undefined &&
    !(await hasMatchingStripeManualResolutionProof(ctx, operation))
  ) {
    blockOwnershipMigration(
      "A Stripe manual-resolution audit is missing or changed.",
    );
  }
  if (!hasCurrentStripeOperationIntegrity(operation)) {
    if (
      !hasLegacyStripeOperationIntegrityVersion(operation) ||
      metadataTransferShape !== "clean" ||
      !hasCleanLegacyStripeOperationTransport(operation)
    ) {
      blockOwnershipMigration(
        "A Stripe operation requires lifecycle integrity reconciliation before migration.",
      );
    }
    await ctx.db.patch(operation._id, {
      dispatchState: "idle",
      integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
      lifecycleIntegrityVersion: undefined,
      updatedAt: args.leaseNow,
    });
  }
  if (
    operation.dispatchState === "may_have_dispatched" ||
    operation.activeStep !== undefined ||
    operation.activeAttemptId !== undefined ||
    operation.activeRequestJson !== undefined ||
    operation.activeRequestFingerprint !== undefined ||
    operation.activeIdempotencyKey !== undefined ||
    operation.providerDeadlineAt !== undefined ||
    operation.quiescentAfterAt !== undefined ||
    operation.nextReconcileAt !== undefined ||
    operation.reconcileClaimId !== undefined ||
    operation.reconcileClaimExpiresAt !== undefined ||
    operation.manualDebtReason !== undefined ||
    hasAnyStripeLateResultField(operation) ||
    (operation.dispatchState === undefined &&
      (operation.state === "reserved" ||
        operation.leaseExpiresAt > args.leaseNow))
  ) {
    throw new ConvexError({
      code: "STRIPE_OPERATION_NOT_QUIESCENT",
      message: "A Stripe operation still owns provider replay authority.",
    });
  }

  const requestKey = operation.requestKey?.trim();
  if (
    operation.requestKey !== undefined &&
    !/^[a-f0-9]{64}$/u.test(requestKey ?? "")
  ) {
    blockOwnershipMigration(
      "A Stripe operation contains a malformed logical request key.",
    );
  }
  const collisions = requestKey
    ? await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_kind_and_requestKey", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("kind", operation.kind)
            .eq("requestKey", requestKey),
        )
        .take(2)
    : await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_kind_and_requestFingerprint", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("kind", operation.kind)
            .eq("requestFingerprint", operation.requestFingerprint),
        )
        .take(2);
  if (collisions.length > 0) {
    blockOwnershipMigration(
      "Both identities contain a Stripe operation for the same logical billing request.",
    );
  }

  const [sourceProfile, destinationProfile] = await Promise.all([
    ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique(),
    ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .unique(),
  ]);
  const sourceProfileCustomerId = sourceProfile?.stripeCustomerId?.trim() ?? "";
  const destinationProfileCustomerId =
    destinationProfile?.stripeCustomerId?.trim() ?? "";
  if (
    sourceProfile &&
    (operation.stripeCustomerAuthorityEpoch ?? 0) !==
      (sourceProfile.stripeCustomerAuthorityEpoch ?? 0)
  ) {
    blockOwnershipMigration(
      "A Stripe operation belongs to a rotated source customer authority.",
    );
  }
  if (
    sourceProfileCustomerId &&
    destinationProfileCustomerId &&
    sourceProfileCustomerId !== destinationProfileCustomerId
  ) {
    blockOwnershipMigration(
      "The Stripe customers on the two identities conflict.",
    );
  }
  let recoveredCustomerId = operation.stripeCustomerId?.trim() ?? "";
  if (!recoveredCustomerId && sourceProfileCustomerId) {
    // Older abandoned logical receipts can predate the request that linked the
    // source profile's live customer. Bind the effective customer before
    // choosing a migration path so its remote owner metadata is transferred
    // and read back; a local-only move would strand the receipt customerless.
    recoveredCustomerId = sourceProfileCustomerId;
    await ctx.db.patch(operation._id, {
      stripeCustomerId: recoveredCustomerId,
      stripeCustomerMetadataOwnerId: args.fromOwnerId,
      updatedAt: args.leaseNow,
    });
  }
  if (!recoveredCustomerId) {
    if (metadataTransferShape !== "clean") {
      blockOwnershipMigration(
        "A customerless Stripe operation contains provider-transfer authority.",
      );
    }
    return {
      recoveredCustomerId,
      sourceProfile,
      destinationProfile,
    };
  }
  const locatorHash = await hashStripeBillingLocator(
    "customer",
    recoveredCustomerId,
  );
  const [linkedProfiles, tombstone] = await Promise.all([
    ctx.db
      .query("billing_profiles")
      .withIndex("by_stripeCustomerId", (q) =>
        q.eq("stripeCustomerId", recoveredCustomerId),
      )
      .take(3),
    ctx.db
      .query("billing_stripe_deletion_tombstones")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
      .unique(),
  ]);
  if (tombstone) {
    blockOwnershipMigration(
      "The recovered Stripe customer was deleted and cannot be transferred.",
    );
  }
  if (
    (sourceProfile?.stripeCustomerId === recoveredCustomerId &&
      sourceProfile.stripeCustomerTerminal) ||
    (destinationProfile?.stripeCustomerId === recoveredCustomerId &&
      destinationProfile.stripeCustomerTerminal)
  ) {
    blockOwnershipMigration(
      "The recovered Stripe customer authority is terminal.",
    );
  }
  if (
    linkedProfiles.some(
      (profile) =>
        profile.ownerId !== args.fromOwnerId &&
        profile.ownerId !== args.toOwnerId,
    )
  ) {
    blockOwnershipMigration(
      "The recovered Stripe customer is linked to another account.",
    );
  }
  if (
    sourceProfile &&
    !isUnencumberedFreeBillingProfile(sourceProfile, recoveredCustomerId)
  ) {
    blockOwnershipMigration(
      "The anonymous identity contains paid billing state that cannot be linked automatically.",
    );
  }
  if (
    destinationProfile?.stripeCustomerId &&
    destinationProfile.stripeCustomerId !== recoveredCustomerId
  ) {
    blockOwnershipMigration(
      "The Stripe operation customer conflicts with the connected account.",
    );
  }
  if (
    destinationProfile &&
    !destinationProfile.stripeCustomerId &&
    !isUnencumberedFreeBillingProfile(destinationProfile, recoveredCustomerId)
  ) {
    blockOwnershipMigration(
      "The connected identity contains incompatible billing state.",
    );
  }
  return { recoveredCustomerId, sourceProfile, destinationProfile };
};

const moveAttachedStripeResolutionProofs = async (
  ctx: MutationCtx,
  operation: Doc<"billing_stripe_operations">,
  args: {
    fromOwnerId: string;
    fromOwnerGeneration: string;
    toOwnerId: string;
    toOwnerGeneration: string;
  },
) => {
  if (!(await moveStripeOperationResolutionProofs(ctx, operation, args))) {
    blockOwnershipMigration(
      "A Stripe operation contains missing, stale, or conflicting resolution audits.",
    );
  }
};

const moveStripeOperationAfterMetadataReadback = async (
  ctx: MutationCtx,
  args: OwnershipLease,
  migration: Doc<"auth_owner_migrations">,
  operation: Doc<"billing_stripe_operations">,
  preflight: Awaited<ReturnType<typeof assertStripeMetadataTransferPreflight>>,
) => {
  const { recoveredCustomerId, sourceProfile, destinationProfile } = preflight;
  const currentDestinationProfile =
    destinationProfile ??
    (await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .unique());
  const destinationCustomerAuthorityEpoch =
    currentDestinationProfile?.stripeCustomerAuthorityEpoch ??
    sourceProfile?.stripeCustomerAuthorityEpoch ??
    0;
  const destinationCustomerCreateIdempotencyKey = currentDestinationProfile
    ? await resolvePinnedStripeCustomerAuthorityKey(ctx, {
        profile: currentDestinationProfile,
        ownerId: args.toOwnerId,
        authorityEpoch: destinationCustomerAuthorityEpoch,
        now: args.leaseNow,
      })
    : await stripeCustomerAuthorityIdempotencyKey(
        args.toOwnerId,
        destinationCustomerAuthorityEpoch,
      );
  if (recoveredCustomerId) {
    if (destinationProfile) {
      if (destinationProfile.stripeCustomerId !== recoveredCustomerId) {
        await ctx.db.patch(
          destinationProfile._id,
          recoveredStripeCustomerPatch(recoveredCustomerId, args.leaseNow),
        );
      }
      if (sourceProfile?.stripeCustomerId === recoveredCustomerId) {
        await ctx.db.patch(sourceProfile._id, {
          ...recoveredStripeCustomerPatch("", args.leaseNow),
          stripeCustomerTerminal: false,
        });
      }
    } else if (sourceProfile) {
      await ctx.db.patch(sourceProfile._id, {
        ownerId: args.toOwnerId,
        ...recoveredStripeCustomerPatch(recoveredCustomerId, args.leaseNow),
        stripeCustomerCreateIdempotencyKey:
          destinationCustomerCreateIdempotencyKey,
      });
    } else {
      blockOwnershipMigration(
        "The recovered Stripe customer has no billing profile to adopt it.",
      );
    }
  }

  const sourceOwnerHash = await ownershipMigrationSourceDigest(
    args.fromOwnerId,
  );
  const destinationOwnerHash = await ownershipMigrationSourceDigest(
    args.toOwnerId,
  );
  const inheritedAliases = await ctx.db
    .query("billing_stripe_owner_aliases")
    .withIndex("by_destinationOwnerHash", (q) =>
      q.eq("destinationOwnerHash", sourceOwnerHash),
    )
    .take(65);
  if (inheritedAliases.length > 64) {
    blockOwnershipMigration(
      "Stripe event ownership alias history exceeds the safe migration bound.",
    );
  }
  const inheritedSourceCounts = new Map<string, number>();
  for (const alias of inheritedAliases) {
    inheritedSourceCounts.set(
      alias.sourceOwnerHash,
      (inheritedSourceCounts.get(alias.sourceOwnerHash) ?? 0) + 1,
    );
  }
  if ([...inheritedSourceCounts.values()].some((count) => count !== 1)) {
    blockOwnershipMigration(
      "Duplicate Stripe event ownership aliases require operator repair.",
    );
  }
  const aliasSourceHashes = new Set([
    sourceOwnerHash,
    ...inheritedAliases.map((alias) => alias.sourceOwnerHash),
  ]);
  for (const aliasSourceHash of aliasSourceHashes) {
    if (aliasSourceHash === destinationOwnerHash) {
      blockOwnershipMigration(
        "Cyclic Stripe event ownership aliases require operator repair.",
      );
    }
    const aliases = await ctx.db
      .query("billing_stripe_owner_aliases")
      .withIndex("by_sourceOwnerHash_and_destinationOwnerHash", (q) =>
        q
          .eq("sourceOwnerHash", aliasSourceHash)
          .eq("destinationOwnerHash", destinationOwnerHash),
      )
      .take(2);
    if (aliases.length > 1) {
      blockOwnershipMigration(
        "Duplicate Stripe event ownership aliases require operator repair.",
      );
    }
    if (aliases.length === 0) {
      await ctx.db.insert("billing_stripe_owner_aliases", {
        sourceOwnerHash: aliasSourceHash,
        destinationOwnerHash,
        createdAt: args.leaseNow,
      });
    }
  }
  await assertOrMoveAttachedStripeRetentionProof(ctx, operation, {
    fromOwnerId: args.fromOwnerId,
    toOwnerId: args.toOwnerId,
    now: args.leaseNow,
  });
  await moveAttachedStripeResolutionProofs(ctx, operation, {
    fromOwnerId: args.fromOwnerId,
    fromOwnerGeneration: migration.fromOwnerGeneration!,
    toOwnerId: args.toOwnerId,
    toOwnerGeneration: migration.toOwnerGeneration!,
  });
  await ctx.db.patch(operation._id, {
    ownerId: args.toOwnerId,
    ownerGeneration: migration.toOwnerGeneration!,
    stripeCustomerAuthorityEpoch: destinationCustomerAuthorityEpoch,
    stripeCustomerCreateIdempotencyKey: destinationCustomerCreateIdempotencyKey,
    stripeCustomerMetadataOwnerId: recoveredCustomerId
      ? args.toOwnerId
      : operation.stripeCustomerMetadataOwnerId,
    stripeCustomerMetadataTransferState: recoveredCustomerId
      ? "idle"
      : operation.stripeCustomerMetadataTransferState,
    stripeCustomerMetadataTransferToOwnerId: undefined,
    stripeCustomerMetadataTransferAttemptId: undefined,
    stripeCustomerMetadataTransferIdempotencyKey: undefined,
    stripeCustomerMetadataTransferProviderDeadlineAt: undefined,
    stripeCustomerMetadataTransferQuiescentAfterAt: undefined,
    stripeCustomerMetadataTransferDebtReason: undefined,
    lifecycleIntegrityVersion: undefined,
    updatedAt: args.leaseNow,
  });
};

const stripeMetadataTransferCommandValidator = v.object({
  kind: v.literal("provider_transfer"),
  operationId: v.string(),
  stripeCustomerId: v.string(),
  attemptId: v.string(),
  idempotencyKey: v.string(),
  providerDeadlineAt: v.number(),
});

export const hasActiveStripeCustomerMetadataTransferInternal = internalMutation(
  {
    args: leasedOwnerArgs,
    returns: v.boolean(),
    handler: async (ctx, args) => {
      await requireActiveOwnershipMigrationLease(ctx, args);
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_metadataTransferState_and_createdAt", (q) =>
          q
            .eq("ownerId", args.fromOwnerId)
            .eq("stripeCustomerMetadataTransferState", "may_have_dispatched"),
        )
        .first();
      return Boolean(
        operation &&
          operation.stripeCustomerMetadataTransferToOwnerId === args.toOwnerId,
      );
    },
  },
);

export const prepareStripeCustomerMetadataTransferInternal = internalMutation({
  args: leasedOwnerArgs,
  returns: v.union(
    v.null(),
    v.object({ kind: v.literal("local_only") }),
    v.object({ kind: v.literal("wait"), retryAt: v.number() }),
    stripeMetadataTransferCommandValidator,
  ),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const operation = (
      await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (!operation) return null;
    if (operation.ownerGeneration !== migration.fromOwnerGeneration) {
      blockOwnershipMigration(
        "A Stripe operation belongs to a stale source owner generation.",
      );
    }
    const preflight = await assertStripeMetadataTransferPreflight(
      ctx,
      args,
      operation,
    );
    if (!preflight.recoveredCustomerId) return { kind: "local_only" as const };
    if (
      operation.stripeCustomerMetadataTransferState === "may_have_dispatched" &&
      operation.stripeCustomerMetadataTransferToOwnerId !== args.toOwnerId
    ) {
      blockOwnershipMigration(
        "Stripe customer metadata transfer targets a different owner.",
      );
    }
    const currentQuiescentAfterAt =
      operation.stripeCustomerMetadataTransferQuiescentAfterAt;
    if (
      operation.stripeCustomerMetadataTransferState === "may_have_dispatched" &&
      currentQuiescentAfterAt !== undefined &&
      args.leaseNow < currentQuiescentAfterAt
    ) {
      return { kind: "wait" as const, retryAt: currentQuiescentAfterAt };
    }
    const authorityHash = await hashSha256Hex(
      `stella-stripe-owner-transfer-v1\u0000${preflight.recoveredCustomerId}\u0000${operation.ownerGeneration}\u0000${migration.toOwnerGeneration ?? ""}`,
    );
    const idempotencyKey = `stella-stripe-owner-transfer-v1-${authorityHash}`;
    const attemptId = crypto.randomUUID();
    const providerDeadlineAt =
      args.leaseNow + STRIPE_METADATA_TRANSFER_TIMEOUT_MS;
    await ctx.db.patch(operation._id, {
      stripeCustomerMetadataTransferState: "may_have_dispatched",
      stripeCustomerMetadataTransferToOwnerId: args.toOwnerId,
      stripeCustomerMetadataTransferAttemptId: attemptId,
      stripeCustomerMetadataTransferIdempotencyKey: idempotencyKey,
      stripeCustomerMetadataTransferProviderDeadlineAt: providerDeadlineAt,
      stripeCustomerMetadataTransferQuiescentAfterAt:
        providerDeadlineAt + STRIPE_METADATA_TRANSFER_GRACE_MS,
      updatedAt: args.leaseNow,
    });
    return {
      kind: "provider_transfer" as const,
      operationId: operation.operationId,
      stripeCustomerId: preflight.recoveredCustomerId,
      attemptId,
      idempotencyKey,
      providerDeadlineAt,
    };
  },
});

export const revalidateStripeCustomerMetadataTransferInternal =
  internalMutation({
    args: {
      ...leasedOwnerArgs,
      operationId: v.string(),
      stripeCustomerId: v.string(),
      attemptId: v.string(),
      idempotencyKey: v.string(),
      providerDeadlineAt: v.number(),
    },
    returns: v.union(v.null(), v.object({ providerDeadlineAt: v.number() })),
    handler: async (ctx, args) => {
      const migration = await requireActiveOwnershipMigrationLease(ctx, args);
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", args.operationId),
        )
        .unique();
      if (
        !operation ||
        operation.ownerId !== args.fromOwnerId ||
        operation.ownerGeneration !== migration.fromOwnerGeneration ||
        operation.stripeCustomerId !== args.stripeCustomerId ||
        operation.stripeCustomerMetadataTransferState !==
          "may_have_dispatched" ||
        operation.stripeCustomerMetadataTransferToOwnerId !== args.toOwnerId ||
        operation.stripeCustomerMetadataTransferAttemptId !== args.attemptId ||
        operation.stripeCustomerMetadataTransferIdempotencyKey !==
          args.idempotencyKey ||
        operation.stripeCustomerMetadataTransferProviderDeadlineAt !==
          args.providerDeadlineAt ||
        operation.stripeCustomerMetadataTransferDebtReason !== undefined ||
        args.leaseNow >= args.providerDeadlineAt ||
        !(await hasValidatedStripeMetadataTransferAuthority(ctx, operation)) ||
        !(await hasExactStripeOperationResolutionProofSet(ctx, operation))
      ) {
        return null;
      }
      const preflight = await assertStripeMetadataTransferPreflight(
        ctx,
        args,
        operation,
      );
      if (preflight.recoveredCustomerId !== args.stripeCustomerId) {
        return null;
      }
      return { providerDeadlineAt: args.providerDeadlineAt };
    },
  });

export const recordActiveStripeCustomerMetadataTransferDebtInternal =
  internalMutation({
    args: {
      ...leasedOwnerArgs,
      operationId: v.string(),
      stripeCustomerId: v.string(),
      attemptId: v.string(),
      idempotencyKey: v.string(),
      providerDeadlineAt: v.number(),
      reason: v.union(
        v.literal("customer_deleted"),
        v.literal("foreign_owner"),
      ),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
      const migration = await requireActiveOwnershipMigrationLease(ctx, args);
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", args.operationId),
        )
        .unique();
      if (
        !operation ||
        operation.ownerId !== args.fromOwnerId ||
        operation.ownerGeneration !== migration.fromOwnerGeneration ||
        operation.stripeCustomerId !== args.stripeCustomerId ||
        operation.stripeCustomerMetadataTransferState !==
          "may_have_dispatched" ||
        operation.stripeCustomerMetadataTransferToOwnerId !== args.toOwnerId ||
        operation.stripeCustomerMetadataTransferAttemptId !== args.attemptId ||
        operation.stripeCustomerMetadataTransferIdempotencyKey !==
          args.idempotencyKey ||
        operation.stripeCustomerMetadataTransferProviderDeadlineAt !==
          args.providerDeadlineAt ||
        !(await hasValidatedStripeMetadataTransferAuthority(ctx, operation))
      ) {
        return false;
      }
      if (
        operation.stripeCustomerMetadataTransferDebtReason !== undefined &&
        operation.stripeCustomerMetadataTransferDebtReason !== args.reason
      ) {
        return false;
      }
      await ctx.db.patch(operation._id, {
        stripeCustomerMetadataTransferDebtReason: args.reason,
        updatedAt: args.leaseNow,
      });
      // Persist the provider terminal outcome and retire the migration lease in
      // the same transaction. If the action loses its response immediately
      // after this commit, no live migration can keep retrying a tuple that now
      // requires operator resolution.
      if (migration.watchdogId) {
        try {
          await ctx.scheduler.cancel(migration.watchdogId);
        } catch {
          // Completed/current scheduler jobs are already harmless once the
          // migration status below becomes terminal.
        }
      }
      await ctx.db.patch(migration._id, {
        status: "failed",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        watchdogId: undefined,
        lastError:
          "Stripe customer metadata ownership requires audited operator resolution.",
        updatedAt: args.leaseNow,
      });
      return true;
    },
  });

export const commitStripeCustomerMetadataTransferInternal = internalMutation({
  args: {
    ...leasedOwnerArgs,
    operationId: v.string(),
    stripeCustomerId: v.string(),
    attemptId: v.string(),
    idempotencyKey: v.string(),
    providerDeadlineAt: v.number(),
    providerOwnerId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const operation = await ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_operationId", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (
      !operation ||
      operation.ownerId !== args.fromOwnerId ||
      operation.ownerGeneration !== migration.fromOwnerGeneration ||
      operation.stripeCustomerId !== args.stripeCustomerId ||
      operation.stripeCustomerMetadataTransferState !== "may_have_dispatched" ||
      operation.stripeCustomerMetadataTransferToOwnerId !== args.toOwnerId ||
      operation.stripeCustomerMetadataTransferAttemptId !== args.attemptId ||
      operation.stripeCustomerMetadataTransferIdempotencyKey !==
        args.idempotencyKey ||
      operation.stripeCustomerMetadataTransferProviderDeadlineAt !==
        args.providerDeadlineAt ||
      operation.stripeCustomerMetadataTransferDebtReason !== undefined ||
      args.providerOwnerId !== args.toOwnerId
    ) {
      return false;
    }
    const preflight = await assertStripeMetadataTransferPreflight(
      ctx,
      args,
      operation,
      args.toOwnerId,
    );
    if (preflight.recoveredCustomerId !== args.stripeCustomerId) return false;
    await moveStripeOperationAfterMetadataReadback(
      ctx,
      args,
      migration,
      operation,
      preflight,
    );
    return true;
  },
});

const getStripeMetadataTransferClient = (providerDeadlineAt: number) => {
  const remaining = Math.floor(providerDeadlineAt - Date.now());
  if (remaining <= 0) {
    throw new ConvexError({
      code: "STRIPE_OPERATION_CONFLICT",
      message: "Stripe metadata-transfer authority expired.",
    });
  }
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("Stripe is not configured.");
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
    timeout: Math.min(STRIPE_METADATA_TRANSFER_TIMEOUT_MS, remaining),
  });
};

type StripeMetadataTransferCommand = {
  kind: "provider_transfer";
  operationId: string;
  stripeCustomerId: string;
  attemptId: string;
  idempotencyKey: string;
  providerDeadlineAt: number;
};

const prepareStripeCustomerMetadataTransferRef = makeFunctionReference<
  "mutation",
  typeof leasedOwnerArgs extends infer _Unused
    ? {
        fromOwnerId: string;
        toOwnerId: string;
        leaseId: string;
        leaseGeneration: number;
        leaseNow: number;
      }
    : never,
  | null
  | { kind: "local_only" }
  | { kind: "wait"; retryAt: number }
  | StripeMetadataTransferCommand
>("auth_migration:prepareStripeCustomerMetadataTransferInternal");

const revalidateStripeCustomerMetadataTransferRef = makeFunctionReference<
  "mutation",
  {
    fromOwnerId: string;
    toOwnerId: string;
    leaseId: string;
    leaseGeneration: number;
    leaseNow: number;
    operationId: string;
    stripeCustomerId: string;
    attemptId: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
  },
  { providerDeadlineAt: number } | null
>("auth_migration:revalidateStripeCustomerMetadataTransferInternal");

const recordActiveStripeCustomerMetadataTransferDebtRef = makeFunctionReference<
  "mutation",
  {
    fromOwnerId: string;
    toOwnerId: string;
    leaseId: string;
    leaseGeneration: number;
    leaseNow: number;
    operationId: string;
    stripeCustomerId: string;
    attemptId: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    reason: "customer_deleted" | "foreign_owner";
  },
  boolean
>("auth_migration:recordActiveStripeCustomerMetadataTransferDebtInternal");

const commitStripeCustomerMetadataTransferRef = makeFunctionReference<
  "mutation",
  {
    fromOwnerId: string;
    toOwnerId: string;
    leaseId: string;
    leaseGeneration: number;
    leaseNow: number;
    operationId: string;
    stripeCustomerId: string;
    attemptId: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    providerOwnerId: string;
  },
  boolean
>("auth_migration:commitStripeCustomerMetadataTransferInternal");

const migrateStripeOperationsBatchRef = makeFunctionReference<
  "mutation",
  {
    fromOwnerId: string;
    toOwnerId: string;
    leaseId: string;
    leaseGeneration: number;
    leaseNow: number;
  },
  { hasMore: boolean }
>("auth_migration:migrateStripeOperationsBatch");

export const migrateNextStripeOperationWithProviderInternal = internalAction({
  args: leasedOwnerArgs,
  returns: v.object({
    hasMore: v.boolean(),
    retryAt: v.optional(v.number()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ hasMore: boolean; retryAt?: number }> => {
    const freshLease = () => ({ ...args, leaseNow: Date.now() });
    const prepared = await ctx.runMutation(
      prepareStripeCustomerMetadataTransferRef,
      freshLease(),
    );
    if (!prepared) return { hasMore: false };
    if (prepared.kind === "wait") {
      return { hasMore: true, retryAt: prepared.retryAt };
    }
    if (prepared.kind === "local_only") {
      return await ctx.runMutation(
        migrateStripeOperationsBatchRef,
        freshLease(),
      );
    }
    const tuple = {
      operationId: prepared.operationId,
      stripeCustomerId: prepared.stripeCustomerId,
      attemptId: prepared.attemptId,
      idempotencyKey: prepared.idempotencyKey,
      providerDeadlineAt: prepared.providerDeadlineAt,
    };
    const recordTerminalDebt = async (
      reason: "customer_deleted" | "foreign_owner",
    ) => {
      const recorded = await ctx.runMutation(
        recordActiveStripeCustomerMetadataTransferDebtRef,
        { ...freshLease(), ...tuple, reason },
      );
      if (!recorded) {
        throw new ConvexError({
          code: "STRIPE_OPERATION_CONFLICT",
          message: "Stripe metadata-transfer debt lost its exact tuple.",
        });
      }
    };
    const withAuthority = async <T>(
      call: (stripe: Stripe) => Promise<T>,
    ): Promise<T> => {
      const authority = await ctx.runMutation(
        revalidateStripeCustomerMetadataTransferRef,
        { ...freshLease(), ...tuple },
      );
      if (!authority) {
        throw new ConvexError({
          code: "STRIPE_OPERATION_CONFLICT",
          message: "Stripe metadata-transfer tuple is stale.",
        });
      }
      const stripe = getStripeMetadataTransferClient(
        authority.providerDeadlineAt,
      );
      return await call(stripe);
    };
    const currentResponse = await withAuthority(
      async (stripe) => await stripe.customers.retrieve(tuple.stripeCustomerId),
    );
    const current = currentResponse as Stripe.Customer | Stripe.DeletedCustomer;
    if ("deleted" in current && current.deleted) {
      await recordTerminalDebt("customer_deleted");
      blockOwnershipMigration(
        "The Stripe customer was deleted during ownership transfer.",
      );
    }
    const currentOwnerId =
      (current as Stripe.Customer).metadata?.ownerId?.trim() ?? "";
    if (
      currentOwnerId !== args.fromOwnerId &&
      currentOwnerId !== args.toOwnerId
    ) {
      await recordTerminalDebt("foreign_owner");
      blockOwnershipMigration(
        "Stripe customer metadata does not match either migration owner.",
      );
    }
    if (currentOwnerId === args.fromOwnerId) {
      await withAuthority(
        async (stripe) =>
          await stripe.customers.update(
            tuple.stripeCustomerId,
            { metadata: { ownerId: args.toOwnerId } },
            { idempotencyKey: tuple.idempotencyKey },
          ),
      );
    }
    const readbackResponse = await withAuthority(
      async (stripe) => await stripe.customers.retrieve(tuple.stripeCustomerId),
    );
    const readback = readbackResponse as
      | Stripe.Customer
      | Stripe.DeletedCustomer;
    if ("deleted" in readback && readback.deleted) {
      await recordTerminalDebt("customer_deleted");
      blockOwnershipMigration(
        "Stripe customer metadata transfer found a deleted customer during readback.",
      );
    }
    if (
      (readback as Stripe.Customer).metadata?.ownerId?.trim() !== args.toOwnerId
    ) {
      await recordTerminalDebt("foreign_owner");
      blockOwnershipMigration(
        "Stripe customer metadata transfer did not pass readback.",
      );
    }
    const committed = await ctx.runMutation(
      commitStripeCustomerMetadataTransferRef,
      {
        ...freshLease(),
        ...tuple,
        providerOwnerId: args.toOwnerId,
      },
    );
    if (!committed) {
      throw new ConvexError({
        code: "STRIPE_OPERATION_CONFLICT",
        message: "Stripe metadata transfer lost its exact local commit tuple.",
      });
    }
    return { hasMore: true };
  },
});

export const migrateStripeOperationsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const operation = (
      await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (!operation) return { hasMore: false };
    await ensureStripeOperationPhysicalHistory(ctx, operation, args.leaseNow);
    if (
      !(await ensureLegacyStripeOperationPhysicalReceiptProvenance(
        ctx,
        operation,
      ))
    ) {
      blockOwnershipMigration(
        "A Stripe operation contains unproven physical receipt authority.",
      );
    }
    const pendingLateResult = await ctx.db
      .query("billing_stripe_late_results")
      .withIndex("by_operationId_and_createdAt", (q) =>
        q.eq("operationId", operation.operationId),
      )
      .first();
    if (pendingLateResult) {
      throw new ConvexError({
        code: "STRIPE_OPERATION_NOT_QUIESCENT",
        message: "A Stripe operation still has an unresolved physical result.",
      });
    }
    const metadataTransferShape = stripeMetadataTransferShape(operation);
    if (!hasValidStripeOperationStateLocators(operation)) {
      blockOwnershipMigration(
        "A Stripe operation contains invalid provider-result locators.",
      );
    }
    if (
      operation.terminalizedByManualResolutionId !== undefined &&
      !(await hasMatchingStripeManualResolutionProof(ctx, operation))
    ) {
      blockOwnershipMigration(
        "A Stripe manual-resolution audit is missing or changed.",
      );
    }
    if (!hasCurrentStripeOperationIntegrity(operation)) {
      if (
        !hasLegacyStripeOperationIntegrityVersion(operation) ||
        metadataTransferShape !== "clean" ||
        !hasCleanLegacyStripeOperationTransport(operation)
      ) {
        blockOwnershipMigration(
          "A Stripe operation requires lifecycle integrity reconciliation before migration.",
        );
      }
      await ctx.db.patch(operation._id, {
        dispatchState: "idle",
        integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
        lifecycleIntegrityVersion: undefined,
        updatedAt: args.leaseNow,
      });
    }
    if (
      operation.dispatchState === "may_have_dispatched" ||
      operation.activeStep !== undefined ||
      operation.activeAttemptId !== undefined ||
      operation.activeRequestJson !== undefined ||
      operation.activeRequestFingerprint !== undefined ||
      operation.activeIdempotencyKey !== undefined ||
      operation.providerDeadlineAt !== undefined ||
      operation.quiescentAfterAt !== undefined ||
      operation.nextReconcileAt !== undefined ||
      operation.reconcileClaimId !== undefined ||
      operation.reconcileClaimExpiresAt !== undefined ||
      operation.manualDebtReason !== undefined ||
      hasAnyStripeLateResultField(operation) ||
      metadataTransferShape !== "clean" ||
      (operation.dispatchState === undefined &&
        operation.leaseExpiresAt > args.leaseNow)
    ) {
      throw new ConvexError({
        code: "STRIPE_OPERATION_NOT_QUIESCENT",
        message: "A Stripe operation still owns provider replay authority.",
      });
    }

    const requestKey = operation.requestKey?.trim();
    if (
      operation.requestKey !== undefined &&
      !/^[a-f0-9]{64}$/u.test(requestKey ?? "")
    ) {
      blockOwnershipMigration(
        "A Stripe operation contains a malformed logical request key.",
      );
    }
    const collisions = requestKey
      ? await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_ownerId_and_kind_and_requestKey", (q) =>
            q
              .eq("ownerId", args.toOwnerId)
              .eq("kind", operation.kind)
              .eq("requestKey", requestKey),
          )
          .take(2)
      : await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_ownerId_and_kind_and_requestFingerprint", (q) =>
            q
              .eq("ownerId", args.toOwnerId)
              .eq("kind", operation.kind)
              .eq("requestFingerprint", operation.requestFingerprint),
          )
          .take(2);
    if (collisions.length > 0) {
      blockOwnershipMigration(
        "Both identities contain a Stripe operation for the same logical billing request.",
      );
    }

    const sourceAuthorityProfile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (
      sourceAuthorityProfile &&
      (operation.stripeCustomerAuthorityEpoch ?? 0) !==
        (sourceAuthorityProfile.stripeCustomerAuthorityEpoch ?? 0)
    ) {
      blockOwnershipMigration(
        "A Stripe operation belongs to a rotated source customer authority.",
      );
    }

    const recoveredCustomerId = operation.stripeCustomerId?.trim();
    if (recoveredCustomerId) {
      blockOwnershipMigration(
        "Stripe customer metadata requires the provider-aware migration action before local ownership moves.",
      );
      const [sourceProfile, destinationProfile, linkedProfiles] =
        await Promise.all([
          ctx.db
            .query("billing_profiles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .unique(),
          ctx.db
            .query("billing_profiles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
            .unique(),
          ctx.db
            .query("billing_profiles")
            .withIndex("by_stripeCustomerId", (q) =>
              q.eq("stripeCustomerId", recoveredCustomerId),
            )
            .take(3),
        ]);
      if (
        linkedProfiles.some(
          (profile) =>
            profile.ownerId !== args.fromOwnerId &&
            profile.ownerId !== args.toOwnerId,
        )
      ) {
        blockOwnershipMigration(
          "The recovered Stripe customer is linked to another account.",
        );
      }
      if (
        sourceProfile &&
        !isUnencumberedFreeBillingProfile(sourceProfile, recoveredCustomerId)
      ) {
        blockOwnershipMigration(
          "The anonymous identity contains paid billing state that cannot be linked automatically.",
        );
      }
      if (
        destinationProfile?.stripeCustomerId &&
        destinationProfile.stripeCustomerId !== recoveredCustomerId
      ) {
        blockOwnershipMigration(
          "The Stripe operation customer conflicts with the connected account.",
        );
      }
      if (
        destinationProfile &&
        !destinationProfile.stripeCustomerId &&
        !isUnencumberedFreeBillingProfile(
          destinationProfile,
          recoveredCustomerId,
        )
      ) {
        blockOwnershipMigration(
          "The connected identity contains incompatible billing state.",
        );
      }

      if (destinationProfile) {
        if (destinationProfile.stripeCustomerId !== recoveredCustomerId) {
          await ctx.db.patch(
            destinationProfile._id,
            recoveredStripeCustomerPatch(recoveredCustomerId, args.leaseNow),
          );
        }
        if (sourceProfile?.stripeCustomerId === recoveredCustomerId) {
          await ctx.db.patch(sourceProfile._id, {
            ...recoveredStripeCustomerPatch("", args.leaseNow),
            stripeCustomerTerminal: false,
          });
        }
      } else if (sourceProfile) {
        await ctx.db.patch(sourceProfile._id, {
          ownerId: args.toOwnerId,
          ...recoveredStripeCustomerPatch(recoveredCustomerId, args.leaseNow),
        });
      } else {
        blockOwnershipMigration(
          "The recovered Stripe customer has no billing profile to adopt it.",
        );
      }
    }

    // A customerless anonymous receipt still has customer-create authority.
    // Re-owning only its owner/generation would leave that authority pinned to
    // the source epoch/key and, when the connected identity already has a live
    // customer, could let the replay attempt a second customer create. Align
    // the receipt with the destination profile in this same transaction. The
    // logical operation/idempotency keys remain untouched; only the shared
    // per-customer authority is adopted.
    const [sourceProfile, destinationProfile] = await Promise.all([
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .unique(),
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique(),
    ]);
    if (sourceProfile?.stripeCustomerId?.trim()) {
      blockOwnershipMigration(
        "A source Stripe customer requires the provider-aware migration action before a customerless receipt can move.",
      );
    }
    const destinationCustomerAuthorityEpoch =
      destinationProfile?.stripeCustomerAuthorityEpoch ??
      sourceProfile?.stripeCustomerAuthorityEpoch ??
      operation.stripeCustomerAuthorityEpoch ??
      0;
    const destinationCustomerCreateIdempotencyKey = destinationProfile
      ? await resolvePinnedStripeCustomerAuthorityKey(ctx, {
          profile: destinationProfile,
          ownerId: args.toOwnerId,
          authorityEpoch: destinationCustomerAuthorityEpoch,
          now: args.leaseNow,
        })
      : await stripeCustomerAuthorityIdempotencyKey(
          args.toOwnerId,
          destinationCustomerAuthorityEpoch,
        );
    const destinationCustomerId =
      destinationProfile?.stripeCustomerId?.trim() ?? "";
    if (destinationCustomerId) {
      const locatorHash = await hashStripeBillingLocator(
        "customer",
        destinationCustomerId,
      );
      const tombstone = await ctx.db
        .query("billing_stripe_deletion_tombstones")
        .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
        .unique();
      if (destinationProfile?.stripeCustomerTerminal || tombstone) {
        blockOwnershipMigration(
          "The connected identity customer authority is terminal and cannot be adopted.",
        );
      }
    }
    if (!destinationProfile && sourceProfile) {
      // Usage-accounting migration moves this profile after all Stripe
      // receipts. Pre-pin the destination authority so that later ownerId move
      // cannot retain a source-derived key.
      await ctx.db.patch(sourceProfile._id, {
        stripeCustomerAuthorityEpoch: destinationCustomerAuthorityEpoch,
        stripeCustomerCreateIdempotencyKey:
          destinationCustomerCreateIdempotencyKey,
        updatedAt: args.leaseNow,
      });
    }

    await assertOrMoveAttachedStripePendingCleanup(ctx, operation, {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
      now: args.leaseNow,
    });
    await assertOrMoveAttachedStripeRetentionProof(ctx, operation, {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
      now: args.leaseNow,
    });
    await moveAttachedStripeResolutionProofs(ctx, operation, {
      fromOwnerId: args.fromOwnerId,
      fromOwnerGeneration: migration.fromOwnerGeneration!,
      toOwnerId: args.toOwnerId,
      toOwnerGeneration: migration.toOwnerGeneration!,
    });
    await ctx.db.patch(operation._id, {
      ownerId: args.toOwnerId,
      ownerGeneration: migration.toOwnerGeneration!,
      stripeCustomerAuthorityEpoch: destinationCustomerAuthorityEpoch,
      stripeCustomerCreateIdempotencyKey:
        destinationCustomerCreateIdempotencyKey,
      ...(destinationCustomerId
        ? {
            stripeCustomerId: destinationCustomerId,
            stripeCustomerMetadataOwnerId: args.toOwnerId,
          }
        : {}),
      lifecycleIntegrityVersion: undefined,
      updatedAt: args.leaseNow,
    });
    return { hasMore: true };
  },
});

/**
 * Stripe manual-resolution audits follow their authoritative operation only
 * after every source operation has moved. Resolution ids are globally unique
 * operator idempotency keys; a collision is evidence of conflicting audit
 * history and therefore blocks account linking instead of being coalesced.
 */
export const migrateStripeOperationResolutionsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const resolution = (
      await ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_ownerId_and_resolvedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (!resolution) return { hasMore: false };
    const operation = await ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_operationId", (q) =>
        q.eq("operationId", resolution.operationId),
      )
      .unique();
    if (!operation) {
      return blockOwnershipMigration(
        "A Stripe operator audit lost its migrated operation receipt.",
      );
    }
    if (
      !(await moveStripeOperationResolutionProofs(ctx, operation, {
        fromOwnerId: args.fromOwnerId,
        fromOwnerGeneration: migration.fromOwnerGeneration!,
        toOwnerId: args.toOwnerId,
        toOwnerGeneration: migration.toOwnerGeneration!,
        phase: "after_operation_move",
      }))
    ) {
      blockOwnershipMigration(
        "A Stripe operation contains missing, stale, or conflicting resolution audits.",
      );
    }
    return { hasMore: true };
  },
});

/**
 * Quota state merges conservatively: usage is summed and each window keeps
 * the later start, so linking cannot immediately expire the anonymous row and
 * reset its allowance.
 */
export const migrateUsageAccountingBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const toOwnerGeneration = migration.toOwnerGeneration!;
    const requestBinding = (
      await ctx.db
        .query("billing_managed_request_bindings")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (requestBinding) {
      const destinationFingerprint =
        await createManagedDispatchRequestFingerprint(
          requestBinding.route,
          `${args.toOwnerId}\u0000${toOwnerGeneration}\u0000${requestBinding.requestId}`,
        );
      const destination = await ctx.db
        .query("billing_managed_request_bindings")
        .withIndex(
          "by_ownerId_and_ownerGeneration_and_route_and_requestId",
          (q) =>
            q
              .eq("ownerId", args.toOwnerId)
              .eq("ownerGeneration", toOwnerGeneration)
              .eq("route", requestBinding.route)
              .eq("requestId", requestBinding.requestId),
        )
        .unique();
      if (destination && destination._id !== requestBinding._id) {
        if (
          destination.bodyFingerprint !== requestBinding.bodyFingerprint ||
          destination.requestFingerprint !== destinationFingerprint
        ) {
          blockOwnershipMigration(
            `A managed-provider request binding collision exists for ${requestBinding.route}/${requestBinding.requestId}.`,
          );
        }
        await ctx.db.patch(destination._id, {
          createdAt: Math.min(destination.createdAt, requestBinding.createdAt),
          updatedAt: Math.max(destination.updatedAt, requestBinding.updatedAt),
        });
        await ctx.db.delete(requestBinding._id);
      } else {
        await ctx.db.patch(requestBinding._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: toOwnerGeneration,
          requestFingerprint: destinationFingerprint,
        });
      }
      return { hasMore: true };
    }
    const rollup = (
      await ctx.db
        .query("usage_rollups")
        .withIndex("by_ownerId_and_bucketStartMs", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (rollup) {
      const destination = await ctx.db
        .query("usage_rollups")
        .withIndex("by_ownerId_and_bucketStartMs", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("bucketStartMs", rollup.bucketStartMs),
        )
        .unique();
      if (destination) {
        await ctx.db.patch(destination._id, {
          inputTokens: destination.inputTokens + rollup.inputTokens,
          outputTokens: destination.outputTokens + rollup.outputTokens,
          totalTokens: destination.totalTokens + rollup.totalTokens,
          requestCount: destination.requestCount + rollup.requestCount,
          toolCallCount: destination.toolCallCount + rollup.toolCallCount,
          updatedAt: Math.max(destination.updatedAt, rollup.updatedAt),
        });
        await ctx.db.delete(rollup._id);
      } else {
        await ctx.db.patch(rollup._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const [usage, destinationUsage] = await Promise.all([
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .unique(),
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique(),
    ]);
    if ((destinationUsage?.activeReservedMicroCents ?? 0) !== 0) {
      blockOwnershipMigration(
        "The connected identity still has reserved managed-provider spend.",
      );
    }
    if (usage) {
      if ((usage.activeReservedMicroCents ?? 0) !== 0) {
        blockOwnershipMigration(
          "The anonymous identity still has reserved managed-provider spend.",
        );
      }
      if (destinationUsage) {
        await ctx.db.patch(
          destinationUsage._id,
          mergeBillingUsageWindows(usage, destinationUsage),
        );
        await ctx.db.delete(usage._id);
      } else {
        await ctx.db.patch(usage._id, {
          ownerId: args.toOwnerId,
          activeReservedMicroCents: 0,
        });
      }
      return { hasMore: true };
    }
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (profile) {
      const isAnonymousFreeProfile =
        profile.activePlan === "free" &&
        (profile.usageMode === undefined || profile.usageMode === "default") &&
        profile.subscriptionStatus === "none" &&
        !profile.stripeCustomerId &&
        !profile.stripeSubscriptionId &&
        !profile.stripePriceId &&
        !profile.defaultPaymentMethodId &&
        !profile.paymentMethodBrand &&
        !profile.paymentMethodLast4 &&
        profile.currentPeriodStart === 0 &&
        profile.currentPeriodEnd === 0 &&
        profile.cancelAtPeriodEnd === false;
      if (!isAnonymousFreeProfile) {
        blockOwnershipMigration(
          "The anonymous identity unexpectedly owns paid billing state.",
        );
      }
      const destination = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) await ctx.db.delete(profile._id);
      else await ctx.db.patch(profile._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    const ttsUsage = (
      await ctx.db
        .query("internal_tts_usage")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (ttsUsage) {
      const collisions =
        ttsUsage.dispatchId !== undefined && ttsUsage.attemptId !== undefined
          ? await ctx.db
              .query("internal_tts_usage")
              .withIndex("by_dispatchId_and_attemptId", (q) =>
                q
                  .eq("dispatchId", ttsUsage.dispatchId)
                  .eq("attemptId", ttsUsage.attemptId),
              )
              .take(2)
          : [];
      const collision = collisions.find((row) => row._id !== ttsUsage._id);
      if (collision) {
        const exactReplay =
          collision.ownerId === args.toOwnerId &&
          collision.ownerGeneration === toOwnerGeneration &&
          collision.dispatchId === ttsUsage.dispatchId &&
          collision.attemptId === ttsUsage.attemptId &&
          collision.leaseId === ttsUsage.leaseId &&
          collision.providerDispatchOutcome ===
            ttsUsage.providerDispatchOutcome &&
          collision.provider === ttsUsage.provider &&
          collision.model === ttsUsage.model &&
          collision.voice === ttsUsage.voice &&
          collision.conversationId === ttsUsage.conversationId &&
          collision.streaming === ttsUsage.streaming &&
          collision.status === ttsUsage.status &&
          collision.requestChars === ttsUsage.requestChars &&
          collision.requestedTextInputTokens ===
            ttsUsage.requestedTextInputTokens &&
          collision.requestedAudioOutputTokens ===
            ttsUsage.requestedAudioOutputTokens &&
          collision.synthesizedChars === ttsUsage.synthesizedChars &&
          collision.audioBytes === ttsUsage.audioBytes &&
          collision.textInputTokens === ttsUsage.textInputTokens &&
          collision.audioOutputTokens === ttsUsage.audioOutputTokens &&
          collision.costMicroCents === ttsUsage.costMicroCents &&
          collision.durationMs === ttsUsage.durationMs &&
          collision.createdAt === ttsUsage.createdAt;
        if (!exactReplay) {
          blockOwnershipMigration(
            `A TTS usage receipt collision exists for ${ttsUsage.dispatchId}/${ttsUsage.attemptId}.`,
          );
        }
        await ctx.db.delete(ttsUsage._id);
      } else {
        await ctx.db.patch(ttsUsage._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: toOwnerGeneration,
        });
      }
      return { hasMore: true };
    }
    const voiceReceipt = (
      await ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (voiceReceipt) {
      const collision = await ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_responseId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("responseId", voiceReceipt.responseId),
        )
        .unique();
      if (collision) {
        blockOwnershipMigration(
          `A voice usage receipt collision exists for ${voiceReceipt.responseId}.`,
        );
      }
      await ctx.db.patch(voiceReceipt._id, {
        ownerId: args.toOwnerId,
        ownerGeneration: toOwnerGeneration,
      });
      return { hasMore: true };
    }
    const mediaReceipt = (
      await ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (mediaReceipt) {
      const collision = await ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_jobId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("jobId", mediaReceipt.jobId),
        )
        .unique();
      if (collision) {
        blockOwnershipMigration(
          `A media usage receipt collision exists for ${mediaReceipt.jobId}.`,
        );
      }
      await ctx.db.patch(mediaReceipt._id, {
        ownerId: args.toOwnerId,
        ownerGeneration: toOwnerGeneration,
      });
      return { hasMore: true };
    }
    const voiceSession = (
      await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (voiceSession) {
      if (
        voiceSession.endedAt === undefined ||
        ["minting", "active", "superseded_unreported_grace"].includes(
          voiceSession.status,
        )
      ) {
        blockOwnershipMigration(
          "A realtime voice billing lease is still active or awaiting its final usage report.",
        );
      }
      await ctx.db.patch(voiceSession._id, {
        ownerId: args.toOwnerId,
        ownerGeneration: toOwnerGeneration,
      });
      return { hasMore: true };
    }
    return { hasMore: false };
  },
});

/** Stable mobile and tunnel registrations survive account linking. Ephemeral
 * pairing/session rows are deliberately handled by the blocking residue gate. */
export const migrateDeviceExtensionsForAccountLink = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const toOwnerGeneration = migration.toOwnerGeneration!;
    const registration = (
      await ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (registration) {
      const destination = await ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("deviceId", registration.deviceId),
        )
        .unique();
      if (destination) {
        if (
          destination.desktopPublicKey &&
          registration.desktopPublicKey &&
          destination.desktopPublicKey !== registration.desktopPublicKey
        ) {
          blockOwnershipMigration(
            `Both identities have different bridge keys for desktop device ${registration.deviceId}.`,
          );
        }
        await ctx.db.patch(destination._id, {
          // Keep the destination's priority order and the same hard cap used
          // by live registration writes; linking must not create an oversized
          // row by concatenating two individually valid URL lists.
          baseUrls: Array.from(
            new Set([...destination.baseUrls, ...registration.baseUrls]),
          ).slice(0, 8),
          updatedAt: Math.max(destination.updatedAt, registration.updatedAt),
          platform: destination.platform ?? registration.platform,
          desktopPublicKey:
            destination.desktopPublicKey ?? registration.desktopPublicKey,
        });
        await ctx.db.delete(registration._id);
      } else {
        await ctx.db.patch(registration._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true };
    }
    const paired = (
      await ctx.db
        .query("paired_mobile_devices")
        .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (paired) {
      const destination = await ctx.db
        .query("paired_mobile_devices")
        .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("desktopDeviceId", paired.desktopDeviceId)
            .eq("mobileDeviceId", paired.mobileDeviceId),
        )
        .unique();
      if (destination) {
        if (destination.pairSecretHash !== paired.pairSecretHash) {
          blockOwnershipMigration(
            `Both identities have different mobile pairing secrets for ${paired.desktopDeviceId}/${paired.mobileDeviceId}.`,
          );
        }
        const newer =
          paired.lastSeenAt > destination.lastSeenAt ? paired : destination;
        await ctx.db.patch(destination._id, {
          ownerGeneration: toOwnerGeneration,
          pairSecretHash: newer.pairSecretHash,
          displayName: newer.displayName,
          platform: newer.platform,
          approvedAt: Math.min(destination.approvedAt, paired.approvedAt),
          lastSeenAt: Math.max(destination.lastSeenAt, paired.lastSeenAt),
          revokedAt:
            destination.revokedAt === undefined ||
            paired.revokedAt === undefined
              ? undefined
              : Math.max(destination.revokedAt, paired.revokedAt),
        });
        await ctx.db.delete(paired._id);
      } else {
        await ctx.db.patch(paired._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: toOwnerGeneration,
        });
      }
      return { hasMore: true };
    }
    const push = (
      await ctx.db
        .query("mobile_push_tokens")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (push) {
      const destination = await ctx.db
        .query("mobile_push_tokens")
        .withIndex("by_ownerId_and_mobileDeviceId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("mobileDeviceId", push.mobileDeviceId),
        )
        .unique();
      const tokenHolders = await ctx.db
        .query("mobile_push_tokens")
        .withIndex("by_expoPushToken", (q) =>
          q.eq("expoPushToken", push.expoPushToken),
        )
        .take(8);
      if (
        tokenHolders.some(
          (holder) =>
            holder._id !== push._id && holder._id !== destination?._id,
        )
      ) {
        blockOwnershipMigration(
          "The anonymous push token is already bound to a different mobile device.",
        );
      }
      if (destination) {
        if (destination.expoPushToken !== push.expoPushToken) {
          blockOwnershipMigration(
            `Both identities have different push tokens for mobile device ${push.mobileDeviceId}.`,
          );
        }
        await ctx.db.patch(destination._id, {
          ownerGeneration: toOwnerGeneration,
          ...(push.updatedAt > destination.updatedAt
            ? {
                expoPushToken: push.expoPushToken,
                platform: push.platform,
                updatedAt: push.updatedAt,
              }
            : {}),
        });
        await ctx.db.delete(push._id);
      } else {
        await ctx.db.patch(push._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: toOwnerGeneration,
        });
      }
      return { hasMore: true };
    }
    const registrationLimit = await ctx.db
      .query("mobile_bridge_registration_limits")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (registrationLimit) {
      const destination = await ctx.db
        .query("mobile_bridge_registration_limits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) {
        await ctx.db.patch(destination._id, {
          windowStartedAt: Math.max(
            destination.windowStartedAt,
            registrationLimit.windowStartedAt,
          ),
          count: Math.min(
            Number.MAX_SAFE_INTEGER,
            destination.count + registrationLimit.count,
          ),
        });
        await ctx.db.delete(registrationLimit._id);
      } else {
        await ctx.db.patch(registrationLimit._id, {
          ownerId: args.toOwnerId,
        });
      }
      return { hasMore: true };
    }
    const tunnel = (
      await ctx.db
        .query("cloudflare_tunnels")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (tunnel) {
      const destination = tunnel.deviceId
        ? await ctx.db
            .query("cloudflare_tunnels")
            .withIndex("by_ownerId_and_deviceId", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("deviceId", tunnel.deviceId),
            )
            .unique()
        : null;
      if (destination) {
        blockOwnershipMigration(
          `Both identities own a Cloudflare tunnel for device ${tunnel.deviceId}.`,
        );
      }
      await ctx.db.patch(tunnel._id, { ownerId: args.toOwnerId });
      return { hasMore: true };
    }
    return { hasMore: false };
  },
});

export const migrateDeviceIdentitySuccessorsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const rows = await ctx.db
      .query("device_identity_successors")
      .withIndex("by_ownerId_and_previousDeviceId", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      const destination = await ctx.db
        .query("device_identity_successors")
        .withIndex("by_ownerId_and_previousDeviceId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("previousDeviceId", row.previousDeviceId),
        )
        .unique();
      if (destination) {
        if (destination.deviceId !== row.deviceId) {
          blockOwnershipMigration(
            `Device ${row.previousDeviceId} has conflicting successor identities.`,
          );
        }
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const discardAnonymousTransientHandshakesBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const migrationOwnerIds = [args.fromOwnerId, args.toOwnerId] as const;
    let upload: Doc<"cloud_drive_uploads"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      upload = (
        await ctx.db
          .query("cloud_drive_uploads")
          .withIndex("by_ownerId_and_path", (q) => q.eq("ownerId", ownerId))
          .take(1)
      )[0];
      if (upload) break;
    }
    if (upload) {
      await ctx.db.delete(upload._id);
      for (const delay of canceledPendingUploadCleanupDelays(
        Date.now(),
        upload.expiresAt,
      )) {
        await ctx.scheduler.runAfter(
          delay,
          internal.cloud_drive.cleanupCanceledPendingUploadInternal,
          { r2Key: upload.r2Key },
        );
      }
      return { hasMore: true };
    }
    let xState: Doc<"x_oauth_states"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      xState = (
        await ctx.db
          .query("x_oauth_states")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1)
      )[0];
      if (xState) break;
    }
    if (xState) {
      await ctx.db.delete(xState._id);
      return { hasMore: true };
    }
    let engineConnect: Doc<"cloud_engine_connects"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      engineConnect = (
        await ctx.db
          .query("cloud_engine_connects")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1)
      )[0];
      if (engineConnect) break;
    }
    if (engineConnect) {
      await ctx.db.delete(engineConnect._id);
      return { hasMore: true };
    }
    let githubState: Doc<"cloud_github_install_states"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      githubState = (
        await ctx.db
          .query("cloud_github_install_states")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1)
      )[0];
      if (githubState) break;
    }
    if (githubState) {
      await ctx.db.delete(githubState._id);
      return { hasMore: true };
    }
    let bridgeSession: Doc<"mobile_bridge_sessions"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      bridgeSession = (
        await ctx.db
          .query("mobile_bridge_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1)
      )[0];
      if (bridgeSession) break;
    }
    if (bridgeSession) {
      await ctx.db.delete(bridgeSession._id);
      return { hasMore: true };
    }
    let pairingSession: Doc<"mobile_pairing_sessions"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      pairingSession = (
        await ctx.db
          .query("mobile_pairing_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1)
      )[0];
      if (pairingSession) break;
    }
    if (pairingSession) {
      await ctx.db.delete(pairingSession._id);
      return { hasMore: true };
    }
    let connectIntent: Doc<"mobile_connect_intents"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      connectIntent = (
        await ctx.db
          .query("mobile_connect_intents")
          .withIndex("by_ownerId_and_desktopDeviceId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1)
      )[0];
      if (connectIntent) break;
    }
    if (connectIntent) {
      await ctx.db.delete(connectIntent._id);
      return { hasMore: true };
    }
    let dispatchPayload: Doc<"execution_dispatch_payloads"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      dispatchPayload = (
        await ctx.db
          .query("execution_dispatch_payloads")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1)
      )[0];
      if (dispatchPayload) break;
    }
    if (dispatchPayload) {
      const authority = await ctx.db
        .query("execution_dispatches")
        .withIndex("by_dispatchId", (q) =>
          q.eq("dispatchId", dispatchPayload.dispatchId),
        )
        .unique();
      if (
        authority &&
        authority.state !== "completed" &&
        authority.state !== "failed" &&
        authority.state !== "canceled"
      ) {
        blockOwnershipMigration(
          "Automatic placement payload cleanup ran before execution quiescence.",
        );
      }
      await ctx.db.delete(dispatchPayload._id);
      return { hasMore: true };
    }
    let offer: Doc<"execution_offers"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      offer = (
        await ctx.db
          .query("execution_offers")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1)
      )[0];
      if (offer) break;
    }
    if (offer) {
      if (offer.status === "open") {
        blockOwnershipMigration(
          "Automatic placement offer cleanup ran before execution quiescence.",
        );
      }
      await ctx.db.delete(offer._id);
      return { hasMore: true };
    }
    let dispatch: Doc<"execution_dispatches"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      dispatch = (
        await ctx.db
          .query("execution_dispatches")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1)
      )[0];
      if (dispatch) break;
    }
    if (dispatch) {
      if (
        dispatch.state !== "completed" &&
        dispatch.state !== "failed" &&
        dispatch.state !== "canceled"
      ) {
        blockOwnershipMigration(
          "Automatic placement authority cleanup ran before execution quiescence.",
        );
      }
      if (dispatch.migrationId && dispatch.migrationId !== migration._id) {
        blockOwnershipMigration(
          "Automatic placement authority belongs to another account migration.",
        );
      }
      await ctx.db.delete(dispatch._id);
      return { hasMore: true };
    }
    let presence: Doc<"desktop_execution_presence"> | undefined;
    for (const ownerId of migrationOwnerIds) {
      presence = (
        await ctx.db
          .query("desktop_execution_presence")
          .withIndex("by_ownerId_and_deviceId", (q) => q.eq("ownerId", ownerId))
          .take(1)
      )[0];
      if (presence) break;
    }
    if (presence) {
      if (presence.migrationId !== migration._id) {
        blockOwnershipMigration(
          "Automatic placement presence cleanup ran before execution quiescence.",
        );
      }
      await ctx.db.delete(presence._id);
      return { hasMore: true };
    }
    return { hasMore: false };
  },
});

export const migrateMediaWebhookEventsBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const toOwnerGeneration = migration.toOwnerGeneration!;
    const rows = await ctx.db
      .query("media_webhook_events")
      .withIndex("by_ownerId_and_receivedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) =>
        ctx.db.patch(row._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: toOwnerGeneration,
        }),
      ),
    );
    return { hasMore: isFullPage(rows) };
  },
});

const CLOUD_PROJECTION_BATCH_SIZE = 200;
const OWNERSHIP_MIGRATION_LEASE_MS = 9 * 60_000;
const OWNERSHIP_MIGRATION_FAILED_RETRY_COOLDOWN_MS = 60_000;
const OWNERSHIP_MIGRATION_COMPLETED_RAW_RETENTION_MS = 30 * 60_000;
type MigrationStatus = "pending" | "running" | "failed" | "complete";

const cloudTransferBatchReturn = v.array(
  v.object({
    conversationId: v.string(),
    deleted: v.boolean(),
    purged: v.boolean(),
  }),
);

const externalTransferReceiptArgs = {
  transferOperationId: v.string(),
  transferPlanFingerprint: v.string(),
  transferStage: v.string(),
} as const;

type ExternalTransferReceiptArgs = {
  transferOperationId: string;
  transferPlanFingerprint: string;
  transferStage: string;
};

const storeExternalTransferAck = async (
  ctx: MutationCtx,
  migration: Doc<"auth_owner_migrations">,
  lease: OwnershipLease,
  receipt: ExternalTransferReceiptArgs,
  ready: boolean,
): Promise<void> => {
  if (
    !sha256HexPattern.test(receipt.transferOperationId) ||
    !sha256HexPattern.test(receipt.transferPlanFingerprint) ||
    !migration.fromOwnerGeneration ||
    !migration.toOwnerGeneration
  ) {
    blockOwnershipMigration("The cloud transfer receipt is malformed.");
  }
  await ctx.db.patch(migration._id, {
    externalTransferAck: {
      ready,
      transferOperationId: receipt.transferOperationId,
      transferPlanFingerprint: receipt.transferPlanFingerprint,
      migrationId: String(migration._id),
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      fromOwnerGeneration: migration.fromOwnerGeneration!,
      toOwnerGeneration: migration.toOwnerGeneration!,
      stage: receipt.transferStage,
      planRevision: migration.planRevision ?? 1,
    },
  });
};

/**
 * Plain mutation helper used by both Better Auth's same-request account-link
 * hook and the system-browser OTT handoff. Inserting the immutable source lock,
 * binding the handoff row, and scheduling the worker can therefore share one
 * Convex transaction.
 */
export const prepareOwnershipMigrationForOwners = async (
  ctx: MutationCtx,
  args: OwnershipMigrationPreparation,
): Promise<Id<"auth_owner_migrations">> => {
  if (args.fromOwnerId === args.toOwnerId) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_CONFLICT",
      message: "Anonymous and connected ownership identities must differ.",
    });
  }
  if (await hasMinimizedOwnershipSourceTombstone(ctx, args.fromOwnerId)) {
    throwOwnershipSourceAlreadyMigrated();
  }
  const sourceAuthUserId = args.sourceAuthUserId?.trim();
  const sourceAuthUserEmail = args.sourceAuthUserEmail?.trim();
  if (
    args.sourceAuthUserId !== undefined &&
    (!sourceAuthUserId ||
      sourceAuthUserId.length > 512 ||
      tokenIdentifierForBetterAuthUserId(sourceAuthUserId) !== args.fromOwnerId)
  ) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_CONFLICT",
      message: "The anonymous auth principal does not match its owner.",
    });
  }
  if (
    args.sourceAuthUserEmail !== undefined &&
    (!sourceAuthUserEmail || sourceAuthUserEmail.length > 1_024)
  ) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_CONFLICT",
      message: "The anonymous auth email locator is invalid.",
    });
  }
  const sourceAuthDeletionOperationId = sourceAuthUserId
    ? await migratedSourceAuthDeletionOperationId(
        args.fromOwnerId,
        args.toOwnerId,
      )
    : undefined;
  const ownerGenerations = await readMigrationOwnerGenerations(ctx, args);
  const existing = await loadSingleSourceMigration(ctx, args);
  let migrationId: Id<"auth_owner_migrations">;
  if (existing) {
    if (
      (existing.fromOwnerGeneration !== undefined &&
        existing.fromOwnerGeneration !==
          ownerGenerations.fromOwnerGeneration) ||
      (existing.toOwnerGeneration !== undefined &&
        existing.toOwnerGeneration !== ownerGenerations.toOwnerGeneration)
    ) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message: "The account data generation changed during account linking.",
      });
    }
    if (
      (sourceAuthUserId !== undefined &&
        existing.sourceAuthUserId !== undefined &&
        existing.sourceAuthUserId !== sourceAuthUserId) ||
      (sourceAuthUserEmail !== undefined &&
        existing.sourceAuthUserEmail !== undefined &&
        existing.sourceAuthUserEmail !== sourceAuthUserEmail) ||
      (sourceAuthDeletionOperationId !== undefined &&
        existing.sourceAuthDeletionOperationId !== undefined &&
        existing.sourceAuthDeletionOperationId !==
          sourceAuthDeletionOperationId)
    ) {
      throw new ConvexError({
        code: "OWNERSHIP_MIGRATION_CONFLICT",
        message: "The anonymous auth deletion locator changed.",
      });
    }
    if (
      !existing.fromOwnerGeneration ||
      !existing.toOwnerGeneration ||
      !existing.planRevision ||
      (sourceAuthUserId !== undefined && !existing.sourceAuthUserId)
    ) {
      await ctx.db.patch(existing._id, {
        ...ownerGenerations,
        planRevision: existing.planRevision ?? 1,
        ...(sourceAuthUserId
          ? {
              sourceAuthUserId,
              sourceAuthUserEmail,
              sourceAuthDeletionOperationId,
              sourceAuthDeletionState:
                existing.sourceAuthDeletionState ?? ("pending" as const),
            }
          : {}),
        updatedAt: Date.now(),
      });
    }
    migrationId = existing._id;
  } else {
    const now = Date.now();
    migrationId = await ctx.db.insert("auth_owner_migrations", {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
      status: "pending",
      leaseGeneration: 0,
      ...ownerGenerations,
      planRevision: 1,
      ...(sourceAuthUserId
        ? {
            sourceAuthUserId,
            sourceAuthUserEmail,
            sourceAuthDeletionOperationId,
            sourceAuthDeletionState: "pending" as const,
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
  }
  if (!existing || existing.status === "pending") {
    // Scheduler insertion and source-fence publication are one transaction.
    await ctx.scheduler.runAfter(0, internal.auth_migration.migrateOwnership, {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
    });
  }
  return migrationId;
};

export const prepareOwnershipMigration = internalMutation({
  args: prepareOwnerArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return null;
    await prepareOwnershipMigrationForOwners(ctx, args);
    return null;
  },
});

export const getMyOwnershipMigrationStatus = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("failed"),
        v.literal("complete"),
      ),
      updatedAt: v.number(),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) return null;
    await assertSensitiveSessionPolicy(ctx, identity);
    const latestForStatus = async (status: MigrationStatus) =>
      (
        await ctx.db
          .query("auth_owner_migrations")
          .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
            q.eq("toOwnerId", ownerId).eq("status", status),
          )
          .order("desc")
          .take(1)
      )[0];
    const [pending, running, failed, complete] = await Promise.all([
      latestForStatus("pending"),
      latestForStatus("running"),
      latestForStatus("failed"),
      latestForStatus("complete"),
    ]);
    const active =
      pending && running
        ? pending.updatedAt >= running.updatedAt
          ? pending
          : running
        : (pending ?? running);
    const row = active ?? failed ?? complete;
    return row
      ? {
          status: row.status,
          updatedAt: row.updatedAt,
          ...(row.lastError
            ? {
                error:
                  row.status === "failed"
                    ? "Account linking stopped because source and destination data could not be merged safely."
                    : "Account data is still moving and will retry automatically.",
              }
            : {}),
        }
      : null;
  },
});

export const retryMyLatestFailedOwnershipMigration = mutation({
  args: {},
  returns: v.object({ scheduled: v.boolean() }),
  handler: async (ctx) => {
    const identity = await requireConnectedUserIdentity(ctx);
    await assertSensitiveSessionPolicy(ctx, identity);
    const ownerId = identity.tokenIdentifier;
    await enforceMutationRateLimit(
      ctx,
      "ownership_migration_retry",
      ownerId,
      RATE_SENSITIVE,
      "Too many ownership migration retries. Please wait and try again.",
    );
    const failed = (
      await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
          q.eq("toOwnerId", ownerId).eq("status", "failed"),
        )
        .order("desc")
        .take(1)
    )[0];
    if (!failed) return { scheduled: false };
    const now = Date.now();
    if (failed.updatedAt + OWNERSHIP_MIGRATION_FAILED_RETRY_COOLDOWN_MS > now) {
      return { scheduled: false };
    }
    await ctx.db.patch(failed._id, {
      status: "pending",
      leaseId: undefined,
      leaseExpiresAt: undefined,
      watchdogId: undefined,
      lastError: undefined,
      completedAt: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.auth_migration.migrateOwnership, {
      fromOwnerId: failed.fromOwnerId,
      toOwnerId: failed.toOwnerId,
    });
    return { scheduled: true };
  },
});

export const listCloudConversationTransferBatch = internalQuery({
  args: ownerArgs,
  returns: cloudTransferBatchReturn,
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return [];
    // An in-progress fork has already bound its target DO before the target is
    // published in `cloud_conversations`. Its owner-indexed edit receipt is
    // therefore the only locator migration can use. Transfer every such target
    // before ordinary source conversations; the commit mutation moves the
    // locator to the destination generation only after this DO handshake.
    const editTarget = (
      await ctx.db
        .query("cloud_conversation_edits")
        .withIndex("by_ownerId_and_targetConversationId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).gt("targetConversationId", ""),
        )
        .take(1)
    )[0];
    if (editTarget?.targetConversationId) {
      const [conversation, tombstone] = await Promise.all([
        ctx.db
          .query("cloud_conversations")
          .withIndex("by_conversationId", (q) =>
            q.eq("conversationId", editTarget.targetConversationId!),
          )
          .unique(),
        ctx.db
          .query("cloud_conversation_tombstones")
          .withIndex("by_conversationId", (q) =>
            q.eq("conversationId", editTarget.targetConversationId!),
          )
          .unique(),
      ]);
      return [
        {
          conversationId: editTarget.targetConversationId,
          deleted: conversation?.deletedAt !== undefined || tombstone !== null,
          purged: conversation?.purgedAt !== undefined || tombstone !== null,
        },
      ];
    }
    const conversations = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(1);
    return conversations.map((conversation) => ({
      conversationId: conversation.conversationId,
      deleted: conversation.deletedAt !== undefined,
      purged: conversation.purgedAt !== undefined,
    }));
  },
});

const cloudProductStageValidator = v.union(
  v.literal("owner-namespaces"),
  v.literal("apps"),
  v.literal("interior"),
  v.literal("projects"),
  v.literal("core"),
  v.literal("complete"),
);
type CloudProductStage =
  | "owner-namespaces"
  | "apps"
  | "interior"
  | "projects"
  | "core"
  | "complete";

const externalTransferAckValidator = v.object({
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
});

/** Exact action-side callback fence for expired external-media reservations. */
export const assertExternalMediaMigrationLeaseInternal = internalMutation({
  args: {
    ...ownerArgs,
    migrationId: v.string(),
    leaseId: v.string(),
    leaseGeneration: v.number(),
    fromOwnerGeneration: v.string(),
    toOwnerGeneration: v.string(),
    planRevision: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
      leaseId: args.leaseId,
      leaseGeneration: args.leaseGeneration,
      leaseNow: args.now,
    });
    if (
      String(migration._id) !== args.migrationId ||
      migration.fromOwnerGeneration !== args.fromOwnerGeneration ||
      migration.toOwnerGeneration !== args.toOwnerGeneration ||
      (migration.planRevision ?? 1) !== args.planRevision
    ) {
      throw new ConvexError({
        code: "STALE_OWNERSHIP_MIGRATION_LEASE",
        message: "External-media cleanup no longer owns the migration lease.",
      });
    }
    return null;
  },
});

export const getReadyExternalTransferAck = internalQuery({
  args: ownerArgs,
  returns: v.union(v.null(), externalTransferAckValidator),
  handler: async (ctx, args) => {
    const migration = await loadSingleSourceMigration(ctx, args);
    const ack = migration?.externalTransferAck;
    return ack?.ready ? ack : null;
  },
});

export const clearReadyExternalTransferAck = internalMutation({
  args: {
    ...leasedOwnerArgs,
    transferOperationId: v.string(),
    transferPlanFingerprint: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const ack = migration.externalTransferAck;
    if (!ack) return true;
    if (
      !ack.ready ||
      ack.transferOperationId !== args.transferOperationId ||
      ack.transferPlanFingerprint !== args.transferPlanFingerprint
    ) {
      return false;
    }
    await ctx.db.patch(migration._id, { externalTransferAck: undefined });
    return true;
  },
});

const cloudProductWorkReturn = v.union(
  v.object({
    kind: v.literal("owner-namespaces"),
    driveImportedWorkspace: v.string(),
    driveImportedProjectId: v.string(),
    stellaImportedWorkspace: v.string(),
    stellaImportedProjectId: v.string(),
  }),
  v.object({
    kind: v.literal("app"),
    appId: v.string(),
    slug: v.string(),
    importedWorkspace: v.string(),
    importedProjectId: v.string(),
  }),
  v.object({ kind: v.literal("interior") }),
  v.object({
    kind: v.literal("project"),
    projectId: v.string(),
    fromWorkspace: v.string(),
    toWorkspace: v.string(),
    targetSlug: v.string(),
    importedWorkspace: v.string(),
  }),
  v.object({
    kind: v.literal("advance"),
    stage: cloudProductStageValidator,
    nextStage: cloudProductStageValidator,
  }),
  v.object({ kind: v.literal("core") }),
  v.object({ kind: v.literal("complete") }),
);

const importedWorkspacePlan = async (
  ctx: Pick<QueryCtx, "db">,
  args: {
    fromOwnerId: string;
    toOwnerId: string;
    sourceWorkspace: string;
    baseSlug: string;
    reuseProjectId?: string;
  },
): Promise<{ workspace: string; projectId: string }> => {
  const identity = await hashSha256Hex(
    `${args.fromOwnerId}:${args.sourceWorkspace}`,
  );
  const projectId =
    args.reuseProjectId ?? `prj-import-${identity.slice(0, 16)}`;
  if (!args.reuseProjectId) {
    const existing = await ctx.db
      .query("cloud_projects")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .unique();
    if (existing) {
      if (existing.ownerId !== args.toOwnerId) {
        throw new Error("Imported workspace project identity is already used.");
      }
      return { workspace: `project:${existing.slug}`, projectId };
    }
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const slug = importedProjectSlug(args.baseSlug, identity, attempt);
    const occupied = await ctx.db
      .query("cloud_projects")
      .withIndex("by_ownerId_and_slug", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("slug", slug),
      )
      .unique();
    if (!occupied) return { workspace: `project:${slug}`, projectId };
  }
  throw new Error("No collision-safe imported project workspace is available.");
};

/**
 * One bounded cloud-product unit per action pass. The migration row is the
 * cursor: it advances only after the worker copy and Convex rekey both return.
 */
export const getCloudProductTransferWork = internalQuery({
  args: ownerArgs,
  returns: cloudProductWorkReturn,
  handler: async (ctx, args) => {
    const migration = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q.eq("fromOwnerId", args.fromOwnerId).eq("toOwnerId", args.toOwnerId),
      )
      .unique();
    const stage: CloudProductStage =
      migration?.cloudProductStage ?? "owner-namespaces";
    if (stage === "owner-namespaces") {
      const [driveImport, stellaImport] = await Promise.all([
        importedWorkspacePlan(ctx, {
          ...args,
          sourceWorkspace: "drive",
          baseSlug: "anonymous-drive",
        }),
        importedWorkspacePlan(ctx, {
          ...args,
          sourceWorkspace: "stella",
          baseSlug: "anonymous-stella",
        }),
      ]);
      return {
        kind: "owner-namespaces",
        driveImportedWorkspace: driveImport.workspace,
        driveImportedProjectId: driveImport.projectId,
        stellaImportedWorkspace: stellaImport.workspace,
        stellaImportedProjectId: stellaImport.projectId,
      } as const;
    }
    if (stage === "apps") {
      const app = (
        await ctx.db
          .query("cloud_apps")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", args.fromOwnerId),
          )
          .take(1)
      )[0];
      if (app) {
        const imported = await importedWorkspacePlan(ctx, {
          ...args,
          sourceWorkspace: `app:${app.slug}`,
          baseSlug: `${app.slug}-workspace`,
        });
        return {
          kind: "app",
          appId: app.appId,
          slug: app.slug,
          importedWorkspace: imported.workspace,
          importedProjectId: imported.projectId,
        } as const;
      }
      return {
        kind: "advance",
        stage,
        nextStage: "interior",
      } as const;
    }
    if (stage === "interior") {
      const deployment = await ctx.db
        .query("cloud_interior_deployables")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .unique();
      const build = (
        await ctx.db
          .query("cloud_interior_builds")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", args.fromOwnerId),
          )
          .take(1)
      )[0];
      return deployment || build
        ? ({ kind: "interior" } as const)
        : ({
            kind: "advance",
            stage,
            nextStage: "projects",
          } as const);
    }
    if (stage === "projects") {
      const project = (
        await ctx.db
          .query("cloud_projects")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", args.fromOwnerId),
          )
          .take(1)
      )[0];
      if (!project) {
        return {
          kind: "advance",
          stage,
          nextStage: "core",
        } as const;
      }
      const collision = await ctx.db
        .query("cloud_projects")
        .withIndex("by_ownerId_and_slug", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("slug", project.slug),
        )
        .unique();
      let targetSlug = project.slug;
      if (collision) {
        let available: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedProjectSlug(
            project.slug,
            project.projectId,
            attempt,
          );
          const occupied = await ctx.db
            .query("cloud_projects")
            .withIndex("by_ownerId_and_slug", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("slug", candidate),
            )
            .unique();
          if (!occupied) {
            available = candidate;
            break;
          }
        }
        if (!available) {
          throw new Error(
            "No collision-safe destination slug is available for this project.",
          );
        }
        targetSlug = available;
      }
      const imported = await importedWorkspacePlan(ctx, {
        ...args,
        sourceWorkspace: `project:${project.slug}`,
        baseSlug: `${targetSlug}-checkpoint`,
        reuseProjectId: project.projectId,
      });
      return {
        kind: "project",
        projectId: project.projectId,
        fromWorkspace: `project:${project.slug}`,
        toWorkspace: `project:${targetSlug}`,
        targetSlug,
        importedWorkspace: imported.workspace,
      } as const;
    }
    if (stage === "core") return { kind: "core" } as const;
    return { kind: "complete" } as const;
  },
});

const ownerNamespaceBlockerReturn = v.union(v.null(), v.string());

type MemoryMigrationState = {
  sourceLifecycle: Doc<"cloud_memory_lifecycles"> | null;
  destinationLifecycle: Doc<"cloud_memory_lifecycles"> | null;
  sourceWipeJob: Doc<"cloud_memory_wipe_jobs"> | null;
  destinationWipeJob: Doc<"cloud_memory_wipe_jobs"> | null;
  targetEpoch: string;
  blocker: string | null;
};

/**
 * Memory epochs are opaque capabilities, not counters. Account linking must
 * never guess an ordering between them: an existing destination epoch wins,
 * otherwise the source epoch moves with its data, and two legacy owners stay
 * on the implicit `legacy` epoch. A live wipe on either principal is a hard
 * transfer barrier because its object sweep and metadata phase deliberately
 * span multiple transactions.
 */
const inspectMemoryMigrationState = async (
  ctx: Pick<QueryCtx, "db">,
  args: OwnerIds,
): Promise<MemoryMigrationState> => {
  const [
    sourceLifecycle,
    destinationLifecycle,
    sourceWipeJob,
    destinationWipeJob,
  ] = await Promise.all([
    ctx.db
      .query("cloud_memory_lifecycles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique(),
    ctx.db
      .query("cloud_memory_lifecycles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .unique(),
    ctx.db
      .query("cloud_memory_wipe_jobs")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique(),
    ctx.db
      .query("cloud_memory_wipe_jobs")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .unique(),
  ]);
  let blocker: string | null = null;
  if (sourceLifecycle?.state === "wiping") {
    blocker = "The anonymous identity has a Memory wipe in progress.";
  } else if (destinationLifecycle?.state === "wiping") {
    blocker = "The connected identity has a Memory wipe in progress.";
  } else if (sourceWipeJob && sourceWipeJob.stage !== "completed") {
    blocker = "The anonymous identity has unfinished Memory wipe debt.";
  } else if (destinationWipeJob && destinationWipeJob.stage !== "completed") {
    blocker = "The connected identity has unfinished Memory wipe debt.";
  }
  return {
    sourceLifecycle,
    destinationLifecycle,
    sourceWipeJob,
    destinationWipeJob,
    targetEpoch:
      destinationLifecycle?.epoch ?? sourceLifecycle?.epoch ?? "legacy",
    blocker,
  };
};

/**
 * Preflight the bounded anonymous namespace before any metadata is re-owned.
 * A pending upload is an incomplete protocol row, not durable product state;
 * core migration cancels it and schedules guarded object cleanup. Agent-home
 * bytes are moved by cloud-builder, while Drive files keep their exact
 * immutable @convex-dev/r2 keys and only their Convex rows change owner.
 */
export const getOwnerNamespaceTransferBlocker = internalQuery({
  args: ownerArgs,
  returns: ownerNamespaceBlockerReturn,
  handler: async (ctx, args) => {
    const memory = await inspectMemoryMigrationState(ctx, args);
    if (memory.blocker) return memory.blocker;
    const browserInteraction = (
      await ctx.db
        .query("cloud_browser_interactions")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (browserInteraction) {
      return "The anonymous identity has a browser session that must be reset before account linking.";
    }
    const pendingUpload = (
      await ctx.db
        .query("cloud_drive_uploads")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (pendingUpload) {
      const disposition =
        ownershipMigrationTransientStateDisposition("cloud_drive_upload");
      if (disposition === "block") {
        return `A Drive upload for "${pendingUpload.path}" cannot be migrated safely.`;
      }
    }
    return null;
  },
});

export const advanceCloudProductTransferStage = internalMutation({
  args: {
    ...leasedOwnerArgs,
    stage: cloudProductStageValidator,
    nextStage: cloudProductStageValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const current = migration.cloudProductStage ?? "owner-namespaces";
    if (current !== args.stage) return current === args.nextStage;
    await ctx.db.patch(migration._id, { cloudProductStage: args.nextStage });
    return true;
  },
});

export const claimOwnershipMigration = internalMutation({
  args: {
    ...ownerArgs,
    leaseId: v.string(),
    expectedLeaseGeneration: v.optional(v.number()),
    now: v.number(),
  },
  returns: v.object({
    claimed: v.boolean(),
    terminal: v.boolean(),
    migrationId: v.optional(v.id("auth_owner_migrations")),
    leaseGeneration: v.optional(v.number()),
    fromOwnerGeneration: v.optional(v.string()),
    toOwnerGeneration: v.optional(v.string()),
    planRevision: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    if (await hasMinimizedOwnershipSourceTombstone(ctx, args.fromOwnerId)) {
      return { claimed: false, terminal: true };
    }
    const existing = await loadSingleSourceMigration(ctx, args);
    // Every current scheduler is published in the same transaction as the
    // pending source fence. A marker-less invocation can only be a delayed
    // pre-marker job (or an invalid internal call); recreating the row here
    // would let it cross a completed reset and bind the owner's new lifecycle
    // generation. Fail closed instead.
    if (!existing) {
      return { claimed: false, terminal: true };
    }
    if (existing.status === "complete" || existing.status === "failed") {
      return { claimed: false, terminal: true };
    }
    if (args.expectedLeaseGeneration !== undefined) {
      if (
        !existing ||
        existing.status !== "running" ||
        existing.leaseGeneration !== args.expectedLeaseGeneration ||
        (existing.leaseExpiresAt ?? 0) > args.now
      ) {
        return { claimed: false, terminal: false };
      }
    } else if (existing.status !== "pending") {
      return { claimed: false, terminal: false };
    }
    let ownerGenerations: MigrationOwnerGenerations;
    try {
      const current = await readMigrationOwnerGenerations(ctx, args);
      if (
        (existing.fromOwnerGeneration !== undefined &&
          existing.fromOwnerGeneration !== current.fromOwnerGeneration) ||
        (existing.toOwnerGeneration !== undefined &&
          existing.toOwnerGeneration !== current.toOwnerGeneration)
      ) {
        throw new ConvexError({
          code: "OWNER_DATA_GENERATION_STALE",
          message:
            "The account data generation changed during account linking.",
        });
      }
      ownerGenerations = {
        fromOwnerGeneration:
          existing.fromOwnerGeneration ?? current.fromOwnerGeneration,
        toOwnerGeneration:
          existing.toOwnerGeneration ?? current.toOwnerGeneration,
      };
    } catch (error) {
      const code = convexErrorCode(error);
      if (
        code !== "OWNER_DATA_PURGE_ACTIVE" &&
        code !== "OWNER_DATA_GENERATION_STALE"
      ) {
        throw error;
      }
      await ctx.db.patch(existing._id, {
        status: "failed",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        watchdogId: undefined,
        lastError:
          "Account linking stopped because source or destination account data changed.",
        updatedAt: args.now,
      });
      return { claimed: false, terminal: true };
    }
    const leaseGeneration = (existing.leaseGeneration ?? 0) + 1;
    const planRevision = existing.planRevision ?? 1;
    const leaseExpiresAt = args.now + OWNERSHIP_MIGRATION_LEASE_MS;
    const watchdogId = await ctx.scheduler.runAfter(
      OWNERSHIP_MIGRATION_LEASE_MS + 5_000,
      internal.auth_migration.migrateOwnership,
      {
        fromOwnerId: args.fromOwnerId,
        toOwnerId: args.toOwnerId,
        expectedLeaseGeneration: leaseGeneration,
      },
    );
    await ctx.db.patch(existing._id, {
      status: "running",
      leaseId: args.leaseId,
      leaseGeneration,
      ...ownerGenerations,
      planRevision,
      leaseExpiresAt,
      watchdogId,
      lastError: undefined,
      updatedAt: args.now,
    });
    // Crash recovery is scheduled while the lease acquisition transaction is
    // still durable. It cannot overlap healthy work because the lease outlives
    // every bounded pass; after a crash it is the wake that claims the expired
    // row and resumes.
    return {
      claimed: true,
      terminal: false,
      migrationId: existing._id,
      leaseGeneration,
      ...ownerGenerations,
      planRevision,
    };
  },
});

/**
 * Stripe creates are durable replay authorities rather than ordinary request
 * leases. Fence and reconcile both principals before any owner-scoped receipt
 * moves so an old response cannot be rejected after the generation transfer
 * and retried as a second provider resource.
 */
export const quiesceStripeOperationsForOwnershipMigration = internalMutation({
  args: leasedOwnerArgs,
  returns: v.object({
    ready: v.boolean(),
    pending: v.array(v.string()),
    retryAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const results: StripeOperationQuiescenceResult[] = [];
    for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
      results.push(
        await quiesceOwnerStripeOperations(ctx, {
          ownerId,
          now: args.leaseNow,
        }),
      );
    }
    const pending = [...new Set(results.flatMap((result) => result.pending))];
    const retryTimes = results
      .map((result) => result.retryAt)
      .filter((retryAt): retryAt is number => retryAt !== null);
    return {
      ready: pending.length === 0,
      pending,
      retryAt: retryTimes.length === 0 ? null : Math.min(...retryTimes),
    };
  },
});

/**
 * Migration quiescence for physical managed-provider attempts. The pending
 * migration row already fences both owners; this exact lease mutation waits
 * for pre-fence transports through their hard quiescence boundary and removes
 * terminal/transient receipts rather than rebinding spend to the destination.
 */
export const quiesceManagedDispatchesForOwnershipMigration = internalMutation({
  args: leasedOwnerArgs,
  returns: v.object({ ready: v.boolean(), pending: v.array(v.string()) }),
  handler: async (ctx, args) => {
    await requireActiveOwnershipMigrationLease(ctx, args);
    const pending = new Set<string>();
    for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
      const rows = await ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH_SIZE);
      if (rows.length === BATCH_SIZE) {
        pending.add("billing_managed_dispatch_leases");
      }
      for (const row of rows) {
        if (
          (row.state === "active" ||
            managedDispatchOutcomeRequiresQuiescence(row.outcome)) &&
          row.quiescentAfterAt > args.leaseNow
        ) {
          pending.add("billing_managed_dispatch_leases");
          continue;
        }
        if (managedDispatchHasPendingBilling(row)) {
          const outcome =
            row.state === "terminal" && row.outcome
              ? row.outcome
              : row.billing?.providerState === "may_have_dispatched"
                ? "outcome_unknown"
                : "aborted";
          await finalizeManagedDispatchBillingFromReceipt(
            ctx,
            row,
            outcome,
            args.leaseNow,
          );
        }
        await ctx.db.delete(row._id);
      }
      const executionRows = await ctx.db
        .query("billing_managed_execution_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH_SIZE);
      if (executionRows.length === BATCH_SIZE) {
        pending.add("billing_managed_execution_leases");
      }
      for (const row of executionRows) {
        if (row.state === "active" && row.quiescentAfterAt > args.leaseNow) {
          pending.add("billing_managed_execution_leases");
          continue;
        }
        await ctx.db.delete(row._id);
      }
    }
    for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
      const [dispatch, execution, usage] = await Promise.all([
        ctx.db
          .query("billing_managed_dispatch_leases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
        ctx.db
          .query("billing_managed_execution_leases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
        ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
      ]);
      if (dispatch) pending.add("billing_managed_dispatch_leases");
      if (execution) pending.add("billing_managed_execution_leases");
      if ((usage?.activeReservedMicroCents ?? 0) !== 0) {
        pending.add("billing_usage_reservations");
      }
    }
    return {
      ready: pending.size === 0,
      pending: [...pending].sort(),
    };
  },
});

/**
 * Session creation is a provider write whose response can be lost after the
 * migration fence lands. Resolve definitively pre-dispatch reservations,
 * retain unknown provider outcomes, and finish known-locator cleanup for both
 * principals before any integration locator or product ownership moves.
 */
export const quiesceComposioProvisioningForOwnershipMigration =
  internalMutation({
    args: leasedOwnerArgs,
    returns: v.object({
      ready: v.boolean(),
      pending: v.array(v.string()),
      retryAt: v.union(v.number(), v.null()),
    }),
    handler: async (ctx, args) => {
      await requireActiveOwnershipMigrationLease(ctx, args);
      const results = [];
      for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
        results.push(
          await quiesceOwnerComposioSessionProvisioning(ctx, {
            ownerId,
            now: args.leaseNow,
          }),
        );
      }
      const pending = [...new Set(results.flatMap((result) => result.pending))]
        .sort()
        .slice(0, 24);
      const retryTimes = results
        .map((result) => result.retryAt)
        .filter((at): at is number => at !== null);
      return {
        ready: results.every((result) => result.ready),
        pending,
        retryAt: retryTimes.length === 0 ? null : Math.min(...retryTimes),
      };
    },
  });

const clearMigratingRemoteTurnAttemptPatch = () => ({
  activeAttemptId: undefined,
  activeAttemptSource: undefined,
  activeAttemptDeviceId: undefined,
  activeAttemptState: undefined,
  activeAttemptPhase: undefined,
  attemptStartedAt: undefined,
  attemptLastHeartbeatAt: undefined,
  attemptLeaseExpiresAt: undefined,
  attemptHardExpiresAt: undefined,
  attemptQuiescentAfterAt: undefined,
  attemptCleanupJobId: undefined,
  attemptCancelRequestedAt: undefined,
});

type RemoteTurnRetirement = {
  retired: boolean;
  waitingUntil: number | null;
  payloadMore: boolean;
  providerDispatchCount: number;
  digestMaterial?: string;
};

/**
 * Cancel one source-bound remote execution and delete its durable authority
 * only after the exact attempt ACKs or its immutable transport+grace boundary
 * elapses. Payload locators go first; the event (and its conversation count)
 * goes last in the same transaction.
 */
const retireRemoteTurnForOwnershipMigration = async (
  ctx: MutationCtx,
  request: Doc<"events">,
  args: { now: number },
): Promise<RemoteTurnRetirement> => {
  if (request.type !== "remote_turn_request") {
    return {
      retired: false,
      waitingUntil: null,
      payloadMore: false,
      providerDispatchCount: 0,
    };
  }

  if (request.activeAttemptId) {
    const quiescentAfterAt =
      request.attemptQuiescentAfterAt ??
      Math.max(
        args.now + REMOTE_TURN_PROVIDER_DEADLINE_MS,
        request.attemptLeaseExpiresAt ?? args.now,
        request.attemptHardExpiresAt ?? args.now,
      ) + REMOTE_TURN_QUIESCENCE_GRACE_MS;
    if (args.now < quiescentAfterAt) {
      if (
        request.activeAttemptState !== "cancel_requested" ||
        request.requestState !== "cancelled" ||
        request.requestTerminalReason !== "ownership_migrated"
      ) {
        if (request.attemptCleanupJobId) {
          await ctx.scheduler.cancel(request.attemptCleanupJobId);
        }
        if (!request.requestId) {
          throw new ConvexError({
            code: "REMOTE_TURN_MIGRATION_CORRUPT",
            message: "An active remote execution is missing its request id.",
          });
        }
        const cleanupJobId = await ctx.scheduler.runAt(
          quiescentAfterAt,
          internal.channels.connector_delivery.expireRemoteTurnAttemptInternal,
          {
            requestId: request.requestId,
            attemptId: request.activeAttemptId,
            quiescentAfterAt,
          },
        );
        await ctx.db.patch(request._id, {
          requestState: "cancelled",
          cancelledAt: request.cancelledAt ?? args.now,
          requestTerminalReason: "ownership_migrated",
          activeAttemptState: "cancel_requested",
          attemptCancelRequestedAt: args.now,
          attemptQuiescentAfterAt: quiescentAfterAt,
          attemptCleanupJobId: cleanupJobId,
        });
      }
      return {
        retired: false,
        waitingUntil: quiescentAfterAt,
        payloadMore: false,
        providerDispatchCount: 0,
      };
    }
    if (request.attemptCleanupJobId) {
      await ctx.scheduler.cancel(request.attemptCleanupJobId);
    }
  }

  if (request.requestId) {
    const payloads = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_requestId", (q) => q.eq("requestId", request.requestId!))
      .take(REMOTE_TURN_PER_CONVERSATION_BATCH);
    for (const payload of payloads) await ctx.db.delete(payload._id);
    if (payloads.length === REMOTE_TURN_PER_CONVERSATION_BATCH) {
      if (request.activeAttemptId) {
        await ctx.db.patch(request._id, {
          ...clearMigratingRemoteTurnAttemptPatch(),
          requestState: "cancelled",
          cancelledAt: request.cancelledAt ?? args.now,
          requestTerminalReason: "ownership_migrated",
          lastAttemptId: request.activeAttemptId,
          lastAttemptOutcome: "timed_out",
          lastAttemptFinishedAt: args.now,
        });
      } else if (request.requestTerminalReason !== "ownership_migrated") {
        await ctx.db.patch(request._id, {
          requestState: "cancelled",
          cancelledAt: request.cancelledAt ?? args.now,
          requestTerminalReason: "ownership_migrated",
        });
      }
      return {
        retired: false,
        waitingUntil: null,
        payloadMore: true,
        providerDispatchCount: 0,
      };
    }
  }

  const conversation = await ctx.db.get(request.conversationId);
  if (conversation) {
    await ctx.db.patch(conversation._id, {
      eventCount: Math.max(0, conversation.eventCount - 1),
    });
  }
  const digestMaterial = JSON.stringify({
    eventId: String(request._id),
    requestId: request.requestId ?? null,
    ownerGeneration: request.ownerGeneration ?? null,
    attemptOutcome: request.lastAttemptOutcome ?? null,
    providerDispatchCount: request.providerDispatchCount ?? 0,
    providerOutcome: request.lastProviderDispatchOutcome ?? null,
  });
  await ctx.db.delete(request._id);
  return {
    retired: true,
    waitingUntil: null,
    payloadMore: false,
    providerDispatchCount: request.providerDispatchCount ?? 0,
    digestMaterial,
  };
};

const recordRemoteTurnMigrationAudit = async (
  ctx: MutationCtx,
  migration: Doc<"auth_owner_migrations">,
  retired: RemoteTurnRetirement[],
): Promise<void> => {
  const completed = retired.filter(
    (row): row is RemoteTurnRetirement & { digestMaterial: string } =>
      row.retired && row.digestMaterial !== undefined,
  );
  if (completed.length === 0) return;
  let digest = migration.remoteTurnOutcomeDigest ?? "";
  for (const row of completed) {
    digest = await hashSha256Hex(`${digest}\0${row.digestMaterial}`);
  }
  await ctx.db.patch(migration._id, {
    remoteTurnRetiredCount:
      (migration.remoteTurnRetiredCount ?? 0) + completed.length,
    remoteTurnProviderDispatchCount:
      (migration.remoteTurnProviderDispatchCount ?? 0) +
      completed.reduce((sum, row) => sum + row.providerDispatchCount, 0),
    remoteTurnOutcomeDigest: digest,
  });
};

/**
 * Source remote-turn migration policy is fail-closed: pending/claimed rows are
 * cancelled, never rebound. Bound rows use their immutable owner index;
 * legacy/unbound rows are found through a crash-resumable source-conversation
 * scan. No conversation transfer may run until this returns ready.
 */
export const quiesceRemoteTurnsForOwnershipMigration = internalMutation({
  args: leasedOwnerArgs,
  returns: v.object({
    ready: v.boolean(),
    processed: v.number(),
    retryAfterAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const byState = await Promise.all(
      (["pending", "claimed", "fulfilled", "cancelled"] as const).map(
        async (requestState) =>
          await ctx.db
            .query("events")
            .withIndex("by_ownerId_requestState", (q) =>
              q
                .eq("ownerId", args.fromOwnerId)
                .eq("requestState", requestState),
            )
            .take(REMOTE_TURN_MIGRATION_BATCH),
      ),
    );
    const boundRows = [
      ...new Map(
        byState
          .flat()
          .filter((row) => row.type === "remote_turn_request")
          .map((row) => [String(row._id), row]),
      ).values(),
    ].slice(0, REMOTE_TURN_MIGRATION_BATCH);
    if (boundRows.length > 0) {
      const results: RemoteTurnRetirement[] = [];
      for (const row of boundRows) {
        results.push(
          await retireRemoteTurnForOwnershipMigration(ctx, row, {
            now: args.leaseNow,
          }),
        );
      }
      await recordRemoteTurnMigrationAudit(ctx, migration, results);
      const waits = results
        .map((row) => row.waitingUntil)
        .filter((at): at is number => at !== null);
      return {
        ready: false,
        processed: boundRows.length,
        retryAfterAt: waits.length > 0 ? Math.min(...waits) : null,
      };
    }

    if (migration.remoteTurnConversationScanComplete === true) {
      return { ready: true, processed: 0, retryAfterAt: null };
    }
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .paginate({
        cursor: migration.remoteTurnConversationCursor ?? null,
        numItems: REMOTE_TURN_CONVERSATION_PAGE,
      });
    const results: RemoteTurnRetirement[] = [];
    let pageMustReplay = false;
    for (const conversation of page.page) {
      const requests = await ctx.db
        .query("events")
        .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
          q
            .eq("conversationId", conversation._id)
            .eq("type", "remote_turn_request"),
        )
        .take(REMOTE_TURN_PER_CONVERSATION_BATCH);
      if (requests.length === REMOTE_TURN_PER_CONVERSATION_BATCH) {
        pageMustReplay = true;
      }
      for (const request of requests) {
        const result = await retireRemoteTurnForOwnershipMigration(
          ctx,
          request,
          { now: args.leaseNow },
        );
        results.push(result);
        pageMustReplay ||= !result.retired;
      }
    }
    await recordRemoteTurnMigrationAudit(ctx, migration, results);
    const waits = results
      .map((row) => row.waitingUntil)
      .filter((at): at is number => at !== null);
    if (pageMustReplay) {
      return {
        ready: false,
        processed: results.length,
        retryAfterAt: waits.length > 0 ? Math.min(...waits) : null,
      };
    }
    await ctx.db.patch(migration._id, {
      remoteTurnConversationCursor: page.isDone
        ? undefined
        : page.continueCursor,
      remoteTurnConversationScanComplete: page.isDone ? true : undefined,
    });
    return {
      ready: page.isDone,
      processed: results.length,
      retryAfterAt: null,
    };
  },
});

export const getMigratedSourceIdentityDeletionInternal = internalQuery({
  args: { migrationId: v.id("auth_owner_migrations") },
  returns: v.union(
    v.null(),
    v.object({
      fromOwnerId: v.string(),
      toOwnerId: v.string(),
      authUserId: v.string(),
      authUserEmail: v.optional(v.string()),
      operationId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const migration = await ctx.db.get(args.migrationId);
    if (
      !migration ||
      migration.status !== "complete" ||
      migration.sourceAuthDeletionState === "started" ||
      !migration.sourceAuthUserId ||
      !migration.sourceAuthDeletionOperationId
    ) {
      return null;
    }
    return {
      fromOwnerId: migration.fromOwnerId,
      toOwnerId: migration.toOwnerId,
      authUserId: migration.sourceAuthUserId,
      authUserEmail: migration.sourceAuthUserEmail,
      operationId: migration.sourceAuthDeletionOperationId,
    };
  },
});

export const recordMigratedSourceIdentityDeletionInternal = internalMutation({
  args: {
    migrationId: v.id("auth_owner_migrations"),
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
    authUserId: v.string(),
    requestedOperationId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const [migration, lifecycle, job, finalizer] = await Promise.all([
      ctx.db.get(args.migrationId),
      ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .unique(),
      ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .unique(),
      ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .unique(),
    ]);
    if (
      !migration ||
      migration.status !== "complete" ||
      migration.fromOwnerId !== args.fromOwnerId ||
      migration.toOwnerId !== args.toOwnerId ||
      migration.sourceAuthUserId !== args.authUserId ||
      migration.sourceAuthDeletionOperationId !== args.requestedOperationId ||
      lifecycle?.state !== "deleting" ||
      lifecycle.operationId !== args.operationId ||
      lifecycle.generation !== args.generation ||
      job?.mode !== "delete" ||
      job.operationId !== args.operationId ||
      job.generation !== args.generation ||
      finalizer?.authUserId !== args.authUserId ||
      finalizer.operationId !== args.operationId ||
      finalizer.generation !== args.generation
    ) {
      return false;
    }
    await ctx.db.patch(migration._id, {
      sourceAuthDeletionOperationId: args.operationId,
      sourceAuthDeletionState: "started",
      sourceAuthDeletionStartedAt: args.now,
      updatedAt: args.now,
    });
    return true;
  },
});

/**
 * Durable post-link handoff. The migration row is only a locator until the
 * permanent source lifecycle/job and Better Auth finalizer exist together;
 * after that point the ordinary purge retry sweeps own convergence.
 */
export const finalizeMigratedSourceIdentityInternal = internalAction({
  args: { migrationId: v.id("auth_owner_migrations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const locator = await ctx.runQuery(
      internal.auth_migration.getMigratedSourceIdentityDeletionInternal,
      args,
    );
    if (!locator) return null;
    const fence = await ctx.runMutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: locator.fromOwnerId,
        operationId: locator.operationId,
        mode: "delete",
        authUserId: locator.authUserId,
        authUserEmail: locator.authUserEmail,
        now: Date.now(),
      },
    );
    const recorded = await ctx.runMutation(
      internal.auth_migration.recordMigratedSourceIdentityDeletionInternal,
      {
        migrationId: args.migrationId,
        fromOwnerId: locator.fromOwnerId,
        toOwnerId: locator.toOwnerId,
        authUserId: locator.authUserId,
        requestedOperationId: locator.operationId,
        operationId: fence.operationId,
        generation: fence.generation,
        now: Date.now(),
      },
    );
    if (!recorded) return null;
    await ctx.runAction(purgeMigratedSourceOwnerRef, {
      ownerId: locator.fromOwnerId,
      operationId: fence.operationId,
      generation: fence.generation,
    });
    return null;
  },
});

export const listPendingMigratedSourceIdentityDeletionsInternal = internalQuery(
  {
    args: { limit: v.optional(v.number()) },
    returns: v.array(v.id("auth_owner_migrations")),
    handler: async (ctx, args) => {
      const limit = Math.min(20, Math.max(1, Math.floor(args.limit ?? 10)));
      const rows = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_status_sourceAuthDeletionState_updatedAt", (q) =>
          q.eq("status", "complete").eq("sourceAuthDeletionState", "pending"),
        )
        .take(limit);
      return rows.map((row) => row._id);
    },
  },
);

export const sweepMigratedSourceIdentityDeletionsInternal = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ attempted: v.number() }),
  handler: async (ctx, args) => {
    const migrationIds: Array<Id<"auth_owner_migrations">> = await ctx.runQuery(
      listPendingMigratedSourceIdentityDeletionsRef,
      args,
    );
    await Promise.all(
      migrationIds.map((migrationId) =>
        ctx.scheduler.runAfter(0, finalizeMigratedSourceIdentityRef, {
          migrationId,
        }),
      ),
    );
    return { attempted: migrationIds.length };
  },
});

export const cleanupOwnershipMigration = internalMutation({
  args: {
    migrationId: v.id("auth_owner_migrations"),
    terminalAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const migration = await ctx.db.get(args.migrationId);
    if (
      !migration ||
      migration.status !== "complete" ||
      migration.completedAt !== args.terminalAt
    ) {
      return null;
    }
    const sourceAuthDeletionPending = Boolean(
      migration.sourceAuthUserId &&
        migration.sourceAuthDeletionState !== "started",
    );
    if (sourceAuthDeletionPending && migration.sourceAuthDeletionOperationId) {
      await ctx.scheduler.runAfter(0, finalizeMigratedSourceIdentityRef, {
        migrationId: migration._id,
      });
    }
    const now = Date.now();
    const minimizeAt =
      args.terminalAt + OWNERSHIP_MIGRATION_COMPLETED_RAW_RETENTION_MS;
    if (now < minimizeAt) {
      await ctx.scheduler.runAfter(
        minimizeAt - now,
        internal.auth_migration.cleanupOwnershipMigration,
        args,
      );
      return null;
    }
    if (sourceAuthDeletionPending) {
      // Never discard the only raw Better Auth locator until a permanent
      // source delete job and its auth finalizer have been durably joined.
      await ctx.scheduler.runAfter(
        60_000,
        internal.auth_migration.cleanupOwnershipMigration,
        args,
      );
      return null;
    }
    const linkRequests = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_ownershipMigrationId", (q) =>
        q.eq("ownershipMigrationId", args.migrationId),
      )
      .take(AUTH_MIGRATION_PURGE_BATCH_SIZE);
    let retryAt: number | null = null;
    for (const link of linkRequests) {
      if (link.expiresAt <= now) {
        await ctx.db.delete(link._id);
      } else {
        retryAt = Math.min(retryAt ?? link.expiresAt, link.expiresAt);
      }
    }
    if (
      retryAt !== null ||
      linkRequests.length === AUTH_MIGRATION_PURGE_BATCH_SIZE
    ) {
      await ctx.scheduler.runAfter(
        retryAt === null ? 0 : Math.max(1_000, retryAt - now + 1_000),
        internal.auth_migration.cleanupOwnershipMigration,
        args,
      );
      return null;
    }
    await minimizeOperationalMigration(ctx, migration);
    return null;
  },
});

const AUTH_MIGRATION_PURGE_BATCH_SIZE = 100;

/**
 * Imported alternatives belong to the destination, but older migration passes
 * stored the raw anonymous owner id as provenance. Source purge must not delete
 * destination data; it replaces that raw locator with the same domain-separated
 * digest used by the permanent migration tombstone, in a bounded transaction.
 */
const anonymizeImportedOwnerReferences = async (
  ctx: MutationCtx,
  sourceOwnerId: string,
): Promise<boolean> => {
  const [credentials, settings] = await Promise.all([
    ctx.db
      .query("cloud_llm_credentials")
      .withIndex("by_importedFromOwnerId", (q) =>
        q.eq("importedFromOwnerId", sourceOwnerId),
      )
      .take(AUTH_MIGRATION_PURGE_BATCH_SIZE),
    ctx.db
      .query("cloud_engine_settings")
      .withIndex("by_importedFromOwnerId", (q) =>
        q.eq("importedFromOwnerId", sourceOwnerId),
      )
      .take(AUTH_MIGRATION_PURGE_BATCH_SIZE),
  ]);
  if (credentials.length === 0 && settings.length === 0) return true;
  const sourceOwnerDigest = await ownershipMigrationSourceDigest(sourceOwnerId);
  await Promise.all([
    ...credentials.map((row) =>
      ctx.db.patch(row._id, { importedFromOwnerId: sourceOwnerDigest }),
    ),
    ...settings.map((row) =>
      ctx.db.patch(row._id, { importedFromOwnerId: sourceOwnerDigest }),
    ),
  ]);
  return false;
};
const AUTH_MIGRATION_SOURCE_DEPENDENCY_BATCH_SIZE = 8;

const ownerPurgeLeaseArgs = (args: {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
  mode: "reset" | "delete";
}) => ({
  ...args,
  stage: "core" as const,
});

const listOwnerOperationalMigrations = async (
  ctx: MutationCtx,
  ownerId: string,
): Promise<Doc<"auth_owner_migrations">[]> => {
  const [asSource, asDestination] = await Promise.all([
    ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
        q.eq("fromOwnerId", ownerId),
      )
      .take(AUTH_MIGRATION_PURGE_BATCH_SIZE),
    ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_toOwnerId_and_updatedAt", (q) =>
        q.eq("toOwnerId", ownerId),
      )
      .take(AUTH_MIGRATION_PURGE_BATCH_SIZE),
  ]);
  return [
    ...new Map(
      [...asSource, ...asDestination].map((row) => [String(row._id), row]),
    ).values(),
  ].slice(0, AUTH_MIGRATION_PURGE_BATCH_SIZE);
};

const hasDurableMigratedSourceIdentityDeletionHandoff = async (
  ctx: MutationCtx,
  migration: Doc<"auth_owner_migrations">,
): Promise<boolean> => {
  if (!migration.sourceAuthUserId) return true;
  const [lifecycle, job, finalizer] = await Promise.all([
    ctx.db
      .query("cloud_owner_lifecycles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", migration.fromOwnerId))
      .unique(),
    ctx.db
      .query("cloud_owner_purge_jobs")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", migration.fromOwnerId))
      .unique(),
    ctx.db
      .query("auth_account_deletion_finalizers")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", migration.fromOwnerId))
      .unique(),
  ]);
  if (
    lifecycle?.state !== "deleting" ||
    !lifecycle.operationId ||
    job?.mode !== "delete" ||
    lifecycle.operationId !== job.operationId ||
    lifecycle.generation !== job.generation
  ) {
    return false;
  }
  if (finalizer) {
    return (
      finalizer.authUserId === migration.sourceAuthUserId &&
      finalizer.operationId === job.operationId &&
      finalizer.generation === job.generation
    );
  }
  return (
    migration.sourceAuthDeletionState === "started" && job.stage === "complete"
  );
};

async function minimizeOperationalMigration(
  ctx: MutationCtx,
  migration: Doc<"auth_owner_migrations">,
): Promise<void> {
  if (
    !(await hasDurableMigratedSourceIdentityDeletionHandoff(ctx, migration))
  ) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATION_SOURCE_AUTH_DELETE_PENDING",
      message:
        "The migrated anonymous auth principal has not entered durable deletion.",
    });
  }
  const sourceOwnerDigest = await ownershipMigrationSourceDigest(
    migration.fromOwnerId,
  );
  const tombstone = (
    await ctx.db
      .query("auth_owner_migration_tombstones")
      .withIndex("by_sourceOwnerDigest", (q) =>
        q.eq("sourceOwnerDigest", sourceOwnerDigest),
      )
      .take(1)
  )[0];
  if (!tombstone) {
    await ctx.db.insert("auth_owner_migration_tombstones", {
      sourceOwnerDigest,
    });
  }
  if (migration.watchdogId) {
    await ctx.scheduler.cancel(migration.watchdogId);
  }
  await ctx.db.delete(migration._id);
}

/**
 * Destination reset/deletion dependency seam.
 *
 * A pending/running/failed A -> B migration can have product state split
 * across both owners. B's purge must permanently purge A before erasing this
 * mapping. Completed edges are excluded because completion is committed only
 * after the exhaustive source residue audit passes.
 *
 * Sources already under another purge are returned separately. The action
 * must wait rather than recursively joining them; this keeps malformed cyclic
 * migration graphs fail-closed instead of recursing forever.
 */
const drainOwnerAuthMigrationSourceDependencies = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    operationId: string;
    generation: string;
  },
): Promise<{
  sourceOwnerIds: string[];
  sourceDependencies: Array<{
    ownerId: string;
    authUserId?: string;
    authUserEmail?: string;
  }>;
  waitingSourceOwnerIds: string[];
  hasMore: boolean;
}> => {
  const limit = AUTH_MIGRATION_SOURCE_DEPENDENCY_BATCH_SIZE;
  const statuses = ["pending", "running", "failed", "complete"] as const;
  const pages = await Promise.all(
    statuses.map((status) =>
      ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
          q.eq("toOwnerId", args.ownerId).eq("status", status),
        )
        .take(limit + 1),
    ),
  );
  const candidates = pages
    .flat()
    .filter(
      (migration) =>
        migration.status !== "complete" || Boolean(migration.sourceAuthUserId),
    )
    .sort((left, right) =>
      `${left.fromOwnerId}:${String(left._id)}`.localeCompare(
        `${right.fromOwnerId}:${String(right._id)}`,
      ),
    );
  const selected = candidates.slice(0, limit);
  const states = await Promise.all(
    selected.map(async (migration) => {
      if (migration.fromOwnerId === args.ownerId) {
        return { migration, lifecycle: null, job: null };
      }
      const [lifecycle, job] = await Promise.all([
        ctx.db
          .query("cloud_owner_lifecycles")
          .withIndex("by_ownerId", (q) =>
            q.eq("ownerId", migration.fromOwnerId),
          )
          .unique(),
        ctx.db
          .query("cloud_owner_purge_jobs")
          .withIndex("by_ownerId", (q) =>
            q.eq("ownerId", migration.fromOwnerId),
          )
          .unique(),
      ]);
      return { migration, lifecycle, job };
    }),
  );
  const ready = new Set<string>();
  const readyDependencies = new Map<
    string,
    { ownerId: string; authUserId?: string; authUserEmail?: string }
  >();
  const waiting = new Set<string>();
  for (const state of states) {
    const sourceOwnerId = state.migration.fromOwnerId;
    const sourcePurgeComplete =
      state.lifecycle?.state === "deleting" &&
      state.job?.mode === "delete" &&
      state.job.stage === "complete" &&
      state.lifecycle.operationId === state.job.operationId &&
      state.lifecycle.generation === state.job.generation;
    if (sourcePurgeComplete) {
      await minimizeOperationalMigration(ctx, state.migration);
      continue;
    }
    if (
      sourceOwnerId === args.ownerId ||
      (state.lifecycle && state.lifecycle.state !== "open")
    ) {
      waiting.add(sourceOwnerId);
    } else {
      ready.add(sourceOwnerId);
      readyDependencies.set(sourceOwnerId, {
        ownerId: sourceOwnerId,
        authUserId: state.migration.sourceAuthUserId,
        authUserEmail: state.migration.sourceAuthUserEmail,
      });
    }
  }
  return {
    sourceOwnerIds: [...ready],
    sourceDependencies: [...readyDependencies.values()],
    waitingSourceOwnerIds: [...waiting],
    hasMore:
      candidates.length > limit || pages.some((page) => page.length > limit),
  };
};

const readActiveDestinationPurge = async (
  ctx: MutationCtx,
  ownerId: string,
) => {
  const [lifecycle, job] = await Promise.all([
    ctx.db
      .query("cloud_owner_lifecycles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique(),
    ctx.db
      .query("cloud_owner_purge_jobs")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique(),
  ]);
  if (
    !lifecycle ||
    lifecycle.state === "open" ||
    !lifecycle.operationId ||
    !job ||
    job.stage === "complete" ||
    lifecycle.operationId !== job.operationId ||
    lifecycle.generation !== job.generation
  ) {
    return null;
  }
  return { lifecycle, job };
};

const retainSourceMigrationForDestinationPurge = async (
  ctx: MutationCtx,
  migration: Doc<"auth_owner_migrations">,
  args: {
    ownerId: string;
    operationId: string;
    generation: string;
  },
): Promise<boolean> => {
  if (
    migration.fromOwnerId !== args.ownerId ||
    migration.status === "complete"
  ) {
    return false;
  }
  const destination = await readActiveDestinationPurge(
    ctx,
    migration.toOwnerId,
  );
  if (!destination) return false;
  if (migration.watchdogId) {
    await ctx.scheduler.cancel(migration.watchdogId);
  }
  await ctx.db.patch(migration._id, {
    status: "failed",
    leaseId: undefined,
    leaseExpiresAt: undefined,
    watchdogId: undefined,
    externalTransferAck: undefined,
    lastError:
      "Ownership migration was quiesced by linked-source data deletion.",
    sourcePurgeDependency: {
      sourceOperationId: args.operationId,
      sourceGeneration: args.generation,
      destinationOperationId: destination.job.operationId,
      destinationGeneration: destination.job.generation,
    },
    updatedAt: Date.now(),
  });
  return true;
};

const isIntentionalRetainedSourcePurgeDependency = async (
  ctx: MutationCtx,
  migration: Doc<"auth_owner_migrations">,
  args: {
    ownerId: string;
    operationId: string;
    generation: string;
  },
): Promise<boolean> => {
  const dependency = migration.sourcePurgeDependency;
  if (
    migration.fromOwnerId !== args.ownerId ||
    !dependency ||
    dependency.sourceOperationId !== args.operationId ||
    dependency.sourceGeneration !== args.generation
  ) {
    return false;
  }
  const destination = await readActiveDestinationPurge(
    ctx,
    migration.toOwnerId,
  );
  return Boolean(
    destination &&
      destination.job.operationId === dependency.destinationOperationId &&
      destination.job.generation === dependency.destinationGeneration,
  );
};

export const drainOwnerAuthMigrationSourceDependenciesInternal =
  internalMutation({
    args: ownerMigrationPurgeArgs,
    returns: v.object({
      sourceOwnerIds: v.array(v.string()),
      sourceDependencies: v.array(
        v.object({
          ownerId: v.string(),
          authUserId: v.optional(v.string()),
          authUserEmail: v.optional(v.string()),
        }),
      ),
      waitingSourceOwnerIds: v.array(v.string()),
      hasMore: v.boolean(),
    }),
    handler: async (ctx, args) => {
      await assertOwnerPurgeLease(ctx, ownerPurgeLeaseArgs(args));
      return await drainOwnerAuthMigrationSourceDependencies(ctx, args);
    },
  });

/**
 * Core-stage purge seam for operational ownership migrations.
 *
 * The caller must first establish the worker's dual-owner purge reservation;
 * this mutation then serializes against every Convex migration commit through
 * the exact purge lease/lifecycle generation. Raw operational rows are
 * replaced with source-only digest tombstones so stale anonymous JWTs and
 * delayed scheduler replays remain permanently fenced without retaining
 * either owner id or any transfer metadata. The sole temporary exception is
 * an A -> B row held while B's teardown cascades A's permanent purge; B
 * retires it only after A's durable purge job reaches `complete`.
 */
export const quiesceAndMinimizeOwnerAuthMigrationsInternal = internalMutation({
  args: ownerMigrationPurgeArgs,
  returns: v.object({
    ready: v.boolean(),
    pending: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, ownerPurgeLeaseArgs(args));
    if (!(await anonymizeImportedOwnerReferences(ctx, args.ownerId))) {
      return {
        ready: false,
        pending: ["cloud_engine_import_source_reference"],
      };
    }
    const dependencies = await drainOwnerAuthMigrationSourceDependencies(
      ctx,
      args,
    );
    if (
      dependencies.sourceOwnerIds.length > 0 ||
      dependencies.waitingSourceOwnerIds.length > 0 ||
      dependencies.hasMore
    ) {
      return {
        ready: false,
        pending: ["auth_owner_migration_source_dependencies"],
      };
    }
    const migrations = await listOwnerOperationalMigrations(ctx, args.ownerId);
    const retained = new Set<string>();
    for (const migration of migrations) {
      if (
        await retainSourceMigrationForDestinationPurge(ctx, migration, args)
      ) {
        retained.add(String(migration._id));
        continue;
      }
      await minimizeOperationalMigration(ctx, migration);
    }
    const remaining = await listOwnerOperationalMigrations(ctx, args.ownerId);
    const unhandled: typeof remaining = [];
    for (const migration of remaining) {
      if (
        retained.has(String(migration._id)) ||
        (await isIntentionalRetainedSourcePurgeDependency(ctx, migration, args))
      ) {
        continue;
      }
      unhandled.push(migration);
    }
    return unhandled.length === 0
      ? { ready: true, pending: [] }
      : { ready: false, pending: ["auth_owner_migrations"] };
  },
});

/**
 * Final core-stage readback. Intentional digest tombstones are excluded; any
 * returned label denotes raw owner identity, session-cookie, device successor,
 * or operational migration residue that must keep the purge fence closed.
 */
export const remainingOwnerAuthMigrationResidueInternal = internalMutation({
  args: ownerMigrationPurgeArgs,
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, ownerPurgeLeaseArgs(args));
    const [
      migrations,
      linksFrom,
      linksTo,
      browserHandoffs,
      successors,
      importedCredentials,
      importedSettings,
    ] = await Promise.all([
      listOwnerOperationalMigrations(ctx, args.ownerId),
      ctx.db
        .query("auth_link_requests")
        .withIndex("by_fromOwnerId_and_createdAt", (q) =>
          q.eq("fromOwnerId", args.ownerId),
        )
        .take(1),
      ctx.db
        .query("auth_link_requests")
        .withIndex("by_toOwnerId_and_createdAt", (q) =>
          q.eq("toOwnerId", args.ownerId),
        )
        .take(1),
      ctx.db
        .query("auth_browser_handoffs")
        .withIndex("by_fromOwnerId", (q) => q.eq("fromOwnerId", args.ownerId))
        .take(1),
      ctx.db
        .query("device_identity_successors")
        .withIndex("by_ownerId_and_previousDeviceId", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(1),
      ctx.db
        .query("cloud_llm_credentials")
        .withIndex("by_importedFromOwnerId", (q) =>
          q.eq("importedFromOwnerId", args.ownerId),
        )
        .take(1),
      ctx.db
        .query("cloud_engine_settings")
        .withIndex("by_importedFromOwnerId", (q) =>
          q.eq("importedFromOwnerId", args.ownerId),
        )
        .take(1),
    ]);
    const residue: string[] = [];
    let hasMigrationResidue = false;
    for (const migration of migrations) {
      if (
        !(await isIntentionalRetainedSourcePurgeDependency(
          ctx,
          migration,
          args,
        ))
      ) {
        hasMigrationResidue = true;
        break;
      }
    }
    if (hasMigrationResidue) residue.push("auth_owner_migrations");
    if (linksFrom.length > 0 || linksTo.length > 0) {
      residue.push("auth_link_requests");
    }
    if (browserHandoffs.length > 0) residue.push("auth_browser_handoffs");
    if (successors.length > 0) residue.push("device_identity_successors");
    if (importedCredentials.length > 0 || importedSettings.length > 0) {
      residue.push("cloud_engine_import_source_reference");
    }
    return residue;
  },
});

export const finishOwnershipMigrationPass = internalMutation({
  args: {
    ...ownerArgs,
    leaseId: v.string(),
    leaseGeneration: v.number(),
    outcome: v.union(
      v.literal("pending"),
      v.literal("failed"),
      v.literal("complete"),
    ),
    retryAfterMs: v.optional(v.number()),
    error: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let row: Doc<"auth_owner_migrations">;
    try {
      row = await requireActiveOwnershipMigrationLease(ctx, {
        ...args,
        leaseNow: args.now,
      });
    } catch (error) {
      if (
        error instanceof ConvexError &&
        typeof error.data === "object" &&
        error.data !== null &&
        (error.data as { code?: unknown }).code ===
          "STALE_OWNERSHIP_MIGRATION_LEASE"
      ) {
        return null;
      }
      throw error;
    }
    if (args.outcome === "pending") {
      await ctx.db.patch(row._id, {
        status: "pending",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        watchdogId: undefined,
        lastError: args.error,
        updatedAt: args.now,
      });
      if (row.watchdogId) await ctx.scheduler.cancel(row.watchdogId);
      await ctx.scheduler.runAfter(
        Math.min(60_000, Math.max(1_000, args.retryAfterMs ?? 5_000)),
        internal.auth_migration.migrateOwnership,
        {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
        },
      );
      return null;
    }
    if (
      args.outcome === "complete" &&
      ((row.cloudProductStage ?? "owner-namespaces") !== "complete" ||
        row.externalTransferAck !== undefined)
    ) {
      throw new ConvexError({
        code: "OWNERSHIP_MIGRATION_INCOMPLETE",
        message:
          "Cloud ownership stages or their durable acknowledgements have not completed.",
      });
    }
    if (args.outcome === "complete") {
      // Legacy backups are retired and deliberately do not participate in
      // account linking. Remove only an obsolete per-migration sweep receipt;
      // dormant backup rows and objects remain untouched for later cleanup.
      const backupSweep = await ctx.db
        .query("backup_legacy_r2_sweeps")
        .withIndex("by_scopeKey", (q) =>
          q.eq(
            "scopeKey",
            `migration:${encodeURIComponent(args.fromOwnerId)}:${String(row._id)}`,
          ),
        )
        .unique();
      if (backupSweep) await ctx.db.delete(backupSweep._id);
    }
    if (row.watchdogId) await ctx.scheduler.cancel(row.watchdogId);
    await ctx.db.patch(row._id, {
      status: args.outcome,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      watchdogId: undefined,
      lastError: args.error,
      ...(args.outcome === "complete" ? { completedAt: args.now } : {}),
      updatedAt: args.now,
    });
    if (args.outcome === "complete") {
      if (
        row.sourceAuthUserId &&
        row.sourceAuthDeletionOperationId &&
        row.sourceAuthDeletionState !== "started"
      ) {
        await ctx.scheduler.runAfter(0, finalizeMigratedSourceIdentityRef, {
          migrationId: row._id,
        });
      }
      await ctx.scheduler.runAfter(
        OWNERSHIP_MIGRATION_COMPLETED_RAW_RETENTION_MS,
        internal.auth_migration.cleanupOwnershipMigration,
        { migrationId: row._id, terminalAt: args.now },
      );
    }
    // Complete operational rows remain source fences until reset/deletion
    // replaces them with an opaque digest tombstone. A stale anonymous JWT
    // must never regain write access after residue audit.
    return null;
  },
});

/**
 * Moves edit control-plane locators only after the corresponding DO owner
 * transfer acknowledged. Target locators are ordered before source
 * conversations by `listCloudConversationTransferBatch`, so a partial fork's
 * target cannot be stranded under the anonymous owner while its receipt moves.
 */
const migrateConversationEditLocators = async (
  ctx: MutationCtx,
  args: OwnerIds & { conversationId: string; toOwnerGeneration: string },
): Promise<{ sourceHasMore: boolean }> => {
  const [targets, sources] = await Promise.all([
    ctx.db
      .query("cloud_conversation_edits")
      .withIndex("by_targetConversationId_and_ownerId_and_updatedAt", (q) =>
        q
          .eq("targetConversationId", args.conversationId)
          .eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE),
    ctx.db
      .query("cloud_conversation_edits")
      .withIndex("by_sourceConversationId_and_ownerId_and_updatedAt", (q) =>
        q
          .eq("sourceConversationId", args.conversationId)
          .eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE),
  ]);
  // Source-side locators with a fork target are migrated by the target pass
  // above. Rewind receipts have no target and follow their sole source DO.
  const sourceOnly = sources.filter(
    (row) => row.targetConversationId === undefined,
  );
  await Promise.all(
    [...targets, ...sourceOnly].map((row) =>
      ctx.db.patch(row._id, {
        ownerId: args.toOwnerId,
        ownerGeneration: args.toOwnerGeneration,
        updatedAt: Date.now(),
      }),
    ),
  );
  return {
    sourceHasMore:
      sources.length === CLOUD_PROJECTION_BATCH_SIZE &&
      sourceOnly.length === CLOUD_PROJECTION_BATCH_SIZE,
  };
};

/**
 * Moves a turn's durable event stream before the parent turn is re-owned.
 * The owner-qualified index is essential for retry progress: once one page is
 * patched, destination rows cannot remain at the front and starve later source
 * rows. Owner-less legacy rows are repaired here while the source turn still
 * supplies an unambiguous owner.
 */
const migrateAgentEventsForTurn = async (
  ctx: MutationCtx,
  args: OwnerIds & { turnId: string },
): Promise<{ sourceHasMore: boolean }> => {
  const [sourceEvents, ownerlessEvents] = await Promise.all([
    ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_ownerId_and_seq", (q) =>
        q.eq("turnId", args.turnId).eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE),
    ctx.db
      .query("agent_events")
      .withIndex("by_turnId_and_ownerId_and_seq", (q) =>
        q.eq("turnId", args.turnId).eq("ownerId", undefined),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE),
  ]);
  await Promise.all(
    [...sourceEvents, ...ownerlessEvents].map((event) =>
      ctx.db.patch(event._id, { ownerId: args.toOwnerId }),
    ),
  );
  return {
    sourceHasMore:
      sourceEvents.length === CLOUD_PROJECTION_BATCH_SIZE ||
      ownerlessEvents.length === CLOUD_PROJECTION_BATCH_SIZE,
  };
};

export const commitCloudConversationTransferBatch = internalMutation({
  args: {
    ...leasedOwnerArgs,
    conversationId: v.string(),
    ...externalTransferReceiptArgs,
  },
  returns: v.object({
    complete: v.boolean(),
    progressed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const finish = async (result: {
      complete: boolean;
      progressed: boolean;
    }) => {
      await storeExternalTransferAck(
        ctx,
        migration,
        args,
        args,
        result.complete,
      );
      return result;
    };
    const editLocators = await migrateConversationEditLocators(ctx, {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
      conversationId: args.conversationId,
      toOwnerGeneration: migration.toOwnerGeneration!,
    });
    const conversation = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (!conversation || conversation.ownerId === args.toOwnerId) {
      return await finish({ complete: true, progressed: false });
    }
    if (conversation.ownerId !== args.fromOwnerId) {
      throw new Error("Cloud conversation ownership changed unexpectedly.");
    }
    if (editLocators.sourceHasMore) {
      return await finish({ complete: false, progressed: true });
    }

    const turn = (
      await ctx.db
        .query("agent_turns")
        .withIndex("by_conversationId_and_ownerId_and_createdAt", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (turn) {
      const [tokens, invocations, events] = await Promise.all([
        ctx.db
          .query("cloud_turn_tokens")
          .withIndex("by_turnId_and_ownerId", (q) =>
            q.eq("turnId", turn.turnId).eq("ownerId", args.fromOwnerId),
          )
          .take(CLOUD_PROJECTION_BATCH_SIZE),
        ctx.db
          .query("cloud_app_op_invocations")
          .withIndex("by_ownerId_and_turnId_and_createdAt", (q) =>
            q.eq("ownerId", args.fromOwnerId).eq("turnId", turn.turnId),
          )
          .take(CLOUD_PROJECTION_BATCH_SIZE),
        migrateAgentEventsForTurn(ctx, {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
          turnId: turn.turnId,
        }),
      ]);
      await Promise.all([
        ...tokens.map((token) =>
          ctx.db.patch(token._id, { ownerId: args.toOwnerId }),
        ),
        ...invocations.map((invocation) =>
          ctx.db.patch(invocation._id, { ownerId: args.toOwnerId }),
        ),
      ]);
      if (
        tokens.length < CLOUD_PROJECTION_BATCH_SIZE &&
        invocations.length < CLOUD_PROJECTION_BATCH_SIZE &&
        !events.sourceHasMore
      ) {
        await ctx.db.patch(turn._id, { ownerId: args.toOwnerId });
      }
      return await finish({ complete: false, progressed: true });
    }

    const thread = (
      await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_conversationId_and_ownerId_and_updatedAt", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (thread) {
      const messages = await ctx.db
        .query("cloud_thread_messages")
        .withIndex("by_conversationId_and_ownerId_and_seq", (q) =>
          q
            .eq("conversationId", thread.threadId)
            .eq("ownerId", args.fromOwnerId),
        )
        .take(CLOUD_PROJECTION_BATCH_SIZE);
      await Promise.all(
        messages.map((message) =>
          ctx.db.patch(message._id, { ownerId: args.toOwnerId }),
        ),
      );
      if (messages.length < CLOUD_PROJECTION_BATCH_SIZE) {
        await ctx.db.patch(thread._id, { ownerId: args.toOwnerId });
      }
      return await finish({ complete: false, progressed: true });
    }

    const legacyMessages = await ctx.db
      .query("cloud_messages")
      .withIndex("by_conversationId_and_ownerId_and_seq", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE);
    if (legacyMessages.length > 0) {
      await Promise.all(
        legacyMessages.map((message) =>
          ctx.db.patch(message._id, { ownerId: args.toOwnerId }),
        ),
      );
      return await finish({ complete: false, progressed: true });
    }

    const excerpts = await ctx.db
      .query("cloud_message_excerpts")
      .withIndex("by_conversationId_and_ownerId_and_seqStart", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE);
    if (excerpts.length > 0) {
      await Promise.all(
        excerpts.map((excerpt) =>
          ctx.db.patch(excerpt._id, { ownerId: args.toOwnerId }),
        ),
      );
      return await finish({ complete: false, progressed: true });
    }

    const schedules = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_conversationId_and_ownerId_and_updatedAt", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .eq("ownerId", args.fromOwnerId),
      )
      .take(CLOUD_PROJECTION_BATCH_SIZE);
    if (schedules.length > 0) {
      await Promise.all(
        schedules.map((schedule) =>
          ctx.db.patch(schedule._id, { ownerId: args.toOwnerId }),
        ),
      );
      return await finish({ complete: false, progressed: true });
    }

    await ctx.db.patch(conversation._id, { ownerId: args.toOwnerId });
    return await finish({ complete: true, progressed: true });
  },
});

export const commitDeletedCloudConversationTransfer = internalMutation({
  args: {
    ...leasedOwnerArgs,
    conversationId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    await migrateConversationEditLocators(ctx, {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
      conversationId: args.conversationId,
      toOwnerGeneration: migration.toOwnerGeneration!,
    });
    const conversation = await ctx.db
      .query("cloud_conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .unique();
    if (!conversation || conversation.ownerId === args.toOwnerId) return true;
    if (
      conversation.ownerId !== args.fromOwnerId ||
      conversation.deletedAt === undefined ||
      conversation.purgedAt === undefined
    ) {
      return false;
    }
    await ctx.db.patch(conversation._id, { ownerId: args.toOwnerId });
    return true;
  },
});

const cloudProductBatchReturn = v.object({
  hasMore: v.boolean(),
  progressed: v.boolean(),
});

const transferCloudAppStorageRow = async (
  ctx: MutationCtx,
  row: Doc<"cloud_app_storage">,
  args: OwnerIds,
): Promise<void> => {
  const ownerId =
    row.ownerId === args.fromOwnerId ? args.toOwnerId : row.ownerId;
  const userId = row.userId === args.fromOwnerId ? args.toOwnerId : row.userId;
  const collision = await ctx.db
    .query("cloud_app_storage")
    .withIndex("by_appId_and_userId_and_key", (q) =>
      q.eq("appId", row.appId).eq("userId", userId).eq("key", row.key),
    )
    .unique();
  if (collision && collision._id !== row._id) {
    let importedKey: string | null = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = importedOwnerScopedKey(
        row.key,
        String(row._id),
        attempt,
        128,
      );
      const occupied = await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_userId_and_key", (q) =>
          q.eq("appId", row.appId).eq("userId", userId).eq("key", candidate),
        )
        .unique();
      if (!occupied) {
        importedKey = candidate;
        break;
      }
    }
    if (!importedKey) {
      blockOwnershipMigration(
        `No imported app-storage key is available for "${row.key}".`,
      );
    }
    await ctx.db.patch(row._id, {
      ownerId,
      userId,
      key: importedKey!,
    });
    return;
  }
  await ctx.db.patch(row._id, { ownerId, userId });
};

const importedWorkspaceProjectValidator = v.object({
  projectId: v.string(),
  workspace: v.string(),
  name: v.string(),
});
type ImportedWorkspaceProject = {
  projectId: string;
  workspace: string;
  name: string;
};

const sameExactKeys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const rewriteOwnedArtifactManifest = async (
  build: Pick<
    Doc<"cloud_interior_builds">,
    | "buildId"
    | "artifactPrefix"
    | "artifactManifestJson"
    | "manifestSha256"
    | "artifactDigest"
    | "artifactSizeBytes"
    | "bridgeAbi"
    | "minShellVersion"
  >,
  sourceOwnerPrefix: string,
  destinationOwnerPrefix: string,
): Promise<{ artifactManifestJson: string; manifestSha256: string }> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(build.artifactManifestJson) as unknown;
  } catch {
    return blockOwnershipMigration(
      "An interior artifact manifest is not valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return blockOwnershipMigration("An interior artifact manifest is invalid.");
  }
  const manifest = parsed as Record<string, unknown>;
  const manifestKeys = [
    "schemaVersion",
    "buildId",
    "version",
    "artifactPrefix",
    "entries",
    "files",
    "artifactSha256",
    "size",
    "bridgeAbi",
    "minShellVersion",
  ];
  const expectedSourcePrefix = `${sourceOwnerPrefix}${build.buildId}`;
  const destinationPrefix = `${destinationOwnerPrefix}${build.buildId}`;
  if (
    !sameExactKeys(manifest, manifestKeys) ||
    manifest.schemaVersion !== 1 ||
    manifest.buildId !== build.buildId ||
    manifest.version !== build.buildId ||
    manifest.artifactPrefix !== expectedSourcePrefix ||
    build.artifactPrefix !== expectedSourcePrefix ||
    manifest.size !== build.artifactSizeBytes ||
    manifest.bridgeAbi !== build.bridgeAbi ||
    manifest.minShellVersion !== build.minShellVersion ||
    manifest.artifactSha256 !== build.artifactDigest.replace(/^sha256:/, "") ||
    !manifest.entries ||
    typeof manifest.entries !== "object" ||
    Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    return blockOwnershipMigration(
      "An interior artifact manifest contradicts its immutable build.",
    );
  }
  const existingManifestSha256 = `sha256:${await hashSha256Hex(
    build.artifactManifestJson,
  )}`;
  if (build.manifestSha256 !== existingManifestSha256) {
    return blockOwnershipMigration(
      "An interior artifact manifest digest does not match its bytes.",
    );
  }

  const sourceUrlPath = `/interior-builds/${expectedSourcePrefix.slice(
    "interiors/".length,
  )}/`;
  const destinationUrlPath = `/interior-builds/${destinationPrefix.slice(
    "interiors/".length,
  )}/`;
  let expectedOrigin: string | null = null;
  const files = manifest.files.map((rawFile) => {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) {
      return blockOwnershipMigration("An interior artifact file is invalid.");
    }
    const file = rawFile as Record<string, unknown>;
    if (
      !sameExactKeys(file, ["path", "url", "size", "sha256", "contentType"]) ||
      typeof file.path !== "string" ||
      typeof file.url !== "string"
    ) {
      return blockOwnershipMigration("An interior artifact file is invalid.");
    }
    let url: URL;
    try {
      url = new URL(file.url);
      const relativePath = decodeURIComponent(
        url.pathname.slice(sourceUrlPath.length),
      );
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        !url.pathname.startsWith(sourceUrlPath) ||
        relativePath !== file.path ||
        (expectedOrigin !== null && url.origin !== expectedOrigin)
      ) {
        return blockOwnershipMigration(
          "An interior artifact URL does not match its file path.",
        );
      }
    } catch {
      return blockOwnershipMigration("An interior artifact URL is invalid.");
    }
    expectedOrigin ??= url.origin;
    url.pathname = `${destinationUrlPath}${file.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    return { ...file, url: url.toString() };
  });
  const artifactManifestJson = JSON.stringify({
    ...manifest,
    artifactPrefix: destinationPrefix,
    files,
  });
  return {
    artifactManifestJson,
    manifestSha256: `sha256:${await hashSha256Hex(artifactManifestJson)}`,
  };
};

const ensureImportedWorkspaceProject = async (
  ctx: MutationCtx,
  ownerId: string,
  imported: ImportedWorkspaceProject,
): Promise<void> => {
  const slug = imported.workspace.startsWith("project:")
    ? imported.workspace.slice("project:".length)
    : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) {
    blockOwnershipMigration("Worker returned an invalid imported workspace.");
  }
  const byId = await ctx.db
    .query("cloud_projects")
    .withIndex("by_projectId", (q) => q.eq("projectId", imported.projectId))
    .unique();
  if (byId) {
    if (byId.ownerId !== ownerId || byId.slug !== slug) {
      blockOwnershipMigration(
        "Imported workspace project identity changed during account linking.",
      );
    }
    return;
  }
  const bySlug = await ctx.db
    .query("cloud_projects")
    .withIndex("by_ownerId_and_slug", (q) =>
      q.eq("ownerId", ownerId).eq("slug", slug),
    )
    .unique();
  if (bySlug) {
    blockOwnershipMigration(
      "Imported workspace project slug changed during account linking.",
    );
  }
  const now = Date.now();
  await ctx.db.insert("cloud_projects", {
    projectId: imported.projectId,
    ownerId,
    slug,
    name: imported.name.slice(0, 80),
    provider: "stella",
    defaultBranch: "main",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
};

export const commitOwnerNamespaceTransfer = internalMutation({
  args: {
    ...leasedOwnerArgs,
    fromOwnerHash: v.string(),
    toOwnerHash: v.string(),
    ...externalTransferReceiptArgs,
    importedProjects: v.array(importedWorkspaceProjectValidator),
  },
  returns: cloudProductBatchReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const finish = async (result: {
      hasMore: boolean;
      progressed: boolean;
    }) => {
      await storeExternalTransferAck(
        ctx,
        migration,
        args,
        args,
        !result.hasMore,
      );
      return result;
    };
    const stage = migration.cloudProductStage ?? "owner-namespaces";
    if (stage !== "owner-namespaces") {
      return await finish({ hasMore: false, progressed: stage === "apps" });
    }
    if (!migration.toOwnerGeneration) {
      blockOwnershipMigration(
        "The destination owner generation is missing from account linking.",
      );
    }
    const destinationGeneration = migration.toOwnerGeneration!;
    const memoryMigration = await inspectMemoryMigrationState(ctx, args);
    if (memoryMigration.blocker) {
      blockOwnershipMigration(memoryMigration.blocker);
    }
    const destinationMemoryEpoch = memoryMigration.targetEpoch;
    const sourceAgentHomePrefix = `agent-home/${args.fromOwnerHash}/`;
    const destinationAgentHomePrefix = importedAgentHomePrefix(
      args.fromOwnerHash,
      args.toOwnerHash,
    );
    const importedObjectKey = (key: string, label: string): string => {
      if (!key.startsWith(sourceAgentHomePrefix)) {
        blockOwnershipMigration(
          `${label} points outside the anonymous owner namespace.`,
        );
      }
      return key.replace(sourceAgentHomePrefix, destinationAgentHomePrefix);
    };
    const progressed = async () =>
      await finish({ hasMore: true, progressed: true });

    for (const imported of args.importedProjects) {
      await ensureImportedWorkspaceProject(ctx, args.toOwnerId, imported);
    }

    // A completed wipe job is an operational replay receipt, not product
    // state. Remove the source receipt instead of transferring it. An existing
    // destination receipt remains intact so its own idempotency contract is
    // not disturbed.
    if (memoryMigration.sourceWipeJob) {
      await ctx.db.delete(memoryMigration.sourceWipeJob._id);
      return await progressed();
    }

    // Reservations and active leases cannot survive an owner-generation
    // change. Their immutable bytes, if already uploaded, remain under the
    // transferred owner prefix for the normal owner purge sweep; no stale
    // source writer can publish them after this mutation.
    const memoryIntents = await ctx.db
      .query("cloud_agent_home_write_intents")
      .withIndex("by_ownerId_and_status_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    if (memoryIntents.length > 0) {
      await Promise.all(memoryIntents.map((row) => ctx.db.delete(row._id)));
      return await progressed();
    }
    const skillIntents = await ctx.db
      .query("cloud_skill_write_intents")
      .withIndex("by_ownerId_and_status_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    if (skillIntents.length > 0) {
      await Promise.all(skillIntents.map((row) => ctx.db.delete(row._id)));
      return await progressed();
    }
    const memoryPreference = await ctx.db
      .query("cloud_agent_home_preferences")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (memoryPreference) {
      const destination = await ctx.db
        .query("cloud_agent_home_preferences")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) {
        if (destination.memoryEnabled !== memoryPreference.memoryEnabled) {
          blockOwnershipMigration(
            "The anonymous and connected identities have conflicting Memory preferences.",
          );
        }
        await ctx.db.patch(destination._id, {
          ownerGeneration: destinationGeneration,
          updatedAt: Math.max(
            destination.updatedAt,
            memoryPreference.updatedAt,
          ),
        });
        await ctx.db.delete(memoryPreference._id);
      } else {
        await ctx.db.patch(memoryPreference._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: destinationGeneration,
        });
      }
      return await progressed();
    }
    const memoryVersions = await ctx.db
      .query("cloud_agent_home_doc_versions")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    if (memoryVersions.length > 0) {
      for (const version of memoryVersions) {
        await ctx.db.patch(version._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: destinationGeneration,
          memoryEpoch: destinationMemoryEpoch,
          name: importedAgentHomeDocumentName(version.name, version.documentId),
          r2Key: importedObjectKey(
            version.r2Key,
            "An Agent Home document version",
          ),
          writer: "owner_migration",
        });
      }
      return await progressed();
    }

    const documents = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    for (const document of documents) {
      const name = importedAgentHomeDocumentName(
        document.name,
        document.documentId ?? String(document._id),
      );
      const collision = await ctx.db
        .query("cloud_agent_home_docs")
        .withIndex("by_ownerId_and_name", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("name", name),
        )
        .unique();
      if (collision && collision._id !== document._id) {
        blockOwnershipMigration(
          `An imported memory path is already occupied: "${name}".`,
        );
      }
      await ctx.db.patch(document._id, {
        ownerId: args.toOwnerId,
        name,
        displayPath: `~/.stella/${name}`,
        kind: "imported_markdown",
        source: "owner_migration",
        ownerGeneration: destinationGeneration,
        memoryEpoch: destinationMemoryEpoch,
        r2Key: importedObjectKey(document.r2Key, "An Agent Home document"),
      });
    }
    if (documents.length > 0) return await progressed();

    // The worker has already copied the complete Agent Home namespace, and
    // every source Memory metadata row above has now moved or drained.
    // Only at this point may the source epoch capability move/disappear.
    if (memoryMigration.sourceLifecycle) {
      if (memoryMigration.destinationLifecycle) {
        const sourceRequiresExplicitImport =
          memoryMigration.sourceLifecycle.importDisposition ===
          "explicit_required";
        const destinationRequiresExplicitImport =
          memoryMigration.destinationLifecycle.importDisposition ===
          "explicit_required";
        await ctx.db.patch(memoryMigration.destinationLifecycle._id, {
          ownerGeneration: destinationGeneration,
          updatedAt: Math.max(
            memoryMigration.destinationLifecycle.updatedAt,
            memoryMigration.sourceLifecycle.updatedAt,
          ),
          ...(!destinationRequiresExplicitImport && sourceRequiresExplicitImport
            ? {
                // Import authorization is subject+epoch bound. The
                // destination epoch survives, so a source wipe tombstone may
                // tighten the destination policy but source authorization can
                // never authorize that different epoch.
                importDisposition: "explicit_required" as const,
                lastWipedEpoch:
                  memoryMigration.sourceLifecycle.lastWipedEpoch ??
                  memoryMigration.destinationLifecycle.lastWipedEpoch,
                importAuthorizationRequestId: undefined,
                importAuthorizedAt: undefined,
              }
            : {}),
        });
        await ctx.db.delete(memoryMigration.sourceLifecycle._id);
      } else {
        await ctx.db.patch(memoryMigration.sourceLifecycle._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: destinationGeneration,
          updatedAt: Date.now(),
        });
      }
      return await progressed();
    }

    const skillFiles = await ctx.db
      .query("cloud_skill_files")
      .withIndex("by_ownerId_and_skillId", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    if (skillFiles.length > 0) {
      for (const file of skillFiles) {
        await ctx.db.patch(file._id, {
          ownerId: args.toOwnerId,
          r2Key: importedObjectKey(file.r2Key, "A cloud Skill file"),
        });
      }
      return await progressed();
    }

    const skillVersions = await ctx.db
      .query("cloud_skill_versions")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    if (skillVersions.length > 0) {
      for (const version of skillVersions) {
        await ctx.db.patch(version._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: destinationGeneration,
          manifestR2Key: importedObjectKey(
            version.manifestR2Key,
            "A cloud Skill manifest",
          ),
          source: "owner_migration",
        });
      }
      return await progressed();
    }

    const skillAuthorizations = await ctx.db
      .query("cloud_skill_authorizations")
      .withIndex("by_ownerId_and_skillId", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    if (skillAuthorizations.length > 0) {
      for (const authorization of skillAuthorizations) {
        const collision = await ctx.db
          .query("cloud_skill_authorizations")
          .withIndex("by_ownerId_and_skillId", (q) =>
            q
              .eq("ownerId", args.toOwnerId)
              .eq("skillId", authorization.skillId),
          )
          .unique();
        if (collision && collision._id !== authorization._id) {
          blockOwnershipMigration(
            "A cloud Skill authorization identity collided during account linking.",
          );
        }
        await ctx.db.patch(authorization._id, { ownerId: args.toOwnerId });
      }
      return await progressed();
    }

    const skills = await ctx.db
      .query("cloud_skills")
      .withIndex("by_ownerId_and_deletedAt_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    if (skills.length > 0) {
      for (const skill of skills) {
        let slug = skill.slug;
        const directCollision = await ctx.db
          .query("cloud_skills")
          .withIndex("by_ownerId_and_slug", (q) =>
            q.eq("ownerId", args.toOwnerId).eq("slug", slug),
          )
          .unique();
        if (directCollision && directCollision._id !== skill._id) {
          let importedSlug: string | null = null;
          for (let attempt = 0; attempt < 32; attempt += 1) {
            const candidate = importedSkillSlug(
              skill.slug,
              skill.skillId,
              attempt,
            );
            const occupied = await ctx.db
              .query("cloud_skills")
              .withIndex("by_ownerId_and_slug", (q) =>
                q.eq("ownerId", args.toOwnerId).eq("slug", candidate),
              )
              .unique();
            if (!occupied) {
              importedSlug = candidate;
              break;
            }
          }
          if (!importedSlug) {
            blockOwnershipMigration(
              `No imported cloud Skill slug is available for "${skill.slug}".`,
            );
          }
          slug = importedSlug!;
        }
        await ctx.db.patch(skill._id, {
          ownerId: args.toOwnerId,
          slug,
          source: "owner_migration",
          updatedAt: Date.now(),
        });
      }
      return await progressed();
    }

    const driveFiles = await ctx.db
      .query("cloud_drive_files")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(20);
    for (const driveFile of driveFiles) {
      const destination = await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("path", driveFile.path),
        )
        .unique();
      let path = driveFile.path;
      if (destination) {
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedDrivePath(
            driveFile.path,
            String(driveFile._id),
            attempt,
          );
          const occupied = await ctx.db
            .query("cloud_drive_files")
            .withIndex("by_ownerId_and_path", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("path", candidate),
            )
            .unique();
          if (!occupied) {
            path = candidate;
            break;
          }
        }
        if (path === driveFile.path) {
          blockOwnershipMigration(
            `No imported Drive path is available for "${driveFile.path}".`,
          );
        }
      }
      await ctx.db.patch(driveFile._id, {
        ...driveFileOwnershipPatch(args.toOwnerId),
        path,
        ...(destination
          ? {
              name:
                path.split("/")[path.split("/").length - 1] ?? driveFile.name,
            }
          : {}),
      });
    }
    const remainingDriveFiles = await ctx.db
      .query("cloud_drive_files")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(1);
    if (shouldAdvanceOwnerNamespaceStage(remainingDriveFiles.length)) {
      await ctx.db.patch(migration._id, { cloudProductStage: "apps" });
      return await finish({ hasMore: false, progressed: true });
    }
    return await finish({
      hasMore: true,
      progressed: driveFiles.length > 0,
    });
  },
});

export const commitCloudAppTransferBatch = internalMutation({
  args: {
    ...leasedOwnerArgs,
    appId: v.string(),
    fromOwnerHash: v.string(),
    toOwnerHash: v.string(),
    importedProject: v.optional(importedWorkspaceProjectValidator),
    ...externalTransferReceiptArgs,
  },
  returns: cloudProductBatchReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    if ((migration.cloudProductStage ?? "owner-namespaces") !== "apps") {
      throw new ConvexError({
        code: "STALE_OWNERSHIP_MIGRATION_STAGE",
        message: "Cloud app acknowledgement does not match the active stage.",
      });
    }
    const finish = async (result: {
      hasMore: boolean;
      progressed: boolean;
    }) => {
      await storeExternalTransferAck(
        ctx,
        migration,
        args,
        args,
        !result.hasMore,
      );
      return result;
    };
    const app = await ctx.db
      .query("cloud_apps")
      .withIndex("by_appId", (q) => q.eq("appId", args.appId))
      .unique();
    if (!app || app.ownerId === args.toOwnerId) {
      return await finish({ hasMore: false, progressed: false });
    }
    if (app.ownerId !== args.fromOwnerId) {
      throw new Error("Cloud app ownership changed unexpectedly.");
    }
    if (args.importedProject) {
      await ensureImportedWorkspaceProject(
        ctx,
        args.toOwnerId,
        args.importedProject,
      );
    }
    const sourceBuild = (
      await ctx.db
        .query("cloud_app_builds")
        .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("appId", app.appId),
        )
        .take(1)
    )[0];
    if (sourceBuild) {
      const expectedSourcePrefix = `builds/${args.fromOwnerHash}/${sourceBuild.buildId}`;
      if (
        sourceBuild.artifactPrefix !== undefined &&
        sourceBuild.artifactPrefix !== expectedSourcePrefix
      ) {
        blockOwnershipMigration(
          "A cloud app build points outside the anonymous owner namespace.",
        );
      }
      await ctx.db.patch(sourceBuild._id, {
        ownerId: args.toOwnerId,
        ...(sourceBuild.artifactPrefix !== undefined
          ? {
              artifactPrefix: `builds/${args.toOwnerHash}/${sourceBuild.buildId}`,
            }
          : {}),
      });
      return await finish({ hasMore: true, progressed: true });
    }
    const operation = await ctx.db
      .query("cloud_app_operations")
      .withIndex("by_ownerId_and_appId", (q) =>
        q.eq("ownerId", args.fromOwnerId).eq("appId", app.appId),
      )
      .unique();
    if (operation) {
      await ctx.db.patch(operation._id, { ownerId: args.toOwnerId });
      return await finish({ hasMore: true, progressed: true });
    }
    const invocation = (
      await ctx.db
        .query("cloud_app_op_invocations")
        .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("appId", app.appId),
        )
        .take(1)
    )[0];
    if (invocation) {
      await ctx.db.patch(invocation._id, { ownerId: args.toOwnerId });
      return await finish({ hasMore: true, progressed: true });
    }
    const storage = (
      await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_ownerId_and_appId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId).eq("appId", app.appId),
        )
        .take(1)
    )[0];
    if (storage) {
      const userId =
        storage.userId === args.fromOwnerId ? args.toOwnerId : storage.userId;
      const collision = await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_userId_and_key", (q) =>
          q
            .eq("appId", storage.appId)
            .eq("userId", userId)
            .eq("key", storage.key),
        )
        .unique();
      if (collision && collision._id !== storage._id) {
        let importedKey: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedOwnerScopedKey(
            storage.key,
            String(storage._id),
            attempt,
            128,
          );
          const occupied = await ctx.db
            .query("cloud_app_storage")
            .withIndex("by_appId_and_userId_and_key", (q) =>
              q
                .eq("appId", storage.appId)
                .eq("userId", userId)
                .eq("key", candidate),
            )
            .unique();
          if (!occupied) {
            importedKey = candidate;
            break;
          }
        }
        if (!importedKey) {
          blockOwnershipMigration(
            `No imported app-storage key is available for "${storage.key}".`,
          );
        }
        await ctx.db.patch(storage._id, {
          ownerId: args.toOwnerId,
          userId,
          key: importedKey!,
        });
      } else {
        await ctx.db.patch(storage._id, { ownerId: args.toOwnerId, userId });
      }
      return await finish({ hasMore: true, progressed: true });
    }
    await ctx.db.patch(app._id, { ownerId: args.toOwnerId });
    return await finish({ hasMore: false, progressed: true });
  },
});

export const commitCloudInteriorTransferBatch = internalMutation({
  args: {
    ...leasedOwnerArgs,
    fromOwnerHash: v.string(),
    toOwnerHash: v.string(),
    ...externalTransferReceiptArgs,
  },
  returns: cloudProductBatchReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    if ((migration.cloudProductStage ?? "owner-namespaces") !== "interior") {
      throw new ConvexError({
        code: "STALE_OWNERSHIP_MIGRATION_STAGE",
        message:
          "Cloud interior acknowledgement does not match the active stage.",
      });
    }
    const finish = async (result: {
      hasMore: boolean;
      progressed: boolean;
    }) => {
      await storeExternalTransferAck(
        ctx,
        migration,
        args,
        args,
        !result.hasMore,
      );
      return result;
    };
    const sourceBuild = (
      await ctx.db
        .query("cloud_interior_builds")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    const sourceDeployment = await ctx.db
      .query("cloud_interior_deployables")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    const destinationDeployment = await ctx.db
      .query("cloud_interior_deployables")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .unique();
    if (sourceBuild) {
      const sourcePrefix = `interiors/${args.fromOwnerHash}/`;
      const destinationPrefix = importedInteriorPrefix(
        args.fromOwnerHash,
        args.toOwnerHash,
      );
      if (!sourceBuild.artifactPrefix.startsWith(sourcePrefix)) {
        blockOwnershipMigration(
          "An interior build points outside the anonymous owner namespace.",
        );
      }
      const rewrittenManifest = await rewriteOwnedArtifactManifest(
        sourceBuild,
        sourcePrefix,
        destinationPrefix,
      );
      await ctx.db.patch(sourceBuild._id, {
        ownerId: args.toOwnerId,
        ...(destinationDeployment
          ? { deployableId: destinationDeployment.deployableId }
          : {}),
        artifactPrefix: sourceBuild.artifactPrefix.replace(
          sourcePrefix,
          destinationPrefix,
        ),
        artifactManifestJson: rewrittenManifest.artifactManifestJson,
        manifestSha256: rewrittenManifest.manifestSha256,
      });
      return await finish({ hasMore: true, progressed: true });
    }
    if (!sourceDeployment) {
      return await finish({ hasMore: false, progressed: false });
    }
    if (destinationDeployment) {
      await ctx.db.delete(sourceDeployment._id);
    } else {
      await ctx.db.patch(sourceDeployment._id, {
        ownerId: args.toOwnerId,
        ownerHash: args.toOwnerHash,
      });
    }
    return await finish({ hasMore: false, progressed: true });
  },
});

export const commitCloudProjectTransfer = internalMutation({
  args: {
    ...leasedOwnerArgs,
    projectId: v.string(),
    targetSlug: v.string(),
    ...externalTransferReceiptArgs,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    if ((migration.cloudProductStage ?? "owner-namespaces") !== "projects") {
      throw new ConvexError({
        code: "STALE_OWNERSHIP_MIGRATION_STAGE",
        message:
          "Cloud project acknowledgement does not match the active stage.",
      });
    }
    const finish = async (complete: boolean) => {
      await storeExternalTransferAck(ctx, migration, args, args, complete);
      return complete;
    };
    const project = await ctx.db
      .query("cloud_projects")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (!project || project.ownerId === args.toOwnerId) {
      return await finish(true);
    }
    if (project.ownerId !== args.fromOwnerId) {
      throw new Error("Cloud project ownership changed unexpectedly.");
    }
    const collision = await ctx.db
      .query("cloud_projects")
      .withIndex("by_ownerId_and_slug", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("slug", args.targetSlug),
      )
      .unique();
    if (collision) return await finish(false);
    await ctx.db.patch(project._id, {
      ownerId: args.toOwnerId,
      slug: args.targetSlug,
      ...(args.targetSlug === project.slug
        ? {}
        : { name: `${project.name} (imported)` }),
    });
    return await finish(true);
  },
});

/**
 * Schedule receipts embed the operation's exact response. Create/update
 * responses include the schedule row, so ownership migration must rewrite the
 * embedded owner together with the indexed receipt and schedule row. Keeping
 * the stale source owner in a replay would otherwise return data that
 * contradicts the canonical row after linking.
 */
const migrateScheduleReceiptResultJson = (
  receipt: Pick<Doc<"cloud_schedule_receipts">, "action" | "resultJson">,
  fromOwnerId: string,
  toOwnerId: string,
): string => {
  if (receipt.action === "remove") return receipt.resultJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(receipt.resultJson) as unknown;
  } catch {
    return blockOwnershipMigration(
      "A Schedule request receipt contains an unreadable response.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return blockOwnershipMigration(
      "A Schedule request receipt contains an invalid response.",
    );
  }
  const result = parsed as Record<string, unknown>;
  const schedule = result.schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return blockOwnershipMigration(
      "A Schedule request receipt is missing its schedule response.",
    );
  }
  const scheduleRecord = schedule as Record<string, unknown>;
  if (
    scheduleRecord.ownerId !== fromOwnerId &&
    scheduleRecord.ownerId !== toOwnerId
  ) {
    return blockOwnershipMigration(
      "A Schedule request receipt names an unexpected owner.",
    );
  }
  return JSON.stringify({
    ...result,
    schedule: { ...scheduleRecord, ownerId: toOwnerId },
  });
};

export const migrateCloudProductCoreBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: cloudProductBatchReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    if ((migration.cloudProductStage ?? "owner-namespaces") !== "core") {
      throw new ConvexError({
        code: "STALE_OWNERSHIP_MIGRATION_STAGE",
        message: "Cloud core batch does not match the active stage.",
      });
    }
    // Both identities are fenced while ownership moves. A Code-safe provider
    // read can still be physically in flight from before that fence, so retain
    // its ambiguity receipt until the bounded dispatch lease expires. Missing
    // lease metadata is malformed durable debt and requires explicit repair.
    for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
      const [missingLease, liveLease] = await Promise.all([
        ctx.db
          .query("cloud_integration_call_receipts")
          .withIndex("by_ownerId_state_leaseExpiresAt", (q) =>
            q
              .eq("ownerId", ownerId)
              .eq("state", "dispatching")
              .eq("leaseExpiresAt", undefined),
          )
          .first(),
        ctx.db
          .query("cloud_integration_call_receipts")
          .withIndex("by_ownerId_state_leaseExpiresAt", (q) =>
            q
              .eq("ownerId", ownerId)
              .eq("state", "dispatching")
              .gt("leaseExpiresAt", args.leaseNow),
          )
          .first(),
      ]);
      if (missingLease) {
        blockOwnershipMigration(
          "A connected-tool dispatch receipt is missing its lease deadline.",
        );
      }
      if (liveLease) return { hasMore: true, progressed: false };
    }
    const driveFile = (
      await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (driveFile) {
      const collision = await ctx.db
        .query("cloud_drive_files")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("path", driveFile.path),
        )
        .unique();
      let path = driveFile.path;
      if (collision) {
        let available: string | null = null;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = importedDrivePath(
            driveFile.path,
            String(driveFile._id),
            attempt,
          );
          const occupied = await ctx.db
            .query("cloud_drive_files")
            .withIndex("by_ownerId_and_path", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("path", candidate),
            )
            .unique();
          if (!occupied) {
            available = candidate;
            break;
          }
        }
        if (!available) {
          throw new Error(
            "No collision-safe destination path is available for a drive file.",
          );
        }
        path = available;
      }
      await ctx.db.patch(driveFile._id, {
        ownerId: args.toOwnerId,
        path,
        ...(collision
          ? {
              name:
                path.split("/")[path.split("/").length - 1] ?? driveFile.name,
            }
          : {}),
      });
      return { hasMore: true, progressed: true };
    }
    const upload = (
      await ctx.db
        .query("cloud_drive_uploads")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (upload) {
      if (
        ownershipMigrationTransientStateDisposition("cloud_drive_upload") ===
        "discard"
      ) {
        await ctx.db.delete(upload._id);
        for (const delay of canceledPendingUploadCleanupDelays(
          Date.now(),
          upload.expiresAt,
        )) {
          await ctx.scheduler.runAfter(
            delay,
            internal.cloud_drive.cleanupCanceledPendingUploadInternal,
            { r2Key: upload.r2Key },
          );
        }
        console.info("[auth_migration] Canceled an incomplete Drive upload.");
        return { hasMore: true, progressed: true };
      }
      blockOwnershipMigration("A pending Drive upload could not be canceled.");
    }
    const deletion = (
      await ctx.db
        .query("cloud_drive_deletions")
        .withIndex("by_ownerId_and_deletedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (deletion) {
      const collision = await ctx.db
        .query("cloud_drive_deletions")
        .withIndex("by_ownerId_and_path", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("path", deletion.path),
        )
        .unique();
      if (collision) {
        if (deletion.deletedAt > collision.deletedAt) {
          await ctx.db.patch(collision._id, {
            deletedAt: deletion.deletedAt,
          });
        }
        await ctx.db.delete(deletion._id);
      } else {
        await ctx.db.patch(deletion._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const usage = await ctx.db
      .query("cloud_drive_usage")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (usage) {
      const destination = await ctx.db
        .query("cloud_drive_usage")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
        .unique();
      if (destination) {
        await ctx.db.patch(destination._id, {
          fileCount: destination.fileCount + usage.fileCount,
          totalBytes: destination.totalBytes + usage.totalBytes,
          updatedAt: Math.max(destination.updatedAt, usage.updatedAt),
        });
        await ctx.db.delete(usage._id);
      } else {
        await ctx.db.patch(usage._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const importedSourceDigest = await ownershipMigrationSourceDigest(
      args.fromOwnerId,
    );
    const rawImportedCredential = await ctx.db
      .query("cloud_llm_credentials")
      .withIndex("by_importedFromOwnerId", (q) =>
        q.eq("importedFromOwnerId", args.fromOwnerId),
      )
      .first();
    if (rawImportedCredential) {
      if (rawImportedCredential.ownerId !== args.toOwnerId) {
        blockOwnershipMigration(
          "An imported cloud credential names an unexpected destination owner.",
        );
      }
      await ctx.db.patch(rawImportedCredential._id, {
        importedFromOwnerId: importedSourceDigest,
      });
      return { hasMore: true, progressed: true };
    }
    const credential = (
      await ctx.db
        .query("cloud_llm_credentials")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (credential) {
      const destination = await ctx.db
        .query("cloud_llm_credentials")
        .withIndex("by_ownerId_and_provider_and_importedFromOwnerId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("provider", credential.provider)
            .eq("importedFromOwnerId", undefined),
        )
        .unique();
      if (destination) {
        await ctx.db.patch(credential._id, {
          ownerId: args.toOwnerId,
          // Preserve imported-alternative semantics without retaining the raw
          // anonymous principal after its permanent source purge.
          importedFromOwnerId: importedSourceDigest,
          refreshLeaseId: undefined,
          refreshLeaseExpiresAt: undefined,
          label: `${credential.label} (imported from anonymous)`,
        });
      } else {
        await ctx.db.patch(credential._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const connect = (
      await ctx.db
        .query("cloud_engine_connects")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (connect) {
      if (
        ownershipMigrationTransientStateDisposition("cloud_engine_connect") ===
        "discard"
      ) {
        await ctx.db.delete(connect._id);
        console.info("[auth_migration] Canceled an incomplete engine connect.");
        return { hasMore: true, progressed: true };
      }
      blockOwnershipMigration(
        "A pending cloud-engine connection could not be canceled.",
      );
    }
    const rawImportedEngineSettings = await ctx.db
      .query("cloud_engine_settings")
      .withIndex("by_importedFromOwnerId", (q) =>
        q.eq("importedFromOwnerId", args.fromOwnerId),
      )
      .first();
    if (rawImportedEngineSettings) {
      if (rawImportedEngineSettings.ownerId !== args.toOwnerId) {
        blockOwnershipMigration(
          "Imported cloud-engine settings name an unexpected destination owner.",
        );
      }
      await ctx.db.patch(rawImportedEngineSettings._id, {
        importedFromOwnerId: importedSourceDigest,
      });
      return { hasMore: true, progressed: true };
    }
    const engineSettings = await ctx.db
      .query("cloud_engine_settings")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .unique();
    if (engineSettings) {
      const destination = await ctx.db
        .query("cloud_engine_settings")
        .withIndex("by_ownerId_and_importedFromOwnerId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("importedFromOwnerId", undefined),
        )
        .unique();
      if (destination) {
        await ctx.db.patch(engineSettings._id, {
          ownerId: args.toOwnerId,
          importedFromOwnerId: importedSourceDigest,
        });
      } else {
        await ctx.db.patch(engineSettings._id, {
          ownerId: args.toOwnerId,
        });
      }
      return { hasMore: true, progressed: true };
    }
    const installation = (
      await ctx.db
        .query("cloud_github_installations")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (installation) {
      await ctx.db.patch(installation._id, { ownerId: args.toOwnerId });
      return { hasMore: true, progressed: true };
    }
    const installState = (
      await ctx.db
        .query("cloud_github_install_states")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
        .take(1)
    )[0];
    if (installState) {
      if (
        ownershipMigrationTransientStateDisposition(
          "cloud_github_install_state",
        ) === "discard"
      ) {
        await ctx.db.delete(installState._id);
        console.info("[auth_migration] Canceled an incomplete GitHub connect.");
        return { hasMore: true, progressed: true };
      }
      blockOwnershipMigration(
        "A pending GitHub connection could not be canceled.",
      );
    }
    // Parent-independent drains close late-writer and historical orphan gaps.
    // The app stage handles these rows while a source app exists; anything
    // reaching core must still be re-owned so residue can make progress.
    const orphanBuild = (
      await ctx.db
        .query("cloud_app_builds")
        .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (orphanBuild) {
      const [fromOwnerHash, toOwnerHash] = await Promise.all([
        hashSha256Hex(args.fromOwnerId),
        hashSha256Hex(args.toOwnerId),
      ]);
      const expectedSourcePrefix = `builds/${fromOwnerHash}/${orphanBuild.buildId}`;
      if (
        orphanBuild.artifactPrefix !== undefined &&
        orphanBuild.artifactPrefix !== expectedSourcePrefix
      ) {
        blockOwnershipMigration(
          "An orphan cloud app build points outside the anonymous owner namespace.",
        );
      }
      await ctx.db.patch(orphanBuild._id, {
        ownerId: args.toOwnerId,
        ...(orphanBuild.artifactPrefix !== undefined
          ? {
              artifactPrefix: `builds/${toOwnerHash}/${orphanBuild.buildId}`,
            }
          : {}),
      });
      return { hasMore: true, progressed: true };
    }
    const orphanOperation = (
      await ctx.db
        .query("cloud_app_operations")
        .withIndex("by_ownerId_and_appId", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (orphanOperation) {
      await ctx.db.patch(orphanOperation._id, { ownerId: args.toOwnerId });
      return { hasMore: true, progressed: true };
    }
    const orphanInvocation = (
      await ctx.db
        .query("cloud_app_op_invocations")
        .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (orphanInvocation) {
      await ctx.db.patch(orphanInvocation._id, { ownerId: args.toOwnerId });
      return { hasMore: true, progressed: true };
    }
    const appStorage = (
      await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (appStorage) {
      await transferCloudAppStorageRow(ctx, appStorage, args);
      return { hasMore: true, progressed: true };
    }
    // `userId` is the app consumer and is independent of the app's `ownerId`.
    // Anonymous data written inside somebody else's app must follow the user.
    const appStorageByUser = (
      await ctx.db
        .query("cloud_app_storage")
        .withIndex("by_userId_and_updatedAt", (q) =>
          q.eq("userId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (appStorageByUser) {
      await transferCloudAppStorageRow(ctx, appStorageByUser, args);
      return { hasMore: true, progressed: true };
    }
    const turn = (
      await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (turn) {
      const [tokens, invocation, events] = await Promise.all([
        ctx.db
          .query("cloud_turn_tokens")
          .withIndex("by_turnId_and_ownerId", (q) =>
            q.eq("turnId", turn.turnId).eq("ownerId", args.fromOwnerId),
          )
          .take(CLOUD_PROJECTION_BATCH_SIZE),
        ctx.db
          .query("cloud_app_op_invocations")
          .withIndex("by_ownerId_and_turnId_and_createdAt", (q) =>
            q.eq("ownerId", args.fromOwnerId).eq("turnId", turn.turnId),
          )
          .first(),
        migrateAgentEventsForTurn(ctx, {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
          turnId: turn.turnId,
        }),
      ]);
      if (tokens.length > 0) {
        await Promise.all(
          tokens.map((token) =>
            ctx.db.patch(token._id, { ownerId: args.toOwnerId }),
          ),
        );
      }
      if (invocation) {
        await ctx.db.patch(invocation._id, { ownerId: args.toOwnerId });
      }
      if (
        tokens.length < CLOUD_PROJECTION_BATCH_SIZE &&
        !invocation &&
        !events.sourceHasMore
      ) {
        await ctx.db.patch(turn._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    // Historical and crash-recovery residue may retain source-attributed
    // events after the parent turn moved (or disappeared). Re-own one indexed
    // row per pass so source purge cannot destroy it after migration finishes.
    const standaloneEvent = await ctx.db
      .query("agent_events")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .first();
    if (standaloneEvent) {
      const parentTurn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", standaloneEvent.turnId))
        .unique();
      if (
        parentTurn &&
        parentTurn.ownerId !== args.fromOwnerId &&
        parentTurn.ownerId !== args.toOwnerId
      ) {
        blockOwnershipMigration(
          "An orphan agent event belongs to another owner's turn.",
        );
      }
      await ctx.db.patch(standaloneEvent._id, { ownerId: args.toOwnerId });
      return { hasMore: true, progressed: true };
    }
    const thread = (
      await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (thread) {
      const messages = await ctx.db
        .query("cloud_thread_messages")
        .withIndex("by_conversationId_and_ownerId_and_seq", (q) =>
          q
            .eq("conversationId", thread.threadId)
            .eq("ownerId", args.fromOwnerId),
        )
        .take(CLOUD_PROJECTION_BATCH_SIZE);
      if (messages.length > 0) {
        await Promise.all(
          messages.map((message) =>
            ctx.db.patch(message._id, { ownerId: args.toOwnerId }),
          ),
        );
      }
      if (messages.length < CLOUD_PROJECTION_BATCH_SIZE) {
        await ctx.db.patch(thread._id, { ownerId: args.toOwnerId });
      }
      return { hasMore: true, progressed: true };
    }
    const scheduleReceipt = (
      await ctx.db
        .query("cloud_schedule_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (scheduleReceipt) {
      if (scheduleReceipt.ownerGeneration !== migration.fromOwnerGeneration) {
        blockOwnershipMigration(
          "A stale-generation Schedule request receipt survived an owner reset.",
        );
      }
      const resultJson = migrateScheduleReceiptResultJson(
        scheduleReceipt,
        args.fromOwnerId,
        args.toOwnerId,
      );
      const destination = await ctx.db
        .query("cloud_schedule_receipts")
        .withIndex("by_ownerId_and_ownerGeneration_and_requestId", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("ownerGeneration", migration.toOwnerGeneration!)
            .eq("requestId", scheduleReceipt.requestId),
        )
        .unique();
      if (destination) {
        if (
          destination.action !== scheduleReceipt.action ||
          destination.intentJson !== scheduleReceipt.intentJson ||
          destination.resultJson !== resultJson
        ) {
          blockOwnershipMigration(
            "Both identities contain conflicting Schedule request receipts.",
          );
        }
        await ctx.db.delete(scheduleReceipt._id);
      } else {
        await ctx.db.patch(scheduleReceipt._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: migration.toOwnerGeneration!,
          resultJson,
        });
      }
      return { hasMore: true, progressed: true };
    }
    const integrationReceipt = (
      await ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.fromOwnerId),
        )
        .take(1)
    )[0];
    if (integrationReceipt) {
      if (
        integrationReceipt.ownerGeneration !== migration.fromOwnerGeneration
      ) {
        blockOwnershipMigration(
          "A stale-generation connected-tool receipt survived an owner reset.",
        );
      }
      if (
        integrationReceipt.state === "dispatching" &&
        (integrationReceipt.leaseExpiresAt ?? 0) > args.leaseNow
      ) {
        return { hasMore: true, progressed: false };
      }
      const destination = await ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_owner_generation_request", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("ownerGeneration", migration.toOwnerGeneration!)
            .eq("requestId", integrationReceipt.requestId),
        )
        .unique();
      if (destination) {
        if (
          destination.fingerprint !== integrationReceipt.fingerprint ||
          destination.toolName !== integrationReceipt.toolName ||
          destination.revision !== integrationReceipt.revision ||
          destination.state !== integrationReceipt.state ||
          destination.resultJson !== integrationReceipt.resultJson ||
          destination.errorCode !== integrationReceipt.errorCode
        ) {
          blockOwnershipMigration(
            "Both identities contain conflicting connected-tool receipts.",
          );
        }
        await ctx.db.delete(integrationReceipt._id);
      } else {
        await ctx.db.patch(integrationReceipt._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: migration.toOwnerGeneration!,
        });
      }
      return { hasMore: true, progressed: true };
    }
    const ownerOnlyTables = [
      "cloud_message_excerpts",
      "cloud_thread_messages",
      "cloud_turn_tokens",
      "cloud_scheduled_turns",
    ] as const;
    for (const table of ownerOnlyTables) {
      if (table === "cloud_message_excerpts") {
        const row = (
          await ctx.db
            .query(table)
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)
        )[0];
        if (row) {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
          return { hasMore: true, progressed: true };
        }
      } else if (table === "cloud_thread_messages") {
        const row = (
          await ctx.db
            .query(table)
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .take(1)
        )[0];
        if (row) {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
          return { hasMore: true, progressed: true };
        }
      } else if (table === "cloud_turn_tokens") {
        const row = (
          await ctx.db
            .query(table)
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .take(1)
        )[0];
        if (row) {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
          return { hasMore: true, progressed: true };
        }
      } else {
        const row = (
          await ctx.db
            .query(table)
            .withIndex("by_ownerId_and_updatedAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)
        )[0];
        if (row) {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
          return { hasMore: true, progressed: true };
        }
      }
    }
    return { hasMore: false, progressed: false };
  },
});

const ownershipResidueReturn = v.object({
  kind: v.union(v.literal("clear"), v.literal("retry"), v.literal("blocked")),
  table: v.optional(v.string()),
});

/**
 * Final fail-closed proof. Safe, anonymous-usable tables return `retry` so a
 * row created by a stale client between drain passes is migrated. Tables that
 * should require a connected account, or that represent an in-flight external
 * protocol, return `blocked`; the migration stays visible and requires an
 * explicit retry after the state is resolved.
 */
export const auditOwnershipMigrationResidue = internalQuery({
  args: ownerArgs,
  returns: ownershipResidueReturn,
  handler: async (ctx, args) => {
    const ownerId = args.fromOwnerId;
    // Attribution-only rows without an owner index (Stripe events and hosted
    // session turn/file audit rows) are covered by their indexed owner parent,
    // billing-profile, room, and membership fences. Do not full-scan them.
    const blockedChecks = [
      [
        "cloud_browser_interactions",
        await ctx.db
          .query("cloud_browser_interactions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", args.fromOwnerId),
          )
          .take(1),
      ],
      [
        "composio_session_provisioning_attempts",
        [
          ...(await ctx.db
            .query("composio_session_provisioning_attempts")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("composio_session_provisioning_attempts")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "media_provider_dispatch_leases",
        [
          ...(await ctx.db
            .query("media_provider_dispatch_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("media_provider_dispatch_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "media_provider_cancellations",
        [
          ...(await ctx.db
            .query("media_provider_cancellations")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .take(1)),
          ...(await ctx.db
            .query("media_provider_cancellations")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
            .take(1)),
        ],
      ],
      [
        "media_billing_disposition_debt",
        [
          ...(await ctx.db
            .query("media_jobs")
            .withIndex(
              "by_ownerId_and_billingDispositionState_and_updatedAt",
              (q) =>
                q
                  .eq("ownerId", args.fromOwnerId)
                  .eq("billingDispositionState", "pending"),
            )
            .take(1)),
          ...(await ctx.db
            .query("media_jobs")
            .withIndex(
              "by_ownerId_and_billingDispositionState_and_updatedAt",
              (q) =>
                q
                  .eq("ownerId", args.fromOwnerId)
                  .eq("billingDispositionState", "unknown"),
            )
            .take(1)),
          ...(await ctx.db
            .query("media_jobs")
            .withIndex(
              "by_ownerId_and_billingDispositionState_and_updatedAt",
              (q) =>
                q
                  .eq("ownerId", args.toOwnerId)
                  .eq("billingDispositionState", "pending"),
            )
            .take(1)),
          ...(await ctx.db
            .query("media_jobs")
            .withIndex(
              "by_ownerId_and_billingDispositionState_and_updatedAt",
              (q) =>
                q
                  .eq("ownerId", args.toOwnerId)
                  .eq("billingDispositionState", "unknown"),
            )
            .take(1)),
        ],
      ],
      [
        "billing_usage_reservations",
        (
          await Promise.all([
            ctx.db
              .query("billing_usage_windows")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
              .unique(),
            ctx.db
              .query("billing_usage_windows")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
              .unique(),
          ])
        ).filter((row) => (row?.activeReservedMicroCents ?? 0) !== 0),
      ],
      [
        "billing_managed_dispatch_leases",
        [
          ...(await ctx.db
            .query("billing_managed_dispatch_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("billing_managed_dispatch_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "billing_managed_execution_leases",
        [
          ...(await ctx.db
            .query("billing_managed_execution_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("billing_managed_execution_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "voice_provider_dispatch_leases",
        [
          ...(await ctx.db
            .query("voice_provider_dispatch_leases")
            .withIndex("by_ownerId_and_state", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("voice_provider_dispatch_leases")
            .withIndex("by_ownerId_and_state", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "voice_realtime_authority",
        [
          ...(await ctx.db
            .query("billing_voice_sessions")
            .withIndex(
              "by_ownerId_and_authorityState_and_authorityExpiresAt",
              (q) =>
                q
                  .eq("ownerId", args.fromOwnerId)
                  .eq("authorityState", "active"),
            )
            .take(1)),
          ...(await ctx.db
            .query("billing_voice_sessions")
            .withIndex(
              "by_ownerId_and_authorityState_and_authorityExpiresAt",
              (q) =>
                q
                  .eq("ownerId", args.fromOwnerId)
                  .eq("authorityState", "cancel_requested"),
            )
            .take(1)),
          ...(await ctx.db
            .query("billing_voice_sessions")
            .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
              q.eq("ownerId", args.fromOwnerId).eq("status", "active"),
            )
            .take(1)),
          ...(await ctx.db
            .query("billing_voice_sessions")
            .withIndex(
              "by_ownerId_and_authorityState_and_authorityExpiresAt",
              (q) =>
                q.eq("ownerId", args.toOwnerId).eq("authorityState", "active"),
            )
            .take(1)),
          ...(await ctx.db
            .query("billing_voice_sessions")
            .withIndex(
              "by_ownerId_and_authorityState_and_authorityExpiresAt",
              (q) =>
                q
                  .eq("ownerId", args.toOwnerId)
                  .eq("authorityState", "cancel_requested"),
            )
            .take(1)),
          ...(await ctx.db
            .query("billing_voice_sessions")
            .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("status", "active"),
            )
            .take(1)),
        ],
      ],
      [
        "cloud_drive_uploads",
        await ctx.db
          .query("cloud_drive_uploads")
          .withIndex("by_ownerId_and_path", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "x_oauth_states",
        await ctx.db
          .query("x_oauth_states")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_engine_connects",
        await ctx.db
          .query("cloud_engine_connects")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_github_install_states",
        await ctx.db
          .query("cloud_github_install_states")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "mobile_bridge_sessions",
        await ctx.db
          .query("mobile_bridge_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "mobile_pairing_sessions",
        await ctx.db
          .query("mobile_pairing_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "mobile_connect_intents",
        await ctx.db
          .query("mobile_connect_intents")
          .withIndex("by_ownerId_and_desktopDeviceId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_usage_credits",
        await ctx.db
          .query("billing_usage_credits")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "billing_usage_credit_purchases",
        await ctx.db
          .query("billing_usage_credit_purchases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_invoice_payments",
        await ctx.db
          .query("billing_invoice_payments")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "media_private_blob_cleanup",
        await ctx.db
          .query("media_private_blob_cleanup")
          .withIndex("by_ownerId_and_state", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_private_payload_manifests",
        await ctx.db
          .query("media_private_payload_manifests")
          .withIndex("by_ownerId_and_state", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_private_payload_chunks",
        await ctx.db
          .query("media_private_payload_chunks")
          .withIndex("by_ownerId_and_manifestId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "media_provider_cancellations",
        await ctx.db
          .query("media_provider_cancellations")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_owner_purges",
        await ctx.db
          .query("media_owner_purges")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "stella_relay_response_streams",
        await ctx.db
          .query("stella_relay_response_streams")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_relay_response_leases",
        await ctx.db
          .query("stella_relay_response_leases")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_relay_cancellation_intents",
        await ctx.db
          .query("stella_relay_cancellation_intents")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "stella_relay_owner_purges",
        await ctx.db
          .query("stella_relay_owner_purges")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "tts_hls_segments",
        [
          ...(await ctx.db
            .query("tts_hls_segments")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("tts_hls_segments")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "tts_stream_tickets",
        [
          ...(await ctx.db
            .query("tts_stream_tickets")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("tts_stream_tickets")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "tts_provider_dispatch_leases",
        [
          ...(await ctx.db
            .query("tts_provider_dispatch_leases")
            .withIndex("by_ownerId_and_state", (q) =>
              q.eq("ownerId", args.fromOwnerId).eq("state", "active"),
            )
            .take(1)),
          ...(await ctx.db
            .query("tts_provider_dispatch_leases")
            .withIndex("by_ownerId_and_state", (q) =>
              q.eq("ownerId", args.fromOwnerId).eq("state", "cancel_requested"),
            )
            .take(1)),
          ...(await ctx.db
            .query("tts_provider_dispatch_leases")
            .withIndex("by_ownerId_and_state", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("state", "active"),
            )
            .take(1)),
          ...(await ctx.db
            .query("tts_provider_dispatch_leases")
            .withIndex("by_ownerId_and_state", (q) =>
              q.eq("ownerId", args.toOwnerId).eq("state", "cancel_requested"),
            )
            .take(1)),
        ],
      ],
      [
        "emoji_packs",
        await ctx.db
          .query("emoji_packs")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "account_external_media_objects",
        await ctx.db
          .query("account_external_media_objects")
          .withIndex("by_ownerId_and_uploadId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "canvas_shares",
        await ctx.db
          .query("canvas_shares")
          .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", ownerId))
          .take(1),
      ],
    ] as const;
    const retryableTransientTables = new Set<string>([
      "billing_managed_dispatch_leases",
      "billing_managed_execution_leases",
      "billing_usage_reservations",
      "voice_provider_dispatch_leases",
      "cloud_drive_uploads",
      "x_oauth_states",
      "cloud_engine_connects",
      "cloud_github_install_states",
      "mobile_bridge_sessions",
      "mobile_pairing_sessions",
      "mobile_connect_intents",
      "media_private_blob_cleanup",
      "media_private_payload_manifests",
      "media_private_payload_chunks",
      "media_provider_cancellations",
      "media_owner_purges",
      "stella_relay_response_streams",
      "stella_relay_response_leases",
      "stella_relay_cancellation_intents",
      "stella_relay_owner_purges",
      "tts_hls_segments",
      "tts_stream_tickets",
      // Provider actions observe the permanent source fence, self-cancel, and
      // release this exact-attempt lease. Migration waits for that release (or
      // its hard reaper) and never transfers ephemeral provider authority.
      "tts_provider_dispatch_leases",
      "emoji_packs",
      "account_external_media_objects",
    ]);
    for (const [table, rows] of blockedChecks) {
      if (rows.length > 0) {
        return retryableTransientTables.has(table)
          ? ({ kind: "retry", table } as const)
          : ({ kind: "blocked", table } as const);
      }
    }

    const retryChecks = [
      [
        "cloud_engine_import_source_reference",
        [
          ...(await ctx.db
            .query("cloud_llm_credentials")
            .withIndex("by_importedFromOwnerId", (q) =>
              q.eq("importedFromOwnerId", ownerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("cloud_engine_settings")
            .withIndex("by_importedFromOwnerId", (q) =>
              q.eq("importedFromOwnerId", ownerId),
            )
            .take(1)),
        ],
      ],
      [
        "events.remote_turn_request",
        [
          ...(await ctx.db
            .query("events")
            .withIndex("by_ownerId_requestState", (q) =>
              q.eq("ownerId", ownerId).eq("requestState", "pending"),
            )
            .take(1)),
          ...(await ctx.db
            .query("events")
            .withIndex("by_ownerId_requestState", (q) =>
              q.eq("ownerId", ownerId).eq("requestState", "claimed"),
            )
            .take(1)),
          ...(await ctx.db
            .query("events")
            .withIndex("by_ownerId_requestState", (q) =>
              q.eq("ownerId", ownerId).eq("requestState", "fulfilled"),
            )
            .take(1)),
          ...(await ctx.db
            .query("events")
            .withIndex("by_ownerId_requestState", (q) =>
              q.eq("ownerId", ownerId).eq("requestState", "cancelled"),
            )
            .take(1)),
        ].filter((row) => row.type === "remote_turn_request"),
      ],
      [
        "conversations",
        await ctx.db
          .query("conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_conversations",
        await ctx.db
          .query("cloud_conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_conversation_edits",
        await ctx.db
          .query("cloud_conversation_edits")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "user_preferences",
        await ctx.db
          .query("user_preferences")
          .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "billing_managed_request_bindings",
        await ctx.db
          .query("billing_managed_request_bindings")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_stripe_operations",
        await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_stripe_operation_resolutions",
        await ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_ownerId_and_resolvedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "usage_logs",
        await ctx.db
          .query("usage_logs")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "usage_rollups",
        await ctx.db
          .query("usage_rollups")
          .withIndex("by_ownerId_and_bucketStartMs", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_usage_windows",
        await ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "billing_profiles",
        await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "internal_tts_usage",
        await ctx.db
          .query("internal_tts_usage")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "fashion_profiles",
        await ctx.db
          .query("fashion_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "fashion_outfits",
        await ctx.db
          .query("fashion_outfits")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "fashion_likes",
        await ctx.db
          .query("fashion_likes")
          .withIndex("by_ownerId_and_likedAt", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "fashion_cart_items",
        await ctx.db
          .query("fashion_cart_items")
          .withIndex("by_ownerId_and_addedAt", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "fashion_checkout_sessions",
        await ctx.db
          .query("fashion_checkout_sessions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "x_oauth_tokens",
        await ctx.db
          .query("x_oauth_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "mobile_bridge_registrations",
        await ctx.db
          .query("mobile_bridge_registrations")
          .withIndex("by_ownerId_and_deviceId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "mobile_bridge_registration_limits",
        await ctx.db
          .query("mobile_bridge_registration_limits")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "device_identity_successors",
        await ctx.db
          .query("device_identity_successors")
          .withIndex("by_ownerId_and_previousDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "desktop_execution_presence",
        [
          ...(await ctx.db
            .query("desktop_execution_presence")
            .withIndex("by_ownerId_and_deviceId", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("desktop_execution_presence")
            .withIndex("by_ownerId_and_deviceId", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "execution_dispatches",
        [
          ...(await ctx.db
            .query("execution_dispatches")
            .withIndex("by_ownerId_and_updatedAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .take(1)),
          ...(await ctx.db
            .query("execution_dispatches")
            .withIndex("by_ownerId_and_updatedAt", (q) =>
              q.eq("ownerId", args.toOwnerId),
            )
            .take(1)),
        ],
      ],
      [
        "execution_offers",
        [
          ...(await ctx.db
            .query("execution_offers")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .take(1)),
          ...(await ctx.db
            .query("execution_offers")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
            .take(1)),
        ],
      ],
      [
        "execution_dispatch_payloads",
        [
          ...(await ctx.db
            .query("execution_dispatch_payloads")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .take(1)),
          ...(await ctx.db
            .query("execution_dispatch_payloads")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
            .take(1)),
        ],
      ],
      [
        "paired_mobile_devices",
        await ctx.db
          .query("paired_mobile_devices")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "mobile_push_tokens",
        await ctx.db
          .query("mobile_push_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloudflare_tunnels",
        await ctx.db
          .query("cloudflare_tunnels")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_jobs",
        await ctx.db
          .query("media_jobs")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_apps",
        await ctx.db
          .query("cloud_apps")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_app_builds",
        await ctx.db
          .query("cloud_app_builds")
          .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_app_operations",
        await ctx.db
          .query("cloud_app_operations")
          .withIndex("by_ownerId_and_appId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_app_op_invocations",
        await ctx.db
          .query("cloud_app_op_invocations")
          .withIndex("by_ownerId_and_appId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_projects",
        await ctx.db
          .query("cloud_projects")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_drive_files",
        await ctx.db
          .query("cloud_drive_files")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_agent_home_docs",
        await ctx.db
          .query("cloud_agent_home_docs")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_agent_home_preferences",
        await ctx.db
          .query("cloud_agent_home_preferences")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_memory_lifecycles",
        await ctx.db
          .query("cloud_memory_lifecycles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_memory_wipe_jobs",
        await ctx.db
          .query("cloud_memory_wipe_jobs")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_agent_home_doc_versions",
        await ctx.db
          .query("cloud_agent_home_doc_versions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_agent_home_write_intents",
        await ctx.db
          .query("cloud_agent_home_write_intents")
          .withIndex("by_ownerId_and_status_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_skills",
        await ctx.db
          .query("cloud_skills")
          .withIndex("by_ownerId_and_deletedAt_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_skill_versions",
        await ctx.db
          .query("cloud_skill_versions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_skill_write_intents",
        await ctx.db
          .query("cloud_skill_write_intents")
          .withIndex("by_ownerId_and_status_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_skill_files",
        await ctx.db
          .query("cloud_skill_files")
          .withIndex("by_ownerId_and_skillId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_skill_authorizations",
        await ctx.db
          .query("cloud_skill_authorizations")
          .withIndex("by_ownerId_and_skillId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_scheduled_turns",
        await ctx.db
          .query("cloud_scheduled_turns")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_schedule_receipts",
        await ctx.db
          .query("cloud_schedule_receipts")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_integration_call_receipts",
        await ctx.db
          .query("cloud_integration_call_receipts")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "devices",
        await ctx.db
          .query("devices")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "auth_revoked_sessions",
        await ctx.db
          .query("auth_revoked_sessions")
          .withIndex("by_ownerId_and_sessionId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "secrets",
        await ctx.db
          .query("secrets")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "secret_access_audit",
        await ctx.db
          .query("secret_access_audit")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "user_integrations",
        await ctx.db
          .query("user_integrations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "composio_session_provisioning_resolutions",
        await ctx.db
          .query("composio_session_provisioning_resolutions")
          .withIndex("by_ownerId_and_resolvedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "connector_turn_payloads",
        await ctx.db
          .query("connector_turn_payloads")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "agents",
        await ctx.db
          .query("agents")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "user_counters",
        await ctx.db
          .query("user_counters")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "billing_voice_usage_receipts",
        await ctx.db
          .query("billing_voice_usage_receipts")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_media_usage_receipts",
        await ctx.db
          .query("billing_media_usage_receipts")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "billing_voice_sessions",
        await ctx.db
          .query("billing_voice_sessions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "media_job_logs",
        await ctx.db
          .query("media_job_logs")
          .withIndex("by_ownerId_and_jobId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "media_request_cancellations",
        await ctx.db
          .query("media_request_cancellations")
          .withIndex("by_ownerId_and_clientRequestKey", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "media_webhook_events",
        await ctx.db
          .query("media_webhook_events")
          .withIndex("by_ownerId_and_receivedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_drive_usage",
        await ctx.db
          .query("cloud_drive_usage")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_drive_deletions",
        await ctx.db
          .query("cloud_drive_deletions")
          .withIndex("by_ownerId_and_deletedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_llm_credentials",
        await ctx.db
          .query("cloud_llm_credentials")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_engine_settings",
        await ctx.db
          .query("cloud_engine_settings")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_github_installations",
        await ctx.db
          .query("cloud_github_installations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_interior_builds",
        await ctx.db
          .query("cloud_interior_builds")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_interior_deployables",
        await ctx.db
          .query("cloud_interior_deployables")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "agent_turns",
        await ctx.db
          .query("agent_turns")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "agent_events",
        await ctx.db
          .query("agent_events")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_agent_threads",
        await ctx.db
          .query("cloud_agent_threads")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_thread_messages",
        await ctx.db
          .query("cloud_thread_messages")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_messages",
        await ctx.db
          .query("cloud_messages")
          .withIndex("by_ownerId_and_seq", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_turn_tokens",
        await ctx.db
          .query("cloud_turn_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ],
      [
        "cloud_message_excerpts",
        await ctx.db
          .query("cloud_message_excerpts")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_app_storage",
        await ctx.db
          .query("cloud_app_storage")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "cloud_app_storage.userId",
        await ctx.db
          .query("cloud_app_storage")
          .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", ownerId))
          .take(1),
      ],
    ] as const;
    for (const [table, rows] of retryChecks) {
      if (rows.length > 0) return { kind: "retry", table } as const;
    }
    return { kind: "clear" } as const;
  },
});

/** Bound on how many duplicate-default conversations we'll consider. */
const DEDUPLICATE_DEFAULT_BATCH = 200;

/**
 * Deduplicate default conversations after migration.
 * If the target user already has a default conversation, un-default the
 * migrated ones to avoid constraint violations.
 */
export const deduplicateDefaultConversation = internalMutation({
  args: leasedOwnerArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    if ((migration.cloudProductStage ?? "owner-namespaces") !== "complete") {
      throw new ConvexError({
        code: "STALE_OWNERSHIP_MIGRATION_STAGE",
        message: "Final ownership cleanup ran before cloud transfer completed.",
      });
    }
    const defaults = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("isDefault", true),
      )
      .take(DEDUPLICATE_DEFAULT_BATCH);

    if (defaults.length <= 1) return null;

    defaults.sort((a, b) => a.createdAt - b.createdAt);
    const promises = [];
    for (let i = 1; i < defaults.length; i++) {
      promises.push(ctx.db.patch(defaults[i]._id, { isDefault: false }));
    }
    await Promise.all(promises);

    return null;
  },
});

/**
 * After ownership migration, both the source and destination owner may have
 * a `user_counters` row. Collapse them by summing the conversation counts
 * into the oldest row and deleting the duplicates so future quota lookups
 * find a single row via `unique()`.
 */
export const deduplicateUserCounters = internalMutation({
  args: leasedOwnerArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    if ((migration.cloudProductStage ?? "owner-namespaces") !== "complete") {
      throw new ConvexError({
        code: "STALE_OWNERSHIP_MIGRATION_STAGE",
        message: "Final ownership cleanup ran before cloud transfer completed.",
      });
    }
    const rows = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .take(64);

    if (rows.length <= 1) return null;

    rows.sort((a, b) => a._creationTime - b._creationTime);
    const [primary, ...duplicates] = rows;
    const totalCount = rows.reduce(
      (sum, row) => sum + (row.conversationCount ?? 0),
      0,
    );
    await ctx.db.patch(primary._id, {
      conversationCount: totalCount,
      updatedAt: Date.now(),
    });
    await Promise.all(duplicates.map((row) => ctx.db.delete(row._id)));
    return null;
  },
});

/**
 * Tables whose batches are independent of every other table — drainable in
 * parallel from the orchestrator. `devices` uses a dedicated migration because
 * duplicate device ids must be merged during account linking.
 */
const PARALLEL_TABLE_MUTATIONS = [
  internal.auth_migration.migrateConversationsBatch,
  internal.auth_migration.migrateUserPreferencesBatch,
  internal.auth_migration.migrateAuthSessionPoliciesBatch,
  internal.auth_migration.migrateSecretsBatch,
  internal.auth_migration.migrateSecretAccessAuditBatch,
  internal.auth_migration.migrateUserIntegrationsBatch,
  internal.auth_migration.migrateComposioSessionProvisioningResolutionsBatch,
  internal.auth_migration.migrateUsageLogsBatch,
  internal.auth_migration.migrateConnectorTurnPayloadsBatch,
  internal.auth_migration.migrateAgentsBatch,
  internal.auth_migration.migrateMediaJobsBatch,
  internal.auth_migration.migrateMediaRequestCancellationsBatch,
  internal.auth_migration.migrateMediaJobLogsBatch,
  internal.auth_migration.migrateMediaWebhookEventsBatch,
  internal.auth_migration.migrateUserCountersBatch,
  internal.auth_migration.migrateFashionBatch,
  internal.auth_migration.migrateAccountExternalMediaContentBatch,
  internal.auth_migration.migrateXTokensBatch,
  internal.auth_migration.migrateDeviceExtensionsForAccountLink,
  internal.auth_migration.migrateDeviceIdentitySuccessorsBatch,
  internal.auth_migration.discardAnonymousTransientHandshakesBatch,
] as const;

type OwnerBatchMutation = FunctionReference<
  "mutation",
  "internal",
  OwnershipLease,
  { hasMore: boolean }
>;

const cloudBuilderEndpoint = (): { url: string; secret: string } | null => {
  const url = process.env.CLOUD_BUILDER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return url && secret ? { url, secret } : null;
};

type CloudOwnerActivityLease = {
  ownerId: string;
  ownerGeneration: string;
  generation: string;
  leaseId: string;
  sessionId: string;
  turnId: string;
};

const registerCloudOwnerActivityLease = async (args: {
  ownerId: string;
  ownerGeneration: string;
  activityId: string;
}): Promise<
  | { kind: "ack"; lease: CloudOwnerActivityLease }
  | { kind: "retry"; reason: string }
  | { kind: "permanent"; reason: string }
> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) {
    return {
      kind: "retry",
      reason: "Cloud builder endpoint is not configured.",
    };
  }
  try {
    const response = await fetch(
      `${builder.url}/internal/owners/activity/register`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builder.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      message?: unknown;
      ownerId?: unknown;
      ownerGeneration?: unknown;
      generation?: unknown;
      leaseId?: unknown;
      sessionId?: unknown;
      turnId?: unknown;
    } | null;
    const reason =
      typeof body?.message === "string"
        ? body.message
        : `Cloud owner activity lease returned ${response.status}.`;
    if (
      response.ok &&
      typeof body?.ownerId === "string" &&
      body.ownerId === args.ownerId &&
      body.ownerGeneration === args.ownerGeneration &&
      typeof body.generation === "string" &&
      typeof body.leaseId === "string" &&
      typeof body.sessionId === "string" &&
      typeof body.turnId === "string"
    ) {
      return {
        kind: "ack",
        lease: {
          ownerId: body.ownerId,
          ownerGeneration: args.ownerGeneration,
          generation: body.generation,
          leaseId: body.leaseId,
          sessionId: body.sessionId,
          turnId: body.turnId,
        },
      };
    }
    if (response.status === 409 && body?.code === "owner_purge") {
      return { kind: "permanent", reason };
    }
    return { kind: "retry", reason };
  } catch (error) {
    return {
      kind: "retry",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const releaseCloudOwnerActivityLease = async (
  lease: CloudOwnerActivityLease,
): Promise<void> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) return;
  await fetch(`${builder.url}/internal/owners/activity/unregister`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${builder.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(lease),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
};

type MigrationControlEnvelope = {
  migrationId: string;
  leaseId: string;
  leaseGeneration: number;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  stage: string;
  planRevision: number;
};

type CloudTransferReceipt = {
  transferOperationId: string;
  transferPlanFingerprint: string;
};

const sha256HexPattern = /^[a-f0-9]{64}$/;

const parseCloudTransferReceipt = (
  body: Record<string, unknown> | null,
): CloudTransferReceipt | null =>
  body?.transferred === true &&
  body.ackRequired === true &&
  typeof body.transferOperationId === "string" &&
  sha256HexPattern.test(body.transferOperationId) &&
  typeof body.transferPlanFingerprint === "string" &&
  sha256HexPattern.test(body.transferPlanFingerprint)
    ? {
        transferOperationId: body.transferOperationId,
        transferPlanFingerprint: body.transferPlanFingerprint,
      }
    : null;

const RETRYABLE_TRANSFER_CODES = new Set([
  "copy_in_progress",
  "transfer_busy",
  "owner_purge_temporary",
  "transfer_unavailable",
  "missing_binding",
]);
const PERMANENT_TRANSFER_CODES = new Set([
  "owner_purge_permanent",
  "owner_transfer_conflict",
  "destination_checkpoint_changed",
]);

const requestCloudConversationOwnerTransfer = async (
  args: {
    conversationId: string;
    fromOwnerId: string;
    toOwnerId: string;
  } & MigrationControlEnvelope,
): Promise<
  | ({ kind: "ack" } & CloudTransferReceipt)
  | { kind: "retry"; reason: string; retryAfterMs: number }
  | { kind: "permanent"; reason: string }
> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) {
    return {
      kind: "retry",
      reason: "Cloud builder endpoint is not configured.",
      retryAfterMs: 60_000,
    };
  }
  const response = await fetch(
    `${builder.url}/internal/conversations/${encodeURIComponent(args.conversationId)}/transfer-owner`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${builder.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fromOwnerId: args.fromOwnerId,
        toOwnerId: args.toOwnerId,
        migrationId: args.migrationId,
        leaseId: args.leaseId,
        leaseGeneration: args.leaseGeneration,
        fromOwnerGeneration: args.fromOwnerGeneration,
        toOwnerGeneration: args.toOwnerGeneration,
        stage: args.stage,
        planRevision: args.planRevision,
      }),
      signal: AbortSignal.timeout(150_000),
    },
  );
  const verdict = (await response.json().catch(() => null)) as
    | ({
        transferred?: unknown;
        ackRequired?: unknown;
        transferOperationId?: unknown;
        transferPlanFingerprint?: unknown;
        code?: unknown;
        message?: unknown;
        retryAfterMs?: unknown;
      } & Record<string, unknown>)
    | null;
  const code = typeof verdict?.code === "string" ? verdict.code : "";
  const reason =
    typeof verdict?.message === "string"
      ? verdict.message
      : `Cloud conversation ownership transfer returned ${response.status}.`;
  const retryAfterMs =
    typeof verdict?.retryAfterMs === "number" &&
    Number.isFinite(verdict.retryAfterMs)
      ? Math.min(60_000, Math.max(1_000, verdict.retryAfterMs))
      : 5_000;
  const receipt = parseCloudTransferReceipt(verdict);
  if (response.ok && receipt) return { kind: "ack", ...receipt };
  if (response.status === 202 || RETRYABLE_TRANSFER_CODES.has(code)) {
    return { kind: "retry", reason, retryAfterMs };
  }
  if (PERMANENT_TRANSFER_CODES.has(code)) {
    return { kind: "permanent", reason };
  }
  if (response.status === 400) {
    return { kind: "permanent", reason };
  }
  // A mixed Convex/worker rollout can temporarily expose no transfer route.
  // Treat 404 as deployment skew, not proof that user data is unrecoverable.
  if (response.status === 404) {
    return { kind: "retry", reason, retryAfterMs: 60_000 };
  }
  return { kind: "retry", reason, retryAfterMs };
};

type CloudProductTransferPayload = {
  fromOwnerId: string;
  toOwnerId: string;
  migrationId: string;
  leaseId: string;
  leaseGeneration: number;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  stage: string;
  planRevision: number;
  agentHome: boolean;
  interiors: boolean;
  workspaces: Array<{ from: string; to: string; importedTo?: string }>;
  appSlugs: string[];
};

type WorkspaceTransferResolution = {
  from: string;
  requestedTo: string;
  resolvedTo: string;
  imported: boolean;
};

const requestCloudProductOwnerTransfer = async (
  args: CloudProductTransferPayload,
): Promise<
  | {
      kind: "ack";
      transferOperationId: string;
      transferPlanFingerprint: string;
      fromOwnerHash: string;
      toOwnerHash: string;
      workspaceResolutions: WorkspaceTransferResolution[];
    }
  | { kind: "retry"; reason: string; retryAfterMs: number }
  | { kind: "permanent"; reason: string }
> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) {
    return {
      kind: "retry",
      reason: "Cloud builder endpoint is not configured.",
      retryAfterMs: 60_000,
    };
  }
  try {
    const response = await fetch(
      `${builder.url}/internal/owners/transfer-product-state`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builder.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(150_000),
      },
    );
    const body = (await response.json().catch(() => null)) as
      | ({
          transferred?: unknown;
          ackRequired?: unknown;
          transferOperationId?: unknown;
          transferPlanFingerprint?: unknown;
          fromOwnerHash?: unknown;
          toOwnerHash?: unknown;
          workspaceResolutions?: unknown;
          code?: unknown;
          message?: unknown;
          retryAfterMs?: unknown;
        } & Record<string, unknown>)
      | null;
    const reason =
      typeof body?.message === "string"
        ? body.message
        : `Cloud product ownership transfer returned ${response.status}.`;
    const retryAfterMs =
      typeof body?.retryAfterMs === "number" &&
      Number.isFinite(body.retryAfterMs)
        ? Math.min(60_000, Math.max(1_000, body.retryAfterMs))
        : 5_000;
    const receipt = parseCloudTransferReceipt(body);
    if (
      response.ok &&
      receipt &&
      typeof body?.fromOwnerHash === "string" &&
      typeof body.toOwnerHash === "string" &&
      Array.isArray(body.workspaceResolutions)
    ) {
      const workspaceResolutions: WorkspaceTransferResolution[] = [];
      for (const raw of body.workspaceResolutions) {
        if (!raw || typeof raw !== "object") {
          return {
            kind: "retry",
            reason: "Cloud product transfer returned an invalid workspace map.",
            retryAfterMs: 5_000,
          };
        }
        const entry = raw as Record<string, unknown>;
        if (
          typeof entry.from !== "string" ||
          typeof entry.requestedTo !== "string" ||
          typeof entry.resolvedTo !== "string" ||
          typeof entry.imported !== "boolean"
        ) {
          return {
            kind: "retry",
            reason: "Cloud product transfer returned an invalid workspace map.",
            retryAfterMs: 5_000,
          };
        }
        workspaceResolutions.push({
          from: entry.from,
          requestedTo: entry.requestedTo,
          resolvedTo: entry.resolvedTo,
          imported: entry.imported,
        });
      }
      const [expectedFromOwnerHash, expectedToOwnerHash] = await Promise.all([
        hashSha256Hex(args.fromOwnerId),
        hashSha256Hex(args.toOwnerId),
      ]);
      if (
        body.fromOwnerHash !== expectedFromOwnerHash ||
        body.toOwnerHash !== expectedToOwnerHash ||
        !workspaceTransferResolutionsMatch(
          args.workspaces,
          workspaceResolutions,
        )
      ) {
        return {
          kind: "retry",
          reason:
            "Cloud product transfer returned a workspace mapping that does not match the requested import plan.",
          retryAfterMs: 60_000,
        };
      }
      return {
        kind: "ack",
        ...receipt,
        fromOwnerHash: body.fromOwnerHash,
        toOwnerHash: body.toOwnerHash,
        workspaceResolutions,
      };
    }
    const code = typeof body?.code === "string" ? body.code : "";
    if (response.status === 400 || PERMANENT_TRANSFER_CODES.has(code)) {
      return { kind: "permanent", reason };
    }
    return { kind: "retry", reason, retryAfterMs };
  } catch (error) {
    return {
      kind: "retry",
      reason: error instanceof Error ? error.message : String(error),
      retryAfterMs: 5_000,
    };
  }
};

const acknowledgeCloudOwnerTransfer = async (
  args: OwnerIds & MigrationControlEnvelope & CloudTransferReceipt,
): Promise<
  | { kind: "ack" }
  | { kind: "stale" }
  | { kind: "retry"; reason: string; retryAfterMs: number }
  | { kind: "permanent"; reason: string }
> => {
  const builder = cloudBuilderEndpoint();
  if (!builder) {
    return {
      kind: "retry",
      reason: "Cloud builder endpoint is not configured.",
      retryAfterMs: 60_000,
    };
  }
  try {
    const response = await fetch(
      `${builder.url}/internal/owners/transfer-ack`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${builder.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      acknowledged?: unknown;
      code?: unknown;
      message?: unknown;
      retryAfterMs?: unknown;
    } | null;
    if (response.ok && body?.acknowledged === true) return { kind: "ack" };
    const code = typeof body?.code === "string" ? body.code : "";
    if (response.status === 409 && code === "stale_transfer_lease") {
      return { kind: "stale" };
    }
    const reason =
      typeof body?.message === "string"
        ? body.message
        : `Cloud transfer acknowledgement returned ${response.status}.`;
    const retryAfterMs =
      typeof body?.retryAfterMs === "number" &&
      Number.isFinite(body.retryAfterMs)
        ? Math.min(60_000, Math.max(1_000, body.retryAfterMs))
        : 5_000;
    if (
      (response.status === 409 && code === "owner_transfer_incomplete") ||
      (response.status === 404 && code === "owner_transfer_missing") ||
      response.status >= 500
    ) {
      return { kind: "retry", reason, retryAfterMs };
    }
    if (response.status === 400 || PERMANENT_TRANSFER_CODES.has(code)) {
      return { kind: "permanent", reason };
    }
    return { kind: "retry", reason, retryAfterMs };
  } catch (error) {
    return {
      kind: "retry",
      reason: error instanceof Error ? error.message : String(error),
      retryAfterMs: 5_000,
    };
  }
};

/**
 * Orchestrate the full ownership migration across all tables. Called
 * asynchronously via scheduler when an anonymous user links to a real
 * account.
 *
 * Tables whose drain is independent run concurrently (`Promise.all`) so a
 * tenant with data in many tables doesn't pay the sum of every per-table
 * round-trip. The devices/presence/connections migration runs first and
 * sequentially because `migrateDevicesForAccountLink` enforces a strict
 * order across those three tables.
 */
export const migrateOwnership = internalAction({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
    expectedLeaseGeneration: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return null;

    const leaseId = crypto.randomUUID();
    const claim = await ctx.runMutation(
      internal.auth_migration.claimOwnershipMigration,
      {
        fromOwnerId: args.fromOwnerId,
        toOwnerId: args.toOwnerId,
        leaseId,
        ...(args.expectedLeaseGeneration !== undefined
          ? { expectedLeaseGeneration: args.expectedLeaseGeneration }
          : {}),
        now: Date.now(),
      },
    );
    if (!claim.claimed) {
      return null;
    }
    if (
      !("migrationId" in claim) ||
      claim.migrationId === undefined ||
      claim.leaseGeneration === undefined ||
      claim.fromOwnerGeneration === undefined ||
      claim.toOwnerGeneration === undefined ||
      claim.planRevision === undefined
    ) {
      throw new Error("Ownership migration claim omitted its fence receipt.");
    }
    const ownerIds: OwnerIds = {
      fromOwnerId: args.fromOwnerId,
      toOwnerId: args.toOwnerId,
    };
    const migrationId = claim.migrationId;
    const leaseGeneration = claim.leaseGeneration;
    const fromOwnerGeneration = claim.fromOwnerGeneration;
    const toOwnerGeneration = claim.toOwnerGeneration;
    const planRevision = claim.planRevision;
    const leaseForCommit = (): OwnershipLease => ({
      ...ownerIds,
      leaseId,
      leaseGeneration,
      leaseNow: Date.now(),
    });

    const remoteTurns = await ctx.runMutation(
      internal.auth_migration.quiesceRemoteTurnsForOwnershipMigration,
      leaseForCommit(),
    );
    if (!remoteTurns.ready) {
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            remoteTurns.retryAfterAt === null
              ? 1_000
              : Math.min(
                  60_000,
                  Math.max(1_000, remoteTurns.retryAfterAt - now),
                ),
          error:
            "Account linking is waiting for a remote execution attempt to become quiescent.",
          now,
        },
      );
      return null;
    }

    const executionPlacement = await Promise.all(
      [args.fromOwnerId, args.toOwnerId].map((ownerId) =>
        ctx.runMutation(
          internal.execution_placement
            .quiesceOwnerExecutionPlacementForMigrationInternal,
          { migrationId, ownerId, now: Date.now() },
        ),
      ),
    );
    if (executionPlacement.some((result) => !result.ready)) {
      const retryAt = executionPlacement
        .map((result) => result.nextCheckAt)
        .filter((at): at is number => at !== undefined);
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            retryAt.length === 0
              ? 1_000
              : Math.min(60_000, Math.max(1_000, Math.min(...retryAt) - now)),
          error:
            "Account linking is waiting for automatic placement execution to become quiescent.",
          now,
        },
      );
      return null;
    }

    await Promise.all(
      [args.fromOwnerId, args.toOwnerId].map((ownerId) =>
        ctx.runMutation(
          internal.media_jobs
            .cancelOwnerMediaProviderDispatchesForMigrationInternal,
          { migrationId, ownerId, now: Date.now() },
        ),
      ),
    );
    await Promise.all(
      [args.fromOwnerId, args.toOwnerId].map((ownerId) =>
        ctx.runAction(
          internal.media_image_submission.drainOwnerProviderCancellations,
          { ownerId, limit: 100 },
        ),
      ),
    );
    const mediaDispatches = await Promise.all(
      [args.fromOwnerId, args.toOwnerId].map((ownerId) =>
        ctx.runMutation(
          internal.media_jobs
            .cancelOwnerMediaProviderDispatchesForMigrationInternal,
          { migrationId, ownerId, now: Date.now() },
        ),
      ),
    );
    if (mediaDispatches.some((result) => !result.ready)) {
      const retryAt = mediaDispatches
        .map((result) => result.retryAt)
        .filter((at): at is number => at !== null);
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            retryAt.length === 0
              ? 1_000
              : Math.min(60_000, Math.max(1_000, Math.min(...retryAt) - now)),
          error:
            "Account linking is waiting for a media provider attempt to become quiescent.",
          now,
        },
      );
      return null;
    }

    // HLS segments are children of the short-lived read-aloud ticket. Neither
    // is product state, and neither may regain provider authority after the
    // migration fence clears. Drain both principals child-first before waiting
    // on the durable provider-attempt receipts below.
    const ttsSessions = await Promise.all(
      [args.fromOwnerId, args.toOwnerId].map((ownerId) =>
        ctx.runMutation(
          internal.tts_hls.discardOwnerTtsSessionsForMigrationInternal,
          { ownerId },
        ),
      ),
    );
    if (ttsSessions.some((result) => !result.ready)) {
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs: 1_000,
          error:
            "Account linking is discarding transient TTS playback sessions.",
          now,
        },
      );
      return null;
    }

    const ttsDispatches = await Promise.all(
      [args.fromOwnerId, args.toOwnerId].map((ownerId) =>
        ctx.runMutation(
          internal.tts_dispatch
            .quiesceOwnerTtsProviderDispatchesForMigrationInternal,
          { ownerId, now: Date.now() },
        ),
      ),
    );
    if (ttsDispatches.some((result) => !result.ready)) {
      const retryAt = ttsDispatches
        .map((result) => result.retryAt)
        .filter((at): at is number => at !== null);
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            retryAt.length === 0
              ? 1_000
              : Math.min(60_000, Math.max(1_000, Math.min(...retryAt) - now)),
          error:
            "Account linking is waiting for a TTS provider attempt to become quiescent.",
          now,
        },
      );
      return null;
    }

    const voiceDispatches = await Promise.all(
      [args.fromOwnerId, args.toOwnerId].map((ownerId) =>
        ctx.runMutation(
          internal.voice_dispatch
            .cancelOwnerVoiceProviderDispatchesForMigrationInternal,
          { migrationId, ownerId, now: Date.now() },
        ),
      ),
    );
    if (voiceDispatches.some((result) => !result.ready)) {
      const retryAt = voiceDispatches
        .map((result) => result.retryAt)
        .filter((at): at is number => at !== null);
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            retryAt.length === 0
              ? 1_000
              : Math.min(60_000, Math.max(1_000, Math.min(...retryAt) - now)),
          error:
            "Account linking is waiting for a voice provider attempt to become quiescent.",
          now,
        },
      );
      return null;
    }

    // A metadata-owner update can have succeeded remotely while its action
    // lost the response. Generic Stripe quiescence must keep reset/delete
    // blocked, but this migration owns the exact transfer tuple and is the
    // only workflow allowed to GET/read back and commit it. Recover that tuple
    // before the generic gate or the gate would make its own recovery action
    // unreachable forever.
    const activeStripeMetadataTransfer = await ctx.runMutation(
      internal.auth_migration.hasActiveStripeCustomerMetadataTransferInternal,
      leaseForCommit(),
    );
    if (activeStripeMetadataTransfer) {
      let stripeTransfer: { hasMore: boolean; retryAt?: number };
      try {
        stripeTransfer = await ctx.runAction(
          internal.auth_migration
            .migrateNextStripeOperationWithProviderInternal,
          leaseForCommit(),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isOwnershipMigrationBlockedMessage(message)) {
          // Terminal provider ownership evidence is persisted together with a
          // failed migration lease by the exact-tuple mutation. Let the outer
          // migration handler observe the terminal classification; never
          // downgrade it to a retryable pending pass.
          throw error;
        }
        await ctx.runMutation(
          internal.auth_migration.finishOwnershipMigrationPass,
          {
            ...ownerIds,
            leaseId,
            leaseGeneration,
            outcome: "pending",
            retryAfterMs: 5_000,
            error: safeMigrationStatusError("pending"),
            now: Date.now(),
          },
        );
        console.error(
          `[auth_migration] Stripe metadata-transfer recovery will retry: ${message}`,
        );
        return null;
      }
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            stripeTransfer.retryAt === undefined
              ? 1_000
              : Math.min(60_000, Math.max(1_000, stripeTransfer.retryAt - now)),
          error:
            "Account linking is reconciling a Stripe customer metadata transfer.",
          now,
        },
      );
      return null;
    }

    const stripeDispatches = await ctx.runMutation(
      internal.auth_migration.quiesceStripeOperationsForOwnershipMigration,
      leaseForCommit(),
    );
    if (!stripeDispatches.ready) {
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            stripeDispatches.retryAt === null
              ? 5_000
              : Math.min(
                  60_000,
                  Math.max(1_000, stripeDispatches.retryAt - now),
                ),
          error:
            "Account linking is waiting for a Stripe operation to reconcile.",
          now,
        },
      );
      return null;
    }

    const managedDispatches = await ctx.runMutation(
      internal.auth_migration.quiesceManagedDispatchesForOwnershipMigration,
      leaseForCommit(),
    );
    if (!managedDispatches.ready) {
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs: 5_000,
          error:
            "Account linking is waiting for a managed provider attempt to become quiescent.",
          now: Date.now(),
        },
      );
      return null;
    }

    // Code-safe calls and direct native integration actions share the same
    // durable provider-dispatch receipt. Fence both identities before any
    // conversation, credential, or integration ownership moves: an action
    // admitted just before the migration marker may still be physically in
    // flight until its exact lease expires. The cloud-core transfer repeats
    // this check as a final transaction-side backstop before receipt rows move.
    const integrationCalls = await Promise.all(
      [args.fromOwnerId, args.toOwnerId].map((ownerId) =>
        ctx.runQuery(
          internal.cloud_purge.getOwnerIntegrationCallQuiescenceInternal,
          { ownerId, now: Date.now() },
        ),
      ),
    );
    if (integrationCalls.some((result) => !result.ready)) {
      const nextCheckAt = integrationCalls
        .map((result) => result.nextCheckAt)
        .filter((at): at is number => at !== undefined);
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            nextCheckAt.length === 0
              ? 5_000
              : Math.min(
                  60_000,
                  Math.max(1_000, Math.min(...nextCheckAt) - now),
                ),
          error:
            "Account linking is waiting for a connected integration action to become quiescent.",
          now,
        },
      );
      return null;
    }

    const composioProvisioning = await ctx.runMutation(
      internal.auth_migration.quiesceComposioProvisioningForOwnershipMigration,
      leaseForCommit(),
    );
    if (!composioProvisioning.ready) {
      const now = Date.now();
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: "pending",
          retryAfterMs:
            composioProvisioning.retryAt === null
              ? 60_000
              : Math.min(
                  60_000,
                  Math.max(1_000, composioProvisioning.retryAt - now),
                ),
          error:
            "Account linking is waiting for Composio session provisioning to reconcile.",
          now,
        },
      );
      return null;
    }

    const readyAck = await ctx.runQuery(
      internal.auth_migration.getReadyExternalTransferAck,
      ownerIds,
    );
    if (readyAck) {
      const verdict = await acknowledgeCloudOwnerTransfer({
        ...ownerIds,
        migrationId: readyAck.migrationId,
        leaseId: readyAck.leaseId,
        leaseGeneration: readyAck.leaseGeneration,
        fromOwnerGeneration: readyAck.fromOwnerGeneration,
        toOwnerGeneration: readyAck.toOwnerGeneration,
        stage: readyAck.stage,
        planRevision: readyAck.planRevision,
        transferOperationId: readyAck.transferOperationId,
        transferPlanFingerprint: readyAck.transferPlanFingerprint,
      });
      if (verdict.kind === "stale") return null;
      let ackOutcome: "pending" | "failed" = "pending";
      let ackRetryAfterMs = 5_000;
      let ackError: string | undefined;
      if (verdict.kind === "ack") {
        const cleared = await ctx.runMutation(
          internal.auth_migration.clearReadyExternalTransferAck,
          {
            ...leaseForCommit(),
            transferOperationId: readyAck.transferOperationId,
            transferPlanFingerprint: readyAck.transferPlanFingerprint,
          },
        );
        if (!cleared) ackError = "Cloud transfer acknowledgement changed.";
        else ackRetryAfterMs = 1_000;
      } else {
        ackOutcome = verdict.kind === "permanent" ? "failed" : "pending";
        ackRetryAfterMs =
          verdict.kind === "retry" ? verdict.retryAfterMs : 5_000;
        ackError = verdict.reason;
      }
      await ctx.runMutation(
        internal.auth_migration.finishOwnershipMigrationPass,
        {
          ...ownerIds,
          leaseId,
          leaseGeneration,
          outcome: ackOutcome,
          retryAfterMs: ackRetryAfterMs,
          ...(ackError ? { error: safeMigrationStatusError(ackOutcome) } : {}),
          now: Date.now(),
        },
      );
      return null;
    }

    let outcome: "pending" | "failed" | "complete" = "pending";
    let retryAfterMs = 5_000;
    let migrationError: string | undefined;
    try {
      const cloudConversations: Array<{
        conversationId: string;
        deleted: boolean;
        purged: boolean;
      }> = await ctx.runQuery(
        internal.auth_migration.listCloudConversationTransferBatch,
        ownerIds,
      );
      const conversation = cloudConversations[0];
      if (conversation) {
        if (conversation.deleted) {
          if (!conversation.purged) {
            await ctx.runAction(internal.cloud_apps.purgeConversationInternal, {
              conversationId: conversation.conversationId,
              ownerId: args.fromOwnerId,
            });
          } else {
            await ctx.runMutation(
              internal.auth_migration.commitDeletedCloudConversationTransfer,
              {
                ...leaseForCommit(),
                conversationId: conversation.conversationId,
              },
            );
          }
          retryAfterMs = 1_000;
        } else {
          // Even an empty conversation may already have bound its Durable
          // Object when a client opened a socket. Always rekey the DO before
          // flipping the Convex index; lastSeq cannot prove no DO exists.
          // Hold both owner purge fences through the Convex projection commit.
          // Without this, account deletion can begin after the DO rekeys but
          // before the index flips, miss the conversation, and then race a stale
          // commit that resurrects data under the deleted account.
          const heldLeases: CloudOwnerActivityLease[] = [];
          const activityId = `owner-transfer:${leaseId}:${conversation.conversationId}`;
          try {
            for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
              const expectedOwnerGeneration =
                ownerId === args.fromOwnerId
                  ? fromOwnerGeneration
                  : toOwnerGeneration;
              try {
                const active = await assertOwnerDataAccessActive(ctx, ownerId);
                if (active.generation !== expectedOwnerGeneration) {
                  outcome = "failed";
                  migrationError =
                    "Account data changed before cloud ownership transfer.";
                  break;
                }
              } catch {
                outcome = "failed";
                migrationError =
                  "Account deletion or reset blocked cloud ownership transfer.";
                break;
              }
              const registration = await registerCloudOwnerActivityLease({
                ownerId,
                ownerGeneration: expectedOwnerGeneration,
                activityId,
              });
              if (registration.kind === "permanent") {
                outcome = "failed";
                migrationError = registration.reason;
                break;
              }
              if (registration.kind === "retry") {
                migrationError = registration.reason;
                retryAfterMs = 60_000;
                break;
              }
              heldLeases.push(registration.lease);
            }
            if (heldLeases.length === 2 && outcome !== "failed") {
              const verdict = await requestCloudConversationOwnerTransfer({
                conversationId: conversation.conversationId,
                ...ownerIds,
                migrationId: String(migrationId),
                leaseId,
                leaseGeneration,
                fromOwnerGeneration,
                toOwnerGeneration,
                stage: "conversations",
                planRevision,
              });
              if (verdict.kind === "permanent") {
                outcome = "failed";
                migrationError = verdict.reason;
              } else if (verdict.kind === "retry") {
                migrationError = verdict.reason;
                retryAfterMs = verdict.retryAfterMs;
              } else {
                await ctx.runMutation(
                  internal.auth_migration.commitCloudConversationTransferBatch,
                  {
                    ...leaseForCommit(),
                    conversationId: conversation.conversationId,
                    transferOperationId: verdict.transferOperationId,
                    transferPlanFingerprint: verdict.transferPlanFingerprint,
                    transferStage: "conversations",
                  },
                );
                retryAfterMs = 1_000;
              }
            }
          } finally {
            await Promise.all(
              heldLeases.map((held) => releaseCloudOwnerActivityLease(held)),
            );
          }
        }
      } else {
        const work = await ctx.runQuery(
          internal.auth_migration.getCloudProductTransferWork,
          ownerIds,
        );
        if (work.kind === "advance") {
          await ctx.runMutation(
            internal.auth_migration.advanceCloudProductTransferStage,
            {
              ...leaseForCommit(),
              stage: work.stage,
              nextStage: work.nextStage,
            },
          );
          retryAfterMs = 1_000;
        } else if (work.kind === "core") {
          const result = await ctx.runMutation(
            internal.auth_migration.migrateCloudProductCoreBatch,
            leaseForCommit(),
          );
          if (!result.hasMore) {
            await ctx.runMutation(
              internal.auth_migration.advanceCloudProductTransferStage,
              {
                ...leaseForCommit(),
                stage: "core",
                nextStage: "complete",
              },
            );
          }
          retryAfterMs = 1_000;
        } else if (work.kind !== "complete") {
          const namespaceBlocker =
            work.kind === "owner-namespaces"
              ? await ctx.runQuery(
                  internal.auth_migration.getOwnerNamespaceTransferBlocker,
                  ownerIds,
                )
              : null;
          if (namespaceBlocker) {
            outcome = "failed";
            migrationError = namespaceBlocker;
          }
          const payload: CloudProductTransferPayload = {
            ...ownerIds,
            migrationId: String(migrationId),
            leaseId,
            leaseGeneration,
            fromOwnerGeneration,
            toOwnerGeneration,
            stage: work.kind,
            planRevision,
            agentHome: work.kind === "owner-namespaces",
            interiors: work.kind === "interior",
            workspaces:
              work.kind === "owner-namespaces"
                ? [
                    {
                      from: "drive",
                      to: "drive",
                      importedTo: work.driveImportedWorkspace,
                    },
                    {
                      from: "stella",
                      to: "stella",
                      importedTo: work.stellaImportedWorkspace,
                    },
                  ]
                : work.kind === "app"
                  ? [
                      {
                        from: `app:${work.slug}`,
                        to: `app:${work.slug}`,
                        importedTo: work.importedWorkspace,
                      },
                    ]
                  : work.kind === "project"
                    ? [
                        {
                          from: work.fromWorkspace,
                          to: work.toWorkspace,
                          importedTo: work.importedWorkspace,
                        },
                      ]
                    : [],
            appSlugs: work.kind === "app" ? [work.slug] : [],
          };
          const heldLeases: CloudOwnerActivityLease[] = [];
          const activityId = `owner-product-transfer:${leaseId}:${work.kind}`;
          try {
            for (const ownerId of namespaceBlocker
              ? []
              : [args.fromOwnerId, args.toOwnerId]) {
              const expectedOwnerGeneration =
                ownerId === args.fromOwnerId
                  ? fromOwnerGeneration
                  : toOwnerGeneration;
              try {
                const active = await assertOwnerDataAccessActive(ctx, ownerId);
                if (active.generation !== expectedOwnerGeneration) {
                  outcome = "failed";
                  migrationError =
                    "Account data changed before cloud ownership transfer.";
                  break;
                }
              } catch {
                outcome = "failed";
                migrationError =
                  "Account deletion or reset blocked cloud ownership transfer.";
                break;
              }
              const registration = await registerCloudOwnerActivityLease({
                ownerId,
                ownerGeneration: expectedOwnerGeneration,
                activityId,
              });
              if (registration.kind === "permanent") {
                outcome = "failed";
                migrationError = registration.reason;
                break;
              }
              if (registration.kind === "retry") {
                migrationError = registration.reason;
                retryAfterMs = 60_000;
                break;
              }
              heldLeases.push(registration.lease);
            }
            if (heldLeases.length === 2 && outcome !== "failed") {
              const verdict = await requestCloudProductOwnerTransfer(payload);
              if (verdict.kind === "permanent") {
                outcome = "failed";
                migrationError = verdict.reason;
              } else if (verdict.kind === "retry") {
                migrationError = verdict.reason;
                retryAfterMs = verdict.retryAfterMs;
              } else if (work.kind === "owner-namespaces") {
                const importedProjects: ImportedWorkspaceProject[] = [];
                const driveResolution = verdict.workspaceResolutions.find(
                  (entry) => entry.from === "drive",
                );
                if (driveResolution?.imported) {
                  importedProjects.push({
                    projectId: work.driveImportedProjectId,
                    workspace: driveResolution.resolvedTo,
                    name: "Anonymous Drive workspace (imported)",
                  });
                }
                const stellaResolution = verdict.workspaceResolutions.find(
                  (entry) => entry.from === "stella",
                );
                if (stellaResolution?.imported) {
                  importedProjects.push({
                    projectId: work.stellaImportedProjectId,
                    workspace: stellaResolution.resolvedTo,
                    name: "Anonymous Stella workspace (imported)",
                  });
                }
                await ctx.runMutation(
                  internal.auth_migration.commitOwnerNamespaceTransfer,
                  {
                    ...leaseForCommit(),
                    fromOwnerHash: verdict.fromOwnerHash,
                    toOwnerHash: verdict.toOwnerHash,
                    importedProjects,
                    transferOperationId: verdict.transferOperationId,
                    transferPlanFingerprint: verdict.transferPlanFingerprint,
                    transferStage: work.kind,
                  },
                );
                retryAfterMs = 1_000;
              } else if (work.kind === "app") {
                const resolution = verdict.workspaceResolutions.find(
                  (entry) => entry.from === `app:${work.slug}`,
                );
                await ctx.runMutation(
                  internal.auth_migration.commitCloudAppTransferBatch,
                  {
                    ...leaseForCommit(),
                    appId: work.appId,
                    fromOwnerHash: verdict.fromOwnerHash,
                    toOwnerHash: verdict.toOwnerHash,
                    transferOperationId: verdict.transferOperationId,
                    transferPlanFingerprint: verdict.transferPlanFingerprint,
                    transferStage: work.kind,
                    ...(resolution?.imported
                      ? {
                          importedProject: {
                            projectId: work.importedProjectId,
                            workspace: resolution.resolvedTo,
                            name: `${work.slug} app workspace (imported)`,
                          },
                        }
                      : {}),
                  },
                );
                retryAfterMs = 1_000;
              } else if (work.kind === "interior") {
                await ctx.runMutation(
                  internal.auth_migration.commitCloudInteriorTransferBatch,
                  {
                    ...leaseForCommit(),
                    fromOwnerHash: verdict.fromOwnerHash,
                    toOwnerHash: verdict.toOwnerHash,
                    transferOperationId: verdict.transferOperationId,
                    transferPlanFingerprint: verdict.transferPlanFingerprint,
                    transferStage: work.kind,
                  },
                );
                retryAfterMs = 1_000;
              } else {
                const resolution = verdict.workspaceResolutions.find(
                  (entry) => entry.from === work.fromWorkspace,
                );
                const resolvedWorkspace =
                  resolution?.resolvedTo ?? work.toWorkspace;
                const resolvedTargetSlug = resolvedWorkspace.startsWith(
                  "project:",
                )
                  ? resolvedWorkspace.slice("project:".length)
                  : "";
                if (!resolvedTargetSlug) {
                  outcome = "failed";
                  migrationError =
                    "The worker returned an invalid project workspace mapping.";
                } else {
                  const committed = await ctx.runMutation(
                    internal.auth_migration.commitCloudProjectTransfer,
                    {
                      ...leaseForCommit(),
                      projectId: work.projectId,
                      targetSlug: resolvedTargetSlug,
                      transferOperationId: verdict.transferOperationId,
                      transferPlanFingerprint: verdict.transferPlanFingerprint,
                      transferStage: work.kind,
                    },
                  );
                  if (!committed) {
                    outcome = "failed";
                    migrationError =
                      "The destination project slug changed during ownership transfer.";
                  } else {
                    retryAfterMs = 1_000;
                  }
                }
              }
            }
          } finally {
            await Promise.all(
              heldLeases.map((held) => releaseCloudOwnerActivityLease(held)),
            );
          }
        } else {
          const externalMediaCleanup = await ctx.runAction(
            internal.account_external_media
              .cleanupOwnerExternalMediaReservationsForMigrationInternal,
            {
              ...ownerIds,
              migrationId: String(migrationId),
              leaseId,
              leaseGeneration,
              fromOwnerGeneration,
              toOwnerGeneration,
              planRevision,
              now: Date.now(),
            },
          );
          if (!externalMediaCleanup.ready) {
            retryAfterMs = Math.min(
              60_000,
              Math.max(1_000, externalMediaCleanup.retryAfterMs ?? 5_000),
            );
          } else {
            const deviceMigration = await ctx.runMutation(
              internal.auth_migration.migrateDevicesForAccountLink,
              {
                ...leaseForCommit(),
              },
            );
            const stripeMigration = await ctx.runAction(
              internal.auth_migration
                .migrateNextStripeOperationWithProviderInternal,
              { ...leaseForCommit() },
            );
            const stripeResolutionMigration = stripeMigration.hasMore
              ? { hasMore: true }
              : await ctx.runMutation(
                  internal.auth_migration
                    .migrateStripeOperationResolutionsBatch,
                  { ...leaseForCommit() },
                );
            const usageAccountingMigration =
              stripeMigration.hasMore || stripeResolutionMigration.hasMore
                ? { hasMore: true }
                : await ctx.runMutation(
                    internal.auth_migration.migrateUsageAccountingBatch,
                    { ...leaseForCommit() },
                  );
            const independentMigrations = await Promise.all(
              PARALLEL_TABLE_MUTATIONS.map((mutation) =>
                ctx.runMutation(mutation as OwnerBatchMutation, {
                  ...leaseForCommit(),
                }),
              ),
            );
            if (
              deviceMigration.hasMore ||
              stripeMigration.hasMore ||
              stripeResolutionMigration.hasMore ||
              usageAccountingMigration.hasMore ||
              independentMigrations.some((result) => result.hasMore)
            ) {
              retryAfterMs = 1_000;
            } else {
              // These depend on all source-owner rows having drained.
              await Promise.all([
                ctx.runMutation(
                  internal.auth_migration.deduplicateDefaultConversation,
                  {
                    ...leaseForCommit(),
                  },
                ),
                ctx.runMutation(
                  internal.auth_migration.deduplicateUserCounters,
                  {
                    ...leaseForCommit(),
                  },
                ),
              ]);
              const residue = await ctx.runQuery(
                internal.auth_migration.auditOwnershipMigrationResidue,
                ownerIds,
              );
              if (residue.kind === "retry") {
                retryAfterMs = 1_000;
                migrationError = `Source-owner state reappeared in ${residue.table ?? "an anonymous-usable table"}; another bounded pass is required.`;
              } else if (residue.kind === "blocked") {
                outcome = "failed";
                migrationError = `Account linking is blocked by unresolved ${residue.table ?? "connected-only or in-flight"} state on the anonymous identity.`;
              } else {
                outcome = "complete";
                console.log(
                  `[auth_migration] Completed ownership migration ${String(migrationId)}.`,
                );
              }
            }
          }
        }
      }
    } catch (error) {
      migrationError = error instanceof Error ? error.message : String(error);
      if (isOwnershipMigrationBlockedMessage(migrationError)) {
        outcome = "failed";
        migrationError = migrationError
          .slice(OWNERSHIP_MIGRATION_BLOCKED_PREFIX.length)
          .trim();
        console.error(
          `[auth_migration] Ownership migration ${String(migrationId)} blocked.`,
        );
      } else {
        retryAfterMs = 5_000;
        console.error(
          `[auth_migration] Ownership migration ${String(migrationId)} will retry.`,
        );
      }
    }
    await ctx.runMutation(
      internal.auth_migration.finishOwnershipMigrationPass,
      {
        ...ownerIds,
        leaseId,
        leaseGeneration,
        outcome,
        retryAfterMs,
        ...(migrationError ? { error: safeMigrationStatusError(outcome) } : {}),
        now: Date.now(),
      },
    );
    return null;
  },
});

/** Migrate stable device profiles for an account-link in bounded batches. */
export const migrateDevicesForAccountLink = internalMutation({
  args: leasedOwnerArgs,
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    if ((migration.cloudProductStage ?? "owner-namespaces") !== "complete") {
      throw new ConvexError({
        code: "STALE_OWNERSHIP_MIGRATION_STAGE",
        message: "Device ownership moved before cloud transfer completed.",
      });
    }
    const deviceRows = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    for (const row of deviceRows) {
      if (
        row.ownerGeneration !== undefined &&
        row.ownerGeneration !== migration.fromOwnerGeneration
      ) {
        blockOwnershipMigration(
          "A device registration belongs to a stale source generation.",
        );
      }
      const existing = await ctx.db
        .query("devices")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("deviceId", row.deviceId),
        )
        .unique();

      if (existing) {
        if (
          existing.ownerGeneration !== undefined &&
          existing.ownerGeneration !== migration.toOwnerGeneration
        ) {
          blockOwnershipMigration(
            "A destination device registration belongs to a stale generation.",
          );
        }
        if (
          existing.devicePublicKey !== undefined &&
          row.devicePublicKey !== undefined &&
          existing.devicePublicKey !== row.devicePublicKey
        ) {
          blockOwnershipMigration(
            "Both identities contain different public keys for the same device.",
          );
        }
        await ctx.db.patch(existing._id, {
          ownerGeneration: migration.toOwnerGeneration!,
          devicePublicKey: existing.devicePublicKey ?? row.devicePublicKey,
        });
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, {
          ownerId: args.toOwnerId,
          ownerGeneration: migration.toOwnerGeneration!,
        });
      }
    }
    return { hasMore: deviceRows.length === BATCH_SIZE };
  },
});
