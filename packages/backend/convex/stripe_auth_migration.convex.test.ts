/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { ownershipMigrationSourceDigest } from "./lib/auth_migration_paths";
import { stripeResolutionAuditHash } from "./stripe_operation_dispatch";
import {
  hashStripeBillingLocator,
  hashStripeRetainedLocatorSet,
} from "./lib/billing_deletion";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js"]);
const createTest = () => convexTest(schema, modules);
type Harness = ReturnType<typeof createTest>;

type OwnerArgs = { fromOwnerId: string; toOwnerId: string };
type LeaseArgs = OwnerArgs & {
  leaseId: string;
  leaseGeneration: number;
  leaseNow: number;
};

const prepareMigration = makeFunctionReference<"mutation", OwnerArgs, null>(
  "auth_migration:prepareOwnershipMigration",
);
const claimMigration = makeFunctionReference<
  "mutation",
  OwnerArgs & { leaseId: string; now: number },
  {
    claimed: boolean;
    terminal: boolean;
    migrationId?: string;
    leaseGeneration?: number;
    fromOwnerGeneration?: string;
    toOwnerGeneration?: string;
  }
>("auth_migration:claimOwnershipMigration");
const quiesceMigrationStripe = makeFunctionReference<
  "mutation",
  LeaseArgs,
  { ready: boolean; pending: string[]; retryAt: number | null }
>("auth_migration:quiesceStripeOperationsForOwnershipMigration");
const migrateStripe = makeFunctionReference<
  "mutation",
  LeaseArgs,
  { hasMore: boolean }
>("auth_migration:migrateStripeOperationsBatch");
const migrateStripeResolutions = makeFunctionReference<
  "mutation",
  LeaseArgs,
  { hasMore: boolean }
>("auth_migration:migrateStripeOperationResolutionsBatch");
const migrateDevices = makeFunctionReference<
  "mutation",
  LeaseArgs,
  { hasMore: boolean }
>("auth_migration:migrateDevicesForAccountLink");
const prepareStripeMetadataTransfer = makeFunctionReference<
  "mutation",
  LeaseArgs,
  | null
  | { kind: "local_only" }
  | { kind: "wait"; retryAt: number }
  | {
      kind: "provider_transfer";
      operationId: string;
      stripeCustomerId: string;
      attemptId: string;
      idempotencyKey: string;
      providerDeadlineAt: number;
    }
>("auth_migration:prepareStripeCustomerMetadataTransferInternal");
const revalidateStripeMetadataTransfer = makeFunctionReference<
  "mutation",
  LeaseArgs & {
    operationId: string;
    stripeCustomerId: string;
    attemptId: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
  },
  { providerDeadlineAt: number } | null
>("auth_migration:revalidateStripeCustomerMetadataTransferInternal");
const commitStripeMetadataTransfer = makeFunctionReference<
  "mutation",
  LeaseArgs & {
    operationId: string;
    stripeCustomerId: string;
    attemptId: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    providerOwnerId: string;
  },
  boolean
>("auth_migration:commitStripeCustomerMetadataTransferInternal");
const authorizeLateStripeCleanupProviderOwner = makeFunctionReference<
  "query",
  {
    providerOwnerHash: string;
    cleanupOwnerHash?: string;
    providerOwnerId: string;
  },
  boolean
>("stripe_operation_dispatch:authorizeLateStripeCleanupProviderOwnerInternal");
const migrateStripeWithProvider = makeFunctionReference<
  "action",
  LeaseArgs,
  { hasMore: boolean; retryAt?: number }
>("auth_migration:migrateNextStripeOperationWithProviderInternal");
const resolveStripeMetadataTransferDebt = makeFunctionReference<
  "mutation",
  {
    operationId: string;
    expectedAttemptId: string;
    expectedSourceOwnerId: string;
    expectedDestinationOwnerId: string;
    resolutionId: string;
    resolution: "provider_restored_source" | "provider_confirmed_deleted";
    resolvedBy: string;
    evidence: string;
    now: number;
  },
  {
    resolution: "provider_restored_source" | "provider_confirmed_deleted";
    replayed: boolean;
  }
>("stripe_operation_dispatch:resolveStripeMetadataTransferDebtInternal");
const migrateUsage = makeFunctionReference<
  "mutation",
  LeaseArgs,
  { hasMore: boolean }
>("auth_migration:migrateUsageAccountingBatch");
const reserveStripe = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    kind: "subscription_checkout" | "usage_credit_checkout" | "billing_portal";
    stripeCustomerId?: string;
    requestKey: string;
    requestFingerprint: string;
    now: number;
  },
  {
    operationId: string;
    ownerGeneration: string;
    idempotencyKey: string;
    stripeCustomerCreateIdempotencyKey: string;
    state: "reserved" | "provider_succeeded" | "completed";
    dispatchState: "idle" | "may_have_dispatched";
    activeStep: "customer_create" | "checkout_create" | "portal_create" | null;
    stripeCustomerId: string | null;
    stripeCheckoutSessionId: string | null;
    stripePortalSessionId: string | null;
  }
>("billing:reserveStripeOperationInternal");
const markStripe = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    step: "customer_create" | "checkout_create" | "portal_create";
    requestJson: string;
    now: number;
  },
  {
    attemptId: string;
    requestFingerprint: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    quiescentAfterAt: number;
    replayed: boolean;
  }
>("stripe_operation_dispatch:markStripeOperationDispatchInternal");
const settleStripe = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    step: "customer_create" | "checkout_create" | "portal_create";
    requestFingerprint: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
    now: number;
  },
  { recorded: boolean; duplicate: boolean; customerDeleted: boolean }
>("stripe_operation_dispatch:settleStripeOperationDispatchInternal");

const seedOwner = async (
  t: Harness,
  ownerId: string,
  generation: string,
  stripeCustomerId = "",
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId,
      generation,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("billing_profiles", {
      ownerId,
      activePlan: "free",
      subscriptionStatus: "none",
      stripeCustomerId,
      stripeSubscriptionId: "",
      stripePriceId: "",
      defaultPaymentMethodId: "",
      paymentMethodBrand: "",
      paymentMethodLast4: "",
      currentPeriodStart: 0,
      currentPeriodEnd: 0,
      cancelAtPeriodEnd: false,
      monthlyAnchorAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
  });
};

const claim = async (t: Harness, owners: OwnerArgs): Promise<LeaseArgs> => {
  await t.mutation(prepareMigration, owners);
  const result = await t.mutation(claimMigration, {
    ...owners,
    leaseId: "stripe-migration-lease",
    now: 1_000,
  });
  expect(result).toMatchObject({ claimed: true, terminal: false });
  return {
    ...owners,
    leaseId: "stripe-migration-lease",
    leaseGeneration: result.leaseGeneration!,
    leaseNow: 1_001,
  };
};

const seedStripeOperation = async (
  t: Harness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    requestKey?: string;
    requestFingerprint: string;
    createdAt: number;
  },
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("billing_stripe_operations", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      operationId: args.operationId,
      kind: "subscription_checkout",
      state: "reserved",
      dispatchState: "idle",
      idempotencyKey: `${args.operationId}:operation`,
      stripeCustomerCreateIdempotencyKey: `${args.operationId}:customer`,
      ...(args.requestKey ? { requestKey: args.requestKey } : {}),
      requestFingerprint: args.requestFingerprint,
      leaseExpiresAt: 0,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    });
  });
};

