/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { ownershipMigrationSourceDigest } from "./lib/auth_migration_paths";
import { createManagedDispatchRequestFingerprint } from "./lib/managed_dispatch";
import { composioUserIdForOwner } from "./lib/composio_identity";
import { seedReadyMigrationBackupSweep } from "../tests/convex_backup_sweep_test_helpers";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js"]);
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};
const authCreateTriggerRef = makeFunctionReference<
  "mutation",
  { model: string; doc: Record<string, unknown> },
  null
>("auth:onBetterAuthComponentCreate");
const migrateUserIntegrations = makeFunctionReference<"mutation", any, any>(
  "auth_migration:migrateUserIntegrationsBatch",
);

beforeAll(() => {
  process.env.CONVEX_SITE_URL = "https://stella.test";
  const billingEnv: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "1",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "1",
    STELLA_FREE_MONTHLY_LIMIT_USD: "1",
    STELLA_FREE_LIFETIME_LIMIT_USD: "0.5",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(billingEnv)) {
    process.env[key] = value;
  }
});

afterEach(() => {
  vi.useRealTimers();
});

type OwnerArgs = { fromOwnerId: string; toOwnerId: string };
type PreparationArgs = OwnerArgs & {
  sourceAuthUserId?: string;
  sourceAuthUserEmail?: string;
};
type LeaseArgs = OwnerArgs & {
  leaseId: string;
  leaseGeneration: number;
  leaseNow: number;
};
type MigrationStatus = "pending" | "running" | "failed" | "complete";
type PurgeArgs = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
  mode: "reset" | "delete";
};

const migrationInternal = (
  internal as unknown as {
    auth_migration: {
      prepareOwnershipMigration: FunctionReference<
        "mutation",
        "internal",
        PreparationArgs,
        null
      >;
      claimOwnershipMigration: FunctionReference<
        "mutation",
        "internal",
        OwnerArgs & { leaseId: string; now: number },
        {
          claimed: boolean;
          terminal: boolean;
          migrationId?: Id<"auth_owner_migrations">;
          leaseGeneration?: number;
          fromOwnerGeneration?: string;
          toOwnerGeneration?: string;
          planRevision?: number;
        }
      >;
      finishOwnershipMigrationPass: FunctionReference<
        "mutation",
        "internal",
        OwnerArgs & {
          leaseId: string;
          leaseGeneration: number;
          outcome: "pending" | "failed" | "complete";
          retryAfterMs?: number;
          error?: string;
          now: number;
        },
        null
      >;
      cleanupOwnershipMigration: FunctionReference<
        "mutation",
        "internal",
        {
          migrationId: Id<"auth_owner_migrations">;
          terminalAt: number;
        },
        null
      >;
      recordMigratedSourceIdentityDeletionInternal: FunctionReference<
        "mutation",
        "internal",
        {
          migrationId: Id<"auth_owner_migrations">;
          fromOwnerId: string;
          toOwnerId: string;
          authUserId: string;
          requestedOperationId: string;
          operationId: string;
          generation: string;
          now: number;
        },
        boolean
      >;
      listPendingMigratedSourceIdentityDeletionsInternal: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        Array<Id<"auth_owner_migrations">>
      >;
      sweepMigratedSourceIdentityDeletionsInternal: FunctionReference<
        "action",
        "internal",
        { limit?: number },
        { attempted: number }
      >;
      quiesceManagedDispatchesForOwnershipMigration: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { ready: boolean; pending: string[] }
      >;
      quiesceComposioProvisioningForOwnershipMigration: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { ready: boolean; pending: string[]; retryAt: number | null }
      >;
      quiesceRemoteTurnsForOwnershipMigration: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { ready: boolean; processed: number; retryAfterAt: number | null }
      >;
      migrateConversationsBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      migrateAgentsBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      migrateUserPreferencesBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      migrateDeviceIdentitySuccessorsBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      commitCloudConversationTransferBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs & {
          conversationId: string;
          transferOperationId: string;
          transferPlanFingerprint: string;
          transferStage: string;
        },
        { complete: boolean; progressed: boolean }
      >;
      commitOwnerNamespaceTransfer: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs & {
          fromOwnerHash: string;
          toOwnerHash: string;
          transferOperationId: string;
          transferPlanFingerprint: string;
          transferStage: string;
        },
        { hasMore: boolean; progressed: boolean }
      >;
      getOwnerNamespaceTransferBlocker: FunctionReference<
        "query",
        "internal",
        OwnerArgs,
        string | null
      >;
      getReadyExternalTransferAck: FunctionReference<
        "query",
        "internal",
        OwnerArgs,
        null | {
          ready: boolean;
          transferOperationId: string;
          transferPlanFingerprint: string;
          leaseId: string;
          leaseGeneration: number;
        }
      >;
      migrateCloudProductCoreBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean; progressed: boolean }
      >;
      migrateAccountExternalMediaContentBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      migrateXTokensBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      migrateUsageAccountingBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      migrateDeviceExtensionsForAccountLink: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      assertExternalMediaMigrationLeaseInternal: FunctionReference<
        "mutation",
        "internal",
        OwnerArgs & {
          migrationId: string;
          leaseId: string;
          leaseGeneration: number;
          fromOwnerGeneration: string;
          toOwnerGeneration: string;
          planRevision: number;
          now: number;
        },
        null
      >;
      discardAnonymousTransientHandshakesBatch: FunctionReference<
        "mutation",
        "internal",
        LeaseArgs,
        { hasMore: boolean }
      >;
      auditOwnershipMigrationResidue: FunctionReference<
        "query",
        "internal",
        OwnerArgs,
        { kind: "clear" | "retry" | "blocked"; table?: string }
      >;
      quiesceAndMinimizeOwnerAuthMigrationsInternal: FunctionReference<
        "mutation",
        "internal",
        PurgeArgs,
        { ready: boolean; pending: string[] }
      >;
      drainOwnerAuthMigrationSourceDependenciesInternal: FunctionReference<
        "mutation",
        "internal",
        PurgeArgs,
        {
          sourceOwnerIds: string[];
          sourceDependencies: Array<{
            ownerId: string;
            authUserId?: string;
            authUserEmail?: string;
          }>;
          waitingSourceOwnerIds: string[];
          hasMore: boolean;
        }
      >;
      remainingOwnerAuthMigrationResidueInternal: FunctionReference<
        "mutation",
        "internal",
        PurgeArgs,
        string[]
      >;
    };
  }
).auth_migration;

const authInternal = (
  internal as unknown as {
    auth: {
      hasOwnerMigrationSourceFenceInternal: FunctionReference<
        "query",
        "internal",
        { ownerId: string },
        boolean
      >;
    };
  }
).auth;

const migrationPublic = (
  api as unknown as {
    auth_migration: {
      getMyOwnershipMigrationStatus: FunctionReference<
        "query",
        "public",
        Record<string, never>,
        null | { status: MigrationStatus; updatedAt: number; error?: string }
      >;
      retryMyLatestFailedOwnershipMigration: FunctionReference<
        "mutation",
        "public",
        Record<string, never>,
        { scheduled: boolean }
      >;
    };
  }
).auth_migration;

const fromOwnerId = "https://issuer.test|anonymous-owner";
const toOwnerId = "https://issuer.test|connected-owner";
const ownerArgs = { fromOwnerId, toOwnerId };

const getMigration = async (t: ReturnType<typeof createTest>) =>
  await t.run(async (ctx) =>
    ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q.eq("fromOwnerId", fromOwnerId).eq("toOwnerId", toOwnerId),
      )
      .unique(),
  );

const seedCorePurgeLease = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  mode: "reset" | "delete",
): Promise<PurgeArgs> => {
  const args: PurgeArgs = {
    ownerId,
    operationId: `${mode}-operation`,
    generation: `${mode}-generation`,
    leaseId: `${mode}-lease`,
    mode,
  };
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId,
      generation: args.generation,
      state: mode === "delete" ? "deleting" : "resetting",
      operationId: args.operationId,
      createdAt: 2_000,
      updatedAt: 2_000,
    });
    await ctx.db.insert("cloud_owner_purge_jobs", {
      ownerId,
      operationId: args.operationId,
      generation: args.generation,
      mode,
      stage: "core",
      attempts: 1,
      nextRetryAt: 2_000,
      leaseId: args.leaseId,
      leaseExpiresAt: 100_000,
      createdAt: 2_000,
      updatedAt: 2_000,
    });
  });
  return args;
};

