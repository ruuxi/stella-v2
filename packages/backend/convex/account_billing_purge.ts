import Stripe from "stripe";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import {
  hashStripeDeletedOperationTuple,
  hashStripeBillingLocator,
  stripeHistoricalResultShape,
  type StripeBillingLocatorKind,
} from "./lib/billing_deletion";
import {
  ensureLegacyStripeOperationPhysicalReceiptProvenance,
  hasStripePhysicalReceiptCapacityForInsert,
  hasCleanIdleStripeOperationTransport,
  hasCleanLegacyStripeOperationTransport,
  hasCurrentStripeOperationIntegrity,
  hasLegacyStripeOperationIntegrityVersion,
  hasMatchingStripeManualResolutionProof,
  hasOnlyProvenStripeOperationPhysicalReceipts,
  hasValidStripeRetainedLocatorProof,
  hasValidStripeOperationStateLocators,
} from "./lib/stripe_operation_integrity";
import { ownershipMigrationSourceDigest } from "./lib/auth_migration_paths";
import { assertOwnerPurgeLease } from "./owner_lifecycle";
import { managedDispatchOutcomeRequiresQuiescence } from "./lib/managed_dispatch";
import { activeManagedUsageReservationMicroCents } from "./lib/managed_usage_reservation";
import {
  finalizeManagedDispatchBillingFromReceipt,
  managedDispatchHasPendingBilling,
} from "./billing";

const STRIPE_API_VERSION = "2026-05-27.dahlia";
const CAPTURE_PAGE_SIZE = 64;
const DELETE_BATCH_SIZE = 100;
const MAX_EXTERNAL_DELETIONS_PER_RUN = 8;
const STRIPE_DELETION_PROVIDER_TIMEOUT_MS = 20_000;
const STRIPE_DELETION_DISCOVERY_CLAIM_MS = 120_000;
const STRIPE_DELETION_MUTATION_CLAIM_MS = 35_000;
const STRIPE_MANUAL_DEBT_REASONS = [
  "portal_lookup_unavailable",
  "customer_lookup_unavailable",
  "customer_authority_revoked",
  "customer_duplicate",
  "customer_scan_horizon",
  "checkout_lookup_unavailable",
  "checkout_duplicate",
  "checkout_scan_horizon",
  "legacy_missing_receipt",
  "late_result_conflict",
] as const;
const isStripeOperationDestructivelyTerminal = (
  row: Doc<"billing_stripe_operations">,
): boolean =>
  row.state !== "reserved" &&
  hasCurrentStripeOperationIntegrity(row) &&
  hasValidStripeOperationStateLocators(row) &&
  hasCleanIdleStripeOperationTransport(row) &&
  row.lifecycleIntegrityVersion === 1;

const purgeFenceValidator = {
  ownerId: v.string(),
  operationId: v.string(),
  generation: v.string(),
  leaseId: v.string(),
};

const captureSourceValidator = v.union(
  v.literal("profile"),
  v.literal("purchases"),
  v.literal("invoices"),
  v.literal("events"),
  v.literal("operations"),
);

const locatorKindValidator = v.union(
  v.literal("customer"),
  v.literal("subscription"),
  v.literal("payment_method"),
  v.literal("checkout_session"),
);

const stripeOperationKindValidator = v.union(
  v.literal("subscription_checkout"),
  v.literal("usage_credit_checkout"),
  v.literal("billing_portal"),
);

const ownerBillingTableValidator = v.union(
  v.literal("usage_logs"),
  v.literal("usage_rollups"),
  v.literal("billing_profiles"),
  v.literal("billing_usage_windows"),
  v.literal("billing_usage_credits"),
  v.literal("billing_usage_credit_purchases"),
  v.literal("billing_voice_usage_receipts"),
  v.literal("billing_voice_sessions"),
  v.literal("billing_media_usage_receipts"),
  v.literal("billing_invoice_payments"),
  v.literal("stella_relay_billing_receipts"),
  v.literal("billing_stripe_operation_resolutions"),
  v.literal("billing_stripe_operations"),
  v.literal("billing_managed_dispatch_leases"),
  v.literal("billing_managed_request_bindings"),
  v.literal("billing_managed_execution_leases"),
  v.literal("voice_provider_dispatch_leases"),
);

type OwnerBillingTable =
  | "usage_logs"
  | "usage_rollups"
  | "billing_profiles"
  | "billing_usage_windows"
  | "billing_usage_credits"
  | "billing_usage_credit_purchases"
  | "billing_voice_usage_receipts"
  | "billing_voice_sessions"
  | "billing_media_usage_receipts"
  | "billing_invoice_payments"
  | "stella_relay_billing_receipts"
  | "billing_stripe_operation_resolutions"
  | "billing_stripe_operations"
  | "billing_managed_dispatch_leases"
  | "billing_managed_request_bindings"
  | "billing_managed_execution_leases"
  | "voice_provider_dispatch_leases";

const OWNER_BILLING_TABLES: readonly OwnerBillingTable[] = [
  "usage_logs",
  "usage_rollups",
  "billing_usage_credit_purchases",
  "billing_voice_usage_receipts",
  "billing_voice_sessions",
  "billing_media_usage_receipts",
  "billing_invoice_payments",
  "stella_relay_billing_receipts",
  "billing_stripe_operations",
  "billing_stripe_operation_resolutions",
  "billing_managed_dispatch_leases",
  "billing_managed_request_bindings",
  "billing_managed_execution_leases",
  "voice_provider_dispatch_leases",
  "billing_usage_credits",
  "billing_usage_windows",
  // The profile carries the primary Stripe customer locator, so it is always
  // drained after every other billing row and after remote deletion.
  "billing_profiles",
] as const;

type PurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
};

const assertDeleteLease = async (ctx: MutationCtx, fence: PurgeFence) => {
  await assertOwnerPurgeLease(ctx, {
    ...fence,
    stage: "core",
    mode: "delete",
  });
};

const findOwnerStripeManualDebt = async (ctx: MutationCtx, ownerId: string) =>
  (
    await Promise.all(
      STRIPE_MANUAL_DEBT_REASONS.map(
        async (reason) =>
          await ctx.db
            .query("billing_stripe_operations")
            .withIndex("by_ownerId_and_manualDebtReason_and_createdAt", (q) =>
              q.eq("ownerId", ownerId).eq("manualDebtReason", reason),
            )
            .first(),
      ),
    )
  ).find((row) => row !== null) ?? null;

const getStripeClient = () => {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("Stripe is not configured.");
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    // Purge retries are coordinated by the durable deletion action so every
    // destructive replay can renew the exact core/delete lease first.
    maxNetworkRetries: 0,
    timeout: STRIPE_DELETION_PROVIDER_TIMEOUT_MS,
  });
};

const safeErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

export const isStripeResourceAlreadyGone = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.code === "resource_missing" || candidate.statusCode === 404;
};

class StripeOwnershipMismatchError extends Error {}
class StripeProviderClaimSupersededError extends Error {}

/**
 * A migrated child resource may retain immutable source-owner metadata even
 * after its attached customer becomes destination-owned. That mismatch is
 * usable only when both independent facts agree: the live customer names the
 * destination and one exact hash-minimized source -> destination alias exists.
 */
export const hasVerifiedMigratedStripeChildOwner = async (args: {
  destinationOwnerId: string;
  childMetadataOwnerId: string | null | undefined;
  customerMetadataOwnerId: string | null | undefined;
  customerDeleted: boolean;
  hasExactAlias: (
    sourceOwnerId: string,
    destinationOwnerId: string,
  ) => Promise<boolean>;
}): Promise<boolean> => {
  const destinationOwnerId = args.destinationOwnerId.trim();
  const sourceOwnerId = args.childMetadataOwnerId?.trim() ?? "";
  const customerOwnerId = args.customerMetadataOwnerId?.trim() ?? "";
  if (
    !destinationOwnerId ||
    !sourceOwnerId ||
    sourceOwnerId === destinationOwnerId ||
    args.customerDeleted ||
    customerOwnerId !== destinationOwnerId
  ) {
    return false;
  }
  return await args.hasExactAlias(sourceOwnerId, destinationOwnerId);
};

