/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { assertFreshStripeProviderDispatch } from "./billing";
import {
  discoverUniqueStripeCheckoutSession,
  stripeResolutionAuditHash,
} from "./stripe_operation_dispatch";
import {
  hashStripeBillingLocator,
  hashStripePhysicalSuccessLocators,
} from "./lib/billing_deletion";
import { ownershipMigrationSourceDigest } from "./lib/auth_migration_paths";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js"]);
const createTest = () => convexTest(schema, modules);
type Harness = ReturnType<typeof createTest>;
type StripeStep = "customer_create" | "checkout_create" | "portal_create";
type ManualDebtReason =
  | "portal_lookup_unavailable"
  | "customer_lookup_unavailable"
  | "customer_authority_revoked"
  | "customer_duplicate"
  | "customer_scan_horizon"
  | "checkout_lookup_unavailable"
  | "checkout_duplicate"
  | "checkout_scan_horizon"
  | "legacy_missing_receipt"
  | "late_result_conflict";

type MarkResult = {
  attemptId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  providerDeadlineAt: number;
  quiescentAfterAt: number;
  replayed: boolean;
};

type SettleResult = {
  recorded: boolean;
  duplicate: boolean;
  customerDeleted: boolean;
};

const markStripeOperation = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    step: StripeStep;
    requestJson: string;
    now: number;
  },
  MarkResult
>("stripe_operation_dispatch:markStripeOperationDispatchInternal");

const revalidateInitialProviderCall = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    step: StripeStep;
    requestFingerprint: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    now: number;
  },
  { providerCallDeadlineAt: number } | null
>("stripe_operation_dispatch:revalidateStripeInitialProviderCallInternal");

const settleStripeOperation = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    step: StripeStep;
    requestFingerprint: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    reconcileClaimId?: string;
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
    now: number;
  },
  SettleResult
>("stripe_operation_dispatch:settleStripeOperationDispatchInternal");

const settleStripeOperationNotCreated = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    step: StripeStep;
    requestFingerprint: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    reconcileClaimId?: string;
    now: number;
  },
  SettleResult
>("stripe_operation_dispatch:settleStripeOperationNotCreatedInternal");

const resolveStripeManualDebt = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    resolutionId: string;
    expectedStep: StripeStep;
    expectedAttemptId?: string;
    resolution:
      | { kind: "recovered_customer"; stripeCustomerId: string }
      | {
          kind: "recovered_checkout";
          stripeCustomerId: string;
          stripeCheckoutSessionId: string;
        }
      | {
          kind: "recovered_portal";
          stripeCustomerId: string;
          stripePortalSessionId: string;
        }
      | { kind: "provider_confirmed_not_created" };
    resolvedBy: string;
    evidence: string;
    now: number;
  },
  {
    resolution:
      | "recovered_customer"
      | "recovered_checkout"
      | "recovered_portal"
      | "provider_confirmed_not_created";
    replayed: boolean;
  }
>("stripe_operation_dispatch:resolveStripeOperationManualDebtInternal");

const claimReconcileCommand = makeFunctionReference<
  "mutation",
  {
    operationId: string;
    attemptId: string;
    claimId: string;
    now: number;
  },
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    step: StripeStep;
    requestJson: string;
    requestFingerprint: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    reconcileProviderDeadlineAt: number;
  } | null
>("stripe_operation_dispatch:claimStripeOperationReconcileCommandInternal");

const revalidateReconcileProviderCall = makeFunctionReference<
  "mutation",
  {
    operationId: string;
    attemptId: string;
    claimId: string;
    allowRevokedCustomerAuthority: boolean;
    now: number;
  },
  { providerCallDeadlineAt: number; customerAuthorityCurrent: boolean } | null
>("stripe_operation_dispatch:revalidateStripeReconcileProviderCallInternal");

const reconcileStripeOperation = makeFunctionReference<
  "action",
  { operationId: string; attemptId: string },
  null
>("stripe_operation_dispatch:reconcileStripeOperationDispatchInternal");

const reconcileInactiveStripeMetadataTransfer = makeFunctionReference<
  "action",
  { operationId: string },
  null
>("stripe_operation_dispatch:reconcileInactiveStripeMetadataTransferInternal");

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

const recordManualDebt = makeFunctionReference<
  "mutation",
  {
    operationId: string;
    attemptId: string;
    claimId: string;
    reason: ManualDebtReason;
    now: number;
  },
  null
>("stripe_operation_dispatch:recordStripeOperationManualDebtInternal");

const completeStripeOperation = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    now: number;
  },
  boolean
>("stripe_operation_dispatch:completeStripeOperationInternal");

const authorizeStripeOperationResultReturn = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    stripeCustomerId: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
  },
  boolean
>("stripe_operation_dispatch:authorizeStripeOperationResultReturnInternal");

const resolveLateStripeCleanupRetention = makeFunctionReference<
  "mutation",
  {
    tupleHash: string;
    successLocatorHash: string;
    resolutionId: string;
    resolvedBy: string;
    evidence: string;
    now: number;
  },
  { resolution: "provider_resource_retained"; replayed: boolean }
>("stripe_operation_dispatch:resolveLateStripeCleanupRetentionInternal");

const claimLateStripeCleanup = makeFunctionReference<
  "mutation",
  { tupleHash: string; locatorHash: string; claimId: string; now: number },
  boolean
>("stripe_operation_dispatch:claimLateStripeCleanupInternal");

const revalidateLateStripeCleanupClaim = makeFunctionReference<
  "mutation",
  { tupleHash: string; locatorHash: string; claimId: string; now: number },
  boolean
>("stripe_operation_dispatch:revalidateLateStripeCleanupClaimInternal");

const recordLateStripeCleanupFailure = makeFunctionReference<
  "mutation",
  {
    tupleHash: string;
    locatorHash: string;
    claimId?: string;
    error: string;
    now: number;
  },
  null
>("stripe_operation_dispatch:recordLateStripeCleanupFailureInternal");

const quiesceForPurge = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
    mode: "reset" | "delete";
    now: number;
  },
  { ready: boolean; pending: string[]; retryAt: number | null }
>("stripe_operation_dispatch:quiesceOwnerStripeOperationsForPurgeInternal");

const remainingDispatches = makeFunctionReference<
  "query",
  { ownerId: string; now: number },
  string[]
>("stripe_operation_dispatch:remainingOwnerStripeOperationDispatchesInternal");

const reserveStripeOperation = makeFunctionReference<
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
    activeStep: StripeStep | null;
    stripeCustomerId: string | null;
    stripeCheckoutSessionId: string | null;
    stripePortalSessionId: string | null;
    blockedReason: "legacy_dispatch_active" | "legacy_missing_receipt" | null;
  }
>("billing:reserveStripeOperationInternal");

const hex64 = (value: number) => value.toString(16).padStart(64, "0");
// Keep scheduled reconciliation wakes outside the wall-clock duration of a
// unit test. The state-machine receives this clock explicitly; using 1970-era
// values would make convex-test execute `runAt` callbacks between assertions.
const TEST_CLOCK = Date.now() + 60 * 60_000;

const seedActiveOwner = async (
  t: Harness,
  ownerId: string,
  generation: string,
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId,
      generation,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
};

const seedProfile = async (
  t: Harness,
  ownerId: string,
  options: {
    stripeCustomerId?: string;
    authorityEpoch?: number;
    adoptionScanEpoch?: number;
  } = {},
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("billing_profiles", {
      ownerId,
      activePlan: "free",
      subscriptionStatus: "none",
      stripeCustomerId: options.stripeCustomerId ?? "",
      stripeSubscriptionId: "",
      stripePriceId: "",
      defaultPaymentMethodId: "",
      paymentMethodBrand: "",
      paymentMethodLast4: "",
      currentPeriodStart: 0,
      currentPeriodEnd: 0,
      cancelAtPeriodEnd: false,
      monthlyAnchorAt: 1,
      stripeCustomerAuthorityEpoch: options.authorityEpoch ?? 0,
      ...(options.adoptionScanEpoch === undefined
        ? {}
        : { stripeCustomerAdoptionScanEpoch: options.adoptionScanEpoch }),
      createdAt: 1,
      updatedAt: 1,
    });
  });
};

const seedOperation = async (
  t: Harness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    index: number;
    operationId?: string;
    kind?: "subscription_checkout" | "usage_credit_checkout" | "billing_portal";
    state?: "reserved" | "provider_succeeded" | "completed";
    dispatchState?: "idle" | "may_have_dispatched" | null;
    modern?: boolean;
    integrityVersion?: number | null;
    authorityEpoch?: number | null;
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
    leaseExpiresAt?: number;
    requestKey?: string;
    requestFingerprint?: string;
    manualDebtReason?: ManualDebtReason;
  },
) => {
  const operationId = args.operationId ?? `operation-${args.index}`;
  const modern = args.modern ?? true;
  const dispatchState =
    args.dispatchState === null
      ? undefined
      : (args.dispatchState ?? (modern ? "idle" : undefined));
  const integrityVersion =
    args.integrityVersion === null
      ? undefined
      : (args.integrityVersion ?? (modern ? 3 : undefined));
  const authorityEpoch =
    args.authorityEpoch === null
      ? undefined
      : (args.authorityEpoch ?? (modern ? 0 : undefined));
  await t.run(async (ctx) => {
    await ctx.db.insert("billing_stripe_operations", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      operationId,
      kind: args.kind ?? "subscription_checkout",
      state: args.state ?? "reserved",
      idempotencyKey: `operation-key-${args.index}`,
      stripeCustomerCreateIdempotencyKey: `customer-key-${args.index}`,
      requestKey: args.requestKey ?? hex64(args.index + 1),
      requestFingerprint: args.requestFingerprint ?? hex64(args.index + 10_000),
      ...(dispatchState ? { dispatchState } : {}),
      ...(integrityVersion === undefined ? {} : { integrityVersion }),
      ...(authorityEpoch === undefined
        ? {}
        : { stripeCustomerAuthorityEpoch: authorityEpoch }),
      ...(args.stripeCustomerId
        ? {
            stripeCustomerId: args.stripeCustomerId,
            stripeCustomerMetadataOwnerId: args.ownerId,
          }
        : {}),
      ...(args.stripeCheckoutSessionId
        ? { stripeCheckoutSessionId: args.stripeCheckoutSessionId }
        : {}),
      ...(args.stripePortalSessionId
        ? { stripePortalSessionId: args.stripePortalSessionId }
        : {}),
      ...(args.manualDebtReason
        ? { manualDebtReason: args.manualDebtReason }
        : {}),
      leaseExpiresAt: args.leaseExpiresAt ?? 0,
      createdAt: args.index + 1,
      updatedAt: args.index + 1,
    });
  });
  return operationId;
};

const seedManyOperations = async (
  t: Harness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    count: number;
    integrityVersion?: number;
    authorityEpoch?: number;
    stripeCustomerForIndex?: (index: number) => string | undefined;
  },
) => {
  await t.run(async (ctx) => {
    for (let index = 0; index < args.count; index += 1) {
      const stripeCustomerId = args.stripeCustomerForIndex?.(index);
      await ctx.db.insert("billing_stripe_operations", {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        operationId: `operation-${index}`,
        kind: "subscription_checkout",
        state: "reserved",
        dispatchState: "idle",
        ...(args.integrityVersion === undefined
          ? {}
          : { integrityVersion: args.integrityVersion }),
        ...(args.authorityEpoch === undefined
          ? {}
          : { stripeCustomerAuthorityEpoch: args.authorityEpoch }),
        idempotencyKey: `operation-key-${index}`,
        stripeCustomerCreateIdempotencyKey: `customer-key-${index}`,
        requestKey: hex64(index + 1),
        requestFingerprint: hex64(index + 10_000),
        ...(stripeCustomerId
          ? {
              stripeCustomerId,
              stripeCustomerMetadataOwnerId: args.ownerId,
            }
          : {}),
        leaseExpiresAt: 0,
        createdAt: index + 1,
        updatedAt: index + 1,
      });
    }
  });
};

const readOperation = async (t: Harness, operationId: string) =>
  await t.run(async (ctx) =>
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
      .unique(),
  );

