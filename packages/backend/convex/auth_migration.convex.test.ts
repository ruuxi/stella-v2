/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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
        "mutation",
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
      migrateUserCountersBatch: FunctionReference<
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
      await t.mutation(
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

});