const deleteStripeLocator = async (args: {
  ownerId: string;
  ownerVerified: boolean;
  kind: StripeBillingLocatorKind;
  value: string;
  locatorHash: string;
  beforeMutation: () => Promise<void>;
  hasExactOwnerAlias: (
    sourceOwnerId: string,
    destinationOwnerId: string,
  ) => Promise<boolean>;
}): Promise<string | null> => {
  const stripe = getStripeClient();
  const requestOptions = {
    idempotencyKey: `stella-billing-delete-v1-${args.kind}-${args.locatorHash}`,
  };
  const assertMetadataOwner = (
    metadata: Stripe.Metadata | null | undefined,
    allowMissing = false,
  ) => {
    const metadataOwner = metadata?.ownerId?.trim();
    if (!metadataOwner && !args.ownerVerified && !allowMissing) {
      throw new StripeOwnershipMismatchError(
        "Stripe resource ownership could not be proven.",
      );
    }
    if (metadataOwner && metadataOwner !== args.ownerId) {
      throw new StripeOwnershipMismatchError(
        "Stripe resource is linked to a different owner.",
      );
    }
  };
  const retrieveCustomerForOwnership = async (customerId: string) => {
    try {
      return await stripe.customers.retrieve(customerId);
    } catch (error) {
      // Only absence of the locator being deleted is a terminal replay. An
      // absent attached customer cannot prove ownership of a still-present
      // child resource and must fail closed instead of being mistaken for a
      // successful child cleanup.
      if (isStripeResourceAlreadyGone(error)) {
        throw new StripeOwnershipMismatchError(
          "Stripe attached-customer ownership could not be proven.",
        );
      }
      throw error;
    }
  };
  const assertCustomerOwner = async (customerId: string) => {
    const customer = await retrieveCustomerForOwnership(customerId);
    if (!("deleted" in customer && customer.deleted)) {
      assertMetadataOwner(customer.metadata);
    }
    return customer;
  };
  const assertChildAndCustomerOwner = async (
    metadata: Stripe.Metadata | null | undefined,
    customerId: string,
  ) => {
    const customer = await retrieveCustomerForOwnership(customerId);
    const customerDeleted = "deleted" in customer && customer.deleted === true;
    const childMetadataOwnerId = metadata?.ownerId?.trim();
    if (childMetadataOwnerId && childMetadataOwnerId !== args.ownerId) {
      const migratedOwnerVerified = await hasVerifiedMigratedStripeChildOwner({
        destinationOwnerId: args.ownerId,
        childMetadataOwnerId,
        customerMetadataOwnerId: customerDeleted
          ? undefined
          : customer.metadata?.ownerId,
        customerDeleted,
        hasExactAlias: args.hasExactOwnerAlias,
      });
      if (!migratedOwnerVerified) {
        throw new StripeOwnershipMismatchError(
          "Stripe resource is linked to a different owner.",
        );
      }
      return;
    }
    assertMetadataOwner(metadata, true);
    if (!customerDeleted) assertMetadataOwner(customer.metadata);
  };
  try {
    if (args.kind === "customer") {
      // Stripe documents customer deletion as permanent and as immediately
      // canceling every active subscription attached to the customer.
      const customer = await stripe.customers.retrieve(args.value);
      if ("deleted" in customer && customer.deleted) return null;
      assertMetadataOwner(customer.metadata);
      await args.beforeMutation();
      await stripe.customers.del(args.value, {}, requestOptions);
      return null;
    } else if (args.kind === "subscription") {
      const subscription = await stripe.subscriptions.retrieve(args.value);
      const customerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id;
      await assertChildAndCustomerOwner(subscription.metadata, customerId);
      if (subscription.status === "canceled") return customerId;
      await args.beforeMutation();
      await stripe.subscriptions.cancel(args.value, {}, requestOptions);
      return customerId;
    } else if (args.kind === "payment_method") {
      const paymentMethod = await stripe.paymentMethods.retrieve(args.value);
      const customerId =
        typeof paymentMethod.customer === "string"
          ? paymentMethod.customer
          : paymentMethod.customer?.id;
      if (customerId) await assertCustomerOwner(customerId);
      if (!customerId) return null;
      await args.beforeMutation();
      await stripe.paymentMethods.detach(args.value, {}, requestOptions);
      return customerId;
    } else {
      const session = await stripe.checkout.sessions.retrieve(args.value);
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : session.customer?.id;
      if (customerId) {
        await assertChildAndCustomerOwner(session.metadata, customerId);
      } else {
        assertMetadataOwner(session.metadata, true);
      }
      if (session.status !== "open") return customerId ?? null;
      if (!customerId && !args.ownerVerified) {
        throw new StripeOwnershipMismatchError(
          "Stripe checkout ownership could not be proven.",
        );
      }
      try {
        await args.beforeMutation();
        await stripe.checkout.sessions.expire(args.value, {}, requestOptions);
      } catch (error) {
        if (isStripeResourceAlreadyGone(error)) return customerId ?? null;
        // A concurrent checkout completion makes expiration fail. Read the
        // provider again and accept only a proven non-open terminal state.
        const after = await stripe.checkout.sessions.retrieve(args.value);
        if (after.status !== "open") return customerId ?? null;
        throw error;
      }
      return customerId ?? null;
    }
  } catch (error) {
    // A response-lost retry can observe the resource after the first request
    // already removed it. Resource-missing is therefore a terminal success.
    if (!isStripeResourceAlreadyGone(error)) throw error;
    return null;
  }
};

const readDebt = async (ctx: MutationCtx, ownerId: string) =>
  await ctx.db
    .query("billing_owner_deletion_debts")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const hasExactStripeOwnerAlias = async (
  ctx: Pick<QueryCtx, "db">,
  sourceOwnerId: string,
  destinationOwnerId: string,
): Promise<boolean> => {
  const [sourceOwnerHash, destinationOwnerHash] = await Promise.all([
    ownershipMigrationSourceDigest(sourceOwnerId),
    ownershipMigrationSourceDigest(destinationOwnerId),
  ]);
  if (sourceOwnerHash === destinationOwnerHash) return false;
  const aliases = await ctx.db
    .query("billing_stripe_owner_aliases")
    .withIndex("by_sourceOwnerHash_and_destinationOwnerHash", (q) =>
      q
        .eq("sourceOwnerHash", sourceOwnerHash)
        .eq("destinationOwnerHash", destinationOwnerHash),
    )
    .take(2);
  return aliases.length === 1;
};

export const hasExactStripeOwnerAliasInternal = internalQuery({
  args: {
    sourceOwnerId: v.string(),
    destinationOwnerId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    await hasExactStripeOwnerAlias(
      ctx,
      args.sourceOwnerId,
      args.destinationOwnerId,
    ),
});

export const deleteDestinationStripeOwnerAliasBatchInternal = internalMutation({
  args: purgeFenceValidator,
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    const destinationOwnerHash = await ownershipMigrationSourceDigest(
      args.ownerId,
    );
    const aliases = await ctx.db
      .query("billing_stripe_owner_aliases")
      .withIndex("by_destinationOwnerHash", (q) =>
        q.eq("destinationOwnerHash", destinationOwnerHash),
      )
      .take(DELETE_BATCH_SIZE);
    for (const alias of aliases) await ctx.db.delete(alias._id);
    const remaining = await ctx.db
      .query("billing_stripe_owner_aliases")
      .withIndex("by_destinationOwnerHash", (q) =>
        q.eq("destinationOwnerHash", destinationOwnerHash),
      )
      .first();
    return { deleted: aliases.length, hasMore: remaining !== null };
  },
});

const hasValidScopedStripeRetentionFence = async (
  ctx: Pick<QueryCtx, "db">,
  args: {
    ownerHash: string;
    locatorHash: string;
    locatorKind: StripeBillingLocatorKind;
  },
): Promise<boolean> => {
  const retained = await ctx.db
    .query("billing_stripe_retained_locators")
    .withIndex("by_ownerHash_and_locatorHash", (q) =>
      q.eq("ownerHash", args.ownerHash).eq("locatorHash", args.locatorHash),
    )
    .first();
  if (!retained) return false;
  if (
    retained.locatorKind !== args.locatorKind ||
    !(await hasValidStripeRetainedLocatorProof(ctx, retained))
  ) {
    throw new Error("Stripe retained locator audit is missing or changed.");
  }
  return true;
};

