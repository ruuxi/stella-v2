/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { hasVerifiedMigratedStripeChildOwner } from "./account_billing_purge";
import { ownershipMigrationSourceDigest } from "./lib/auth_migration_paths";
import { hashStripePhysicalSuccessLocators } from "./lib/billing_deletion";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;
const LEGACY_GENERATION = "legacy";

const seedProfile = async (
  t: TestHarness,
  args: {
    ownerId: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
  },
) => {
  await t.run(async (ctx) => {
    const now = 1_000;
    await ctx.db.insert("billing_profiles", {
      ownerId: args.ownerId,
      activePlan: "free",
      subscriptionStatus: "none",
      stripeCustomerId: args.stripeCustomerId ?? "",
      stripeSubscriptionId: args.stripeSubscriptionId ?? "",
      stripePriceId: "",
      defaultPaymentMethodId: "",
      paymentMethodBrand: "",
      paymentMethodLast4: "",
      currentPeriodStart: 0,
      currentPeriodEnd: 0,
      cancelAtPeriodEnd: false,
      monthlyAnchorAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
};

const beginDeleteAndClaimCoreLease = async (
  t: TestHarness,
  ownerId: string,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId: `delete-${ownerId}`, mode: "delete", now: 10_000 },
  );
  const leaseId = `lease-${ownerId}`;
  expect(
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId,
      now: 10_001,
    }),
  ).toMatchObject({ claimed: true, mode: "delete" });
  return {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId,
  };
};

const settleReservedCheckout = async (
  t: TestHarness,
  args: {
    ownerId: string;
    operationId: string;
    ownerGeneration: string;
    stripeCustomerId: string;
    stripeCheckoutSessionId: string;
    attemptId: string;
    now: number;
  },
) => {
  const marked = await t.mutation(
    internal.stripe_operation_dispatch.markStripeOperationDispatchInternal,
    {
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
    },
  );
  await t.mutation(
    internal.stripe_operation_dispatch.settleStripeOperationDispatchInternal,
    {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      operationId: args.operationId,
      attemptId: marked.attemptId,
      step: "checkout_create",
      requestFingerprint: marked.requestFingerprint,
      idempotencyKey: marked.idempotencyKey,
      providerDeadlineAt: marked.providerDeadlineAt,
      stripeCustomerId: args.stripeCustomerId,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      now: args.now + 1,
    },
  );
  return marked;
};

const resetAndReopenOwner = async (t: TestHarness, ownerId: string) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId: `reset-${ownerId}`, mode: "reset", now: 20_000 },
  );
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId: "reset-core-lease",
    now: 20_001,
  });
  await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId: "reset-core-lease",
    stage: "core",
    nextStage: "cloud",
    now: 20_002,
  });
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "cloud",
    leaseId: "reset-cloud-lease",
    now: 20_003,
  });
  await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId: "reset-cloud-lease",
    nextGeneration: `reopened-${ownerId}`,
    now: 20_004,
  });
};

describe("billing webhook lifecycle and claim races", () => {
  it("discards deleting and migrated owners, but asks a resetting owner to retry", async () => {
    const t = createTest();

    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId: "resetting-owner",
      operationId: "reset-op",
      mode: "reset",
      now: 1_000,
    });
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId: "deleting-owner",
      operationId: "delete-op",
      mode: "delete",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: "migrated-owner",
        toOwnerId: "destination-owner",
        status: "running",
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    });

    await expect(
      t.mutation(internal.billing.recordStripeEvent, {
        eventId: "evt-resetting",
        claimId: "worker-resetting",
        eventType: "invoice.paid",
        ownerId: "resetting-owner",
        createdAt: 1,
      }),
    ).resolves.toEqual({ accepted: false, status: "retry" });
    await expect(
      t.mutation(internal.billing.recordStripeEvent, {
        eventId: "evt-deleting",
        claimId: "worker-deleting",
        eventType: "invoice.paid",
        ownerId: "deleting-owner",
        createdAt: 1,
      }),
    ).resolves.toEqual({ accepted: false, status: "discarded" });
    await expect(
      t.mutation(internal.billing.recordStripeEvent, {
        eventId: "evt-migrated",
        claimId: "worker-migrated",
        eventType: "invoice.paid",
        ownerId: "migrated-owner",
        createdAt: 1,
      }),
    ).resolves.toEqual({ accepted: false, status: "retry" });

    await expect(
      t.mutation(internal.billing.recordStripeEvent, {
        eventId: "evt-incoming-destination",
        claimId: "worker-incoming-destination",
        eventType: "invoice.paid",
        ownerId: "destination-owner",
        createdAt: 1,
      }),
    ).resolves.toEqual({ accepted: false, status: "retry" });

    let events = await t.run(async (ctx) =>
      ctx.db.query("billing_stripe_events").take(10),
    );
    expect(events).toHaveLength(0);

    await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
          q.eq("fromOwnerId", "migrated-owner"),
        )
        .unique();
      if (!migration) throw new Error("missing ownership migration");
      await ctx.db.patch(migration._id, {
        status: "complete",
        updatedAt: 2_000,
      });
    });
    await expect(
      t.mutation(internal.billing.recordStripeEvent, {
        eventId: "evt-incoming-destination-after-complete",
        claimId: "worker-incoming-destination-after-complete",
        eventType: "invoice.paid",
        ownerId: "destination-owner",
        createdAt: 2,
      }),
    ).resolves.toEqual({ accepted: true, status: "accepted" });
    events = await t.run(async (ctx) =>
      ctx.db.query("billing_stripe_events").take(10),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: "evt-incoming-destination-after-complete",
      ownerId: "destination-owner",
      ownerGeneration: LEGACY_GENERATION,
    });
  });

  it("holds an active claim, permits an expired-lease reclaim, and rejects completed replays", async () => {
    const t = createTest();
    const args = {
      eventId: "evt-claim",
      eventType: "checkout.session.completed",
      ownerId: "claim-owner",
      createdAt: 1,
    };

    expect(
      await t.mutation(internal.billing.recordStripeEvent, {
        ...args,
        claimId: "worker-a",
      }),
    ).toEqual({ accepted: true, status: "accepted" });
    expect(
      await t.mutation(internal.billing.recordStripeEvent, {
        ...args,
        claimId: "worker-b",
      }),
    ).toEqual({ accepted: false, status: "in_progress" });

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("billing_stripe_events")
        .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
        .unique();
      await ctx.db.patch(event!._id, { claimExpiresAt: 0 });
    });
    expect(
      await t.mutation(internal.billing.recordStripeEvent, {
        ...args,
        claimId: "worker-b",
      }),
    ).toEqual({ accepted: true, status: "accepted" });
    expect(
      await t.mutation(internal.billing.completeStripeEvent, {
        eventId: args.eventId,
        claimId: "worker-a",
        processedAt: 2,
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.billing.completeStripeEvent, {
        eventId: args.eventId,
        claimId: "worker-b",
        processedAt: 2,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.billing.recordStripeEvent, {
        ...args,
        claimId: "worker-c",
      }),
    ).toEqual({ accepted: false, status: "duplicate" });
  });

  it("retains retry diagnostics instead of deleting a failed webhook claim", async () => {
    const t = createTest();
    const args = {
      eventId: "evt-retry",
      eventType: "customer.updated",
      ownerId: "retry-owner",
      createdAt: 1,
    };
    await t.mutation(internal.billing.recordStripeEvent, {
      ...args,
      claimId: "worker-a",
    });
    expect(
      await t.mutation(internal.billing.releaseStripeEventClaim, {
        eventId: args.eventId,
        claimId: "worker-a",
        error: "temporary provider failure",
        now: 10,
      }),
    ).toBe(true);
    const retained = await t.run(async (ctx) =>
      ctx.db
        .query("billing_stripe_events")
        .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
        .unique(),
    );
    expect(retained).toMatchObject({
      processingState: "retry",
      lastError: "temporary provider failure",
      nextRetryAt: 1_010,
      attempts: 1,
    });
  });

  it("rejects stale webhook projections while retaining an exact provider result across reset", async () => {
    const t = createTest();
    const ownerId = "stripe-generation-owner";
    await seedProfile(t, { ownerId, stripeCustomerId: "cus-generation" });

    expect(
      await t.mutation(internal.billing.recordStripeEvent, {
        eventId: "evt-generation",
        claimId: "claim-generation",
        eventType: "customer.subscription.updated",
        ownerId,
        stripeCustomerId: "cus-generation",
        createdAt: 1,
      }),
    ).toEqual({ accepted: true, status: "accepted" });
    const claimFence = await t.query(
      internal.billing.getStripeEventClaimFenceInternal,
      { eventId: "evt-generation", claimId: "claim-generation" },
    );
    expect(claimFence).toEqual({
      ownerId,
      ownerGeneration: LEGACY_GENERATION,
    });

    const operation = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "subscription_checkout",
        stripeCustomerId: "cus-generation",
        requestKey: "d".repeat(64),
        requestFingerprint: "c".repeat(64),
        now: 2,
      },
    );
    const marked = await t.mutation(
      internal.stripe_operation_dispatch.markStripeOperationDispatchInternal,
      {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        attemptId: "generation-checkout-attempt",
        step: "checkout_create",
        requestJson: JSON.stringify({ customer: "cus-generation" }),
        now: 3,
      },
    );
    await resetAndReopenOwner(t, ownerId);

    await expect(
      t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: claimFence!.ownerGeneration,
        stripeEventCreatedAt: 2,
        stripeEventId: "evt-generation",
        stripeCustomerId: "cus-generation",
        stripeSubscriptionId: "sub-stale",
        requestedPlan: "pro",
        subscriptionStatus: "active",
      }),
    ).rejects.toThrow(/started before the account data was reset/u);
    expect(
      await t.mutation(
        internal.stripe_operation_dispatch
          .settleStripeOperationDispatchInternal,
        {
          ownerId,
          ownerGeneration: operation.ownerGeneration,
          operationId: operation.operationId,
          attemptId: marked.attemptId,
          step: "checkout_create",
          requestFingerprint: marked.requestFingerprint,
          idempotencyKey: marked.idempotencyKey,
          providerDeadlineAt: marked.providerDeadlineAt,
          stripeCustomerId: "cus-generation",
          stripeCheckoutSessionId: "cs-stale",
          now: 20_005,
        },
      ),
    ).toEqual({ recorded: true, duplicate: false, customerDeleted: false });

    const snapshot = await t.run(async (ctx) => ({
      profile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
    }));
    expect(snapshot.profile).toMatchObject({
      activePlan: "free",
      stripeSubscriptionId: "",
    });
    expect(snapshot.operation).toMatchObject({
      state: "provider_succeeded",
      stripeCheckoutSessionId: "cs-stale",
    });
  });
});

