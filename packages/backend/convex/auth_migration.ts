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
import { composioUserIdForOwner } from "./lib/composio_identity";
import {
  assertSensitiveSessionPolicy,
  requireConnectedUserIdentity,
  tokenIdentifierForBetterAuthUserId,
} from "./auth";
import { enforceMutationRateLimit, RATE_SENSITIVE } from "./lib/rate_limits";
import {
  ownershipMigrationStatusValidator,
  readMyOwnershipMigrationStatus,
} from "./lib/ownership_migration_status";
import {
  importedOwnerScopedKey,
  importedProjectSlug,
  isOwnershipMigrationBlockedMessage,
  migratedSourceAuthDeletionOperationId,
  ownershipMigrationSourceDigest,
  ownershipMigrationTransientStateDisposition,
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
import { quiesceOwnerComposioSessionProvisioning } from "./composio_session_dispatch";

const BATCH_SIZE = 500;
const REMOTE_TURN_MIGRATION_BATCH = 32;
const REMOTE_TURN_CONVERSATION_PAGE = 12;
const REMOTE_TURN_PER_CONVERSATION_BATCH = 8;
const REMOTE_TURN_PROVIDER_DEADLINE_MS = 60_000;
const REMOTE_TURN_QUIESCENCE_GRACE_MS = 30_000;
const SAFE_COMPOSIO_USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/u;

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

export const discardAnonymousTransientHandshakesBatch = internalMutation({
  args: leasedOwnerArgs,
  returns: hasMoreReturn,
  handler: async (ctx, args) => {
    const migration = await requireActiveOwnershipMigrationLease(ctx, args);
    const migrationOwnerIds = [args.fromOwnerId, args.toOwnerId] as const;
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
    return { hasMore: false };
  },
});

const CLOUD_PROJECTION_BATCH_SIZE = 200;
const OWNERSHIP_MIGRATION_LEASE_MS = 9 * 60_000;
const OWNERSHIP_MIGRATION_FAILED_RETRY_COOLDOWN_MS = 60_000;
const OWNERSHIP_MIGRATION_COMPLETED_RAW_RETENTION_MS = 30 * 60_000;

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
  returns: ownershipMigrationStatusValidator,
  handler: async (ctx) => await readMyOwnershipMigrationStatus(ctx),
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
  v.literal("projects"),
  v.literal("core"),
  v.literal("complete"),
);
type CloudProductStage =
  | "owner-namespaces"
  | "apps"
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
  v.object({ kind: v.literal("owner-namespaces") }),
  v.object({
    kind: v.literal("app"),
    appId: v.string(),
    slug: v.string(),
  }),
  v.object({
    kind: v.literal("project"),
    projectId: v.string(),
    targetSlug: v.string(),
  }),
  v.object({
    kind: v.literal("advance"),
    stage: cloudProductStageValidator,
    nextStage: cloudProductStageValidator,
  }),
  v.object({ kind: v.literal("core") }),
  v.object({ kind: v.literal("complete") }),
);

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
      return { kind: "owner-namespaces" } as const;
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
        return { kind: "app", appId: app.appId, slug: app.slug } as const;
      }
      return {
        kind: "advance",
        stage,
        nextStage: "projects",
      } as const;
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
      return {
        kind: "project",
        projectId: project.projectId,
        targetSlug,
      } as const;
    }
    if (stage === "core") return { kind: "core" } as const;
    return { kind: "complete" } as const;
  },
});

const ownerNamespaceBlockerReturn = v.union(v.null(), v.string());

/**
 * Preflight the anonymous owner namespace before cloud-builder copies the
 * world checkpoint.
 */