const recordLocator = async (
  ctx: MutationCtx,
  debt: {
    ownerId: string;
    operationId: string;
    generation: string;
  },
  kind: StripeBillingLocatorKind,
  rawValue: string | null | undefined,
  now: number,
  verifiedByBinding = false,
) => {
  const value = rawValue?.trim() ?? "";
  if (!value) return;
  const authoritativeProfiles =
    kind === "customer"
      ? await ctx.db
          .query("billing_profiles")
          .withIndex("by_stripeCustomerId", (q) =>
            q.eq("stripeCustomerId", value),
          )
          .take(65)
      : kind === "subscription"
        ? await ctx.db
            .query("billing_profiles")
            .withIndex("by_stripeSubscriptionId", (q) =>
              q.eq("stripeSubscriptionId", value),
            )
            .take(65)
        : kind === "payment_method"
          ? await ctx.db
              .query("billing_profiles")
              .withIndex("by_defaultPaymentMethodId", (q) =>
                q.eq("defaultPaymentMethodId", value),
              )
              .take(65)
          : [];
  // Historical receipts/events are useful locator sources, but are not
  // authoritative enough to delete a provider object currently linked to a
  // different owner.
  if (
    authoritativeProfiles.length > 64 ||
    authoritativeProfiles.some((profile) => profile.ownerId !== debt.ownerId)
  ) {
    return;
  }
  const ownerVerified =
    verifiedByBinding ||
    authoritativeProfiles.some((profile) => profile.ownerId === debt.ownerId);
  const locatorHash = await hashStripeBillingLocator(kind, value);
  const tombstone = await ctx.db
    .query("billing_stripe_deletion_tombstones")
    .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
    .unique();
  if (tombstone) {
    if (tombstone.locatorKind !== kind) {
      throw new Error("Stripe billing deletion tombstone kind changed.");
    }
    return;
  }
  const deletionOwnerHash = await ownershipMigrationSourceDigest(debt.ownerId);
  if (
    await hasValidScopedStripeRetentionFence(ctx, {
      ownerHash: deletionOwnerHash,
      locatorHash,
      locatorKind: kind,
    })
  ) {
    return;
  }
  const existing = await ctx.db
    .query("billing_owner_deletion_locators")
    .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
    .unique();
  if (existing) {
    if (
      existing.ownerId !== debt.ownerId ||
      existing.operationId !== debt.operationId ||
      existing.generation !== debt.generation
    ) {
      throw new Error(
        "Stripe billing locator belongs to another purge operation.",
      );
    }
    if (ownerVerified && !existing.ownerVerified) {
      await ctx.db.patch(existing._id, { ownerVerified: true, updatedAt: now });
    }
    return;
  }
  await ctx.db.insert("billing_owner_deletion_locators", {
    ownerId: debt.ownerId,
    operationId: debt.operationId,
    generation: debt.generation,
    locatorHash,
    locatorKind: kind,
    locatorValue: value,
    ownerVerified,
    state: "pending",
    eventsDrained: false,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
};

export const captureOwnerBillingDebtPageInternal = internalMutation({
  args: {
    ...purgeFenceValidator,
    source: captureSourceValidator,
    now: v.number(),
  },
  returns: v.object({ complete: v.boolean() }),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    let debt = await readDebt(ctx, args.ownerId);
    if (
      debt &&
      (debt.operationId !== args.operationId ||
        debt.generation !== args.generation)
    ) {
      throw new Error(
        "Billing deletion debt belongs to a stale purge operation.",
      );
    }
    if (!debt) {
      const debtId = await ctx.db.insert("billing_owner_deletion_debts", {
        ownerId: args.ownerId,
        operationId: args.operationId,
        generation: args.generation,
        profileCaptured: false,
        purchasesCaptured: false,
        invoicesCaptured: false,
        eventsCaptured: false,
        operationsCaptured: false,
        attempts: 1,
        createdAt: args.now,
        updatedAt: args.now,
      });
      debt = await ctx.db.get(debtId);
      if (!debt) throw new Error("Failed to create billing deletion debt.");
    } else if (args.source === "profile") {
      await ctx.db.patch(debt._id, {
        attempts: debt.attempts + 1,
        updatedAt: args.now,
      });
    }

    let profileCaptured = debt.profileCaptured;
    let purchasesCaptured = debt.purchasesCaptured;
    let invoicesCaptured = debt.invoicesCaptured;
    let eventsCaptured = debt.eventsCaptured;
    let operationsCaptured = debt.operationsCaptured;

    if (args.source === "profile" && !profileCaptured) {
      const page = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .paginate({
          numItems: CAPTURE_PAGE_SIZE,
          cursor: debt.profileCursor ?? null,
        });
      for (const profile of page.page) {
        // Insert dependent resources first. Customer deletion is last and is
        // itself sufficient to cancel any subscription missed by old data.
        await recordLocator(
          ctx,
          debt,
          "subscription",
          profile.stripeSubscriptionId,
          args.now,
        );
        await recordLocator(
          ctx,
          debt,
          "payment_method",
          profile.defaultPaymentMethodId,
          args.now,
        );
        await recordLocator(
          ctx,
          debt,
          "customer",
          profile.stripeCustomerId,
          args.now,
        );
      }
      profileCaptured = page.isDone;
      await ctx.db.patch(debt._id, {
        profileCaptured: page.isDone,
        profileCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: args.now,
      });
    } else if (args.source === "purchases" && !purchasesCaptured) {
      const page = await ctx.db
        .query("billing_usage_credit_purchases")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .paginate({
          numItems: CAPTURE_PAGE_SIZE,
          cursor: debt.purchaseCursor ?? null,
        });
      for (const row of page.page) {
        await recordLocator(
          ctx,
          debt,
          "checkout_session",
          row.stripeCheckoutSessionId,
          args.now,
          true,
        );
        await recordLocator(
          ctx,
          debt,
          "customer",
          row.stripeCustomerId,
          args.now,
          true,
        );
      }
      purchasesCaptured = page.isDone;
      await ctx.db.patch(debt._id, {
        purchasesCaptured: page.isDone,
        purchaseCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: args.now,
      });
    } else if (args.source === "invoices" && !invoicesCaptured) {
      const page = await ctx.db
        .query("billing_invoice_payments")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .paginate({
          numItems: CAPTURE_PAGE_SIZE,
          cursor: debt.invoiceCursor ?? null,
        });
      for (const row of page.page) {
        await recordLocator(
          ctx,
          debt,
          "subscription",
          row.stripeSubscriptionId,
          args.now,
        );
      }
      invoicesCaptured = page.isDone;
      await ctx.db.patch(debt._id, {
        invoicesCaptured: page.isDone,
        invoiceCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: args.now,
      });
    } else if (args.source === "events" && !eventsCaptured) {
      const page = await ctx.db
        .query("billing_stripe_events")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .paginate({
          numItems: CAPTURE_PAGE_SIZE,
          cursor: debt.eventCursor ?? null,
        });
      for (const row of page.page) {
        await recordLocator(
          ctx,
          debt,
          "checkout_session",
          row.stripeCheckoutSessionId,
          args.now,
        );
        await recordLocator(
          ctx,
          debt,
          "subscription",
          row.stripeSubscriptionId,
          args.now,
        );
        await recordLocator(
          ctx,
          debt,
          "payment_method",
          row.stripePaymentMethodId,
          args.now,
        );
        await recordLocator(
          ctx,
          debt,
          "customer",
          row.stripeCustomerId,
          args.now,
        );
      }
      eventsCaptured = page.isDone;
      await ctx.db.patch(debt._id, {
        eventsCaptured: page.isDone,
        eventCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: args.now,
      });
    } else if (args.source === "operations" && !operationsCaptured) {
      const page = await ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .paginate({
          numItems: CAPTURE_PAGE_SIZE,
          cursor: debt.operationCursor ?? null,
        });
      for (const row of page.page) {
        const locatorAuthorityValid =
          hasValidStripeOperationStateLocators(row) &&
          (hasCurrentStripeOperationIntegrity(row)
            ? await hasOnlyProvenStripeOperationPhysicalReceipts(ctx, row)
            : hasLegacyStripeOperationIntegrityVersion(row) &&
              (await ensureLegacyStripeOperationPhysicalReceiptProvenance(
                ctx,
                row,
              )));
        if (!locatorAuthorityValid) {
          // Capture is intentionally non-destructive. A malformed/current-v3
          // orphan remains for the quiescence and destructive gates to report,
          // but its raw fields can never become owner-verified delete authority.
          continue;
        }
        await recordLocator(
          ctx,
          debt,
          "checkout_session",
          row.stripeCheckoutSessionId,
          args.now,
          true,
        );
        await recordLocator(
          ctx,
          debt,
          "checkout_session",
          row.lateResultStripeCheckoutSessionId,
          args.now,
          true,
        );
        await recordLocator(
          ctx,
          debt,
          "customer",
          row.stripeCustomerId,
          args.now,
          true,
        );
        await recordLocator(
          ctx,
          debt,
          "customer",
          row.lateResultStripeCustomerId,
          args.now,
          true,
        );
        // Billing Portal sessions have no Stripe deletion API. Current and
        // prior portal locators therefore remain only on the operation receipt
        // until local drain; they never become deletion locators or provider
        // tombstones that would falsely claim physical cleanup.
        if (
          row.state === "reserved" &&
          row.dispatchState === "idle" &&
          row.activeStep === undefined &&
          row.activeAttemptId === undefined &&
          row.activeRequestJson === undefined &&
          row.activeRequestFingerprint === undefined &&
          row.activeIdempotencyKey === undefined &&
          row.providerDeadlineAt === undefined &&
          row.quiescentAfterAt === undefined &&
          row.manualDebtReason === undefined &&
          row.lateResultConflictStep === undefined &&
          row.lateResultConflictAttemptId === undefined &&
          row.lateResultRequestFingerprint === undefined &&
          row.lateResultIdempotencyKey === undefined &&
          row.lateResultProviderDeadlineAt === undefined &&
          row.lateResultReconcileClaimId === undefined &&
          row.lateResultConflictAt === undefined &&
          row.lateResultConflictQuiescentAfterAt === undefined &&
          row.stripeCustomerMetadataTransferState !== "may_have_dispatched" &&
          row.stripeCustomerMetadataTransferToOwnerId === undefined &&
          row.stripeCustomerMetadataTransferAttemptId === undefined &&
          row.stripeCustomerMetadataTransferIdempotencyKey === undefined &&
          row.stripeCustomerMetadataTransferProviderDeadlineAt === undefined &&
          row.stripeCustomerMetadataTransferQuiescentAfterAt === undefined &&
          row.stripeCustomerMetadataTransferDebtReason === undefined
        ) {
          // An exact idle receipt proves no provider request is in flight. Any
          // already-captured customer/session locator was recorded above, so
          // this reservation can become terminal without provider I/O.
          await ctx.db.patch(row._id, {
            state: "provider_succeeded",
            terminalizedWithoutProviderDispatch: true,
            leaseExpiresAt: args.now,
            updatedAt: args.now,
          });
        }
      }
      const manualDebt = page.isDone
        ? await findOwnerStripeManualDebt(ctx, args.ownerId)
        : null;
      const [
        active,
        sourceMetadataTransfer,
        targetMetadataTransfer,
        lateResult,
      ] = page.isDone
        ? await Promise.all([
            ctx.db
              .query("billing_stripe_operations")
              .withIndex("by_ownerId_and_state", (q) =>
                q.eq("ownerId", args.ownerId).eq("state", "reserved"),
              )
              .first(),
            ctx.db
              .query("billing_stripe_operations")
              .withIndex(
                "by_ownerId_and_metadataTransferState_and_createdAt",
                (q) =>
                  q
                    .eq("ownerId", args.ownerId)
                    .eq(
                      "stripeCustomerMetadataTransferState",
                      "may_have_dispatched",
                    ),
              )
              .first(),
            ctx.db
              .query("billing_stripe_operations")
              .withIndex(
                "by_metadataTransferToOwnerId_and_state_and_createdAt",
                (q) =>
                  q
                    .eq("stripeCustomerMetadataTransferToOwnerId", args.ownerId)
                    .eq(
                      "stripeCustomerMetadataTransferState",
                      "may_have_dispatched",
                    ),
              )
              .first(),
            ctx.db
              .query("billing_stripe_late_results")
              .withIndex("by_ownerId_and_createdAt", (q) =>
                q.eq("ownerId", args.ownerId),
              )
              .first(),
          ])
        : [null, null, null, null];
      operationsCaptured =
        page.isDone &&
        !active &&
        !manualDebt &&
        !sourceMetadataTransfer &&
        !targetMetadataTransfer &&
        !lateResult;
      await ctx.db.patch(debt._id, {
        operationsCaptured,
        operationCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: args.now,
      });
    }

    return {
      complete:
        profileCaptured &&
        purchasesCaptured &&
        invoicesCaptured &&
        eventsCaptured &&
        operationsCaptured,
    };
  },
});

export const getBlockingStripeOperationInternal = internalQuery({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      stripeOperationId: v.string(),
      kind: stripeOperationKindValidator,
      stripeCustomerId: v.union(v.string(), v.null()),
      stripeCustomerCreateIdempotencyKey: v.string(),
      expired: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const debt = await ctx.db
      .query("billing_owner_deletion_debts")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !debt ||
      debt.operationId !== args.operationId ||
      debt.generation !== args.generation
    ) {
      return null;
    }
    const operations = await ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "reserved"),
      )
      .take(CAPTURE_PAGE_SIZE + 1);
    // Only pre-rollout rows lack an exact durable dispatch tuple. New idle
    // rows are terminalized locally during capture; marked rows are owned by
    // stripe_operation_dispatch and must never enter this legacy path.
    const operation = operations.find((row) => row.dispatchState === undefined);
    if (!operation) return null;
    return {
      stripeOperationId: operation.operationId,
      kind: operation.kind,
      stripeCustomerId: operation.stripeCustomerId ?? null,
      stripeCustomerCreateIdempotencyKey:
        operation.stripeCustomerCreateIdempotencyKey,
      expired: operation.leaseExpiresAt <= args.now,
    };
  },
});

