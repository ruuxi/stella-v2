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
  isOwnershipMigrationBlockedMessage,
  migratedSourceAuthDeletionOperationId,
  ownershipMigrationSourceDigest,
} from "./lib/auth_migration_paths";
import {
  assertOwnerDataAccessActive,
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
} from "./owner_lifecycle";
import { ownerPurgeModeValidator } from "./schema/owner_lifecycle";

const BATCH_SIZE = 500;
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

const OWNERSHIP_MIGRATION_LEASE_MS = 9 * 60_000;
const OWNERSHIP_MIGRATION_FAILED_RETRY_COOLDOWN_MS = 60_000;
const OWNERSHIP_MIGRATION_COMPLETED_RAW_RETENTION_MS = 30 * 60_000;

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
    kind: v.literal("advance"),
    stage: cloudProductStageValidator,
    nextStage: cloudProductStageValidator,
  }),
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
    if (stage !== "complete") {
      return { kind: "advance", stage, nextStage: "complete" } as const;
    }
    return { kind: "complete" } as const;
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

const cloudProductBatchReturn = v.object({
  hasMore: v.boolean(),
  progressed: v.boolean(),
});

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
      return await finish({ hasMore: false, progressed: stage === "complete" });
    }
    // The worker has copied the world checkpoint; no Convex row is rekeyed in
    // this stage.
    await ctx.db.patch(migration._id, { cloudProductStage: "complete" });
    return await finish({ hasMore: false, progressed: true });
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
    const retryChecks = [
      [
        "auth_revoked_sessions",
        await ctx.db
          .query("auth_revoked_sessions")
          .withIndex("by_ownerId_and_sessionId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ],
    ] as const;
    for (const [table, rows] of retryChecks) {
      if (rows.length > 0) return { kind: "retry", table } as const;
    }
    return { kind: "clear" } as const;
  },
});

/**
 * Tables whose batches are independent of every other table — drainable in
 * parallel from the orchestrator. `devices` uses a dedicated migration because
 * duplicate device ids must be merged during account linking.
 */
const PARALLEL_TABLE_MUTATIONS = [
  internal.auth_migration.migrateAuthSessionPoliciesBatch,
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

const PERMANENT_TRANSFER_CODES = new Set([
  "owner_purge_permanent",
  "owner_transfer_conflict",
  "destination_checkpoint_changed",
]);

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
      } else if (work.kind === "owner-namespaces") {
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
          world: true,
          appSlugs: [],
        };
        const heldLeases: CloudOwnerActivityLease[] = [];
        const activityId = `owner-product-transfer:${leaseId}:${work.kind}`;
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
            const verdict = await requestCloudProductOwnerTransfer(payload);
            if (verdict.kind === "permanent") {
              outcome = "failed";
              migrationError = verdict.reason;
            } else if (verdict.kind === "retry") {
              migrationError = verdict.reason;
              retryAfterMs = verdict.retryAfterMs;
            } else {
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
          const residue = await ctx.runQuery(
            internal.auth_migration.auditOwnershipMigrationResidue,
            ownerIds,
          );
          if (residue.kind === "retry") {
            retryAfterMs = 1_000;
            migrationError = `Source-owner state reappeared in ${residue.table ?? "an anonymous-usable table"}; another bounded pass is required.`;
          } else {
            outcome = "complete";
            console.log(
              `[auth_migration] Completed ownership migration ${String(migrationId)}.`,
            );
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