const beginPurge = async (
  t: Harness,
  ownerId: string,
  mode: "reset" | "delete",
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId: `${mode}-${ownerId}`, mode, now: 10_000 },
  );
  const leaseId = `lease-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId,
    now: 10_001,
  });
  return {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId,
  };
};

const exactTuple = (
  ownerId: string,
  ownerGeneration: string,
  operationId: string,
  step: StripeStep,
  marked: MarkResult,
) => ({
  ownerId,
  ownerGeneration,
  operationId,
  attemptId: marked.attemptId,
  step,
  requestFingerprint: marked.requestFingerprint,
  idempotencyKey: marked.idempotencyKey,
  providerDeadlineAt: marked.providerDeadlineAt,
});

const seedLateCleanupEnvelope = async (
  t: Harness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    providerOwnerId?: string;
    operationId: string;
    index: number;
    stripeCustomerId: string;
    stripeCheckoutSessionId?: string;
    includeCustomer?: boolean;
    includeCheckout?: boolean;
  },
) => {
  const tupleHash = hex64(500_000 + args.index);
  const successLocatorHash = await hashStripePhysicalSuccessLocators({
    stripeCustomerId: args.stripeCustomerId,
    ...(args.stripeCheckoutSessionId
      ? { stripeCheckoutSessionId: args.stripeCheckoutSessionId }
      : {}),
  });
  const [ownerHash, providerOwnerHash, customerLocatorHash] = await Promise.all(
    [
      ownershipMigrationSourceDigest(args.ownerId),
      ownershipMigrationSourceDigest(args.providerOwnerId ?? args.ownerId),
      hashStripeBillingLocator("customer", args.stripeCustomerId),
    ],
  );
  const checkoutLocatorHash = args.stripeCheckoutSessionId
    ? await hashStripeBillingLocator(
        "checkout_session",
        args.stripeCheckoutSessionId,
      )
    : undefined;
  await t.run(async (ctx) => {
    await ctx.db.insert("billing_stripe_physical_receipts", {
      operationId: args.operationId,
      tupleHash,
      providerOwnerHash,
      successLocatorHash,
      createdAt: args.index,
    });
    if (
      args.stripeCheckoutSessionId &&
      (args.includeCheckout ?? true) &&
      checkoutLocatorHash
    ) {
      await ctx.db.insert("billing_stripe_late_cleanup_locators", {
        tupleHash,
        ownerHash,
        providerOwnerHash,
        successLocatorHash,
        locatorHash: checkoutLocatorHash,
        locatorKind: "checkout_session",
        locatorValue: args.stripeCheckoutSessionId,
        successStripeCustomerId: args.stripeCustomerId,
        successStripeCheckoutSessionId: args.stripeCheckoutSessionId,
        customerLocatorHash,
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: args.index,
        updatedAt: args.index,
      });
    }
    if (args.includeCustomer ?? true) {
      await ctx.db.insert("billing_stripe_late_cleanup_locators", {
        tupleHash,
        ownerHash,
        providerOwnerHash,
        successLocatorHash,
        locatorHash: customerLocatorHash,
        locatorKind: "customer",
        locatorValue: args.stripeCustomerId,
        successStripeCustomerId: args.stripeCustomerId,
        ...(args.stripeCheckoutSessionId
          ? { successStripeCheckoutSessionId: args.stripeCheckoutSessionId }
          : {}),
        checkoutBlocked: Boolean(
          args.stripeCheckoutSessionId && (args.includeCheckout ?? true),
        ),
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: args.index,
        updatedAt: args.index,
      });
    }
  });
  return {
    tupleHash,
    successLocatorHash,
    ownerHash,
    providerOwnerHash,
    customerLocatorHash,
    checkoutLocatorHash,
  };
};

const settleSeededCheckout = async (
  t: Harness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    stripeCustomerId: string;
    stripeCheckoutSessionId: string;
    attemptId: string;
    now: number;
  },
) => {
  const marked = await t.mutation(markStripeOperation, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    operationId: args.operationId,
    attemptId: args.attemptId,
    step: "checkout_create",
    requestJson: JSON.stringify({
      customer: args.stripeCustomerId,
      metadata: { stellaOperationId: args.operationId },
    }),
    now: args.now,
  });
  await t.mutation(settleStripeOperation, {
    ...exactTuple(
      args.ownerId,
      args.ownerGeneration,
      args.operationId,
      "checkout_create",
      marked,
    ),
    stripeCustomerId: args.stripeCustomerId,
    stripeCheckoutSessionId: args.stripeCheckoutSessionId,
    now: args.now + 1,
  });
  return marked;
};

const markAndPersistManualDebt = async (
  t: Harness,
  args: {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    claimId: string;
    step: StripeStep;
    reason: ManualDebtReason;
    now: number;
  },
) => {
  const marked = await t.mutation(markStripeOperation, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    operationId: args.operationId,
    attemptId: args.attemptId,
    step: args.step,
    requestJson: JSON.stringify({
      metadata: { ownerId: args.ownerId, operationId: args.operationId },
    }),
    now: args.now,
  });
  const claim = await t.mutation(claimReconcileCommand, {
    operationId: args.operationId,
    attemptId: marked.attemptId,
    claimId: args.claimId,
    now: marked.quiescentAfterAt,
  });
  expect(claim).not.toBeNull();
  await t.mutation(recordManualDebt, {
    operationId: args.operationId,
    attemptId: marked.attemptId,
    claimId: args.claimId,
    reason: args.reason,
    now: marked.quiescentAfterAt + 1,
  });
  return { marked, claim: claim! };
};

describe("Stripe provider dispatch authority", () => {
  it("grants one physical-call authority and rejects incompatible settlement", async () => {
    const provider = vi.fn(async () => "created");
    assertFreshStripeProviderDispatch({ replayed: false });
    await provider();
    expect(() => assertFreshStripeProviderDispatch({ replayed: true })).toThrow(
      /already has a provider dispatch in progress/u,
    );
    expect(provider).toHaveBeenCalledTimes(1);

    const t = createTest();
    const ownerId = "dispatch-authority-owner";
    const ownerGeneration = "dispatch-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 1,
    });
    const requestJson = JSON.stringify({ metadata: { ownerId } });
    const first = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "attempt-winner",
      step: "customer_create",
      requestJson,
      now: TEST_CLOCK + 100,
    });
    const replay = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "attempt-loser",
      step: "customer_create",
      requestJson,
      now: TEST_CLOCK + 101,
    });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({
      replayed: true,
      attemptId: "attempt-winner",
      idempotencyKey: first.idempotencyKey,
      requestFingerprint: first.requestFingerprint,
      providerDeadlineAt: first.providerDeadlineAt,
    });

    await expect(
      t.mutation(settleStripeOperation, {
        ...exactTuple(
          ownerId,
          ownerGeneration,
          operationId,
          "customer_create",
          first,
        ),
        stripeCustomerId: "cus_authority",
        stripeCheckoutSessionId: "cs_incompatible",
        now: TEST_CLOCK + 102,
      }),
    ).rejects.toThrow(/step-incompatible locators/u);
  });

  it("rejects the 257th physical tuple before provider authority is published", async () => {
    const t = createTest();
    const ownerId = "physical-receipt-cap-owner";
    const ownerGeneration = "physical-receipt-cap-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 701,
    });
    const providerOwnerHash = await ownershipMigrationSourceDigest(ownerId);
    await t.run(async (ctx) => {
      for (let index = 0; index < 256; index += 1) {
        const tupleHash = hex64(700_000 + index);
        const locatorHash = hex64(800_000 + index);
        await ctx.db.insert("billing_stripe_physical_receipts", {
          operationId,
          tupleHash,
          providerOwnerHash,
          successLocatorHash: locatorHash,
          createdAt: index,
        });
        await ctx.db.insert("billing_stripe_operation_resolutions", {
          ownerId,
          ownerGeneration,
          operationId,
          resolutionId: `physical-cap-resolution-${index}`,
          debtKey: `late:${tupleHash}:${locatorHash}`,
          attemptId: `physical-cap-attempt-${index}`,
          step: "customer_create",
          resolution: "recovered_customer",
          debtReason: "late_result_conflict",
          locatorHash,
          resolvedByHash: hex64(900_000 + index),
          evidenceHash: hex64(1_000_000 + index),
          resolvedAt: index,
        });
      }
    });

    const provider = vi.fn(async () => "must-not-run");
    let marked = false;
    try {
      await t.mutation(markStripeOperation, {
        ownerId,
        ownerGeneration,
        operationId,
        attemptId: "physical-cap-attempt-257",
        step: "customer_create",
        requestJson: JSON.stringify({ metadata: { ownerId } }),
        now: TEST_CLOCK + 150,
      });
      marked = true;
    } catch (error) {
      expect(String(error)).toMatch(/physical receipt capacity/iu);
    }
    expect(marked).toBe(false);
    if (marked) await provider();
    expect(provider).not.toHaveBeenCalled();
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
    expect(snapshot.operation).toMatchObject({ dispatchState: "idle" });
    expect(snapshot.receipts).toHaveLength(256);
  }, 30_000);

  it("rejects rotated customer authority at mark and at the last pre-I/O fence", async () => {
    const t = createTest();
    const ownerId = "rotated-authority-owner";
    const ownerGeneration = "rotated-authority-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { authorityEpoch: 0 });
    const markedOperationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 2,
      authorityEpoch: 0,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId: markedOperationId,
      attemptId: "authority-before-rotation",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 200,
    });

    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerAuthorityEpoch: 1,
        updatedAt: TEST_CLOCK + 201,
      });
    });

    const provider = vi.fn(async () => "must-not-run");
    const authority = await t.mutation(revalidateInitialProviderCall, {
      ...exactTuple(
        ownerId,
        ownerGeneration,
        markedOperationId,
        "customer_create",
        marked,
      ),
      now: TEST_CLOCK + 202,
    });
    if (authority) await provider();
    expect(authority).toBeNull();
    expect(provider).not.toHaveBeenCalled();

    const staleOperationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 3,
      authorityEpoch: 0,
    });
    await expect(
      t.mutation(markStripeOperation, {
        ownerId,
        ownerGeneration,
        operationId: staleOperationId,
        attemptId: "authority-after-rotation",
        step: "customer_create",
        requestJson: JSON.stringify({ metadata: { ownerId } }),
        now: TEST_CLOCK + 203,
      }),
    ).rejects.toThrow(/authority was rotated/u);
  });

  it("never creates a second customer after account linking adopts a canonical profile customer", async () => {
    const provider = vi.fn(async () => "must-not-run");

    const markFence = createTest();
    const markOwnerId = "adopted-customer-mark-owner";
    const markGeneration = "adopted-customer-mark-generation";
    await seedActiveOwner(markFence, markOwnerId, markGeneration);
    await seedProfile(markFence, markOwnerId);
    const idleOperationId = await seedOperation(markFence, {
      ownerId: markOwnerId,
      ownerGeneration: markGeneration,
      index: 702,
    });
    await markFence.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", markOwnerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerId: "cus_adopted_before_mark",
        updatedAt: TEST_CLOCK + 250,
      });
    });
    await expect(
      markFence.mutation(markStripeOperation, {
        ownerId: markOwnerId,
        ownerGeneration: markGeneration,
        operationId: idleOperationId,
        attemptId: "adopted-customer-mark-attempt",
        step: "customer_create",
        requestJson: JSON.stringify({ metadata: { ownerId: markOwnerId } }),
        now: TEST_CLOCK + 251,
      }),
    ).rejects.toThrow(/already has a canonical customer/iu);
    await expect(
      markFence.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_physical_receipts")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", idleOperationId),
          )
          .collect(),
      ),
    ).resolves.toEqual([]);

    const resumed = createTest();
    const resumedOwnerId = "adopted-customer-resumed-owner";
    const resumedGeneration = "adopted-customer-resumed-generation";
    await seedActiveOwner(resumed, resumedOwnerId, resumedGeneration);
    await seedProfile(resumed, resumedOwnerId);
    const markedOperationId = await seedOperation(resumed, {
      ownerId: resumedOwnerId,
      ownerGeneration: resumedGeneration,
      index: 703,
    });
    const marked = await resumed.mutation(markStripeOperation, {
      ownerId: resumedOwnerId,
      ownerGeneration: resumedGeneration,
      operationId: markedOperationId,
      attemptId: "adopted-customer-resumed-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId: resumedOwnerId } }),
      now: TEST_CLOCK + 260,
    });
    await resumed.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", resumedOwnerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerId: "cus_adopted_while_suspended",
        updatedAt: TEST_CLOCK + 261,
      });
    });
    const initialAuthority = await resumed.mutation(
      revalidateInitialProviderCall,
      {
        ...exactTuple(
          resumedOwnerId,
          resumedGeneration,
          markedOperationId,
          "customer_create",
          marked,
        ),
        now: TEST_CLOCK + 262,
      },
    );
    if (initialAuthority) await provider();
    expect(initialAuthority).toBeNull();

    const claim = await resumed.mutation(claimReconcileCommand, {
      operationId: markedOperationId,
      attemptId: marked.attemptId,
      claimId: "adopted-customer-reconcile-claim",
      now: marked.quiescentAfterAt,
    });
    expect(claim).not.toBeNull();
    const replayAuthority = await resumed.mutation(
      revalidateReconcileProviderCall,
      {
        operationId: markedOperationId,
        attemptId: marked.attemptId,
        claimId: "adopted-customer-reconcile-claim",
        allowRevokedCustomerAuthority: false,
        now: marked.quiescentAfterAt + 1,
      },
    );
    if (replayAuthority) await provider();
    expect(replayAuthority).toBeNull();
    const discoveryOnly = await resumed.mutation(
      revalidateReconcileProviderCall,
      {
        operationId: markedOperationId,
        attemptId: marked.attemptId,
        claimId: "adopted-customer-reconcile-claim",
        allowRevokedCustomerAuthority: true,
        now: marked.quiescentAfterAt + 2,
      },
    );
    expect(discoveryOnly).toMatchObject({ customerAuthorityCurrent: false });
    expect(provider).not.toHaveBeenCalled();
  });

  it("pins an already-marked rolling v2 customer key before admitting a distinct request", async () => {
    const t = createTest();
    const ownerId = "rolling-customer-key-owner";
    const ownerGeneration = "rolling-customer-key-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { authorityEpoch: 0 });
    const firstOperationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 17,
      authorityEpoch: 0,
    });
    const rollingV2Key = "stella-billing-customer-v2-frozen-active-key";
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", firstOperationId),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        stripeCustomerCreateIdempotencyKey: rollingV2Key,
      });
    });
    const requestJson = JSON.stringify({
      metadata: { ownerId, stellaCustomerAuthorityId: rollingV2Key },
    });
    const firstMark = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId: firstOperationId,
      attemptId: "rolling-v2-active-attempt",
      step: "customer_create",
      requestJson,
      now: TEST_CLOCK + 5_000,
    });
    expect(firstMark.idempotencyKey).toBe(rollingV2Key);
    // Model an in-flight v2 writer: the tuple exists, but the immutable
    // provider-owner binding was not part of that rollout. Pin resolution must
    // run the full legacy normalizer before promoting this row to v3.
    await t.run(async (ctx) => {
      const [operation, receipt] = await Promise.all([
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", firstOperationId),
          )
          .unique(),
        ctx.db
          .query("billing_stripe_physical_receipts")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", firstOperationId),
          )
          .unique(),
      ]);
      await ctx.db.patch(operation!._id, { integrityVersion: 2 });
      await ctx.db.patch(receipt!._id, { providerOwnerHash: undefined });
    });
    // Simulate a newer deployment pinning v3 after the older action crossed
    // its durable v2 mark but before a distinct logical request reserves.
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerCreateIdempotencyKey:
          "stella-billing-customer-v3-conflicting-nonphysical-pin",
      });
    });

    const second = await t.mutation(reserveStripeOperation, {
      ownerId,
      ownerGeneration,
      kind: "usage_credit_checkout",
      requestKey: hex64(45),
      requestFingerprint: hex64(46),
      now: TEST_CLOCK + 5_001,
    });
    expect(second.stripeCustomerCreateIdempotencyKey).toBe(rollingV2Key);
    const normalizedFirst = await readOperation(t, firstOperationId);
    const normalizedReceipt = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", firstOperationId),
        )
        .unique(),
    );
    expect(normalizedFirst?.integrityVersion).toBe(3);
    await expect(ownershipMigrationSourceDigest(ownerId)).resolves.toBe(
      normalizedReceipt?.providerOwnerHash,
    );
    const secondMark = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId: second.operationId,
      attemptId: "rolling-v2-second-attempt",
      step: "customer_create",
      requestJson,
      now: TEST_CLOCK + 5_002,
    });
    expect(secondMark.idempotencyKey).toBe(firstMark.idempotencyKey);
    expect(secondMark.requestFingerprint).toBe(firstMark.requestFingerprint);

    await t.mutation(settleStripeOperation, {
      ...exactTuple(
        ownerId,
        ownerGeneration,
        firstOperationId,
        "customer_create",
        firstMark,
      ),
      stripeCustomerId: "cus_rolling_winner",
      now: TEST_CLOCK + 5_003,
    });
    await t.mutation(settleStripeOperation, {
      ...exactTuple(
        ownerId,
        ownerGeneration,
        second.operationId,
        "customer_create",
        secondMark,
      ),
      stripeCustomerId: "cus_rolling_loser",
      now: TEST_CLOCK + 5_004,
    });
    await expect(
      t.run(
        async (ctx) =>
          await ctx.db
            .query("billing_stripe_late_results")
            .withIndex("by_operationId_and_attemptId", (q) =>
              q
                .eq("operationId", second.operationId)
                .eq("attemptId", secondMark.attemptId),
            )
            .unique(),
      ),
    ).resolves.toMatchObject({
      stripeCustomerId: "cus_rolling_loser",
    });
  });

  it("rejects an idle rolling v2 customer mark after a nonphysical v3 pin", async () => {
    const t = createTest();
    const ownerId = "rolling-idle-key-owner";
    const ownerGeneration = "rolling-idle-key-generation";
    const pinnedKey = "stella-billing-customer-v3-pinned-before-old-mark";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { authorityEpoch: 0 });
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 18,
      authorityEpoch: 0,
    });
    await t.run(async (ctx) => {
      const [profile, operation] = await Promise.all([
        ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique(),
      ]);
      await ctx.db.patch(profile!._id, {
        stripeCustomerCreateIdempotencyKey: pinnedKey,
      });
      await ctx.db.patch(operation!._id, {
        stripeCustomerCreateIdempotencyKey:
          "stella-billing-customer-v2-idle-stale-key",
      });
    });
    await expect(
      t.mutation(markStripeOperation, {
        ownerId,
        ownerGeneration,
        operationId,
        attemptId: "rolling-idle-stale-attempt",
        step: "customer_create",
        requestJson: JSON.stringify({ metadata: { ownerId } }),
        now: TEST_CLOCK + 5_100,
      }),
    ).rejects.toThrow(/authority key changed/u);
    await expect(
      t.run(async (ctx) =>
        ctx.db.query("billing_stripe_physical_receipts").collect(),
      ),
    ).resolves.toEqual([]);

    const adopted = await t.mutation(reserveStripeOperation, {
      ownerId,
      ownerGeneration,
      kind: "subscription_checkout",
      requestKey: hex64(19),
      requestFingerprint: hex64(10_018),
      now: TEST_CLOCK + 5_101,
    });
    expect(adopted.stripeCustomerCreateIdempotencyKey).toBe(pinnedKey);
  });

  it("fails closed on every malformed historical-result shape during request adoption", async () => {
    const t = createTest();
    const ownerId = "historical-adoption-owner";
    const ownerGeneration = "historical-adoption-generation";
    const index = 27;
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index,
    });
    const reserveExact = () =>
      t.mutation(reserveStripeOperation, {
        ownerId,
        ownerGeneration,
        kind: "subscription_checkout",
        requestKey: hex64(index + 1),
        requestFingerprint: hex64(index + 10_000),
        now: TEST_CLOCK + 5_200,
      });
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
    await expect(reserveExact()).rejects.toThrow(
      /receipt history is malformed/u,
    );
    await patchOperation({
      lastStripeDisposition: undefined,
      lastStripeReconcileClaimId: "historical-adoption-claim",
    });
    await expect(reserveExact()).rejects.toThrow(
      /receipt history is malformed/u,
    );
    await patchOperation({
      lastStripeReconcileClaimId: undefined,
      lastStripeStep: "customer_create",
      lastStripeAttemptId: "historical-adoption-attempt",
      lastStripeRequestFingerprint: hex64(30_000),
      lastStripeIdempotencyKey: "historical-adoption-key",
      lastStripeProviderDeadlineAt: TEST_CLOCK + 5_000,
    });
    await expect(reserveExact()).rejects.toThrow(
      /receipt history is malformed/u,
    );
    await patchOperation({
      lastStripeDisposition: "not_created",
      lastStripeReconcileClaimId: "historical-adoption-valid-claim",
    });
    await expect(reserveExact()).rejects.toThrow(
      /physical receipt authority is missing/u,
    );
    await patchOperation({ integrityVersion: 2 });
    await expect(reserveExact()).resolves.toMatchObject({ operationId });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_physical_receipts")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .collect(),
      ),
    ).resolves.toHaveLength(1);
  });

  it("makes stale reconcile claims and elapsed provider deadlines zero-call authorities", async () => {
    const t = createTest();
    const ownerId = "reconcile-authority-owner";
    const ownerGeneration = "reconcile-authority-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 4,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "reconcile-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 300,
    });
    const claim = await t.mutation(claimReconcileCommand, {
      operationId,
      attemptId: marked.attemptId,
      claimId: "reconcile-live-claim",
      now: marked.quiescentAfterAt,
    });
    expect(claim).not.toBeNull();

    const provider = vi.fn(async () => "must-not-run");
    const staleClaim = await t.mutation(revalidateReconcileProviderCall, {
      operationId,
      attemptId: marked.attemptId,
      claimId: "reconcile-stale-claim",
      allowRevokedCustomerAuthority: false,
      now: marked.quiescentAfterAt + 1,
    });
    if (staleClaim) await provider();

    const elapsedDeadline = await t.mutation(revalidateReconcileProviderCall, {
      operationId,
      attemptId: marked.attemptId,
      claimId: "reconcile-live-claim",
      allowRevokedCustomerAuthority: false,
      now: claim!.reconcileProviderDeadlineAt,
    });
    if (elapsedDeadline) await provider();

    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerCreateIdempotencyKey:
          "stella-billing-customer-v3-different-pin",
        updatedAt: marked.quiescentAfterAt + 2,
      });
    });
    const revokedByPin = await t.mutation(revalidateReconcileProviderCall, {
      operationId,
      attemptId: marked.attemptId,
      claimId: "reconcile-live-claim",
      allowRevokedCustomerAuthority: false,
      now: marked.quiescentAfterAt + 3,
    });
    const discoveryOnlyByPin = await t.mutation(
      revalidateReconcileProviderCall,
      {
        operationId,
        attemptId: marked.attemptId,
        claimId: "reconcile-live-claim",
        allowRevokedCustomerAuthority: true,
        now: marked.quiescentAfterAt + 4,
      },
    );
    if (revokedByPin) await provider();
    expect(revokedByPin).toBeNull();
    expect(discoveryOnlyByPin).toMatchObject({
      customerAuthorityCurrent: false,
    });

    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerAuthorityEpoch: 1,
        updatedAt: marked.quiescentAfterAt + 5,
      });
    });
    const revokedAuthority = await t.mutation(revalidateReconcileProviderCall, {
      operationId,
      attemptId: marked.attemptId,
      claimId: "reconcile-live-claim",
      allowRevokedCustomerAuthority: false,
      now: marked.quiescentAfterAt + 6,
    });
    if (revokedAuthority) await provider();

    expect(staleClaim).toBeNull();
    expect(elapsedDeadline).toBeNull();
    expect(revokedAuthority).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps revoked empty customer discovery as debt and blocks every distinct create", async () => {
    const t = createTest();
    const ownerId = "revoked-empty-search-owner";
    const ownerGeneration = "revoked-empty-search-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { authorityEpoch: 0 });
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 19,
      authorityEpoch: 0,
    });
    const wallNow = Date.now();
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "revoked-empty-search-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({
        metadata: {
          ownerId,
          stellaCustomerAuthorityId: "revoked-empty-search-authority",
        },
      }),
      now: wallNow - 46_000,
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(profile!._id, {
        stripeCustomerCreateIdempotencyKey:
          "stella-billing-customer-v3-revoked-pin",
        updatedAt: wallNow - 1,
      });
    });

    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      expect(url).toContain("/v1/customers/search");
      return new Response(
        JSON.stringify({
          object: "search_result",
          data: [],
          has_more: false,
          next_page: null,
          url: "/v1/customers/search",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "request-id": "req_revoked_empty_search",
          },
        },
      );
    });
    process.env.STRIPE_SECRET_KEY = "sk_test_revoked_empty_search";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(reconcileStripeOperation, {
        operationId,
        attemptId: marked.attemptId,
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(await readOperation(t, operationId)).toMatchObject({
      dispatchState: "may_have_dispatched",
      activeAttemptId: marked.attemptId,
      manualDebtReason: "customer_authority_revoked",
    });
    await expect(
      t.mutation(reserveStripeOperation, {
        ownerId,
        ownerGeneration,
        kind: "usage_credit_checkout",
        requestKey: hex64(20),
        requestFingerprint: hex64(10_020),
        now: Date.now(),
      }),
    ).rejects.toThrow(/requires reconciliation/u);

    const agedOwnerId = "aged-customer-authority-owner";
    const agedGeneration = "aged-customer-authority-generation";
    await seedActiveOwner(t, agedOwnerId, agedGeneration);
    await seedProfile(t, agedOwnerId, { authorityEpoch: 0 });
    const agedOperationId = await seedOperation(t, {
      ownerId: agedOwnerId,
      ownerGeneration: agedGeneration,
      index: 20,
      authorityEpoch: 0,
    });
    await t.mutation(markStripeOperation, {
      ownerId: agedOwnerId,
      ownerGeneration: agedGeneration,
      operationId: agedOperationId,
      attemptId: "aged-customer-authority-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId: agedOwnerId } }),
      now: wallNow - 23 * 60 * 60 * 1_000 - 60_000,
    });
    await expect(
      t.mutation(reserveStripeOperation, {
        ownerId: agedOwnerId,
        ownerGeneration: agedGeneration,
        kind: "usage_credit_checkout",
        requestKey: hex64(21),
        requestFingerprint: hex64(10_021),
        now: wallNow,
      }),
    ).rejects.toThrow(/requires reconciliation/u);
  });

  it("rolls an inactive response-lost metadata transfer back before lifecycle proceeds", async () => {
    const t = createTest();
    const sourceOwnerId = "inactive-transfer-source";
    const destinationOwnerId = "inactive-transfer-destination";
    const ownerGeneration = "inactive-transfer-generation";
    const operationId = "inactive-transfer-operation";
    const stripeCustomerId = "cus_inactive_transfer";
    await seedActiveOwner(t, sourceOwnerId, ownerGeneration);
    await seedActiveOwner(
      t,
      destinationOwnerId,
      "inactive-transfer-destination-generation",
    );
    await seedProfile(t, sourceOwnerId, { stripeCustomerId });
    await seedProfile(t, destinationOwnerId);
    await seedOperation(t, {
      ownerId: sourceOwnerId,
      ownerGeneration,
      operationId,
      index: 22,
      stripeCustomerId,
    });
    const now = Date.now();
    await settleSeededCheckout(t, {
      ownerId: sourceOwnerId,
      ownerGeneration,
      operationId,
      stripeCustomerId,
      stripeCheckoutSessionId: "cs_inactive_transfer",
      attemptId: "inactive-transfer-checkout",
      now: now - 60_000,
    });
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      await ctx.db.patch(operation!._id, {
        stripeCustomerMetadataTransferState: "may_have_dispatched",
        stripeCustomerMetadataTransferToOwnerId: destinationOwnerId,
        stripeCustomerMetadataTransferAttemptId: "inactive-transfer-attempt",
        stripeCustomerMetadataTransferIdempotencyKey:
          "inactive-transfer-provider-key",
        stripeCustomerMetadataTransferProviderDeadlineAt: now - 20_000,
        stripeCustomerMetadataTransferQuiescentAfterAt: now - 5_000,
      });
    });

    let providerOwnerId = destinationOwnerId;
    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        expect(url).toContain(`/v1/customers/${stripeCustomerId}`);
        if (method === "POST") providerOwnerId = sourceOwnerId;
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
              "request-id": "req_inactive_transfer",
            },
          },
        );
      },
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_inactive_transfer";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(reconcileInactiveStripeMetadataTransfer, { operationId });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }

    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(providerOwnerId).toBe(sourceOwnerId);
    const operation = await readOperation(t, operationId);
    expect(operation).toMatchObject({
      stripeCustomerMetadataTransferState: "idle",
      stripeCustomerId,
    });
    expect(operation?.stripeCustomerMetadataTransferToOwnerId).toBeUndefined();
    expect(operation?.stripeCustomerMetadataTransferDebtReason).toBeUndefined();
    await expect(
      t.query(remainingDispatches, { ownerId: sourceOwnerId, now: now + 1 }),
    ).resolves.toEqual([`stripe_operation_integrity_unchecked:${operationId}`]);
    await expect(
      t.query(remainingDispatches, {
        ownerId: destinationOwnerId,
        now: now + 1,
      }),
    ).resolves.toEqual([]);
  });

  it("persists and explicitly resolves foreign metadata-transfer ownership debt", async () => {
    const t = createTest();
    const sourceOwnerId = "foreign-transfer-source";
    const destinationOwnerId = "foreign-transfer-destination";
    const ownerGeneration = "foreign-transfer-generation";
    const operationId = "foreign-transfer-operation";
    const stripeCustomerId = "cus_foreign_transfer";
    const attemptId = "foreign-transfer-attempt";
    await seedActiveOwner(t, sourceOwnerId, ownerGeneration);
    await seedProfile(t, sourceOwnerId, { stripeCustomerId });
    await seedOperation(t, {
      ownerId: sourceOwnerId,
      ownerGeneration,
      operationId,
      index: 23,
      stripeCustomerId,
    });
    const now = Date.now();
    await settleSeededCheckout(t, {
      ownerId: sourceOwnerId,
      ownerGeneration,
      operationId,
      stripeCustomerId,
      stripeCheckoutSessionId: "cs_foreign_transfer",
      attemptId: "foreign-transfer-checkout",
      now: now - 60_000,
    });
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      await ctx.db.patch(operation!._id, {
        stripeCustomerMetadataTransferState: "may_have_dispatched",
        stripeCustomerMetadataTransferToOwnerId: destinationOwnerId,
        stripeCustomerMetadataTransferAttemptId: attemptId,
        stripeCustomerMetadataTransferIdempotencyKey:
          "foreign-transfer-provider-key",
        stripeCustomerMetadataTransferProviderDeadlineAt: now - 20_000,
        stripeCustomerMetadataTransferQuiescentAfterAt: now - 5_000,
      });
    });

    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: stripeCustomerId,
            object: "customer",
            deleted: false,
            metadata: { ownerId: "unrelated-foreign-owner" },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "request-id": "req_foreign_transfer",
            },
          },
        ),
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_foreign_transfer";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(reconcileInactiveStripeMetadataTransfer, { operationId });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(await readOperation(t, operationId)).toMatchObject({
      stripeCustomerMetadataTransferDebtReason: "foreign_owner",
    });
    await expect(
      t.query(remainingDispatches, { ownerId: sourceOwnerId, now: now + 1 }),
    ).resolves.toContain(
      `stripe_customer_metadata_transfer_manual_reconciliation:foreign_owner:${operationId}`,
    );

    const resolutionArgs = {
      operationId,
      expectedAttemptId: attemptId,
      expectedSourceOwnerId: sourceOwnerId,
      expectedDestinationOwnerId: destinationOwnerId,
      resolutionId: "foreign-transfer-resolution",
      resolution: "provider_restored_source" as const,
      resolvedBy: "operator@example.test",
      evidence: "Stripe support confirmed source metadata was restored.",
    };
    await expect(
      t.mutation(resolveStripeMetadataTransferDebt, {
        ...resolutionArgs,
        now: now + 2,
      }),
    ).resolves.toEqual({
      resolution: "provider_restored_source",
      replayed: false,
    });
    await expect(
      t.mutation(resolveStripeMetadataTransferDebt, {
        ...resolutionArgs,
        now: now + 3,
      }),
    ).resolves.toEqual({
      resolution: "provider_restored_source",
      replayed: true,
    });
    await expect(
      t.mutation(resolveStripeMetadataTransferDebt, {
        ...resolutionArgs,
        resolvedBy: "different-operator@example.test",
        now: now + 4,
      }),
    ).rejects.toThrow(/resolution ID was reused/u);
    await expect(
      t.mutation(resolveStripeMetadataTransferDebt, {
        ...resolutionArgs,
        evidence: "Different evidence must not replay the same audit id.",
        now: now + 5,
      }),
    ).rejects.toThrow(/resolution ID was reused/u);
    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_metadata_transfer_resolutions")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", resolutionArgs.resolutionId),
        )
        .unique(),
    );
    expect(audit).toMatchObject({
      operationId,
      transferAttemptId: attemptId,
      resolution: "provider_restored_source",
    });
    expect(JSON.stringify(audit)).not.toContain(sourceOwnerId);
    expect(JSON.stringify(audit)).not.toContain(destinationOwnerId);
    await expect(
      t.query(remainingDispatches, { ownerId: sourceOwnerId, now: now + 4 }),
    ).resolves.toEqual([`stripe_operation_integrity_unchecked:${operationId}`]);
  });

  it("revokes every local customer authority when metadata-transfer debt confirms deletion", async () => {
    const t = createTest();
    const ownerId = "deleted-transfer-source";
    const destinationOwnerId = "deleted-transfer-destination";
    const ownerGeneration = "deleted-transfer-generation";
    const operationId = "deleted-transfer-operation";
    const stripeCustomerId = "cus_deleted_transfer";
    const attemptId = "deleted-transfer-attempt";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, {
      stripeCustomerId,
      authorityEpoch: 0,
      adoptionScanEpoch: 0,
    });
    await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 24,
      stripeCustomerId,
      authorityEpoch: 0,
    });
    const now = TEST_CLOCK + 70_000;
    await settleSeededCheckout(t, {
      ownerId,
      ownerGeneration,
      operationId,
      stripeCustomerId,
      stripeCheckoutSessionId: "cs_deleted_transfer",
      attemptId: "deleted-transfer-checkout",
      now: now - 60_000,
    });
    await t.run(async (ctx) => {
      const [profile, operation] = await Promise.all([
        ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique(),
      ]);
      await ctx.db.patch(profile!._id, {
        stripeSubscriptionId: "sub_deleted_transfer",
        stripePriceId: "price_deleted_transfer",
        defaultPaymentMethodId: "pm_deleted_transfer",
        paymentMethodBrand: "visa",
        paymentMethodLast4: "4242",
        stripeCustomerCreateIdempotencyKey: "old-deleted-customer-key",
      });
      await ctx.db.patch(operation!._id, {
        stripeCustomerMetadataTransferState: "may_have_dispatched",
        stripeCustomerMetadataTransferToOwnerId: destinationOwnerId,
        stripeCustomerMetadataTransferAttemptId: attemptId,
        stripeCustomerMetadataTransferIdempotencyKey:
          "deleted-transfer-provider-key",
        stripeCustomerMetadataTransferProviderDeadlineAt: now - 20_000,
        stripeCustomerMetadataTransferQuiescentAfterAt: now - 5_000,
        stripeCustomerMetadataTransferDebtReason: "customer_deleted",
      });
    });

    await expect(
      t.mutation(resolveStripeMetadataTransferDebt, {
        operationId,
        expectedAttemptId: attemptId,
        expectedSourceOwnerId: ownerId,
        expectedDestinationOwnerId: destinationOwnerId,
        resolutionId: "deleted-transfer-resolution",
        resolution: "provider_confirmed_deleted",
        resolvedBy: "operator@example.test",
        evidence: "Stripe confirms the transferred customer is deleted.",
        now,
      }),
    ).resolves.toEqual({
      resolution: "provider_confirmed_deleted",
      replayed: false,
    });

    const snapshot = await t.run(async (ctx) => ({
      profile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      tombstones: await ctx.db
        .query("billing_stripe_deletion_tombstones")
        .collect(),
    }));
    expect(snapshot.profile).toMatchObject({
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      stripePriceId: "",
      defaultPaymentMethodId: "",
      paymentMethodBrand: "",
      paymentMethodLast4: "",
      stripeCustomerTerminal: true,
      stripeSubscriptionTerminal: true,
      stripeCustomerAuthorityEpoch: 1,
      stripeCustomerAdoptionScanEpoch: 1,
    });
    expect(
      snapshot.profile?.stripeCustomerCreateIdempotencyKey,
    ).toBeUndefined();
    expect(snapshot.operation?.stripeCustomerId).toBe(stripeCustomerId);
    expect(snapshot.tombstones).toHaveLength(1);

    await expect(
      t.mutation(reserveStripeOperation, {
        ownerId,
        ownerGeneration,
        kind: "subscription_checkout",
        requestKey: hex64(25),
        requestFingerprint: hex64(10_024),
        now: 2_002,
      }),
    ).rejects.toThrow(/deleted Stripe customer authority/u);
    const fresh = await t.mutation(reserveStripeOperation, {
      ownerId,
      ownerGeneration,
      kind: "usage_credit_checkout",
      requestKey: hex64(26),
      requestFingerprint: hex64(10_026),
      now: 2_003,
    });
    expect(fresh.stripeCustomerCreateIdempotencyKey).toMatch(
      /^stella-billing-customer-v3-/u,
    );
    expect(fresh.stripeCustomerCreateIdempotencyKey).not.toBe(
      "old-deleted-customer-key",
    );

    const purge = await beginPurge(t, ownerId, "reset");
    await expect(
      t.mutation(quiesceForPurge, {
        ...purge,
        mode: "reset",
        now: 20_000,
      }),
    ).resolves.toEqual({ ready: true, pending: [], retryAt: null });
  });

  it("tombstones an ownerless deleted customer before delayed settlement can link it", async () => {
    const t = createTest();
    const ownerId = "ownerless-deleted-customer-owner";
    const ownerGeneration = "ownerless-deleted-customer-generation";
    const stripeCustomerId = "cus_ownerless_deleted_before_settle";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 707,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "ownerless-deleted-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 71_000,
    });

    const eventId = "evt_ownerless_customer_deleted_before_settle";
    const claimId = "ownerless-customer-deleted-claim";
    await expect(
      t.mutation(internal.billing.recordStripeEvent, {
        eventId,
        claimId,
        eventType: "customer.deleted",
        stripeCustomerId,
        createdAt: TEST_CLOCK + 71_001,
      }),
    ).resolves.toEqual({ accepted: true, status: "accepted" });
    const fence = await t.query(
      internal.billing.getStripeEventClaimFenceInternal,
      { eventId, claimId },
    );
    expect(fence).toEqual({ ownerId: "", ownerGeneration: "" });
    await expect(
      t.mutation(internal.billing.syncCustomerDeletionFromStripe, {
        stripeCustomerId,
        ownerGeneration: fence!.ownerGeneration,
        stripeEventCreatedAt: TEST_CLOCK + 71_001,
        stripeEventId: eventId,
      }),
    ).resolves.toEqual({ updated: false });

    const locatorHash = await hashStripeBillingLocator(
      "customer",
      stripeCustomerId,
    );
    const tombstone = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_deletion_tombstones")
        .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
        .unique(),
    );
    expect(tombstone).toMatchObject({
      locatorHash,
      locatorKind: "customer",
    });

    await expect(
      t.mutation(settleStripeOperation, {
        ...exactTuple(
          ownerId,
          ownerGeneration,
          operationId,
          "customer_create",
          marked,
        ),
        stripeCustomerId,
        now: TEST_CLOCK + 71_002,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: true,
    });
    const profile = await t.run(async (ctx) =>
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    );
    expect(profile?.stripeCustomerId).toBe("");
  });

  it("never slides the immutable physical quiescence boundary across lifecycle retries", async () => {
    const t = createTest();
    const ownerId = "immutable-quiescence-owner";
    const ownerGeneration = "immutable-quiescence-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 5,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "immutable-quiescence-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 400,
    });
    const purge = await beginPurge(t, ownerId, "delete");

    const before = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: marked.quiescentAfterAt - 1,
    });
    expect(before.ready).toBe(false);
    expect(before.retryAt).toBe(marked.quiescentAfterAt);

    const firstEligible = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: marked.quiescentAfterAt,
    });
    const secondEligible = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: marked.quiescentAfterAt + 1,
    });
    expect(firstEligible.pending).toContain(
      `stripe_operation_reconciling:${operationId}`,
    );
    expect(secondEligible.pending).toContain(
      `stripe_operation_reconciling:${operationId}`,
    );
    const row = await readOperation(t, operationId);
    expect(row).toMatchObject({
      quiescentAfterAt: marked.quiescentAfterAt,
      nextReconcileAt: marked.quiescentAfterAt,
      leaseExpiresAt: marked.quiescentAfterAt,
    });
  });
});

describe("Stripe manual provider-debt resolution", () => {
  it("requires a persisted reason, records only hashes, and replays one exact recovered customer", async () => {
    const t = createTest();
    const ownerId = "stripe-manual-customer-owner";
    const ownerGeneration = "manual-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 90,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "manual-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 1_000,
    });
    const resolution = {
      ownerId,
      ownerGeneration,
      operationId,
      resolutionId: "manual-customer-resolution",
      expectedStep: "customer_create" as const,
      expectedAttemptId: marked.attemptId,
      resolution: {
        kind: "recovered_customer" as const,
        stripeCustomerId: "cus_manual_recovered",
      },
      resolvedBy: "operator@example.test",
      evidence: "Stripe support ticket STRIPE-123 confirms this customer.",
    };
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...resolution,
        now: marked.quiescentAfterAt,
      }),
    ).rejects.toThrow(/has not reached an audited manual state/u);

    const claim = await t.mutation(claimReconcileCommand, {
      operationId,
      attemptId: marked.attemptId,
      claimId: "manual-customer-claim",
      now: marked.quiescentAfterAt,
    });
    expect(claim).not.toBeNull();
    await t.mutation(recordManualDebt, {
      operationId,
      attemptId: marked.attemptId,
      claimId: "manual-customer-claim",
      reason: "customer_lookup_unavailable",
      now: marked.quiescentAfterAt + 1,
    });

    const { expectedAttemptId: _expectedAttemptId, ...missingAttempt } =
      resolution;
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...missingAttempt,
        now: marked.quiescentAfterAt + 2,
      }),
    ).rejects.toThrow(/exact physical attempt/u);
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...resolution,
        expectedAttemptId: "wrong-manual-customer-attempt",
        now: marked.quiescentAfterAt + 2,
      }),
    ).rejects.toThrow(/exact physical attempt/u);

    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...resolution,
        now: marked.quiescentAfterAt + 2,
      }),
    ).resolves.toEqual({ resolution: "recovered_customer", replayed: false });
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...resolution,
        now: marked.quiescentAfterAt + 3,
      }),
    ).resolves.toEqual({ resolution: "recovered_customer", replayed: true });
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...resolution,
        evidence: "A different Stripe support record.",
        now: marked.quiescentAfterAt + 4,
      }),
    ).rejects.toThrow(/does not match its audit/u);

    const snapshot = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      audit: await ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", "manual-customer-resolution"),
        )
        .unique(),
      profile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    }));
    expect(snapshot.operation).toMatchObject({
      state: "reserved",
      dispatchState: "idle",
      stripeCustomerId: "cus_manual_recovered",
      lastStripeAttemptId: "manual-customer-attempt",
      lastStripeProviderDeadlineAt: marked.providerDeadlineAt,
      lastStripeDisposition: "succeeded",
    });
    expect(snapshot.profile?.stripeCustomerId).toBe("cus_manual_recovered");
    expect(snapshot.audit).toMatchObject({
      operationId,
      debtKey: "attempt:manual-customer-attempt:customer_lookup_unavailable",
      debtReason: "customer_lookup_unavailable",
      step: "customer_create",
      resolution: "recovered_customer",
      locatorHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      resolvedByHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(snapshot.audit).not.toHaveProperty("resolvedBy");
    expect(snapshot.audit).not.toHaveProperty("evidence");
    expect(snapshot.audit).not.toHaveProperty("stripeCustomerId");
    expect(snapshot.audit?.resolvedByHash).not.toBe(
      snapshot.audit?.evidenceHash,
    );
  });

  it("allows an exact resolution replay at the audit cap but rejects the next distinct proof atomically", async () => {
    const t = createTest();
    const ownerId = "stripe-resolution-cap-owner";
    const ownerGeneration = "stripe-resolution-cap-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 704,
    });
    const debt = await markAndPersistManualDebt(t, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "stripe-resolution-cap-active-attempt",
      claimId: "stripe-resolution-cap-active-claim",
      step: "customer_create",
      reason: "customer_lookup_unavailable",
      now: TEST_CLOCK + 1_500,
    });
    const replayResolution = {
      ownerId,
      ownerGeneration,
      operationId,
      resolutionId: "stripe-resolution-cap-existing",
      expectedStep: "customer_create" as const,
      expectedAttemptId: "stripe-resolution-cap-existing-attempt",
      resolution: { kind: "provider_confirmed_not_created" as const },
      resolvedBy: "operator@example.test",
      evidence: "Existing immutable resolution proof at the capacity boundary.",
    };
    const [resolvedByHash, evidenceHash] = await Promise.all([
      stripeResolutionAuditHash("operator", replayResolution.resolvedBy),
      stripeResolutionAuditHash("evidence", replayResolution.evidence),
    ]);
    await t.run(async (ctx) => {
      for (let index = 0; index < 513; index += 1) {
        const isReplay = index === 0;
        const attemptId = isReplay
          ? replayResolution.expectedAttemptId
          : `stripe-resolution-cap-history-${index}`;
        await ctx.db.insert("billing_stripe_operation_resolutions", {
          ownerId,
          ownerGeneration,
          operationId,
          resolutionId: isReplay
            ? replayResolution.resolutionId
            : `stripe-resolution-cap-history-${index}`,
          debtKey: `attempt:${attemptId}:customer_lookup_unavailable`,
          attemptId,
          step: "customer_create",
          resolution: "provider_confirmed_not_created",
          debtReason: "customer_lookup_unavailable",
          resolvedByHash: isReplay ? resolvedByHash : hex64(1_100_000 + index),
          evidenceHash: isReplay ? evidenceHash : hex64(1_200_000 + index),
          resolvedAt: index,
        });
      }
    });

    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...replayResolution,
        now: debt.marked.quiescentAfterAt + 2,
      }),
    ).resolves.toEqual({
      resolution: "provider_confirmed_not_created",
      replayed: true,
    });
    const before = await readOperation(t, operationId);
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId,
        resolutionId: "stripe-resolution-cap-overflow",
        expectedStep: "customer_create",
        expectedAttemptId: debt.marked.attemptId,
        resolution: { kind: "provider_confirmed_not_created" },
        resolvedBy: "operator@example.test",
        evidence: "This 514th proof must never be committed.",
        now: debt.marked.quiescentAfterAt + 3,
      }),
    ).rejects.toThrow(/resolution audit capacity/iu);
    expect(await readOperation(t, operationId)).toEqual(before);
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_operationId_and_resolvedAt", (q) =>
            q.eq("operationId", operationId),
          )
          .collect(),
      ),
    ).resolves.toHaveLength(513);
  }, 30_000);

  it("requires exact Checkout/Portal locator shapes and supports a no-create attestation", async () => {
    const t = createTest();
    const ownerId = "stripe-manual-shapes-owner";
    const ownerGeneration = "manual-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { stripeCustomerId: "cus_manual_shapes" });

    const checkoutId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 91,
      stripeCustomerId: "cus_manual_shapes",
    });
    const checkoutDebt = await markAndPersistManualDebt(t, {
      ownerId,
      ownerGeneration,
      operationId: checkoutId,
      attemptId: "manual-checkout-attempt",
      claimId: "manual-checkout-claim",
      step: "checkout_create",
      reason: "checkout_lookup_unavailable",
      now: TEST_CLOCK + 2_000,
    });
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId: checkoutId,
        resolutionId: "manual-checkout-wrong-shape",
        expectedStep: "checkout_create",
        expectedAttemptId: checkoutDebt.marked.attemptId,
        resolution: {
          kind: "recovered_customer",
          stripeCustomerId: "cus_manual_shapes",
        },
        resolvedBy: "operator@example.test",
        evidence: "Wrong shape must not settle Checkout debt.",
        now: checkoutDebt.marked.quiescentAfterAt + 2,
      }),
    ).rejects.toThrow(/locator shape is invalid/u);
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId: checkoutId,
        resolutionId: "manual-checkout-resolution",
        expectedStep: "checkout_create",
        expectedAttemptId: checkoutDebt.marked.attemptId,
        resolution: {
          kind: "recovered_checkout",
          stripeCustomerId: "cus_manual_shapes",
          stripeCheckoutSessionId: "cs_manual_recovered",
        },
        resolvedBy: "operator@example.test",
        evidence: "Stripe support located the exact Checkout session.",
        now: checkoutDebt.marked.quiescentAfterAt + 3,
      }),
    ).resolves.toEqual({ resolution: "recovered_checkout", replayed: false });

    const portalId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 92,
      kind: "billing_portal",
      stripeCustomerId: "cus_manual_shapes",
    });
    const portalDebt = await markAndPersistManualDebt(t, {
      ownerId,
      ownerGeneration,
      operationId: portalId,
      attemptId: "manual-portal-attempt",
      claimId: "manual-portal-claim",
      step: "portal_create",
      reason: "portal_lookup_unavailable",
      now: TEST_CLOCK + 3_000,
    });
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId: portalId,
        resolutionId: "manual-portal-resolution",
        expectedStep: "portal_create",
        expectedAttemptId: portalDebt.marked.attemptId,
        resolution: {
          kind: "recovered_portal",
          stripeCustomerId: "cus_manual_shapes",
          stripePortalSessionId: "bps_manual_recovered",
        },
        resolvedBy: "operator@example.test",
        evidence: "Stripe support located the exact Portal session.",
        now: portalDebt.marked.quiescentAfterAt + 2,
      }),
    ).resolves.toEqual({ resolution: "recovered_portal", replayed: false });

    const noCreateOwnerId = "stripe-manual-no-create-owner";
    const noCreateGeneration = "stripe-manual-no-create-generation";
    await seedActiveOwner(t, noCreateOwnerId, noCreateGeneration);
    await seedProfile(t, noCreateOwnerId);
    const notCreatedId = await seedOperation(t, {
      ownerId: noCreateOwnerId,
      ownerGeneration: noCreateGeneration,
      index: 93,
    });
    const notCreatedDebt = await markAndPersistManualDebt(t, {
      ownerId: noCreateOwnerId,
      ownerGeneration: noCreateGeneration,
      operationId: notCreatedId,
      attemptId: "manual-not-created-attempt",
      claimId: "manual-not-created-claim",
      step: "customer_create",
      reason: "customer_lookup_unavailable",
      now: TEST_CLOCK + 4_000,
    });
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ownerId: noCreateOwnerId,
        ownerGeneration: noCreateGeneration,
        operationId: notCreatedId,
        resolutionId: "manual-not-created-resolution",
        expectedStep: "customer_create",
        expectedAttemptId: notCreatedDebt.marked.attemptId,
        resolution: { kind: "provider_confirmed_not_created" },
        resolvedBy: "operator@example.test",
        evidence: "Stripe confirmed no customer was created.",
        now: notCreatedDebt.marked.quiescentAfterAt + 2,
      }),
    ).resolves.toEqual({
      resolution: "provider_confirmed_not_created",
      replayed: false,
    });

    const rows = await Promise.all(
      [checkoutId, portalId, notCreatedId].map((operationId) =>
        readOperation(t, operationId),
      ),
    );
    expect(rows[0]).toMatchObject({
      state: "provider_succeeded",
      stripeCheckoutSessionId: "cs_manual_recovered",
    });
    expect(rows[1]).toMatchObject({
      state: "provider_succeeded",
      stripePortalSessionId: "bps_manual_recovered",
    });
    expect(rows[2]).toMatchObject({ state: "reserved", dispatchState: "idle" });

    await expect(
      t.mutation(settleStripeOperation, {
        ...exactTuple(
          noCreateOwnerId,
          noCreateGeneration,
          notCreatedId,
          "customer_create",
          notCreatedDebt.marked,
        ),
        stripeCustomerId: "cus_manual_not_created_late_success",
        now: notCreatedDebt.marked.quiescentAfterAt + 4,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    const lateSnapshot = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", notCreatedId))
        .unique(),
      lateResult: await ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_operationId_and_attemptId", (q) =>
          q
            .eq("operationId", notCreatedId)
            .eq("attemptId", notCreatedDebt.marked.attemptId),
        )
        .unique(),
      physicalReceipts: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", notCreatedId))
        .collect(),
    }));
    expect(lateSnapshot.operation).toMatchObject({
      manualDebtReason: "late_result_conflict",
      lateResultStripeCustomerId: "cus_manual_not_created_late_success",
    });
    expect(lateSnapshot.lateResult).toMatchObject({
      attemptId: notCreatedDebt.marked.attemptId,
      stripeCustomerId: "cus_manual_not_created_late_success",
    });
    expect(lateSnapshot.physicalReceipts).toHaveLength(1);
  });

  it("keeps a legacy manual recovery receipt unbound until the provider callback arrives", async () => {
    const t = createTest();
    const ownerId = "legacy-manual-unbound-owner";
    const ownerGeneration = "legacy-manual-unbound-generation";
    const stripeCustomerId = "cus_legacy_manual_unbound";
    const operationId = "legacy-manual-unbound-operation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { stripeCustomerId });
    await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 93,
      stripeCustomerId,
    });
    const debt = await markAndPersistManualDebt(t, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "legacy-manual-unbound-attempt",
      claimId: "legacy-manual-unbound-claim",
      step: "checkout_create",
      reason: "checkout_lookup_unavailable",
      now: TEST_CLOCK + 4_000,
    });
    await t.mutation(resolveStripeManualDebt, {
      ownerId,
      ownerGeneration,
      operationId,
      resolutionId: "legacy-manual-unbound-resolution",
      expectedStep: "checkout_create",
      expectedAttemptId: debt.marked.attemptId,
      resolution: {
        kind: "recovered_checkout",
        stripeCustomerId,
        stripeCheckoutSessionId: "cs_operator_recovered",
      },
      resolvedBy: "operator@example.test",
      evidence: "Operator recovered a canonical Checkout locator.",
      now: debt.marked.quiescentAfterAt + 2,
    });
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      const receipt = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      await ctx.db.patch(operation!._id, { integrityVersion: 2 });
      await ctx.db.patch(receipt!._id, { successLocatorHash: undefined });
    });
    const purge = await beginPurge(t, ownerId, "delete");
    const normalized = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: debt.marked.quiescentAfterAt + 3,
    });
    expect(normalized.pending).not.toContain(
      `stripe_operation_malformed:${operationId}`,
    );
    const unboundReceipt = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
    );
    expect(unboundReceipt?.successLocatorHash).toBeUndefined();
    await expect(
      t.mutation(settleStripeOperation, {
        ...exactTuple(
          ownerId,
          ownerGeneration,
          operationId,
          "checkout_create",
          debt.marked,
        ),
        stripeCustomerId,
        stripeCheckoutSessionId: "cs_actual_provider_result",
        now: debt.marked.quiescentAfterAt + 4,
      }),
    ).resolves.toMatchObject({ recorded: true, customerDeleted: true });
    const expectedResultHash = await hashStripePhysicalSuccessLocators({
      stripeCustomerId,
      stripeCheckoutSessionId: "cs_actual_provider_result",
    });
    const boundReceipt = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
    );
    expect(boundReceipt?.successLocatorHash).toBe(expectedResultHash);
  });

  it("routes a post-capture late success through global cleanup before and after operation deletion", async () => {
    const t = createTest();
    const ownerId = "post-capture-late-success-owner";
    const ownerGeneration = "post-capture-late-success-generation";
    const wallNow = Date.now();
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 94,
    });
    const debt = await markAndPersistManualDebt(t, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "post-capture-late-attempt",
      claimId: "post-capture-late-claim",
      step: "customer_create",
      reason: "customer_lookup_unavailable",
      now: wallNow - 60_000,
    });
    await t.mutation(resolveStripeManualDebt, {
      ownerId,
      ownerGeneration,
      operationId,
      resolutionId: "post-capture-not-created-resolution",
      expectedStep: "customer_create",
      expectedAttemptId: debt.marked.attemptId,
      resolution: { kind: "provider_confirmed_not_created" },
      resolvedBy: "operator@example.test",
      evidence:
        "Stripe confirmed the original customer request created nothing.",
      now: debt.marked.quiescentAfterAt + 2,
    });

    const purge = await beginPurge(t, ownerId, "delete");
    for (const source of [
      "profile",
      "purchases",
      "invoices",
      "events",
      "operations",
    ] as const) {
      await t.mutation(
        internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
        {
          ...purge,
          source,
          now: debt.marked.quiescentAfterAt + 3,
        },
      );
    }
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_owner_deletion_debts")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
      ),
    ).resolves.toMatchObject({ operationsCaptured: true });

    const tuple = exactTuple(
      ownerId,
      ownerGeneration,
      operationId,
      "customer_create",
      debt.marked,
    );
    const lateSuccess = {
      ...tuple,
      stripeCustomerId: "cus_post_capture_late",
    };
    await expect(
      t.mutation(settleStripeOperation, {
        ...lateSuccess,
        now: debt.marked.quiescentAfterAt + 4,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: true,
    });
    const afterFirstCallback = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      lateResults: await ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_operationId_and_createdAt", (q) =>
          q.eq("operationId", operationId),
        )
        .collect(),
      cleanup: await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .filter((q) => q.eq(q.field("locatorValue"), "cus_post_capture_late"))
        .unique(),
    }));
    expect(afterFirstCallback.operation).toMatchObject({
      state: "provider_succeeded",
      dispatchState: "idle",
      terminalizedWithoutProviderDispatch: true,
    });
    expect(afterFirstCallback.operation?.manualDebtReason).toBe(
      "late_result_conflict",
    );
    expect(afterFirstCallback.lateResults).toHaveLength(1);
    expect(afterFirstCallback.cleanup).toMatchObject({
      locatorKind: "customer",
      locatorValue: "cus_post_capture_late",
    });
    await expect(
      t.mutation(settleStripeOperation, {
        ...lateSuccess,
        now: debt.marked.quiescentAfterAt + 5,
      }),
    ).resolves.toEqual({
      recorded: false,
      duplicate: true,
      customerDeleted: true,
    });

    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        expect(url).toContain("/v1/customers/cus_post_capture_late");
        expect(["GET", "DELETE"]).toContain(method);
        return new Response(
          JSON.stringify({
            id: "cus_post_capture_late",
            object: "customer",
            deleted: method === "DELETE",
            metadata: { ownerId },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "request-id": "req_post_capture_late_cleanup",
            },
          },
        );
      },
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_post_capture_late_cleanup";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(
        internal.stripe_operation_dispatch.drainLateStripeCleanupInternal,
        {},
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    const cleanupMethods = providerFetch.mock.calls.map(([input, init]) =>
      input instanceof Request ? input.method : (init?.method ?? "GET"),
    );
    expect(cleanupMethods).toContain("GET");
    expect(cleanupMethods).toContain("DELETE");
    await expect(
      t.run(async (ctx) => ({
        pending: await ctx.db
          .query("billing_stripe_late_cleanup_locators")
          .withIndex("by_locatorHash", (q) =>
            q.eq("locatorHash", afterFirstCallback.cleanup!.locatorHash),
          )
          .unique(),
        terminal: await ctx.db
          .query("billing_stripe_deletion_tombstones")
          .withIndex("by_locatorHash", (q) =>
            q.eq("locatorHash", afterFirstCallback.cleanup!.locatorHash),
          )
          .unique(),
      })),
    ).resolves.toMatchObject({
      pending: null,
      terminal: { locatorKind: "customer" },
    });
    const afterCleanup = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      lateResults: await ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_operationId_and_createdAt", (q) =>
          q.eq("operationId", operationId),
        )
        .collect(),
    }));
    expect(afterCleanup.operation?.manualDebtReason).toBeUndefined();
    expect(afterCleanup.lateResults).toEqual([]);
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...purge, table: "billing_stripe_operations" },
      ),
    ).rejects.toThrow(/lifecycle audit/iu);
    await expect(
      t.mutation(quiesceForPurge, {
        ...purge,
        mode: "delete",
        now: debt.marked.quiescentAfterAt + 6,
      }),
    ).resolves.toEqual({ ready: true, pending: [], retryAt: null });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...purge, table: "billing_stripe_operations" },
      ),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    const afterOperationDelete = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      tombstone: await ctx.db
        .query("billing_stripe_operation_tombstones")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      receipts: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .collect(),
    }));
    expect(afterOperationDelete.operation).toBeNull();
    expect(afterOperationDelete.tombstone).not.toBeNull();
    expect(afterOperationDelete.receipts).toHaveLength(1);
    await expect(
      t.mutation(settleStripeOperation, {
        ...lateSuccess,
        now: debt.marked.quiescentAfterAt + 7,
      }),
    ).resolves.toEqual({
      recorded: false,
      duplicate: true,
      customerDeleted: true,
    });
    await expect(
      t.mutation(settleStripeOperation, {
        ...lateSuccess,
        stripeCustomerId: "cus_post_capture_changed",
        now: debt.marked.quiescentAfterAt + 8,
      }),
    ).rejects.toThrow(/different locators/iu);

    await t.mutation(
      internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
      { ...purge, table: "billing_stripe_operation_resolutions" },
    );
    await t.mutation(
      internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
      { ...purge, table: "billing_profiles" },
    );
    await expect(
      t.mutation(
        internal.account_billing_purge.finishOwnerBillingPurgeInternal,
        purge,
      ),
    ).resolves.toBe(true);
    await expect(
      t.query(internal.account_billing_purge.remainingOwnerBillingInternal, {
        ownerId,
      }),
    ).resolves.toEqual([]);
  });

  it("records a Checkout late result with more than 1024 shared-customer cleanup rows", async () => {
    const t = createTest();
    const ownerId = "shared-customer-fanout-owner";
    const ownerGeneration = "shared-customer-fanout-generation";
    const stripeCustomerId = "cus_shared_customer_fanout";
    const stripeCheckoutSessionId = "cs_shared_customer_fanout";
    const wallNow = Date.now();
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { stripeCustomerId });
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 140,
      stripeCustomerId,
    });
    const debt = await markAndPersistManualDebt(t, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "shared-customer-fanout-attempt",
      claimId: "shared-customer-fanout-claim",
      step: "checkout_create",
      reason: "checkout_lookup_unavailable",
      now: wallNow - 60_000,
    });
    await t.mutation(resolveStripeManualDebt, {
      ownerId,
      ownerGeneration,
      operationId,
      resolutionId: "shared-customer-fanout-not-created",
      expectedStep: "checkout_create",
      expectedAttemptId: debt.marked.attemptId,
      resolution: { kind: "provider_confirmed_not_created" },
      resolvedBy: "operator@example.test",
      evidence:
        "Stripe confirmed the original Checkout request created nothing.",
      now: debt.marked.quiescentAfterAt + 2,
    });
    const purge = await beginPurge(t, ownerId, "delete");
    for (const source of [
      "profile",
      "purchases",
      "invoices",
      "events",
      "operations",
    ] as const) {
      await t.mutation(
        internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
        {
          ...purge,
          source,
          now: debt.marked.quiescentAfterAt + 3,
        },
      );
    }
    const [ownerHash, customerLocatorHash] = await Promise.all([
      ownershipMigrationSourceDigest(ownerId),
      hashStripeBillingLocator("customer", stripeCustomerId),
    ]);
    await t.run(async (ctx) => {
      for (let index = 0; index < 1_025; index += 1) {
        await ctx.db.insert("billing_stripe_late_cleanup_locators", {
          tupleHash: hex64(10_000 + index),
          ownerHash,
          providerOwnerHash: ownerHash,
          successLocatorHash: hex64(20_000 + index),
          locatorHash: customerLocatorHash,
          locatorKind: "customer",
          locatorValue: stripeCustomerId,
          successStripeCustomerId: stripeCustomerId,
          checkoutBlocked: false,
          attempts: 0,
          nextAttemptAt: TEST_CLOCK,
          createdAt: index,
          updatedAt: index,
        });
      }
    });
    await expect(
      t.mutation(settleStripeOperation, {
        ...exactTuple(
          ownerId,
          ownerGeneration,
          operationId,
          "checkout_create",
          debt.marked,
        ),
        stripeCustomerId,
        stripeCheckoutSessionId,
        now: debt.marked.quiescentAfterAt + 4,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: true,
    });
    const productionCleanup = await t.run(async (ctx) => {
      const receipt = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      return ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", receipt!.tupleHash))
        .collect();
    });
    expect(productionCleanup).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locatorKind: "checkout_session",
          locatorValue: stripeCheckoutSessionId,
        }),
        expect.objectContaining({
          locatorKind: "customer",
          locatorValue: stripeCustomerId,
          checkoutBlocked: true,
        }),
      ]),
    );
  });

  it("turns not-created then exact late success into durable debt without sliding its boundary", async () => {
    const t = createTest();
    const ownerId = "late-customer-owner";
    const ownerGeneration = "late-customer-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 100,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "late-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 10_000,
    });
    const tuple = exactTuple(
      ownerId,
      ownerGeneration,
      operationId,
      "customer_create",
      marked,
    );
    await expect(
      t.mutation(settleStripeOperationNotCreated, {
        ...tuple,
        now: TEST_CLOCK + 10_100,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    await expect(
      t.mutation(settleStripeOperation, {
        ...tuple,
        stripeCustomerId: "cus_late_exact",
        now: TEST_CLOCK + 10_101,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    const firstDebt = await readOperation(t, operationId);
    expect(firstDebt).toMatchObject({
      state: "reserved",
      manualDebtReason: "late_result_conflict",
      lateResultConflictStep: "customer_create",
      lateResultConflictAttemptId: marked.attemptId,
      lateResultStripeCustomerId: "cus_late_exact",
      lateResultConflictQuiescentAfterAt: TEST_CLOCK + 10_101,
    });

    await expect(
      t.mutation(settleStripeOperation, {
        ...tuple,
        stripeCustomerId: "cus_late_exact",
        now: TEST_CLOCK + 20_000,
      }),
    ).resolves.toEqual({
      recorded: false,
      duplicate: true,
      customerDeleted: false,
    });
    const repeatedDebt = await readOperation(t, operationId);
    expect(repeatedDebt?.lateResultConflictQuiescentAfterAt).toBe(
      firstDebt?.lateResultConflictQuiescentAfterAt,
    );
    await expect(
      t.query(remainingDispatches, { ownerId, now: TEST_CLOCK + 20_000 }),
    ).resolves.toContain(
      `stripe_operation_manual_reconciliation:late_result_conflict:${operationId}`,
    );

    // Model the pre-ledger rollout after the projected singleton was stored
    // but before its receipt/ledger rows committed. Resolution must
    // materialize them first, then prove every receipt before promoting v3.
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      const lateRows = await ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_operationId_and_createdAt", (q) =>
          q.eq("operationId", operationId),
        )
        .collect();
      const receipts = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .collect();
      for (const row of lateRows) await ctx.db.delete(row._id);
      for (const row of receipts) await ctx.db.delete(row._id);
      await ctx.db.patch(operation!._id, { integrityVersion: 2 });
    });

    await expect(
      t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId,
        resolutionId: "late-customer-ack",
        expectedStep: "customer_create",
        expectedAttemptId: marked.attemptId,
        resolution: {
          kind: "recovered_customer",
          stripeCustomerId: "cus_late_exact",
        },
        resolvedBy: "operator@example.test",
        evidence:
          "The delayed exact provider response was independently verified.",
        now: TEST_CLOCK + 20_001,
      }),
    ).resolves.toEqual({ resolution: "recovered_customer", replayed: false });
    const resolved = await readOperation(t, operationId);
    expect(resolved).toMatchObject({
      lastStripeStep: "customer_create",
      lastStripeAttemptId: marked.attemptId,
      lastStripeRequestFingerprint: marked.requestFingerprint,
      lastStripeIdempotencyKey: marked.idempotencyKey,
      lastStripeProviderDeadlineAt: marked.providerDeadlineAt,
      lastStripeDisposition: "succeeded",
      stripeCustomerId: "cus_late_exact",
    });
    expect(resolved?.manualDebtReason).toBeUndefined();
    const reboundReceipt = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
    );
    await expect(ownershipMigrationSourceDigest(ownerId)).resolves.toBe(
      reboundReceipt?.providerOwnerHash,
    );
    expect(reboundReceipt?.successLocatorHash).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      t.mutation(settleStripeOperation, {
        ...tuple,
        stripeCustomerId: "cus_late_exact",
        now: TEST_CLOCK + 20_002,
      }),
    ).resolves.toEqual({
      recorded: false,
      duplicate: true,
      customerDeleted: false,
    });
    expect(
      (await readOperation(t, operationId))?.manualDebtReason,
    ).toBeUndefined();
  });

  it.each(["provider_succeeded", "completed"] as const)(
    "retains both recovered Checkout locators when a late result contradicts a %s receipt",
    async (startingState) => {
      const t = createTest();
      const ownerId = `different-checkout-${startingState}`;
      const ownerGeneration = "different-checkout-generation";
      await seedActiveOwner(t, ownerId, ownerGeneration);
      await seedProfile(t, ownerId, {
        stripeCustomerId: "cus_checkout_owner",
      });
      const operationId = await seedOperation(t, {
        ownerId,
        ownerGeneration,
        index: startingState === "completed" ? 111 : 110,
        stripeCustomerId: "cus_checkout_owner",
      });
      const debt = await markAndPersistManualDebt(t, {
        ownerId,
        ownerGeneration,
        operationId,
        attemptId: `different-checkout-${startingState}-attempt`,
        claimId: `different-checkout-${startingState}-claim`,
        step: "checkout_create",
        reason: "checkout_lookup_unavailable",
        now: TEST_CLOCK + 30_000,
      });
      await t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId,
        resolutionId: `different-checkout-${startingState}-recovered`,
        expectedStep: "checkout_create",
        expectedAttemptId: debt.marked.attemptId,
        resolution: {
          kind: "recovered_checkout",
          stripeCustomerId: "cus_checkout_owner",
          stripeCheckoutSessionId: "cs_recovered_first",
        },
        resolvedBy: "operator@example.test",
        evidence: "First reconciliation found the original Checkout session.",
        now: debt.marked.quiescentAfterAt + 2,
      });
      if (startingState === "completed") {
        await expect(
          t.mutation(completeStripeOperation, {
            ownerId,
            ownerGeneration,
            operationId,
            now: debt.marked.quiescentAfterAt + 3,
          }),
        ).resolves.toBe(true);
      }
      expect((await readOperation(t, operationId))?.state).toBe(startingState);

      await expect(
        t.mutation(settleStripeOperation, {
          ...exactTuple(
            ownerId,
            ownerGeneration,
            operationId,
            "checkout_create",
            debt.marked,
          ),
          stripeCustomerId: "cus_checkout_owner",
          stripeCheckoutSessionId: "cs_late_actual",
          now: debt.marked.quiescentAfterAt + 4,
        }),
      ).resolves.toEqual({
        recorded: true,
        duplicate: false,
        customerDeleted: false,
      });
      expect(await readOperation(t, operationId)).toMatchObject({
        state: startingState,
        stripeCheckoutSessionId: "cs_recovered_first",
        lateResultStripeCheckoutSessionId: "cs_late_actual",
        manualDebtReason: "late_result_conflict",
      });

      await t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId,
        resolutionId: `different-checkout-${startingState}-late-ack`,
        expectedStep: "checkout_create",
        expectedAttemptId: debt.marked.attemptId,
        resolution: {
          kind: "recovered_checkout",
          stripeCustomerId: "cus_checkout_owner",
          stripeCheckoutSessionId: "cs_late_actual",
        },
        resolvedBy: "operator@example.test",
        evidence: "The exact delayed response supersedes the first recovery.",
        now: debt.marked.quiescentAfterAt + 5,
      });
      expect(await readOperation(t, operationId)).toMatchObject({
        state: startingState,
        stripeCheckoutSessionId: "cs_recovered_first",
        lastStripeDisposition: "succeeded",
      });
      const cleanup = await t.run(
        async (ctx) =>
          await ctx.db
            .query("billing_stripe_late_cleanup_locators")
            .filter((q) => q.eq(q.field("locatorValue"), "cs_late_actual"))
            .unique(),
      );
      expect(cleanup).toMatchObject({ locatorKind: "checkout_session" });
      await expect(
        t.run(
          async (ctx) =>
            await ctx.db
              .query("billing_stripe_late_results")
              .withIndex("by_operationId_and_createdAt", (q) =>
                q.eq("operationId", operationId),
              )
              .first(),
        ),
      ).resolves.toBeNull();
    },
  );

  it("resolves same-locator results from two physical attempts independently", async () => {
    const t = createTest();
    const ownerId = "same-locator-multi-attempt";
    const ownerGeneration = "same-locator-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, {
      stripeCustomerId: "cus_same_locator",
    });
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 118,
      stripeCustomerId: "cus_same_locator",
    });
    const requestJson = JSON.stringify({ metadata: { ownerId } });
    const attemptA = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "same-locator-attempt-a",
      step: "checkout_create",
      requestJson,
      now: TEST_CLOCK + 40_000,
    });
    const tupleA = exactTuple(
      ownerId,
      ownerGeneration,
      operationId,
      "checkout_create",
      attemptA,
    );
    await t.mutation(settleStripeOperationNotCreated, {
      ...tupleA,
      now: attemptA.quiescentAfterAt,
    });
    const attemptB = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "same-locator-attempt-b",
      step: "checkout_create",
      requestJson,
      now: attemptA.quiescentAfterAt + 1,
    });
    const tupleB = exactTuple(
      ownerId,
      ownerGeneration,
      operationId,
      "checkout_create",
      attemptB,
    );
    const observed = {
      stripeCustomerId: "cus_same_locator",
      stripeCheckoutSessionId: "cs_same_late",
    };
    await t.mutation(settleStripeOperation, {
      ...tupleA,
      ...observed,
      now: attemptA.quiescentAfterAt + 2,
    });
    await t.mutation(settleStripeOperation, {
      ...tupleB,
      ...observed,
      now: attemptA.quiescentAfterAt + 3,
    });
    const pendingAttempts = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("billing_stripe_late_results")
          .withIndex("by_operationId_and_createdAt", (q) =>
            q.eq("operationId", operationId),
          )
          .collect()
      ).map((row) => row.attemptId),
    );
    expect(pendingAttempts).toEqual(["same-locator-attempt-a"]);

    await expect(
      t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId,
        resolutionId: "same-locator-resolution-a",
        expectedStep: "checkout_create",
        expectedAttemptId: "same-locator-attempt-a",
        resolution: {
          kind: "recovered_checkout",
          ...observed,
        },
        resolvedBy: "operator@example.test",
        evidence: "The exact older physical tuple was verified independently.",
        now: attemptA.quiescentAfterAt + 4,
      }),
    ).resolves.toEqual({ resolution: "recovered_checkout", replayed: false });
    expect(await readOperation(t, operationId)).toMatchObject({
      stripeCheckoutSessionId: "cs_same_late",
    });
    expect(
      (await readOperation(t, operationId))?.manualDebtReason,
    ).toBeUndefined();
    await expect(
      t.run(
        async (ctx) =>
          await ctx.db
            .query("billing_stripe_late_results")
            .withIndex("by_operationId_and_createdAt", (q) =>
              q.eq("operationId", operationId),
            )
            .collect(),
      ),
    ).resolves.toEqual([]);
    await expect(
      t.mutation(settleStripeOperation, {
        ...tupleA,
        ...observed,
        now: attemptA.quiescentAfterAt + 5,
      }),
    ).resolves.toEqual({
      recorded: false,
      duplicate: true,
      customerDeleted: false,
    });
  });

  it("acknowledges an ancillary late customer result without replacing terminal Checkout history", async () => {
    const t = createTest();
    const ownerId = "ancillary-customer-late-owner";
    const ownerGeneration = "ancillary-customer-late-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 119,
    });

    const customerMark = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "ancillary-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId, operationId } }),
      now: TEST_CLOCK + 50_000,
    });
    const customerTuple = exactTuple(
      ownerId,
      ownerGeneration,
      operationId,
      "customer_create",
      customerMark,
    );
    await t.mutation(settleStripeOperation, {
      ...customerTuple,
      stripeCustomerId: "cus_ancillary_late",
      now: TEST_CLOCK + 50_001,
    });

    const checkoutMark = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "ancillary-checkout-attempt",
      step: "checkout_create",
      requestJson: JSON.stringify({
        customer: "cus_ancillary_late",
        metadata: { stellaOperationId: operationId },
      }),
      now: TEST_CLOCK + 50_002,
    });
    await t.mutation(settleStripeOperation, {
      ...exactTuple(
        ownerId,
        ownerGeneration,
        operationId,
        "checkout_create",
        checkoutMark,
      ),
      stripeCustomerId: "cus_ancillary_late",
      stripeCheckoutSessionId: "cs_ancillary_terminal",
      now: TEST_CLOCK + 50_003,
    });
    await expect(
      t.mutation(completeStripeOperation, {
        ownerId,
        ownerGeneration,
        operationId,
        now: TEST_CLOCK + 50_004,
      }),
    ).resolves.toBe(true);

    await expect(
      t.mutation(settleStripeOperation, {
        ...customerTuple,
        stripeCustomerId: "cus_ancillary_late",
        now: TEST_CLOCK + 50_005,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ownerId,
        ownerGeneration,
        operationId,
        resolutionId: "ancillary-customer-late-resolution",
        expectedStep: "customer_create",
        expectedAttemptId: customerMark.attemptId,
        resolution: {
          kind: "recovered_customer",
          stripeCustomerId: "cus_ancillary_late",
        },
        resolvedBy: "operator@example.test",
        evidence:
          "The delayed customer response names the customer already used by the terminal Checkout.",
        now: TEST_CLOCK + 50_006,
      }),
    ).resolves.toEqual({ resolution: "recovered_customer", replayed: false });

    expect(await readOperation(t, operationId)).toMatchObject({
      state: "completed",
      stripeCustomerId: "cus_ancillary_late",
      stripeCheckoutSessionId: "cs_ancillary_terminal",
      lastStripeStep: "checkout_create",
      lastStripeAttemptId: checkoutMark.attemptId,
      lastStripeDisposition: "succeeded",
      dispatchState: "idle",
    });
    await expect(
      t.mutation(completeStripeOperation, {
        ownerId,
        ownerGeneration,
        operationId,
        now: TEST_CLOCK + 50_007,
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(settleStripeOperation, {
        ...customerTuple,
        stripeCustomerId: "cus_ancillary_late",
        now: TEST_CLOCK + 50_008,
      }),
    ).resolves.toEqual({
      recorded: false,
      duplicate: true,
      customerDeleted: false,
    });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_late_results")
          .withIndex("by_operationId_and_createdAt", (q) =>
            q.eq("operationId", operationId),
          )
          .collect(),
      ),
    ).resolves.toEqual([]);
  });

  it("captures a source-owner customer result after an ownership move without false metadata adoption", async () => {
    const t = createTest();
    const sourceOwnerId = "late-customer-source";
    const destinationOwnerId = "late-customer-destination";
    const sourceGeneration = "source-generation";
    const destinationGeneration = "destination-generation";
    await seedActiveOwner(t, sourceOwnerId, sourceGeneration);
    await seedActiveOwner(t, destinationOwnerId, destinationGeneration);
    await seedProfile(t, sourceOwnerId);
    await seedProfile(t, destinationOwnerId);
    const operationId = await seedOperation(t, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      index: 119,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId: sourceOwnerId,
      ownerGeneration: sourceGeneration,
      operationId,
      attemptId: "source-owner-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId: sourceOwnerId } }),
      now: TEST_CLOCK + 50_000,
    });
    const sourceTuple = exactTuple(
      sourceOwnerId,
      sourceGeneration,
      operationId,
      "customer_create",
      marked,
    );
    await t.mutation(settleStripeOperationNotCreated, {
      ...sourceTuple,
      now: marked.quiescentAfterAt,
    });
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      await ctx.db.patch(operation!._id, {
        ownerId: destinationOwnerId,
        ownerGeneration: destinationGeneration,
        updatedAt: marked.quiescentAfterAt + 1,
      });
    });
    await expect(
      t.mutation(settleStripeOperation, {
        ...sourceTuple,
        stripeCustomerId: "cus_created_for_source",
        now: marked.quiescentAfterAt + 2,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    const pending = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_stripe_late_results")
          .withIndex("by_operationId_and_attemptId", (q) =>
            q.eq("operationId", operationId).eq("attemptId", marked.attemptId),
          )
          .unique(),
    );
    expect(pending).toMatchObject({
      ownerId: destinationOwnerId,
      providerOwnerId: sourceOwnerId,
      stripeCustomerId: "cus_created_for_source",
    });
    await t.mutation(resolveStripeManualDebt, {
      ownerId: destinationOwnerId,
      ownerGeneration: destinationGeneration,
      operationId,
      resolutionId: "source-owner-customer-cleanup",
      expectedStep: "customer_create",
      expectedAttemptId: marked.attemptId,
      resolution: {
        kind: "recovered_customer",
        stripeCustomerId: "cus_created_for_source",
      },
      resolvedBy: "operator@example.test",
      evidence:
        "The customer was created under the retired source metadata owner.",
      now: marked.quiescentAfterAt + 3,
    });
    const destinationProfile = await t.run(
      async (ctx) =>
        await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", destinationOwnerId))
          .unique(),
    );
    expect(destinationProfile?.stripeCustomerId).toBe("");
    await expect(
      t.run(
        async (ctx) =>
          await ctx.db
            .query("billing_stripe_late_cleanup_locators")
            .filter((q) =>
              q.eq(q.field("locatorValue"), "cus_created_for_source"),
            )
            .unique(),
      ),
    ).resolves.toMatchObject({ locatorKind: "customer" });
  });

  it("captures an old-generation result after reset adoption under the current owner", async () => {
    const t = createTest();
    const ownerId = "late-reset-owner";
    const oldGeneration = "late-reset-old";
    const newGeneration = "late-reset-new";
    await seedActiveOwner(t, ownerId, oldGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration: oldGeneration,
      index: 120,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration: oldGeneration,
      operationId,
      attemptId: "old-generation-customer-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 55_000,
    });
    const oldTuple = exactTuple(
      ownerId,
      oldGeneration,
      operationId,
      "customer_create",
      marked,
    );
    await t.mutation(settleStripeOperationNotCreated, {
      ...oldTuple,
      now: marked.quiescentAfterAt,
    });
    await t.run(async (ctx) => {
      const [operation, lifecycle] = await Promise.all([
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique(),
        ctx.db
          .query("cloud_owner_lifecycles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
      ]);
      await ctx.db.patch(operation!._id, {
        ownerGeneration: newGeneration,
        updatedAt: marked.quiescentAfterAt + 1,
      });
      await ctx.db.patch(lifecycle!._id, {
        generation: newGeneration,
        updatedAt: marked.quiescentAfterAt + 1,
      });
    });
    await t.mutation(settleStripeOperation, {
      ...oldTuple,
      stripeCustomerId: "cus_after_reset",
      now: marked.quiescentAfterAt + 2,
    });
    await t.mutation(resolveStripeManualDebt, {
      ownerId,
      ownerGeneration: newGeneration,
      operationId,
      resolutionId: "old-generation-customer-resolution",
      expectedStep: "customer_create",
      expectedAttemptId: marked.attemptId,
      resolution: {
        kind: "recovered_customer",
        stripeCustomerId: "cus_after_reset",
      },
      resolvedBy: "operator@example.test",
      evidence: "The exact old-generation result belongs to the same owner.",
      now: marked.quiescentAfterAt + 3,
    });
    expect(await readOperation(t, operationId)).toMatchObject({
      ownerGeneration: newGeneration,
      stripeCustomerId: "cus_after_reset",
      lastStripeAttemptId: marked.attemptId,
      lastStripeDisposition: "succeeded",
    });
  });

  it("moves every resolution proof during reset adoption before accepting a delayed exact success", async () => {
    const t = createTest();
    const ownerId = "reset-resolution-proof-owner";
    const oldGeneration = "reset-resolution-proof-old";
    const newGeneration = "reset-resolution-proof-new";
    const index = 121;
    await seedActiveOwner(t, ownerId, oldGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration: oldGeneration,
      index,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration: oldGeneration,
      operationId,
      attemptId: "reset-resolution-proof-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 56_000,
    });
    const oldTuple = exactTuple(
      ownerId,
      oldGeneration,
      operationId,
      "customer_create",
      marked,
    );
    await t.mutation(settleStripeOperationNotCreated, {
      ...oldTuple,
      now: marked.quiescentAfterAt,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_operation_resolutions", {
        ownerId,
        ownerGeneration: oldGeneration,
        operationId,
        resolutionId: "reset-resolution-proof-not-created",
        debtKey: `attempt:${marked.attemptId}:customer_lookup_unavailable`,
        attemptId: marked.attemptId,
        step: "customer_create",
        resolution: "provider_confirmed_not_created",
        debtReason: "customer_lookup_unavailable",
        resolvedByHash: hex64(121_001),
        evidenceHash: hex64(121_002),
        resolvedAt: marked.quiescentAfterAt + 1,
      });
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(lifecycle!._id, {
        generation: newGeneration,
        updatedAt: marked.quiescentAfterAt + 2,
      });
    });

    await expect(
      t.mutation(reserveStripeOperation, {
        ownerId,
        ownerGeneration: newGeneration,
        kind: "subscription_checkout",
        requestKey: hex64(index + 1),
        requestFingerprint: hex64(index + 10_000),
        now: marked.quiescentAfterAt + 3,
      }),
    ).resolves.toMatchObject({
      operationId,
      ownerGeneration: newGeneration,
    });
    const adoptedProof = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", "reset-resolution-proof-not-created"),
        )
        .unique(),
    );
    expect(adoptedProof).toMatchObject({
      ownerId,
      ownerGeneration: newGeneration,
      operationId,
    });

    await expect(
      t.mutation(settleStripeOperation, {
        ...oldTuple,
        stripeCustomerId: "cus_reset_resolution_late_success",
        now: marked.quiescentAfterAt + 4,
      }),
    ).resolves.toMatchObject({ recorded: true, duplicate: false });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_late_results")
          .withIndex("by_operationId_and_attemptId", (q) =>
            q.eq("operationId", operationId).eq("attemptId", marked.attemptId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({
      ownerId,
      stripeCustomerId: "cus_reset_resolution_late_success",
    });
  });

  it("preserves debt across not-created/success callback orderings and waits out a foreign claim", async () => {
    const t = createTest();
    const ownerId = "claim-order-owner";
    const ownerGeneration = "claim-order-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);

    const notCreatedFirstId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId: "not-created-first",
      index: 120,
    });
    const notCreatedFirst = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId: notCreatedFirstId,
      attemptId: "not-created-first-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 40_000,
    });
    const firstClaim = await t.mutation(claimReconcileCommand, {
      operationId: notCreatedFirstId,
      attemptId: notCreatedFirst.attemptId,
      claimId: "not-created-first-claim",
      now: notCreatedFirst.quiescentAfterAt,
    });
    expect(firstClaim).not.toBeNull();
    const firstTuple = exactTuple(
      ownerId,
      ownerGeneration,
      notCreatedFirstId,
      "customer_create",
      notCreatedFirst,
    );
    await t.mutation(settleStripeOperationNotCreated, {
      ...firstTuple,
      reconcileClaimId: "not-created-first-claim",
      now: notCreatedFirst.quiescentAfterAt + 1,
    });
    await t.mutation(settleStripeOperation, {
      ...firstTuple,
      stripeCustomerId: "cus_not_created_first_late",
      now: notCreatedFirst.quiescentAfterAt + 2,
    });
    expect(await readOperation(t, notCreatedFirstId)).toMatchObject({
      manualDebtReason: "late_result_conflict",
      lateResultStripeCustomerId: "cus_not_created_first_late",
    });

    const successFirstId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId: "success-first",
      index: 121,
      stripeCustomerId: "cus_claim_order",
    });
    const successFirstAttemptA = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId: successFirstId,
      attemptId: "success-first-attempt-a",
      step: "checkout_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 50_000,
    });
    const successFirstTupleA = exactTuple(
      ownerId,
      ownerGeneration,
      successFirstId,
      "checkout_create",
      successFirstAttemptA,
    );
    await t.mutation(settleStripeOperationNotCreated, {
      ...successFirstTupleA,
      now: successFirstAttemptA.quiescentAfterAt,
    });
    const successFirstAttemptB = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId: successFirstId,
      attemptId: "success-first-attempt-b",
      step: "checkout_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: successFirstAttemptA.quiescentAfterAt + 1,
    });
    const secondClaim = await t.mutation(claimReconcileCommand, {
      operationId: successFirstId,
      attemptId: successFirstAttemptB.attemptId,
      claimId: "success-first-live-claim",
      now: successFirstAttemptB.quiescentAfterAt,
    });
    expect(secondClaim).not.toBeNull();
    const secondTuple = exactTuple(
      ownerId,
      ownerGeneration,
      successFirstId,
      "checkout_create",
      successFirstAttemptB,
    );
    await t.mutation(settleStripeOperation, {
      ...secondTuple,
      reconcileClaimId: "success-first-live-claim",
      stripeCustomerId: "cus_claim_order",
      stripeCheckoutSessionId: "cs_after_late",
      now: successFirstAttemptB.quiescentAfterAt + 1,
    });
    await t.mutation(settleStripeOperation, {
      ...successFirstTupleA,
      stripeCustomerId: "cus_claim_order",
      stripeCheckoutSessionId: "cs_before_late",
      now: successFirstAttemptB.quiescentAfterAt + 2,
    });
    expect(await readOperation(t, successFirstId)).toMatchObject({
      manualDebtReason: "late_result_conflict",
      stripeCheckoutSessionId: "cs_after_late",
      lateResultStripeCheckoutSessionId: "cs_before_late",
    });
    await expect(
      t.mutation(settleStripeOperationNotCreated, {
        ...secondTuple,
        reconcileClaimId: "success-first-live-claim",
        now: successFirstAttemptB.quiescentAfterAt + 3,
      }),
    ).rejects.toThrow(/disposition changed/u);
    const successFirstAfterNotCreated = await readOperation(t, successFirstId);
    expect(successFirstAfterNotCreated).toMatchObject({
      manualDebtReason: "late_result_conflict",
      lateResultStripeCheckoutSessionId: "cs_before_late",
    });
    expect(successFirstAfterNotCreated?.reconcileClaimId).toBeUndefined();

    const expiryId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId: "claim-expiry",
      index: 122,
      stripeCustomerId: "cus_claim_order",
    });
    const expiryPrior = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId: expiryId,
      attemptId: "claim-expiry-prior-attempt",
      step: "checkout_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 60_000,
    });
    const expiryPriorTuple = exactTuple(
      ownerId,
      ownerGeneration,
      expiryId,
      "checkout_create",
      expiryPrior,
    );
    await t.mutation(settleStripeOperationNotCreated, {
      ...expiryPriorTuple,
      now: expiryPrior.quiescentAfterAt,
    });
    const expiryMark = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId: expiryId,
      attemptId: "claim-expiry-attempt",
      step: "checkout_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: expiryPrior.quiescentAfterAt + 1,
    });
    const expiryClaim = await t.mutation(claimReconcileCommand, {
      operationId: expiryId,
      attemptId: expiryMark.attemptId,
      claimId: "claim-expiry-live-claim",
      now: expiryMark.quiescentAfterAt,
    });
    expect(expiryClaim).not.toBeNull();
    const expiryTuple = exactTuple(
      ownerId,
      ownerGeneration,
      expiryId,
      "checkout_create",
      expiryMark,
    );
    await t.mutation(settleStripeOperation, {
      ...expiryPriorTuple,
      stripeCustomerId: "cus_claim_order",
      stripeCheckoutSessionId: "cs_after_expiry",
      now: expiryMark.quiescentAfterAt + 1,
    });
    const claimExpiresAt = await t.run(async (ctx) => {
      const [late, operation] = await Promise.all([
        ctx.db
          .query("billing_stripe_late_results")
          .withIndex("by_operationId_and_attemptId", (q) =>
            q
              .eq("operationId", expiryId)
              .eq("attemptId", expiryPrior.attemptId),
          )
          .unique(),
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", expiryId))
          .unique(),
      ]);
      return Math.max(
        late!.quiescentAfterAt,
        operation!.reconcileClaimExpiresAt!,
      );
    });
    const expiryResolution = {
      ownerId,
      ownerGeneration,
      operationId: expiryId,
      resolutionId: "claim-expiry-resolution",
      expectedStep: "checkout_create" as const,
      expectedAttemptId: expiryPrior.attemptId,
      resolution: {
        kind: "recovered_checkout" as const,
        stripeCustomerId: "cus_claim_order",
        stripeCheckoutSessionId: "cs_after_expiry",
      },
      resolvedBy: "operator@example.test",
      evidence: "The foreign reconciliation claim expired without more I/O.",
    };
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...expiryResolution,
        now: claimExpiresAt - 1,
      }),
    ).rejects.toThrow(/authority is still active/u);
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...expiryResolution,
        now: claimExpiresAt,
      }),
    ).rejects.toThrow(/authority is still active/u);
    await expect(
      t.mutation(settleStripeOperationNotCreated, {
        ...expiryTuple,
        reconcileClaimId: "claim-expiry-live-claim",
        now: claimExpiresAt + 1,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...expiryResolution,
        now: claimExpiresAt + 2,
      }),
    ).resolves.toEqual({ resolution: "recovered_checkout", replayed: false });
    expect(await readOperation(t, expiryId)).toMatchObject({
      state: "provider_succeeded",
      stripeCheckoutSessionId: "cs_after_expiry",
    });
    await expect(
      t.run(
        async (ctx) =>
          await ctx.db
            .query("billing_stripe_late_cleanup_locators")
            .filter((q) => q.eq(q.field("locatorValue"), "cs_after_expiry"))
            .unique(),
      ),
    ).resolves.toBeNull();
    expect(
      (await readOperation(t, expiryId))?.reconcileClaimId,
    ).toBeUndefined();
    expect(
      (await readOperation(t, expiryId))?.manualDebtReason,
    ).toBeUndefined();
  });
});

describe("Stripe final-return and cleanup fences", () => {
  it("rechecks exact hosted-result locators, auth epoch, and lifecycle at final return", async () => {
    const t = createTest();
    const ownerId = "final-return-owner";
    const ownerGeneration = "final-return-generation";
    const stripeCustomerId = "cus_final_return";
    const stripeCheckoutSessionId = "cs_final_return";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { stripeCustomerId });
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 120,
      stripeCustomerId,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "final-return-attempt",
      step: "checkout_create",
      requestJson: JSON.stringify({ customer: stripeCustomerId }),
      now: TEST_CLOCK,
    });
    await t.mutation(settleStripeOperation, {
      ...exactTuple(
        ownerId,
        ownerGeneration,
        operationId,
        "checkout_create",
        marked,
      ),
      stripeCustomerId,
      stripeCheckoutSessionId,
      now: TEST_CLOCK + 1,
    });
    await expect(
      t.mutation(completeStripeOperation, {
        ownerId,
        ownerGeneration,
        operationId,
        now: TEST_CLOCK + 2,
      }),
    ).resolves.toBe(true);
    const exactResult = {
      ownerId,
      ownerGeneration,
      operationId,
      stripeCustomerId,
      stripeCheckoutSessionId,
    };
    await expect(
      t.mutation(authorizeStripeOperationResultReturn, exactResult),
    ).resolves.toBe(true);
    await expect(
      t.mutation(authorizeStripeOperationResultReturn, {
        ...exactResult,
        stripeCheckoutSessionId: "cs_changed_before_return",
      }),
    ).resolves.toBe(false);
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(profile!._id, { stripeCustomerAuthorityEpoch: 1 });
    });
    await expect(
      t.mutation(authorizeStripeOperationResultReturn, exactResult),
    ).resolves.toBe(false);
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(profile!._id, { stripeCustomerAuthorityEpoch: 0 });
      await ctx.db.patch(lifecycle!._id, { state: "deleting" });
    });
    await expect(
      t.mutation(authorizeStripeOperationResultReturn, exactResult),
    ).resolves.toBe(false);
  });

  it("keeps a current-v3 success with missing receipt provenance orphaned", async () => {
    const t = createTest();
    const ownerId = "current-v3-orphan-owner";
    const ownerGeneration = "current-v3-orphan-generation";
    const stripeCustomerId = "cus_current_v3_orphan";
    const operationId = "current-v3-orphan-operation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { stripeCustomerId });
    await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 121,
      stripeCustomerId,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "current-v3-orphan-attempt",
      step: "checkout_create",
      requestJson: JSON.stringify({ customer: stripeCustomerId }),
      now: TEST_CLOCK + 10,
    });
    await t.mutation(settleStripeOperation, {
      ...exactTuple(
        ownerId,
        ownerGeneration,
        operationId,
        "checkout_create",
        marked,
      ),
      stripeCustomerId,
      stripeCheckoutSessionId: "cs_current_v3_orphan",
      now: TEST_CLOCK + 11,
    });
    await t.run(async (ctx) => {
      const receipt = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      await ctx.db.patch(receipt!._id, { successLocatorHash: undefined });
    });
    const purge = await beginPurge(t, ownerId, "delete");
    const result = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: TEST_CLOCK + 12,
    });
    expect(result.ready).toBe(false);
    expect(result.pending).toContain(
      `stripe_operation_malformed:${operationId}`,
    );
    const receipt = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
    );
    expect(receipt?.successLocatorHash).toBeUndefined();
  });

  it("never deletes a customer behind a failed Checkout and supports audited retention", async () => {
    const t = createTest();
    const ownerId = "cleanup-retention-owner";
    const ownerGeneration = "cleanup-retention-generation";
    const stripeCustomerId = "cus_cleanup_retention";
    const stripeCheckoutSessionId = "cs_cleanup_retention";
    const operationId = "cleanup-retention-operation";
    const wallNow = Date.now() - 1_000;
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId, { stripeCustomerId });
    await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 122,
      stripeCustomerId,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration,
      operationId,
      attemptId: "cleanup-retention-attempt",
      step: "checkout_create",
      requestJson: JSON.stringify({ customer: stripeCustomerId }),
      now: wallNow,
    });
    await beginPurge(t, ownerId, "delete");
    const lateSuccess = {
      ...exactTuple(
        ownerId,
        ownerGeneration,
        operationId,
        "checkout_create",
        marked,
      ),
      stripeCustomerId,
      stripeCheckoutSessionId,
    };
    await t.mutation(settleStripeOperation, {
      ...lateSuccess,
      now: wallNow + 1,
    });
    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        if (url.includes(`/v1/checkout/sessions/${stripeCheckoutSessionId}`)) {
          return new Response(
            JSON.stringify({
              id: stripeCheckoutSessionId,
              object: "checkout.session",
              status: "open",
              customer: stripeCustomerId,
              metadata: { ownerId },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(`/v1/customers/${stripeCustomerId}`)) {
          return new Response(
            JSON.stringify({
              id: stripeCustomerId,
              object: "customer",
              metadata: { ownerId: "foreign-cleanup-owner" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected Stripe request: ${method} ${url}`);
      },
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_cleanup_retention";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(
        internal.stripe_operation_dispatch.drainLateStripeCleanupInternal,
        {},
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    expect(
      providerFetch.mock.calls.some(([input, init]) => {
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        return method !== "GET";
      }),
    ).toBe(false);
    // Read by operation receipt to avoid retaining the physical tuple in test
    // setup outside the same durable authority chain.
    const debt = await t.run(async (ctx) => {
      const receipt = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      const rows = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", receipt!.tupleHash))
        .collect();
      return { receipt, rows };
    });
    expect(debt.rows).toHaveLength(2);
    expect(
      debt.rows.find((row) => row.locatorKind === "checkout_session"),
    ).toMatchObject({ attempts: 1 });
    expect(
      debt.rows.find((row) => row.locatorKind === "customer"),
    ).toMatchObject({ attempts: 0, checkoutBlocked: true });
    await expect(
      t.mutation(resolveLateStripeCleanupRetention, {
        tupleHash: debt.receipt!.tupleHash,
        successLocatorHash: debt.receipt!.successLocatorHash!,
        resolutionId: "retain-foreign-cleanup-resource",
        resolvedBy: "operator@example.test",
        evidence: "Provider metadata proves a different owner; retain it.",
        now: wallNow + 2,
      }),
    ).resolves.toEqual({
      resolution: "provider_resource_retained",
      replayed: false,
    });
    await expect(
      t.mutation(settleStripeOperation, {
        ...lateSuccess,
        now: wallNow + 3,
      }),
    ).resolves.toEqual({
      recorded: false,
      duplicate: true,
      customerDeleted: true,
    });
    const retained = await t.run(async (ctx) => ({
      rows: await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .collect(),
      receipt: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      audit: await ctx.db
        .query("billing_stripe_late_cleanup_resolutions")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", "retain-foreign-cleanup-resource"),
        )
        .unique(),
    }));
    expect(retained.rows).toEqual([]);
    expect(retained.receipt).toMatchObject({
      cleanupResolutionId: "retain-foreign-cleanup-resource",
    });
    expect(retained.receipt?.deletionCleanupTerminalized).toBeUndefined();
    expect(retained.audit).not.toBeNull();
    await t.run(async (ctx) => {
      await ctx.db.patch(retained.audit!._id, {
        successLocatorHash: hex64(999_999),
      });
    });
    await expect(
      t.mutation(settleStripeOperation, {
        ...lateSuccess,
        now: wallNow + 4,
      }),
    ).rejects.toThrow(/integrity requires reconciliation|retention audit/iu);
  });

  it("fences retained-resource resolution against expired and cross-channel provider claims", async () => {
    const t = createTest();
    const ownerId = "cleanup-claim-fence-owner";
    const ownerGeneration = "cleanup-claim-fence-generation";
    const operationId = "cleanup-claim-fence-operation";
    const stripeCustomerId = "cus_cleanup_claim_fence";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 130,
    });
    const envelope = await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 130,
      stripeCustomerId,
    });
    await expect(
      t.mutation(claimLateStripeCleanup, {
        tupleHash: envelope.tupleHash,
        locatorHash: envelope.customerLocatorHash,
        claimId: "cleanup-worker-old",
        now: 1_000,
      }),
    ).resolves.toBe(true);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", envelope.tupleHash)
            .eq("locatorHash", envelope.customerLocatorHash),
        )
        .unique();
      await ctx.db.patch(row!._id, { cleanupClaimExpiresAt: 0 });
    });
    await expect(
      t.mutation(claimLateStripeCleanup, {
        tupleHash: envelope.tupleHash,
        locatorHash: envelope.customerLocatorHash,
        claimId: "cleanup-worker-new",
        now: 2_000,
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(revalidateLateStripeCleanupClaim, {
        tupleHash: envelope.tupleHash,
        locatorHash: envelope.customerLocatorHash,
        claimId: "cleanup-worker-old",
        now: 2_001,
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(revalidateLateStripeCleanupClaim, {
        tupleHash: envelope.tupleHash,
        locatorHash: envelope.customerLocatorHash,
        claimId: "cleanup-worker-new",
        now: 2_002,
      }),
    ).resolves.toBe(true);
    const resolution = {
      tupleHash: envelope.tupleHash,
      successLocatorHash: envelope.successLocatorHash,
      resolutionId: "retain-cleanup-claim-fence",
      resolvedBy: "operator@example.test",
      evidence: "Provider ownership cannot be safely reconciled.",
      now: 2_003,
    };
    await expect(
      t.mutation(resolveLateStripeCleanupRetention, resolution),
    ).rejects.toThrow(/exact failed provider debt|in-flight provider claim/iu);
    await t.mutation(recordLateStripeCleanupFailure, {
      tupleHash: envelope.tupleHash,
      locatorHash: envelope.customerLocatorHash,
      claimId: "cleanup-worker-new",
      error: "Provider metadata names a foreign owner.",
      now: 2_004,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_owner_deletion_locators", {
        ownerId,
        operationId: "delete-cleanup-claim-fence-owner",
        generation: "delete-cleanup-claim-fence-generation",
        locatorHash: envelope.customerLocatorHash,
        locatorKind: "customer",
        locatorValue: stripeCustomerId,
        ownerVerified: true,
        state: "pending",
        eventsDrained: false,
        attempts: 0,
        providerClaimId: "owner-cleanup-worker",
        providerClaimExpiresAt: 0,
        createdAt: 2_004,
        updatedAt: 2_004,
      });
    });
    await expect(
      t.mutation(resolveLateStripeCleanupRetention, {
        ...resolution,
        now: 2_005,
      }),
    ).rejects.toThrow(/in-flight provider claim/iu);
    await t.run(async (ctx) => {
      const local = await ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_locatorHash", (q) =>
          q.eq("locatorHash", envelope.customerLocatorHash),
        )
        .unique();
      await ctx.db.patch(local!._id, {
        providerClaimId: undefined,
        providerClaimExpiresAt: undefined,
      });
    });
    await expect(
      t.mutation(resolveLateStripeCleanupRetention, {
        ...resolution,
        now: 2_006,
      }),
    ).resolves.toEqual({
      resolution: "provider_resource_retained",
      replayed: false,
    });
    await expect(
      t.query(
        internal.account_billing_purge.hasRetainedStripeDeletionLocatorInternal,
        {
          ownerId,
          locatorHash: envelope.customerLocatorHash,
          locatorKind: "customer",
        },
      ),
    ).resolves.toBe(true);
    await expect(
      t.query(
        internal.account_billing_purge.hasRetainedStripeDeletionLocatorInternal,
        {
          ownerId: "rightful-foreign-owner",
          locatorHash: envelope.customerLocatorHash,
          locatorKind: "customer",
        },
      ),
    ).resolves.toBe(false);
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_owner_deletion_locators")
          .withIndex("by_locatorHash", (q) =>
            q.eq("locatorHash", envelope.customerLocatorHash),
          )
          .unique(),
      ),
    ).resolves.toBeNull();
  });

  it("makes a provider action resumed after claim takeover perform zero destructive calls", async () => {
    const t = createTest();
    const ownerId = "cleanup-suspended-action-owner";
    const ownerGeneration = "cleanup-suspended-action-generation";
    const operationId = "cleanup-suspended-action-operation";
    const stripeCustomerId = "cus_cleanup_suspended_action";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 131,
    });
    const envelope = await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 131,
      stripeCustomerId,
    });
    let releaseProviderRead!: () => void;
    const providerReadBlocked = new Promise<void>((resolve) => {
      releaseProviderRead = resolve;
    });
    let signalProviderRead!: () => void;
    const providerReadStarted = new Promise<void>((resolve) => {
      signalProviderRead = resolve;
    });
    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        if (
          method === "GET" &&
          url.includes(`/v1/customers/${stripeCustomerId}`)
        ) {
          signalProviderRead();
          await providerReadBlocked;
          return new Response(
            JSON.stringify({
              id: stripeCustomerId,
              object: "customer",
              metadata: { ownerId },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected Stripe request: ${method} ${url}`);
      },
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_cleanup_suspended_action";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      const action = t.action(
        internal.stripe_operation_dispatch.drainLateStripeCleanupInternal,
        {},
      );
      await providerReadStarted;
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("billing_stripe_late_cleanup_locators")
          .withIndex("by_tupleHash_and_locatorHash", (q) =>
            q
              .eq("tupleHash", envelope.tupleHash)
              .eq("locatorHash", envelope.customerLocatorHash),
          )
          .unique();
        await ctx.db.patch(row!._id, { cleanupClaimExpiresAt: 0 });
      });
      await expect(
        t.mutation(claimLateStripeCleanup, {
          tupleHash: envelope.tupleHash,
          locatorHash: envelope.customerLocatorHash,
          claimId: "cleanup-takeover-worker",
          now: Date.now(),
        }),
      ).resolves.toBe(true);
      releaseProviderRead();
      await action;
    } finally {
      releaseProviderRead();
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    expect(
      providerFetch.mock.calls.some(([input, init]) => {
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        return method !== "GET";
      }),
    ).toBe(false);
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", envelope.tupleHash)
            .eq("locatorHash", envelope.customerLocatorHash),
        )
        .unique(),
    );
    expect(remaining).toMatchObject({
      cleanupClaimId: "cleanup-takeover-worker",
    });
  });

  it("propagates one owner-scoped retained customer fence across physical tuples", async () => {
    const t = createTest();
    const ownerId = "cross-tuple-retention-owner";
    const ownerGeneration = "cross-tuple-retention-generation";
    const stripeCustomerId = "cus_cross_tuple_retention";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    for (const [operationId, index] of [
      ["cross-tuple-retention-a", 132],
      ["cross-tuple-retention-b", 133],
    ] as const) {
      await seedOperation(t, {
        ownerId,
        ownerGeneration,
        operationId,
        index,
      });
    }
    const first = await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId: "cross-tuple-retention-a",
      index: 132,
      stripeCustomerId,
    });
    const second = await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId: "cross-tuple-retention-b",
      index: 133,
      stripeCustomerId,
    });
    await t.run(async (ctx) => {
      const firstRow = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", first.tupleHash)
            .eq("locatorHash", first.customerLocatorHash),
        )
        .unique();
      await ctx.db.patch(firstRow!._id, {
        attempts: 1,
        lastError: "Provider metadata is foreign.",
      });
    });
    await expect(
      t.mutation(claimLateStripeCleanup, {
        tupleHash: second.tupleHash,
        locatorHash: second.customerLocatorHash,
        claimId: "cross-tuple-worker",
        now: 1_000,
      }),
    ).resolves.toBe(true);
    const firstResolution = {
      tupleHash: first.tupleHash,
      successLocatorHash: first.successLocatorHash,
      resolutionId: "retain-cross-tuple-customer",
      resolvedBy: "operator@example.test",
      evidence: "The shared customer belongs to a foreign provider owner.",
      now: 1_001,
    };
    await expect(
      t.mutation(resolveLateStripeCleanupRetention, firstResolution),
    ).rejects.toThrow(/in-flight provider claim/iu);
    await t.mutation(recordLateStripeCleanupFailure, {
      tupleHash: second.tupleHash,
      locatorHash: second.customerLocatorHash,
      claimId: "cross-tuple-worker",
      error: "Provider metadata is foreign.",
      now: 1_002,
    });
    await expect(
      t.mutation(resolveLateStripeCleanupRetention, {
        ...firstResolution,
        now: 1_003,
      }),
    ).resolves.toEqual({
      resolution: "provider_resource_retained",
      replayed: false,
    });
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(async () => {
      throw new Error("A retained cross-tuple locator reached Stripe.");
    });
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(
        internal.stripe_operation_dispatch.drainLateStripeCleanupInternal,
        {},
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(providerFetch).not.toHaveBeenCalled();
    const snapshot = await t.run(async (ctx) => ({
      pending: await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", second.tupleHash))
        .collect(),
      receipt: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", second.tupleHash))
        .unique(),
      retained: await ctx.db
        .query("billing_stripe_retained_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", second.tupleHash)
            .eq("locatorHash", second.customerLocatorHash),
        )
        .unique(),
    }));
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.receipt?.cleanupResolutionId).toBe(
      `retained-fence-${second.tupleHash}`,
    );
    expect(snapshot.receipt?.deletionCleanupTerminalized).toBeUndefined();
    expect(snapshot.retained).toMatchObject({ ownerHash: second.ownerHash });
  });

  it("deletes a distinct Checkout while retaining its shared customer across tuples", async () => {
    const t = createTest();
    const ownerId = "mixed-cross-tuple-retention-owner";
    const ownerGeneration = "mixed-cross-tuple-retention-generation";
    const stripeCustomerId = "cus_mixed_cross_tuple_retention";
    const stripeCheckoutSessionId = "cs_mixed_cross_tuple_retention";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    for (const [operationId, index] of [
      ["mixed-cross-tuple-retention-a", 134],
      ["mixed-cross-tuple-retention-b", 135],
    ] as const) {
      await seedOperation(t, {
        ownerId,
        ownerGeneration,
        operationId,
        index,
      });
    }
    const retainedTuple = await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId: "mixed-cross-tuple-retention-a",
      index: 134,
      stripeCustomerId,
    });
    const mixedTuple = await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId: "mixed-cross-tuple-retention-b",
      index: 135,
      stripeCustomerId,
      stripeCheckoutSessionId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", retainedTuple.tupleHash)
            .eq("locatorHash", retainedTuple.customerLocatorHash),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        attempts: 1,
        lastError: "Provider metadata is foreign.",
      });
    });
    await t.mutation(resolveLateStripeCleanupRetention, {
      tupleHash: retainedTuple.tupleHash,
      successLocatorHash: retainedTuple.successLocatorHash,
      resolutionId: "retain-mixed-cross-tuple-customer",
      resolvedBy: "operator@example.test",
      evidence: "The shared customer belongs to a foreign provider owner.",
      now: 1_010,
    });
    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        if (url.includes(`/v1/checkout/sessions/${stripeCheckoutSessionId}`)) {
          return new Response(
            JSON.stringify({
              id: stripeCheckoutSessionId,
              object: "checkout.session",
              status: method === "POST" ? "expired" : "open",
              customer: stripeCustomerId,
              metadata: { ownerId },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(`/v1/customers/${stripeCustomerId}`)) {
          expect(method).toBe("GET");
          return new Response(
            JSON.stringify({
              id: stripeCustomerId,
              object: "customer",
              metadata: { ownerId },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected Stripe request: ${method} ${url}`);
      },
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_mixed_cross_tuple_retention";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(
        internal.stripe_operation_dispatch.drainLateStripeCleanupInternal,
        {},
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    expect(
      providerFetch.mock.calls.some(
        ([input, init]) =>
          (input instanceof Request
            ? input.method
            : (init?.method ?? "GET")) === "DELETE",
      ),
    ).toBe(false);
    expect(
      providerFetch.mock.calls.some(([input, init]) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        return url.endsWith("/expire") && method === "POST";
      }),
    ).toBe(true);
    const snapshot = await t.run(async (ctx) => ({
      pending: await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) =>
          q.eq("tupleHash", mixedTuple.tupleHash),
        )
        .collect(),
      receipt: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_tupleHash", (q) =>
          q.eq("tupleHash", mixedTuple.tupleHash),
        )
        .unique(),
      retained: await ctx.db
        .query("billing_stripe_retained_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", mixedTuple.tupleHash)
            .eq("locatorHash", mixedTuple.customerLocatorHash),
        )
        .unique(),
      checkoutTombstone: await ctx.db
        .query("billing_stripe_deletion_tombstones")
        .withIndex("by_locatorHash", (q) =>
          q.eq("locatorHash", mixedTuple.checkoutLocatorHash!),
        )
        .unique(),
    }));
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.receipt?.cleanupResolutionId).toBe(
      `retained-fence-${mixedTuple.tupleHash}`,
    );
    expect(snapshot.receipt?.deletionCleanupTerminalized).toBeUndefined();
    expect(snapshot.retained).toMatchObject({
      ownerHash: mixedTuple.ownerHash,
      locatorKind: "customer",
    });
    expect(snapshot.checkoutTombstone).toMatchObject({
      locatorKind: "checkout_session",
    });
  });

  it("upgrades inherited customer retention when the tuple Checkout also requires retention", async () => {
    const t = createTest();
    const ownerId = "upgrade-cross-tuple-retention-owner";
    const ownerGeneration = "upgrade-cross-tuple-retention-generation";
    const stripeCustomerId = "cus_upgrade_cross_tuple_retention";
    const stripeCheckoutSessionId = "cs_upgrade_cross_tuple_retention";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    for (const [operationId, index] of [
      ["upgrade-cross-tuple-retention-a", 136],
      ["upgrade-cross-tuple-retention-b", 137],
    ] as const) {
      await seedOperation(t, {
        ownerId,
        ownerGeneration,
        operationId,
        index,
      });
    }
    const retainedTuple = await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId: "upgrade-cross-tuple-retention-a",
      index: 136,
      stripeCustomerId,
    });
    const mixedTuple = await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId: "upgrade-cross-tuple-retention-b",
      index: 137,
      stripeCustomerId,
      stripeCheckoutSessionId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", retainedTuple.tupleHash)
            .eq("locatorHash", retainedTuple.customerLocatorHash),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        attempts: 1,
        lastError: "Provider metadata is foreign.",
      });
    });
    await t.mutation(resolveLateStripeCleanupRetention, {
      tupleHash: retainedTuple.tupleHash,
      successLocatorHash: retainedTuple.successLocatorHash,
      resolutionId: "retain-upgrade-source-customer",
      resolvedBy: "operator@example.test",
      evidence: "The shared customer belongs to a foreign provider owner.",
      now: 1_020,
    });
    await expect(
      t.mutation(claimLateStripeCleanup, {
        tupleHash: mixedTuple.tupleHash,
        locatorHash: mixedTuple.customerLocatorHash,
        claimId: "inherit-upgrade-customer",
        now: 1_021,
      }),
    ).resolves.toBe(false);
    await t.run(async (ctx) => {
      const checkout = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q
            .eq("tupleHash", mixedTuple.tupleHash)
            .eq("locatorHash", mixedTuple.checkoutLocatorHash!),
        )
        .unique();
      await ctx.db.patch(checkout!._id, {
        attempts: 1,
        lastError: "Provider Checkout ownership is foreign.",
      });
    });
    const operatorResolution = {
      tupleHash: mixedTuple.tupleHash,
      successLocatorHash: mixedTuple.successLocatorHash,
      resolutionId: "retain-upgrade-mixed-tuple",
      resolvedBy: "operator@example.test",
      evidence:
        "The remaining Checkout also belongs to a foreign provider owner.",
      now: 1_022,
    };
    await expect(
      t.mutation(resolveLateStripeCleanupRetention, operatorResolution),
    ).resolves.toEqual({
      resolution: "provider_resource_retained",
      replayed: false,
    });
    await expect(
      t.mutation(resolveLateStripeCleanupRetention, {
        ...operatorResolution,
        now: 1_023,
      }),
    ).resolves.toEqual({
      resolution: "provider_resource_retained",
      replayed: true,
    });
    const snapshot = await t.run(async (ctx) => ({
      pending: await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) =>
          q.eq("tupleHash", mixedTuple.tupleHash),
        )
        .collect(),
      receipt: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_tupleHash", (q) =>
          q.eq("tupleHash", mixedTuple.tupleHash),
        )
        .unique(),
      resolutions: await ctx.db
        .query("billing_stripe_late_cleanup_resolutions")
        .withIndex("by_tupleHash", (q) =>
          q.eq("tupleHash", mixedTuple.tupleHash),
        )
        .collect(),
      retained: await ctx.db
        .query("billing_stripe_retained_locators")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", operatorResolution.resolutionId),
        )
        .collect(),
    }));
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.receipt?.cleanupResolutionId).toBe(
      operatorResolution.resolutionId,
    );
    expect(snapshot.receipt?.deletionCleanupTerminalized).toBeUndefined();
    expect(snapshot.resolutions).toEqual([
      expect.objectContaining({
        resolutionId: operatorResolution.resolutionId,
        locatorCount: 2,
      }),
    ]);
    expect(snapshot.retained).toHaveLength(2);
    expect(snapshot.retained.map((row) => row.locatorKind).sort()).toEqual([
      "checkout_session",
      "customer",
    ]);
  });

  it("terminalizes a non-open Checkout without requiring its missing customer", async () => {
    const t = createTest();
    const ownerId = "terminal-checkout-cleanup-owner";
    const ownerGeneration = "terminal-checkout-cleanup-generation";
    const operationId = "terminal-checkout-cleanup-operation";
    const stripeCustomerId = "cus_terminal_checkout_missing";
    const stripeCheckoutSessionId = "cs_terminal_checkout_missing";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedOperation(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 123,
    });
    await seedLateCleanupEnvelope(t, {
      ownerId,
      ownerGeneration,
      operationId,
      index: 123,
      stripeCustomerId,
      stripeCheckoutSessionId,
    });
    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        expect(method).toBe("GET");
        if (url.includes(`/v1/checkout/sessions/${stripeCheckoutSessionId}`)) {
          return new Response(
            JSON.stringify({
              id: stripeCheckoutSessionId,
              object: "checkout.session",
              status: "expired",
              metadata: { ownerId },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(`/v1/customers/${stripeCustomerId}`)) {
          return new Response(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "resource_missing",
                message: "No such customer",
              },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected Stripe request: ${method} ${url}`);
      },
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_terminal_checkout_cleanup";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(
        internal.stripe_operation_dispatch.drainLateStripeCleanupInternal,
        {},
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    const snapshot = await t.run(async (ctx) => ({
      rows: await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .collect(),
      receipt: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
    }));
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.receipt).toMatchObject({
      deletionCleanupTerminalized: true,
    });
    expect(
      providerFetch.mock.calls.some(
        ([input, init]) =>
          (input instanceof Request
            ? input.method
            : (init?.method ?? "GET")) !== "GET",
      ),
    ).toBe(false);
  });

  it("allows source-session/destination-customer cleanup but rejects a corrupted cleanup owner before I/O", async () => {
    const t = createTest();
    const destinationOwnerId = "cleanup-migrated-destination";
    const sourceOwnerId = "cleanup-migrated-source";
    const ownerGeneration = "cleanup-migrated-generation";
    await seedActiveOwner(t, destinationOwnerId, ownerGeneration);
    await seedOperation(t, {
      ownerId: destinationOwnerId,
      ownerGeneration,
      operationId: "cleanup-migrated-valid-operation",
      index: 124,
    });
    await seedOperation(t, {
      ownerId: destinationOwnerId,
      ownerGeneration,
      operationId: "cleanup-migrated-corrupt-operation",
      index: 125,
    });
    await seedLateCleanupEnvelope(t, {
      ownerId: destinationOwnerId,
      ownerGeneration,
      providerOwnerId: sourceOwnerId,
      operationId: "cleanup-migrated-valid-operation",
      index: 124,
      stripeCustomerId: "cus_cleanup_migrated_valid",
      stripeCheckoutSessionId: "cs_cleanup_migrated_valid",
    });
    const corrupt = await seedLateCleanupEnvelope(t, {
      ownerId: destinationOwnerId,
      ownerGeneration,
      providerOwnerId: sourceOwnerId,
      operationId: "cleanup-migrated-corrupt-operation",
      index: 125,
      stripeCustomerId: "cus_cleanup_migrated_corrupt",
      stripeCheckoutSessionId: "cs_cleanup_migrated_corrupt",
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", corrupt.tupleHash))
        .collect();
      for (const row of rows) {
        await ctx.db.patch(row._id, { ownerHash: hex64(880_000) });
      }
    });
    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousFetch = globalThis.fetch;
    const providerFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        expect(url).not.toContain("_corrupt");
        if (url.includes("/v1/checkout/sessions/cs_cleanup_migrated_valid")) {
          return new Response(
            JSON.stringify({
              id: "cs_cleanup_migrated_valid",
              object: "checkout.session",
              status: method === "POST" ? "expired" : "open",
              customer: "cus_cleanup_migrated_valid",
              metadata: { ownerId: sourceOwnerId },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/v1/customers/cus_cleanup_migrated_valid")) {
          return new Response(
            JSON.stringify({
              id: "cus_cleanup_migrated_valid",
              object: "customer",
              deleted: method === "DELETE",
              metadata: { ownerId: destinationOwnerId },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected Stripe request: ${method} ${url}`);
      },
    );
    process.env.STRIPE_SECRET_KEY = "sk_test_migrated_cleanup";
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      await t.action(
        internal.stripe_operation_dispatch.drainLateStripeCleanupInternal,
        {},
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    const snapshot = await t.run(async (ctx) => ({
      valid: await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) =>
          q.eq("tupleHash", hex64(500_000 + 124)),
        )
        .collect(),
      corrupt: await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", corrupt.tupleHash))
        .collect(),
    }));
    expect(snapshot.valid).toEqual([]);
    expect(snapshot.corrupt).toHaveLength(2);
    expect(
      snapshot.corrupt.find((row) => row.locatorKind === "checkout_session"),
    ).toMatchObject({ attempts: 1 });
    expect(
      providerFetch.mock.calls.some(([input, init]) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        return url.includes("/expire") && method === "POST";
      }),
    ).toBe(true);
  });
});