export const getPendingBillingDeletionLocatorInternal = internalQuery({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      locatorHash: v.string(),
      locatorKind: locatorKindValidator,
      locatorValue: v.string(),
      ownerVerified: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const debt = await ctx.db
      .query("billing_owner_deletion_debts")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !debt ||
      debt.operationId !== args.operationId ||
      debt.generation !== args.generation
    ) {
      return null;
    }
    let locator = null;
    for (const kind of [
      "checkout_session",
      "subscription",
      "payment_method",
      "customer",
    ] as const) {
      locator = await ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_state_and_kind", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("state", "pending")
            .eq("locatorKind", kind),
        )
        .first();
      if (locator) break;
    }
    if (!locator) return null;
    return {
      locatorHash: locator.locatorHash,
      locatorKind: locator.locatorKind,
      locatorValue: locator.locatorValue,
      ownerVerified: locator.ownerVerified,
    };
  },
});

export const hasRetainedStripeDeletionLocatorInternal = internalQuery({
  args: {
    ownerId: v.string(),
    locatorHash: v.string(),
    locatorKind: locatorKindValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const ownerHash = await ownershipMigrationSourceDigest(args.ownerId);
    return await hasValidScopedStripeRetentionFence(ctx, {
      ownerHash,
      locatorHash: args.locatorHash,
      locatorKind: args.locatorKind,
    });
  },
});

export const claimBillingDeletionLocatorInternal = internalMutation({
  args: {
    ...purgeFenceValidator,
    locatorHash: v.string(),
    providerClaimId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(args.providerClaimId)) {
      return false;
    }
    const locator = await ctx.db
      .query("billing_owner_deletion_locators")
      .withIndex("by_ownerId_and_locatorHash", (q) =>
        q.eq("ownerId", args.ownerId).eq("locatorHash", args.locatorHash),
      )
      .unique();
    if (
      !locator ||
      locator.operationId !== args.operationId ||
      locator.generation !== args.generation ||
      locator.state !== "pending" ||
      (locator.providerClaimExpiresAt !== undefined &&
        locator.providerClaimExpiresAt > args.now)
    ) {
      return false;
    }
    const ownerHash = await ownershipMigrationSourceDigest(args.ownerId);
    if (
      await hasValidScopedStripeRetentionFence(ctx, {
        ownerHash,
        locatorHash: locator.locatorHash,
        locatorKind: locator.locatorKind,
      })
    ) {
      return false;
    }
    await ctx.db.patch(locator._id, {
      providerClaimId: args.providerClaimId,
      providerClaimExpiresAt: args.now + STRIPE_DELETION_DISCOVERY_CLAIM_MS,
      updatedAt: args.now,
    });
    return true;
  },
});