export const getOwnerNamespaceTransferBlocker = internalQuery({
  args: ownerArgs,
  returns: ownerNamespaceBlockerReturn,
  handler: async (ctx, args) => {
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

// A mutation, not an action: the minute cron reads pending retirements and
// schedules them in one transaction, and an idle tick costs no action.
export const sweepMigratedSourceIdentityDeletionsInternal = internalMutation({
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
      const [invocations, events] = await Promise.all([
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
      await Promise.all(
        invocations.map((invocation) =>
          ctx.db.patch(invocation._id, { ownerId: args.toOwnerId }),
        ),
      );
      if (
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
      await ctx.db.patch(thread._id, { ownerId: args.toOwnerId });
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
    await requireActiveOwnershipMigrationLease(ctx, args);
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

export const commitOwnerNamespaceTransfer = internalMutation({
  args: {
    ...leasedOwnerArgs,
    ...externalTransferReceiptArgs,
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
    // The worker has copied the world checkpoint; no Convex row is rekeyed in
    // this stage.
    await ctx.db.patch(migration._id, { cloudProductStage: "apps" });
    return await finish({ hasMore: false, progressed: true });
  },
});

export const commitCloudAppTransferBatch = internalMutation({
  args: {
    ...leasedOwnerArgs,
    appId: v.string(),
    fromOwnerHash: v.string(),
    toOwnerHash: v.string(),
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
      const [invocation, events] = await Promise.all([
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
      if (invocation) {
        await ctx.db.patch(invocation._id, { ownerId: args.toOwnerId });
      }
      if (!invocation && !events.sourceHasMore) {
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
      await ctx.db.patch(thread._id, { ownerId: args.toOwnerId });
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
      "x_oauth_states",
      "cloud_engine_connects",
      "cloud_github_install_states",
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
        "x_oauth_tokens",
        await ctx.db
          .query("x_oauth_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
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
        "cloud_integration_call_receipts",
        await ctx.db
          .query("cloud_integration_call_receipts")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
      [
        "auth_revoked_sessions",
        await ctx.db
          .query("auth_revoked_sessions")
          .withIndex("by_ownerId_and_sessionId", (q) =>
            q.eq("ownerId", ownerId),
          )
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
  internal.auth_migration.migrateAuthSessionPoliciesBatch,
  internal.auth_migration.migrateSecretsBatch,
  internal.auth_migration.migrateSecretAccessAuditBatch,
  internal.auth_migration.migrateUserIntegrationsBatch,
  internal.auth_migration.migrateComposioSessionProvisioningResolutionsBatch,
  internal.auth_migration.migrateUsageLogsBatch,
  internal.auth_migration.migrateConnectorTurnPayloadsBatch,
  internal.auth_migration.migrateAgentsBatch,
  internal.auth_migration.migrateUserCountersBatch,
  internal.auth_migration.migrateXTokensBatch,
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
  world: boolean;
  appSlugs: string[];
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
      typeof body.toOwnerHash === "string"
    ) {
      const [expectedFromOwnerHash, expectedToOwnerHash] = await Promise.all([
        hashSha256Hex(args.fromOwnerId),
        hashSha256Hex(args.toOwnerId),
      ]);
      if (
        body.fromOwnerHash !== expectedFromOwnerHash ||
        body.toOwnerHash !== expectedToOwnerHash
      ) {
        return {
          kind: "retry",
          reason:
            "Cloud product transfer returned owner hashes that do not match the requested plan.",
          retryAfterMs: 60_000,
        };
      }
      return {
        kind: "ack",
        ...receipt,
        fromOwnerHash: body.fromOwnerHash,
        toOwnerHash: body.toOwnerHash,
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
 * round-trip.
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
            await ctx.runMutation(
              internal.cloud_apps.purgeConversationRowsInternal,
              { conversationId: conversation.conversationId },
            );
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
            agentHome: false,
            world: work.kind === "owner-namespaces",
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
                await ctx.runMutation(
                  internal.auth_migration.commitOwnerNamespaceTransfer,
                  {
                    ...leaseForCommit(),
                    transferOperationId: verdict.transferOperationId,
                    transferPlanFingerprint: verdict.transferPlanFingerprint,
                    transferStage: work.kind,
                  },
                );
                retryAfterMs = 1_000;
              } else if (work.kind === "app") {
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
                  },
                );
                retryAfterMs = 1_000;
              } else {
                const committed = await ctx.runMutation(
                  internal.auth_migration.commitCloudProjectTransfer,
                  {
                    ...leaseForCommit(),
                    projectId: work.projectId,
                    targetSlug: work.targetSlug,
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
          } finally {
            await Promise.all(
              heldLeases.map((held) => releaseCloudOwnerActivityLease(held)),
            );
          }
        } else {
          const independentMigrations = await Promise.all(
            PARALLEL_TABLE_MUTATIONS.map((mutation) =>
              ctx.runMutation(mutation as OwnerBatchMutation, {
                ...leaseForCommit(),
              }),
            ),
          );
          if (independentMigrations.some((result) => result.hasMore)) {
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