describe("Stripe projections retain their monotonic ownership and credit rules", () => {
  it("keeps newer subscription and invoice projections and credits a paid checkout exactly once", async () => {
    const t = createTest();
    const ownerId = "ordered-owner";
    await seedProfile(t, { ownerId, stripeCustomerId: "cus-ordered" });

    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 200,
        stripeCustomerId: "cus-ordered",
        stripeSubscriptionId: "sub-ordered",
        requestedPlan: "go",
        subscriptionStatus: "active",
      }),
    ).toMatchObject({ updated: true, activePlan: "go" });
    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 100,
        stripeCustomerId: "cus-ordered",
        stripeSubscriptionId: "sub-ordered",
        requestedPlan: "go",
        subscriptionStatus: "canceled",
      }),
    ).toMatchObject({ updated: false, activePlan: "go" });

    expect(
      await t.mutation(internal.billing.recordInvoicePayment, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 200,
        stripeCustomerId: "cus-ordered",
        stripeInvoiceId: "in-ordered",
        stripePaymentIntentId: "pi-ordered",
        stripeSubscriptionId: "sub-ordered",
        amountPaidCents: 1_000,
        currency: "usd",
        billingReason: "subscription_cycle",
        status: "paid",
      }),
    ).toEqual({ recorded: true });
    expect(
      await t.mutation(internal.billing.recordInvoicePayment, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 100,
        stripeCustomerId: "cus-ordered",
        stripeInvoiceId: "in-ordered",
        stripePaymentIntentId: "pi-ordered",
        stripeSubscriptionId: "sub-ordered",
        amountPaidCents: 1,
        currency: "usd",
        billingReason: "subscription_cycle",
        status: "void",
      }),
    ).toEqual({ recorded: false });

    const purchase = {
      ownerId,
      ownerGeneration: LEGACY_GENERATION,
      stripeCheckoutSessionId: "cs-ordered",
      stripePaymentIntentId: "pi-credit-ordered",
      stripeCustomerId: "cus-ordered",
      amountCents: 500,
      currency: "usd",
    };
    expect(
      await t.mutation(internal.billing.recordUsageCreditPurchase, {
        ...purchase,
        stripeEventCreatedAt: 300,
        status: "paid",
      }),
    ).toMatchObject({ credited: true, amountMicroCents: 500_000_000 });
    expect(
      await t.mutation(internal.billing.recordUsageCreditPurchase, {
        ...purchase,
        stripeEventCreatedAt: 301,
        status: "paid",
      }),
    ).toMatchObject({ credited: false, amountMicroCents: 500_000_000 });
    expect(
      await t.mutation(internal.billing.recordUsageCreditPurchase, {
        ...purchase,
        stripeEventCreatedAt: 100,
        status: "expired",
      }),
    ).toMatchObject({ credited: false });

    const snapshot = await t.run(async (ctx) => {
      const [profile, invoice, credit, creditPurchase] = await Promise.all([
        ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        ctx.db
          .query("billing_invoice_payments")
          .withIndex("by_stripeInvoiceId", (q) =>
            q.eq("stripeInvoiceId", "in-ordered"),
          )
          .unique(),
        ctx.db
          .query("billing_usage_credits")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        ctx.db
          .query("billing_usage_credit_purchases")
          .withIndex("by_stripeCheckoutSessionId", (q) =>
            q.eq("stripeCheckoutSessionId", "cs-ordered"),
          )
          .unique(),
      ]);
      return { profile, invoice, credit, creditPurchase };
    });
    expect(snapshot.profile).toMatchObject({
      activePlan: "go",
      subscriptionStatus: "active",
      stripeSubscriptionUpdatedAt: 200,
    });
    expect(snapshot.invoice).toMatchObject({
      amountPaidCents: 1_000,
      status: "paid",
      lastStripeEventCreatedAt: 200,
    });
    expect(snapshot.credit).toMatchObject({
      balanceMicroCents: 500_000_000,
      totalPurchasedMicroCents: 500_000_000,
    });
    expect(snapshot.creditPurchase).toMatchObject({
      status: "paid",
      creditedAmountMicroCents: 500_000_000,
      lastStripeEventCreatedAt: 301,
    });
  });

  it("rejects cross-owner reuse of customer, invoice, and checkout identifiers", async () => {
    const t = createTest();
    await seedProfile(t, {
      ownerId: "owner-a",
      stripeCustomerId: "cus-shared",
    });
    await seedProfile(t, { ownerId: "owner-b" });
    const operation = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId: "owner-b",
        ownerGeneration: LEGACY_GENERATION,
        kind: "subscription_checkout",
        requestKey: "9".repeat(64),
        requestFingerprint: "8".repeat(64),
        now: 1,
      },
    );
    const marked = await t.mutation(
      internal.stripe_operation_dispatch.markStripeOperationDispatchInternal,
      {
        ownerId: "owner-b",
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        attemptId: "cross-owner-customer-attempt",
        step: "customer_create",
        requestJson: JSON.stringify({ metadata: { ownerId: "owner-b" } }),
        now: 2,
      },
    );
    await expect(
      t.mutation(
        internal.stripe_operation_dispatch
          .settleStripeOperationDispatchInternal,
        {
          ownerId: "owner-b",
          ownerGeneration: operation.ownerGeneration,
          operationId: operation.operationId,
          attemptId: marked.attemptId,
          step: "customer_create",
          requestFingerprint: marked.requestFingerprint,
          idempotencyKey: marked.idempotencyKey,
          providerDeadlineAt: marked.providerDeadlineAt,
          stripeCustomerId: "cus-shared",
          now: 3,
        },
      ),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_late_results")
          .withIndex("by_operationId_and_attemptId", (q) =>
            q
              .eq("operationId", operation.operationId)
              .eq("attemptId", marked.attemptId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({ stripeCustomerId: "cus-shared" });

    await t.mutation(internal.billing.recordInvoicePayment, {
      ownerId: "owner-a",
      ownerGeneration: LEGACY_GENERATION,
      stripeEventCreatedAt: 1,
      stripeInvoiceId: "in-shared",
      amountPaidCents: 500,
      currency: "usd",
      billingReason: "subscription_cycle",
      status: "paid",
    });
    await expect(
      t.mutation(internal.billing.recordInvoicePayment, {
        ownerId: "owner-b",
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 2,
        stripeInvoiceId: "in-shared",
        amountPaidCents: 500,
        currency: "usd",
        billingReason: "subscription_cycle",
        status: "paid",
      }),
    ).rejects.toThrow(/ownership cannot be changed/u);

    await t.mutation(internal.billing.recordUsageCreditPurchase, {
      ownerId: "owner-a",
      ownerGeneration: LEGACY_GENERATION,
      stripeEventCreatedAt: 1,
      stripeCheckoutSessionId: "cs-shared",
      stripeCustomerId: "cus-shared",
      amountCents: 500,
      currency: "usd",
      status: "paid",
    });
    await expect(
      t.mutation(internal.billing.recordUsageCreditPurchase, {
        ownerId: "owner-b",
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 2,
        stripeCheckoutSessionId: "cs-shared",
        stripeCustomerId: "cus-other",
        amountCents: 500,
        currency: "usd",
        status: "paid",
      }),
    ).rejects.toThrow(/identity cannot be changed/u);
  });

  it("makes customer deletion terminal against already-claimed Stripe callbacks and permits a fresh customer", async () => {
    const t = createTest();
    const ownerId = "customer-deleted-owner";
    await seedProfile(t, { ownerId, stripeCustomerId: "cus-deleted" });

    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 100,
        stripeEventId: "evt-sub-active",
        stripeCustomerId: "cus-deleted",
        stripeSubscriptionId: "sub-deleted",
        requestedPlan: "go",
        subscriptionStatus: "active",
      }),
    ).toMatchObject({ updated: true, activePlan: "go" });

    // This models a callback admitted before customer.deleted committed. Its
    // handler still has to lose when it reaches the transactional projection.
    expect(
      await t.mutation(internal.billing.recordStripeEvent, {
        eventId: "evt-already-claimed-subscription",
        claimId: "stripe-worker",
        eventType: "customer.subscription.updated",
        ownerId,
        stripeCustomerId: "cus-deleted",
        stripeSubscriptionId: "sub-deleted",
        createdAt: 400,
      }),
    ).toEqual({ accepted: true, status: "accepted" });

    expect(
      await t.mutation(internal.billing.syncCustomerDeletionFromStripe, {
        stripeCustomerId: "cus-deleted",
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 300,
        stripeEventId: "evt-customer-deleted",
      }),
    ).toEqual({ updated: true });

    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 400,
        stripeEventId: "evt-already-claimed-subscription",
        stripeCustomerId: "cus-deleted",
        stripeSubscriptionId: "sub-deleted",
        requestedPlan: "pro",
        subscriptionStatus: "active",
      }),
    ).toMatchObject({ updated: false, activePlan: "free" });
    expect(
      await t.mutation(internal.billing.recordStripeEvent, {
        eventId: "evt-after-customer-deletion",
        claimId: "late-stripe-worker",
        eventType: "customer.subscription.updated",
        ownerId,
        stripeCustomerId: "cus-deleted",
        stripeSubscriptionId: "sub-deleted",
        createdAt: 500,
      }),
    ).toEqual({ accepted: false, status: "discarded" });

    const readBillingState = async () =>
      await t.run(async (ctx) => ({
        profile: await ctx.db
          .query("billing_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
        usage: await ctx.db
          .query("billing_usage_windows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
      }));
    const beforeStrayReplacement = await readBillingState();
    expect(beforeStrayReplacement.profile).toMatchObject({
      activePlan: "free",
      stripeCustomerId: "",
      stripeCustomerTerminal: true,
      stripeCustomerAuthorityEpoch: 1,
    });
    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 450,
        stripeEventId: "evt-stray-customer-replacement",
        stripeCustomerId: "cus-stray-after-terminal-deletion",
        stripeSubscriptionId: "sub-stray-after-terminal-deletion",
        requestedPlan: "pro",
        subscriptionStatus: "active",
      }),
    ).toMatchObject({ updated: false, ownerId, activePlan: "free" });
    expect(await readBillingState()).toEqual(beforeStrayReplacement);

    const replacementOperation = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "subscription_checkout",
        requestKey: "7".repeat(64),
        requestFingerprint: "6".repeat(64),
        now: 550,
      },
    );
    const replacementMark = await t.mutation(
      internal.stripe_operation_dispatch.markStripeOperationDispatchInternal,
      {
        ownerId,
        ownerGeneration: replacementOperation.ownerGeneration,
        operationId: replacementOperation.operationId,
        attemptId: "replacement-customer-attempt",
        step: "customer_create",
        requestJson: JSON.stringify({ metadata: { ownerId } }),
        now: 551,
      },
    );
    await expect(
      t.mutation(
        internal.stripe_operation_dispatch
          .settleStripeOperationDispatchInternal,
        {
          ownerId,
          ownerGeneration: replacementOperation.ownerGeneration,
          operationId: replacementOperation.operationId,
          attemptId: replacementMark.attemptId,
          step: "customer_create",
          requestFingerprint: replacementMark.requestFingerprint,
          idempotencyKey: replacementMark.idempotencyKey,
          providerDeadlineAt: replacementMark.providerDeadlineAt,
          stripeCustomerId: "cus-replacement",
          now: 552,
        },
      ),
    ).resolves.toEqual({
      recorded: true,
      duplicate: false,
      customerDeleted: false,
    });
    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 600,
        stripeEventId: "evt-replacement-subscription",
        stripeCustomerId: "cus-replacement",
        stripeSubscriptionId: "sub-replacement",
        requestedPlan: "pro",
        subscriptionStatus: "active",
      }),
    ).toMatchObject({ updated: true, activePlan: "pro" });

    const snapshot = await t.run(async (ctx) => ({
      profile: await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      tombstones: await ctx.db
        .query("billing_stripe_deletion_tombstones")
        .collect(),
    }));
    expect(snapshot.profile).toMatchObject({
      activePlan: "pro",
      stripeCustomerId: "cus-replacement",
      stripeSubscriptionId: "sub-replacement",
      stripeCustomerTerminal: false,
    });
    expect(snapshot.tombstones).toHaveLength(1);
    expect(snapshot.tombstones[0]?.locatorKind).toBe("customer");
  });

  it("keeps a terminal subscription sticky while allowing a replacement subscription", async () => {
    const t = createTest();
    const ownerId = "replacement-owner";
    await seedProfile(t, { ownerId, stripeCustomerId: "cus-replacement" });
    await t.mutation(internal.billing.syncSubscriptionFromStripe, {
      ownerId,
      ownerGeneration: LEGACY_GENERATION,
      stripeEventCreatedAt: 100,
      stripeEventId: "evt-active",
      stripeCustomerId: "cus-replacement",
      stripeSubscriptionId: "sub-old",
      requestedPlan: "go",
      subscriptionStatus: "active",
    });
    await t.mutation(internal.billing.syncSubscriptionFromStripe, {
      ownerId,
      ownerGeneration: LEGACY_GENERATION,
      stripeEventCreatedAt: 200,
      stripeEventId: "evt-deleted",
      stripeEventTerminal: true,
      stripeCustomerId: "cus-replacement",
      stripeSubscriptionId: "sub-old",
      requestedPlan: "go",
      subscriptionStatus: "canceled",
    });
    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 300,
        stripeEventId: "evt-stale-resurrection",
        stripeCustomerId: "cus-replacement",
        stripeSubscriptionId: "sub-old",
        requestedPlan: "go",
        subscriptionStatus: "active",
      }),
    ).toMatchObject({ updated: false, activePlan: "free" });
    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 200,
        stripeEventId: "evt-new-subscription",
        stripeCustomerId: "cus-replacement",
        stripeSubscriptionId: "sub-new",
        requestedPlan: "pro",
        subscriptionStatus: "active",
      }),
    ).toMatchObject({ updated: true, activePlan: "pro" });
    expect(
      await t.mutation(internal.billing.syncSubscriptionFromStripe, {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        stripeEventCreatedAt: 400,
        stripeEventId: "evt-old-delete-late",
        stripeEventTerminal: true,
        stripeCustomerId: "cus-replacement",
        stripeSubscriptionId: "sub-old",
        requestedPlan: "go",
        subscriptionStatus: "canceled",
      }),
    ).toMatchObject({ updated: false, activePlan: "pro" });
  });
});