/**
 * Exact last-moment provider-mutation fence. A stale action may resume after
 * its discovery claim expires, so every destructive Stripe call must first
 * prove it still owns the claim and that no retained-resource audit now
 * covers this owner's locator.
 */
export const revalidateBillingDeletionLocatorClaimInternal = internalMutation({
  args: {
    ...purgeFenceValidator,
    locatorHash: v.string(),
    providerClaimId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    const locator = await ctx.db
      .query("billing_owner_deletion_locators")
      .withIndex("by_ownerId_and_locatorHash", (q) =>
        q.eq("ownerId", args.ownerId).eq("locatorHash", args.locatorHash),
      )
      .unique();
    if (
      !locator ||
      locator.operationId !== args.operationId ||
      locator.generation !== args.generation ||
      locator.state !== "pending" ||
      locator.providerClaimId !== args.providerClaimId
    ) {
      return false;
    }
    const ownerHash = await ownershipMigrationSourceDigest(args.ownerId);
    if (
      await hasValidScopedStripeRetentionFence(ctx, {
        ownerHash,
        locatorHash: locator.locatorHash,
        locatorKind: locator.locatorKind,
      })
    ) {
      return false;
    }
    await ctx.db.patch(locator._id, {
      providerClaimExpiresAt: args.now + STRIPE_DELETION_MUTATION_CLAIM_MS,
      updatedAt: args.now,
    });
    return true;
  },
});

export const markBillingDeletionLocatorTerminalInternal = internalMutation({
  args: {
    ...purgeFenceValidator,
    locatorHash: v.string(),
    providerClaimId: v.string(),
    discoveredStripeCustomerId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    const locator = await ctx.db
      .query("billing_owner_deletion_locators")
      .withIndex("by_ownerId_and_locatorHash", (q) =>
        q.eq("ownerId", args.ownerId).eq("locatorHash", args.locatorHash),
      )
      .unique();
    if (
      !locator ||
      locator.operationId !== args.operationId ||
      locator.generation !== args.generation ||
      locator.providerClaimId !== args.providerClaimId
    ) {
      throw new Error("Billing deletion locator was superseded.");
    }
    const debt = await readDebt(ctx, args.ownerId);
    if (
      !debt ||
      debt.operationId !== args.operationId ||
      debt.generation !== args.generation
    ) {
      throw new Error("Billing deletion debt was superseded.");
    }
    await recordLocator(
      ctx,
      debt,
      "customer",
      args.discoveredStripeCustomerId,
      args.now,
      true,
    );
    const tombstone = await ctx.db
      .query("billing_stripe_deletion_tombstones")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", args.locatorHash))
      .unique();
    if (tombstone && tombstone.locatorKind !== locator.locatorKind) {
      throw new Error("Stripe billing deletion tombstone kind changed.");
    }
    if (!tombstone) {
      await ctx.db.insert("billing_stripe_deletion_tombstones", {
        locatorHash: args.locatorHash,
        locatorKind: locator.locatorKind,
        createdAt: args.now,
      });
    }
    await ctx.db.patch(locator._id, {
      state: "terminal",
      attempts: locator.attempts + 1,
      lastError: undefined,
      providerClaimId: undefined,
      providerClaimExpiresAt: undefined,
      terminalAt: args.now,
      updatedAt: args.now,
    });
    return null;
  },
});

export const recordBillingDeletionLocatorFailureInternal = internalMutation({
  args: {
    ...purgeFenceValidator,
    locatorHash: v.string(),
    providerClaimId: v.string(),
    error: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    const locator = await ctx.db
      .query("billing_owner_deletion_locators")
      .withIndex("by_ownerId_and_locatorHash", (q) =>
        q.eq("ownerId", args.ownerId).eq("locatorHash", args.locatorHash),
      )
      .unique();
    if (
      !locator ||
      locator.operationId !== args.operationId ||
      locator.generation !== args.generation ||
      locator.providerClaimId !== args.providerClaimId
    ) {
      throw new Error("Billing deletion locator was superseded.");
    }
    await ctx.db.patch(locator._id, {
      attempts: locator.attempts + 1,
      lastError: args.error.slice(0, 2_000),
      providerClaimId: undefined,
      providerClaimExpiresAt: undefined,
      updatedAt: args.now,
    });
    return null;
  },
});

export const discardUnverifiedBillingDeletionLocatorInternal = internalMutation(
  {
    args: {
      ...purgeFenceValidator,
      locatorHash: v.string(),
      providerClaimId: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      await assertDeleteLease(ctx, args);
      const locator = await ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_locatorHash", (q) =>
          q.eq("ownerId", args.ownerId).eq("locatorHash", args.locatorHash),
        )
        .unique();
      if (!locator) return null;
      if (
        locator.operationId !== args.operationId ||
        locator.generation !== args.generation ||
        (args.providerClaimId !== undefined
          ? locator.providerClaimId !== args.providerClaimId
          : locator.providerClaimExpiresAt !== undefined &&
            locator.providerClaimExpiresAt > Date.now())
      ) {
        throw new Error("Billing deletion locator was superseded.");
      }
      // Do not tombstone or retain a raw locator whose ownership is conflicting
      // or unprovable: doing so could suppress another owner's valid webhook.
      await ctx.db.delete(locator._id);
      return null;
    },
  },
);

/**
 * Reset/delete quiescence barrier for generic managed-provider attempts.
 * Definitive terminal receipts are transient and removable immediately.
 * Active/ambiguous provider attempts and enclosing model/tool executions block
 * through their exact lease and abort-grace boundary.
 */
export const quiesceOwnerManagedDispatchesInternal = internalMutation({
  args: {
    ...purgeFenceValidator,
    mode: v.union(v.literal("reset"), v.literal("delete")),
    now: v.number(),
  },
  returns: v.object({ ready: v.boolean(), pending: v.array(v.string()) }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      leaseId: args.leaseId,
      stage: "core",
      mode: args.mode,
    });
    const rows = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(DELETE_BATCH_SIZE);
    let live = false;
    for (const row of rows) {
      const requiresQuiescence =
        row.state === "active" ||
        managedDispatchOutcomeRequiresQuiescence(row.outcome);
      if (requiresQuiescence && row.quiescentAfterAt > args.now) {
        live = true;
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
          args.now,
        );
      }
      await ctx.db.delete(row._id);
    }
    if (live || rows.length === DELETE_BATCH_SIZE) {
      return {
        ready: false,
        pending: ["billing_managed_dispatch_leases"],
      };
    }
    const remaining = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .first();
    if (remaining) {
      return {
        ready: false,
        pending: ["billing_managed_dispatch_leases"],
      };
    }

    const executions = await ctx.db
      .query("billing_managed_execution_leases")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(DELETE_BATCH_SIZE);
    let liveExecution = false;
    for (const execution of executions) {
      if (
        execution.state === "active" &&
        execution.quiescentAfterAt > args.now
      ) {
        liveExecution = true;
        continue;
      }
      await ctx.db.delete(execution._id);
    }
    if (liveExecution || executions.length === DELETE_BATCH_SIZE) {
      return {
        ready: false,
        pending: ["billing_managed_execution_leases"],
      };
    }
    const remainingExecution = await ctx.db
      .query("billing_managed_execution_leases")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .first();
    if (remainingExecution) {
      return {
        ready: false,
        pending: ["billing_managed_execution_leases"],
      };
    }

    // The aggregate is the OCC admission authority shared by generic and
    // realtime-voice receipts. Voice quiescence runs before this barrier; once
    // both exact lease families are empty, a non-zero aggregate is therefore
    // unresolved monetary debt and must never be hidden by reset/delete.
    const usageWindow = await ctx.db
      .query("billing_usage_windows")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      usageWindow &&
      activeManagedUsageReservationMicroCents(usageWindow) !== 0
    ) {
      return {
        ready: false,
        pending: ["billing_usage_reservations"],
      };
    }

    // Request ids are generation-scoped. Reset must remove their durable body
    // bindings after every physical/execution lease joins, or the reopened
    // owner retains stale request identity despite all other data being gone.
    // Delete drains the same table in the ordinary billing-owned table pass.
    if (args.mode === "reset") {
      const bindings = await ctx.db
        .query("billing_managed_request_bindings")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(DELETE_BATCH_SIZE);
      for (const binding of bindings) await ctx.db.delete(binding._id);
      if (bindings.length === DELETE_BATCH_SIZE) {
        return {
          ready: false,
          pending: ["billing_managed_request_bindings"],
        };
      }
      const remainingBinding = await ctx.db
        .query("billing_managed_request_bindings")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first();
      if (remainingBinding) {
        return {
          ready: false,
          pending: ["billing_managed_request_bindings"],
        };
      }
    }

    return { ready: true, pending: [] };
  },
});