describe("crash-safe ownership migration lifecycle", () => {
  it("hands a completed linked source principal to one permanent source-only delete", async () => {
    const t = createTest();
    const authUserId = "linked-anonymous-user";
    const linkedOwners = {
      fromOwnerId: `https://stella.test|${authUserId}`,
      toOwnerId: "https://stella.test|connected-destination-user",
      sourceAuthUserId: authUserId,
      sourceAuthUserEmail: "linked-anonymous-user@anon.stella.local",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, linkedOwners);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      fromOwnerId: linkedOwners.fromOwnerId,
      toOwnerId: linkedOwners.toOwnerId,
      leaseId: "linked-completion-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.get(claim.migrationId!);
      if (!row) throw new Error("missing linked migration");
      await ctx.db.patch(row._id, { cloudProductStage: "complete" });
      await seedReadyMigrationBackupSweep(ctx, { migrationId: row._id });
    });
    await t.mutation(migrationInternal.finishOwnershipMigrationPass, {
      fromOwnerId: linkedOwners.fromOwnerId,
      toOwnerId: linkedOwners.toOwnerId,
      leaseId: "linked-completion-lease",
      leaseGeneration: claim.leaseGeneration!,
      outcome: "complete",
      now: 2_000,
    });

    const completed = await t.run(
      async (ctx) => await ctx.db.get(claim.migrationId!),
    );
    expect(completed).toMatchObject({
      status: "complete",
      sourceAuthUserId: authUserId,
      sourceAuthDeletionState: "pending",
    });
    expect(completed?.sourceAuthDeletionOperationId).toMatch(
      /^migrated-source-auth-delete:[a-f0-9]{64}$/u,
    );

    const sourceFence = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: linkedOwners.fromOwnerId,
        operationId: completed!.sourceAuthDeletionOperationId!,
        mode: "delete",
        authUserId,
        authUserEmail: linkedOwners.sourceAuthUserEmail,
        now: 3_000,
      },
    );
    expect(
      await t.mutation(
        migrationInternal.recordMigratedSourceIdentityDeletionInternal,
        {
          migrationId: claim.migrationId!,
          fromOwnerId: linkedOwners.fromOwnerId,
          toOwnerId: linkedOwners.toOwnerId,
          authUserId,
          requestedOperationId: completed!.sourceAuthDeletionOperationId!,
          operationId: sourceFence.operationId,
          generation: sourceFence.generation,
          now: 3_001,
        },
      ),
    ).toBe(true);

    const snapshot = await t.run(async (ctx) => ({
      sourceLifecycle: await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) =>
          q.eq("ownerId", linkedOwners.fromOwnerId),
        )
        .unique(),
      destinationLifecycle: await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", linkedOwners.toOwnerId))
        .unique(),
      sourceFinalizer: await ctx.db
        .query("auth_account_deletion_finalizers")
        .withIndex("by_ownerId", (q) =>
          q.eq("ownerId", linkedOwners.fromOwnerId),
        )
        .unique(),
      migration: await ctx.db.get(claim.migrationId!),
    }));
    expect(snapshot.sourceLifecycle).toMatchObject({
      state: "deleting",
      operationId: sourceFence.operationId,
      generation: sourceFence.generation,
    });
    expect(snapshot.sourceFinalizer).toMatchObject({
      authUserId,
      operationId: sourceFence.operationId,
      generation: sourceFence.generation,
    });
    expect(snapshot.migration).toMatchObject({
      sourceAuthDeletionState: "started",
    });
    expect(snapshot.destinationLifecycle).toBeNull();
    await expect(
      t.mutation(
        internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
        {
          ownerId: linkedOwners.fromOwnerId,
          ownerGeneration: sourceFence.generation,
        },
      ),
    ).rejects.toThrow(/being deleted/u);
  });

  it("recovers a completed migration whose source-delete action was never scheduled", async () => {
    const t = createTest();
    const migrationId = await t.run(
      async (ctx) =>
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: "https://stella.test|crash-source-user",
          toOwnerId: "https://stella.test|crash-destination-user",
          sourceAuthUserId: "crash-source-user",
          sourceAuthDeletionOperationId:
            "migrated-source-auth-delete:" + "a".repeat(64),
          sourceAuthDeletionState: "pending",
          status: "complete",
          fromOwnerGeneration: "legacy",
          toOwnerGeneration: "legacy",
          planRevision: 1,
          cloudProductStage: "complete",
          completedAt: 1_000,
          createdAt: 500,
          updatedAt: 1_000,
        }),
    );
    expect(
      await t.query(
        migrationInternal.listPendingMigratedSourceIdentityDeletionsInternal,
        { limit: 10 },
      ),
    ).toContain(migrationId);
    expect(
      await t.action(
        migrationInternal.sweepMigratedSourceIdentityDeletionsInternal,
        { limit: 10 },
      ),
    ).toEqual({ attempted: 1 });
    const scheduled = await t.run(
      async (ctx) =>
        await ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.some(
        (job) =>
          JSON.stringify(job.args).includes(String(migrationId)) &&
          String(job.name).includes("finalizeMigratedSourceIdentityInternal"),
      ),
    ).toBe(true);
  });

  it("blocks destination writes only while an incoming migration is unresolved", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "https://stella.test|incoming-source-user",
      toOwnerId: "https://stella.test|incoming-destination-user",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    await expect(
      t.mutation(authCreateTriggerRef, {
        model: "session",
        doc: {
          _id: "destination-session-before-complete",
          userId: "incoming-destination-user",
          ownerGeneration: "legacy",
        },
      }),
    ).rejects.toThrow(/OWNERSHIP_MIGRATED/u);

    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "incoming-destination-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      const migration = await ctx.db.get(claim.migrationId!);
      if (!migration) throw new Error("missing incoming migration");
      await ctx.db.patch(migration._id, { cloudProductStage: "complete" });
    });
    await t.mutation(migrationInternal.finishOwnershipMigrationPass, {
      ...args,
      leaseId: "incoming-destination-lease",
      leaseGeneration: claim.leaseGeneration!,
      outcome: "complete",
      now: 2_000,
    });
    await expect(
      t.mutation(authCreateTriggerRef, {
        model: "session",
        doc: {
          _id: "destination-session-after-complete",
          userId: "incoming-destination-user",
          ownerGeneration: "legacy",
        },
      }),
    ).resolves.toBeNull();
  });

  it("does not gate account linking on dormant retired backup rows", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "retired-backup-migration-source",
      toOwnerId: "retired-backup-migration-destination",
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("backup_key_escrows", {
        ownerId: args.fromOwnerId,
        ownerGeneration: "legacy",
        encryptedKey: "dormant-encrypted-key",
        keyFingerprint: "dormant-key-fingerprint",
        isCurrent: true,
        keyVersion: 1,
        sourceDeviceId: "dormant-device",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("backup_objects", {
        ownerId: args.fromOwnerId,
        ownerGeneration: "legacy",
        keyFingerprint: "dormant-key-fingerprint",
        objectId: "dormant-object",
        r2Key: "backups/dormant-object",
        uploadExpiresAt: 100_000,
        algorithm: "AES-256-GCM",
        plaintextSha256: "a".repeat(64),
        plaintextSize: 1,
        ivBase64Url: "dormant-iv",
        authTagBase64Url: "dormant-tag",
        sourceDeviceId: "dormant-device",
        createdAt: 1,
      });
      await ctx.db.insert("backup_manifests", {
        ownerId: args.fromOwnerId,
        ownerGeneration: "legacy",
        keyFingerprint: "dormant-key-fingerprint",
        snapshotId: "dormant-snapshot",
        snapshotHash: "b".repeat(64),
        sourceDeviceId: "dormant-device",
        manifestR2Key: "backups/dormant-manifest",
        uploadExpiresAt: 100_000,
        manifestAlgorithm: "AES-256-GCM",
        manifestPlaintextSha256: "c".repeat(64),
        manifestPlaintextSize: 1,
        manifestIvBase64Url: "dormant-manifest-iv",
        manifestAuthTagBase64Url: "dormant-manifest-tag",
        entryCount: 1,
        objectCount: 1,
        isLatest: true,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("backup_upload_reservations", {
        ownerId: args.fromOwnerId,
        ownerGeneration: "legacy",
        keyFingerprint: "dormant-key-fingerprint",
        kind: "object",
        snapshotId: "dormant-snapshot",
        objectId: "dormant-object",
        r2Key: "backups/dormant-object",
        uploadExpiresAt: 100_000,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({ kind: "clear" });

    await t.run(async (ctx) => {
      await ctx.db.insert("conversations", {
        ownerId: args.fromOwnerId,
        isDefault: false,
        eventCount: 0,
        createdAt: 2,
        updatedAt: 2,
      });
    });
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({ kind: "retry", table: "conversations" });
  });

  it("removes only the exact obsolete backup sweep when account linking completes", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "obsolete-sweep-migration-source",
      toOwnerId: "obsolete-sweep-migration-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "obsolete-sweep-completion-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      const migration = await ctx.db.get(claim.migrationId!);
      if (!migration) throw new Error("missing obsolete-sweep migration");
      await ctx.db.patch(migration._id, { cloudProductStage: "complete" });
      const sweep = {
        protocolVersion: 1,
        revision: 1,
        kind: "migration" as const,
        sourceOwnerId: args.fromOwnerId,
        sourceOwnerGeneration: claim.fromOwnerGeneration!,
        destinationOwnerId: args.toOwnerId,
        destinationOwnerGeneration: claim.toOwnerGeneration!,
        planRevision: 1,
        notBefore: 1_000_000,
        legacyRowFenceComplete: true,
        legacyRowFenceTargetIndex: 0,
        goal: "preserve_refs" as const,
        phase: "cleanup" as const,
        targetIndex: 0,
        verifyDirty: false,
        listedCount: 0,
        deletedCount: 0,
        protectedCount: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      await ctx.db.insert("backup_legacy_r2_sweeps", {
        ...sweep,
        scopeKey: `migration:${encodeURIComponent(args.fromOwnerId)}:${String(migration._id)}`,
        operationId: String(migration._id),
      });
      await ctx.db.insert("backup_legacy_r2_sweeps", {
        ...sweep,
        scopeKey: "migration:unrelated-source:unrelated-operation",
        operationId: "unrelated-operation",
        sourceOwnerId: "unrelated-source",
        destinationOwnerId: "unrelated-destination",
      });
    });

    await t.mutation(migrationInternal.finishOwnershipMigrationPass, {
      ...args,
      leaseId: "obsolete-sweep-completion-lease",
      leaseGeneration: claim.leaseGeneration!,
      outcome: "complete",
      now: 2_000,
    });

    const sweeps = await t.run(async (ctx) =>
      ctx.db.query("backup_legacy_r2_sweeps").collect(),
    );
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]?.operationId).toBe("unrelated-operation");
  });

  it("waits for managed dispatches on both owners and deletes only quiescent transient receipts", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "managed-dispatch-source",
      toOwnerId: "managed-dispatch-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "managed-dispatch-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_managed_dispatch_leases", {
        ownerId: args.fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        executionId: "source-execution",
        attemptId: "source-attempt",
        leaseId: "source-provider-lease",
        state: "active",
        providerDeadlineAt: 2_000,
        leaseExpiresAt: 2_500,
        quiescentAfterAt: 3_000,
        cleanupAt: 4_000,
        billing: {
          kind: "parallel_search_fast",
          requestFingerprint: "reserved-source-" + "a".repeat(48),
          chargeMicroCents: 100_000,
          providerState: "reserved",
          billingState: "pending",
        },
        createdAt: 500,
        updatedAt: 500,
      });
      await ctx.db.insert("billing_managed_dispatch_leases", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        executionId: "destination-execution",
        attemptId: "destination-attempt",
        leaseId: "destination-provider-lease",
        state: "terminal",
        providerDeadlineAt: 900,
        leaseExpiresAt: 950,
        quiescentAfterAt: 1_000,
        outcome: "succeeded",
        terminalAt: 900,
        cleanupAt: 2_000,
        createdAt: 500,
        updatedAt: 900,
      });
      await ctx.db.insert("billing_managed_dispatch_leases", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        executionId: "destination-ambiguous-execution",
        attemptId: "destination-ambiguous-attempt",
        leaseId: "destination-ambiguous-provider-lease",
        state: "terminal",
        providerDeadlineAt: 2_000,
        leaseExpiresAt: 2_500,
        quiescentAfterAt: 3_500,
        outcome: "outcome_unknown",
        terminalAt: 2_000,
        cleanupAt: 4_000,
        billing: {
          kind: "parallel_search_fast",
          requestFingerprint: "ambiguous-destination-" + "b".repeat(40),
          chargeMicroCents: 100_000,
          providerState: "may_have_dispatched",
          billingState: "pending",
        },
        createdAt: 500,
        updatedAt: 2_000,
      });
      await ctx.db.insert("billing_managed_execution_leases", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        executionId: "destination-live-tool-loop",
        leaseId: "destination-execution-lease",
        state: "active",
        leaseExpiresAt: 3_500,
        hardExpiresAt: 3_800,
        quiescentAfterAt: 4_000,
        cleanupAt: 5_000,
        createdAt: 500,
        updatedAt: 2_000,
      });
    });
    expect(
      await t.mutation(
        migrationInternal.quiesceManagedDispatchesForOwnershipMigration,
        {
          ...args,
          leaseId: "managed-dispatch-migration",
          leaseGeneration: claim.leaseGeneration!,
          leaseNow: 2_000,
        },
      ),
    ).toEqual({
      ready: false,
      pending: [
        "billing_managed_dispatch_leases",
        "billing_managed_execution_leases",
      ],
    });
    let rows = await t.run(
      async (ctx) =>
        await ctx.db.query("billing_managed_dispatch_leases").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerId: args.fromOwnerId, state: "active" }),
        expect.objectContaining({
          ownerId: args.toOwnerId,
          state: "terminal",
          outcome: "outcome_unknown",
        }),
      ]),
    );

    expect(
      await t.mutation(
        migrationInternal.quiesceManagedDispatchesForOwnershipMigration,
        {
          ...args,
          leaseId: "managed-dispatch-migration",
          leaseGeneration: claim.leaseGeneration!,
          leaseNow: 3_001,
        },
      ),
    ).toEqual({
      ready: false,
      pending: [
        "billing_managed_dispatch_leases",
        "billing_managed_execution_leases",
      ],
    });
    expect(
      await t.mutation(
        migrationInternal.quiesceManagedDispatchesForOwnershipMigration,
        {
          ...args,
          leaseId: "managed-dispatch-migration",
          leaseGeneration: claim.leaseGeneration!,
          leaseNow: 3_501,
        },
      ),
    ).toEqual({
      ready: false,
      pending: ["billing_managed_execution_leases"],
    });
    const destinationUsage = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
          .unique(),
    );
    expect(destinationUsage).toMatchObject({
      totalUsageMicroCents: 100_000,
      totalRequestCount: 1,
    });
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db
            .query("billing_usage_windows")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
            .unique(),
      ),
    ).toBeNull();
    expect(
      await t.mutation(
        migrationInternal.quiesceManagedDispatchesForOwnershipMigration,
        {
          ...args,
          leaseId: "managed-dispatch-migration",
          leaseGeneration: claim.leaseGeneration!,
          leaseNow: 4_001,
        },
      ),
    ).toEqual({ ready: true, pending: [] });
    rows = await t.run(
      async (ctx) =>
        await ctx.db.query("billing_managed_dispatch_leases").collect(),
    );
    expect(rows).toEqual([]);
  });

  it("drops pre-dispatch Composio reservations but blocks both-principal migration on an unknown create outcome", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "composio-provision-source",
      toOwnerId: "composio-provision-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "composio-provision-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("composio_session_provisioning_attempts", {
        ownerId: args.fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        integrationId: "github",
        toolkit: "github",
        composioUserId: "source_composio_user",
        attemptId: "source-reserved-attempt",
        leaseId: "source-reserved-lease",
        state: "reserved",
        providerDeadlineAt: 2_000,
        quiescentAfterAt: 2_500,
        cleanupAttempts: 0,
        createdAt: 500,
        updatedAt: 500,
      });
      await ctx.db.insert("composio_session_provisioning_attempts", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        integrationId: "slack",
        toolkit: "slack",
        composioUserId: "destination_composio_user",
        attemptId: "destination-unknown-attempt",
        leaseId: "destination-unknown-lease",
        state: "outcome_unknown",
        providerDeadlineAt: 1_500,
        quiescentAfterAt: 2_000,
        cleanupAttempts: 0,
        lastError: "Composio create response was not captured.",
        createdAt: 600,
        updatedAt: 2_000,
      });
    });
    const lease = {
      ...args,
      leaseId: "composio-provision-migration",
      leaseGeneration: claim.leaseGeneration!,
      leaseNow: 2_001,
    };

    expect(
      await t.mutation(
        migrationInternal.quiesceComposioProvisioningForOwnershipMigration,
        lease,
      ),
    ).toEqual({
      ready: false,
      pending: ["composio_session_outcome_unknown:slack"],
      retryAt: null,
    });
    const afterFirstPass = await t.run(async (ctx) =>
      ctx.db.query("composio_session_provisioning_attempts").collect(),
    );
    expect(afterFirstPass).toHaveLength(1);
    expect(afterFirstPass[0]).toMatchObject({
      ownerId: args.toOwnerId,
      state: "outcome_unknown",
      attemptId: "destination-unknown-attempt",
    });
    expect(
      await t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).toEqual({
      kind: "blocked",
      table: "composio_session_provisioning_attempts",
    });

    await t.run(async (ctx) => {
      await ctx.db.delete(afterFirstPass[0]!._id);
    });
    expect(
      await t.mutation(
        migrationInternal.quiesceComposioProvisioningForOwnershipMigration,
        { ...lease, leaseNow: 2_002 },
      ),
    ).toEqual({ ready: true, pending: [], retryAt: null });
  });

  it("persists the exact source-derived Composio principal before moving a legacy integration", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "legacy-composio-principal-source",
      toOwnerId: "legacy-composio-principal-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "legacy-composio-principal-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        ownerId: args.fromOwnerId,
        provider: "gmail",
        mode: "composio",
        externalId: "session_legacy_principal",
        config: {},
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await expect(
      t.mutation(migrateUserIntegrations, {
        ...args,
        leaseId: "legacy-composio-principal-migration",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 1_001,
      }),
    ).resolves.toEqual({ hasMore: false });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("provider", "gmail"),
        )
        .unique(),
    );
    expect(row).toMatchObject({
      ownerId: args.toOwnerId,
      externalId: "session_legacy_principal",
      config: {
        composioUserId: await composioUserIdForOwner(args.fromOwnerId),
      },
    });
  });

  it("fails closed without moving or deleting either Composio locator when both owners have the same provider", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "composio-collision-source",
      toOwnerId: "composio-collision-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "composio-collision-migration",
      now: 2_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("user_integrations", {
        ownerId: args.fromOwnerId,
        provider: "gmail",
        mode: "composio",
        externalId: "session_collision_source",
        config: {},
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("user_integrations", {
        ownerId: args.toOwnerId,
        provider: "gmail",
        mode: "composio",
        externalId: "session_collision_destination",
        config: {
          composioUserId: await composioUserIdForOwner(args.toOwnerId),
        },
        createdAt: 2,
        updatedAt: 2,
      });
    });

    await expect(
      t.mutation(migrateUserIntegrations, {
        ...args,
        leaseId: "composio-collision-migration",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 2_001,
      }),
    ).rejects.toThrow(/both identities contain a gmail integration/iu);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("user_integrations").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerId: args.fromOwnerId,
          provider: "gmail",
          externalId: "session_collision_source",
          config: {},
        }),
        expect.objectContaining({
          ownerId: args.toOwnerId,
          provider: "gmail",
          externalId: "session_collision_destination",
          config: {
            composioUserId: await composioUserIdForOwner(args.toOwnerId),
          },
        }),
      ]),
    );
  });

  it("cancels and strictly audits media provider authority on both migration owners", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "media-dispatch-source",
      toOwnerId: "media-dispatch-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "media-dispatch-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const [ownerId, suffix, generation] of [
        [args.fromOwnerId, "source", claim.fromOwnerGeneration!],
        [args.toOwnerId, "destination", claim.toOwnerGeneration!],
      ] as const) {
        const cleanupJobId = await ctx.scheduler.runAfter(
          60_000,
          internal.media_jobs.expireMediaProviderDispatchInternal,
          {
            dispatchId: `media-dispatch-${suffix}`,
            attemptId: `media-attempt-${suffix}`,
            quiescentAfterAt: 3_000,
          },
        );
        await ctx.db.insert("media_provider_dispatch_leases", {
          ownerId,
          ownerGeneration: generation,
          dispatchId: `media-dispatch-${suffix}`,
          attemptId: `media-attempt-${suffix}`,
          kind: "fal_submit",
          state: "active",
          providerDeadlineAt: 2_000,
          leaseExpiresAt: 2_500,
          quiescentAfterAt: 3_000,
          cleanupJobId,
          createdAt: 500,
          updatedAt: 500,
        });
      }
    });

    for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
      await expect(
        t.mutation(
          internal.media_jobs
            .cancelOwnerMediaProviderDispatchesForMigrationInternal,
          { migrationId: claim.migrationId!, ownerId, now: 2_000 },
        ),
      ).resolves.toMatchObject({ ready: false, canceled: 1 });
    }
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({
      kind: "blocked",
      table: "media_provider_dispatch_leases",
    });

    for (const ownerId of [args.fromOwnerId, args.toOwnerId]) {
      await expect(
        t.mutation(
          internal.media_jobs
            .cancelOwnerMediaProviderDispatchesForMigrationInternal,
          { migrationId: claim.migrationId!, ownerId, now: 3_001 },
        ),
      ).resolves.toMatchObject({ ready: true, reaped: 1 });
    }
    const cancellationId = await t.run(async (ctx) =>
      ctx.db.insert("media_provider_cancellations", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        jobId: "media-cancel-destination",
        endpointId: "fal-endpoint",
        providerRequestId: "fal-request",
        attempts: 0,
        nextAttemptAt: 3_100,
        createdAt: 3_000,
        updatedAt: 3_000,
      }),
    );
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({
      kind: "retry",
      table: "media_provider_cancellations",
    });
    await t.run(async (ctx) => ctx.db.delete(cancellationId));
    const dispositionJobId = await t.run(async (ctx) =>
      ctx.db.insert("media_jobs", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        jobId: "media-billing-disposition-destination",
        capability: "text_to_image",
        profile: "best",
        provider: "fal",
        endpointId: "fal-ai/flux/dev",
        request: { prompt: "billing disposition" },
        billingDispositionState: "unknown",
        status: "failed",
        upstreamStatus: "FAILED",
        queuePosition: null,
        createdAt: 3_000,
        updatedAt: 3_000,
      }),
    );
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({
      kind: "blocked",
      table: "media_billing_disposition_debt",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(dispositionJobId, {
        billingDispositionState: "billed",
        billingDispositionUpdatedAt: 3_001,
        updatedAt: 3_001,
      }),
    );
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({ kind: "clear" });
  });

  it("rewrites retained mobile pairings and push bindings to the destination generation", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "mobile-generation-source",
      toOwnerId: "mobile-generation-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "mobile-generation-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const [ownerId, generation, lastSeenAt] of [
        [args.fromOwnerId, claim.fromOwnerGeneration!, 20],
        [args.toOwnerId, "stale-destination-generation", 10],
      ] as const) {
        await ctx.db.insert("paired_mobile_devices", {
          ownerId,
          ownerGeneration: generation,
          desktopDeviceId: "desktop-mobile-generation",
          mobileDeviceId: "mobile-generation",
          pairSecretHash: "same-pair-secret",
          approvedAt: 1,
          lastSeenAt,
        });
        await ctx.db.insert("mobile_push_tokens", {
          ownerId,
          ownerGeneration: generation,
          mobileDeviceId: "mobile-generation",
          expoPushToken: "same-expo-token",
          platform: "ios",
          updatedAt: lastSeenAt,
        });
      }
      await ctx.db.insert("mobile_pairing_sessions", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        desktopDeviceId: "desktop-mobile-generation",
        pairingCode: "654321",
        createdAt: 1,
        expiresAt: 10_000,
      });
      await ctx.db.insert("mobile_connect_intents", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        desktopDeviceId: "desktop-mobile-generation",
        mobileDeviceId: "mobile-generation",
        createdAt: 1,
        expiresAt: 10_000,
      });
      await ctx.db.insert("mobile_bridge_sessions", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        desktopDeviceId: "desktop-mobile-generation",
        mobileDeviceId: "mobile-generation",
        sessionId: "migration-destination-bridge-session",
        sessionSecretHash: "bridge-session-secret",
        desktopChallenge: "bridge-challenge",
        desktopPublicKey: "desktop-public-key",
        mobilePublicKey: "mobile-public-key",
        createdAt: 1,
        expiresAt: 10_000,
        lastSeenAt: 1,
      });
      for (const [ownerId, updatedAt, prefix] of [
        [args.fromOwnerId, 20, "source"],
        [args.toOwnerId, 10, "destination"],
      ] as const) {
        await ctx.db.insert("mobile_bridge_registrations", {
          ownerId,
          deviceId: "desktop-mobile-generation",
          baseUrls: Array.from(
            { length: 8 },
            (_, index) => `https://${prefix}-${index}.example.test`,
          ),
          desktopPublicKey: "shared-desktop-public-key",
          updatedAt,
        });
        await ctx.db.insert("mobile_bridge_registration_limits", {
          ownerId,
          windowStartedAt: updatedAt,
          count: ownerId === args.fromOwnerId ? 2 : 3,
        });
      }
    });

    const leaseArgs = {
      ...args,
      leaseId: "mobile-generation-migration",
      leaseGeneration: claim.leaseGeneration!,
      leaseNow: 1_001,
    };
    for (let pass = 0; pass < 8; pass += 1) {
      await t.mutation(
        migrationInternal.discardAnonymousTransientHandshakesBatch,
        leaseArgs,
      );
    }
    await expect(
      t.run(async (ctx) => ({
        pairing: await ctx.db.query("mobile_pairing_sessions").collect(),
        connects: await ctx.db.query("mobile_connect_intents").collect(),
        bridges: await ctx.db.query("mobile_bridge_sessions").collect(),
      })),
    ).resolves.toEqual({ pairing: [], connects: [], bridges: [] });
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await t.mutation(
        migrationInternal.migrateDeviceExtensionsForAccountLink,
        leaseArgs,
      );
      if (!result.hasMore) break;
    }
    const rows = await t.run(async (ctx) => ({
      pairings: await ctx.db.query("paired_mobile_devices").collect(),
      pushes: await ctx.db.query("mobile_push_tokens").collect(),
      registrations: await ctx.db
        .query("mobile_bridge_registrations")
        .collect(),
      registrationLimits: await ctx.db
        .query("mobile_bridge_registration_limits")
        .collect(),
    }));
    expect(rows.pairings).toHaveLength(1);
    expect(rows.pairings[0]).toMatchObject({
      ownerId: args.toOwnerId,
      ownerGeneration: claim.toOwnerGeneration,
      lastSeenAt: 20,
    });
    expect(rows.pushes).toHaveLength(1);
    expect(rows.pushes[0]).toMatchObject({
      ownerId: args.toOwnerId,
      ownerGeneration: claim.toOwnerGeneration,
      updatedAt: 20,
    });
    expect(rows.registrations).toHaveLength(1);
    expect(rows.registrations[0]).toMatchObject({
      ownerId: args.toOwnerId,
      desktopPublicKey: "shared-desktop-public-key",
      updatedAt: 20,
    });
    expect(rows.registrations[0]?.baseUrls).toHaveLength(8);
    expect(
      rows.registrations[0]?.baseUrls.every((url) =>
        url.includes("destination-"),
      ),
    ).toBe(true);
    expect(rows.registrationLimits).toEqual([
      expect.objectContaining({
        ownerId: args.toOwnerId,
        windowStartedAt: 20,
        count: 5,
      }),
    ]);
    await expect(
      t.mutation(internal.mobile_bridge.upsertRegistration, {
        ownerId: args.fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        deviceId: "desktop-mobile-generation",
        baseUrls: ["https://stale-source.example.test"],
        updatedAt: 30,
      }),
    ).rejects.toThrow(/linked|migration/i);
  });

  it("fails closed when mobile bridge public keys conflict during account linking", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "mobile-key-conflict-source",
      toOwnerId: "mobile-key-conflict-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "mobile-key-conflict",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("mobile_bridge_registrations", {
        ownerId: args.fromOwnerId,
        deviceId: "desktop-key-conflict",
        baseUrls: ["https://source.example.test"],
        desktopPublicKey: "source-public-key",
        updatedAt: 20,
      });
      await ctx.db.insert("mobile_bridge_registrations", {
        ownerId: args.toOwnerId,
        deviceId: "desktop-key-conflict",
        baseUrls: ["https://destination.example.test"],
        desktopPublicKey: "destination-public-key",
        updatedAt: 10,
      });
    });
    await expect(
      t.mutation(migrationInternal.migrateDeviceExtensionsForAccountLink, {
        ...args,
        leaseId: "mobile-key-conflict",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 1_001,
      }),
    ).rejects.toThrow(/different bridge keys/i);
  });

  it("rewrites a retained X credential to the destination generation", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "x-token-generation-source",
      toOwnerId: "x-token-generation-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "x-token-generation-migration",
      now: 1_000,
    });
    const rows = await t.run(async (ctx) => ({
      tokenId: await ctx.db.insert("x_oauth_tokens", {
        ownerId: args.fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        xUserId: "x-user-generation",
        username: "generation_user",
        encryptedTokenSet: "encrypted-token-set",
        tokenKeyVersion: 1,
        scopes: ["tweet.read"],
        tokenType: "bearer",
        createdAt: 1,
        updatedAt: 1,
      }),
      destinationStateId: await ctx.db.insert("x_oauth_states", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        stateHash: "destination-pre-migration-state",
        codeVerifier: "destination-pre-migration-verifier",
        expiresAt: 10_000,
        createdAt: 1,
      }),
    }));

    await expect(
      t.mutation(migrationInternal.discardAnonymousTransientHandshakesBatch, {
        ...args,
        leaseId: "x-token-generation-migration",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 1_001,
      }),
    ).resolves.toEqual({ hasMore: true });
    expect(
      await t.run(async (ctx) => ctx.db.get(rows.destinationStateId)),
    ).toBeNull();

    await expect(
      t.mutation(migrationInternal.migrateXTokensBatch, {
        ...args,
        leaseId: "x-token-generation-migration",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 1_001,
      }),
    ).resolves.toEqual({ hasMore: true });
    await expect(
      t.run(async (ctx) => ctx.db.get(rows.tokenId)),
    ).resolves.toMatchObject({
      ownerId: args.toOwnerId,
      ownerGeneration: claim.toOwnerGeneration,
    });
  });

  it("blocks migration residue on renderer voice authority for either owner", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "voice-authority-source",
      toOwnerId: "voice-authority-destination",
    };
    const insertSession = async (
      ownerId: string,
      stellaSessionId: string,
      authority: boolean,
    ) =>
      await t.run(
        async (ctx) =>
          await ctx.db.insert("billing_voice_sessions", {
            ownerId,
            ownerGeneration: "legacy",
            stellaSessionId,
            provider: "openai",
            model: "gpt-realtime",
            voice: "alloy",
            status: "active",
            ...(authority
              ? {
                  authorityLeaseId: `${stellaSessionId}-lease`,
                  authorityEpoch: 1,
                  authorityState: "active" as const,
                  authorityExpiresAt: 10_000,
                }
              : {}),
            leaseStartedAt: 1,
            leaseExpiresAt: 10_000,
            heartbeatCount: 0,
            responseCount: 0,
            estimatedCostMicroCents: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            realtimeAudioSeconds: 0,
            sttAudioSeconds: 0,
            createdAt: 1,
            updatedAt: 1,
          }),
      );

    const destinationSession = await insertSession(
      args.toOwnerId,
      "destination-modern-authority",
      true,
    );
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({
      kind: "blocked",
      table: "voice_realtime_authority",
    });
    await t.run(async (ctx) => await ctx.db.delete(destinationSession));

    await insertSession(args.fromOwnerId, "source-legacy-authority", false);
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({
      kind: "blocked",
      table: "voice_realtime_authority",
    });
  });

  it("cancels and retires source remote turns before conversation ownership can move", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const t = createTest();
    const args = {
      fromOwnerId: "remote-turn-migration-source",
      toOwnerId: "remote-turn-migration-destination",
    };
    const seeded = await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("conversations", {
        ownerId: args.fromOwnerId,
        isDefault: false,
        eventCount: 2,
        createdAt: 100,
        updatedAt: 100,
      });
      const boundEventId = await ctx.db.insert("events", {
        conversationId,
        timestamp: 100,
        type: "remote_turn_request",
        requestId: "migration-bound-request",
        targetDeviceId: "migration-desktop",
        ownerId: args.fromOwnerId,
        ownerGeneration: "legacy",
        ownerBindingState: "bound",
        requestState: "claimed",
        claimedByDeviceId: "migration-desktop",
        claimedAt: 200,
        activeAttemptId: "migration-attempt",
        activeAttemptSource: "desktop",
        activeAttemptDeviceId: "migration-desktop",
        activeAttemptState: "active",
        activeAttemptPhase: "running",
        attemptStartedAt: 200,
        attemptLastHeartbeatAt: 200,
        attemptLeaseExpiresAt: 2_500,
        attemptHardExpiresAt: 2_700,
        attemptQuiescentAfterAt: 3_000,
        providerDispatchCount: 1,
        lastProviderDispatchId: "migration-provider-dispatch",
        lastProviderDispatchOutcome: "in_flight",
        lastProviderDispatchAt: 500,
        payload: { provider: "stella_app", deliveryMeta: {} },
      });
      const legacyEventId = await ctx.db.insert("events", {
        conversationId,
        timestamp: 101,
        type: "remote_turn_request",
        requestId: "migration-legacy-request",
        targetDeviceId: "migration-desktop",
        ownerBindingState: "legacy_unbound",
        requestState: "pending",
        payload: { provider: "stella_app", deliveryMeta: {} },
      });
      for (const requestId of [
        "migration-bound-request",
        "migration-legacy-request",
      ]) {
        await ctx.db.insert("connector_turn_payloads", {
          ownerId: args.fromOwnerId,
          conversationId,
          requestId,
          targetDeviceId: "migration-desktop",
          payload: { conversationId: String(conversationId), text: "secret" },
          createdAt: 100,
          expiresAt: 100_000,
        });
      }
      return { conversationId, boundEventId, legacyEventId };
    });
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "remote-turn-migration-lease",
      now: 1_000,
    });
    const lease = {
      ...args,
      leaseId: "remote-turn-migration-lease",
      leaseGeneration: claim.leaseGeneration!,
    };

    await expect(
      t.mutation(migrationInternal.migrateConversationsBatch, {
        ...lease,
        leaseNow: 1_001,
      }),
    ).rejects.toThrow(/Remote execution must be cancelled/u);

    expect(
      await t.mutation(
        migrationInternal.quiesceRemoteTurnsForOwnershipMigration,
        { ...lease, leaseNow: 1_500 },
      ),
    ).toEqual({ ready: false, processed: 1, retryAfterAt: 3_000 });
    const cancelled = await t.run(
      async (ctx) => await ctx.db.get(seeded.boundEventId),
    );
    expect(cancelled).toMatchObject({
      requestState: "cancelled",
      requestTerminalReason: "ownership_migrated",
      activeAttemptState: "cancel_requested",
      attemptLeaseExpiresAt: 2_500,
      attemptHardExpiresAt: 2_700,
      attemptQuiescentAfterAt: 3_000,
    });
    await expect(
      t.mutation(
        internal.channels.connector_delivery
          .acknowledgeRemoteTurnUsageDispositionInternal,
        {
          requestId: "migration-bound-request",
          conversationId: seeded.conversationId,
          ownerId: args.fromOwnerId,
          ownerGeneration: "legacy",
          attemptId: "migration-attempt",
          source: "desktop",
          deviceId: "migration-desktop",
          now: 1_501,
        },
      ),
    ).resolves.toBe(false);

    expect(
      await t.mutation(
        migrationInternal.quiesceRemoteTurnsForOwnershipMigration,
        { ...lease, leaseNow: 2_999 },
      ),
    ).toEqual({ ready: false, processed: 1, retryAfterAt: 3_000 });
    expect(
      await t.mutation(
        migrationInternal.quiesceRemoteTurnsForOwnershipMigration,
        { ...lease, leaseNow: 3_000 },
      ),
    ).toEqual({ ready: false, processed: 1, retryAfterAt: null });
    expect(
      await t.mutation(
        migrationInternal.quiesceRemoteTurnsForOwnershipMigration,
        { ...lease, leaseNow: 3_001 },
      ),
    ).toEqual({ ready: true, processed: 1, retryAfterAt: null });

    const retired = await t.run(async (ctx) => ({
      bound: await ctx.db.get(seeded.boundEventId),
      legacy: await ctx.db.get(seeded.legacyEventId),
      conversation: await ctx.db.get(seeded.conversationId),
      payloads: await ctx.db.query("connector_turn_payloads").collect(),
      migration: await ctx.db.get(claim.migrationId!),
    }));
    expect(retired.bound).toBeNull();
    expect(retired.legacy).toBeNull();
    expect(retired.payloads).toEqual([]);
    expect(retired.conversation?.eventCount).toBe(0);
    expect(retired.migration).toMatchObject({
      remoteTurnConversationScanComplete: true,
      remoteTurnRetiredCount: 2,
      remoteTurnProviderDispatchCount: 1,
    });
    expect(retired.migration?.remoteTurnOutcomeDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    await expect(
      t.mutation(migrationInternal.migrateConversationsBatch, {
        ...lease,
        leaseNow: 3_002,
      }),
    ).resolves.toEqual({ hasMore: false });
    expect(
      await t.run(async (ctx) => ctx.db.get(seeded.conversationId)),
    ).toMatchObject({ ownerId: args.toOwnerId, eventCount: 0 });
  });

  it("publishes a source fence and minimizes completed operational metadata", async () => {
    const t = createTest();

    await expect(
      t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs),
    ).resolves.toBeNull();

    const pending = await getMigration(t);
    expect(pending).toMatchObject({
      ...ownerArgs,
      status: "pending",
      fromOwnerGeneration: "legacy",
      toOwnerGeneration: "legacy",
      planRevision: 1,
    });

    const firstClaim = await t.mutation(
      migrationInternal.claimOwnershipMigration,
      { ...ownerArgs, leaseId: "lease-one", now: 1_000 },
    );
    expect(firstClaim).toMatchObject({
      claimed: true,
      terminal: false,
      leaseGeneration: 1,
      fromOwnerGeneration: "legacy",
      toOwnerGeneration: "legacy",
      planRevision: 1,
    });

    const competingClaim = await t.mutation(
      migrationInternal.claimOwnershipMigration,
      { ...ownerArgs, leaseId: "lease-two", now: 1_001 },
    );
    expect(competingClaim).toEqual({ claimed: false, terminal: false });

    const running = await getMigration(t);
    expect(running).toMatchObject({
      ...ownerArgs,
      status: "running",
      leaseId: "lease-one",
    });
    expect(running?.leaseExpiresAt).toBeGreaterThan(1_000);
    expect(running?.watchdogId).toBeDefined();

    await t.run(async (ctx) => {
      await ctx.db.patch(running!._id, { cloudProductStage: "complete" });
      await seedReadyMigrationBackupSweep(ctx, {
        migrationId: running!._id,
      });
    });

    await t.mutation(migrationInternal.finishOwnershipMigrationPass, {
      ...ownerArgs,
      leaseId: "lease-one",
      leaseGeneration: 1,
      outcome: "complete",
      now: 2_000,
    });

    const complete = await getMigration(t);
    expect(complete).toMatchObject({
      ...ownerArgs,
      status: "complete",
      completedAt: 2_000,
    });
    expect(complete?.leaseId).toBeUndefined();
    expect(complete?.watchdogId).toBeUndefined();

    await t.mutation(migrationInternal.cleanupOwnershipMigration, {
      migrationId: complete!._id,
      terminalAt: 3_000,
    });
    expect(await getMigration(t)).toMatchObject({ status: "complete" });

    await t.mutation(migrationInternal.cleanupOwnershipMigration, {
      migrationId: complete!._id,
      terminalAt: 2_000,
    });
    expect(await getMigration(t)).toBeNull();
    const tombstones = await t.run(async (ctx) =>
      ctx.db.query("auth_owner_migration_tombstones").collect(),
    );
    expect(tombstones).toHaveLength(1);
    expect(JSON.stringify(tombstones[0])).not.toContain(fromOwnerId);
    expect(JSON.stringify(tombstones[0])).not.toContain(toOwnerId);

    const postCompleteClaim = await t.mutation(
      migrationInternal.claimOwnershipMigration,
      { ...ownerArgs, leaseId: "lease-three", now: 4_000 },
    );
    expect(postCompleteClaim).toMatchObject({
      claimed: false,
      terminal: true,
    });
  });

  it("keeps completed metadata only through the live link replay window", async () => {
    const t = createTest();
    const completedAt = Date.now() - 60 * 60_000;
    const migrationId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("auth_owner_migrations", {
        ...ownerArgs,
        status: "complete",
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: "legacy",
        planRevision: 1,
        cloudProductStage: "complete",
        completedAt,
        createdAt: completedAt,
        updatedAt: completedAt,
      });
      await ctx.db.insert("auth_link_requests", {
        email: "live-replay@example.test",
        requestId: "live-replay-link",
        status: "completed",
        fromOwnerId,
        fromOwnerGeneration: "legacy",
        toOwnerId,
        toOwnerGeneration: "legacy",
        ownershipMigrationId: id,
        tokenEnc: "enc:live-replay-bearer",
        expiresAt: Date.now() + 60_000,
        createdAt: completedAt,
      });
      return id;
    });

    await t.mutation(migrationInternal.cleanupOwnershipMigration, {
      migrationId,
      terminalAt: completedAt,
    });
    expect(await getMigration(t)).not.toBeNull();
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", "live-replay-link"))
        .unique();
      await ctx.db.patch(link!._id, { expiresAt: Date.now() - 1 });
    });
    await t.mutation(migrationInternal.cleanupOwnershipMigration, {
      migrationId,
      terminalAt: completedAt,
    });
    expect(await getMigration(t)).toBeNull();
    await expect(
      t.run(async (ctx) => ctx.db.query("auth_link_requests").collect()),
    ).resolves.toEqual([]);
    await expect(
      t.query(authInternal.hasOwnerMigrationSourceFenceInternal, {
        ownerId: fromOwnerId,
      }),
    ).resolves.toBe(true);
  });

  it("quiesces a destination deletion and retains only an opaque source fence", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "migration-before-delete",
      now: 1_000,
    });
    const migration = await getMigration(t);
    expect(migration?.watchdogId).toBeDefined();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_link_requests", {
        email: "deleted-owner@example.test",
        requestId: "delete-link-request",
        status: "completed",
        fromOwnerId,
        fromOwnerGeneration: "legacy",
        toOwnerId,
        toOwnerGeneration: "legacy",
        ownershipMigrationId: migration!._id,
        tokenEnc: "enc:sensitive-bearer",
        expiresAt: 100_000,
        createdAt: 1,
      });
      await ctx.db.insert("auth_browser_handoffs", {
        requestId: "delete-browser-handoff",
        provider: "google",
        fromOwnerId: toOwnerId,
        fromOwnerGeneration: "legacy",
        returnOrigin: "stella://auth",
        returnTo: "/",
        status: "pending",
        expiresAt: 100_000,
        createdAt: 1,
      });
      await ctx.db.insert("device_identity_successors", {
        ownerId: toOwnerId,
        previousDeviceId: "deleted-device-old",
        deviceId: "deleted-device-new",
        rotatedAt: 1,
      });
      await ctx.db.insert("conversations", {
        ownerId: fromOwnerId,
        title: "source residue during destination deletion",
        isDefault: false,
        eventCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const purge = await seedCorePurgeLease(t, toOwnerId, "delete");

    await expect(
      t.mutation(
        migrationInternal.quiesceAndMinimizeOwnerAuthMigrationsInternal,
        { ...purge, leaseId: "stale-delete-lease" },
      ),
    ).rejects.toThrow("started before the account data was reset");
    expect(await getMigration(t)).not.toBeNull();

    await expect(
      t.mutation(
        migrationInternal.drainOwnerAuthMigrationSourceDependenciesInternal,
        purge,
      ),
    ).resolves.toEqual({
      sourceOwnerIds: [fromOwnerId],
      sourceDependencies: [{ ownerId: fromOwnerId }],
      waitingSourceOwnerIds: [],
      hasMore: false,
    });
    await expect(
      t.mutation(
        migrationInternal.quiesceAndMinimizeOwnerAuthMigrationsInternal,
        purge,
      ),
    ).resolves.toEqual({
      ready: false,
      pending: ["auth_owner_migration_source_dependencies"],
    });
    expect(await getMigration(t)).not.toBeNull();

    const [importedCredentialId, importedSettingsId] = await t.run(
      async (ctx) =>
        await Promise.all([
          ctx.db.insert("cloud_llm_credentials", {
            ownerId: toOwnerId,
            provider: "anthropic",
            payloadEncrypted: "encrypted-imported-source-credential",
            label: "Imported source credential",
            importedFromOwnerId: fromOwnerId,
            createdAt: 1,
            updatedAt: 1,
          }),
          ctx.db.insert("cloud_engine_settings", {
            ownerId: toOwnerId,
            chatEngine: "anthropic",
            importedFromOwnerId: fromOwnerId,
            updatedAt: 1,
          }),
        ]),
    );
    const sourcePurge = await seedCorePurgeLease(t, fromOwnerId, "delete");
    await expect(
      t.mutation(
        migrationInternal.quiesceAndMinimizeOwnerAuthMigrationsInternal,
        sourcePurge,
      ),
    ).resolves.toEqual({
      ready: false,
      pending: ["cloud_engine_import_source_reference"],
    });
    const sourceDigest = await ownershipMigrationSourceDigest(fromOwnerId);
    const importedRows = await t.run(
      async (ctx) =>
        await Promise.all([
          ctx.db.get(importedCredentialId),
          ctx.db.get(importedSettingsId),
        ]),
    );
    for (const row of importedRows) {
      expect(row?.ownerId).toBe(toOwnerId);
      expect(row?.importedFromOwnerId).toBe(sourceDigest);
      expect(row?.importedFromOwnerId).not.toBe(fromOwnerId);
    }
    await expect(
      t.mutation(
        migrationInternal.quiesceAndMinimizeOwnerAuthMigrationsInternal,
        sourcePurge,
      ),
    ).resolves.toEqual({ ready: true, pending: [] });
    const held = await getMigration(t);
    expect(held).toMatchObject({
      status: "failed",
      sourcePurgeDependency: {
        sourceOperationId: sourcePurge.operationId,
        sourceGeneration: sourcePurge.generation,
        destinationOperationId: purge.operationId,
        destinationGeneration: purge.generation,
      },
    });
    await expect(
      t.mutation(
        migrationInternal.drainOwnerAuthMigrationSourceDependenciesInternal,
        purge,
      ),
    ).resolves.toEqual({
      sourceOwnerIds: [],
      sourceDependencies: [],
      waitingSourceOwnerIds: [fromOwnerId],
      hasMore: false,
    });
    await expect(
      t.mutation(
        migrationInternal.quiesceAndMinimizeOwnerAuthMigrationsInternal,
        purge,
      ),
    ).resolves.toEqual({
      ready: false,
      pending: ["auth_owner_migration_source_dependencies"],
    });
    expect(await getMigration(t)).not.toBeNull();
    await t.run(async (ctx) => {
      const conversation = await ctx.db
        .query("conversations")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .unique();
      const sourceLink = await ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) =>
          q.eq("requestId", "delete-link-request"),
        )
        .unique();
      await ctx.db.delete(conversation!._id);
      await ctx.db.delete(sourceLink!._id);
    });
    await expect(
      t.mutation(
        migrationInternal.remainingOwnerAuthMigrationResidueInternal,
        sourcePurge,
      ),
    ).resolves.toEqual([]);
    await t.run(async (ctx) => {
      const sourceJob = await ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .unique();
      await ctx.db.patch(sourceJob!._id, {
        stage: "cloud",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: 4_000,
      });
    });
    await expect(
      t.mutation(
        migrationInternal.drainOwnerAuthMigrationSourceDependenciesInternal,
        purge,
      ),
    ).resolves.toEqual({
      sourceOwnerIds: [],
      sourceDependencies: [],
      waitingSourceOwnerIds: [fromOwnerId],
      hasMore: false,
    });
    expect(await getMigration(t)).not.toBeNull();
    await t.run(async (ctx) => {
      const sourceJob = await ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .unique();
      await ctx.db.patch(sourceJob!._id, {
        stage: "complete",
        updatedAt: 5_000,
      });
      await ctx.db.insert("auth_link_requests", {
        email: "destination-residue@example.test",
        requestId: "destination-delete-link-request",
        status: "completed",
        toOwnerId,
        toOwnerGeneration: "legacy",
        tokenEnc: "enc:destination-sensitive-bearer",
        expiresAt: 100_000,
        createdAt: 2,
      });
    });
    await expect(
      t.mutation(
        migrationInternal.drainOwnerAuthMigrationSourceDependenciesInternal,
        purge,
      ),
    ).resolves.toEqual({
      sourceOwnerIds: [],
      sourceDependencies: [],
      waitingSourceOwnerIds: [],
      hasMore: false,
    });
    expect(await getMigration(t)).toBeNull();
    await expect(
      t.mutation(
        migrationInternal.quiesceAndMinimizeOwnerAuthMigrationsInternal,
        purge,
      ),
    ).resolves.toEqual({ ready: true, pending: [] });

    const minimized = await t.run(async (ctx) => ({
      migrations: await ctx.db.query("auth_owner_migrations").collect(),
      tombstones: await ctx.db
        .query("auth_owner_migration_tombstones")
        .collect(),
    }));
    expect(minimized.migrations).toEqual([]);
    expect(minimized.tombstones).toHaveLength(1);
    const tombstone = minimized.tombstones[0]!;
    expect(tombstone.sourceOwnerDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(tombstone)).not.toContain(fromOwnerId);
    expect(JSON.stringify(tombstone)).not.toContain(toOwnerId);
    expect(
      Object.keys(tombstone)
        .filter((key) => !key.startsWith("_"))
        .sort(),
    ).toEqual(["sourceOwnerDigest"]);
    await expect(
      t.query(authInternal.hasOwnerMigrationSourceFenceInternal, {
        ownerId: fromOwnerId,
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(migrationInternal.claimOwnershipMigration, {
        ...ownerArgs,
        leaseId: "stale-scheduled-replay",
        now: 3_000,
      }),
    ).resolves.toEqual({ claimed: false, terminal: true });
    await expect(
      t.mutation(migrationInternal.migrateAgentsBatch, {
        ...ownerArgs,
        leaseId: "migration-before-delete",
        leaseGeneration: 1,
        leaseNow: 3_000,
      }),
    ).rejects.toThrow("no longer owns the lease");
    await expect(
      t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs),
    ).rejects.toThrow("already linked");

    await expect(
      t.mutation(
        migrationInternal.remainingOwnerAuthMigrationResidueInternal,
        purge,
      ),
    ).resolves.toEqual([
      "auth_link_requests",
      "auth_browser_handoffs",
      "device_identity_successors",
    ]);
    await t.run(async (ctx) => {
      const links = await ctx.db.query("auth_link_requests").collect();
      const handoffs = await ctx.db.query("auth_browser_handoffs").collect();
      const successors = await ctx.db
        .query("device_identity_successors")
        .collect();
      await Promise.all(
        [...links, ...handoffs, ...successors].map((row) =>
          ctx.db.delete(row._id),
        ),
      );
    });
    await expect(
      t.mutation(
        migrationInternal.remainingOwnerAuthMigrationResidueInternal,
        purge,
      ),
    ).resolves.toEqual([]);
  });

  it("serializes reset-before-migration and migration-before-reset orderings", async () => {
    const resetFirst = createTest();
    await seedCorePurgeLease(resetFirst, fromOwnerId, "reset");
    await expect(
      resetFirst.mutation(
        migrationInternal.prepareOwnershipMigration,
        ownerArgs,
      ),
    ).rejects.toThrow("being reset");
    await expect(getMigration(resetFirst)).resolves.toBeNull();
    await resetFirst.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .unique();
      const job = await ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .unique();
      await ctx.db.patch(lifecycle!._id, {
        state: "open",
        generation: "reset-first-reopened",
        operationId: undefined,
        updatedAt: 3_000,
      });
      await ctx.db.patch(job!._id, {
        stage: "complete",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: 3_000,
      });
    });
    await expect(
      resetFirst.mutation(migrationInternal.claimOwnershipMigration, {
        ...ownerArgs,
        leaseId: "pre-marker-delayed-schedule",
        now: 4_000,
      }),
    ).resolves.toEqual({ claimed: false, terminal: true });
    await expect(getMigration(resetFirst)).resolves.toBeNull();

    const migrationFirst = createTest();
    await migrationFirst.mutation(
      migrationInternal.prepareOwnershipMigration,
      ownerArgs,
    );
    const purge = await seedCorePurgeLease(
      migrationFirst,
      fromOwnerId,
      "reset",
    );
    await expect(
      migrationFirst.mutation(
        migrationInternal.quiesceAndMinimizeOwnerAuthMigrationsInternal,
        purge,
      ),
    ).resolves.toEqual({ ready: true, pending: [] });
    await migrationFirst.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .unique();
      const job = await ctx.db
        .query("cloud_owner_purge_jobs")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .unique();
      await ctx.db.patch(lifecycle!._id, {
        state: "open",
        generation: "post-reset-generation",
        operationId: undefined,
        updatedAt: 4_000,
      });
      await ctx.db.patch(job!._id, {
        stage: "complete",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: 4_000,
      });
    });
    await expect(
      migrationFirst.mutation(migrationInternal.claimOwnershipMigration, {
        ...ownerArgs,
        leaseId: "delayed-initial-schedule",
        now: 5_000,
      }),
    ).resolves.toEqual({ claimed: false, terminal: true });
    await expect(getMigration(migrationFirst)).resolves.toBeNull();
    await expect(
      migrationFirst.query(authInternal.hasOwnerMigrationSourceFenceInternal, {
        ownerId: fromOwnerId,
      }),
    ).resolves.toBe(true);
  });

  it("exposes failure to the destination owner and retries only when authenticated", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        ...ownerArgs,
        status: "failed",
        lastError: "worker unavailable",
        createdAt: 10,
        updatedAt: 20,
      });
    });

    await expect(
      t.mutation(migrationPublic.retryMyLatestFailedOwnershipMigration, {}),
    ).rejects.toThrow("Authentication required");

    const owner = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "connected-owner",
      tokenIdentifier: toOwnerId,
    });
    await expect(
      owner.query(migrationPublic.getMyOwnershipMigrationStatus, {}),
    ).resolves.toEqual({
      status: "failed",
      updatedAt: 20,
      error:
        "Account linking stopped because source and destination data could not be merged safely.",
    });

    await expect(
      owner.mutation(migrationPublic.retryMyLatestFailedOwnershipMigration, {}),
    ).resolves.toEqual({ scheduled: true });

    const pending = await getMigration(t);
    expect(pending).toMatchObject({ status: "pending" });
    expect(pending?.lastError).toBeUndefined();
    expect(pending?.completedAt).toBeUndefined();
  });

  it("does not hide an older active fence behind completed migrations", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        ...ownerArgs,
        status: "pending",
        createdAt: 1,
        updatedAt: 2,
      });
      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert("auth_owner_migrations", {
          fromOwnerId: `${fromOwnerId}-${index}`,
          toOwnerId,
          status: "complete",
          completedAt: 100 + index,
          createdAt: 100 + index,
          updatedAt: 100 + index,
        });
      }
    });
    const owner = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "connected-owner",
      tokenIdentifier: toOwnerId,
    });

    await expect(
      owner.query(migrationPublic.getMyOwnershipMigrationStatus, {}),
    ).resolves.toEqual({ status: "pending", updatedAt: 2 });
  });

  it("fails closed instead of creating duplicate owner-scoped agent ids", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "agent-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const ownerId of [fromOwnerId, toOwnerId]) {
        await ctx.db.insert("agents", {
          ownerId,
          id: "researcher",
          name: "Researcher",
          description: "test",
          systemPrompt: "test",
          agentTypes: ["researcher"],
          version: 1,
          source: "test",
          updatedAt: 1,
        });
      }
    });

    await expect(
      t.mutation(migrationInternal.migrateAgentsBatch, {
        ...ownerArgs,
        leaseId: "agent-lease",
        leaseGeneration: 1,
        leaseNow: 1_001,
      }),
    ).rejects.toThrow('Both identities contain an agent with id "researcher".');

    const owners = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("agents")
          .withIndex("by_ownerId_and_id", (q) =>
            q.eq("ownerId", fromOwnerId).eq("id", "researcher"),
          )
          .take(1)
      ).map((row) => row.ownerId),
    );
    expect(owners).toEqual([fromOwnerId]);
  });

  it("rejects a second destination for the same permanent source fence", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);

    await expect(
      t.mutation(migrationInternal.prepareOwnershipMigration, {
        fromOwnerId,
        toOwnerId: "https://issuer.test|other-connected-owner",
      }),
    ).rejects.toThrow("already bound to a different account");
  });

  it("never lets the watchdog auto-reclaim a hard-blocked migration", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "failed-lease",
      now: 1_000,
    });
    await t.mutation(migrationInternal.finishOwnershipMigrationPass, {
      ...ownerArgs,
      leaseId: "failed-lease",
      leaseGeneration: 1,
      outcome: "failed",
      error: "conflict",
      now: 2_000,
    });

    const watchdog = await t.mutation(
      migrationInternal.claimOwnershipMigration,
      {
        ...ownerArgs,
        leaseId: "watchdog-lease",
        expectedLeaseGeneration: 1,
        now: 1_000_000,
      } as OwnerArgs & {
        leaseId: string;
        expectedLeaseGeneration: number;
        now: number;
      },
    );
    expect(watchdog).toMatchObject({ claimed: false, terminal: true });
    expect(await getMigration(t)).toMatchObject({ status: "failed" });
  });

  it("rebinds durable managed request identities and fails closed on body collisions", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "managed-binding-source",
      toOwnerId: "managed-binding-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "managed-binding-migration",
      now: 1_000,
    });
    const route = "parallel_search_fast";
    const replayRequestId = "managed-replay-request";
    const movedRequestId = "managed-moved-request";
    const bodyFingerprint = "a".repeat(64);
    const sourceReplayFingerprint =
      await createManagedDispatchRequestFingerprint(
        route,
        `${args.fromOwnerId}\u0000${claim.fromOwnerGeneration}\u0000${replayRequestId}`,
      );
    const destinationReplayFingerprint =
      await createManagedDispatchRequestFingerprint(
        route,
        `${args.toOwnerId}\u0000${claim.toOwnerGeneration}\u0000${replayRequestId}`,
      );
    const sourceMovedFingerprint =
      await createManagedDispatchRequestFingerprint(
        route,
        `${args.fromOwnerId}\u0000${claim.fromOwnerGeneration}\u0000${movedRequestId}`,
      );
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_managed_request_bindings", {
        ownerId: args.fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        route,
        requestId: replayRequestId,
        bodyFingerprint,
        requestFingerprint: sourceReplayFingerprint,
        createdAt: 2,
        updatedAt: 4,
      });
      await ctx.db.insert("billing_managed_request_bindings", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        route,
        requestId: replayRequestId,
        bodyFingerprint,
        requestFingerprint: destinationReplayFingerprint,
        createdAt: 1,
        updatedAt: 3,
      });
      await ctx.db.insert("billing_managed_request_bindings", {
        ownerId: args.fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        route,
        requestId: movedRequestId,
        bodyFingerprint,
        requestFingerprint: sourceMovedFingerprint,
        createdAt: 5,
        updatedAt: 6,
      });
    });

    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({
      kind: "retry",
      table: "billing_managed_request_bindings",
    });
    const leaseArgs = {
      ...args,
      leaseId: "managed-binding-migration",
      leaseGeneration: claim.leaseGeneration!,
      leaseNow: 1_001,
    };
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, leaseArgs),
    ).resolves.toEqual({ hasMore: true });
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, leaseArgs),
    ).resolves.toEqual({ hasMore: true });

    const destinationRows = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_managed_request_bindings")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", args.toOwnerId),
          )
          .collect(),
    );
    expect(destinationRows).toHaveLength(2);
    expect(destinationRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerGeneration: claim.toOwnerGeneration,
          requestId: replayRequestId,
          requestFingerprint: destinationReplayFingerprint,
          createdAt: 1,
          updatedAt: 4,
        }),
        expect.objectContaining({
          ownerGeneration: claim.toOwnerGeneration,
          requestId: movedRequestId,
          requestFingerprint: await createManagedDispatchRequestFingerprint(
            route,
            `${args.toOwnerId}\u0000${claim.toOwnerGeneration}\u0000${movedRequestId}`,
          ),
          createdAt: 5,
          updatedAt: 6,
        }),
      ]),
    );
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({ kind: "clear" });

    const conflictRequestId = "managed-conflict-request";
    const sourceConflictFingerprint =
      await createManagedDispatchRequestFingerprint(
        route,
        `${args.fromOwnerId}\u0000${claim.fromOwnerGeneration}\u0000${conflictRequestId}`,
      );
    const destinationConflictFingerprint =
      await createManagedDispatchRequestFingerprint(
        route,
        `${args.toOwnerId}\u0000${claim.toOwnerGeneration}\u0000${conflictRequestId}`,
      );
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_managed_request_bindings", {
        ownerId: args.fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        route,
        requestId: conflictRequestId,
        bodyFingerprint: "b".repeat(64),
        requestFingerprint: sourceConflictFingerprint,
        createdAt: 7,
        updatedAt: 7,
      });
      await ctx.db.insert("billing_managed_request_bindings", {
        ownerId: args.toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        route,
        requestId: conflictRequestId,
        bodyFingerprint: "c".repeat(64),
        requestFingerprint: destinationConflictFingerprint,
        createdAt: 8,
        updatedAt: 8,
      });
    });
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, leaseArgs),
    ).rejects.toThrow("managed-provider request binding collision");
    await expect(
      t.run(
        async (ctx) =>
          await ctx.db
            .query("billing_managed_request_bindings")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.fromOwnerId),
            )
            .collect(),
      ),
    ).resolves.toHaveLength(1);
  });

  it("requires both billing reservation aggregates to reach zero before usage transfer", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "reserved-usage-source",
      toOwnerId: "reserved-usage-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "reserved-usage-migration",
      now: 1_000,
    });
    const [sourceUsageId, destinationUsageId] = await t.run(async (ctx) => {
      const usage = (
        ownerId: string,
        activeReservedMicroCents: number,
        totalRequestCount: number,
      ) => ({
        ownerId,
        activeReservedMicroCents,
        rollingUsageMicroCents: 10,
        rollingWindowStartedAt: 1,
        weeklyUsageMicroCents: 20,
        weeklyWindowStartedAt: 1,
        monthlyUsageMicroCents: 30,
        monthlyWindowStartedAt: 1,
        totalUsageMicroCents: 40,
        totalRequestCount,
        createdAt: 1,
        updatedAt: 1,
      });
      return await Promise.all([
        ctx.db.insert("billing_usage_windows", usage(args.fromOwnerId, 100, 2)),
        ctx.db.insert("billing_usage_windows", usage(args.toOwnerId, 0, 3)),
      ]);
    });
    const leaseArgs = {
      ...args,
      leaseId: "reserved-usage-migration",
      leaseGeneration: claim.leaseGeneration!,
      leaseNow: 1_001,
    };
    await expect(
      t.mutation(
        migrationInternal.quiesceManagedDispatchesForOwnershipMigration,
        leaseArgs,
      ),
    ).resolves.toEqual({
      ready: false,
      pending: ["billing_usage_reservations"],
    });
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({
      kind: "retry",
      table: "billing_usage_reservations",
    });
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, leaseArgs),
    ).rejects.toThrow("anonymous identity still has reserved");
    await t.run(async (ctx) => {
      await ctx.db.patch(sourceUsageId, { activeReservedMicroCents: 0 });
      await ctx.db.patch(destinationUsageId, {
        activeReservedMicroCents: 100,
      });
    });
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({
      kind: "retry",
      table: "billing_usage_reservations",
    });
    await expect(
      t.mutation(
        migrationInternal.quiesceManagedDispatchesForOwnershipMigration,
        leaseArgs,
      ),
    ).resolves.toEqual({
      ready: false,
      pending: ["billing_usage_reservations"],
    });
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, leaseArgs),
    ).rejects.toThrow("connected identity still has reserved");
    await t.run(
      async (ctx) =>
        await ctx.db.patch(destinationUsageId, {
          activeReservedMicroCents: 0,
        }),
    );
    await expect(
      t.mutation(
        migrationInternal.quiesceManagedDispatchesForOwnershipMigration,
        leaseArgs,
      ),
    ).resolves.toEqual({ ready: true, pending: [] });
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({ kind: "retry", table: "billing_usage_windows" });
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, leaseArgs),
    ).resolves.toEqual({ hasMore: true });
    const rows = await t.run(
      async (ctx) => await ctx.db.query("billing_usage_windows").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: args.toOwnerId,
      activeReservedMicroCents: 0,
      rollingUsageMicroCents: 20,
      weeklyUsageMicroCents: 40,
      monthlyUsageMicroCents: 60,
      totalUsageMicroCents: 80,
      totalRequestCount: 5,
    });
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({ kind: "clear" });
  });

  it("moves finalized TTS spend receipts and collapses exact destination replays", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "tts-usage-source",
      toOwnerId: "tts-usage-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "tts-usage-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      const receipt = {
        provider: "inworld" as const,
        model: "inworld-tts-1",
        voice: "Ashley",
        streaming: true,
        status: "interrupted" as const,
        requestChars: 80,
        synthesizedChars: 80,
        audioBytes: 0,
        textInputTokens: 20,
        audioOutputTokens: 0,
        costMicroCents: 1_000,
        durationMs: 500,
      };
      await ctx.db.insert("internal_tts_usage", {
        ownerId: args.fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        dispatchId: "tts-move-dispatch",
        attemptId: "tts-move-attempt",
        leaseId: "tts-move-lease",
        providerDispatchOutcome: "may_have_dispatched",
        ...receipt,
        createdAt: 1,
      });
      for (const [ownerId, ownerGeneration] of [
        [args.fromOwnerId, claim.fromOwnerGeneration!],
        [args.toOwnerId, claim.toOwnerGeneration!],
      ] as const) {
        await ctx.db.insert("internal_tts_usage", {
          ownerId,
          ownerGeneration,
          dispatchId: "tts-replay-dispatch",
          attemptId: "tts-replay-attempt",
          leaseId: "tts-replay-lease",
          providerDispatchOutcome: "settled",
          ...receipt,
          status: "completed",
          createdAt: 2,
        });
      }
    });

    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({ kind: "retry", table: "internal_tts_usage" });

    const leaseArgs = {
      ...args,
      leaseId: "tts-usage-migration",
      leaseGeneration: claim.leaseGeneration!,
      leaseNow: 1_001,
    };
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, leaseArgs),
    ).resolves.toEqual({ hasMore: true });
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, leaseArgs),
    ).resolves.toEqual({ hasMore: true });

    const rows = await t.run(
      async (ctx) => await ctx.db.query("internal_tts_usage").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerId: args.toOwnerId,
          ownerGeneration: claim.toOwnerGeneration,
          dispatchId: "tts-move-dispatch",
          providerDispatchOutcome: "may_have_dispatched",
        }),
        expect.objectContaining({
          ownerId: args.toOwnerId,
          ownerGeneration: claim.toOwnerGeneration,
          dispatchId: "tts-replay-dispatch",
          providerDispatchOutcome: "settled",
        }),
      ]),
    );
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, args),
    ).resolves.toEqual({ kind: "clear" });
  });

  it("fails closed on a conflicting TTS exact-attempt receipt", async () => {
    const t = createTest();
    const args = {
      fromOwnerId: "tts-conflict-source",
      toOwnerId: "tts-conflict-destination",
    };
    await t.mutation(migrationInternal.prepareOwnershipMigration, args);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...args,
      leaseId: "tts-conflict-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const [ownerId, ownerGeneration, requestedTextInputTokens] of [
        [args.fromOwnerId, claim.fromOwnerGeneration!, 20],
        [args.toOwnerId, claim.toOwnerGeneration!, 21],
      ] as const) {
        await ctx.db.insert("internal_tts_usage", {
          ownerId,
          ownerGeneration,
          dispatchId: "tts-conflict-dispatch",
          attemptId: "tts-conflict-attempt",
          leaseId: "tts-conflict-lease",
          providerDispatchOutcome: "settled",
          provider: "inworld",
          model: "inworld-tts-1",
          streaming: true,
          status: "completed",
          requestChars: 80,
          requestedTextInputTokens,
          requestedAudioOutputTokens: 0,
          synthesizedChars: 80,
          audioBytes: 1_024,
          textInputTokens: 20,
          audioOutputTokens: 0,
          costMicroCents: 1_000,
          durationMs: 500,
          createdAt: 1,
        });
      }
    });
    await expect(
      t.mutation(migrationInternal.migrateUsageAccountingBatch, {
        ...args,
        leaseId: "tts-conflict-migration",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 1_001,
      }),
    ).rejects.toThrow("TTS usage receipt collision");
    const owners = await t.run(async (ctx) =>
      (await ctx.db.query("internal_tts_usage").collect())
        .map((row) => row.ownerId)
        .sort(),
    );
    expect(owners).toEqual([args.fromOwnerId, args.toOwnerId].sort());
  });

  it("strictly inventories both principals' transient TTS sessions child-first", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "tts-session-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const [ownerId, ownerGeneration, suffix] of [
        [fromOwnerId, claim.fromOwnerGeneration!, "source"],
        [toOwnerId, claim.toOwnerGeneration!, "destination"],
      ] as const) {
        const ticket = `migration-tts-ticket-${suffix}`;
        await ctx.db.insert("tts_stream_tickets", {
          ticket,
          ownerId,
          ownerGeneration,
          providerDispatchId: `migration-tts-logical-${suffix}`,
          text: "Transient text",
          voice: "voice",
          model: "inworld-tts-1",
          hlsStatus: "pending",
          createdAt: 1,
          expiresAt: 10_000,
        });
        await ctx.db.insert("tts_hls_segments", {
          ticket,
          ownerId,
          ownerGeneration,
          seq: 0,
          audio: "audio",
          durationSec: 1,
          createdAt: 1,
          expiresAt: 10_000,
        });
      }
    });

    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, ownerArgs),
    ).resolves.toEqual({ kind: "retry", table: "tts_hls_segments" });
    for (const ownerId of [fromOwnerId, toOwnerId]) {
      await expect(
        t.mutation(
          internal.tts_hls.discardOwnerTtsSessionsForMigrationInternal,
          { ownerId },
        ),
      ).resolves.toEqual({ ready: false, deleted: 1, pending: "segments" });
    }
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, ownerArgs),
    ).resolves.toEqual({ kind: "retry", table: "tts_stream_tickets" });
    for (const ownerId of [fromOwnerId, toOwnerId]) {
      await expect(
        t.mutation(
          internal.tts_hls.discardOwnerTtsSessionsForMigrationInternal,
          { ownerId },
        ),
      ).resolves.toEqual({ ready: false, deleted: 1, pending: "tickets" });
      await expect(
        t.mutation(
          internal.tts_hls.discardOwnerTtsSessionsForMigrationInternal,
          { ownerId },
        ),
      ).resolves.toEqual({ ready: true, deleted: 0, pending: "" });
    }
    await expect(
      t.run(async (ctx) => ({
        tickets: await ctx.db.query("tts_stream_tickets").collect(),
        segments: await ctx.db.query("tts_hls_segments").collect(),
      })),
    ).resolves.toEqual({ tickets: [], segments: [] });
  });

  it("waits for ephemeral TTS provider authority instead of transferring it", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "tts-provider-migration",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const [ownerId, ownerGeneration, suffix, providerState] of [
        [
          fromOwnerId,
          claim.fromOwnerGeneration!,
          "source",
          "may_have_dispatched",
        ],
        [toOwnerId, claim.toOwnerGeneration!, "destination", "reserved"],
      ] as const) {
        const dispatchId = `migration-tts-dispatch-${suffix}`;
        const attemptId = `migration-tts-attempt-${suffix}`;
        const leaseId = `migration-tts-lease-${suffix}`;
        const usageId = await ctx.db.insert("internal_tts_usage", {
          ownerId,
          ownerGeneration,
          dispatchId,
          attemptId,
          leaseId,
          ...(providerState === "may_have_dispatched"
            ? { providerDispatchOutcome: providerState }
            : {}),
          provider: "inworld",
          model: "inworld-tts-1",
          streaming: true,
          status:
            providerState === "may_have_dispatched" ? "interrupted" : "failed",
          requestChars: 100,
          synthesizedChars: providerState === "may_have_dispatched" ? 100 : 0,
          audioBytes: 0,
          textInputTokens: providerState === "may_have_dispatched" ? 25 : 0,
          audioOutputTokens: 0,
          costMicroCents: providerState === "may_have_dispatched" ? 1_000 : 0,
          durationMs: 0,
          createdAt: 1_000,
        });
        const cleanupJobId = await ctx.scheduler.runAfter(
          60_000,
          internal.tts_dispatch.expireTtsProviderDispatchInternal,
          { dispatchId, attemptId, leaseId, quiescentAfterAt: 3_000 },
        );
        await ctx.db.insert("tts_provider_dispatch_leases", {
          ownerId,
          ownerGeneration,
          dispatchId,
          attemptId,
          leaseId,
          kind: "buffered",
          state: "active",
          providerState,
          usageId,
          leaseExpiresAt: 2_500,
          hardExpiresAt: 2_700,
          quiescentAfterAt: 3_000,
          cleanupJobId,
          lastHeartbeatAt: 1_000,
          createdAt: 1_000,
          updatedAt: 1_000,
        });
      }
    });

    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, ownerArgs),
    ).resolves.toEqual({
      kind: "retry",
      table: "tts_provider_dispatch_leases",
    });

    await expect(
      t.mutation(
        internal.tts_dispatch
          .quiesceOwnerTtsProviderDispatchesForMigrationInternal,
        { ownerId: fromOwnerId, now: 2_000 },
      ),
    ).resolves.toMatchObject({ ready: false, canceled: 1, reaped: 0 });
    // A reserved attempt has transactionally proven that provider I/O never
    // started, so it can finalize as not-dispatched without waiting.
    await expect(
      t.mutation(
        internal.tts_dispatch
          .quiesceOwnerTtsProviderDispatchesForMigrationInternal,
        { ownerId: toOwnerId, now: 2_000 },
      ),
    ).resolves.toMatchObject({ ready: true, canceled: 0, reaped: 1 });
    await expect(
      t.mutation(
        internal.tts_dispatch
          .quiesceOwnerTtsProviderDispatchesForMigrationInternal,
        { ownerId: fromOwnerId, now: 3_001 },
      ),
    ).resolves.toMatchObject({ ready: true, canceled: 0, reaped: 1 });
    await expect(
      t.mutation(
        internal.tts_dispatch
          .quiesceOwnerTtsProviderDispatchesForMigrationInternal,
        { ownerId: toOwnerId, now: 3_001 },
      ),
    ).resolves.toMatchObject({ ready: true, canceled: 0, reaped: 0 });

    const receiptsBeforeTransfer = await t.run(
      async (ctx) => await ctx.db.query("internal_tts_usage").collect(),
    );
    expect(receiptsBeforeTransfer).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerId: fromOwnerId,
          providerDispatchOutcome: "may_have_dispatched",
        }),
        expect.objectContaining({
          ownerId: toOwnerId,
          providerDispatchOutcome: "not_dispatched",
          costMicroCents: 0,
        }),
      ]),
    );
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, ownerArgs),
    ).resolves.toEqual({ kind: "retry", table: "internal_tts_usage" });
    await t.mutation(migrationInternal.migrateUsageAccountingBatch, {
      ...ownerArgs,
      leaseId: "tts-provider-migration",
      leaseGeneration: claim.leaseGeneration!,
      leaseNow: 3_002,
    });
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, ownerArgs),
    ).resolves.toEqual({ kind: "clear" });
    const sourceReceipts = await t.run(
      async (ctx) =>
        await ctx.db
          .query("internal_tts_usage")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", fromOwnerId),
          )
          .collect(),
    );
    expect(sourceReceipts).toEqual([]);
  });

  it("fences stale leases and an account-deletion race before table writes", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "active-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("user_preferences", {
        ownerId: fromOwnerId,
        key: "theme",
        value: "dark",
        updatedAt: 1,
      });
    });

    await expect(
      t.mutation(migrationInternal.migrateUserPreferencesBatch, {
        ...ownerArgs,
        leaseId: "active-lease",
        leaseGeneration: 2,
        leaseNow: 1_001,
      }),
    ).rejects.toThrow("no longer owns the lease");

    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: toOwnerId,
        generation: "delete-generation",
        state: "deleting",
        operationId: "delete-operation",
        createdAt: 1_002,
        updatedAt: 1_002,
      });
    });
    await expect(
      t.mutation(migrationInternal.migrateUserPreferencesBatch, {
        ...ownerArgs,
        leaseId: "active-lease",
        leaseGeneration: 1,
        leaseNow: 1_003,
      }),
    ).rejects.toThrow("being deleted");

    const sourcePreference = await t.run(async (ctx) =>
      ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", fromOwnerId).eq("key", "theme"),
        )
        .unique(),
    );
    expect(sourcePreference?.ownerId).toBe(fromOwnerId);
  });

  it("migrates device successor records with deterministic dedupe", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "device-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("device_identity_successors", {
        ownerId: fromOwnerId,
        previousDeviceId: "retired-device",
        deviceId: "current-device",
        rotatedAt: 1,
      });
      await ctx.db.insert("device_identity_successors", {
        ownerId: toOwnerId,
        previousDeviceId: "retired-device",
        deviceId: "current-device",
        rotatedAt: 2,
      });
    });

    await t.mutation(migrationInternal.migrateDeviceIdentitySuccessorsBatch, {
      ...ownerArgs,
      leaseId: "device-lease",
      leaseGeneration: 1,
      leaseNow: 1_001,
    });
    const sourceRows = await t.run(async (ctx) =>
      ctx.db
        .query("device_identity_successors")
        .withIndex("by_ownerId_and_previousDeviceId", (q) =>
          q.eq("ownerId", fromOwnerId),
        )
        .collect(),
    );
    expect(sourceRows).toEqual([]);
  });

  it("retains the exact external receipt across a crash after projection commit", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "copy-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_conversations", {
        conversationId: "cloud-conversation",
        ownerId: fromOwnerId,
        title: "Test",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const transferOperationId = "a".repeat(64);
    const transferPlanFingerprint = "b".repeat(64);
    await t.mutation(migrationInternal.commitCloudConversationTransferBatch, {
      ...ownerArgs,
      leaseId: "copy-lease",
      leaseGeneration: 1,
      leaseNow: 1_001,
      conversationId: "cloud-conversation",
      transferOperationId,
      transferPlanFingerprint,
      transferStage: "conversations",
    });

    await t.mutation(migrationInternal.finishOwnershipMigrationPass, {
      ...ownerArgs,
      leaseId: "copy-lease",
      leaseGeneration: 1,
      outcome: "pending",
      now: 1_002,
    });
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "recovery-lease",
      now: 1_003,
    });
    await expect(
      t.query(migrationInternal.getReadyExternalTransferAck, ownerArgs),
    ).resolves.toMatchObject({
      ready: true,
      transferOperationId,
      transferPlanFingerprint,
      leaseId: "copy-lease",
      leaseGeneration: 1,
    });
  });

  it("moves app-consumer storage independently and preserves collisions", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "storage-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q.eq("fromOwnerId", fromOwnerId).eq("toOwnerId", toOwnerId),
        )
        .unique();
      await ctx.db.patch(migration!._id, { cloudProductStage: "core" });
      await ctx.db.insert("cloud_app_storage", {
        appId: "third-party-app",
        ownerId: "https://issuer.test|app-author",
        userId: fromOwnerId,
        key: "draft",
        valueJson: '{"source":true}',
        sizeBytes: 15,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_app_storage", {
        appId: "third-party-app",
        ownerId: "https://issuer.test|app-author",
        userId: toOwnerId,
        key: "draft",
        valueJson: '{"destination":true}',
        sizeBytes: 20,
        updatedAt: 2,
      });
    });

    await t.mutation(migrationInternal.migrateCloudProductCoreBatch, {
      ...ownerArgs,
      leaseId: "storage-lease",
      leaseGeneration: 1,
      leaseNow: 1_001,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cloud_app_storage")
        .withIndex("by_appId_and_userId", (q) =>
          q.eq("appId", "third-party-app").eq("userId", toOwnerId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows.map((row) => row.valueJson).sort()).toEqual([
      '{"destination":true}',
      '{"source":true}',
    ]);
  });

  it("waits for source and destination Code-call leases, rewrites generation, and rejects receipt conflicts", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "integration-receipt-lease",
      now: 1_000,
    });
    const generations = await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q.eq("fromOwnerId", fromOwnerId).eq("toOwnerId", toOwnerId),
        )
        .unique();
      if (!migration?.fromOwnerGeneration || !migration.toOwnerGeneration) {
        throw new Error("missing ownership migration generations");
      }
      await ctx.db.patch(migration._id, { cloudProductStage: "core" });
      await ctx.db.insert("cloud_integration_call_receipts", {
        ownerId: fromOwnerId,
        ownerGeneration: migration.fromOwnerGeneration,
        requestId: "source-live-request",
        fingerprint: "source-fingerprint",
        toolName: "connected.read",
        revision: "revision-1",
        state: "dispatching",
        leaseId: "source-dispatch",
        leaseExpiresAt: 1_500,
        attempts: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return {
        from: migration.fromOwnerGeneration,
        to: migration.toOwnerGeneration,
      };
    });
    const lease = {
      ...ownerArgs,
      leaseId: "integration-receipt-lease",
      leaseGeneration: 1,
    };

    await expect(
      t.mutation(migrationInternal.migrateCloudProductCoreBatch, {
        ...lease,
        leaseNow: 1_001,
      }),
    ).resolves.toEqual({ hasMore: true, progressed: false });
    await expect(
      t.mutation(migrationInternal.migrateCloudProductCoreBatch, {
        ...lease,
        leaseNow: 1_501,
      }),
    ).resolves.toEqual({ hasMore: true, progressed: true });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("cloud_integration_call_receipts")
          .withIndex("by_owner_generation_request", (q) =>
            q
              .eq("ownerId", toOwnerId)
              .eq("ownerGeneration", generations.to)
              .eq("requestId", "source-live-request"),
          )
          .unique(),
      ),
    ).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: generations.to,
      state: "dispatching",
    });

    const destinationLiveId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("cloud_integration_call_receipts", {
        ownerId: toOwnerId,
        ownerGeneration: generations.to,
        requestId: "destination-live-request",
        fingerprint: "destination-live-fingerprint",
        toolName: "connected.read",
        revision: "revision-1",
        state: "dispatching",
        leaseId: "destination-dispatch",
        leaseExpiresAt: 3_000,
        attempts: 1,
        createdAt: 2,
        updatedAt: 2,
      });
      await ctx.db.insert("cloud_integration_call_receipts", {
        ownerId: fromOwnerId,
        ownerGeneration: generations.from,
        requestId: "conflicting-request",
        fingerprint: "source-conflict-fingerprint",
        toolName: "connected.read",
        revision: "revision-1",
        state: "succeeded",
        resultJson: '{"source":true}',
        attempts: 1,
        createdAt: 3,
        updatedAt: 3,
      });
      await ctx.db.insert("cloud_integration_call_receipts", {
        ownerId: toOwnerId,
        ownerGeneration: generations.to,
        requestId: "conflicting-request",
        fingerprint: "destination-conflict-fingerprint",
        toolName: "connected.read",
        revision: "revision-1",
        state: "succeeded",
        resultJson: '{"destination":true}',
        attempts: 1,
        createdAt: 4,
        updatedAt: 4,
      });
      return id;
    });
    await expect(
      t.mutation(migrationInternal.migrateCloudProductCoreBatch, {
        ...lease,
        leaseNow: 2_000,
      }),
    ).resolves.toEqual({ hasMore: true, progressed: false });
    await t.run(async (ctx) => {
      await ctx.db.patch(destinationLiveId, {
        state: "succeeded",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        resultJson: "{}",
      });
    });
    await expect(
      t.mutation(migrationInternal.migrateCloudProductCoreBatch, {
        ...lease,
        leaseNow: 3_001,
      }),
    ).rejects.toThrow(/conflicting connected-tool receipts/u);
  });

  it("moves pet, emoji, and Store objects with their exact deletion locators", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "external-media-lease",
      now: 1_000,
    });
    const migrationId = String(claim.migrationId!);
    await expect(
      t.mutation(migrationInternal.assertExternalMediaMigrationLeaseInternal, {
        ...ownerArgs,
        migrationId,
        leaseId: "external-media-lease",
        leaseGeneration: 1,
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: "legacy",
        planRevision: 1,
        now: 1_001,
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(migrationInternal.assertExternalMediaMigrationLeaseInternal, {
        ...ownerArgs,
        migrationId: "wrong-migration-id",
        leaseId: "external-media-lease",
        leaseGeneration: 1,
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: "legacy",
        planRevision: 1,
        now: 1_001,
      }),
    ).rejects.toThrow("no longer owns the migration lease");

    await t.run(async (ctx) => {
      const packId = await ctx.db.insert("emoji_packs", {
        ownerId: fromOwnerId,
        packId: "pack-source",
        displayName: "Source pack",
        tags: ["test"],
        coverEmoji: "star",
        sheetUrls: ["https://media.test/emoji.png"],
        visibility: "private",
        searchText: "source pack",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("account_external_media_objects", {
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        uploadId: "emoji-upload",
        objectRole: "sheet-1",
        storageKind: "raw-r2",
        bucket: "emoji",
        r2Key: "emoji-packs/source/sheet.png",
        payloadSha256: "emoji-sha",
        publicUrl: "https://media.test/emoji.png",
        state: "committed",
        uploadExpiresAt: 0,
        sourceKind: "emoji_pack",
        sourceId: String(packId),
        sourceKey: `emoji_pack:${String(packId)}`,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const lease = {
      ...ownerArgs,
      leaseId: "external-media-lease",
      leaseGeneration: 1,
      leaseNow: 1_002,
    };
    await expect(
      t.mutation(
        migrationInternal.migrateAccountExternalMediaContentBatch,
        lease,
      ),
    ).resolves.toEqual({ hasMore: true });

    const state = await t.run(async (ctx) => ({
      packs: await ctx.db.query("emoji_packs").collect(),
      locators: await ctx.db.query("account_external_media_objects").collect(),
    }));
    expect(state.packs[0]?.ownerId).toBe(toOwnerId);
    expect(state.locators).toHaveLength(1);
    expect(
      state.locators.every(
        (row) => row.ownerId === toOwnerId && row.ownerGeneration === "legacy",
      ),
    ).toBe(true);
    expect(state.locators.map((row) => row.r2Key)).toEqual([
      "emoji-packs/source/sheet.png",
    ]);
  });

  it("quiesces and discards both principals' execution-placement authority", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "placement-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const [ownerId, ownerGeneration, suffix] of [
        [fromOwnerId, claim.fromOwnerGeneration!, "source"],
        [toOwnerId, claim.toOwnerGeneration!, "destination"],
      ] as const) {
        await ctx.db.insert("desktop_execution_presence", {
          ownerId,
          ownerGeneration,
          deviceId: `desktop-${suffix}`,
          devicePublicKey: `public-key-${suffix}`,
          deviceKeyFingerprint: `fingerprint-${suffix}`,
          presenceSessionId: `presence-${suffix}`,
          protocolVersion: 1,
          appVersion: "test",
          capabilities: ["chat"],
          status: "ready",
          heartbeatSeq: 1,
          proofSeq: 1,
          lastProofOperation: "presence-register",
          lastProofBodyHash: `proof-hash-${suffix}`,
          chatSlotCapacity: 1,
          agentSlotCapacity: 0,
          availableChatSlots: 1,
          availableAgentSlots: 0,
          leaseExpiresAt: 10_000,
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("execution_dispatches", {
          dispatchId: `dispatch-${suffix}`,
          ownerId,
          ownerGeneration,
          idempotencyKey: `dispatch-idempotency-${suffix}`,
          payloadHash: `payload-hash-${suffix}`,
          payloadSizeBytes: 2,
          kind: "chat",
          ingress: "desktop",
          subject: "portable",
          conversationId: `conversation-${suffix}`,
          requiredCapabilities: ["chat"],
          routingPolicyVersion: 1,
          onNoEligibleComputer: "blocked",
          state: "queued",
          revision: 1,
          attemptGeneration: 1,
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("execution_offers", {
          ownerId,
          ownerGeneration,
          dispatchId: `dispatch-${suffix}`,
          deviceId: `desktop-${suffix}`,
          presenceSessionId: `presence-${suffix}`,
          status: "open",
          expiresAt: 10_000,
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("execution_dispatch_payloads", {
          ownerId,
          ownerGeneration,
          dispatchId: `dispatch-${suffix}`,
          payloadJson: "{}",
          payloadHash: `payload-hash-${suffix}`,
          expiresAt: 10_000,
          createdAt: 1,
        });
      }
    });

    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, ownerArgs),
    ).resolves.toEqual({
      kind: "retry",
      table: "desktop_execution_presence",
    });

    await expect(
      t.mutation(migrationInternal.discardAnonymousTransientHandshakesBatch, {
        ...ownerArgs,
        leaseId: "placement-lease",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 1_001,
      }),
    ).rejects.toThrow("before execution quiescence");

    for (const ownerId of [fromOwnerId, toOwnerId]) {
      await expect(
        t.mutation(
          internal.execution_placement
            .quiesceOwnerExecutionPlacementForMigrationInternal,
          { migrationId: claim.migrationId!, ownerId, now: 1_002 },
        ),
      ).resolves.toMatchObject({ ready: true, terminalizedDispatches: 1 });
    }

    for (let pass = 0; pass < 8; pass += 1) {
      await expect(
        t.mutation(migrationInternal.discardAnonymousTransientHandshakesBatch, {
          ...ownerArgs,
          leaseId: "placement-lease",
          leaseGeneration: claim.leaseGeneration!,
          leaseNow: 1_003 + pass,
        }),
      ).resolves.toEqual({ hasMore: true });
    }
    await expect(
      t.mutation(migrationInternal.discardAnonymousTransientHandshakesBatch, {
        ...ownerArgs,
        leaseId: "placement-lease",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 1_011,
      }),
    ).resolves.toEqual({ hasMore: false });
    await expect(
      t.query(migrationInternal.auditOwnershipMigrationResidue, ownerArgs),
    ).resolves.toEqual({ kind: "clear" });

    await expect(
      t.run(async (ctx) => ({
        presence: await ctx.db.query("desktop_execution_presence").collect(),
        dispatches: await ctx.db.query("execution_dispatches").collect(),
        offers: await ctx.db.query("execution_offers").collect(),
        payloads: await ctx.db.query("execution_dispatch_payloads").collect(),
      })),
    ).resolves.toEqual({
      presence: [],
      dispatches: [],
      offers: [],
      payloads: [],
    });
  });

  it("moves versioned Memory and authorized Skills without stale leases", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "cloud-home-lease",
      now: 1_000,
    });
    const fromOwnerHash = "a".repeat(64);
    const toOwnerHash = "b".repeat(64);
    const sourcePrefix = `agent-home/${fromOwnerHash}/`;
    const sha = "c".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_memory_lifecycles", {
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        epoch: "source-memory-epoch",
        state: "open",
        importDisposition: "explicit_required",
        lastWipedEpoch: "source-wiped-epoch",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_memory_lifecycles", {
        ownerId: toOwnerId,
        ownerGeneration: "legacy",
        epoch: "destination-memory-epoch",
        state: "open",
        importDisposition: "explicit_allowed",
        lastWipedEpoch: "destination-wiped-epoch",
        importAuthorizationRequestId: "destination-import-authorization",
        importAuthorizedAt: 2,
        createdAt: 1,
        updatedAt: 2,
      });
      for (const [ownerId, operationId, requestId] of [
        [fromOwnerId, "source-wipe-operation", "source-wipe-request"],
        [toOwnerId, "destination-wipe-operation", "destination-wipe-request"],
      ] as const) {
        await ctx.db.insert("cloud_memory_wipe_jobs", {
          ownerId,
          ownerGeneration: "legacy",
          operationId,
          requestId,
          requestedEpoch: `${ownerId}-old-epoch`,
          targetEpoch: `${ownerId}-old-epoch`,
          nextEpoch: `${ownerId}-next-epoch`,
          stage: "completed",
          externalCursor: 0,
          metadataStoreIndex: 0,
          attempts: 1,
          nextRetryAt: 0,
          objectsDeleted: 1,
          rowsDeleted: 1,
          completedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      await ctx.db.insert("cloud_agent_home_preferences", {
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        memoryEnabled: false,
        revision: 1,
        lastRequestId: "memory-preference-source",
        lastRequestExpectedRevision: 0,
        lastRequestMemoryEnabled: false,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_agent_home_docs", {
        ownerId: fromOwnerId,
        documentId: "memdoc-source",
        name: "MEMORY.md",
        displayPath: "~/.stella/memories/MEMORY.md",
        kind: "memory",
        source: "desktop_sync",
        ownerGeneration: "legacy",
        memoryEpoch: "source-memory-epoch",
        activeVersionId: "memver-source",
        revision: 1,
        r2Key: `${sourcePrefix}memory-versions/memdoc-source/memver-source/${sha}.md`,
        sha256: sha,
        sizeBytes: 10,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_agent_home_doc_versions", {
        versionId: "memver-source",
        documentId: "memdoc-source",
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        memoryEpoch: "source-memory-epoch",
        name: "MEMORY.md",
        revision: 1,
        r2Key: `${sourcePrefix}memory-versions/memdoc-source/memver-source/${sha}.md`,
        sha256: sha,
        sizeBytes: 10,
        writer: "desktop_sync",
        idempotencyKey: "memory-source",
        createdAt: 1,
      });
      await ctx.db.insert("cloud_agent_home_write_intents", {
        intentId: "memintent-source",
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        memoryEpoch: "source-memory-epoch",
        documentId: "memdoc-source",
        name: "MEMORY.md",
        displayPath: "~/.stella/memories/MEMORY.md",
        kind: "memory",
        source: "desktop_sync",
        baseRevision: 1,
        baseVersionId: "memver-source",
        versionId: "memver-pending",
        nextRevision: 2,
        r2Key: `${sourcePrefix}memory-versions/memdoc-source/memver-pending/${sha}.md`,
        sha256: sha,
        sizeBytes: 10,
        writer: "desktop_sync",
        idempotencyKey: "memory-pending",
        status: "prepared",
        expiresAt: 10_000,
        createdAt: 2,
        updatedAt: 2,
      });
      await ctx.db.insert("cloud_skills", {
        skillId: "skill-destination",
        ownerId: toOwnerId,
        slug: "calendar",
        name: "Destination Calendar",
        description: "Existing destination skill",
        source: "cloud_created",
        availability: "both",
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_skills", {
        skillId: "skill-source",
        ownerId: fromOwnerId,
        slug: "calendar",
        name: "Calendar",
        description: "Source skill",
        source: "desktop_sync",
        availability: "both",
        activeVersionId: "skillver-source",
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
      });
      await ctx.db.insert("cloud_skill_versions", {
        versionId: "skillver-source",
        skillId: "skill-source",
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        revision: 1,
        manifestR2Key: `${sourcePrefix}skills/skill-source/skillver-source/manifest.json`,
        manifestSha256: sha,
        treeSha256: sha,
        fileCount: 1,
        totalSizeBytes: 10,
        source: "desktop_sync",
        idempotencyKey: "skill-source",
        createdAt: 1,
      });
      await ctx.db.insert("cloud_skill_files", {
        ownerId: fromOwnerId,
        skillId: "skill-source",
        versionId: "skillver-source",
        path: "SKILL.md",
        r2Key: `${sourcePrefix}skills/skill-source/skillver-source/files/SKILL.md`,
        sha256: sha,
        sizeBytes: 10,
        contentType: "text/markdown",
        createdAt: 1,
      });
      await ctx.db.insert("cloud_skill_write_intents", {
        intentId: "skillintent-source",
        ownerId: fromOwnerId,
        ownerGeneration: "legacy",
        skillId: "skill-source",
        slug: "calendar",
        name: "Calendar",
        description: "Source skill",
        source: "desktop_sync",
        availability: "both",
        baseRevision: 1,
        baseVersionId: "skillver-source",
        versionId: "skillver-pending",
        nextRevision: 2,
        manifestR2Key: `${sourcePrefix}skills/skill-source/skillver-pending/manifest.json`,
        manifestSha256: sha,
        treeSha256: sha,
        fileCount: 1,
        totalSizeBytes: 10,
        filesJson: "[]",
        idempotencyKey: "skill-pending",
        status: "prepared",
        expiresAt: 10_000,
        createdAt: 2,
        updatedAt: 2,
      });
    });

    const receipt = {
      ...ownerArgs,
      leaseId: "cloud-home-lease",
      leaseGeneration: 1,
      leaseNow: 1_001,
      fromOwnerHash,
      toOwnerHash,
      transferOperationId: "d".repeat(64),
      transferPlanFingerprint: "e".repeat(64),
      transferStage: "owner-namespaces",
    };
    let complete = false;
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await t.mutation(
        migrationInternal.commitOwnerNamespaceTransfer,
        receipt,
      );
      if (!result.hasMore) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);

    const state = await t.run(async (ctx) => ({
      memoryPreferences: await ctx.db
        .query("cloud_agent_home_preferences")
        .collect(),
      memoryLifecycles: await ctx.db.query("cloud_memory_lifecycles").collect(),
      memoryWipeJobs: await ctx.db.query("cloud_memory_wipe_jobs").collect(),
      memoryHeads: await ctx.db.query("cloud_agent_home_docs").collect(),
      memoryVersions: await ctx.db
        .query("cloud_agent_home_doc_versions")
        .collect(),
      memoryIntents: await ctx.db
        .query("cloud_agent_home_write_intents")
        .collect(),
      skills: await ctx.db.query("cloud_skills").collect(),
      skillVersions: await ctx.db.query("cloud_skill_versions").collect(),
      skillFiles: await ctx.db.query("cloud_skill_files").collect(),
      skillIntents: await ctx.db.query("cloud_skill_write_intents").collect(),
    }));
    expect(state.memoryPreferences).toHaveLength(1);
    expect(state.memoryPreferences[0]).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: "legacy",
      memoryEnabled: false,
    });
    expect(state.memoryLifecycles).toHaveLength(1);
    expect(state.memoryLifecycles[0]).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: "legacy",
      epoch: "destination-memory-epoch",
      state: "open",
      importDisposition: "explicit_required",
      lastWipedEpoch: "source-wiped-epoch",
    });
    expect(
      state.memoryLifecycles[0]?.importAuthorizationRequestId,
    ).toBeUndefined();
    expect(state.memoryLifecycles[0]?.importAuthorizedAt).toBeUndefined();
    expect(state.memoryWipeJobs).toHaveLength(1);
    expect(state.memoryWipeJobs[0]).toMatchObject({
      ownerId: toOwnerId,
      operationId: "destination-wipe-operation",
      stage: "completed",
    });
    const memory = state.memoryHeads[0]!;
    expect(memory).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: "legacy",
      kind: "imported_markdown",
      source: "owner_migration",
      memoryEpoch: "destination-memory-epoch",
    });
    expect(memory.name).toBe("imports/anonymous-memdocsource/MEMORY.md");
    expect(
      memory.r2Key.startsWith(
        `agent-home/${toOwnerHash}/__stella_imported__/${fromOwnerHash}/`,
      ),
    ).toBe(true);
    expect(state.memoryVersions[0]).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: "legacy",
      name: memory.name,
      writer: "owner_migration",
      memoryEpoch: "destination-memory-epoch",
    });
    expect(state.memoryIntents).toEqual([]);
    const importedSkill = state.skills.find(
      (skill) => skill.skillId === "skill-source",
    )!;
    expect(importedSkill).toMatchObject({
      ownerId: toOwnerId,
      source: "owner_migration",
      activeVersionId: "skillver-source",
    });
    expect(importedSkill.slug).not.toBe("calendar");
    expect(state.skillVersions[0]).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: "legacy",
      source: "owner_migration",
    });
    expect(state.skillFiles[0]?.ownerId).toBe(toOwnerId);
    expect(state.skillIntents).toEqual([]);
  });

  it("preserves a destination Memory import tombstone when its epoch survives", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "memory-import-policy",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_memory_lifecycles", {
        ownerId: fromOwnerId,
        ownerGeneration: claim.fromOwnerGeneration!,
        epoch: "discarded-source-epoch",
        state: "open",
        importDisposition: "explicit_allowed",
        lastWipedEpoch: "source-wiped-epoch",
        importAuthorizationRequestId: "source-only-authorization",
        importAuthorizedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_memory_lifecycles", {
        ownerId: toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        epoch: "surviving-destination-epoch",
        state: "open",
        importDisposition: "explicit_required",
        lastWipedEpoch: "destination-wiped-epoch",
        createdAt: 2,
        updatedAt: 2,
      });
    });
    const receipt = {
      ...ownerArgs,
      leaseId: "memory-import-policy",
      leaseGeneration: claim.leaseGeneration!,
      leaseNow: 1_001,
      fromOwnerHash: "a".repeat(64),
      toOwnerHash: "b".repeat(64),
      transferOperationId: "c".repeat(64),
      transferPlanFingerprint: "d".repeat(64),
      transferStage: "owner-namespaces",
    };
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await t.mutation(
        migrationInternal.commitOwnerNamespaceTransfer,
        { ...receipt, leaseNow: receipt.leaseNow + pass },
      );
      if (!result.hasMore) break;
    }
    const lifecycles = await t.run(
      async (ctx) => await ctx.db.query("cloud_memory_lifecycles").collect(),
    );
    expect(lifecycles).toHaveLength(1);
    expect(lifecycles[0]).toMatchObject({
      ownerId: toOwnerId,
      ownerGeneration: claim.toOwnerGeneration,
      epoch: "surviving-destination-epoch",
      importDisposition: "explicit_required",
      lastWipedEpoch: "destination-wiped-epoch",
    });
    expect(lifecycles[0]?.importAuthorizationRequestId).toBeUndefined();
    expect(lifecycles[0]?.importAuthorizedAt).toBeUndefined();
  });

  it("blocks active Memory wipes on either principal and moves an open source epoch only after the debt completes", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "memory-wipe-barrier",
      now: 1_000,
    });
    const lifecycleId = await t.run(
      async (ctx) =>
        await ctx.db.insert("cloud_memory_lifecycles", {
          ownerId: fromOwnerId,
          ownerGeneration: claim.fromOwnerGeneration!,
          epoch: "source-open-epoch",
          state: "wiping",
          operationId: "active-source-wipe",
          importDisposition: "explicit_allowed",
          lastWipedEpoch: "source-previous-epoch",
          importAuthorizationRequestId: "source-import-authorization",
          importAuthorizedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const receipt = {
      ...ownerArgs,
      leaseId: "memory-wipe-barrier",
      leaseGeneration: claim.leaseGeneration!,
      leaseNow: 1_001,
      fromOwnerHash: "a".repeat(64),
      toOwnerHash: "b".repeat(64),
      transferOperationId: "c".repeat(64),
      transferPlanFingerprint: "d".repeat(64),
      transferStage: "owner-namespaces",
    };

    await expect(
      t.query(migrationInternal.getOwnerNamespaceTransferBlocker, ownerArgs),
    ).resolves.toContain("anonymous identity has a Memory wipe in progress");
    await expect(
      t.mutation(migrationInternal.commitOwnerNamespaceTransfer, receipt),
    ).rejects.toThrow("anonymous identity has a Memory wipe in progress");

    const destinationJobId = await t.run(async (ctx) => {
      await ctx.db.patch(lifecycleId, {
        state: "open",
        operationId: undefined,
        updatedAt: 2,
      });
      return await ctx.db.insert("cloud_memory_wipe_jobs", {
        ownerId: toOwnerId,
        ownerGeneration: claim.toOwnerGeneration!,
        operationId: "destination-wipe-operation",
        requestId: "destination-wipe-request",
        requestedEpoch: "destination-old-epoch",
        targetEpoch: "destination-old-epoch",
        nextEpoch: "destination-next-epoch",
        stage: "metadata",
        externalCursor: 0,
        metadataStoreIndex: 0,
        attempts: 1,
        nextRetryAt: 2,
        objectsDeleted: 1,
        rowsDeleted: 0,
        createdAt: 1,
        updatedAt: 2,
      });
    });
    await expect(
      t.query(migrationInternal.getOwnerNamespaceTransferBlocker, ownerArgs),
    ).resolves.toContain("connected identity has unfinished Memory wipe debt");
    await expect(
      t.mutation(migrationInternal.commitOwnerNamespaceTransfer, receipt),
    ).rejects.toThrow("connected identity has unfinished Memory wipe debt");

    await t.run(async (ctx) => {
      await ctx.db.patch(destinationJobId, {
        stage: "completed",
        completedAt: 3,
        updatedAt: 3,
      });
    });
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await t.mutation(
        migrationInternal.commitOwnerNamespaceTransfer,
        { ...receipt, leaseNow: 1_002 + pass },
      );
      if (!result.hasMore) break;
    }
    await expect(
      t.run(async (ctx) => ({
        lifecycles: await ctx.db.query("cloud_memory_lifecycles").collect(),
        jobs: await ctx.db.query("cloud_memory_wipe_jobs").collect(),
      })),
    ).resolves.toMatchObject({
      lifecycles: [
        {
          ownerId: toOwnerId,
          ownerGeneration: claim.toOwnerGeneration!,
          epoch: "source-open-epoch",
          state: "open",
          importDisposition: "explicit_allowed",
          lastWipedEpoch: "source-previous-epoch",
          importAuthorizationRequestId: "source-import-authorization",
          importAuthorizedAt: 1,
        },
      ],
      jobs: [
        {
          ownerId: toOwnerId,
          operationId: "destination-wipe-operation",
          stage: "completed",
        },
      ],
    });
  });

  it("fails closed on conflicting source and destination Memory preferences", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    const claim = await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "memory-preference-conflict",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const [ownerId, generation, memoryEnabled] of [
        [fromOwnerId, claim.fromOwnerGeneration!, false],
        [toOwnerId, claim.toOwnerGeneration!, true],
      ] as const) {
        await ctx.db.insert("cloud_agent_home_preferences", {
          ownerId,
          ownerGeneration: generation,
          memoryEnabled,
          revision: 1,
          lastRequestId: `${ownerId}-memory-preference`,
          lastRequestExpectedRevision: 0,
          lastRequestMemoryEnabled: memoryEnabled,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });

    await expect(
      t.mutation(migrationInternal.commitOwnerNamespaceTransfer, {
        ...ownerArgs,
        leaseId: "memory-preference-conflict",
        leaseGeneration: claim.leaseGeneration!,
        leaseNow: 1_001,
        fromOwnerHash: "a".repeat(64),
        toOwnerHash: "b".repeat(64),
        transferOperationId: "c".repeat(64),
        transferPlanFingerprint: "d".repeat(64),
        transferStage: "owner-namespaces",
      }),
    ).rejects.toThrow("conflicting Memory preferences");
  });
});