describe("billing deletion batches", () => {
  it("drains Stripe operator-resolution audits before operation authority", async () => {
    const t = createTest();
    const fence = await beginDeleteAndClaimCoreLease(
      t,
      "stripe-resolution-purge-owner",
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_operation_resolutions", {
        ownerId: fence.ownerId,
        ownerGeneration: LEGACY_GENERATION,
        operationId: "stripe-resolution-purge-operation",
        resolutionId: "stripe-resolution-purge-audit",
        debtKey: "legacy:customer_create",
        step: "customer_create",
        resolution: "provider_confirmed_not_created",
        resolvedByHash: "a".repeat(64),
        evidenceHash: "b".repeat(64),
        resolvedAt: 1,
      });
    });
    await expect(
      t.query(internal.account_billing_purge.remainingOwnerBillingInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.toContain("billing_stripe_operation_resolutions");
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operation_resolutions" },
      ),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    await expect(
      t.query(internal.account_billing_purge.remainingOwnerBillingInternal, {
        ownerId: fence.ownerId,
      }),
    ).resolves.not.toContain("billing_stripe_operation_resolutions");
  });

  it("keeps more than 100 manual proofs until every proof-backed operation is tombstoned", async () => {
    const t = createTest();
    const fence = await beginDeleteAndClaimCoreLease(
      t,
      "stripe-proof-batch-owner",
    );
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        const operationId = `stripe-proof-batch-operation-${index}`;
        const resolutionId = `stripe-proof-batch-resolution-${index}`;
        const stripeCustomerId = `cus_proof_batch_${index}`;
        const stripeCheckoutSessionId = `cs_proof_batch_${index}`;
        const locatorHash = await hashStripePhysicalSuccessLocators({
          stripeCustomerId,
          stripeCheckoutSessionId,
        });
        await ctx.db.insert("billing_stripe_operation_resolutions", {
          ownerId: fence.ownerId,
          ownerGeneration: fence.generation,
          operationId,
          resolutionId,
          debtKey: `attempt:proof-batch-${index}:checkout_lookup_unavailable`,
          attemptId: `proof-batch-${index}`,
          step: "checkout_create",
          resolution: "recovered_checkout",
          debtReason: "checkout_lookup_unavailable",
          locatorHash,
          resolvedByHash: "a".repeat(64),
          evidenceHash: "b".repeat(64),
          resolvedAt: index,
        });
        await ctx.db.insert("billing_stripe_operations", {
          ownerId: fence.ownerId,
          ownerGeneration: fence.generation,
          operationId,
          kind: "usage_credit_checkout",
          state: "provider_succeeded",
          dispatchState: "idle",
          idempotencyKey: `proof-batch-operation-key-${index}`,
          stripeCustomerCreateIdempotencyKey: `proof-batch-customer-key-${index}`,
          requestKey: index.toString(16).padStart(64, "0"),
          requestFingerprint: (index + 101).toString(16).padStart(64, "0"),
          stripeCustomerId,
          stripeCustomerMetadataOwnerId: fence.ownerId,
          stripeCheckoutSessionId,
          terminalizedByManualResolutionId: resolutionId,
          integrityVersion: 3,
          lifecycleIntegrityVersion: 1,
          leaseExpiresAt: 0,
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).resolves.toEqual({ deleted: 100, hasMore: true });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operation_resolutions" },
      ),
    ).resolves.toEqual({ deleted: 0, hasMore: true });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operation_resolutions" },
      ),
    ).resolves.toEqual({ deleted: 100, hasMore: true });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operation_resolutions" },
      ),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    const snapshot = await t.run(async (ctx) => ({
      operations: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", fence.ownerId),
        )
        .collect(),
      resolutions: await ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_ownerId_and_resolvedAt", (q) =>
          q.eq("ownerId", fence.ownerId),
        )
        .collect(),
      tombstones: await ctx.db
        .query("billing_stripe_operation_tombstones")
        .collect(),
    }));
    expect(snapshot.operations).toEqual([]);
    expect(snapshot.resolutions).toEqual([]);
    expect(snapshot.tombstones).toHaveLength(101);
  });

  it("drains bounded local batches and reports readback residue without calling Stripe", async () => {
    const t = createTest();
    const fence = await beginDeleteAndClaimCoreLease(t, "purge-batch-owner");
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("billing_usage_credit_purchases", {
          ownerId: fence.ownerId,
          stripeCheckoutSessionId: `cs-batch-${index}`,
          stripePaymentIntentId: "",
          stripeCustomerId: "cus-batch",
          amountMicroCents: 5_000_000,
          currency: "usd",
          status: "paid",
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    expect(
      await t.query(
        internal.account_billing_purge.remainingOwnerBillingInternal,
        {
          ownerId: fence.ownerId,
        },
      ),
    ).toContain("billing_usage_credit_purchases");
    expect(
      await t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_usage_credit_purchases" },
      ),
    ).toEqual({ deleted: 100, hasMore: true });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("billing_usage_credit_purchases")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", fence.ownerId),
          )
          .take(102),
      ),
    ).toHaveLength(1);
    expect(
      await t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_usage_credit_purchases" },
      ),
    ).toEqual({ deleted: 1, hasMore: false });
    expect(
      await t.query(
        internal.account_billing_purge.remainingOwnerBillingInternal,
        {
          ownerId: fence.ownerId,
        },
      ),
    ).not.toContain("billing_usage_credit_purchases");
  });

  it("accepts stale child metadata only through one exact alias and a destination-owned customer", async () => {
    const t = createTest();
    const sourceOwnerId = "migrated-source-owner";
    const destinationOwnerId = "migrated-destination-owner";
    const unrelatedOwnerId = "unrelated-destination-owner";
    const [sourceOwnerHash, destinationOwnerHash, unrelatedOwnerHash] =
      await Promise.all([
        ownershipMigrationSourceDigest(sourceOwnerId),
        ownershipMigrationSourceDigest(destinationOwnerId),
        ownershipMigrationSourceDigest(unrelatedOwnerId),
      ]);
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_owner_aliases", {
        sourceOwnerHash,
        destinationOwnerHash,
        createdAt: 1,
      });
      await ctx.db.insert("billing_stripe_owner_aliases", {
        sourceOwnerHash,
        destinationOwnerHash: unrelatedOwnerHash,
        createdAt: 2,
      });
    });
    const hasExactAlias = async (source: string, destination: string) =>
      await t.query(
        internal.account_billing_purge.hasExactStripeOwnerAliasInternal,
        { sourceOwnerId: source, destinationOwnerId: destination },
      );

    await expect(
      hasVerifiedMigratedStripeChildOwner({
        destinationOwnerId,
        childMetadataOwnerId: sourceOwnerId,
        customerMetadataOwnerId: destinationOwnerId,
        customerDeleted: false,
        hasExactAlias,
      }),
    ).resolves.toBe(true);
    await expect(
      hasVerifiedMigratedStripeChildOwner({
        destinationOwnerId,
        childMetadataOwnerId: sourceOwnerId,
        customerMetadataOwnerId: unrelatedOwnerId,
        customerDeleted: false,
        hasExactAlias,
      }),
    ).resolves.toBe(false);
    await expect(
      hasVerifiedMigratedStripeChildOwner({
        destinationOwnerId,
        childMetadataOwnerId: sourceOwnerId,
        customerMetadataOwnerId: destinationOwnerId,
        customerDeleted: true,
        hasExactAlias,
      }),
    ).resolves.toBe(false);

    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_owner_aliases", {
        sourceOwnerHash,
        destinationOwnerHash,
        createdAt: 3,
      });
    });
    await expect(
      hasExactAlias(sourceOwnerId, destinationOwnerId),
    ).resolves.toBe(false);
  });

  it("drains destination aliases in restart-safe batches and leaves zero destination residue", async () => {
    const t = createTest();
    const ownerId = "alias-purge-destination";
    const fence = await beginDeleteAndClaimCoreLease(t, ownerId);
    const [destinationOwnerHash, unrelatedDestinationHash] = await Promise.all([
      ownershipMigrationSourceDigest(ownerId),
      ownershipMigrationSourceDigest("alias-unrelated-destination"),
    ]);
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("billing_stripe_owner_aliases", {
          sourceOwnerHash: index.toString(16).padStart(64, "0"),
          destinationOwnerHash,
          createdAt: index,
        });
      }
      await ctx.db.insert("billing_stripe_owner_aliases", {
        sourceOwnerHash: "f".repeat(64),
        destinationOwnerHash: unrelatedDestinationHash,
        createdAt: 1_000,
      });
    });
    await expect(
      t.query(internal.account_billing_purge.remainingOwnerBillingInternal, {
        ownerId,
      }),
    ).resolves.toContain("billing_stripe_owner_aliases");
    await expect(
      t.mutation(
        internal.account_billing_purge
          .deleteDestinationStripeOwnerAliasBatchInternal,
        fence,
      ),
    ).resolves.toEqual({ deleted: 100, hasMore: true });
    await expect(
      t.mutation(
        internal.account_billing_purge
          .deleteDestinationStripeOwnerAliasBatchInternal,
        fence,
      ),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    const readback = await t.run(async (ctx) => ({
      destination: await ctx.db
        .query("billing_stripe_owner_aliases")
        .withIndex("by_destinationOwnerHash", (q) =>
          q.eq("destinationOwnerHash", destinationOwnerHash),
        )
        .first(),
      unrelated: await ctx.db
        .query("billing_stripe_owner_aliases")
        .withIndex("by_destinationOwnerHash", (q) =>
          q.eq("destinationOwnerHash", unrelatedDestinationHash),
        )
        .unique(),
    }));
    expect(readback.destination).toBeNull();
    expect(readback.unrelated).not.toBeNull();
    await expect(
      t.query(internal.account_billing_purge.remainingOwnerBillingInternal, {
        ownerId,
      }),
    ).resolves.not.toContain("billing_stripe_owner_aliases");
  });

  it("preserves Stripe ownership aliases under a reset lease", async () => {
    const t = createTest();
    const ownerId = "alias-reset-destination";
    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      { ownerId, operationId: "alias-reset", mode: "reset", now: 1_000 },
    );
    const fence = {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: "alias-reset-lease",
    };
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ...fence,
      stage: "core",
      now: 1_001,
    });
    const destinationOwnerHash = await ownershipMigrationSourceDigest(ownerId);
    await t.run(async (ctx) => {
      await ctx.db.insert("billing_stripe_owner_aliases", {
        sourceOwnerHash: "e".repeat(64),
        destinationOwnerHash,
        createdAt: 1,
      });
    });
    await expect(
      t.mutation(
        internal.account_billing_purge
          .deleteDestinationStripeOwnerAliasBatchInternal,
        fence,
      ),
    ).rejects.toThrow();
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_owner_aliases")
          .withIndex("by_destinationOwnerHash", (q) =>
            q.eq("destinationOwnerHash", destinationOwnerHash),
          )
          .unique(),
      ),
    ).resolves.not.toBeNull();
  });

  it("terminalizes a never-dispatched Stripe reservation locally during capture", async () => {
    const t = createTest();
    const ownerId = "idle-operation-owner";
    await seedProfile(t, { ownerId, stripeCustomerId: "cus-idle" });
    const operation = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "billing_portal",
        stripeCustomerId: "cus-idle",
        requestKey: "1".repeat(64),
        requestFingerprint: "2".repeat(64),
        now: 1_000,
      },
    );
    const fence = await beginDeleteAndClaimCoreLease(t, ownerId);

    await t.mutation(
      internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
      { ...fence, source: "operations", now: 2_000 },
    );

    const rows = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
      locator: await ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", ownerId).eq("state", "pending"),
        )
        .first(),
    }));
    expect(rows.operation).toMatchObject({
      state: "provider_succeeded",
      dispatchState: "idle",
      stripeCustomerId: "cus-idle",
    });
    expect(rows.locator).toMatchObject({
      locatorKind: "customer",
      locatorValue: "cus-idle",
      ownerVerified: true,
    });
    await expect(
      t.query(
        internal.account_billing_purge.getBlockingStripeOperationInternal,
        {
          ownerId,
          operationId: fence.operationId,
          generation: fence.generation,
          now: 2_001,
        },
      ),
    ).resolves.toBeNull();
  });

  it("completes capture and strict deletion readback for a clean provider-succeeded operation", async () => {
    const t = createTest();
    const ownerId = "clean-operation-capture-owner";
    await seedProfile(t, {
      ownerId,
      stripeCustomerId: "cus-clean-operation",
    });
    const operation = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "subscription_checkout",
        stripeCustomerId: "cus-clean-operation",
        requestKey: "3".repeat(64),
        requestFingerprint: "4".repeat(64),
        now: 1_000,
      },
    );
    await settleReservedCheckout(t, {
      ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      stripeCustomerId: "cus-clean-operation",
      stripeCheckoutSessionId: "cs-clean-operation",
      attemptId: "clean-operation-checkout",
      now: 1_001,
    });
    const fence = await beginDeleteAndClaimCoreLease(t, ownerId);
    for (const source of [
      "profile",
      "purchases",
      "invoices",
      "events",
    ] as const) {
      await expect(
        t.mutation(
          internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
          { ...fence, source, now: 10_002 },
        ),
      ).resolves.toEqual({ complete: false });
    }
    await expect(
      t.mutation(
        internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
        { ...fence, source: "operations", now: 10_003 },
      ),
    ).resolves.toEqual({ complete: true });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_owner_deletion_debts")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
      ),
    ).resolves.toMatchObject({ operationsCaptured: true });

    const pendingLocators = await t.run(async (ctx) =>
      ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", ownerId).eq("state", "pending"),
        )
        .collect(),
    );
    expect(pendingLocators).toHaveLength(2);
    for (const locator of pendingLocators) {
      const providerClaimId = `purge-claim-${locator.locatorKind.replaceAll(
        "_",
        "-",
      )}`;
      await expect(
        t.mutation(
          internal.account_billing_purge.claimBillingDeletionLocatorInternal,
          {
            ...fence,
            locatorHash: locator.locatorHash,
            providerClaimId,
            now: 10_004,
          },
        ),
      ).resolves.toBe(true);
      await t.mutation(
        internal.account_billing_purge
          .markBillingDeletionLocatorTerminalInternal,
        {
          ...fence,
          locatorHash: locator.locatorHash,
          providerClaimId,
          now: 10_004,
        },
      );
    }
    for (let index = 0; index < 4; index += 1) {
      const result = await t.mutation(
        internal.account_billing_purge.deleteOwnerStripeEventBatchInternal,
        fence,
      );
      if (!result.hasMore) break;
    }
    await expect(
      t.mutation(
        internal.stripe_operation_dispatch
          .quiesceOwnerStripeOperationsForPurgeInternal,
        { ...fence, mode: "delete", now: 10_005 },
      ),
    ).resolves.toEqual({ ready: true, pending: [], retryAt: null });

    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_profiles" },
      ),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    await expect(
      t.mutation(
        internal.account_billing_purge.finishOwnerBillingPurgeInternal,
        fence,
      ),
    ).resolves.toBe(true);
    await expect(
      t.query(internal.account_billing_purge.remainingOwnerBillingInternal, {
        ownerId,
      }),
    ).resolves.toEqual([]);
  });

  it("blocks partial historical physical tuples and backfills a complete tuple before deletion", async () => {
    const t = createTest();
    const ownerId = "partial-physical-tuple-owner";
    await seedProfile(t, { ownerId });
    const operation = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "subscription_checkout",
        requestKey: "5".repeat(64),
        requestFingerprint: "6".repeat(64),
        now: 1_000,
      },
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        state: "completed",
        stripeCustomerId: "cus-partial-history",
        stripeCustomerMetadataOwnerId: ownerId,
        stripeCheckoutSessionId: "cs-partial-history",
        lastStripeStep: "customer_create",
        leaseExpiresAt: 1_001,
        updatedAt: 1_001,
      });
    });
    const fence = await beginDeleteAndClaimCoreLease(t, ownerId);
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).rejects.toThrow(/malformed Stripe physical receipt history/iu);
    const blocked = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
      receipts: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .collect(),
      tombstone: await ctx.db
        .query("billing_stripe_operation_tombstones")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .first(),
    }));
    expect(blocked.operation).not.toBeNull();
    expect(blocked.receipts).toEqual([]);
    expect(blocked.tombstone).toBeNull();

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        lastStripeStep: undefined,
        lastStripeDisposition: "succeeded",
      });
    });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).rejects.toThrow(/malformed Stripe physical receipt history/iu);

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        lastStripeDisposition: undefined,
        lastStripeReconcileClaimId: "historical-claim-only",
      });
    });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).rejects.toThrow(/malformed Stripe physical receipt history/iu);

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        lastStripeReconcileClaimId: undefined,
        lastStripeStep: "checkout_create",
        lastStripeAttemptId: "complete-historical-attempt",
        lastStripeRequestFingerprint: "7".repeat(64),
        lastStripeIdempotencyKey: "complete-historical-key",
        lastStripeProviderDeadlineAt: 2_000,
      });
    });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).rejects.toThrow(/malformed Stripe physical receipt history/iu);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        lastStripeDisposition: "succeeded",
      });
    });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).rejects.toThrow(/physical receipt provenance/iu);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      await ctx.db.patch(row!._id, { integrityVersion: 2 });
    });
    await expect(
      t.mutation(
        internal.stripe_operation_dispatch
          .quiesceOwnerStripeOperationsForPurgeInternal,
        { ...fence, mode: "delete", now: 10_005 },
      ),
    ).resolves.toEqual({ ready: true, pending: [], retryAt: null });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
    const drained = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .first(),
      receipts: await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .collect(),
    }));
    expect(drained.operation).toBeNull();
    expect(drained.receipts).toHaveLength(1);
  });

  it("retains unknown-integrity and v2 idle orphan authority during destructive purge", async () => {
    for (const scenario of ["unknown-integrity", "v2-orphan"] as const) {
      const t = createTest();
      const ownerId = `destructive-shape-${scenario}-owner`;
      await seedProfile(t, { ownerId });
      const operation = await t.mutation(
        internal.billing.reserveStripeOperationInternal,
        {
          ownerId,
          ownerGeneration: LEGACY_GENERATION,
          kind: "subscription_checkout",
          requestKey:
            scenario === "unknown-integrity" ? "b".repeat(64) : "c".repeat(64),
          requestFingerprint:
            scenario === "unknown-integrity" ? "d".repeat(64) : "e".repeat(64),
          now: 1_000,
        },
      );
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .unique();
        await ctx.db.patch(row!._id, {
          state: "completed",
          integrityVersion: scenario === "unknown-integrity" ? 4 : 2,
          ...(scenario === "v2-orphan"
            ? { activeAttemptId: "v2-orphan-active-attempt" }
            : {}),
          leaseExpiresAt: 1_001,
          updatedAt: 1_001,
        });
      });
      const fence = await beginDeleteAndClaimCoreLease(t, ownerId);

      await expect(
        t.mutation(
          internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
          { ...fence, table: "billing_stripe_operations" },
        ),
      ).rejects.toThrow(/nonterminal Stripe operation authority/iu);
      const retained = await t.run(async (ctx) => ({
        operation: await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .unique(),
        tombstone: await ctx.db
          .query("billing_stripe_operation_tombstones")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .first(),
        receipt: await ctx.db
          .query("billing_stripe_physical_receipts")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .first(),
      }));
      expect(retained.operation).not.toBeNull();
      expect(retained.tombstone).toBeNull();
      expect(retained.receipt).toBeNull();
    }
  });

  it("rejects terminal Stripe operation states with missing or wrong-kind locators", async () => {
    const scenarios = [
      {
        name: "subscription-missing-customer",
        kind: "subscription_checkout" as const,
        stripeCheckoutSessionId: "cs-missing-customer",
      },
      {
        name: "subscription-missing-checkout",
        kind: "subscription_checkout" as const,
        stripeCustomerId: "cus-missing-checkout",
      },
      {
        name: "portal-with-checkout",
        kind: "billing_portal" as const,
        stripeCustomerId: "cus-wrong-portal",
        stripeCheckoutSessionId: "cs-wrong-portal",
      },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const t = createTest();
      const ownerId = `invalid-terminal-${scenario.name}-owner`;
      await seedProfile(t, {
        ownerId,
        ...(scenario.kind === "billing_portal" && scenario.stripeCustomerId
          ? { stripeCustomerId: scenario.stripeCustomerId }
          : {}),
      });
      const operation = await t.mutation(
        internal.billing.reserveStripeOperationInternal,
        {
          ownerId,
          ownerGeneration: LEGACY_GENERATION,
          kind: scenario.kind,
          ...(scenario.kind === "billing_portal"
            ? { stripeCustomerId: scenario.stripeCustomerId }
            : {}),
          requestKey: (index + 1).toString(16).repeat(64),
          requestFingerprint: (index + 4).toString(16).repeat(64),
          now: 1_000,
        },
      );
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .unique();
        await ctx.db.patch(row!._id, {
          state: "completed",
          stripeCustomerId: scenario.stripeCustomerId,
          stripeCustomerMetadataOwnerId: scenario.stripeCustomerId
            ? ownerId
            : undefined,
          stripeCheckoutSessionId: scenario.stripeCheckoutSessionId,
          leaseExpiresAt: 1_001,
          updatedAt: 1_001,
        });
      });
      const fence = await beginDeleteAndClaimCoreLease(t, ownerId);
      await expect(
        t.mutation(
          internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
          { ...fence, table: "billing_stripe_operations" },
        ),
      ).rejects.toThrow(/nonterminal Stripe operation authority/iu);
      await expect(
        t.run(async (ctx) =>
          ctx.db
            .query("billing_stripe_operations")
            .withIndex("by_operationId", (q) =>
              q.eq("operationId", operation.operationId),
            )
            .unique(),
        ),
      ).resolves.not.toBeNull();
    }
  });

  it("finds a later exact manual-debt row without classifying an earlier clean operation as debt", async () => {
    const t = createTest();
    const ownerId = "mixed-manual-debt-owner";
    await seedProfile(t, { ownerId });
    const clean = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "subscription_checkout",
        requestKey: "7".repeat(64),
        requestFingerprint: "8".repeat(64),
        now: 1_000,
      },
    );
    const debt = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "usage_credit_checkout",
        requestKey: "9".repeat(64),
        requestFingerprint: "a".repeat(64),
        now: 1_001,
      },
    );
    await t.run(async (ctx) => {
      const [cleanRow, debtRow] = await Promise.all([
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", clean.operationId),
          )
          .unique(),
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", debt.operationId),
          )
          .unique(),
      ]);
      await ctx.db.patch(cleanRow!._id, {
        state: "completed",
        leaseExpiresAt: 1_002,
      });
      await ctx.db.patch(debtRow!._id, {
        state: "completed",
        manualDebtReason: "late_result_conflict",
        leaseExpiresAt: 1_003,
      });
    });
    const fence = await beginDeleteAndClaimCoreLease(t, ownerId);
    await expect(
      t.mutation(
        internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
        { ...fence, source: "operations", now: 10_002 },
      ),
    ).resolves.toEqual({ complete: false });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("billing_owner_deletion_debts")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .unique(),
      ),
    ).resolves.toMatchObject({ operationsCaptured: false });
    await expect(
      t.mutation(
        internal.account_billing_purge.finishOwnerBillingPurgeInternal,
        fence,
      ),
    ).resolves.toBe(false);
    await expect(
      t.query(internal.account_billing_purge.remainingOwnerBillingInternal, {
        ownerId,
      }),
    ).resolves.toContain("billing_stripe_operations");
  });

  it("keeps an expired legacy Stripe operation as manual debt with no purge-side result writer", async () => {
    const t = createTest();
    const ownerId = "operation-owner";
    await seedProfile(t, { ownerId, stripeCustomerId: "cus-operation" });
    const operation = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "subscription_checkout",
        stripeCustomerId: "cus-operation",
        requestKey: "e".repeat(64),
        requestFingerprint: "a".repeat(64),
        now: 1_000,
      },
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      // Simulate a receipt written before durable dispatch state existed. New
      // idle rows are terminalized locally during capture and never need the
      // legacy provider-reconciliation branch exercised by this test.
      await ctx.db.patch(row!._id, {
        leaseExpiresAt: 0,
        dispatchState: undefined,
      });
    });
    const fence = await beginDeleteAndClaimCoreLease(t, ownerId);
    await t.mutation(
      internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
      { ...fence, source: "operations", now: 10_002 },
    );
    const blocking = await t.query(
      internal.account_billing_purge.getBlockingStripeOperationInternal,
      {
        ownerId: fence.ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
        now: 10_003,
      },
    );
    expect(blocking).toMatchObject({
      stripeOperationId: operation.operationId,
      stripeCustomerId: "cus-operation",
      expired: true,
    });
    const accountBillingPurgeModule =
      await modules["./account_billing_purge.ts"]!();
    expect(accountBillingPurgeModule).not.toHaveProperty(
      "reconcileExpiredStripeOperationInternal",
    );
    const rows = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique(),
      locator: await ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", ownerId).eq("state", "pending"),
        )
        .first(),
      resolutions: await ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_ownerId_and_resolvedAt", (q) => q.eq("ownerId", ownerId))
        .take(2),
    }));
    expect(rows.operation?.state).toBe("reserved");
    expect(rows.locator).toMatchObject({
      locatorKind: "customer",
      locatorValue: "cus-operation",
      ownerVerified: true,
    });
    expect(rows.resolutions).toEqual([]);
    await expect(
      t.query(
        internal.account_billing_purge.getBlockingStripeOperationInternal,
        {
          ownerId: fence.ownerId,
          operationId: fence.operationId,
          generation: fence.generation,
          now: 10_004,
        },
      ),
    ).resolves.toMatchObject({
      stripeOperationId: operation.operationId,
      expired: true,
    });
  });

  it("never treats unproven prior locator fields as deletion authority", async () => {
    const t = createTest();
    const ownerId = "late-checkout-owner";
    await seedProfile(t, { ownerId, stripeCustomerId: "cus-current" });
    const operation = await t.mutation(
      internal.billing.reserveStripeOperationInternal,
      {
        ownerId,
        ownerGeneration: LEGACY_GENERATION,
        kind: "usage_credit_checkout",
        stripeCustomerId: "cus-current",
        requestKey: "f".repeat(64),
        requestFingerprint: "b".repeat(64),
        now: 1_000,
      },
    );
    await settleReservedCheckout(t, {
      ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      stripeCustomerId: "cus-current",
      stripeCheckoutSessionId: "cs-current",
      attemptId: "late-conflict-canonical-checkout",
      now: 1_001,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", operation.operationId),
        )
        .unique();
      if (!row) throw new Error("missing Stripe operation");
      // These deprecated fields have no production writer or immutable
      // physical-result proof. Corrupting them must not authorize deletion of
      // either raw provider resource.
      await ctx.db.patch(row._id, {
        priorStripeCustomerId: "cus-prior",
        priorStripeCheckoutSessionId: "cs-prior",
        updatedAt: 1_003,
      });
    });
    const fence = await beginDeleteAndClaimCoreLease(t, ownerId);
    await t.mutation(
      internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
      { ...fence, source: "operations", now: 10_002 },
    );
    const pending = await t.run(async (ctx) =>
      ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", ownerId).eq("state", "pending"),
        )
        .take(10),
    );
    expect(pending).toEqual([]);
    await expect(
      t.mutation(
        internal.stripe_operation_dispatch
          .quiesceOwnerStripeOperationsForPurgeInternal,
        { ...fence, mode: "delete", now: 10_003 },
      ),
    ).resolves.toMatchObject({
      ready: false,
      pending: [`stripe_operation_malformed:${operation.operationId}`],
    });
    await expect(
      t.mutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...fence, table: "billing_stripe_operations" },
      ),
    ).rejects.toThrow(/nonterminal Stripe operation authority/iu);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .unique(),
      ),
    ).not.toBeNull();
  });

  it("drains ownerless Stripe events for every terminal locator without a 32-row blind spot", async () => {
    const t = createTest();
    const fence = await beginDeleteAndClaimCoreLease(t, "event-drain-owner");
    await t.run(async (ctx) => {
      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert("billing_owner_deletion_locators", {
          ownerId: fence.ownerId,
          operationId: fence.operationId,
          generation: fence.generation,
          locatorHash: `hash-${index}`,
          locatorKind: index === 39 ? "customer" : "checkout_session",
          locatorValue: index === 39 ? "cus-ownerless" : `cs-${index}`,
          ownerVerified: true,
          state: "terminal",
          eventsDrained: false,
          attempts: 1,
          terminalAt: 1,
          createdAt: index,
          updatedAt: index,
        });
      }
      await ctx.db.insert("billing_stripe_events", {
        eventId: "evt-ownerless",
        eventType: "customer.updated",
        ownerId: "",
        stripeCustomerId: "cus-ownerless",
        stripeSubscriptionId: "",
        createdAt: 1,
        processingState: "processed",
        processedAt: 1,
      });
    });
    for (let index = 0; index < 45; index += 1) {
      const result = await t.mutation(
        internal.account_billing_purge.deleteOwnerStripeEventBatchInternal,
        fence,
      );
      if (!result.hasMore) break;
    }
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("billing_stripe_events")
          .withIndex("by_eventId", (q) => q.eq("eventId", "evt-ownerless"))
          .unique(),
      ),
    ).toBeNull();
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("billing_owner_deletion_locators")
          .withIndex("by_ownerId_and_state_and_eventsDrained", (q) =>
            q
              .eq("ownerId", fence.ownerId)
              .eq("state", "terminal")
              .eq("eventsDrained", false),
          )
          .first(),
      ),
    ).toBeNull();
  });
});