export const deleteOwnerBillingTableBatchInternal = internalMutation({
  args: {
    ...purgeFenceValidator,
    table: ownerBillingTableValidator,
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    let ids: Array<Id<TableNames>> = [];
    switch (args.table) {
      case "usage_logs":
        ids = (
          await ctx.db
            .query("usage_logs")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "usage_rollups":
        ids = (
          await ctx.db
            .query("usage_rollups")
            .withIndex("by_ownerId_and_bucketStartMs", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_profiles":
        ids = (
          await ctx.db
            .query("billing_profiles")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_usage_windows":
        ids = (
          await ctx.db
            .query("billing_usage_windows")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_usage_credits":
        ids = (
          await ctx.db
            .query("billing_usage_credits")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_usage_credit_purchases":
        ids = (
          await ctx.db
            .query("billing_usage_credit_purchases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_voice_usage_receipts":
        ids = (
          await ctx.db
            .query("billing_voice_usage_receipts")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_voice_sessions":
        ids = (
          await ctx.db
            .query("billing_voice_sessions")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_media_usage_receipts":
        ids = (
          await ctx.db
            .query("billing_media_usage_receipts")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_invoice_payments":
        ids = (
          await ctx.db
            .query("billing_invoice_payments")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "stella_relay_billing_receipts":
        ids = (
          await ctx.db
            .query("stella_relay_billing_receipts")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_stripe_operations":
        {
          const rows = await ctx.db
            .query("billing_stripe_operations")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE);
          const ownerHash = await ownershipMigrationSourceDigest(args.ownerId);
          for (const row of rows) {
            const historicalResultShape = stripeHistoricalResultShape(row);
            if (historicalResultShape === "malformed") {
              throw new Error(
                "Malformed Stripe physical receipt history reached destructive purge.",
              );
            }
            const isEligibleLegacyTerminal =
              row.state !== "reserved" &&
              hasLegacyStripeOperationIntegrityVersion(row) &&
              hasValidStripeOperationStateLocators(row) &&
              hasCleanLegacyStripeOperationTransport(row);
            const physicalProvenanceValid = isEligibleLegacyTerminal
              ? await ensureLegacyStripeOperationPhysicalReceiptProvenance(
                  ctx,
                  row,
                )
              : await hasOnlyProvenStripeOperationPhysicalReceipts(ctx, row);
            if (!physicalProvenanceValid) {
              throw new Error(
                "Stripe physical receipt provenance reached destructive purge incomplete.",
              );
            }
            if (row.lifecycleIntegrityVersion !== 1) {
              throw new Error(
                "Stripe lifecycle audit marker is missing at destructive purge; nonterminal Stripe operation authority cannot be deleted.",
              );
            }
            if (!isStripeOperationDestructivelyTerminal(row)) {
              throw new Error(
                "Nonterminal Stripe operation authority reached destructive purge.",
              );
            }
            if (
              row.terminalizedByManualResolutionId !== undefined &&
              !(await hasMatchingStripeManualResolutionProof(ctx, row))
            ) {
              throw new Error(
                "Stripe manual-resolution authority is missing or changed during purge.",
              );
            }
            if (
              row.stripeCustomerMetadataTransferState ===
                "may_have_dispatched" ||
              row.stripeCustomerMetadataTransferToOwnerId !== undefined ||
              row.stripeCustomerMetadataTransferAttemptId !== undefined ||
              row.stripeCustomerMetadataTransferIdempotencyKey !== undefined ||
              row.stripeCustomerMetadataTransferProviderDeadlineAt !==
                undefined ||
              row.stripeCustomerMetadataTransferQuiescentAfterAt !==
                undefined ||
              row.stripeCustomerMetadataTransferDebtReason !== undefined
            ) {
              throw new Error(
                "Stripe customer metadata transfer reached destructive purge.",
              );
            }
            const pendingLateResult = await ctx.db
              .query("billing_stripe_late_results")
              .withIndex("by_operationId_and_createdAt", (q) =>
                q.eq("operationId", row.operationId),
              )
              .first();
            if (pendingLateResult) {
              throw new Error(
                "Stripe late-result locator reached destructive purge.",
              );
            }
            // Rolling-deploy backfill for exact tuples settled before physical
            // receipt insertion shipped. This is deliberately restricted to
            // the enumerated pre-v3 lineage; a current-v3 row can never mint
            // missing callback authority during deletion.
            if (historicalResultShape === "complete") {
              const tupleHash = await hashStripeDeletedOperationTuple({
                operationId: row.operationId,
                attemptId: row.lastStripeAttemptId!,
                step: row.lastStripeStep!,
                requestFingerprint: row.lastStripeRequestFingerprint!,
                idempotencyKey: row.lastStripeIdempotencyKey!,
                providerDeadlineAt: row.lastStripeProviderDeadlineAt!,
              });
              const physicalReceipts = await ctx.db
                .query("billing_stripe_physical_receipts")
                .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
                .take(2);
              if (physicalReceipts.length > 1) {
                throw new Error(
                  "Duplicate Stripe physical receipt requires repair.",
                );
              }
              if (
                physicalReceipts[0] &&
                physicalReceipts[0].operationId !== row.operationId
              ) {
                throw new Error(
                  "Stripe physical receipt belongs to another operation.",
                );
              }
              if (!physicalReceipts[0]) {
                if (!isEligibleLegacyTerminal) {
                  throw new Error(
                    "Missing Stripe physical receipt authority reached destructive purge.",
                  );
                }
                if (
                  !(await hasStripePhysicalReceiptCapacityForInsert(
                    ctx,
                    row.operationId,
                  ))
                ) {
                  throw new Error(
                    "Stripe physical receipt capacity requires repair before destructive purge.",
                  );
                }
                await ctx.db.insert("billing_stripe_physical_receipts", {
                  operationId: row.operationId,
                  tupleHash,
                  createdAt: Date.now(),
                });
              }
            }
            const tombstones = await ctx.db
              .query("billing_stripe_operation_tombstones")
              .withIndex("by_operationId", (q) =>
                q.eq("operationId", row.operationId),
              )
              .take(2);
            if (tombstones.length > 1) {
              throw new Error(
                "Duplicate deleted Stripe operation authority requires repair.",
              );
            }
            if (tombstones[0] && tombstones[0].ownerHash !== ownerHash) {
              throw new Error(
                "Deleted Stripe operation owner authority changed during purge.",
              );
            }
            if (!tombstones[0]) {
              await ctx.db.insert("billing_stripe_operation_tombstones", {
                operationId: row.operationId,
                ownerHash,
                createdAt: Date.now(),
              });
            }
          }
          ids = rows.map((row) => row._id);
        }
        break;
      case "billing_stripe_operation_resolutions":
        // A resolution row may be the only proof that a terminal operation's
        // recovered locator was operator-authorized. Never delete any proofs
        // while even one owner operation remains; this also survives the
        // 100-row batch boundary without stranding the final operation.
        if (
          await ctx.db
            .query("billing_stripe_operations")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .first()
        ) {
          return { deleted: 0, hasMore: true };
        }
        ids = (
          await ctx.db
            .query("billing_stripe_operation_resolutions")
            .withIndex("by_ownerId_and_resolvedAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_managed_dispatch_leases":
        {
          const rows = await ctx.db
            .query("billing_managed_dispatch_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE);
          if (rows.some(managedDispatchHasPendingBilling)) {
            throw new Error(
              "Pending managed-provider billing reached destructive purge.",
            );
          }
          ids = rows.map((row) => row._id);
        }
        break;
      case "billing_managed_request_bindings":
        ids = (
          await ctx.db
            .query("billing_managed_request_bindings")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "billing_managed_execution_leases":
        ids = (
          await ctx.db
            .query("billing_managed_execution_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
      case "voice_provider_dispatch_leases":
        ids = (
          await ctx.db
            .query("voice_provider_dispatch_leases")
            .withIndex("by_ownerId_and_createdAt", (q) =>
              q.eq("ownerId", args.ownerId),
            )
            .take(DELETE_BATCH_SIZE)
        ).map((row) => row._id);
        break;
    }
    await Promise.all(ids.map((id) => ctx.db.delete(id)));
    return {
      deleted: ids.length,
      hasMore: ids.length === DELETE_BATCH_SIZE,
    };
  },
});

export const deleteOwnerStripeEventBatchInternal = internalMutation({
  args: purgeFenceValidator,
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    const rows = await ctx.db
      .query("billing_stripe_events")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(DELETE_BATCH_SIZE);
    const ids = new Set<Id<"billing_stripe_events">>(
      rows.map((row) => row._id),
    );
    if (ids.size < DELETE_BATCH_SIZE) {
      const locator = await ctx.db
        .query("billing_owner_deletion_locators")
        .withIndex("by_ownerId_and_state_and_eventsDrained", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("state", "terminal")
            .eq("eventsDrained", false),
        )
        .first();
      if (locator) {
        const remaining = DELETE_BATCH_SIZE - ids.size;
        const matches =
          locator.locatorKind === "customer"
            ? await ctx.db
                .query("billing_stripe_events")
                .withIndex("by_stripeCustomerId", (q) =>
                  q.eq("stripeCustomerId", locator.locatorValue),
                )
                .take(remaining)
            : locator.locatorKind === "subscription"
              ? await ctx.db
                  .query("billing_stripe_events")
                  .withIndex("by_stripeSubscriptionId", (q) =>
                    q.eq("stripeSubscriptionId", locator.locatorValue),
                  )
                  .take(remaining)
              : locator.locatorKind === "payment_method"
                ? await ctx.db
                    .query("billing_stripe_events")
                    .withIndex("by_stripePaymentMethodId", (q) =>
                      q.eq("stripePaymentMethodId", locator.locatorValue),
                    )
                    .take(remaining)
                : await ctx.db
                    .query("billing_stripe_events")
                    .withIndex("by_stripeCheckoutSessionId", (q) =>
                      q.eq("stripeCheckoutSessionId", locator.locatorValue),
                    )
                    .take(remaining);
        for (const row of matches) ids.add(row._id);
        if (matches.length < remaining) {
          await ctx.db.patch(locator._id, {
            eventsDrained: true,
            updatedAt: Date.now(),
          });
        }
      }
    }
    await Promise.all([...ids].map((id) => ctx.db.delete(id)));
    return {
      deleted: ids.size,
      hasMore:
        ids.size === DELETE_BATCH_SIZE ||
        Boolean(
          await ctx.db
            .query("billing_owner_deletion_locators")
            .withIndex("by_ownerId_and_state_and_eventsDrained", (q) =>
              q
                .eq("ownerId", args.ownerId)
                .eq("state", "terminal")
                .eq("eventsDrained", false),
            )
            .first(),
        ),
    };
  },
});

const findLocalBillingResidue = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<string[]> => {
  const checks: Array<[string, Promise<unknown>]> = [
    [
      "usage_logs",
      ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "usage_rollups",
      ctx.db
        .query("usage_rollups")
        .withIndex("by_ownerId_and_bucketStartMs", (q) =>
          q.eq("ownerId", ownerId),
        )
        .first(),
    ],
    [
      "billing_profiles",
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_usage_windows",
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_usage_credits",
      ctx.db
        .query("billing_usage_credits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_usage_credit_purchases",
      ctx.db
        .query("billing_usage_credit_purchases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_voice_usage_receipts",
      ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_voice_sessions",
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_media_usage_receipts",
      ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_invoice_payments",
      ctx.db
        .query("billing_invoice_payments")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_stripe_events",
      ctx.db
        .query("billing_stripe_events")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "stella_relay_billing_receipts",
      ctx.db
        .query("stella_relay_billing_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_stripe_operation_resolutions",
      ctx.db
        .query("billing_stripe_operation_resolutions")
        .withIndex("by_ownerId_and_resolvedAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_stripe_operations",
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_stripe_late_results",
      ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_stripe_incoming_metadata_transfers",
      ctx.db
        .query("billing_stripe_operations")
        .withIndex(
          "by_metadataTransferToOwnerId_and_state_and_createdAt",
          (q) =>
            q
              .eq("stripeCustomerMetadataTransferToOwnerId", ownerId)
              .eq("stripeCustomerMetadataTransferState", "may_have_dispatched"),
        )
        .first(),
    ],
    [
      "billing_managed_dispatch_leases",
      ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_managed_request_bindings",
      ctx.db
        .query("billing_managed_request_bindings")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "billing_managed_execution_leases",
      ctx.db
        .query("billing_managed_execution_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
    [
      "voice_provider_dispatch_leases",
      ctx.db
        .query("voice_provider_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .first(),
    ],
  ];
  const values = await Promise.all(checks.map(([, promise]) => promise));
  return checks
    .filter((_, index) => values[index] !== null)
    .map(([name]) => name);
};

const findDestinationStripeOwnerAlias = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
) => {
  const destinationOwnerHash = await ownershipMigrationSourceDigest(ownerId);
  return await ctx.db
    .query("billing_stripe_owner_aliases")
    .withIndex("by_destinationOwnerHash", (q) =>
      q.eq("destinationOwnerHash", destinationOwnerHash),
    )
    .first();
};

const findOwnerLateStripeCleanup = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
) => {
  const ownerHash = await ownershipMigrationSourceDigest(ownerId);
  return await ctx.db
    .query("billing_stripe_late_cleanup_locators")
    .withIndex("by_ownerHash", (q) => q.eq("ownerHash", ownerHash))
    .first();
};

export const remainingOwnerBillingInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const pending = await findLocalBillingResidue(ctx, args.ownerId);
    const [debt, locator, stripeOwnerAlias, lateStripeCleanup] =
      await Promise.all([
        ctx.db
          .query("billing_owner_deletion_debts")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
          .first(),
        ctx.db
          .query("billing_owner_deletion_locators")
          .withIndex("by_ownerId_and_state", (q) =>
            q.eq("ownerId", args.ownerId),
          )
          .first(),
        findDestinationStripeOwnerAlias(ctx, args.ownerId),
        findOwnerLateStripeCleanup(ctx, args.ownerId),
      ]);
    if (locator) pending.push("billing_owner_deletion_locators");
    if (debt) pending.push("billing_owner_deletion_debts");
    if (stripeOwnerAlias) pending.push("billing_stripe_owner_aliases");
    if (lateStripeCleanup) pending.push("billing_stripe_late_cleanup_locators");
    return pending;
  },
});

export const finishOwnerBillingPurgeInternal = internalMutation({
  args: purgeFenceValidator,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    if ((await findLocalBillingResidue(ctx, args.ownerId)).length > 0) {
      return false;
    }
    if (await findOwnerLateStripeCleanup(ctx, args.ownerId)) return false;
    if (await findDestinationStripeOwnerAlias(ctx, args.ownerId)) return false;
    const pendingLocator = await ctx.db
      .query("billing_owner_deletion_locators")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "pending"),
      )
      .first();
    if (pendingLocator) return false;
    const undrainedLocator = await ctx.db
      .query("billing_owner_deletion_locators")
      .withIndex("by_ownerId_and_state_and_eventsDrained", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("state", "terminal")
          .eq("eventsDrained", false),
      )
      .first();
    if (undrainedLocator) return false;
    const debt = await readDebt(ctx, args.ownerId);
    if (
      !debt ||
      debt.operationId !== args.operationId ||
      debt.generation !== args.generation
    ) {
      return false;
    }
    const terminalLocators = await ctx.db
      .query("billing_owner_deletion_locators")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "terminal"),
      )
      .take(DELETE_BATCH_SIZE);
    for (const locator of terminalLocators) await ctx.db.delete(locator._id);
    if (terminalLocators.length === DELETE_BATCH_SIZE) return false;
    await ctx.db.delete(debt._id);
    return true;
  },
});

/**
 * Permanent-delete billing stage. This action never runs for Reset: reset must
 * preserve subscription projection, usage/quota history, purchased credits,
 * entitlements, and financial receipts.
 */
export const purgeOwnerBillingInternal = internalAction({
  args: purgeFenceValidator,
  returns: v.object({
    ready: v.boolean(),
    pending: v.array(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ ready: boolean; pending: string[] }> => {
    const voiceDispatches: { ready: boolean; pending: string[] } =
      await ctx.runMutation(
        internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
        { ...args, mode: "delete", now: Date.now() },
      );
    if (!voiceDispatches.ready) return voiceDispatches;

    const dispatches: { ready: boolean; pending: string[] } =
      await ctx.runMutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...args, mode: "delete", now: Date.now() },
      );
    if (!dispatches.ready) return dispatches;

    // Stripe resource creation has its own exact idempotency-key replay debt.
    // Reconcile it before capturing or deleting raw locators so a lost
    // customer/Checkout/portal response cannot materialize behind the purge.
    const stripeDispatches: { ready: boolean; pending: string[] } =
      await ctx.runMutation(
        internal.stripe_operation_dispatch
          .quiesceOwnerStripeOperationsForPurgeInternal,
        { ...args, mode: "delete", now: Date.now() },
      );
    if (!stripeDispatches.ready) return stripeDispatches;

    let captureComplete = true;
    for (const source of [
      "profile",
      "purchases",
      "invoices",
      "events",
      "operations",
    ] as const) {
      const result: { complete: boolean } = await ctx.runMutation(
        internal.account_billing_purge.captureOwnerBillingDebtPageInternal,
        { ...args, source, now: Date.now() },
      );
      captureComplete &&= result.complete;
    }
    if (!captureComplete) {
      const now = Date.now();
      const blockingOperation: {
        stripeOperationId: string;
        kind:
          | "subscription_checkout"
          | "usage_credit_checkout"
          | "billing_portal";
        stripeCustomerId: string | null;
        stripeCustomerCreateIdempotencyKey: string;
        expired: boolean;
      } | null = await ctx.runQuery(
        internal.account_billing_purge.getBlockingStripeOperationInternal,
        {
          ownerId: args.ownerId,
          operationId: args.operationId,
          generation: args.generation,
          now,
        },
      );
      if (blockingOperation) {
        return {
          ready: false,
          pending: [
            `${
              blockingOperation.expired
                ? "billing_stripe_legacy_manual_reconciliation"
                : "billing_stripe_legacy_dispatch"
            }:${blockingOperation.stripeOperationId}`,
          ],
        };
      }
      return { ready: false, pending: ["billing_locator_capture"] };
    }

    for (let i = 0; i < MAX_EXTERNAL_DELETIONS_PER_RUN; i += 1) {
      const locator: {
        locatorHash: string;
        locatorKind: StripeBillingLocatorKind;
        locatorValue: string;
        ownerVerified: boolean;
      } | null = await ctx.runQuery(
        internal.account_billing_purge.getPendingBillingDeletionLocatorInternal,
        {
          ownerId: args.ownerId,
          operationId: args.operationId,
          generation: args.generation,
        },
      );
      if (!locator) break;

      const retainedBeforeProvider: boolean = await ctx.runQuery(
        internal.account_billing_purge.hasRetainedStripeDeletionLocatorInternal,
        {
          ownerId: args.ownerId,
          locatorHash: locator.locatorHash,
          locatorKind: locator.locatorKind,
        },
      );
      if (retainedBeforeProvider) {
        await ctx.runMutation(
          internal.account_billing_purge
            .discardUnverifiedBillingDeletionLocatorInternal,
          { ...args, locatorHash: locator.locatorHash },
        );
        continue;
      }

      // Renew and re-assert the exact core/delete lease immediately before
      // each remote mutation. A reset->delete upgrade or reclaimed worker can
      // never continue mutating the provider under a stale lease.
      await ctx.runMutation(
        internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
        {
          ...args,
          stage: "core",
          mode: "delete",
          now: Date.now(),
        },
      );
      const providerClaimId = crypto.randomUUID();
      const claimed: boolean = await ctx.runMutation(
        internal.account_billing_purge.claimBillingDeletionLocatorInternal,
        {
          ...args,
          locatorHash: locator.locatorHash,
          providerClaimId,
          now: Date.now(),
        },
      );
      if (!claimed) continue;
      let discoveredStripeCustomerId: string | null = null;
      try {
        discoveredStripeCustomerId = await deleteStripeLocator({
          ownerId: args.ownerId,
          ownerVerified: locator.ownerVerified,
          kind: locator.locatorKind,
          value: locator.locatorValue,
          locatorHash: locator.locatorHash,
          beforeMutation: async () => {
            await ctx.runMutation(
              internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
              {
                ...args,
                stage: "core",
                mode: "delete",
                now: Date.now(),
              },
            );
            const claimRevalidated: boolean = await ctx.runMutation(
              internal.account_billing_purge
                .revalidateBillingDeletionLocatorClaimInternal,
              {
                ...args,
                locatorHash: locator.locatorHash,
                providerClaimId,
                now: Date.now(),
              },
            );
            if (!claimRevalidated) {
              throw new StripeProviderClaimSupersededError(
                "Stripe deletion provider claim was superseded.",
              );
            }
          },
          hasExactOwnerAlias: async (sourceOwnerId, destinationOwnerId) => {
            const verified: boolean = await ctx.runQuery(
              internal.account_billing_purge.hasExactStripeOwnerAliasInternal,
              { sourceOwnerId, destinationOwnerId },
            );
            return verified;
          },
        });
      } catch (error) {
        if (error instanceof StripeProviderClaimSupersededError) continue;
        if (error instanceof StripeOwnershipMismatchError) {
          await ctx.runMutation(
            internal.account_billing_purge
              .discardUnverifiedBillingDeletionLocatorInternal,
            { ...args, locatorHash: locator.locatorHash, providerClaimId },
          );
          continue;
        }
        await ctx.runMutation(
          internal.account_billing_purge
            .recordBillingDeletionLocatorFailureInternal,
          {
            ...args,
            locatorHash: locator.locatorHash,
            providerClaimId,
            error: safeErrorMessage(error),
            now: Date.now(),
          },
        );
        return {
          ready: false,
          pending: [`stripe_${locator.locatorKind}`],
        };
      }
      await ctx.runMutation(
        internal.account_billing_purge
          .markBillingDeletionLocatorTerminalInternal,
        {
          ...args,
          locatorHash: locator.locatorHash,
          providerClaimId,
          discoveredStripeCustomerId: discoveredStripeCustomerId ?? undefined,
          now: Date.now(),
        },
      );
    }

    const stillPending = await ctx.runQuery(
      internal.account_billing_purge.getPendingBillingDeletionLocatorInternal,
      {
        ownerId: args.ownerId,
        operationId: args.operationId,
        generation: args.generation,
      },
    );
    if (stillPending) {
      return { ready: false, pending: ["stripe_billing_locators"] };
    }

    let hasMore = false;
    const stripeEvents: { hasMore: boolean } = await ctx.runMutation(
      internal.account_billing_purge.deleteOwnerStripeEventBatchInternal,
      args,
    );
    hasMore ||= stripeEvents.hasMore;
    for (const table of OWNER_BILLING_TABLES) {
      const result: { hasMore: boolean } = await ctx.runMutation(
        internal.account_billing_purge.deleteOwnerBillingTableBatchInternal,
        { ...args, table },
      );
      hasMore ||= result.hasMore;
    }
    if (hasMore) {
      return { ready: false, pending: ["billing_rows"] };
    }

    const stripeOwnerAliases: { hasMore: boolean } = await ctx.runMutation(
      internal.account_billing_purge
        .deleteDestinationStripeOwnerAliasBatchInternal,
      args,
    );
    if (stripeOwnerAliases.hasMore) {
      return { ready: false, pending: ["billing_stripe_owner_aliases"] };
    }

    const finished: boolean = await ctx.runMutation(
      internal.account_billing_purge.finishOwnerBillingPurgeInternal,
      args,
    );
    if (!finished) {
      const pending: string[] = await ctx.runQuery(
        internal.account_billing_purge.remainingOwnerBillingInternal,
        { ownerId: args.ownerId },
      );
      return { ready: false, pending };
    }
    return { ready: true, pending: [] };
  },
});
