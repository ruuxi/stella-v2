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
    ]);
    await t.run(async (ctx) => {
      const links = await ctx.db.query("auth_link_requests").collect();
      const handoffs = await ctx.db.query("auth_browser_handoffs").collect();
      await Promise.all(
        [...links, ...handoffs].map((row) =>
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

  it("fences stale leases and an account-deletion race before table writes", async () => {
    const t = createTest();
    await t.mutation(migrationInternal.prepareOwnershipMigration, ownerArgs);
    await t.mutation(migrationInternal.claimOwnershipMigration, {
      ...ownerArgs,
      leaseId: "active-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("user_counters", {
        ownerId: fromOwnerId,
        conversationCount: 1,
        updatedAt: 1,
      });
    });

    await expect(
      t.mutation(migrationInternal.migrateUserCountersBatch, {
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
      t.mutation(migrationInternal.migrateUserCountersBatch, {
        ...ownerArgs,
        leaseId: "active-lease",
        leaseGeneration: 1,
        leaseNow: 1_003,
      }),
    ).rejects.toThrow("being deleted");

    const sourceCounter = await t.run(async (ctx) =>
      ctx.db
        .query("user_counters")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", fromOwnerId))
        .unique(),
    );
    expect(sourceCounter?.ownerId).toBe(fromOwnerId);
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
      await ctx.db.insert("cloud_agent_threads", {
        threadId: "cloud-thread",
        ownerId: fromOwnerId,
        conversationId: "cloud-conversation",
        description: "Test thread",
        placement: "cloud",
        agentType: "general",
        status: "completed",
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

    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("cloud_agent_threads")
          .withIndex("by_threadId", (q) => q.eq("threadId", "cloud-thread"))
          .unique(),
      ),
    ).toMatchObject({ ownerId: toOwnerId });

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
});