describe("bounded Stripe lifecycle scans", () => {
  it("lets a reset proceed when the owner has no Stripe profile or recovery rows", async () => {
    const t = createTest();
    const ownerId = "no-stripe-history-reset-owner";
    const purge = await beginPurge(t, ownerId, "reset");

    await expect(
      t.mutation(quiesceForPurge, {
        ...purge,
        mode: "reset",
        now: 10_002,
      }),
    ).resolves.toEqual({ ready: true, pending: [], retryAt: null });
  });

  it("never promotes a partial current-v3 projected late result into delete authority", async () => {
    const t = createTest();
    const ownerId = "partial-v3-late-result-owner";
    const ownerGeneration = "partial-v3-late-result-generation";
    const stripeCustomerId = "cus_partial_v3_late_result";
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 499,
    });
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      await ctx.db.patch(operation!._id, {
        lifecycleIntegrityVersion: 1,
        lateResultStripeCustomerId: stripeCustomerId,
      });
    });
    const purge = await beginPurge(t, ownerId, "delete");
    const result = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: 10_002,
    });
    expect(result.ready).toBe(false);
    expect(result.pending).toContain(
      `stripe_operation_malformed:${operationId}`,
    );
    await t.mutation(
      internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
      {
        ...purge,
        source: "operations",
        now: 10_003,
      },
    );
    const locatorHash = await hashStripeBillingLocator(
      "customer",
      stripeCustomerId,
    );
    const snapshot = await t.run(async (ctx) => ({
      locator: await ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_locatorHash", (q) =>
          q.eq("ownerId", ownerId).eq("locatorHash", locatorHash),
        )
        .unique(),
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
    }));
    expect(snapshot.locator).toBeNull();
    expect(snapshot.operation).toMatchObject({
      state: "reserved",
      dispatchState: "idle",
      lifecycleIntegrityVersion: 1,
      lateResultStripeCustomerId: stripeCustomerId,
    });
  });

  it("normalizes only proven legacy terminal rows and never repairs a current row with missing transport shape", async () => {
    const t = createTest();
    const ownerId = "terminal-transport-normalization-owner";
    const ownerGeneration = "terminal-transport-normalization-generation";
    const currentOperationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 498,
      state: "completed",
      dispatchState: null,
      stripeCustomerId: "cus_current_missing_transport",
      stripeCheckoutSessionId: "cs_current_missing_transport",
    });
    const legacyOperationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 497,
      state: "completed",
      dispatchState: null,
      integrityVersion: 2,
      stripeCustomerId: "cus_legacy_terminal",
      stripeCheckoutSessionId: "cs_legacy_terminal",
    });
    await t.run(async (ctx) => {
      const legacy = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", legacyOperationId),
        )
        .unique();
      await ctx.db.patch(legacy!._id, {
        lastStripeStep: "checkout_create",
        lastStripeAttemptId: "legacy-terminal-attempt",
        lastStripeRequestFingerprint: hex64(497_001),
        lastStripeIdempotencyKey: "legacy-terminal-provider-key",
        lastStripeProviderDeadlineAt: 9_000,
        lastStripeDisposition: "succeeded",
      });
    });

    const purge = await beginPurge(t, ownerId, "delete");
    const result = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: 10_002,
    });
    expect(result.ready).toBe(false);
    expect(result.pending).toContain(
      `stripe_operation_malformed:${currentOperationId}`,
    );
    const snapshot = await t.run(async (ctx) => ({
      current: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", currentOperationId),
        )
        .unique(),
      legacy: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", legacyOperationId),
        )
        .unique(),
      legacyReceipt: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", legacyOperationId),
        )
        .unique(),
    }));
    expect(snapshot.current?.dispatchState).toBeUndefined();
    expect(snapshot.current?.lifecycleIntegrityVersion).toBeUndefined();
    expect(snapshot.legacy).toMatchObject({
      dispatchState: "idle",
      integrityVersion: 3,
      lifecycleIntegrityVersion: 1,
    });
    expect(snapshot.legacyReceipt).toMatchObject({
      operationId: legacyOperationId,
      successLocatorHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("fails closed on unknown integrity versions and idle rows with active authority", async () => {
    for (const integrityVersion of [0, 4]) {
      const t = createTest();
      const ownerId = `unknown-integrity-${integrityVersion}-owner`;
      const operationId = await seedOperation(t, {
        ownerId,
        ownerGeneration: "legacy",
        index: 500 + integrityVersion,
        integrityVersion,
      });
      await t.run(async (ctx) => {
        const operation = await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique();
        await ctx.db.patch(operation!._id, {
          activeStep: "customer_create",
          activeAttemptId: `unknown-integrity-attempt-${integrityVersion}`,
          activeRequestJson: "{}",
          activeRequestFingerprint: hex64(600 + integrityVersion),
          activeIdempotencyKey: `unknown-integrity-key-${integrityVersion}`,
          providerDeadlineAt: 20_000,
          quiescentAfterAt: 20_001,
        });
      });
      const purge = await beginPurge(t, ownerId, "delete");

      const result = await t.mutation(quiesceForPurge, {
        ...purge,
        mode: "delete",
        now: 10_002,
      });
      expect(result.ready).toBe(false);
      expect(result.pending).toContain(
        `stripe_operation_malformed:${operationId}`,
      );
      await expect(
        t.query(remainingDispatches, { ownerId, now: 10_002 }),
      ).resolves.toContain(`stripe_operation_malformed:${operationId}`);
    }

    const t = createTest();
    const ownerId = "idle-orphan-authority-owner";
    const attemptOnlyId = await seedOperation(t, {
      ownerId,
      ownerGeneration: "legacy",
      index: 550,
      integrityVersion: 2,
    });
    const lateOnlyId = await seedOperation(t, {
      ownerId,
      ownerGeneration: "legacy",
      index: 551,
      integrityVersion: 2,
    });
    const metadataOnlyId = await seedOperation(t, {
      ownerId,
      ownerGeneration: "legacy",
      index: 552,
      integrityVersion: 2,
    });
    await t.run(async (ctx) => {
      const [attemptOnly, lateOnly, metadataOnly] = await Promise.all([
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", attemptOnlyId),
          )
          .unique(),
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", lateOnlyId))
          .unique(),
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", metadataOnlyId),
          )
          .unique(),
      ]);
      await ctx.db.patch(attemptOnly!._id, {
        activeAttemptId: "idle-active-attempt",
      });
      await ctx.db.patch(lateOnly!._id, {
        lateResultConflictAt: 9_000,
      });
      await ctx.db.patch(metadataOnly!._id, {
        stripeCustomerMetadataTransferAttemptId: "orphan-transfer-attempt",
      });
    });
    const purge = await beginPurge(t, ownerId, "delete");
    const malformed = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: 10_002,
    });
    expect(malformed.ready).toBe(false);
    expect(malformed.pending).toEqual(
      expect.arrayContaining(
        [attemptOnlyId, lateOnlyId, metadataOnlyId].map(
          (operationId) => `stripe_operation_malformed:${operationId}`,
        ),
      ),
    );
    const remaining = await t.query(remainingDispatches, {
      ownerId,
      now: 10_002,
    });
    expect(remaining).toEqual(
      expect.arrayContaining(
        [attemptOnlyId, lateOnlyId, metadataOnlyId].map(
          (operationId) => `stripe_operation_malformed:${operationId}`,
        ),
      ),
    );
  });

  it("normalizes a complete active v2 receipt while preserving provider recovery", async () => {
    const t = createTest();
    const ownerId = "active-v2-receipt-owner";
    const generation = "active-v2-generation";
    await seedActiveOwner(t, ownerId, generation);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration: generation,
      index: 553,
    });
    const marked = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration: generation,
      operationId,
      attemptId: "active-v2-attempt",
      step: "customer_create",
      requestJson: JSON.stringify({ metadata: { ownerId } }),
      now: TEST_CLOCK + 90_000,
    });
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      await ctx.db.patch(operation!._id, { integrityVersion: 2 });
      const receipt = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique();
      await ctx.db.patch(receipt!._id, { providerOwnerHash: undefined });
    });
    const purge = await beginPurge(t, ownerId, "delete");
    const result = await t.mutation(quiesceForPurge, {
      ...purge,
      mode: "delete",
      now: marked.providerDeadlineAt - 1,
    });
    expect(result.ready).toBe(false);
    expect(result.pending).toContain(
      `stripe_operation_dispatching:${operationId}`,
    );
    expect(await readOperation(t, operationId)).toMatchObject({
      integrityVersion: 3,
      dispatchState: "may_have_dispatched",
      activeAttemptId: marked.attemptId,
    });
    const repairedReceipt = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
    );
    await expect(ownershipMigrationSourceDigest(ownerId)).resolves.toBe(
      repairedReceipt?.providerOwnerHash,
    );
    await expect(
      t.query(remainingDispatches, {
        ownerId,
        now: marked.providerDeadlineAt - 1,
      }),
    ).resolves.toContain(`stripe_operation_customer_create:${operationId}`);
  });

  it("normalizes row 257 across restart-safe cursorless integrity passes", async () => {
    const t = createTest();
    const ownerId = "integrity-257-owner";
    await seedManyOperations(t, {
      ownerId,
      ownerGeneration: "legacy",
      count: 257,
    });
    const purge = await beginPurge(t, ownerId, "delete");

    let completed = false;
    for (let pass = 0; pass < 12; pass += 1) {
      const result = await t.mutation(quiesceForPurge, {
        ...purge,
        mode: "delete",
        now: 10_002,
      });
      if (result.ready) {
        completed = true;
        break;
      }
      expect(result.pending).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /stripe_operation_(?:integrity_scan|dispatch):additional_rows/u,
          ),
        ]),
      );
      expect(result.retryAt).toBe(10_002);
    }
    expect(completed).toBe(true);
    expect(await readOperation(t, "operation-256")).toMatchObject({
      integrityVersion: 3,
    });
    await expect(
      t.query(remainingDispatches, { ownerId, now: 10_002 }),
    ).resolves.toEqual([]);
  }, 30_000);

  it("adopts row 257 across restart-safe passes and catches a row-257 conflict", async () => {
    const same = createTest();
    const sameOwner = "adoption-257-owner";
    await seedProfile(same, sameOwner, {
      authorityEpoch: 0,
      adoptionScanEpoch: -1,
    });
    await seedManyOperations(same, {
      ownerId: sameOwner,
      ownerGeneration: "legacy",
      count: 257,
      integrityVersion: 3,
      stripeCustomerForIndex: () => "cus_recovered_257",
    });
    const samePurge = await beginPurge(same, sameOwner, "reset");
    let adoptionComplete = false;
    for (let pass = 0; pass < 40; pass += 1) {
      const result = await same.mutation(quiesceForPurge, {
        ...samePurge,
        mode: "reset",
        now: 10_002,
      });
      if (result.ready) {
        adoptionComplete = true;
        break;
      }
      expect(result.pending).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /(?:stripe_operation_dispatch|stripe_customer_adoption):additional_rows/u,
          ),
        ]),
      );
    }
    expect(adoptionComplete).toBe(true);
    const adopted = await same.run(async (ctx) =>
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", sameOwner))
        .unique(),
    );
    expect(adopted).toMatchObject({
      stripeCustomerId: "cus_recovered_257",
      stripeCustomerAdoptionScanEpoch: 0,
    });
    expect(await readOperation(same, "operation-256")).toMatchObject({
      stripeCustomerAuthorityEpoch: 0,
    });

    const mixed = createTest();
    const mixedOwner = "adoption-257-conflict-owner";
    await seedProfile(mixed, mixedOwner, {
      authorityEpoch: 0,
      adoptionScanEpoch: -1,
    });
    await seedManyOperations(mixed, {
      ownerId: mixedOwner,
      ownerGeneration: "legacy",
      count: 257,
      integrityVersion: 3,
      stripeCustomerForIndex: (index) =>
        index === 256 ? "cus_conflict_257" : "cus_recovered_257",
    });
    const mixedPurge = await beginPurge(mixed, mixedOwner, "reset");
    let sawConflict = false;
    for (let pass = 0; pass < 40; pass += 1) {
      try {
        await mixed.mutation(quiesceForPurge, {
          ...mixedPurge,
          mode: "reset",
          now: 10_002,
        });
      } catch (error) {
        expect(String(error)).toMatch(/different active Stripe customer/u);
        sawConflict = true;
        break;
      }
    }
    expect(sawConflict).toBe(true);
    expect(await readOperation(mixed, "operation-256")).not.toHaveProperty(
      "stripeCustomerAuthorityEpoch",
    );
  }, 30_000);

  it("keeps one customer-create authority across reset and captures a losing concurrent result", async () => {
    const t = createTest();
    const ownerId = "reset-customer-key-owner";
    const oldGeneration = "reset-customer-key-old";
    const nextGeneration = "reset-customer-key-new";
    const firstRequestKey = hex64(401);
    const firstFingerprint = hex64(402);
    await seedActiveOwner(t, ownerId, oldGeneration);
    await seedProfile(t, ownerId, {
      authorityEpoch: 0,
      adoptionScanEpoch: -1,
    });
    const firstOperationId = await seedOperation(t, {
      ownerId,
      ownerGeneration: oldGeneration,
      index: 140,
      authorityEpoch: 0,
      requestKey: firstRequestKey,
      requestFingerprint: firstFingerprint,
    });

    const purge = await beginPurge(t, ownerId, "reset");
    await expect(
      t.mutation(quiesceForPurge, {
        ...purge,
        mode: "reset",
        now: 10_002,
      }),
    ).resolves.toEqual({ ready: true, pending: [], retryAt: null });
    const adoptedBeforeReopen = await readOperation(t, firstOperationId);
    expect(adoptedBeforeReopen?.stripeCustomerCreateIdempotencyKey).toBe(
      "customer-key-140",
    );
    await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
      ...purge,
      stage: "core",
      nextStage: "cloud",
      now: 10_003,
    });
    const cloudLeaseId = "reset-customer-key-cloud";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "cloud",
      leaseId: cloudLeaseId,
      now: 10_004,
    });
    await t.run(async (ctx) => {
      await seedReadyPurgeBackupSweep(ctx, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        now: 10_005,
      });
    });
    await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: cloudLeaseId,
      nextGeneration,
      now: 10_005,
    });

    const first = await t.mutation(reserveStripeOperation, {
      ownerId,
      ownerGeneration: nextGeneration,
      kind: "subscription_checkout",
      requestKey: firstRequestKey,
      requestFingerprint: firstFingerprint,
      now: 10_006,
    });
    const second = await t.mutation(reserveStripeOperation, {
      ownerId,
      ownerGeneration: nextGeneration,
      kind: "usage_credit_checkout",
      requestKey: hex64(403),
      requestFingerprint: hex64(404),
      now: 10_007,
    });
    expect(first.operationId).toBe(firstOperationId);
    expect(first.stripeCustomerCreateIdempotencyKey).toBe(
      second.stripeCustomerCreateIdempotencyKey,
    );

    const customerRequestJson = JSON.stringify({
      metadata: {
        ownerId,
        stellaCustomerAuthorityId: first.stripeCustomerCreateIdempotencyKey,
      },
    });
    const firstMark = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration: nextGeneration,
      operationId: first.operationId,
      attemptId: "post-reset-customer-first",
      step: "customer_create",
      requestJson: customerRequestJson,
      now: TEST_CLOCK + 70_000,
    });
    const secondMark = await t.mutation(markStripeOperation, {
      ownerId,
      ownerGeneration: nextGeneration,
      operationId: second.operationId,
      attemptId: "post-reset-customer-second",
      step: "customer_create",
      requestJson: customerRequestJson,
      now: TEST_CLOCK + 70_001,
    });
    expect(firstMark.idempotencyKey).toBe(secondMark.idempotencyKey);
    expect(firstMark.requestFingerprint).toBe(secondMark.requestFingerprint);

    await t.mutation(settleStripeOperation, {
      ...exactTuple(
        ownerId,
        nextGeneration,
        first.operationId,
        "customer_create",
        firstMark,
      ),
      stripeCustomerId: "cus_reset_winner",
      now: TEST_CLOCK + 70_002,
    });
    await expect(
      t.mutation(settleStripeOperation, {
        ...exactTuple(
          ownerId,
          nextGeneration,
          second.operationId,
          "customer_create",
          secondMark,
        ),
        stripeCustomerId: "cus_reset_loser",
        now: TEST_CLOCK + 70_003,
      }),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    const snapshot = await t.run(async (ctx) => ({
      profile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      losingResult: await ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_operationId_and_attemptId", (q) =>
          q
            .eq("operationId", second.operationId)
            .eq("attemptId", secondMark.attemptId),
        )
        .unique(),
    }));
    expect(snapshot.profile?.stripeCustomerId).toBe("cus_reset_winner");
    expect(snapshot.losingResult).toMatchObject({
      stripeCustomerId: "cus_reset_loser",
      attemptId: secondMark.attemptId,
    });
  });

  it("classifies late-result, legacy, and integrity-only rows in strict remaining readback", async () => {
    const t = createTest();
    const ownerId = "remaining-classification-owner";
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_operations", {
        ownerId,
        ownerGeneration: "generation",
        operationId: "late-provider-succeeded",
        kind: "subscription_checkout",
        state: "provider_succeeded",
        dispatchState: "idle",
        integrityVersion: 1,
        stripeCustomerAuthorityEpoch: 0,
        idempotencyKey: "late-operation-key",
        stripeCustomerCreateIdempotencyKey: "late-customer-key",
        requestKey: hex64(201),
        requestFingerprint: hex64(202),
        stripeCustomerId: "cus_remaining",
        stripeCheckoutSessionId: "cs_remaining",
        manualDebtReason: "late_result_conflict",
        lateResultConflictStep: "checkout_create",
        lateResultConflictAttemptId: "late-remaining-attempt",
        lateResultRequestFingerprint: hex64(203),
        lateResultIdempotencyKey: "late-remaining-key",
        lateResultProviderDeadlineAt: 100,
        lateResultStripeCustomerId: "cus_remaining",
        lateResultStripeCheckoutSessionId: "cs_remaining_late",
        lateResultConflictAt: 200,
        lateResultConflictQuiescentAfterAt: 200,
        leaseExpiresAt: 200,
        createdAt: 1,
        updatedAt: 200,
      });
      await ctx.db.insert("billing_stripe_operations", {
        ownerId,
        ownerGeneration: "generation",
        operationId: "legacy-debt",
        kind: "subscription_checkout",
        state: "reserved",
        idempotencyKey: "legacy-operation-key",
        stripeCustomerCreateIdempotencyKey: "legacy-customer-key",
        requestKey: hex64(204),
        requestFingerprint: hex64(205),
        manualDebtReason: "legacy_missing_receipt",
        leaseExpiresAt: 0,
        createdAt: 2,
        updatedAt: 2,
      });
      await ctx.db.insert("billing_stripe_operations", {
        ownerId,
        ownerGeneration: "generation",
        operationId: "integrity-only",
        kind: "subscription_checkout",
        state: "completed",
        dispatchState: "idle",
        stripeCustomerAuthorityEpoch: 0,
        idempotencyKey: "integrity-operation-key",
        stripeCustomerCreateIdempotencyKey: "integrity-customer-key",
        requestKey: hex64(206),
        requestFingerprint: hex64(207),
        leaseExpiresAt: 0,
        createdAt: 3,
        updatedAt: 3,
      });
    });

    const labels = await t.query(remainingDispatches, { ownerId, now: 1_000 });
    expect(labels).toEqual(
      expect.arrayContaining([
        "stripe_operation_manual_reconciliation:late_result_conflict:late-provider-succeeded",
        "stripe_operation_legacy_manual_reconciliation:legacy-debt",
        "stripe_operation_malformed:integrity-only",
      ]),
    );
    expect(labels).not.toContain("stripe_operation_malformed:legacy-debt");
  });

  it("persists legacy retry debt before returning a caller-visible blocked result", async () => {
    const t = createTest();
    const ownerId = "legacy-retry-owner";
    const ownerGeneration = "legacy-retry-generation";
    const requestKey = hex64(301);
    const requestFingerprint = hex64(302);
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 130,
      modern: false,
      requestKey,
      requestFingerprint,
      leaseExpiresAt: 1,
    });
    const retry = {
      ownerId,
      ownerGeneration,
      kind: "subscription_checkout" as const,
      requestKey,
      requestFingerprint,
      now: 100,
    };
    await expect(
      t.mutation(reserveStripeOperation, retry),
    ).resolves.toMatchObject({
      operationId,
      blockedReason: "legacy_missing_receipt",
    });
    expect(await readOperation(t, operationId)).toMatchObject({
      manualDebtReason: "legacy_missing_receipt",
    });
    await expect(
      t.mutation(reserveStripeOperation, { ...retry, now: 101 }),
    ).resolves.toMatchObject({
      operationId,
      blockedReason: "legacy_missing_receipt",
    });
    expect(await readOperation(t, operationId)).toMatchObject({
      manualDebtReason: "legacy_missing_receipt",
    });
  });

  it("promotes clean coarse legacy debt only after exhaustive receipt provenance", async () => {
    const t = createTest();
    const ownerId = "legacy-coarse-manual-clean-owner";
    const ownerGeneration = "legacy-coarse-manual-clean-generation";
    await seedActiveOwner(t, ownerId, ownerGeneration);
    await seedProfile(t, ownerId);
    const operationId = await seedOperation(t, {
      ownerId,
      ownerGeneration,
      index: 705,
      modern: false,
      integrityVersion: 2,
      manualDebtReason: "legacy_missing_receipt",
      leaseExpiresAt: 1,
    });
    const resolution = {
      ownerId,
      ownerGeneration,
      operationId,
      resolutionId: "legacy-coarse-manual-clean-resolution",
      expectedStep: "customer_create" as const,
      resolution: { kind: "provider_confirmed_not_created" as const },
      resolvedBy: "operator@example.test",
      evidence: "The legacy operation has no unexplained physical receipt.",
    };
    const beforeFakeAttempt = await readOperation(t, operationId);
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...resolution,
        expectedAttemptId: "invented-legacy-physical-attempt",
        now: 2,
      }),
    ).rejects.toThrow(/must not name a physical attempt/iu);
    expect(await readOperation(t, operationId)).toEqual(beforeFakeAttempt);
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_operationId_and_resolvedAt", (q) =>
            q.eq("operationId", operationId),
          )
          .collect(),
      ),
    ).resolves.toEqual([]);

    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...resolution,
        now: 3,
      }),
    ).resolves.toEqual({
      resolution: "provider_confirmed_not_created",
      replayed: false,
    });
    await expect(
      t.mutation(resolveStripeManualDebt, {
        ...resolution,
        now: 4,
      }),
    ).resolves.toEqual({
      resolution: "provider_confirmed_not_created",
      replayed: true,
    });

    const snapshot = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .unique(),
      resolutions: await ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_operationId_and_resolvedAt", (q) =>
          q.eq("operationId", operationId),
        )
        .collect(),
    }));
    expect(snapshot.operation).toMatchObject({
      state: "reserved",
      dispatchState: "idle",
      integrityVersion: 3,
    });
    expect(snapshot.operation?.manualDebtReason).toBeUndefined();
    expect(snapshot.resolutions).toEqual([
      expect.objectContaining({
        operationId,
        resolutionId: "legacy-coarse-manual-clean-resolution",
        debtKey: "legacy:customer_create:legacy_missing_receipt",
        resolution: "provider_confirmed_not_created",
      }),
    ]);
  });

  it.each([
    {
      label: "an unbound not-created receipt",
      receipt: async () => ({
        tupleHash: hex64(1_300_001),
        notCreatedTerminalized: true as const,
      }),
    },
    {
      label: "a foreign success receipt",
      receipt: async () => ({
        tupleHash: hex64(1_300_002),
        providerOwnerHash: await ownershipMigrationSourceDigest(
          "legacy-coarse-manual-foreign-owner",
        ),
        successLocatorHash: await hashStripePhysicalSuccessLocators({
          stripeCustomerId: "cus_legacy_coarse_foreign",
        }),
      }),
    },
  ])(
    "rejects coarse legacy debt with $label atomically",
    async ({ receipt }) => {
      const t = createTest();
      const ownerId = "legacy-coarse-manual-corrupt-owner";
      const ownerGeneration = "legacy-coarse-manual-corrupt-generation";
      await seedActiveOwner(t, ownerId, ownerGeneration);
      await seedProfile(t, ownerId);
      const operationId = await seedOperation(t, {
        ownerId,
        ownerGeneration,
        index: 706,
        modern: false,
        integrityVersion: 2,
        manualDebtReason: "legacy_missing_receipt",
        leaseExpiresAt: 1,
      });
      await t.run(async (ctx) => {
        await ctx.db.insert("billing_stripe_physical_receipts", {
          operationId,
          ...(await receipt()),
          createdAt: 1,
        });
      });
      const before = await t.run(async (ctx) => ({
        operation: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique(),
        profile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        receipts: await ctx.db
          .query("billing_stripe_physical_receipts")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .collect(),
        resolutions: await ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_operationId_and_resolvedAt", (q) =>
            q.eq("operationId", operationId),
          )
          .collect(),
      }));

      await expect(
        t.mutation(resolveStripeManualDebt, {
          ownerId,
          ownerGeneration,
          operationId,
          resolutionId: "legacy-coarse-manual-corrupt-resolution",
          expectedStep: "customer_create",
          resolution: { kind: "provider_confirmed_not_created" },
          resolvedBy: "operator@example.test",
          evidence: "This debt must not hide unexplained physical authority.",
          now: 2,
        }),
      ).rejects.toThrow(/receipt provenance requires reconciliation/iu);

      const after = await t.run(async (ctx) => ({
        operation: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique(),
        profile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        receipts: await ctx.db
          .query("billing_stripe_physical_receipts")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .collect(),
        resolutions: await ctx.db
          .query("billing_stripe_operation_resolutions")
          .withIndex("by_operationId_and_resolvedAt", (q) =>
            q.eq("operationId", operationId),
          )
          .collect(),
      }));
      expect(after).toEqual(before);
    },
  );
});