describe("Stripe ownership migration replay authority", () => {
  it("performs zero provider calls when any operation resolution proof has stale ownership", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "transfer-stale-proof-source",
      toOwnerId: "transfer-stale-proof-destination",
    };
    const sourceGeneration = "transfer-stale-proof-source-generation";
    const destinationGeneration = "transfer-stale-proof-destination-generation";
    const stripeCustomerId = "cus_transfer_stale_resolution_proof";
    await seedOwner(t, owners.fromOwnerId, sourceGeneration, stripeCustomerId);
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    const operation = await t.mutation(reserveStripe, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
      kind: "subscription_checkout",
      stripeCustomerId,
      requestKey: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      now: 100,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_operation_resolutions", {
        ownerId: owners.fromOwnerId,
        ownerGeneration: "stale-resolution-generation",
        operationId: operation.operationId,
        resolutionId: "transfer-stale-resolution-proof",
        debtKey:
          "attempt:transfer-stale-resolution-attempt:customer_lookup_unavailable",
        attemptId: "transfer-stale-resolution-attempt",
        step: "customer_create",
        resolution: "recovered_customer",
        debtReason: "customer_lookup_unavailable",
        locatorHash: "c".repeat(64),
        resolvedByHash: "d".repeat(64),
        evidenceHash: "e".repeat(64),
        resolvedAt: 101,
      });
    });
    await t.mutation(prepareMigration, owners);
    const wallNow = Date.now();
    const claimed = await t.mutation(claimMigration, {
      ...owners,
      leaseId: "transfer-stale-proof-lease",
      now: wallNow,
    });
    const lease: LeaseArgs = {
      ...owners,
      leaseId: "transfer-stale-proof-lease",
      leaseGeneration: claimed.leaseGeneration!,
      leaseNow: wallNow + 1,
    };
    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(async () => {
      throw new Error("provider must not run");
    });
    process.env.STRIPE_SECRET_KEY = "sk_test_zero_call_stale_proof";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await expect(t.action(migrateStripeWithProvider, lease)).rejects.toThrow(
        /stale or conflicting resolution authority/iu,
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    expect(providerFetch).not.toHaveBeenCalled();
    const unchangedOperation = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
    );
    expect(unchangedOperation).toMatchObject({
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
    });
    expect(
      unchangedOperation?.stripeCustomerMetadataTransferState,
    ).toBeUndefined();
  });

  it("recovers a response-lost metadata transfer before the generic quiescence gate", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "transfer-recovery-source",
      toOwnerId: "transfer-recovery-destination",
    };
    const sourceGeneration = "transfer-recovery-source-generation";
    const destinationGeneration = "transfer-recovery-destination-generation";
    const stripeCustomerId = "cus_transfer_response_lost";
    await seedOwner(t, owners.fromOwnerId, sourceGeneration, stripeCustomerId);
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    const operation = await t.mutation(reserveStripe, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
      kind: "subscription_checkout",
      stripeCustomerId,
      requestKey: "6".repeat(64),
      requestFingerprint: "7".repeat(64),
      now: Date.now() - 10_000,
    });

    await t.mutation(prepareMigration, owners);
    const wallNow = Date.now();
    const claimResult = await t.mutation(claimMigration, {
      ...owners,
      leaseId: "transfer-recovery-lease",
      now: wallNow,
    });
    const lease: LeaseArgs = {
      ...owners,
      leaseId: "transfer-recovery-lease",
      leaseGeneration: claimResult.leaseGeneration!,
      leaseNow: wallNow + 1,
    };
    await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
      ready: true,
      pending: [],
      retryAt: null,
    });
    const transfer = await t.mutation(prepareStripeMetadataTransfer, lease);
    if (!transfer || transfer.kind !== "provider_transfer") {
      throw new Error("Expected a provider metadata transfer tuple.");
    }
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        stripeCustomerMetadataTransferProviderDeadlineAt: wallNow - 20_000,
        stripeCustomerMetadataTransferQuiescentAfterAt: wallNow - 5_000,
      });
    });
    const blocked = await t.mutation(quiesceMigrationStripe, {
      ...lease,
      leaseNow: wallNow + 2,
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.pending).toContain(
      `stripe_customer_metadata_transfer_outcome_unknown:${operation.operationId}`,
    );

    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      expect(url).toContain(`/v1/customers/${stripeCustomerId}`);
      return new Response(
        JSON.stringify({
          id: stripeCustomerId,
          object: "customer",
          deleted: false,
          metadata: { ownerId: owners.toOwnerId },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "request-id": "req_transfer_recovery",
          },
        },
      );
    });
    process.env.STRIPE_SECRET_KEY = "sk_test_transfer_recovery";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await expect(
        t.action(migrateStripeWithProvider, {
          ...lease,
          leaseNow: Date.now(),
        }),
      ).resolves.toEqual({ hasMore: true });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }

    expect(providerFetch).toHaveBeenCalledTimes(2);
    const snapshot = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
      aliases: await ctx.db.query("billing_stripe_owner_aliases").collect(),
    }));
    expect(snapshot.operation).toMatchObject({
      ownerId: owners.toOwnerId,
      ownerGeneration: destinationGeneration,
      stripeCustomerId,
      stripeCustomerMetadataOwnerId: owners.toOwnerId,
      stripeCustomerMetadataTransferState: "idle",
    });
    expect(
      snapshot.operation?.stripeCustomerMetadataTransferAttemptId,
    ).toBeUndefined();
    expect(snapshot.aliases).toHaveLength(1);
  });

  it.each(["customer_deleted", "foreign_owner"] as const)(
    "atomically fails an active metadata transfer on terminal %s readback",
    async (terminalReason) => {
      const t = createTest();
      const owners = {
        fromOwnerId: `terminal-transfer-source-${terminalReason}`,
        toOwnerId: `terminal-transfer-destination-${terminalReason}`,
      };
      const sourceGeneration = `terminal-source-generation-${terminalReason}`;
      const destinationGeneration = `terminal-destination-generation-${terminalReason}`;
      const stripeCustomerId = `cus_terminal_${terminalReason}`;
      await seedOwner(
        t,
        owners.fromOwnerId,
        sourceGeneration,
        stripeCustomerId,
      );
      await seedOwner(t, owners.toOwnerId, destinationGeneration);
      const operation = await t.mutation(reserveStripe, {
        ownerId: owners.fromOwnerId,
        ownerGeneration: sourceGeneration,
        kind: "subscription_checkout",
        stripeCustomerId,
        requestKey:
          terminalReason === "customer_deleted"
            ? "2".repeat(64)
            : "3".repeat(64),
        requestFingerprint:
          terminalReason === "customer_deleted"
            ? "4".repeat(64)
            : "5".repeat(64),
        now: Date.now() - 1_000,
      });
      await t.mutation(prepareMigration, owners);
      const wallNow = Date.now();
      const claimed = await t.mutation(claimMigration, {
        ...owners,
        leaseId: `terminal-transfer-lease-${terminalReason}`,
        now: wallNow,
      });
      const lease: LeaseArgs = {
        ...owners,
        leaseId: `terminal-transfer-lease-${terminalReason}`,
        leaseGeneration: claimed.leaseGeneration!,
        leaseNow: wallNow + 1,
      };

      const previousSecret = process.env.STRIPE_SECRET_KEY;
      const previousFetch = globalThis.fetch;
      const providerFetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              terminalReason === "customer_deleted"
                ? { id: stripeCustomerId, object: "customer", deleted: true }
                : {
                    id: stripeCustomerId,
                    object: "customer",
                    deleted: false,
                    metadata: { ownerId: "unrelated-terminal-owner" },
                  },
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "request-id": `req_terminal_${terminalReason}`,
              },
            },
          ),
      );
      process.env.STRIPE_SECRET_KEY = `sk_test_terminal_${terminalReason}`;
      globalThis.fetch = providerFetch as typeof fetch;
      try {
        await expect(
          t.action(migrateStripeWithProvider, lease),
        ).rejects.toThrow(/ownership_migration_blocked/iu);
      } finally {
        globalThis.fetch = previousFetch;
        if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = previousSecret;
      }
      expect(providerFetch).toHaveBeenCalledTimes(1);
      const terminal = await t.run(async (ctx) => ({
        operation: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .unique(),
        migration: await ctx.db
          .query("auth_owner_migrations")
          .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
            q
              .eq("fromOwnerId", owners.fromOwnerId)
              .eq("toOwnerId", owners.toOwnerId),
          )
          .unique(),
      }));
      expect(terminal.operation).toMatchObject({
        stripeCustomerMetadataTransferDebtReason: terminalReason,
      });
      expect(terminal.migration).toMatchObject({ status: "failed" });
      expect(terminal.migration?.leaseId).toBeUndefined();
      expect(terminal.migration?.watchdogId).toBeUndefined();
      const attemptId =
        terminal.operation!.stripeCustomerMetadataTransferAttemptId!;
      const quiescentAfterAt =
        terminal.operation!.stripeCustomerMetadataTransferQuiescentAfterAt!;
      const resolution =
        terminalReason === "customer_deleted"
          ? ("provider_confirmed_deleted" as const)
          : ("provider_restored_source" as const);
      await expect(
        t.mutation(resolveStripeMetadataTransferDebt, {
          operationId: operation.operationId,
          expectedAttemptId: attemptId,
          expectedSourceOwnerId: owners.fromOwnerId,
          expectedDestinationOwnerId: owners.toOwnerId,
          resolutionId: `terminal-transfer-resolution-${terminalReason}`,
          resolution,
          resolvedBy: "operator@example.test",
          evidence: `Stripe support confirmed terminal ${terminalReason} ownership.`,
          now: quiescentAfterAt + 1,
        }),
      ).resolves.toEqual({ resolution, replayed: false });
    },
  );

  it("moves every immutable resolution audit atomically with its operation authority", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "stripe-resolution-source",
      toOwnerId: "stripe-resolution-destination",
    };
    const sourceGeneration = "source-generation";
    const destinationGeneration = "destination-generation";
    await seedOwner(t, owners.fromOwnerId, sourceGeneration);
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    await seedStripeOperation(t, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: "resolved-operation",
      requestKey: "9".repeat(64),
      requestFingerprint: "8".repeat(64),
      createdAt: 1,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_operation_resolutions", {
        ownerId: owners.fromOwnerId,
        ownerGeneration: sourceGeneration,
        operationId: "resolved-operation",
        resolutionId: "resolved-operation-audit",
        debtKey: "attempt:resolved-operation-attempt",
        attemptId: "resolved-operation-attempt",
        step: "customer_create",
        resolution: "recovered_customer",
        locatorHash: "a".repeat(64),
        resolvedByHash: "b".repeat(64),
        evidenceHash: "c".repeat(64),
        resolvedAt: 2,
      });
      await ctx.db.insert("billing_stripe_operation_resolutions", {
        ownerId: owners.fromOwnerId,
        ownerGeneration: sourceGeneration,
        operationId: "resolved-operation",
        resolutionId: "resolved-operation-late-audit",
        debtKey:
          "attempt:resolved-operation-other-attempt:customer_lookup_unavailable",
        attemptId: "resolved-operation-other-attempt",
        step: "customer_create",
        resolution: "recovered_customer",
        debtReason: "customer_lookup_unavailable",
        locatorHash: "e".repeat(64),
        resolvedByHash: "f".repeat(64),
        evidenceHash: "0".repeat(64),
        resolvedAt: 3,
      });
    });
    const lease = await claim(t, owners);
    await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
      ready: true,
      pending: [],
      retryAt: null,
    });
    while ((await t.mutation(migrateStripe, lease)).hasMore) {
      // Drain operation authority before its immutable audit.
    }
    await expect(t.mutation(migrateStripeResolutions, lease)).resolves.toEqual({
      hasMore: false,
    });
    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", "resolved-operation-audit"),
        )
        .unique(),
    );
    expect(audit).toMatchObject({
      ownerId: owners.toOwnerId,
      ownerGeneration: destinationGeneration,
      operationId: "resolved-operation",
      debtKey: "attempt:resolved-operation-attempt",
      locatorHash: "a".repeat(64),
      resolvedByHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
    });
    const lateAudit = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", "resolved-operation-late-audit"),
        )
        .unique(),
    );
    expect(lateAudit).toMatchObject({
      ownerId: owners.toOwnerId,
      ownerGeneration: destinationGeneration,
      operationId: "resolved-operation",
      debtReason: "customer_lookup_unavailable",
    });
  });

  it("repairs each legacy physical receipt inside the operation-scoped move mutation", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "stripe-two-operation-source",
      toOwnerId: "stripe-two-operation-destination",
    };
    const sourceGeneration = "stripe-two-operation-source-generation";
    const destinationGeneration = "stripe-two-operation-destination-generation";
    await seedOwner(t, owners.fromOwnerId, sourceGeneration);
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    for (const [index, operationId] of [
      "stripe-two-operation-a",
      "stripe-two-operation-b",
    ].entries()) {
      await seedStripeOperation(t, {
        ownerId: owners.fromOwnerId,
        ownerGeneration: sourceGeneration,
        operationId,
        requestKey: `${index + 1}`.repeat(64),
        requestFingerprint: `${index + 3}`.repeat(64),
        createdAt: index + 1,
      });
      await t.run(async (ctx) => {
        const operation = await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique();
        await ctx.db.patch(operation!._id, {
          integrityVersion: 2,
          lastStripeStep: "customer_create",
          lastStripeAttemptId: `${operationId}-attempt`,
          lastStripeRequestFingerprint: `${index + 5}`.repeat(64),
          lastStripeIdempotencyKey: `${operationId}-provider-key`,
          lastStripeProviderDeadlineAt: 500 + index,
          lastStripeDisposition: "not_created",
        });
      });
    }

    const lease = await claim(t, owners);
    await expect(t.mutation(migrateStripe, lease)).resolves.toEqual({
      hasMore: true,
    });
    await expect(t.mutation(migrateStripe, lease)).resolves.toEqual({
      hasMore: true,
    });
    await expect(t.mutation(migrateStripe, lease)).resolves.toEqual({
      hasMore: false,
    });

    const sourceOwnerHash = await ownershipMigrationSourceDigest(
      owners.fromOwnerId,
    );
    const snapshot = await t.run(async (ctx) => ({
      operations: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", owners.toOwnerId),
        )
        .collect(),
      receipts: await ctx.db
        .query("billing_stripe_physical_receipts")
        .collect(),
    }));
    expect(snapshot.operations).toHaveLength(2);
    expect(snapshot.operations.every((row) => row.integrityVersion === 3)).toBe(
      true,
    );
    expect(snapshot.receipts).toHaveLength(2);
    expect(
      snapshot.receipts.every(
        (row) =>
          row.providerOwnerHash === sourceOwnerHash &&
          row.notCreatedTerminalized === true,
      ),
    ).toBe(true);
  });

  it("atomically repairs mixed source and destination resolution residue after an old deployment moved the operation", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "stripe-mixed-resolution-source",
      toOwnerId: "stripe-mixed-resolution-destination",
    };
    const sourceGeneration = "stripe-mixed-resolution-source-generation";
    const destinationGeneration =
      "stripe-mixed-resolution-destination-generation";
    await seedOwner(t, owners.fromOwnerId, sourceGeneration);
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    const lease = await claim(t, owners);
    const operationId = "stripe-mixed-resolution-operation";
    await seedStripeOperation(t, {
      ownerId: owners.toOwnerId,
      ownerGeneration: destinationGeneration,
      operationId,
      requestKey: "6".repeat(64),
      requestFingerprint: "7".repeat(64),
      createdAt: 1,
    });
    await t.run(async (ctx) => {
      for (const [index, atDestination] of [false, true].entries()) {
        await ctx.db.insert("billing_stripe_operation_resolutions", {
          ownerId: atDestination ? owners.toOwnerId : owners.fromOwnerId,
          ownerGeneration: atDestination
            ? destinationGeneration
            : sourceGeneration,
          operationId,
          resolutionId: `stripe-mixed-resolution-${index}`,
          debtKey: `attempt:stripe-mixed-attempt-${index}:customer_lookup_unavailable`,
          attemptId: `stripe-mixed-attempt-${index}`,
          step: "customer_create",
          resolution: "recovered_customer",
          debtReason: "customer_lookup_unavailable",
          locatorHash: `${index + 8}`.repeat(64),
          resolvedByHash: `${index + 1}`.repeat(64),
          evidenceHash: `${index + 3}`.repeat(64),
          resolvedAt: index,
        });
      }
    });

    await expect(t.mutation(migrateStripeResolutions, lease)).resolves.toEqual({
      hasMore: true,
    });
    await expect(t.mutation(migrateStripeResolutions, lease)).resolves.toEqual({
      hasMore: false,
    });
    const proofs = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_operationId_and_resolvedAt", (q) =>
          q.eq("operationId", operationId),
        )
        .collect(),
    );
    expect(proofs).toHaveLength(2);
    expect(
      proofs.every(
        (row) =>
          row.ownerId === owners.toOwnerId &&
          row.ownerGeneration === destinationGeneration,
      ),
    ).toBe(true);
  });

  it.each([
    "stale-source-generation",
    "stale-destination-generation",
    "duplicate-debt-key",
  ] as const)(
    "rejects %s while migrating Stripe resolution audits",
    async (scenario) => {
      const t = createTest();
      const owners = {
        fromOwnerId: `resolution-${scenario}-source`,
        toOwnerId: `resolution-${scenario}-destination`,
      };
      const sourceGeneration = `resolution-${scenario}-source-generation`;
      const destinationGeneration = `resolution-${scenario}-destination-generation`;
      await seedOwner(t, owners.fromOwnerId, sourceGeneration);
      await seedOwner(t, owners.toOwnerId, destinationGeneration);
      const lease = await claim(t, owners);
      const operationId = `resolution-${scenario}-operation`;
      await seedStripeOperation(t, {
        ownerId: owners.toOwnerId,
        ownerGeneration:
          scenario === "stale-destination-generation"
            ? "stale-destination-generation"
            : destinationGeneration,
        operationId,
        requestKey: "1".repeat(64),
        requestFingerprint: "2".repeat(64),
        createdAt: 1,
      });
      await t.run(async (ctx) => {
        await ctx.db.insert("billing_stripe_operation_resolutions", {
          ownerId: owners.fromOwnerId,
          ownerGeneration:
            scenario === "stale-source-generation"
              ? "stale-source-generation"
              : sourceGeneration,
          operationId,
          resolutionId: `resolution-${scenario}-source-audit`,
          debtKey: "attempt:shared-provider-debt",
          attemptId: "shared-provider-attempt",
          step: "customer_create",
          resolution: "recovered_customer",
          locatorHash: "3".repeat(64),
          resolvedByHash: "4".repeat(64),
          evidenceHash: "5".repeat(64),
          resolvedAt: 1,
        });
        if (scenario === "duplicate-debt-key") {
          await ctx.db.insert("billing_stripe_operation_resolutions", {
            ownerId: owners.toOwnerId,
            ownerGeneration: destinationGeneration,
            operationId,
            resolutionId: "resolution-duplicate-debt-key-destination-audit",
            debtKey: "attempt:shared-provider-debt",
            attemptId: "shared-provider-attempt",
            step: "customer_create",
            resolution: "recovered_customer",
            locatorHash: "3".repeat(64),
            resolvedByHash: "6".repeat(64),
            evidenceHash: "7".repeat(64),
            resolvedAt: 2,
          });
        }
      });

      await expect(t.mutation(migrateStripeResolutions, lease)).rejects.toThrow(
        /missing, stale, or conflicting resolution audits/iu,
      );
      const audits = await t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_operationId_and_resolvedAt", (q) =>
            q.eq("operationId", operationId),
          )
          .collect(),
      );
      expect(audits.some((row) => row.ownerId === owners.fromOwnerId)).toBe(
        true,
      );
    },
  );

  it.each([
    "stale-source-generation",
    "conflicting-public-key",
    "adopt-source-public-key",
  ] as const)("fences device migration for %s", async (scenario) => {
    const t = createTest();
    const owners = {
      fromOwnerId: `device-${scenario}-source`,
      toOwnerId: `device-${scenario}-destination`,
    };
    const sourceGeneration = `device-${scenario}-source-generation`;
    const destinationGeneration = `device-${scenario}-destination-generation`;
    await seedOwner(t, owners.fromOwnerId, sourceGeneration);
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    const lease = await claim(t, owners);
    await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q
            .eq("fromOwnerId", owners.fromOwnerId)
            .eq("toOwnerId", owners.toOwnerId),
        )
        .unique();
      await ctx.db.patch(migration!._id, { cloudProductStage: "complete" });
      await ctx.db.insert("devices", {
        ownerId: owners.fromOwnerId,
        ownerGeneration:
          scenario === "stale-source-generation"
            ? "stale-source-generation"
            : sourceGeneration,
        deviceId: "shared-device",
        devicePublicKey: "source-public-key",
      });
      if (scenario !== "stale-source-generation") {
        await ctx.db.insert("devices", {
          ownerId: owners.toOwnerId,
          ownerGeneration: destinationGeneration,
          deviceId: "shared-device",
          ...(scenario === "conflicting-public-key"
            ? { devicePublicKey: "destination-public-key" }
            : {}),
        });
      }
    });

    if (scenario === "adopt-source-public-key") {
      await expect(t.mutation(migrateDevices, lease)).resolves.toEqual({
        hasMore: false,
      });
      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("devices")
          .withIndex("by_ownerId_and_deviceId", (q) =>
            q.eq("ownerId", owners.toOwnerId).eq("deviceId", "shared-device"),
          )
          .collect(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ownerGeneration: destinationGeneration,
        devicePublicKey: "source-public-key",
      });
      return;
    }

    await expect(t.mutation(migrateDevices, lease)).rejects.toThrow(
      scenario === "stale-source-generation"
        ? /stale source generation/iu
        : /different public keys/iu,
    );
    const source = await t.run(async (ctx) =>
      ctx.db
        .query("devices")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", owners.fromOwnerId).eq("deviceId", "shared-device"),
        )
        .unique(),
    );
    expect(source).not.toBeNull();
  });

  it("collides by logical request key even when request details differ", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "stripe-collision-source",
      toOwnerId: "stripe-collision-destination",
    };
    await seedOwner(t, owners.fromOwnerId, "source-generation");
    await seedOwner(t, owners.toOwnerId, "destination-generation");
    const lease = await claim(t, owners);
    const requestKey = "a".repeat(64);
    await seedStripeOperation(t, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: "source-generation",
      operationId: "source-operation",
      requestKey,
      requestFingerprint: "b".repeat(64),
      createdAt: 1,
    });
    await seedStripeOperation(t, {
      ownerId: owners.toOwnerId,
      ownerGeneration: "destination-generation",
      operationId: "destination-operation",
      requestKey,
      requestFingerprint: "c".repeat(64),
      createdAt: 2,
    });

    await expect(t.mutation(migrateStripe, lease)).rejects.toThrow(
      /same logical billing request/u,
    );
    const source = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", "source-operation"),
        )
        .unique(),
    );
    expect(source?.ownerId).toBe(owners.fromOwnerId);
  });

  it("adopts destination customer authority for a customerless local-only receipt", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "local-only-authority-source",
      toOwnerId: "local-only-authority-destination",
    };
    const sourceGeneration = "local-only-source-generation";
    const destinationGeneration = "local-only-destination-generation";
    const destinationCustomerId = "cus_local_only_destination";
    const destinationCustomerKey = "destination-pinned-customer-key";
    await seedOwner(t, owners.fromOwnerId, sourceGeneration);
    await seedOwner(
      t,
      owners.toOwnerId,
      destinationGeneration,
      destinationCustomerId,
    );
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.toOwnerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerAuthorityEpoch: 3,
        stripeCustomerCreateIdempotencyKey: destinationCustomerKey,
        stripeCustomerTerminal: false,
      });
    });
    const requestKey = "0".repeat(64);
    const requestFingerprint = "1".repeat(64);
    await seedStripeOperation(t, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: "local-only-authority-operation",
      requestKey,
      requestFingerprint,
      createdAt: 1,
    });
    const sourceBefore = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", "local-only-authority-operation"),
        )
        .unique(),
    );
    const lease = await claim(t, owners);
    await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
      ready: true,
      pending: [],
      retryAt: null,
    });
    await expect(
      t.mutation(prepareStripeMetadataTransfer, lease),
    ).resolves.toEqual({ kind: "local_only" });
    await expect(t.mutation(migrateStripe, lease)).resolves.toEqual({
      hasMore: true,
    });

    const migrated = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", "local-only-authority-operation"),
        )
        .unique(),
    );
    expect(migrated).toMatchObject({
      ownerId: owners.toOwnerId,
      ownerGeneration: destinationGeneration,
      operationId: "local-only-authority-operation",
      idempotencyKey: sourceBefore!.idempotencyKey,
      requestKey,
      requestFingerprint,
      stripeCustomerAuthorityEpoch: 3,
      stripeCustomerCreateIdempotencyKey: destinationCustomerKey,
      stripeCustomerId: destinationCustomerId,
      stripeCustomerMetadataOwnerId: owners.toOwnerId,
    });

    await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q
            .eq("fromOwnerId", owners.fromOwnerId)
            .eq("toOwnerId", owners.toOwnerId),
        )
        .unique();
      await ctx.db.patch(migration!._id, {
        status: "complete",
        completedAt: 2_000,
        updatedAt: 2_000,
      });
    });
    await expect(
      t.mutation(reserveStripe, {
        ownerId: owners.toOwnerId,
        ownerGeneration: destinationGeneration,
        kind: "subscription_checkout",
        stripeCustomerId: destinationCustomerId,
        requestKey,
        requestFingerprint,
        now: 2_001,
      }),
    ).resolves.toMatchObject({
      operationId: "local-only-authority-operation",
      idempotencyKey: sourceBefore!.idempotencyKey,
      stripeCustomerCreateIdempotencyKey: destinationCustomerKey,
      stripeCustomerId: destinationCustomerId,
    });
  });

  it("rejects a stale-generation source receipt before provider metadata I/O", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "stale-operation-generation-source",
      toOwnerId: "stale-operation-generation-destination",
    };
    const sourceGeneration = "current-source-generation";
    const destinationGeneration = "current-destination-generation";
    await seedOwner(
      t,
      owners.fromOwnerId,
      sourceGeneration,
      "cus_stale_operation_generation",
    );
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    await seedStripeOperation(t, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: "stale-source-operation-generation",
      operationId: "stale-operation-generation-operation",
      requestKey: "4".repeat(64),
      requestFingerprint: "5".repeat(64),
      createdAt: 1,
    });
    await t.mutation(prepareMigration, owners);
    const wallNow = Date.now();
    const claimed = await t.mutation(claimMigration, {
      ...owners,
      leaseId: "stale-operation-generation-lease",
      now: wallNow,
    });
    const lease: LeaseArgs = {
      ...owners,
      leaseId: "stale-operation-generation-lease",
      leaseGeneration: claimed.leaseGeneration!,
      leaseNow: wallNow + 1,
    };
    const readState = async () =>
      await t.run(async (ctx) => ({
        operation: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", "stale-operation-generation-operation"),
          )
          .unique(),
        sourceProfile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.fromOwnerId))
          .unique(),
        destinationProfile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.toOwnerId))
          .unique(),
      }));
    const before = await readState();

    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(async () => {
      throw new Error("provider must not run");
    });
    process.env.STRIPE_SECRET_KEY = "sk_test_stale_operation_generation";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await expect(t.action(migrateStripeWithProvider, lease)).rejects.toThrow(
        /stale source owner generation/iu,
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await readState()).toEqual(before);
  });

  it("revalidates profile customer authority immediately before every metadata provider call", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "metadata-profile-race-source",
      toOwnerId: "metadata-profile-race-destination",
    };
    const sourceGeneration = "metadata-profile-race-source-generation";
    const destinationGeneration =
      "metadata-profile-race-destination-generation";
    const selectedCustomerId = "cus_metadata_profile_selected";
    await seedOwner(t, owners.fromOwnerId, sourceGeneration);
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    await seedStripeOperation(t, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: "metadata-profile-race-operation",
      requestKey: "6".repeat(64),
      requestFingerprint: "7".repeat(64),
      createdAt: 1,
    });
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", "metadata-profile-race-operation"),
        )
        .unique();
      await ctx.db.patch(operation!._id, {
        stripeCustomerId: selectedCustomerId,
        stripeCustomerMetadataOwnerId: owners.fromOwnerId,
      });
    });
    await t.mutation(prepareMigration, owners);
    const wallNow = Date.now();
    const claimed = await t.mutation(claimMigration, {
      ...owners,
      leaseId: "metadata-profile-race-lease",
      now: wallNow,
    });
    const lease: LeaseArgs = {
      ...owners,
      leaseId: "metadata-profile-race-lease",
      leaseGeneration: claimed.leaseGeneration!,
      leaseNow: wallNow + 1,
    };
    const prepared = await t.mutation(prepareStripeMetadataTransfer, lease);
    if (!prepared || prepared.kind !== "provider_transfer") {
      throw new Error("Expected a provider metadata-transfer command.");
    }
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.fromOwnerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerId: "cus_metadata_profile_late_convergence",
        stripeCustomerTerminal: false,
      });
    });
    const exactCommand = {
      ...lease,
      operationId: prepared.operationId,
      stripeCustomerId: prepared.stripeCustomerId,
      attemptId: prepared.attemptId,
      idempotencyKey: prepared.idempotencyKey,
      providerDeadlineAt: prepared.providerDeadlineAt,
    };
    const readState = async () =>
      await t.run(async (ctx) => ({
        operation: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", prepared.operationId),
          )
          .unique(),
        sourceProfile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.fromOwnerId))
          .unique(),
        destinationProfile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.toOwnerId))
          .unique(),
      }));
    const before = await readState();
    await expect(
      t.mutation(revalidateStripeMetadataTransfer, {
        ...exactCommand,
        leaseNow: wallNow + 2,
      }),
    ).rejects.toThrow(/paid billing state|conflicts with the connected/iu);

    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(async () => {
      throw new Error("provider must not run");
    });
    process.env.STRIPE_SECRET_KEY = "sk_test_metadata_profile_race";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await expect(t.action(migrateStripeWithProvider, lease)).rejects.toThrow(
        /paid billing state|conflicts with the connected/iu,
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await readState()).toEqual(before);
  });

  it("rejects a customerless receipt from a rotated source authority before provider I/O", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "rotated-source-authority-source",
      toOwnerId: "rotated-source-authority-destination",
    };
    const sourceGeneration = "rotated-source-authority-source-generation";
    const destinationGeneration =
      "rotated-source-authority-destination-generation";
    await seedOwner(
      t,
      owners.fromOwnerId,
      sourceGeneration,
      "cus_rotated_source_authority",
    );
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.fromOwnerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerAuthorityEpoch: 1,
        stripeCustomerCreateIdempotencyKey:
          "rotated-source-authority-customer-key",
      });
    });
    await seedStripeOperation(t, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: "rotated-source-authority-operation",
      requestKey: "2".repeat(64),
      requestFingerprint: "3".repeat(64),
      createdAt: 1,
    });
    await t.mutation(prepareMigration, owners);
    const wallNow = Date.now();
    const claimed = await t.mutation(claimMigration, {
      ...owners,
      leaseId: "rotated-source-authority-lease",
      now: wallNow,
    });
    const lease: LeaseArgs = {
      ...owners,
      leaseId: "rotated-source-authority-lease",
      leaseGeneration: claimed.leaseGeneration!,
      leaseNow: wallNow + 1,
    };
    const readState = async () =>
      await t.run(async (ctx) => ({
        operation: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", "rotated-source-authority-operation"),
          )
          .unique(),
        sourceProfile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.fromOwnerId))
          .unique(),
        destinationProfile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.toOwnerId))
          .unique(),
      }));
    const before = await readState();
    expect(before.operation?.stripeCustomerAuthorityEpoch ?? 0).toBe(0);
    expect(before.sourceProfile?.stripeCustomerAuthorityEpoch).toBe(1);

    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(async () => {
      throw new Error("provider must not run");
    });
    process.env.STRIPE_SECRET_KEY = "sk_test_rotated_source_authority";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await expect(t.action(migrateStripeWithProvider, lease)).rejects.toThrow(
        /rotated source customer authority/iu,
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await readState()).toEqual(before);
  });

  it.each(["absent", "empty"] as const)(
    "routes the oldest customerless receipt through the source-profile customer when destination profile is %s",
    async (destinationProfileState) => {
      const t = createTest();
      const owners = {
        fromOwnerId: `effective-customer-source-${destinationProfileState}`,
        toOwnerId: `effective-customer-destination-${destinationProfileState}`,
      };
      const sourceGeneration = `effective-source-generation-${destinationProfileState}`;
      const destinationGeneration = `effective-destination-generation-${destinationProfileState}`;
      const stripeCustomerId = `cus_effective_${destinationProfileState}`;
      await seedOwner(
        t,
        owners.fromOwnerId,
        sourceGeneration,
        stripeCustomerId,
      );
      await seedOwner(t, owners.toOwnerId, destinationGeneration);
      if (destinationProfileState === "absent") {
        await t.run(async (ctx) => {
          const destinationProfile = await ctx.db
            .query("billing_profiles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.toOwnerId))
            .unique();
          await ctx.db.delete(destinationProfile!._id);
        });
      }
      const oldestRequestKey =
        destinationProfileState === "absent" ? "6".repeat(64) : "7".repeat(64);
      const oldestFingerprint =
        destinationProfileState === "absent" ? "8".repeat(64) : "9".repeat(64);
      await seedStripeOperation(t, {
        ownerId: owners.fromOwnerId,
        ownerGeneration: sourceGeneration,
        operationId: `effective-oldest-${destinationProfileState}`,
        requestKey: oldestRequestKey,
        requestFingerprint: oldestFingerprint,
        createdAt: 1,
      });
      await seedStripeOperation(t, {
        ownerId: owners.fromOwnerId,
        ownerGeneration: sourceGeneration,
        operationId: `effective-later-${destinationProfileState}`,
        requestKey:
          destinationProfileState === "absent"
            ? "a".repeat(64)
            : "b".repeat(64),
        requestFingerprint:
          destinationProfileState === "absent"
            ? "c".repeat(64)
            : "d".repeat(64),
        createdAt: 2,
      });
      await t.run(async (ctx) => {
        const later = await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", `effective-later-${destinationProfileState}`),
          )
          .unique();
        await ctx.db.patch(later!._id, {
          stripeCustomerId,
          stripeCustomerMetadataOwnerId: owners.fromOwnerId,
        });
      });

      await t.mutation(prepareMigration, owners);
      const wallNow = Date.now();
      const claimed = await t.mutation(claimMigration, {
        ...owners,
        leaseId: `effective-customer-lease-${destinationProfileState}`,
        now: wallNow,
      });
      const lease: LeaseArgs = {
        ...owners,
        leaseId: `effective-customer-lease-${destinationProfileState}`,
        leaseGeneration: claimed.leaseGeneration!,
        leaseNow: wallNow + 1,
      };
      await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
        ready: true,
        pending: [],
        retryAt: null,
      });

      const previousSecret = process.env.STRIPE_SECRET_KEY;
      const previousFetch = globalThis.fetch;
      let providerOwnerId = owners.fromOwnerId;
      const providerFetch = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          if ((init?.method ?? "GET").toUpperCase() === "POST") {
            providerOwnerId = owners.toOwnerId;
          }
          return new Response(
            JSON.stringify({
              id: stripeCustomerId,
              object: "customer",
              deleted: false,
              metadata: { ownerId: providerOwnerId },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "request-id": `req_effective_${destinationProfileState}`,
              },
            },
          );
        },
      );
      process.env.STRIPE_SECRET_KEY = `sk_test_effective_${destinationProfileState}`;
      globalThis.fetch = providerFetch as typeof fetch;
      try {
        await expect(
          t.action(migrateStripeWithProvider, lease),
        ).resolves.toEqual({ hasMore: true });
        await expect(
          t.action(migrateStripeWithProvider, lease),
        ).resolves.toEqual({ hasMore: true });
        await expect(
          t.action(migrateStripeWithProvider, lease),
        ).resolves.toEqual({ hasMore: false });
      } finally {
        globalThis.fetch = previousFetch;
        if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = previousSecret;
      }

      const migrated = await t.run(async (ctx) => ({
        oldest: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", `effective-oldest-${destinationProfileState}`),
          )
          .unique(),
        later: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", `effective-later-${destinationProfileState}`),
          )
          .unique(),
        destinationProfile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.toOwnerId))
          .unique(),
        migration: await ctx.db
          .query("auth_owner_migrations")
          .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
            q
              .eq("fromOwnerId", owners.fromOwnerId)
              .eq("toOwnerId", owners.toOwnerId),
          )
          .unique(),
      }));
      expect(migrated.oldest).toMatchObject({
        ownerId: owners.toOwnerId,
        ownerGeneration: destinationGeneration,
        stripeCustomerId,
        stripeCustomerMetadataOwnerId: owners.toOwnerId,
      });
      expect(migrated.later).toMatchObject({
        ownerId: owners.toOwnerId,
        stripeCustomerId,
        stripeCustomerMetadataOwnerId: owners.toOwnerId,
      });
      expect(migrated.destinationProfile?.stripeCustomerId).toBe(
        stripeCustomerId,
      );
      await t.run(async (ctx) => {
        await ctx.db.patch(migrated.migration!._id, {
          status: "complete",
          leaseId: undefined,
          leaseExpiresAt: undefined,
          watchdogId: undefined,
          completedAt: wallNow + 10,
          updatedAt: wallNow + 10,
        });
      });
      const replay = await t.mutation(reserveStripe, {
        ownerId: owners.toOwnerId,
        ownerGeneration: destinationGeneration,
        kind: "subscription_checkout",
        stripeCustomerId,
        requestKey: oldestRequestKey,
        requestFingerprint: oldestFingerprint,
        now: wallNow + 11,
      });
      expect(replay.operationId).toBe(
        `effective-oldest-${destinationProfileState}`,
      );
      await expect(
        t.mutation(markStripe, {
          ownerId: owners.toOwnerId,
          ownerGeneration: destinationGeneration,
          operationId: replay.operationId,
          attemptId: `effective-checkout-${destinationProfileState}`,
          step: "checkout_create",
          requestJson: JSON.stringify({ customer: stripeCustomerId }),
          now: wallNow + 12,
        }),
      ).resolves.toMatchObject({
        replayed: false,
        attemptId: `effective-checkout-${destinationProfileState}`,
      });
    },
  );

  it("retains the legacy fingerprint collision fallback only for keyless rows", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "legacy-collision-source",
      toOwnerId: "legacy-collision-destination",
    };
    await seedOwner(t, owners.fromOwnerId, "source-generation");
    await seedOwner(t, owners.toOwnerId, "destination-generation");
    const lease = await claim(t, owners);
    const fingerprint = "d".repeat(64);
    await seedStripeOperation(t, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: "source-generation",
      operationId: "legacy-source-operation",
      requestFingerprint: fingerprint,
      createdAt: 1,
    });
    await seedStripeOperation(t, {
      ownerId: owners.toOwnerId,
      ownerGeneration: "destination-generation",
      operationId: "legacy-destination-operation",
      requestFingerprint: fingerprint,
      createdAt: 2,
    });
    await expect(t.mutation(migrateStripe, lease)).rejects.toThrow(
      /same logical billing request/u,
    );
  });

  it("fails migration closed on every malformed historical-result shape", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "historical-shape-source",
      toOwnerId: "historical-shape-destination",
    };
    await seedOwner(t, owners.fromOwnerId, "source-generation");
    await seedOwner(t, owners.toOwnerId, "destination-generation");
    const operationId = "historical-shape-operation";
    await seedStripeOperation(t, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: "source-generation",
      operationId,
      requestKey: "3".repeat(64),
      requestFingerprint: "4".repeat(64),
      createdAt: 1,
    });
    const lease = await claim(t, owners);
    const patchOperation = async (
      patch: Record<string, string | number | undefined>,
    ) => {
      await t.run(async (ctx) => {
        const operation = await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique();
        await ctx.db.patch(operation!._id, patch);
      });
    };
    await patchOperation({ lastStripeDisposition: "succeeded" });
    await expect(t.mutation(migrateStripe, lease)).rejects.toThrow(
      /malformed physical receipt history/u,
    );
    await patchOperation({
      lastStripeDisposition: undefined,
      lastStripeReconcileClaimId: "historical-migration-claim",
    });
    await expect(t.mutation(migrateStripe, lease)).rejects.toThrow(
      /malformed physical receipt history/u,
    );
    await patchOperation({
      lastStripeReconcileClaimId: undefined,
      lastStripeStep: "customer_create",
      lastStripeAttemptId: "historical-migration-attempt",
      lastStripeRequestFingerprint: "5".repeat(64),
      lastStripeIdempotencyKey: "historical-migration-key",
      lastStripeProviderDeadlineAt: 2_000,
    });
    await expect(t.mutation(migrateStripe, lease)).rejects.toThrow(
      /malformed physical receipt history/u,
    );
    await patchOperation({
      lastStripeDisposition: "not_created",
      lastStripeReconcileClaimId: "historical-migration-valid-claim",
    });
    await expect(t.mutation(migrateStripe, lease)).resolves.toEqual({
      hasMore: true,
    });
    const snapshot = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      receipts: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .collect(),
    }));
    expect(snapshot.operation?.ownerId).toBe(owners.toOwnerId);
    expect(snapshot.receipts).toHaveLength(1);
  });

  it("atomically adopts a recovered customer and replays the original request and keys", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "recovered-customer-source",
      toOwnerId: "recovered-customer-destination",
    };
    const sourceGeneration = "source-generation";
    const destinationGeneration = "destination-generation";
    await seedOwner(t, owners.fromOwnerId, sourceGeneration);
    await seedOwner(t, owners.toOwnerId, destinationGeneration);
    const requestKey = "e".repeat(64);
    const requestFingerprint = "f".repeat(64);
    const operation = await t.mutation(reserveStripe, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
      kind: "subscription_checkout",
      requestKey,
      requestFingerprint,
      now: 100,
    });
    const marked = await t.mutation(markStripe, {
      ownerId: owners.fromOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: operation.operationId,
      attemptId: "lost-response-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({
        metadata: {
          ownerId: owners.fromOwnerId,
          stellaCustomerAuthorityId:
            operation.stripeCustomerCreateIdempotencyKey,
        },
      }),
      now: 101,
    });
    await expect(
      t.mutation(settleStripe, {
        ownerId: owners.fromOwnerId,
        ownerGeneration: sourceGeneration,
        operationId: operation.operationId,
        attemptId: marked.attemptId,
        step: "customer_create",
        requestFingerprint: marked.requestFingerprint,
        idempotencyKey: marked.idempotencyKey,
        providerDeadlineAt: marked.providerDeadlineAt,
        stripeCustomerId: "cus_recovered",
        now: 102,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });

    const convergedSource = await t.run(async (ctx) =>
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.fromOwnerId))
        .unique(),
    );
    expect(convergedSource?.stripeCustomerId).toBe("cus_recovered");

    const lease = await claim(t, owners);
    await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
      ready: true,
      pending: [],
      retryAt: null,
    });
    const transfer = await t.mutation(prepareStripeMetadataTransfer, lease);
    expect(transfer).toMatchObject({
      kind: "provider_transfer",
      operationId: operation.operationId,
      stripeCustomerId: "cus_recovered",
    });
    if (!transfer || transfer.kind !== "provider_transfer") {
      throw new Error("Expected provider-aware Stripe metadata transfer.");
    }
    await expect(
      t.mutation(commitStripeMetadataTransfer, {
        ...lease,
        operationId: transfer.operationId,
        stripeCustomerId: transfer.stripeCustomerId,
        attemptId: transfer.attemptId,
        idempotencyKey: transfer.idempotencyKey,
        providerDeadlineAt: transfer.providerDeadlineAt,
        providerOwnerId: owners.toOwnerId,
      }),
    ).resolves.toBe(true);
    await expect(t.mutation(migrateStripe, lease)).resolves.toEqual({
      hasMore: false,
    });

    const adopted = await t.run(async (ctx) => ({
      sourceProfile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.fromOwnerId))
        .unique(),
      destinationProfile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", owners.toOwnerId))
        .unique(),
      receipt: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
    }));
    expect(adopted.sourceProfile?.stripeCustomerId).toBe("");
    expect(adopted.destinationProfile?.stripeCustomerId).toBe("cus_recovered");
    const migratedCustomerKey =
      adopted.receipt!.stripeCustomerCreateIdempotencyKey;
    expect(migratedCustomerKey).toMatch(/^stella-billing-customer-v3-/u);
    expect(adopted.receipt).toMatchObject({
      ownerId: owners.toOwnerId,
      ownerGeneration: destinationGeneration,
      requestKey,
      requestFingerprint,
      idempotencyKey: operation.idempotencyKey,
      stripeCustomerCreateIdempotencyKey: migratedCustomerKey,
      stripeCustomerId: "cus_recovered",
    });

    await expect(t.mutation(migrateUsage, lease)).resolves.toEqual({
      hasMore: true,
    });
    await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q
            .eq("fromOwnerId", owners.fromOwnerId)
            .eq("toOwnerId", owners.toOwnerId),
        )
        .unique();
      await ctx.db.patch(migration!._id, {
        status: "complete",
        completedAt: 2_000,
        updatedAt: 2_000,
      });
    });

    const replay = await t.mutation(reserveStripe, {
      ownerId: owners.toOwnerId,
      ownerGeneration: destinationGeneration,
      kind: "subscription_checkout",
      stripeCustomerId: "cus_recovered",
      requestKey,
      requestFingerprint,
      now: 2_001,
    });
    expect(replay).toMatchObject({
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      stripeCustomerCreateIdempotencyKey: migratedCustomerKey,
      stripeCustomerId: "cus_recovered",
    });

    const next = await t.mutation(reserveStripe, {
      ownerId: owners.toOwnerId,
      ownerGeneration: destinationGeneration,
      kind: "subscription_checkout",
      stripeCustomerId: "cus_recovered",
      requestKey: "1".repeat(64),
      requestFingerprint: "2".repeat(64),
      now: 2_002,
    });
    expect(next.stripeCustomerId).toBe("cus_recovered");
    const snapshot = await t.run(async (ctx) => ({
      logicalRows: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_kind_and_requestKey", (q) =>
          q
            .eq("ownerId", owners.toOwnerId)
            .eq("kind", "subscription_checkout")
            .eq("requestKey", requestKey),
        )
        .take(2),
      customerProfiles: await ctx.db
        .query("billing_profiles")
        .withIndex("by_stripeCustomerId", (q) =>
          q.eq("stripeCustomerId", "cus_recovered"),
        )
        .take(2),
    }));
    expect(snapshot.logicalRows).toHaveLength(1);
    expect(snapshot.customerProfiles).toHaveLength(1);
    expect(snapshot.customerProfiles[0]?.ownerId).toBe(owners.toOwnerId);
  });

  it("flattens inherited Stripe owner aliases across sequential metadata transfers", async () => {
    const t = createTest();
    const sourceOwnerId = "multi-hop-alias-source";
    const destinationOwnerId = "multi-hop-alias-destination";
    const finalOwnerId = "multi-hop-alias-final";
    const sourceGeneration = "multi-hop-alias-source-generation";
    const destinationGeneration = "multi-hop-alias-destination-generation";
    const finalGeneration = "multi-hop-alias-final-generation";
    const stripeCustomerId = "cus_multi_hop_alias";
    await seedOwner(t, sourceOwnerId, sourceGeneration);
    await seedOwner(t, destinationOwnerId, destinationGeneration);
    await seedOwner(t, finalOwnerId, finalGeneration);

    const operation = await t.mutation(reserveStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      kind: "subscription_checkout",
      requestKey: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      now: 100,
    });
    const marked = await t.mutation(markStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: operation.operationId,
      attemptId: "multi-hop-alias-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({
        metadata: {
          ownerId: sourceOwnerId,
          stellaCustomerAuthorityId:
            operation.stripeCustomerCreateIdempotencyKey,
        },
      }),
      now: 101,
    });
    await expect(
      t.mutation(settleStripe, {
        ownerId: sourceOwnerId,
        ownerGeneration: sourceGeneration,
        operationId: operation.operationId,
        attemptId: marked.attemptId,
        step: "customer_create",
        requestFingerprint: marked.requestFingerprint,
        idempotencyKey: marked.idempotencyKey,
        providerDeadlineAt: marked.providerDeadlineAt,
        stripeCustomerId,
        now: 102,
      }),
    ).resolves.toMatchObject({ recorded: true, duplicate: false });

    const migrateOneHop = async (owners: OwnerArgs) => {
      const lease = await claim(t, owners);
      await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
        ready: true,
        pending: [],
        retryAt: null,
      });
      const transfer = await t.mutation(prepareStripeMetadataTransfer, lease);
      expect(transfer).toMatchObject({
        kind: "provider_transfer",
        operationId: operation.operationId,
        stripeCustomerId,
      });
      if (!transfer || transfer.kind !== "provider_transfer") {
        throw new Error("Expected a provider-aware Stripe metadata transfer.");
      }
      await expect(
        t.mutation(commitStripeMetadataTransfer, {
          ...lease,
          operationId: transfer.operationId,
          stripeCustomerId: transfer.stripeCustomerId,
          attemptId: transfer.attemptId,
          idempotencyKey: transfer.idempotencyKey,
          providerDeadlineAt: transfer.providerDeadlineAt,
          providerOwnerId: owners.toOwnerId,
        }),
      ).resolves.toBe(true);
    };

    await migrateOneHop({
      fromOwnerId: sourceOwnerId,
      toOwnerId: destinationOwnerId,
    });
    await migrateOneHop({
      fromOwnerId: destinationOwnerId,
      toOwnerId: finalOwnerId,
    });

    const [sourceOwnerHash, destinationOwnerHash, finalOwnerHash] =
      await Promise.all([
        ownershipMigrationSourceDigest(sourceOwnerId),
        ownershipMigrationSourceDigest(destinationOwnerId),
        ownershipMigrationSourceDigest(finalOwnerId),
      ]);
    const snapshot = await t.run(async (ctx) => ({
      aliases: await ctx.db.query("billing_stripe_owner_aliases").collect(),
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
      finalProfile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", finalOwnerId))
        .unique(),
    }));
    expect(
      snapshot.aliases.map(({ sourceOwnerHash, destinationOwnerHash }) => ({
        sourceOwnerHash,
        destinationOwnerHash,
      })),
    ).toEqual(
      expect.arrayContaining([
        { sourceOwnerHash, destinationOwnerHash },
        {
          sourceOwnerHash: destinationOwnerHash,
          destinationOwnerHash: finalOwnerHash,
        },
        { sourceOwnerHash, destinationOwnerHash: finalOwnerHash },
      ]),
    );
    expect(snapshot.aliases).toHaveLength(3);
    expect(snapshot.operation).toMatchObject({
      ownerId: finalOwnerId,
      ownerGeneration: finalGeneration,
      stripeCustomerId,
      stripeCustomerMetadataOwnerId: finalOwnerId,
    });
    expect(snapshot.finalProfile?.stripeCustomerId).toBe(stripeCustomerId);
  });

  it("moves an attached retained-resource deletion fence with its Stripe operation", async () => {
    const t = createTest();
    const sourceOwnerId = "retained-proof-source";
    const destinationOwnerId = "retained-proof-destination";
    const sourceGeneration = "retained-proof-source-generation";
    const destinationGeneration = "retained-proof-destination-generation";
    const stripeCustomerId = "cus_retained_proof_migration";
    await seedOwner(t, sourceOwnerId, sourceGeneration);
    await seedOwner(t, destinationOwnerId, destinationGeneration);
    const operation = await t.mutation(reserveStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      kind: "subscription_checkout",
      requestKey: "e".repeat(64),
      requestFingerprint: "f".repeat(64),
      now: 300,
    });
    const marked = await t.mutation(markStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: operation.operationId,
      attemptId: "retained-proof-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({
        metadata: {
          ownerId: sourceOwnerId,
          stellaCustomerAuthorityId:
            operation.stripeCustomerCreateIdempotencyKey,
        },
      }),
      now: 301,
    });
    await t.mutation(settleStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: operation.operationId,
      attemptId: marked.attemptId,
      step: "customer_create",
      requestFingerprint: marked.requestFingerprint,
      idempotencyKey: marked.idempotencyKey,
      providerDeadlineAt: marked.providerDeadlineAt,
      stripeCustomerId,
      now: 302,
    });
    const [sourceOwnerHash, destinationOwnerHash, locatorHash] =
      await Promise.all([
        ownershipMigrationSourceDigest(sourceOwnerId),
        ownershipMigrationSourceDigest(destinationOwnerId),
        hashStripeBillingLocator("customer", stripeCustomerId),
      ]);
    const locatorSetHash = await hashStripeRetainedLocatorSet([
      { locatorKind: "customer", locatorHash, ownerHash: sourceOwnerHash },
    ]);
    const receipt = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
    );
    const resolutionId = `retained-fence-${receipt!.tupleHash}`;
    const [systemResolverHash, systemEvidenceHash] = await Promise.all([
      stripeResolutionAuditHash("operator", "system-retained-locator-fence"),
      stripeResolutionAuditHash(
        "evidence",
        `inherited-locator-set:${locatorSetHash}`,
      ),
    ]);
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_late_cleanup_resolutions", {
        tupleHash: receipt!.tupleHash,
        successLocatorHash: receipt!.successLocatorHash!,
        resolutionId,
        resolution: "provider_resource_retained",
        locatorCount: 1,
        locatorSetHash,
        resolvedByHash: systemResolverHash,
        evidenceHash: systemEvidenceHash,
        resolvedAt: 303,
      });
      await ctx.db.insert("billing_stripe_retained_locators", {
        tupleHash: receipt!.tupleHash,
        locatorHash,
        ownerHash: sourceOwnerHash,
        locatorKind: "customer",
        resolutionId,
        createdAt: 303,
      });
      await ctx.db.patch(receipt!._id, { cleanupResolutionId: resolutionId });
    });

    const lease = await claim(t, {
      fromOwnerId: sourceOwnerId,
      toOwnerId: destinationOwnerId,
    });
    await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
      ready: true,
      pending: [],
      retryAt: null,
    });
    const transfer = await t.mutation(prepareStripeMetadataTransfer, lease);
    if (!transfer || transfer.kind !== "provider_transfer") {
      throw new Error("Expected a provider-aware Stripe metadata transfer.");
    }
    const destinationCleanupTupleHash = "9".repeat(64);
    const destinationCleanupClaimId = "destination-cleanup-claim";
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_late_cleanup_locators", {
        tupleHash: destinationCleanupTupleHash,
        ownerHash: destinationOwnerHash,
        providerOwnerHash: destinationOwnerHash,
        successLocatorHash: "8".repeat(64),
        locatorHash,
        locatorKind: "customer",
        locatorValue: stripeCustomerId,
        successStripeCustomerId: stripeCustomerId,
        checkoutBlocked: false,
        cleanupClaimId: destinationCleanupClaimId,
        cleanupClaimExpiresAt: 10_000,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 304,
        updatedAt: 304,
      });
    });
    await expect(
      t.mutation(commitStripeMetadataTransfer, {
        ...lease,
        operationId: transfer.operationId,
        stripeCustomerId: transfer.stripeCustomerId,
        attemptId: transfer.attemptId,
        idempotencyKey: transfer.idempotencyKey,
        providerDeadlineAt: transfer.providerDeadlineAt,
        providerOwnerId: destinationOwnerId,
      }),
    ).rejects.toThrow(/destination Stripe deletion claim/iu);
    await expect(
      t.run(async (ctx) => {
        const marker = await ctx.db
          .query("billing_stripe_retained_locators")
          .withIndex("by_resolutionId", (q) =>
            q.eq("resolutionId", resolutionId),
          )
          .unique();
        return marker?.ownerHash;
      }),
    ).resolves.toBe(sourceOwnerHash);
    await t.run(async (ctx) => {
      const destinationCleanup = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", destinationCleanupTupleHash)
            .eq("locatorHash", locatorHash),
        )
        .unique();
      await ctx.db.delete(destinationCleanup!._id);
      await ctx.db.insert("billing_owner_deletion_locators", {
        ownerId: destinationOwnerId,
        operationId: "destination-owner-deletion",
        generation: "destination-owner-deletion-generation",
        locatorHash,
        locatorKind: "customer",
        locatorValue: stripeCustomerId,
        ownerVerified: true,
        state: "pending",
        eventsDrained: true,
        attempts: 0,
        providerClaimId: "destination-owner-deletion-claim",
        providerClaimExpiresAt: 10_000,
        createdAt: 305,
        updatedAt: 305,
      });
    });
    await expect(
      t.mutation(commitStripeMetadataTransfer, {
        ...lease,
        operationId: transfer.operationId,
        stripeCustomerId: transfer.stripeCustomerId,
        attemptId: transfer.attemptId,
        idempotencyKey: transfer.idempotencyKey,
        providerDeadlineAt: transfer.providerDeadlineAt,
        providerOwnerId: destinationOwnerId,
      }),
    ).rejects.toThrow(/destination Stripe deletion claim/iu);
    await t.run(async (ctx) => {
      const destinationDeletion = await ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_locatorHash", (q) =>
          q.eq("ownerId", destinationOwnerId).eq("locatorHash", locatorHash),
        )
        .unique();
      await ctx.db.patch(destinationDeletion!._id, {
        providerClaimId: undefined,
        providerClaimExpiresAt: undefined,
      });
    });
    await expect(
      t.mutation(commitStripeMetadataTransfer, {
        ...lease,
        operationId: transfer.operationId,
        stripeCustomerId: transfer.stripeCustomerId,
        attemptId: transfer.attemptId,
        idempotencyKey: transfer.idempotencyKey,
        providerDeadlineAt: transfer.providerDeadlineAt,
        providerOwnerId: destinationOwnerId,
      }),
    ).resolves.toBe(true);
    const snapshot = await t.run(async (ctx) => ({
      marker: await ctx.db
        .query("billing_stripe_retained_locators")
        .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
        .unique(),
      resolution: await ctx.db
        .query("billing_stripe_late_cleanup_resolutions")
        .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
        .unique(),
    }));
    expect(snapshot.marker?.ownerHash).toBe(destinationOwnerHash);
    await expect(
      hashStripeRetainedLocatorSet([snapshot.marker!]),
    ).resolves.toBe(snapshot.resolution?.locatorSetHash);
    await expect(
      stripeResolutionAuditHash(
        "evidence",
        `inherited-locator-set:${snapshot.resolution?.locatorSetHash}`,
      ),
    ).resolves.toBe(snapshot.resolution?.evidenceHash);
    await expect(
      t.query(
        internal.account_billing_purge.hasRetainedStripeDeletionLocatorInternal,
        {
          ownerId: sourceOwnerId,
          locatorHash,
          locatorKind: "customer",
        },
      ),
    ).resolves.toBe(false);
    await expect(
      t.query(
        internal.account_billing_purge.hasRetainedStripeDeletionLocatorInternal,
        {
          ownerId: destinationOwnerId,
          locatorHash,
          locatorKind: "customer",
        },
      ),
    ).resolves.toBe(true);
  });

  it("moves cleanup debt that arrives after Stripe metadata transfer preparation", async () => {
    const t = createTest();
    const sourceOwnerId = "late-cleanup-source";
    const destinationOwnerId = "late-cleanup-destination";
    const sourceGeneration = "late-cleanup-source-generation";
    const destinationGeneration = "late-cleanup-destination-generation";
    const stripeCustomerId = "cus_late_cleanup_migration";
    await seedOwner(t, sourceOwnerId, sourceGeneration);
    await seedOwner(t, destinationOwnerId, destinationGeneration);
    const operation = await t.mutation(reserveStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      kind: "subscription_checkout",
      requestKey: "7".repeat(64),
      requestFingerprint: "8".repeat(64),
      now: 400,
    });
    const marked = await t.mutation(markStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: operation.operationId,
      attemptId: "late-cleanup-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({
        metadata: {
          ownerId: sourceOwnerId,
          stellaCustomerAuthorityId:
            operation.stripeCustomerCreateIdempotencyKey,
        },
      }),
      now: 401,
    });
    await t.mutation(settleStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: operation.operationId,
      attemptId: marked.attemptId,
      step: "customer_create",
      requestFingerprint: marked.requestFingerprint,
      idempotencyKey: marked.idempotencyKey,
      providerDeadlineAt: marked.providerDeadlineAt,
      stripeCustomerId,
      now: 402,
    });
    const lease = await claim(t, {
      fromOwnerId: sourceOwnerId,
      toOwnerId: destinationOwnerId,
    });
    await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
      ready: true,
      pending: [],
      retryAt: null,
    });
    const transfer = await t.mutation(prepareStripeMetadataTransfer, lease);
    if (!transfer || transfer.kind !== "provider_transfer") {
      throw new Error("Expected a provider-aware Stripe metadata transfer.");
    }
    const [sourceOwnerHash, destinationOwnerHash, locatorHash] =
      await Promise.all([
        ownershipMigrationSourceDigest(sourceOwnerId),
        ownershipMigrationSourceDigest(destinationOwnerId),
        hashStripeBillingLocator("customer", stripeCustomerId),
      ]);
    await t.run(async (ctx) => {
      const receipt = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      await ctx.db.insert("billing_stripe_late_cleanup_locators", {
        tupleHash: receipt!.tupleHash,
        ownerHash: sourceOwnerHash,
        providerOwnerHash: sourceOwnerHash,
        successLocatorHash: receipt!.successLocatorHash!,
        locatorHash,
        locatorKind: "customer",
        locatorValue: stripeCustomerId,
        successStripeCustomerId: stripeCustomerId,
        checkoutBlocked: false,
        attempts: 0,
        nextAttemptAt: 403,
        createdAt: 403,
        updatedAt: 403,
      });
    });
    await expect(
      t.mutation(commitStripeMetadataTransfer, {
        ...lease,
        operationId: transfer.operationId,
        stripeCustomerId: transfer.stripeCustomerId,
        attemptId: transfer.attemptId,
        idempotencyKey: transfer.idempotencyKey,
        providerDeadlineAt: transfer.providerDeadlineAt,
        providerOwnerId: destinationOwnerId,
      }),
    ).resolves.toBe(true);
    const cleanup = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_ownerHash_and_locatorHash", (q) =>
          q
            .eq("ownerHash", destinationOwnerHash)
            .eq("locatorHash", locatorHash),
        )
        .unique(),
    );
    expect(cleanup).toMatchObject({
      ownerHash: destinationOwnerHash,
      providerOwnerHash: sourceOwnerHash,
      locatorValue: stripeCustomerId,
    });
    await expect(
      t.query(authorizeLateStripeCleanupProviderOwner, {
        providerOwnerHash: sourceOwnerHash,
        cleanupOwnerHash: destinationOwnerHash,
        providerOwnerId: destinationOwnerId,
      }),
    ).resolves.toBe(true);
  });

  it("fails a Stripe metadata transfer closed on duplicate inherited aliases", async () => {
    const t = createTest();
    const inheritedSourceOwnerId = "duplicate-alias-inherited-source";
    const sourceOwnerId = "duplicate-alias-source";
    const destinationOwnerId = "duplicate-alias-destination";
    const sourceGeneration = "duplicate-alias-source-generation";
    const destinationGeneration = "duplicate-alias-destination-generation";
    const stripeCustomerId = "cus_duplicate_inherited_alias";
    await seedOwner(t, sourceOwnerId, sourceGeneration);
    await seedOwner(t, destinationOwnerId, destinationGeneration);

    const operation = await t.mutation(reserveStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      kind: "subscription_checkout",
      requestKey: "c".repeat(64),
      requestFingerprint: "d".repeat(64),
      now: 200,
    });
    const marked = await t.mutation(markStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: operation.operationId,
      attemptId: "duplicate-alias-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({
        metadata: {
          ownerId: sourceOwnerId,
          stellaCustomerAuthorityId:
            operation.stripeCustomerCreateIdempotencyKey,
        },
      }),
      now: 201,
    });
    await t.mutation(settleStripe, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      operationId: operation.operationId,
      attemptId: marked.attemptId,
      step: "customer_create",
      requestFingerprint: marked.requestFingerprint,
      idempotencyKey: marked.idempotencyKey,
      providerDeadlineAt: marked.providerDeadlineAt,
      stripeCustomerId,
      now: 202,
    });

    const [inheritedSourceOwnerHash, sourceOwnerHash, destinationOwnerHash] =
      await Promise.all([
        ownershipMigrationSourceDigest(inheritedSourceOwnerId),
        ownershipMigrationSourceDigest(sourceOwnerId),
        ownershipMigrationSourceDigest(destinationOwnerId),
      ]);
    await t.run(async (ctx) => {
      for (const createdAt of [1, 2]) {
        await ctx.db.insert("billing_stripe_owner_aliases", {
          sourceOwnerHash: inheritedSourceOwnerHash,
          destinationOwnerHash: sourceOwnerHash,
          createdAt,
        });
      }
    });

    const lease = await claim(t, {
      fromOwnerId: sourceOwnerId,
      toOwnerId: destinationOwnerId,
    });
    await expect(t.mutation(quiesceMigrationStripe, lease)).resolves.toEqual({
      ready: true,
      pending: [],
      retryAt: null,
    });
    const transfer = await t.mutation(prepareStripeMetadataTransfer, lease);
    if (!transfer || transfer.kind !== "provider_transfer") {
      throw new Error("Expected a provider-aware Stripe metadata transfer.");
    }
    await expect(
      t.mutation(commitStripeMetadataTransfer, {
        ...lease,
        operationId: transfer.operationId,
        stripeCustomerId: transfer.stripeCustomerId,
        attemptId: transfer.attemptId,
        idempotencyKey: transfer.idempotencyKey,
        providerDeadlineAt: transfer.providerDeadlineAt,
        providerOwnerId: destinationOwnerId,
      }),
    ).rejects.toThrow(/Duplicate Stripe event ownership aliases/u);

    const snapshot = await t.run(async (ctx) => ({
      aliases: await ctx.db.query("billing_stripe_owner_aliases").collect(),
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
      sourceProfile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", sourceOwnerId))
        .unique(),
      destinationProfile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", destinationOwnerId))
        .unique(),
    }));
    expect(snapshot.aliases).toHaveLength(2);
    expect(
      snapshot.aliases.some(
        (alias) =>
          alias.destinationOwnerHash === destinationOwnerHash ||
          (alias.sourceOwnerHash === sourceOwnerHash &&
            alias.destinationOwnerHash === destinationOwnerHash),
      ),
    ).toBe(false);
    expect(snapshot.operation).toMatchObject({
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      stripeCustomerId,
    });
    expect(snapshot.sourceProfile?.stripeCustomerId).toBe(stripeCustomerId);
    expect(snapshot.destinationProfile?.stripeCustomerId).toBe("");
  });
});