describe("bounded Checkout discovery", () => {
  it("proves an early singleton only after the final page", async () => {
    const pages = [
      {
        data: [{ id: "cs_match", metadata: { stellaOperationId: "op" } }],
        has_more: true,
      },
      { data: [{ id: "cs_other", metadata: {} }], has_more: false },
    ];
    const listPage = vi.fn(async () => pages.shift()!);
    await expect(
      discoverUniqueStripeCheckoutSession({ operationId: "op", listPage }),
    ).resolves.toEqual({ kind: "found", sessionId: "cs_match" });
    expect(listPage).toHaveBeenCalledTimes(2);
  });

  it("keeps split-page duplicates and an unexhausted horizon as manual debt", async () => {
    const duplicatePages = [
      {
        data: [{ id: "cs_one", metadata: { stellaOperationId: "op" } }],
        has_more: true,
      },
      {
        data: [{ id: "cs_two", metadata: { stellaOperationId: "op" } }],
        has_more: false,
      },
    ];
    await expect(
      discoverUniqueStripeCheckoutSession({
        operationId: "op",
        listPage: async () => duplicatePages.shift()!,
      }),
    ).resolves.toEqual({ kind: "manual_debt", reason: "duplicate" });

    const listPage = vi.fn(async (_startingAfter?: string) => ({
      data: [
        {
          id: `cs_page_${listPage.mock.calls.length}`,
          metadata:
            listPage.mock.calls.length === 1
              ? { stellaOperationId: "op" }
              : ({} as Record<string, string>),
        },
      ],
      has_more: true,
    }));
    await expect(
      discoverUniqueStripeCheckoutSession({ operationId: "op", listPage }),
    ).resolves.toEqual({ kind: "manual_debt", reason: "scan_horizon" });
    expect(listPage).toHaveBeenCalledTimes(10);
  });
});
