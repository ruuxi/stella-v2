import Stripe from "stripe";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import { hashSha256Hex } from "./lib/crypto_utils";
import {
  hashStripeBillingLocator,
  hashStripeDeletedOperationTuple,
  hashStripePhysicalSuccessLocators,
  hashStripeRetainedLocatorSet,
  stripeHistoricalResultShape,
} from "./lib/billing_deletion";
import {
  ensureLegacyStripeOperationPhysicalReceiptProvenance,
  hasStripeOperationResolutionCapacityForInsert,
  hasStripePhysicalReceiptCapacityForInsert,
  hasCleanIdleStripeOperationTransport,
  hasCurrentStripeOperationIntegrity,
  hasLegacyStripeOperationIntegrityVersion,
  hasMatchingStripeManualResolutionProof,
  hasOnlyProvenStripeOperationPhysicalReceipts,
  hasValidStripeRetainedLocatorProof,
  hasValidStripeOperationStateLocators,
  STRIPE_RECEIPT_INTEGRITY_VERSION,
} from "./lib/stripe_operation_integrity";
import { assertOwnerPurgeLease } from "./owner_lifecycle";
import { ownershipMigrationSourceDigest } from "./lib/auth_migration_paths";

const STRIPE_API_VERSION = "2026-05-27.dahlia";
const STRIPE_PROVIDER_TIMEOUT_MS = 30_000;
const STRIPE_PROVIDER_ABORT_GRACE_MS = 15_000;
const STRIPE_LATE_CLEANUP_PROVIDER_TIMEOUT_MS = 20_000;
const STRIPE_LATE_CLEANUP_MUTATION_CLAIM_MS =
  STRIPE_LATE_CLEANUP_PROVIDER_TIMEOUT_MS + STRIPE_PROVIDER_ABORT_GRACE_MS;
const STRIPE_LATE_CLEANUP_DISCOVERY_CLAIM_MS = 120_000;
const STRIPE_RECONCILE_RETRY_MS = 30_000;
const STRIPE_RECONCILE_CLAIM_MS =
  STRIPE_PROVIDER_TIMEOUT_MS + STRIPE_PROVIDER_ABORT_GRACE_MS;
// Stripe may prune idempotency keys after 24 hours. Automatic create replay
// stops one hour before that documented floor; older debt uses metadata/list
// discovery only, or remains an explicit lifecycle blocker when Stripe has no
// exact lookup (Billing Portal sessions).
const STRIPE_IDEMPOTENCY_REPLAY_HORIZON_MS = 23 * 60 * 60 * 1_000;
const STRIPE_CHECKOUT_DISCOVERY_MAX_PAGES = 10;
const STRIPE_REQUEST_JSON_MAX_BYTES = 64 * 1024;
const MAX_OWNER_OPERATIONS_PER_PASS = 32;
const MAX_PENDING_LABELS = 40;
// v3 adds exact validation of the customer-metadata transfer tuple, the
// append-only late-result ledger, and state/locator proof at every authority
// boundary.
const SAFE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_STRIPE_LOCATOR = /^[A-Za-z0-9][A-Za-z0-9_:-]{1,191}$/u;
const SAFE_OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const MAX_MANUAL_RESOLUTION_EVIDENCE_LENGTH = 1_024;

const stripeStepValidator = v.union(
  v.literal("customer_create"),
  v.literal("checkout_create"),
  v.literal("portal_create"),
);

const stripeOperationKindValidator = v.union(
  v.literal("subscription_checkout"),
  v.literal("usage_credit_checkout"),
  v.literal("billing_portal"),
);

const stripeManualDebtReasonValidator = v.union(
  v.literal("portal_lookup_unavailable"),
  v.literal("customer_lookup_unavailable"),
  v.literal("customer_authority_revoked"),
  v.literal("customer_duplicate"),
  v.literal("customer_scan_horizon"),
  v.literal("checkout_lookup_unavailable"),
  v.literal("checkout_duplicate"),
  v.literal("checkout_scan_horizon"),
  v.literal("legacy_missing_receipt"),
  v.literal("late_result_conflict"),
);

const pendingResultValidator = v.object({
  ready: v.boolean(),
  pending: v.array(v.string()),
  retryAt: v.union(v.number(), v.null()),
});

const markResultValidator = v.object({
  attemptId: v.string(),
  requestFingerprint: v.string(),
  idempotencyKey: v.string(),
  providerDeadlineAt: v.number(),
  quiescentAfterAt: v.number(),
  replayed: v.boolean(),
});

const settleResultValidator = v.union(
  v.object({
    recorded: v.literal(true),
    duplicate: v.literal(false),
    customerDeleted: v.boolean(),
  }),
  v.object({
    recorded: v.literal(false),
    duplicate: v.literal(true),
    customerDeleted: v.boolean(),
  }),
);

const manualResolutionValidator = v.union(
  v.object({
    kind: v.literal("recovered_customer"),
    stripeCustomerId: v.string(),
  }),
  v.object({
    kind: v.literal("recovered_checkout"),
    stripeCustomerId: v.string(),
    stripeCheckoutSessionId: v.string(),
  }),
  v.object({
    kind: v.literal("recovered_portal"),
    stripeCustomerId: v.string(),
    stripePortalSessionId: v.string(),
  }),
  v.object({ kind: v.literal("provider_confirmed_not_created") }),
);

const manualResolutionResultValidator = v.object({
  resolution: v.union(
    v.literal("recovered_customer"),
    v.literal("recovered_checkout"),
    v.literal("recovered_portal"),
    v.literal("provider_confirmed_not_created"),
  ),
  replayed: v.boolean(),
});

type StripeOperation = Doc<"billing_stripe_operations">;
type StripeStep = "customer_create" | "checkout_create" | "portal_create";

type ExactDispatchTuple = {
  operationId: string;
  attemptId: string;
  step: StripeStep;
  requestFingerprint: string;
  idempotencyKey: string;
  providerDeadlineAt: number;
  reconcileClaimId?: string;
};

type StripeManualDebtReason =
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

const reconcileActionRef = makeFunctionReference<
  "action",
  { operationId: string; attemptId: string },
  null
>("stripe_operation_dispatch:reconcileStripeOperationDispatchInternal");

const claimReconcileCommandRef = makeFunctionReference<
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

const settleSuccessRef = makeFunctionReference<
  "mutation",
  ExactDispatchTuple & {
    ownerId: string;
    ownerGeneration: string;
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
    now: number;
  },
  { recorded: boolean; duplicate: boolean; customerDeleted: boolean }
>("stripe_operation_dispatch:settleStripeOperationDispatchInternal");

const settleNotCreatedRef = makeFunctionReference<
  "mutation",
  ExactDispatchTuple & {
    ownerId: string;
    ownerGeneration: string;
    now: number;
  },
  { recorded: boolean; duplicate: boolean; customerDeleted: boolean }
>("stripe_operation_dispatch:settleStripeOperationNotCreatedInternal");

const deferReconcileRef = makeFunctionReference<
  "mutation",
  Pick<ExactDispatchTuple, "operationId" | "attemptId"> & {
    claimId: string;
    now: number;
  },
  null
>("stripe_operation_dispatch:deferStripeOperationReconciliationInternal");

const revalidateReconcileProviderCallRef = makeFunctionReference<
  "mutation",
  {
    operationId: string;
    attemptId: string;
    claimId: string;
    allowRevokedCustomerAuthority: boolean;
    now: number;
  },
  {
    providerCallDeadlineAt: number;
    customerAuthorityCurrent: boolean;
  } | null
>("stripe_operation_dispatch:revalidateStripeReconcileProviderCallInternal");

const recordManualDebtRef = makeFunctionReference<
  "mutation",
  {
    operationId: string;
    attemptId: string;
    claimId: string;
    reason: StripeManualDebtReason;
    now: number;
  },
  null
>("stripe_operation_dispatch:recordStripeOperationManualDebtInternal");

const drainLateStripeCleanupRef = makeFunctionReference<"action", {}, null>(
  "stripe_operation_dispatch:drainLateStripeCleanupInternal",
);

const getPendingLateStripeCleanupRef = makeFunctionReference<
  "query",
  { now: number },
  null | {
    tupleHash: string;
    ownerHash: string;
    providerOwnerHash: string;
    successLocatorHash: string;
    locatorHash: string;
    locatorKind: "customer" | "checkout_session";
    locatorValue: string;
  }
>("stripe_operation_dispatch:getPendingLateStripeCleanupInternal");

const authorizeLateStripeCleanupProviderOwnerRef = makeFunctionReference<
  "query",
  {
    providerOwnerHash: string;
    cleanupOwnerHash?: string;
    providerOwnerId: string;
  },
  boolean
>("stripe_operation_dispatch:authorizeLateStripeCleanupProviderOwnerInternal");

const authorizeLateStripeCleanupRowRef = makeFunctionReference<
  "query",
  { tupleHash: string; locatorHash: string },
  boolean
>("stripe_operation_dispatch:authorizeLateStripeCleanupRowInternal");

const hasTerminalStripeCleanupCustomerRef = makeFunctionReference<
  "query",
  { locatorHash: string },
  boolean
>("stripe_operation_dispatch:hasTerminalStripeCleanupCustomerInternal");

const claimLateStripeCleanupRef = makeFunctionReference<
  "mutation",
  { tupleHash: string; locatorHash: string; claimId: string; now: number },
  boolean
>("stripe_operation_dispatch:claimLateStripeCleanupInternal");

const revalidateLateStripeCleanupClaimRef = makeFunctionReference<
  "mutation",
  { tupleHash: string; locatorHash: string; claimId: string; now: number },
  boolean
>("stripe_operation_dispatch:revalidateLateStripeCleanupClaimInternal");

const markLateStripeCleanupTerminalRef = makeFunctionReference<
  "mutation",
  { tupleHash: string; locatorHash: string; claimId: string; now: number },
  null
>("stripe_operation_dispatch:markLateStripeCleanupTerminalInternal");

const recordLateStripeCleanupFailureRef = makeFunctionReference<
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

const scheduleLateStripeCleanupContinuationRef = makeFunctionReference<
  "mutation",
  { delayMs: number },
  null
>("stripe_operation_dispatch:scheduleLateStripeCleanupContinuationInternal");

const resumeOwnershipMigrationRef = makeFunctionReference<
  "action",
  {
    fromOwnerId: string;
    toOwnerId: string;
    expectedLeaseGeneration?: number;
  },
  null
>("auth_migration:migrateOwnership");

const reconcileInactiveStripeMetadataTransferRef = makeFunctionReference<
  "action",
  { operationId: string },
  null
>("stripe_operation_dispatch:reconcileInactiveStripeMetadataTransferInternal");

const getInactiveStripeMetadataTransferRecoveryRef = makeFunctionReference<
  "mutation",
  { operationId: string; now: number },
  null | {
    operationId: string;
    stripeCustomerId: string;
    sourceOwnerId: string;
    destinationOwnerId: string;
    attemptId: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    quiescentAfterAt: number;
    rollbackIdempotencyKey: string;
  }
>(
  "stripe_operation_dispatch:getInactiveStripeMetadataTransferRecoveryInternal",
);

const settleInactiveStripeMetadataTransferRecoveryRef = makeFunctionReference<
  "mutation",
  {
    operationId: string;
    stripeCustomerId: string;
    sourceOwnerId: string;
    destinationOwnerId: string;
    attemptId: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    quiescentAfterAt: number;
    outcome: "source_restored" | "customer_deleted" | "foreign_owner";
    now: number;
  },
  boolean
>(
  "stripe_operation_dispatch:settleInactiveStripeMetadataTransferRecoveryInternal",
);

const scheduleInactiveStripeMetadataTransferRecoveryRef = makeFunctionReference<
  "mutation",
  { operationId: string; delayMs: number },
  null
>(
  "stripe_operation_dispatch:scheduleInactiveStripeMetadataTransferRecoveryInternal",
);

const conflict = (message: string) =>
  new ConvexError({ code: "STRIPE_OPERATION_CONFLICT", message });

export const stripeResolutionAuditHash = async (
  kind: "locator" | "operator" | "evidence",
  value: string,
): Promise<string> =>
  await hashSha256Hex(`stella-stripe-resolution-v1\u0000${kind}\u0000${value}`);

type CheckoutDiscoveryPage = {
  data: ReadonlyArray<{
    id: string;
    metadata?: Record<string, string> | null;
  }>;
  has_more: boolean;
};

export type CheckoutDiscoveryResult =
  | { kind: "found"; sessionId: string }
  | { kind: "not_found" }
  | { kind: "manual_debt"; reason: "duplicate" | "scan_horizon" };

/**
 * Prove uniqueness across the complete bounded Stripe listing before using a
 * discovered Checkout locator. A singleton on an early page is only a
 * candidate: a later page (or an unscanned page beyond the safety horizon)
 * can still contain the same operation metadata.
 */
export const discoverUniqueStripeCheckoutSession = async (args: {
  operationId: string;
  listPage: (startingAfter?: string) => Promise<CheckoutDiscoveryPage>;
  maxPages?: number;
}): Promise<CheckoutDiscoveryResult> => {
  const maxPages = args.maxPages ?? STRIPE_CHECKOUT_DISCOVERY_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw conflict("Stripe Checkout discovery page bound is invalid.");
  }
  let startingAfter: string | undefined;
  let candidateId: string | undefined;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await args.listPage(startingAfter);
    for (const session of page.data) {
      if (session.metadata?.stellaOperationId !== args.operationId) continue;
      if (candidateId && candidateId !== session.id) {
        return { kind: "manual_debt", reason: "duplicate" };
      }
      candidateId = session.id;
    }
    if (!page.has_more) {
      return candidateId
        ? { kind: "found", sessionId: candidateId }
        : { kind: "not_found" };
    }
    if (pageIndex === maxPages - 1) {
      return { kind: "manual_debt", reason: "scan_horizon" };
    }
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) {
      throw conflict("Stripe Checkout discovery pagination was invalid.");
    }
  }
  return { kind: "manual_debt", reason: "scan_horizon" };
};

export const remainingStripeProviderBudgetMs = (
  providerDeadlineAt: number,
  now = Date.now(),
): number => {
  const remaining = Math.floor(providerDeadlineAt - now);
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw conflict("Stripe provider-call authority has expired.");
  }
  return Math.min(STRIPE_PROVIDER_TIMEOUT_MS, remaining);
};

const getStripeClient = (timeoutMs: number) => {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("Stripe is not configured.");
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    // The durable operation row owns all retries with a frozen request and
    // exact idempotency key. SDK-internal retries would be an invisible
    // physical attempt.
    maxNetworkRetries: 0,
    timeout: timeoutMs,
  });
};

const normalizeRequestJson = (requestJson: string): string => {
  const bytes = new TextEncoder().encode(requestJson).byteLength;
  if (bytes < 2 || bytes > STRIPE_REQUEST_JSON_MAX_BYTES) {
    throw conflict("Stripe dispatch request is outside the allowed size.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    throw conflict("Stripe dispatch request is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw conflict("Stripe dispatch request must be a JSON object.");
  }
  // Persist exactly the caller-supplied bytes. Reconciliation parses this
  // immutable envelope, while the fingerprint rejects any changed replay.
  return requestJson;
};

const idempotencyKeyForStep = (
  operation: StripeOperation,
  step: StripeStep,
): string => {
  switch (step) {
    case "customer_create":
      return operation.stripeCustomerCreateIdempotencyKey;
    case "checkout_create":
      return `${operation.idempotencyKey}:checkout`;
    case "portal_create":
      return `${operation.idempotencyKey}:portal`;
  }
};

/**
 * One customer-create authority exists for an owner/customer epoch, even when
 * reset rotates the Convex owner generation. Customer deletion advances the
 * epoch; reset intentionally does not. Keeping generation out of this key
 * prevents two preserved logical requests on opposite sides of a reset from
 * creating different Stripe customers concurrently.
 */
export const stripeCustomerAuthorityIdempotencyKey = async (
  ownerId: string,
  authorityEpoch: number,
): Promise<string> => {
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 0) {
    throw conflict("Stripe customer authority epoch is malformed.");
  }
  const keyHash = await hashSha256Hex(
    `stella-billing-customer-v3\u0000${ownerId}\u0000${authorityEpoch}`,
  );
  return `stella-billing-customer-v3-${keyHash}`;
};

/**
 * Pin the customer-create key transactionally on the billing profile. During
 * a rolling deployment an older v2 call may already be across the provider
 * boundary, so its frozen key wins over the v3 formula. Once pinned, every
 * distinct logical request in the epoch uses the same provider authority.
 */
export const resolvePinnedStripeCustomerAuthorityKey = async (
  ctx: MutationCtx,
  args: {
    profile: Doc<"billing_profiles">;
    ownerId: string;
    authorityEpoch: number;
    now: number;
  },
): Promise<string> => {
  const existingPin = args.profile.stripeCustomerCreateIdempotencyKey?.trim();
  const activeRows = await ctx.db
    .query("billing_stripe_operations")
    .withIndex("by_ownerId_and_activeStep_and_createdAt", (q) =>
      q.eq("ownerId", args.ownerId).eq("activeStep", "customer_create"),
    )
    .take(MAX_OWNER_OPERATIONS_PER_PASS + 1);
  if (activeRows.length > MAX_OWNER_OPERATIONS_PER_PASS) {
    throw conflict(
      "Stripe customer authority backfill exceeds the bounded active horizon.",
    );
  }
  const currentActiveRows = activeRows.filter(
    (row) =>
      row.dispatchState === "may_have_dispatched" &&
      (row.stripeCustomerAuthorityEpoch ?? 0) === args.authorityEpoch,
  );
  for (const row of currentActiveRows) {
    if (
      (!hasCurrentStripeOperationIntegrity(row) &&
        !hasLegacyStripeOperationIntegrityVersion(row)) ||
      !hasValidStripeOperationStateLocators(row) ||
      !hasCompleteActiveDispatchFields(row)
    ) {
      throw conflict("Active Stripe customer authority is malformed.");
    }
    if (
      !(await ensureCurrentStripeOperationIntegrity(ctx, row, args.now, {
        strictTransport: true,
        allowManualDebt: true,
      }))
    ) {
      throw conflict(
        "Active Stripe customer authority receipt provenance is incomplete.",
      );
    }
  }
  const currentActiveKeys = new Set(
    currentActiveRows.map((row) => row.activeIdempotencyKey?.trim() ?? ""),
  );
  if (currentActiveKeys.has("")) {
    throw conflict("Active Stripe customer authority is malformed.");
  }
  if (currentActiveKeys.size > 1) {
    throw conflict(
      "Multiple active Stripe customer authorities require reconciliation.",
    );
  }
  for (const row of currentActiveRows) {
    if (
      row.manualDebtReason !== undefined ||
      row.providerDeadlineAt === undefined ||
      !Number.isSafeInteger(row.providerDeadlineAt) ||
      args.now >=
        row.providerDeadlineAt -
          STRIPE_PROVIDER_TIMEOUT_MS +
          STRIPE_IDEMPOTENCY_REPLAY_HORIZON_MS
    ) {
      // Once an active customer-create tuple is ambiguous or its Stripe
      // idempotency key may have expired, no distinct logical operation may
      // acquire physical create authority from that key. The exact tuple's
      // reconciler remains discovery-only and operator resolution owns the
      // durable debt.
      throw conflict(
        "Stripe customer authority requires reconciliation before another customer can be created.",
      );
    }
  }

  // A frozen active provider tuple is stronger than a profile pin written by
  // a newer deployment. This exact override bridges the deploy interleaving
  // where v3 was pinned while an older v2 call was already in flight.
  let pinnedKey = [...currentActiveKeys][0] ?? existingPin;
  if (!pinnedKey) {
    const currentRows = await ctx.db
      .query("billing_stripe_operations")
      .withIndex(
        "by_ownerId_and_stripeCustomerAuthorityEpoch_and_createdAt",
        (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("stripeCustomerAuthorityEpoch", args.authorityEpoch),
      )
      .order("desc")
      .take(1);
    const legacyRows =
      args.authorityEpoch === 0 && currentRows.length === 0
        ? await ctx.db
            .query("billing_stripe_operations")
            .withIndex(
              "by_ownerId_and_stripeCustomerAuthorityEpoch_and_createdAt",
              (q) =>
                q
                  .eq("ownerId", args.ownerId)
                  .eq("stripeCustomerAuthorityEpoch", undefined),
            )
            .order("desc")
            .take(1)
        : [];
    pinnedKey = (currentRows[0] ?? legacyRows[0])
      ?.stripeCustomerCreateIdempotencyKey;
  }
  pinnedKey ??= await stripeCustomerAuthorityIdempotencyKey(
    args.ownerId,
    args.authorityEpoch,
  );
  if (!pinnedKey.trim()) {
    throw conflict("Stripe customer authority key is empty.");
  }
  if (existingPin !== pinnedKey) {
    await ctx.db.patch(args.profile._id, {
      stripeCustomerCreateIdempotencyKey: pinnedKey,
      updatedAt: args.now,
    });
  }
  return pinnedKey;
};

const assertStepAllowed = (operation: StripeOperation, step: StripeStep) => {
  if (
    step === "customer_create" &&
    (operation.kind === "billing_portal" || operation.stripeCustomerId)
  ) {
    throw conflict("This Stripe operation cannot create another customer.");
  }
  if (
    step === "checkout_create" &&
    (operation.kind === "billing_portal" || !operation.stripeCustomerId)
  ) {
    throw conflict("Stripe checkout requires the captured customer locator.");
  }
  if (
    step === "portal_create" &&
    (operation.kind !== "billing_portal" || !operation.stripeCustomerId)
  ) {
    throw conflict("Stripe portal dispatch is invalid for this operation.");
  }
};

const readOperation = async (ctx: MutationCtx, operationId: string) =>
  await ctx.db
    .query("billing_stripe_operations")
    .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
    .unique();

const exactActiveTuple = (
  operation: StripeOperation,
  args: ExactDispatchTuple,
): boolean =>
  operation.dispatchState === "may_have_dispatched" &&
  operation.activeAttemptId === args.attemptId &&
  operation.activeStep === args.step &&
  operation.activeRequestFingerprint === args.requestFingerprint &&
  operation.activeIdempotencyKey === args.idempotencyKey &&
  operation.providerDeadlineAt === args.providerDeadlineAt &&
  (args.reconcileClaimId
    ? operation.reconcileClaimId === args.reconcileClaimId
    : operation.reconcileClaimId === undefined);

const sameActivePhysicalTuple = (
  operation: StripeOperation,
  args: ExactDispatchTuple,
): boolean =>
  operation.dispatchState === "may_have_dispatched" &&
  operation.activeAttemptId === args.attemptId &&
  operation.activeStep === args.step &&
  operation.activeRequestFingerprint === args.requestFingerprint &&
  operation.activeIdempotencyKey === args.idempotencyKey &&
  operation.providerDeadlineAt === args.providerDeadlineAt;

const exactLastTuple = (
  operation: StripeOperation,
  args: ExactDispatchTuple,
): boolean =>
  operation.lastStripeAttemptId === args.attemptId &&
  operation.lastStripeStep === args.step &&
  operation.lastStripeRequestFingerprint === args.requestFingerprint &&
  operation.lastStripeIdempotencyKey === args.idempotencyKey &&
  operation.lastStripeProviderDeadlineAt === args.providerDeadlineAt &&
  operation.lastStripeReconcileClaimId === args.reconcileClaimId;

const sameLastPhysicalTuple = (
  operation: StripeOperation,
  args: ExactDispatchTuple,
): boolean =>
  operation.lastStripeAttemptId === args.attemptId &&
  operation.lastStripeStep === args.step &&
  operation.lastStripeRequestFingerprint === args.requestFingerprint &&
  operation.lastStripeIdempotencyKey === args.idempotencyKey &&
  operation.lastStripeProviderDeadlineAt === args.providerDeadlineAt;

const sameLateResultPhysicalTuple = (
  operation: StripeOperation,
  args: ExactDispatchTuple,
): boolean =>
  operation.lateResultConflictAttemptId === args.attemptId &&
  operation.lateResultConflictStep === args.step &&
  operation.lateResultRequestFingerprint === args.requestFingerprint &&
  operation.lateResultIdempotencyKey === args.idempotencyKey &&
  operation.lateResultProviderDeadlineAt === args.providerDeadlineAt;

const locatorsMatchLateResult = (
  operation: StripeOperation,
  args: {
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
  },
): boolean =>
  operation.lateResultStripeCustomerId === args.stripeCustomerId?.trim() &&
  operation.lateResultStripeCheckoutSessionId ===
    args.stripeCheckoutSessionId?.trim() &&
  operation.lateResultStripePortalSessionId ===
    args.stripePortalSessionId?.trim();

const hasUnexpectedIdleDispatchFields = (
  operation: StripeOperation,
  options: { allowManualDebt?: boolean } = {},
) =>
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
  (!options.allowManualDebt && operation.manualDebtReason !== undefined) ||
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
  operation.lateResultConflictQuiescentAfterAt !== undefined ||
  operation.stripeCustomerMetadataTransferState === "may_have_dispatched" ||
  operation.stripeCustomerMetadataTransferToOwnerId !== undefined ||
  operation.stripeCustomerMetadataTransferAttemptId !== undefined ||
  operation.stripeCustomerMetadataTransferIdempotencyKey !== undefined ||
  operation.stripeCustomerMetadataTransferProviderDeadlineAt !== undefined ||
  operation.stripeCustomerMetadataTransferQuiescentAfterAt !== undefined ||
  operation.stripeCustomerMetadataTransferDebtReason !== undefined;

const stripeMetadataTransferShape = (
  operation: StripeOperation,
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
  const hasAnyTuple =
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
    return hasAnyTuple ? "malformed" : "clean";
  }
  return "malformed";
};

const hasCompleteActiveDispatchFields = (operation: StripeOperation): boolean =>
  operation.state === "reserved" &&
  operation.dispatchState === "may_have_dispatched" &&
  operation.activeStep !== undefined &&
  operation.activeAttemptId !== undefined &&
  operation.activeRequestJson !== undefined &&
  operation.activeRequestFingerprint !== undefined &&
  operation.activeIdempotencyKey !== undefined &&
  operation.providerDeadlineAt !== undefined &&
  operation.quiescentAfterAt !== undefined &&
  operation.terminalizedWithoutProviderDispatch !== true &&
  operation.terminalizedForDeletionCleanup !== true &&
  (operation.reconcileClaimId === undefined) ===
    (operation.reconcileClaimExpiresAt === undefined) &&
  stripeMetadataTransferShape(operation) === "clean";

const ensureCurrentStripeOperationIntegrity = async (
  ctx: MutationCtx,
  operation: StripeOperation,
  now: number,
  options: { strictTransport?: boolean; allowManualDebt?: boolean } = {},
): Promise<boolean> => {
  if (hasCurrentStripeOperationIntegrity(operation)) {
    if (
      operation.terminalizedByManualResolutionId !== undefined &&
      !(await hasMatchingStripeManualResolutionProof(ctx, operation))
    ) {
      return false;
    }
    if (!(await hasOnlyProvenStripeOperationPhysicalReceipts(ctx, operation))) {
      return false;
    }
    if (!options.strictTransport) return true;
    if (operation.dispatchState === "may_have_dispatched") {
      return (
        (options.allowManualDebt || operation.manualDebtReason === undefined) &&
        hasCompleteActiveDispatchFields(operation) &&
        (await hasMatchingStripePhysicalReceipt(ctx, {
          operationId: operation.operationId,
          attemptId: operation.activeAttemptId!,
          step: operation.activeStep!,
          requestFingerprint: operation.activeRequestFingerprint!,
          idempotencyKey: operation.activeIdempotencyKey!,
          providerDeadlineAt: operation.providerDeadlineAt!,
        }))
      );
    }
    if (
      operation.dispatchState !== "idle" ||
      hasUnexpectedIdleDispatchFields(operation)
    ) {
      return false;
    }
    const historicalShape = stripeHistoricalResultShape(operation);
    if (historicalShape === "malformed") return false;
    if (
      historicalShape === "clean" &&
      operation.state !== "reserved" &&
      operation.terminalizedForDeletionCleanup !== true &&
      operation.terminalizedWithoutProviderDispatch !== true
    ) {
      return await hasMatchingStripeManualResolutionProof(ctx, operation);
    }
    return (
      historicalShape !== "complete" ||
      (await hasMatchingStripePhysicalReceipt(ctx, {
        operationId: operation.operationId,
        attemptId: operation.lastStripeAttemptId!,
        step: operation.lastStripeStep!,
        requestFingerprint: operation.lastStripeRequestFingerprint!,
        idempotencyKey: operation.lastStripeIdempotencyKey!,
        providerDeadlineAt: operation.lastStripeProviderDeadlineAt!,
      }))
    );
  }
  if (
    (operation.integrityVersion !== undefined &&
      operation.integrityVersion !== 1 &&
      operation.integrityVersion !== 2) ||
    !hasValidStripeOperationStateLocators(operation)
  ) {
    return false;
  }
  if (
    operation.terminalizedByManualResolutionId !== undefined &&
    !(await hasMatchingStripeManualResolutionProof(ctx, operation))
  ) {
    return false;
  }
  const transportValid =
    operation.dispatchState === "may_have_dispatched"
      ? hasCompleteActiveDispatchFields(operation)
      : operation.dispatchState === "idle" &&
        !hasUnexpectedIdleDispatchFields(operation, {
          allowManualDebt: true,
        });
  if (!transportValid) return false;
  if (operation.dispatchState === "may_have_dispatched") {
    const tuple = {
      operationId: operation.operationId,
      attemptId: operation.activeAttemptId!,
      step: operation.activeStep!,
      requestFingerprint: operation.activeRequestFingerprint!,
      idempotencyKey: operation.activeIdempotencyKey!,
      providerDeadlineAt: operation.providerDeadlineAt!,
    };
    let normalizedRequestJson: string;
    try {
      normalizedRequestJson = normalizeRequestJson(
        operation.activeRequestJson!,
      );
    } catch {
      return false;
    }
    const expectedFingerprint = await hashSha256Hex(
      `${operation.activeStep}\u0000${operation.activeIdempotencyKey}\u0000${normalizedRequestJson}`,
    );
    if (
      !SAFE_ATTEMPT_ID.test(operation.activeAttemptId!) ||
      operation.activeIdempotencyKey !==
        idempotencyKeyForStep(operation, operation.activeStep!) ||
      operation.activeRequestFingerprint !== expectedFingerprint ||
      operation.quiescentAfterAt !==
        operation.providerDeadlineAt! + STRIPE_PROVIDER_ABORT_GRACE_MS
    ) {
      return false;
    }
    // Grandfather only a cryptographically self-consistent pre-v3 tuple. This
    // call is unconditional so an existing rollout receipt also receives its
    // missing provider-owner binding; tuple presence alone is not provenance.
    await ensureStripePhysicalReceipt(ctx, tuple, now, operation.ownerId, true);
  } else {
    const historicalShape = stripeHistoricalResultShape(operation);
    if (historicalShape === "malformed") return false;
    if (
      historicalShape === "clean" &&
      operation.state !== "reserved" &&
      operation.terminalizedForDeletionCleanup !== true &&
      operation.terminalizedWithoutProviderDispatch !== true &&
      !(await hasMatchingStripeManualResolutionProof(ctx, operation))
    ) {
      return false;
    }
    // The enumerated pre-v3 idle lineage may predate immutable receipt rows.
    // The exhaustive legacy helper below owns the bounded create/backfill and
    // result/not-created/provider bindings. Current-v3 rows never enter here.
  }
  if (
    !(await ensureLegacyStripeOperationPhysicalReceiptProvenance(
      ctx,
      operation,
    ))
  ) {
    return false;
  }
  await ctx.db.patch(operation._id, {
    integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
    lifecycleIntegrityVersion: undefined,
    updatedAt: now,
  });
  return true;
};

const assertLocatorCompatible = (
  operation: StripeOperation,
  args: {
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
  },
) => {
  for (const [stored, incoming] of [
    [operation.stripeCustomerId, args.stripeCustomerId?.trim()],
    [operation.stripeCheckoutSessionId, args.stripeCheckoutSessionId?.trim()],
    [operation.stripePortalSessionId, args.stripePortalSessionId?.trim()],
  ] as const) {
    if (stored && incoming && stored !== incoming) {
      throw conflict("Stripe returned a different locator for the same step.");
    }
  }
};

const locatorsAreCompatible = (
  operation: StripeOperation,
  args: {
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
  },
): boolean => {
  try {
    assertLocatorCompatible(operation, args);
    return true;
  } catch {
    return false;
  }
};

const isStripeCustomerTombstoned = async (
  ctx: MutationCtx,
  stripeCustomerId: string,
): Promise<boolean> => {
  const locatorHash = await hashStripeBillingLocator(
    "customer",
    stripeCustomerId,
  );
  const tombstone = await ctx.db
    .query("billing_stripe_deletion_tombstones")
    .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
    .unique();
  if (tombstone && tombstone.locatorKind !== "customer") {
    throw conflict("Stripe customer deletion tombstone kind changed.");
  }
  return Boolean(tombstone);
};

/**
 * Persist the hash-only authority for one exact physical request before any
 * provider I/O (or while backfilling a complete pre-rollout receipt). The
 * tuple deliberately excludes mutable owner/generation and reconcile-claim
 * identity so a delayed result remains authentic after reset or migration.
 */
const ensureStripePhysicalReceipt = async (
  ctx: MutationCtx,
  args: ExactDispatchTuple,
  now: number,
  providerOwnerId: string,
  allowLegacyProviderOwnerBackfill = false,
): Promise<string> => {
  const tupleHash = await hashStripeDeletedOperationTuple(args);
  const providerOwnerHash =
    await ownershipMigrationSourceDigest(providerOwnerId);
  const rows = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
    .take(2);
  if (
    rows.length > 1 ||
    (rows[0] && rows[0].operationId !== args.operationId)
  ) {
    throw conflict("Stripe physical receipt authority is duplicated.");
  }
  if (!rows[0]) {
    if (
      !(await hasStripePhysicalReceiptCapacityForInsert(ctx, args.operationId))
    ) {
      throw conflict(
        "Stripe physical receipt capacity requires lifecycle repair.",
      );
    }
    await ctx.db.insert("billing_stripe_physical_receipts", {
      operationId: args.operationId,
      tupleHash,
      providerOwnerHash,
      createdAt: now,
    });
  } else if (rows[0].providerOwnerHash !== providerOwnerHash) {
    if (
      rows[0].providerOwnerHash === undefined &&
      allowLegacyProviderOwnerBackfill
    ) {
      await ctx.db.patch(rows[0]._id, { providerOwnerHash });
    } else {
      throw conflict("Stripe physical receipt provider owner changed.");
    }
  }
  return tupleHash;
};

const hasMatchingStripePhysicalReceipt = async (
  ctx: Pick<QueryCtx, "db">,
  args: ExactDispatchTuple,
): Promise<boolean> => {
  const tupleHash = await hashStripeDeletedOperationTuple(args);
  const rows = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
    .take(2);
  return rows.length === 1 && rows[0]!.operationId === args.operationId;
};

export const hasValidatedStripeMetadataTransferAuthority = async (
  ctx: Pick<QueryCtx, "db">,
  operation: StripeOperation,
): Promise<boolean> => {
  if (
    !hasCurrentStripeOperationIntegrity(operation) ||
    !(await hasOnlyProvenStripeOperationPhysicalReceipts(ctx, operation)) ||
    (operation.terminalizedByManualResolutionId !== undefined &&
      !(await hasMatchingStripeManualResolutionProof(ctx, operation))) ||
    stripeMetadataTransferShape(operation) !== "active" ||
    operation.dispatchState !== "idle" ||
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
    hasAnyProjectedLateResult(operation)
  ) {
    return false;
  }
  const historicalShape = stripeHistoricalResultShape(operation);
  if (historicalShape === "malformed") return false;
  if (historicalShape === "clean") {
    return (
      operation.state === "reserved" ||
      operation.terminalizedForDeletionCleanup === true ||
      operation.terminalizedWithoutProviderDispatch === true ||
      (operation.terminalizedByManualResolutionId !== undefined &&
        (await hasMatchingStripeManualResolutionProof(ctx, operation)))
    );
  }
  return await hasMatchingStripePhysicalReceipt(ctx, {
    operationId: operation.operationId,
    attemptId: operation.lastStripeAttemptId!,
    step: operation.lastStripeStep!,
    requestFingerprint: operation.lastStripeRequestFingerprint!,
    idempotencyKey: operation.lastStripeIdempotencyKey!,
    providerDeadlineAt: operation.lastStripeProviderDeadlineAt!,
  });
};

/**
 * Capturing a customer locator and publishing it into the owner's preserved
 * billing profile must be one transaction. Otherwise a worker can crash after
 * the operation receipt commits, reset can advance the owner generation, and a
 * different logical checkout can create a second Stripe customer.
 *
 * Never recreate a missing profile here: permanent deletion is allowed to
 * remove it while an already-dispatched provider response is still settling.
 * The operation receipt remains the deletion authority in that case.
 */
const convergeStripeCustomerProfile = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    stripeCustomerId: string;
    expectedCustomerAuthorityEpoch?: number;
    now: number;
  },
): Promise<
  | "linked"
  | "missing_profile"
  | "deleted_customer"
  | "stale_authority"
  | "conflicting_customer"
  | "foreign_customer"
> => {
  const stripeCustomerId = args.stripeCustomerId.trim();
  if (!stripeCustomerId) {
    throw conflict("Stripe customer locator is empty.");
  }
  const locatorHash = await hashStripeBillingLocator(
    "customer",
    stripeCustomerId,
  );
  const [profile, linkedProfile, tombstone] = await Promise.all([
    ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique(),
    ctx.db
      .query("billing_profiles")
      .withIndex("by_stripeCustomerId", (q) =>
        q.eq("stripeCustomerId", stripeCustomerId),
      )
      .unique(),
    ctx.db
      .query("billing_stripe_deletion_tombstones")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
      .unique(),
  ]);
  if (tombstone) return "deleted_customer";
  if (linkedProfile && linkedProfile.ownerId !== args.ownerId) {
    return "foreign_customer";
  }
  if (!profile) return "missing_profile";
  if (
    args.expectedCustomerAuthorityEpoch !== undefined &&
    (profile.stripeCustomerAuthorityEpoch ?? 0) !==
      args.expectedCustomerAuthorityEpoch
  ) {
    return "stale_authority";
  }
  if (
    profile.stripeCustomerId &&
    profile.stripeCustomerId !== stripeCustomerId &&
    profile.stripeCustomerTerminal !== true
  ) {
    return "conflicting_customer";
  }
  if (profile.stripeCustomerId !== stripeCustomerId) {
    await ctx.db.patch(profile._id, {
      stripeCustomerId,
      stripeCustomerUpdatedAt: undefined,
      stripeCustomerEventId: undefined,
      stripeCustomerTerminal: false,
      stripeSubscriptionId: "",
      stripeSubscriptionTerminal: false,
      updatedAt: args.now,
    });
  }
  return "linked";
};

export const markStripeOperationDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    attemptId: v.string(),
    step: stripeStepValidator,
    requestJson: v.string(),
    now: v.number(),
  },
  returns: markResultValidator,
  handler: async (ctx, args) => {
    if (!SAFE_ATTEMPT_ID.test(args.attemptId)) {
      throw conflict("Stripe dispatch attempt ID is invalid.");
    }
    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      operation.ownerId !== args.ownerId ||
      operation.ownerGeneration !== args.ownerGeneration ||
      operation.state !== "reserved"
    ) {
      throw conflict("Stripe operation is no longer active.");
    }
    if (
      !(await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now, {
        strictTransport: true,
      }))
    ) {
      throw conflict("Stripe operation integrity requires reconciliation.");
    }
    if (operation.manualDebtReason) {
      throw conflict("Stripe operation requires audited manual resolution.");
    }
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !profile ||
      (profile.stripeCustomerAuthorityEpoch ?? 0) !==
        (operation.stripeCustomerAuthorityEpoch ?? 0)
    ) {
      throw conflict("Stripe customer authority was rotated.");
    }
    if (args.step === "customer_create") {
      if (profile.stripeCustomerId.trim()) {
        throw conflict(
          "Stripe customer authority already has a canonical customer.",
        );
      }
      const pinnedCustomerKey = await resolvePinnedStripeCustomerAuthorityKey(
        ctx,
        {
          profile,
          ownerId: args.ownerId,
          authorityEpoch: operation.stripeCustomerAuthorityEpoch ?? 0,
          now: args.now,
        },
      );
      if (operation.stripeCustomerCreateIdempotencyKey !== pinnedCustomerKey) {
        throw conflict(
          "Stripe customer authority key changed; retry the logical request.",
        );
      }
    }
    assertStepAllowed(operation, args.step);
    if (
      operation.stripeCustomerId &&
      args.step !== "customer_create" &&
      (await isStripeCustomerTombstoned(ctx, operation.stripeCustomerId))
    ) {
      throw conflict("The Stripe customer for this operation was deleted.");
    }
    const requestJson = normalizeRequestJson(args.requestJson);
    const idempotencyKey = idempotencyKeyForStep(operation, args.step);
    const requestFingerprint = await hashSha256Hex(
      `${args.step}\u0000${idempotencyKey}\u0000${requestJson}`,
    );
    if (operation.dispatchState === "may_have_dispatched") {
      if (
        operation.activeStep !== args.step ||
        operation.activeRequestFingerprint !== requestFingerprint ||
        operation.activeIdempotencyKey !== idempotencyKey ||
        operation.activeRequestJson !== requestJson ||
        !operation.activeAttemptId ||
        operation.providerDeadlineAt === undefined ||
        operation.quiescentAfterAt === undefined
      ) {
        throw conflict("A different Stripe step is already in flight.");
      }
      // Rolling-upgrade backfill: pre-feature marked rows contain a complete
      // immutable tuple but no hash receipt. Backfill before returning replay
      // authority so later manual resolution, reset, migration, or deletion
      // cannot make a suspended callback unauthenticated.
      await ensureStripePhysicalReceipt(
        ctx,
        {
          operationId: operation.operationId,
          attemptId: operation.activeAttemptId,
          step: operation.activeStep,
          requestFingerprint: operation.activeRequestFingerprint,
          idempotencyKey: operation.activeIdempotencyKey,
          providerDeadlineAt: operation.providerDeadlineAt,
        },
        args.now,
        operation.ownerId,
        hasLegacyStripeOperationIntegrityVersion(operation),
      );
      return {
        attemptId: operation.activeAttemptId,
        requestFingerprint,
        idempotencyKey,
        providerDeadlineAt: operation.providerDeadlineAt,
        quiescentAfterAt: operation.quiescentAfterAt,
        replayed: true,
      };
    }
    if (operation.dispatchState !== "idle") {
      throw conflict(
        "Legacy Stripe replay authority requires audited reconciliation.",
      );
    }
    const providerDeadlineAt = args.now + STRIPE_PROVIDER_TIMEOUT_MS;
    const quiescentAfterAt =
      providerDeadlineAt + STRIPE_PROVIDER_ABORT_GRACE_MS;
    await ensureStripePhysicalReceipt(
      ctx,
      {
        operationId: operation.operationId,
        attemptId: args.attemptId,
        step: args.step,
        requestFingerprint,
        idempotencyKey,
        providerDeadlineAt,
      },
      args.now,
      operation.ownerId,
    );
    await ctx.db.patch(operation._id, {
      dispatchState: "may_have_dispatched",
      activeStep: args.step,
      activeAttemptId: args.attemptId,
      activeRequestJson: requestJson,
      activeRequestFingerprint: requestFingerprint,
      activeIdempotencyKey: idempotencyKey,
      providerDeadlineAt,
      quiescentAfterAt,
      nextReconcileAt: quiescentAfterAt,
      reconcileClaimId: undefined,
      reconcileClaimExpiresAt: undefined,
      manualDebtReason: undefined,
      integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
      lifecycleIntegrityVersion: undefined,
      terminalizedByManualResolutionId: undefined,
      leaseExpiresAt: quiescentAfterAt,
      updatedAt: args.now,
    });
    // The first durable mark owns its own crash wake. A lost action response
    // must reconcile without waiting for reset, deletion, migration, or a user
    // retry to notice the marked row.
    await ctx.scheduler.runAt(quiescentAfterAt, reconcileActionRef, {
      operationId: operation.operationId,
      attemptId: args.attemptId,
    });
    return {
      attemptId: args.attemptId,
      requestFingerprint,
      idempotencyKey,
      providerDeadlineAt,
      quiescentAfterAt,
      replayed: false,
    };
  },
});

/**
 * Last-moment authority check for the user action that owns the original
 * physical request. A stalled action must re-enter this mutation immediately
 * before provider I/O; a reconciler claim, manual debt, tuple change, or the
 * persisted absolute deadline makes the action perform zero Stripe calls.
 */
export const revalidateStripeInitialProviderCallInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    attemptId: v.string(),
    step: stripeStepValidator,
    requestFingerprint: v.string(),
    idempotencyKey: v.string(),
    providerDeadlineAt: v.number(),
    now: v.number(),
  },
  returns: v.union(v.null(), v.object({ providerCallDeadlineAt: v.number() })),
  handler: async (ctx, args) => {
    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      !(await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now, {
        strictTransport: true,
      })) ||
      operation.ownerId !== args.ownerId ||
      operation.ownerGeneration !== args.ownerGeneration ||
      operation.manualDebtReason !== undefined ||
      args.now >= args.providerDeadlineAt ||
      !exactActiveTuple(operation, args)
    ) {
      return null;
    }
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      return null;
    }
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !profile ||
      (profile.stripeCustomerAuthorityEpoch ?? 0) !==
        (operation.stripeCustomerAuthorityEpoch ?? 0)
    ) {
      return null;
    }
    if (args.step === "customer_create") {
      if (profile.stripeCustomerId.trim()) {
        return null;
      }
      const pinnedCustomerKey = await resolvePinnedStripeCustomerAuthorityKey(
        ctx,
        {
          profile,
          ownerId: args.ownerId,
          authorityEpoch: operation.stripeCustomerAuthorityEpoch ?? 0,
          now: args.now,
        },
      );
      if (
        operation.stripeCustomerCreateIdempotencyKey !== pinnedCustomerKey ||
        operation.activeIdempotencyKey !== pinnedCustomerKey
      ) {
        return null;
      }
    }
    return { providerCallDeadlineAt: args.providerDeadlineAt };
  },
});

/**
 * Re-adopt only a customer locator already captured by the exact dispatcher.
 * No caller can publish a raw provider locator through this seam.
 */
export const adoptStripeOperationCustomerInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    stripeCustomerId: v.string(),
    now: v.number(),
  },
  returns: v.object({ adopted: v.boolean(), customerDeleted: v.boolean() }),
  handler: async (ctx, args) => {
    const stripeCustomerId = args.stripeCustomerId.trim();
    const operation = await readOperation(ctx, args.operationId);
    if (
      !stripeCustomerId ||
      !operation ||
      !(await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now, {
        strictTransport: true,
      })) ||
      operation.ownerId !== args.ownerId ||
      operation.ownerGeneration !== args.ownerGeneration ||
      operation.stripeCustomerId !== stripeCustomerId ||
      operation.dispatchState !== "idle" ||
      hasUnexpectedIdleDispatchFields(operation)
    ) {
      throw conflict(
        "Stripe customer adoption authority is missing or changed.",
      );
    }
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const status = await convergeStripeCustomerProfile(ctx, {
      ownerId: args.ownerId,
      stripeCustomerId,
      expectedCustomerAuthorityEpoch:
        operation.stripeCustomerAuthorityEpoch ?? 0,
      now: args.now,
    });
    return {
      adopted: status === "linked",
      customerDeleted:
        status === "deleted_customer" || status === "stale_authority",
    };
  },
});

/** Completion-only state transition after exact dispatcher settlement. */
export const completeStripeOperationInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      operation.ownerId !== args.ownerId ||
      operation.ownerGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    if (
      !(await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now, {
        strictTransport: true,
      }))
    ) {
      return false;
    }
    if (operation.state === "completed") return true;
    if (
      operation.state !== "provider_succeeded" ||
      operation.manualDebtReason !== undefined ||
      operation.dispatchState !== "idle" ||
      hasUnexpectedIdleDispatchFields(operation) ||
      !operation.stripeCustomerId ||
      (operation.kind === "billing_portal"
        ? !operation.stripePortalSessionId
        : !operation.stripeCheckoutSessionId)
    ) {
      return false;
    }
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      return false;
    }
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !profile ||
      (profile.stripeCustomerAuthorityEpoch ?? 0) !==
        (operation.stripeCustomerAuthorityEpoch ?? 0)
    ) {
      return false;
    }
    await ctx.db.patch(operation._id, {
      state: "completed",
      leaseExpiresAt: args.now,
      integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
      lifecycleIntegrityVersion: undefined,
      updatedAt: args.now,
    });
    return true;
  },
});

/**
 * Final exact authority fence for returning a Stripe-hosted URL to a user.
 * Provider settlement and local completion are not sufficient: reset,
 * deletion, migration, customer-authority rotation, or a late locator conflict
 * can occur while an action is suspended immediately before its response.
 */
export const authorizeStripeOperationResultReturnInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    stripeCustomerId: v.string(),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePortalSessionId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      !(await ensureCurrentStripeOperationIntegrity(
        ctx,
        operation,
        Date.now(),
        {
          strictTransport: true,
        },
      )) ||
      operation.ownerId !== args.ownerId ||
      operation.ownerGeneration !== args.ownerGeneration ||
      operation.state !== "completed" ||
      operation.stripeCustomerId !== args.stripeCustomerId.trim() ||
      operation.stripeCheckoutSessionId !==
        args.stripeCheckoutSessionId?.trim() ||
      operation.stripePortalSessionId !== args.stripePortalSessionId?.trim() ||
      operation.dispatchState !== "idle" ||
      hasUnexpectedIdleDispatchFields(operation)
    ) {
      return false;
    }
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      return false;
    }
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !profile ||
      (profile.stripeCustomerAuthorityEpoch ?? 0) !==
        (operation.stripeCustomerAuthorityEpoch ?? 0) ||
      profile.stripeCustomerId !== operation.stripeCustomerId ||
      (await isStripeCustomerTombstoned(ctx, operation.stripeCustomerId))
    ) {
      return false;
    }
    return true;
  },
});

const stripeDispatchTupleArgs = {
  ownerId: v.string(),
  ownerGeneration: v.string(),
  operationId: v.string(),
  attemptId: v.string(),
  step: stripeStepValidator,
  requestFingerprint: v.string(),
  idempotencyKey: v.string(),
  providerDeadlineAt: v.number(),
  reconcileClaimId: v.optional(v.string()),
  now: v.number(),
};

type LateStripeSuccessArgs = ExactDispatchTuple & {
  ownerId: string;
  ownerGeneration: string;
  stripeCustomerId?: string;
  stripeCheckoutSessionId?: string;
  stripePortalSessionId?: string;
  now: number;
};

type StripeLateResult = Doc<"billing_stripe_late_results">;

const lateResultLocatorEnvelope = (args: {
  stripeCustomerId?: string;
  stripeCheckoutSessionId?: string;
  stripePortalSessionId?: string;
}) => ({
  ...(args.stripeCustomerId?.trim()
    ? { stripeCustomerId: args.stripeCustomerId.trim() }
    : {}),
  ...(args.stripeCheckoutSessionId?.trim()
    ? { stripeCheckoutSessionId: args.stripeCheckoutSessionId.trim() }
    : {}),
  ...(args.stripePortalSessionId?.trim()
    ? { stripePortalSessionId: args.stripePortalSessionId.trim() }
    : {}),
});

const lateResultLocatorHash = async (args: {
  stripeCustomerId?: string;
  stripeCheckoutSessionId?: string;
  stripePortalSessionId?: string;
}): Promise<string> => await hashStripePhysicalSuccessLocators(args);

const bindStripePhysicalSuccessReceipt = async (
  ctx: MutationCtx,
  receipt: Doc<"billing_stripe_physical_receipts">,
  args: {
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
  },
): Promise<string> => {
  const successLocatorHash = await hashStripePhysicalSuccessLocators(args);
  if (
    receipt.successLocatorHash !== undefined &&
    receipt.successLocatorHash !== successLocatorHash
  ) {
    throw conflict("Stripe physical tuple returned different locators.");
  }
  if (
    receipt.successLocatorHash === undefined ||
    receipt.notCreatedTerminalized === true
  ) {
    await ctx.db.patch(receipt._id, {
      successLocatorHash,
      notCreatedTerminalized: undefined,
    });
  }
  return successLocatorHash;
};

const hasStripeCleanupProviderOwnerAuthority = async (args: {
  providerOwnerHash: string;
  providerOwnerId: string;
}): Promise<boolean> => {
  const providerOwnerHash = await ownershipMigrationSourceDigest(
    args.providerOwnerId,
  );
  return providerOwnerHash === args.providerOwnerHash;
};

const hasStripeCleanupOwnerAuthority = async (
  ctx: Pick<QueryCtx, "db">,
  args: {
    cleanupOwnerHash: string;
    providerOwnerHash: string;
    providerOwnerId: string;
    stripeCustomerId?: string;
  },
): Promise<boolean> => {
  if (!(await hasStripeCleanupProviderOwnerAuthority(args))) return false;

  const stripeCustomerId = args.stripeCustomerId?.trim();
  if (!stripeCustomerId) return false;
  const linkedProfiles = await ctx.db
    .query("billing_profiles")
    .withIndex("by_stripeCustomerId", (q) =>
      q.eq("stripeCustomerId", stripeCustomerId),
    )
    .take(65);
  if (linkedProfiles.length > 64) return false;
  for (const profile of linkedProfiles) {
    const linkedOwnerHash = await ownershipMigrationSourceDigest(
      profile.ownerId,
    );
    if (linkedOwnerHash !== args.cleanupOwnerHash) return false;
  }
  return true;
};

const lateResultDebtKey = (tupleHash: string, locatorHash: string): string =>
  `late:${tupleHash}:${locatorHash}`;

const lateResultMatches = (
  row: StripeLateResult,
  args: LateStripeSuccessArgs,
  locatorHash: string,
): boolean =>
  row.operationId === args.operationId &&
  row.locatorHash === locatorHash &&
  row.step === args.step &&
  row.attemptId === args.attemptId &&
  row.requestFingerprint === args.requestFingerprint &&
  row.idempotencyKey === args.idempotencyKey &&
  row.providerDeadlineAt === args.providerDeadlineAt &&
  row.stripeCustomerId === args.stripeCustomerId?.trim() &&
  row.stripeCheckoutSessionId === args.stripeCheckoutSessionId?.trim() &&
  row.stripePortalSessionId === args.stripePortalSessionId?.trim();

const hasAnyProjectedLateResult = (operation: StripeOperation): boolean =>
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

const hasCompleteProjectedLateResult = (operation: StripeOperation): boolean =>
  operation.lateResultConflictStep !== undefined &&
  operation.lateResultConflictAttemptId !== undefined &&
  operation.lateResultRequestFingerprint !== undefined &&
  operation.lateResultIdempotencyKey !== undefined &&
  operation.lateResultProviderDeadlineAt !== undefined &&
  operation.lateResultConflictAt !== undefined &&
  operation.lateResultConflictQuiescentAfterAt !== undefined;

/** Materialize the pre-ledger singleton late tuple during rolling upgrade. */
const ensureProjectedLateResultRow = async (
  ctx: MutationCtx,
  operation: StripeOperation,
  now: number,
): Promise<StripeLateResult | null> => {
  if (!hasAnyProjectedLateResult(operation)) return null;
  if (!hasCompleteProjectedLateResult(operation)) {
    throw conflict("Stripe late-result debt receipt is malformed.");
  }
  const tuple = {
    operationId: operation.operationId,
    attemptId: operation.lateResultConflictAttemptId!,
    step: operation.lateResultConflictStep!,
    requestFingerprint: operation.lateResultRequestFingerprint!,
    idempotencyKey: operation.lateResultIdempotencyKey!,
    providerDeadlineAt: operation.lateResultProviderDeadlineAt!,
    reconcileClaimId: operation.lateResultReconcileClaimId,
  };
  const tupleHash = await hashStripeDeletedOperationTuple(tuple);
  const locatorEnvelope = lateResultLocatorEnvelope({
    stripeCustomerId: operation.lateResultStripeCustomerId,
    stripeCheckoutSessionId: operation.lateResultStripeCheckoutSessionId,
    stripePortalSessionId: operation.lateResultStripePortalSessionId,
  });
  const locatorHash = await lateResultLocatorHash(locatorEnvelope);
  let receiptRows = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
    .take(2);
  if (
    receiptRows.length > 1 ||
    (receiptRows[0] && receiptRows[0].operationId !== operation.operationId)
  ) {
    throw conflict("Stripe projected late-result authority is duplicated.");
  }
  if (!receiptRows[0]) {
    if (
      !hasLegacyStripeOperationIntegrityVersion(operation) ||
      operation.manualDebtReason !== "late_result_conflict"
    ) {
      throw conflict("Stripe projected late-result authority is missing.");
    }
    // Only the enumerated pre-receipt integrity lineage may be grandfathered.
    // A current-version row without this immutable receipt is corruption, not
    // evidence that provider I/O crossed the boundary.
    await ensureStripePhysicalReceipt(ctx, tuple, now, operation.ownerId, true);
    receiptRows = await ctx.db
      .query("billing_stripe_physical_receipts")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
      .take(2);
  }
  if (
    receiptRows.length !== 1 ||
    !/^[a-f0-9]{64}$/u.test(receiptRows[0]!.providerOwnerHash ?? "") ||
    (receiptRows[0]!.successLocatorHash !== undefined &&
      receiptRows[0]!.successLocatorHash !== locatorHash)
  ) {
    throw conflict("Stripe projected late-result authority changed.");
  }
  if (receiptRows[0]!.successLocatorHash === undefined) {
    if (!hasLegacyStripeOperationIntegrityVersion(operation)) {
      throw conflict("Stripe projected late-result result proof is missing.");
    }
    await ctx.db.patch(receiptRows[0]!._id, {
      successLocatorHash: locatorHash,
      notCreatedTerminalized: undefined,
    });
  } else if (receiptRows[0]!.notCreatedTerminalized === true) {
    await ctx.db.patch(receiptRows[0]!._id, {
      notCreatedTerminalized: undefined,
    });
  }
  const existing = await ctx.db
    .query("billing_stripe_late_results")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
    .take(2);
  if (existing.length > 1) {
    throw conflict("Stripe late-result tuple is duplicated.");
  }
  if (existing[0]) {
    const expectedArgs: LateStripeSuccessArgs = {
      ownerId: operation.ownerId,
      ownerGeneration: operation.ownerGeneration,
      ...tuple,
      ...locatorEnvelope,
      now,
    };
    const existingProviderOwnerHash = existing[0].providerOwnerId
      ? await ownershipMigrationSourceDigest(existing[0].providerOwnerId)
      : undefined;
    if (
      !lateResultMatches(existing[0], expectedArgs, locatorHash) ||
      (existingProviderOwnerHash !== undefined &&
        existingProviderOwnerHash !== receiptRows[0]!.providerOwnerHash)
    ) {
      throw conflict("Stripe late-result tuple changed during backfill.");
    }
    return existing[0];
  }
  const currentOwnerHash = await ownershipMigrationSourceDigest(
    operation.ownerId,
  );
  const provenCurrentProviderOwner =
    receiptRows[0]!.providerOwnerHash === currentOwnerHash
      ? operation.ownerId
      : undefined;
  const rowId = await ctx.db.insert("billing_stripe_late_results", {
    ownerId: operation.ownerId,
    // Recover the provider owner only when the immutable receipt proves it is
    // the current owner. A migrated/source-bound hash remains absent and
    // therefore cleanup-only rather than asserting false destination scope.
    ...(provenCurrentProviderOwner
      ? { providerOwnerId: provenCurrentProviderOwner }
      : {}),
    operationId: operation.operationId,
    tupleHash,
    locatorHash,
    step: tuple.step,
    attemptId: tuple.attemptId,
    requestFingerprint: tuple.requestFingerprint,
    idempotencyKey: tuple.idempotencyKey,
    providerDeadlineAt: tuple.providerDeadlineAt,
    ...(tuple.reconcileClaimId
      ? { reconcileClaimId: tuple.reconcileClaimId }
      : {}),
    ...locatorEnvelope,
    quiescentAfterAt: operation.lateResultConflictQuiescentAfterAt!,
    createdAt: operation.lateResultConflictAt!,
    updatedAt: now,
  });
  return await ctx.db.get(rowId);
};

const ensureLateConflictStripeOperationIntegrity = async (
  ctx: MutationCtx,
  operation: StripeOperation,
  now: number,
): Promise<boolean> => {
  if (!hasValidStripeOperationStateLocators(operation)) return false;
  const valid = hasLegacyStripeOperationIntegrityVersion(operation)
    ? await ensureLegacyStripeOperationPhysicalReceiptProvenance(ctx, operation)
    : hasCurrentStripeOperationIntegrity(operation) &&
      (await hasOnlyProvenStripeOperationPhysicalReceipts(ctx, operation));
  if (!valid) return false;
  if (hasLegacyStripeOperationIntegrityVersion(operation)) {
    await ctx.db.patch(operation._id, {
      integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
      lifecycleIntegrityVersion: undefined,
      updatedAt: now,
    });
  }
  return true;
};

const hasValidStripeOperationLifecycleAuditShape = async (
  ctx: Pick<QueryCtx, "db">,
  operation: StripeOperation,
): Promise<boolean> => {
  if (!hasCurrentStripeOperationIntegrity(operation)) return false;
  if (!(await hasOnlyProvenStripeOperationPhysicalReceipts(ctx, operation))) {
    return false;
  }
  if (
    operation.terminalizedByManualResolutionId !== undefined &&
    !(await hasMatchingStripeManualResolutionProof(ctx, operation))
  ) {
    return false;
  }
  if (operation.dispatchState === "may_have_dispatched") {
    return (
      hasCompleteActiveDispatchFields(operation) &&
      (await hasMatchingStripePhysicalReceipt(ctx, {
        operationId: operation.operationId,
        attemptId: operation.activeAttemptId!,
        step: operation.activeStep!,
        requestFingerprint: operation.activeRequestFingerprint!,
        idempotencyKey: operation.activeIdempotencyKey!,
        providerDeadlineAt: operation.providerDeadlineAt!,
      }))
    );
  }
  if (stripeMetadataTransferShape(operation) === "active") {
    return await hasValidatedStripeMetadataTransferAuthority(ctx, operation);
  }
  if (operation.dispatchState !== "idle") return false;
  if (operation.manualDebtReason === "late_result_conflict") {
    if (!hasCompleteProjectedLateResult(operation)) return false;
    return await hasMatchingStripePhysicalReceipt(ctx, {
      operationId: operation.operationId,
      attemptId: operation.lateResultConflictAttemptId!,
      step: operation.lateResultConflictStep!,
      requestFingerprint: operation.lateResultRequestFingerprint!,
      idempotencyKey: operation.lateResultIdempotencyKey!,
      providerDeadlineAt: operation.lateResultProviderDeadlineAt!,
    });
  }
  if (!hasCleanIdleStripeOperationTransport(operation)) return false;
  const historicalShape = stripeHistoricalResultShape(operation);
  if (historicalShape === "malformed") return false;
  if (historicalShape === "complete") {
    return await hasMatchingStripePhysicalReceipt(ctx, {
      operationId: operation.operationId,
      attemptId: operation.lastStripeAttemptId!,
      step: operation.lastStripeStep!,
      requestFingerprint: operation.lastStripeRequestFingerprint!,
      idempotencyKey: operation.lastStripeIdempotencyKey!,
      providerDeadlineAt: operation.lastStripeProviderDeadlineAt!,
    });
  }
  return (
    operation.state === "reserved" ||
    operation.terminalizedForDeletionCleanup === true ||
    operation.terminalizedWithoutProviderDispatch === true ||
    (operation.terminalizedByManualResolutionId !== undefined &&
      (await hasMatchingStripeManualResolutionProof(ctx, operation)))
  );
};

const persistStripeLateResult = async (
  ctx: MutationCtx,
  operation: StripeOperation,
  args: LateStripeSuccessArgs,
  tupleHash: string,
): Promise<{
  recorded: boolean;
  resolved: boolean;
  row?: StripeLateResult;
}> => {
  const locatorHash = await lateResultLocatorHash(args);
  const debtKey = lateResultDebtKey(tupleHash, locatorHash);
  const priorResolution = await ctx.db
    .query("billing_stripe_operation_resolutions")
    .withIndex("by_operationId_and_debtKey", (q) =>
      q.eq("operationId", operation.operationId).eq("debtKey", debtKey),
    )
    .unique();
  if (priorResolution) {
    return { recorded: false, resolved: true };
  }
  const existing = await ctx.db
    .query("billing_stripe_late_results")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
    .take(2);
  if (existing.length > 1) {
    throw conflict("Stripe late-result tuple is duplicated.");
  }
  if (existing[0]) {
    if (
      !lateResultMatches(existing[0], args, locatorHash) ||
      (existing[0].providerOwnerId !== undefined &&
        existing[0].providerOwnerId !== args.ownerId)
    ) {
      throw conflict("Stripe late-result tuple returned different locators.");
    }
    return { recorded: false, resolved: false, row: existing[0] };
  }
  const sameActive = sameActivePhysicalTuple(operation, args);
  const quiescentAfterAt = Math.max(
    args.now,
    sameActive ? (operation.reconcileClaimExpiresAt ?? args.now) : args.now,
  );
  const rowId = await ctx.db.insert("billing_stripe_late_results", {
    ownerId: operation.ownerId,
    providerOwnerId: args.ownerId,
    operationId: operation.operationId,
    tupleHash,
    locatorHash,
    step: args.step,
    attemptId: args.attemptId,
    requestFingerprint: args.requestFingerprint,
    idempotencyKey: args.idempotencyKey,
    providerDeadlineAt: args.providerDeadlineAt,
    ...(args.reconcileClaimId
      ? { reconcileClaimId: args.reconcileClaimId }
      : {}),
    ...lateResultLocatorEnvelope(args),
    quiescentAfterAt,
    createdAt: args.now,
    updatedAt: args.now,
  });
  const hasProjection = hasAnyProjectedLateResult(operation);
  if (hasProjection && !hasCompleteProjectedLateResult(operation)) {
    throw conflict("Stripe late-result debt receipt is malformed.");
  }
  await ctx.db.patch(operation._id, {
    manualDebtReason: "late_result_conflict",
    ...(hasProjection
      ? {}
      : {
          lateResultConflictStep: args.step,
          lateResultConflictAttemptId: args.attemptId,
          lateResultRequestFingerprint: args.requestFingerprint,
          lateResultIdempotencyKey: args.idempotencyKey,
          lateResultProviderDeadlineAt: args.providerDeadlineAt,
          lateResultReconcileClaimId: args.reconcileClaimId,
          ...(args.stripeCustomerId
            ? { lateResultStripeCustomerId: args.stripeCustomerId.trim() }
            : {}),
          ...(args.stripeCheckoutSessionId
            ? {
                lateResultStripeCheckoutSessionId:
                  args.stripeCheckoutSessionId.trim(),
              }
            : {}),
          ...(args.stripePortalSessionId
            ? {
                lateResultStripePortalSessionId:
                  args.stripePortalSessionId.trim(),
              }
            : {}),
          lateResultConflictAt: args.now,
          lateResultConflictQuiescentAfterAt: quiescentAfterAt,
        }),
    updatedAt: args.now,
  });
  const row = await ctx.db.get(rowId);
  return row
    ? { recorded: true, resolved: false, row }
    : { recorded: true, resolved: false };
};

const hasMatchingLateStripeCleanupRetentionResolution = async (
  ctx: Pick<QueryCtx, "db">,
  receipt: Doc<"billing_stripe_physical_receipts">,
): Promise<boolean> => {
  const resolutionId = receipt.cleanupResolutionId?.trim();
  if (!resolutionId || receipt.deletionCleanupTerminalized === true) {
    return false;
  }
  const resolutions = await ctx.db
    .query("billing_stripe_late_cleanup_resolutions")
    .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
    .take(2);
  const retainedLocators = await ctx.db
    .query("billing_stripe_retained_locators")
    .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
    .take(3);
  const locatorSetHash = await hashStripeRetainedLocatorSet(retainedLocators);
  return (
    resolutions.length === 1 &&
    resolutions[0]!.tupleHash === receipt.tupleHash &&
    resolutions[0]!.successLocatorHash === receipt.successLocatorHash &&
    resolutions[0]!.resolution === "provider_resource_retained" &&
    resolutions[0]!.locatorCount === retainedLocators.length &&
    resolutions[0]!.locatorSetHash === locatorSetHash &&
    retainedLocators.length >= 1 &&
    retainedLocators.length <= 2 &&
    retainedLocators.every((locator) => locator.tupleHash === receipt.tupleHash)
  );
};

const readValidScopedStripeRetentionFence = async (
  ctx: Pick<QueryCtx, "db">,
  args: {
    ownerHash: string;
    locatorHash: string;
    locatorKind: "customer" | "checkout_session";
  },
): Promise<Doc<"billing_stripe_retained_locators"> | null> => {
  const retained = await ctx.db
    .query("billing_stripe_retained_locators")
    .withIndex("by_ownerHash_and_locatorHash", (q) =>
      q.eq("ownerHash", args.ownerHash).eq("locatorHash", args.locatorHash),
    )
    .first();
  if (!retained) return null;
  if (
    retained.locatorKind !== args.locatorKind ||
    !(await hasValidStripeRetainedLocatorProof(ctx, retained))
  ) {
    throw conflict("Stripe retained locator audit is missing or changed.");
  }
  return retained;
};

const inheritLateStripeCleanupRetention = async (
  ctx: MutationCtx,
  args: {
    receipt: Doc<"billing_stripe_physical_receipts">;
    ownerHash: string;
    retained: ReadonlyArray<{
      locatorHash: string;
      locatorKind: "customer" | "checkout_session";
    }>;
    now: number;
  },
): Promise<string> => {
  const uniqueRetained = [
    ...new Map(args.retained.map((row) => [row.locatorHash, row])).values(),
  ];
  if (uniqueRetained.length === 0 || uniqueRetained.length > 2) {
    throw conflict("Stripe inherited cleanup retention set is invalid.");
  }
  const resolutionId = `retained-fence-${args.receipt.tupleHash}`;
  const currentReceipt = await ctx.db.get(args.receipt._id);
  if (!currentReceipt) {
    throw conflict("Stripe cleanup physical receipt is missing or changed.");
  }
  const existingResolutionId = currentReceipt.cleanupResolutionId;
  if (
    existingResolutionId !== undefined &&
    !(await hasMatchingLateStripeCleanupRetentionResolution(
      ctx,
      currentReceipt,
    ))
  ) {
    throw conflict("Stripe cleanup retention audit is missing or changed.");
  }
  const existingLocators = existingResolutionId
    ? await ctx.db
        .query("billing_stripe_retained_locators")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", existingResolutionId),
        )
        .take(3)
    : [];
  if (
    existingResolutionId !== undefined &&
    existingResolutionId !== resolutionId
  ) {
    if (
      uniqueRetained.every((incoming) =>
        existingLocators.some(
          (existing) =>
            existing.locatorHash === incoming.locatorHash &&
            existing.locatorKind === incoming.locatorKind &&
            existing.ownerHash === args.ownerHash,
        ),
      )
    ) {
      return existingResolutionId;
    }
    throw conflict("Stripe cleanup retention disposition changed.");
  }
  const mergedByHash = new Map(
    existingLocators.map((row) => [
      row.locatorHash,
      { locatorKind: row.locatorKind, locatorHash: row.locatorHash },
    ]),
  );
  for (const row of uniqueRetained) {
    const existing = mergedByHash.get(row.locatorHash);
    if (existing && existing.locatorKind !== row.locatorKind) {
      throw conflict("Stripe inherited cleanup locator kind changed.");
    }
    mergedByHash.set(row.locatorHash, row);
  }
  const merged = [...mergedByHash.values()];
  if (merged.length === 0 || merged.length > 2) {
    throw conflict("Stripe inherited cleanup retention set is invalid.");
  }
  const retainedLocators = merged.map((row) => ({
    locatorKind: row.locatorKind,
    locatorHash: row.locatorHash,
    ownerHash: args.ownerHash,
  }));
  const locatorSetHash = await hashStripeRetainedLocatorSet(retainedLocators);
  const [resolvedByHash, evidenceHash] = await Promise.all([
    stripeResolutionAuditHash("operator", "system-retained-locator-fence"),
    stripeResolutionAuditHash(
      "evidence",
      `inherited-locator-set:${locatorSetHash}`,
    ),
  ]);
  const existingResolution = existingResolutionId
    ? await ctx.db
        .query("billing_stripe_late_cleanup_resolutions")
        .withIndex("by_resolutionId", (q) =>
          q.eq("resolutionId", existingResolutionId),
        )
        .unique()
    : null;
  if (existingResolution) {
    await ctx.db.patch(existingResolution._id, {
      locatorCount: retainedLocators.length,
      locatorSetHash,
      evidenceHash,
    });
  } else {
    await ctx.db.insert("billing_stripe_late_cleanup_resolutions", {
      tupleHash: currentReceipt.tupleHash,
      successLocatorHash: currentReceipt.successLocatorHash!,
      resolutionId,
      resolution: "provider_resource_retained",
      locatorCount: retainedLocators.length,
      locatorSetHash,
      resolvedByHash,
      evidenceHash,
      resolvedAt: args.now,
    });
  }
  for (const locator of retainedLocators.filter(
    (candidate) =>
      !existingLocators.some(
        (existing) => existing.locatorHash === candidate.locatorHash,
      ),
  )) {
    await ctx.db.insert("billing_stripe_retained_locators", {
      tupleHash: currentReceipt.tupleHash,
      locatorHash: locator.locatorHash,
      ownerHash: locator.ownerHash,
      locatorKind: locator.locatorKind,
      resolutionId,
      createdAt: args.now,
    });
  }
  if (existingResolutionId === undefined) {
    await ctx.db.patch(currentReceipt._id, {
      cleanupResolutionId: resolutionId,
    });
  }
  return resolutionId;
};

const enqueueLateStripeCleanupLocators = async (
  ctx: MutationCtx,
  args: LateStripeSuccessArgs & {
    tupleHash: string;
    ownerHash?: string;
    providerOwnerId?: string;
    deleteStripeCustomerId?: string | null;
    deleteStripeCheckoutSessionId?: string | null;
  },
): Promise<boolean> => {
  const ownerHash =
    args.ownerHash ?? (await ownershipMigrationSourceDigest(args.ownerId));
  const providerOwnerHash = await ownershipMigrationSourceDigest(
    args.providerOwnerId ?? args.ownerId,
  );
  const successLocatorHash = await hashStripePhysicalSuccessLocators(args);
  const receiptRows = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", args.tupleHash))
    .take(2);
  if (
    receiptRows.length !== 1 ||
    receiptRows[0]!.operationId !== args.operationId ||
    receiptRows[0]!.providerOwnerHash !== providerOwnerHash ||
    receiptRows[0]!.successLocatorHash !== successLocatorHash
  ) {
    throw conflict(
      "Stripe cleanup physical result proof is missing or changed.",
    );
  }
  if (receiptRows[0]!.deletionCleanupTerminalized === true) return false;
  if (receiptRows[0]!.cleanupResolutionId !== undefined) {
    if (
      !(await hasMatchingLateStripeCleanupRetentionResolution(
        ctx,
        receiptRows[0]!,
      ))
    ) {
      throw conflict("Stripe cleanup retention audit is missing or changed.");
    }
    return false;
  }
  const successStripeCustomerId = args.stripeCustomerId?.trim();
  const successStripeCheckoutSessionId = args.stripeCheckoutSessionId?.trim();
  const successStripePortalSessionId = args.stripePortalSessionId?.trim();
  if (!successStripeCustomerId) {
    throw conflict("Stripe cleanup success envelope has no customer.");
  }
  const customerLocatorHash = await hashStripeBillingLocator(
    "customer",
    successStripeCustomerId,
  );
  let inserted = false;
  let sawCleanupLocator = false;
  const inheritedRetainedLocators: Array<{
    locatorHash: string;
    locatorKind: "customer" | "checkout_session";
  }> = [];
  for (const [locatorKind, rawValue] of [
    [
      "checkout_session",
      "deleteStripeCheckoutSessionId" in args
        ? args.deleteStripeCheckoutSessionId
        : args.stripeCheckoutSessionId,
    ],
    [
      "customer",
      "deleteStripeCustomerId" in args
        ? args.deleteStripeCustomerId
        : args.stripeCustomerId,
    ],
  ] as const) {
    const locatorValue = rawValue?.trim();
    if (!locatorValue) continue;
    sawCleanupLocator = true;
    const locatorHash = await hashStripeBillingLocator(
      locatorKind,
      locatorValue,
    );
    const terminal = await ctx.db
      .query("billing_stripe_deletion_tombstones")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
      .unique();
    if (terminal) {
      if (terminal.locatorKind !== locatorKind) {
        throw conflict("Stripe cleanup deletion tombstone kind changed.");
      }
      continue;
    }
    const retained = await readValidScopedStripeRetentionFence(ctx, {
      ownerHash,
      locatorHash,
      locatorKind,
    });
    if (retained) {
      inheritedRetainedLocators.push({
        locatorHash,
        locatorKind,
      });
      continue;
    }
    const pending = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash_and_locatorHash", (q) =>
        q.eq("tupleHash", args.tupleHash).eq("locatorHash", locatorHash),
      )
      .unique();
    if (pending) continue;
    await ctx.db.insert("billing_stripe_late_cleanup_locators", {
      tupleHash: args.tupleHash,
      ownerHash,
      providerOwnerHash,
      successLocatorHash,
      locatorHash,
      locatorKind,
      locatorValue,
      successStripeCustomerId,
      ...(successStripeCheckoutSessionId
        ? { successStripeCheckoutSessionId }
        : {}),
      ...(successStripePortalSessionId ? { successStripePortalSessionId } : {}),
      ...(locatorKind === "checkout_session" ? { customerLocatorHash } : {}),
      ...(locatorKind === "customer"
        ? {
            checkoutBlocked: Boolean(
              await ctx.db
                .query("billing_stripe_late_cleanup_locators")
                .withIndex("by_customerLocatorHash", (q) =>
                  q.eq("customerLocatorHash", locatorHash),
                )
                .first(),
            ),
          }
        : {}),
      attempts: 0,
      nextAttemptAt: args.now,
      createdAt: args.now,
      updatedAt: args.now,
    });
    inserted = true;
  }
  const inheritedResolutionId =
    inheritedRetainedLocators.length > 0
      ? await inheritLateStripeCleanupRetention(ctx, {
          receipt: receiptRows[0]!,
          ownerHash,
          retained: inheritedRetainedLocators,
          now: args.now,
        })
      : undefined;
  if (sawCleanupLocator && !inserted) {
    const remainingTupleLocator = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", args.tupleHash))
      .first();
    if (!remainingTupleLocator) {
      await finalizeLateStripeCleanupTuple(
        ctx,
        receiptRows[0]!,
        args.now,
        inheritedResolutionId
          ? { kind: "retained", resolutionId: inheritedResolutionId }
          : { kind: "deleted" },
      );
    }
  }
  if (inserted) {
    await ctx.scheduler.runAfter(0, drainLateStripeCleanupRef, {});
  }
  return inserted;
};

const captureDeletedOperationLateSuccess = async (
  ctx: MutationCtx,
  args: LateStripeSuccessArgs,
): Promise<
  | { recorded: true; duplicate: false; customerDeleted: boolean }
  | { recorded: false; duplicate: true; customerDeleted: boolean }
> => {
  const tombstones = await ctx.db
    .query("billing_stripe_operation_tombstones")
    .withIndex("by_operationId", (q) => q.eq("operationId", args.operationId))
    .take(2);
  if (tombstones.length !== 1) {
    throw conflict("Stripe operation receipt is missing or changed.");
  }
  const tupleHash = await hashStripeDeletedOperationTuple(args);
  const physicalReceipts = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
    .take(2);
  if (
    physicalReceipts.length !== 1 ||
    physicalReceipts[0]!.operationId !== args.operationId
  ) {
    throw conflict("Deleted Stripe physical tuple changed.");
  }
  if (
    !(await hasStripeCleanupOwnerAuthority(ctx, {
      cleanupOwnerHash: tombstones[0]!.ownerHash,
      providerOwnerHash: physicalReceipts[0]!.providerOwnerHash ?? "",
      providerOwnerId: args.ownerId,
      stripeCustomerId: args.stripeCustomerId,
    }))
  ) {
    throw conflict("Deleted Stripe result has no cleanup owner authority.");
  }
  await bindStripePhysicalSuccessReceipt(ctx, physicalReceipts[0]!, args);
  const inserted = await enqueueLateStripeCleanupLocators(ctx, {
    ...args,
    tupleHash,
    ownerHash: tombstones[0]!.ownerHash,
  });
  const result = {
    recorded: inserted,
    duplicate: !inserted,
    // The account/customer authority is permanently closed. Returning true
    // forces every suspended user action to abort before any hosted URL can be
    // delivered while the autonomous cleanup drains the raw locator.
    customerDeleted: true,
  };
  return inserted
    ? { ...result, recorded: true as const, duplicate: false as const }
    : { ...result, recorded: false as const, duplicate: true as const };
};

export const settleStripeOperationDispatchInternal = internalMutation({
  args: {
    ...stripeDispatchTupleArgs,
    stripeCustomerId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePortalSessionId: v.optional(v.string()),
  },
  returns: settleResultValidator,
  handler: async (ctx, args) => {
    const operation = await readOperation(ctx, args.operationId);
    const stripeCustomerId = args.stripeCustomerId?.trim();
    const stripeCheckoutSessionId = args.stripeCheckoutSessionId?.trim();
    const stripePortalSessionId = args.stripePortalSessionId?.trim();
    if (args.step === "customer_create" && !stripeCustomerId) {
      throw conflict("Stripe customer create did not return a locator.");
    }
    if (
      args.step === "customer_create" &&
      (stripeCheckoutSessionId || stripePortalSessionId)
    ) {
      throw conflict(
        "Stripe customer create returned step-incompatible locators.",
      );
    }
    if (
      args.step === "checkout_create" &&
      (!stripeCustomerId || !stripeCheckoutSessionId)
    ) {
      throw conflict("Stripe checkout create did not return exact locators.");
    }
    if (args.step === "checkout_create" && stripePortalSessionId) {
      throw conflict("Stripe checkout create returned a portal locator.");
    }
    if (
      args.step === "portal_create" &&
      (!stripeCustomerId || !stripePortalSessionId)
    ) {
      throw conflict("Stripe portal create did not return exact locators.");
    }
    if (args.step === "portal_create" && stripeCheckoutSessionId) {
      throw conflict("Stripe portal create returned a Checkout locator.");
    }
    if (!operation) {
      return await captureDeletedOperationLateSuccess(ctx, args);
    }
    // A rolling-upgrade singleton is first promoted to the append-only ledger.
    // This makes every older physical result independently resolvable before a
    // newer attempt is allowed to settle.
    if (operation.manualDebtReason === "late_result_conflict") {
      await ensureProjectedLateResultRow(ctx, operation, args.now);
    }
    if (
      operation.manualDebtReason === "late_result_conflict"
        ? !(await ensureLateConflictStripeOperationIntegrity(
            ctx,
            operation,
            args.now,
          ))
        : !(await ensureCurrentStripeOperationIntegrity(
            ctx,
            operation,
            args.now,
          ))
    ) {
      throw conflict("Stripe operation integrity requires reconciliation.");
    }
    const sameLastPhysical = sameLastPhysicalTuple(operation, args);
    const samePhysical = sameActivePhysicalTuple(operation, args);
    const tupleHash = await hashStripeDeletedOperationTuple(args);
    const physicalReceipts = await ctx.db
      .query("billing_stripe_physical_receipts")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
      .take(2);
    if (
      physicalReceipts.length > 1 ||
      (physicalReceipts[0] &&
        physicalReceipts[0].operationId !== operation.operationId)
    ) {
      throw conflict("Stripe physical receipt authority is duplicated.");
    }
    const physicalAuthorized =
      physicalReceipts.length === 1 &&
      physicalReceipts[0]!.operationId === operation.operationId;
    if (!physicalAuthorized) {
      throw conflict("Stripe physical receipt authority is missing.");
    }
    if (
      !(await hasStripeCleanupProviderOwnerAuthority({
        providerOwnerHash: physicalReceipts[0]!.providerOwnerHash ?? "",
        providerOwnerId: args.ownerId,
      }))
    ) {
      throw conflict("Stripe physical receipt provider owner changed.");
    }
    await bindStripePhysicalSuccessReceipt(ctx, physicalReceipts[0]!, args);
    if (
      (operation.ownerId !== args.ownerId ||
        operation.ownerGeneration !== args.ownerGeneration) &&
      !physicalAuthorized
    ) {
      throw conflict("Stripe operation receipt is missing or changed.");
    }
    const lifecycle = await ctx.db
      .query("cloud_owner_lifecycles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", operation.ownerId))
      .unique();
    const enqueueForDeletingOwner = async (): Promise<{
      deleting: boolean;
      authorized: boolean;
      inserted: boolean;
    }> => {
      if (lifecycle?.state !== "deleting") {
        return { deleting: false, authorized: false, inserted: false };
      }
      const ownerHash = await ownershipMigrationSourceDigest(operation.ownerId);
      const authorized = await hasStripeCleanupOwnerAuthority(ctx, {
        cleanupOwnerHash: ownerHash,
        providerOwnerHash: physicalReceipts[0]!.providerOwnerHash ?? "",
        providerOwnerId: args.ownerId,
        stripeCustomerId,
      });
      if (!authorized) {
        return { deleting: true, authorized: false, inserted: false };
      }
      const inserted = await enqueueLateStripeCleanupLocators(ctx, {
        ...args,
        tupleHash,
        ownerHash,
      });
      return { deleting: true, authorized: true, inserted };
    };
    const locatorCompatible = locatorsAreCompatible(operation, args);
    const historicalPhysical =
      physicalAuthorized && !sameLastPhysical && !samePhysical;
    const canonicalActiveAuthorized =
      samePhysical && hasCompleteActiveDispatchFields(operation);
    const lateConflict =
      historicalPhysical ||
      (sameLastPhysical &&
        (operation.lastStripeDisposition !== "succeeded" ||
          !locatorCompatible)) ||
      (samePhysical && (!locatorCompatible || !canonicalActiveAuthorized));
    if (lateConflict) {
      const customerDeleted = stripeCustomerId
        ? await isStripeCustomerTombstoned(ctx, stripeCustomerId)
        : false;
      const lateResult = await persistStripeLateResult(
        ctx,
        operation,
        args,
        tupleHash,
      );
      if (samePhysical) {
        // The exact active provider call returned a definitive locator. Even
        // when that locator conflicts with prior canonical state, its own
        // active slot is finished and the append-only row now owns the debt.
        // Any already-live foreign reconciler is revoked locally; the row's
        // immutable hard-quiescence boundary still prevents premature manual
        // resolution, and a later callback is independently authenticated.
        await ctx.db.patch(operation._id, {
          dispatchState: "idle",
          activeStep: undefined,
          activeAttemptId: undefined,
          activeRequestJson: undefined,
          activeRequestFingerprint: undefined,
          activeIdempotencyKey: undefined,
          providerDeadlineAt: undefined,
          quiescentAfterAt: undefined,
          nextReconcileAt: undefined,
          reconcileClaimId: undefined,
          reconcileClaimExpiresAt: undefined,
          lastStripeStep: args.step,
          lastStripeAttemptId: args.attemptId,
          lastStripeRequestFingerprint: args.requestFingerprint,
          lastStripeIdempotencyKey: args.idempotencyKey,
          lastStripeProviderDeadlineAt: args.providerDeadlineAt,
          lastStripeReconcileClaimId: args.reconcileClaimId,
          lastStripeDisposition: "succeeded",
          leaseExpiresAt: args.now,
          updatedAt: args.now,
        });
      }
      const deletionEnqueue = await enqueueForDeletingOwner();
      if (deletionEnqueue.deleting) {
        const recorded = lateResult.recorded || deletionEnqueue.inserted;
        return {
          recorded,
          duplicate: !recorded,
          customerDeleted: true,
        } as
          | { recorded: true; duplicate: false; customerDeleted: true }
          | { recorded: false; duplicate: true; customerDeleted: true };
      }
      return {
        recorded: lateResult.recorded as true | false,
        duplicate: !lateResult.recorded as true | false,
        customerDeleted,
      } as
        | { recorded: true; duplicate: false; customerDeleted: boolean }
        | { recorded: false; duplicate: true; customerDeleted: boolean };
    }
    if (sameLastPhysical) {
      const customerTombstoned = stripeCustomerId
        ? await isStripeCustomerTombstoned(ctx, stripeCustomerId)
        : false;
      const deletionEnqueue = await enqueueForDeletingOwner();
      if (deletionEnqueue.deleting && !deletionEnqueue.authorized) {
        const lateResult = await persistStripeLateResult(
          ctx,
          operation,
          args,
          tupleHash,
        );
        return {
          recorded: lateResult.recorded as true | false,
          duplicate: !lateResult.recorded as true | false,
          customerDeleted: true,
        } as
          | { recorded: true; duplicate: false; customerDeleted: true }
          | { recorded: false; duplicate: true; customerDeleted: true };
      }
      return {
        recorded: false as const,
        duplicate: true as const,
        customerDeleted: customerTombstoned || deletionEnqueue.deleting,
      };
    }
    if (!samePhysical || !locatorCompatible) {
      throw conflict("Stripe dispatch receipt tuple changed.");
    }
    const activeDeletionEnqueue = await enqueueForDeletingOwner();
    if (activeDeletionEnqueue.deleting) {
      if (!activeDeletionEnqueue.authorized) {
        const lateResult = await persistStripeLateResult(
          ctx,
          operation,
          args,
          tupleHash,
        );
        await ctx.db.patch(operation._id, {
          dispatchState: "idle",
          activeStep: undefined,
          activeAttemptId: undefined,
          activeRequestJson: undefined,
          activeRequestFingerprint: undefined,
          activeIdempotencyKey: undefined,
          providerDeadlineAt: undefined,
          quiescentAfterAt: undefined,
          nextReconcileAt: undefined,
          reconcileClaimId: undefined,
          reconcileClaimExpiresAt: undefined,
          lastStripeStep: args.step,
          lastStripeAttemptId: args.attemptId,
          lastStripeRequestFingerprint: args.requestFingerprint,
          lastStripeIdempotencyKey: args.idempotencyKey,
          lastStripeProviderDeadlineAt: args.providerDeadlineAt,
          lastStripeReconcileClaimId: args.reconcileClaimId,
          lastStripeDisposition: "succeeded",
          lifecycleIntegrityVersion: undefined,
          leaseExpiresAt: args.now,
          updatedAt: args.now,
        });
        return {
          recorded: lateResult.recorded as true | false,
          duplicate: !lateResult.recorded as true | false,
          customerDeleted: true,
        } as
          | { recorded: true; duplicate: false; customerDeleted: true }
          | { recorded: false; duplicate: true; customerDeleted: true };
      }
      // Once permanent deletion owns the account, the exact physical receipt
      // is cleanup authority only. Do not attempt to relink the provider
      // result into a profile (or manufacture operator debt when another
      // profile currently names the returned customer): the hash-minimized
      // global cleanup ledger must survive operation/profile deletion.
      await ctx.db.patch(operation._id, {
        state: "provider_succeeded",
        dispatchState: "idle",
        activeStep: undefined,
        activeAttemptId: undefined,
        activeRequestJson: undefined,
        activeRequestFingerprint: undefined,
        activeIdempotencyKey: undefined,
        providerDeadlineAt: undefined,
        quiescentAfterAt: undefined,
        nextReconcileAt: undefined,
        reconcileClaimId: undefined,
        reconcileClaimExpiresAt: undefined,
        manualDebtReason:
          operation.manualDebtReason === "late_result_conflict"
            ? "late_result_conflict"
            : undefined,
        lastStripeStep: args.step,
        lastStripeAttemptId: args.attemptId,
        lastStripeRequestFingerprint: args.requestFingerprint,
        lastStripeIdempotencyKey: args.idempotencyKey,
        lastStripeProviderDeadlineAt: args.providerDeadlineAt,
        lastStripeReconcileClaimId: args.reconcileClaimId,
        lastStripeDisposition: "succeeded",
        ...(stripeCustomerId
          ? {
              stripeCustomerId,
              stripeCustomerMetadataOwnerId: operation.ownerId,
            }
          : {}),
        ...(stripeCheckoutSessionId ? { stripeCheckoutSessionId } : {}),
        ...(stripePortalSessionId ? { stripePortalSessionId } : {}),
        integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
        lifecycleIntegrityVersion: undefined,
        terminalizedByManualResolutionId: undefined,
        terminalizedForDeletionCleanup: true,
        leaseExpiresAt: args.now,
        updatedAt: args.now,
      });
      return {
        recorded: activeDeletionEnqueue.inserted,
        duplicate: !activeDeletionEnqueue.inserted,
        customerDeleted: true,
      } as
        | { recorded: true; duplicate: false; customerDeleted: true }
        | { recorded: false; duplicate: true; customerDeleted: true };
    }
    const customerConvergence = stripeCustomerId
      ? await convergeStripeCustomerProfile(ctx, {
          ownerId: operation.ownerId,
          stripeCustomerId,
          expectedCustomerAuthorityEpoch:
            operation.stripeCustomerAuthorityEpoch ?? 0,
          now: args.now,
        })
      : undefined;
    const customerDeleted =
      customerConvergence === "deleted_customer" ||
      customerConvergence === "stale_authority";
    if (
      customerConvergence === "conflicting_customer" ||
      customerConvergence === "foreign_customer"
    ) {
      const conflictDeletionEnqueue = await enqueueForDeletingOwner();
      if (conflictDeletionEnqueue.deleting) {
        await ctx.db.patch(operation._id, {
          state: "provider_succeeded",
          dispatchState: "idle",
          activeStep: undefined,
          activeAttemptId: undefined,
          activeRequestJson: undefined,
          activeRequestFingerprint: undefined,
          activeIdempotencyKey: undefined,
          providerDeadlineAt: undefined,
          quiescentAfterAt: undefined,
          nextReconcileAt: undefined,
          reconcileClaimId: undefined,
          reconcileClaimExpiresAt: undefined,
          manualDebtReason:
            operation.manualDebtReason === "late_result_conflict"
              ? "late_result_conflict"
              : undefined,
          lastStripeStep: args.step,
          lastStripeAttemptId: args.attemptId,
          lastStripeRequestFingerprint: args.requestFingerprint,
          lastStripeIdempotencyKey: args.idempotencyKey,
          lastStripeProviderDeadlineAt: args.providerDeadlineAt,
          lastStripeReconcileClaimId: args.reconcileClaimId,
          lastStripeDisposition: "succeeded",
          integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
          lifecycleIntegrityVersion: undefined,
          terminalizedByManualResolutionId: undefined,
          terminalizedForDeletionCleanup: true,
          leaseExpiresAt: args.now,
          updatedAt: args.now,
        });
        return {
          recorded: conflictDeletionEnqueue.inserted,
          duplicate: !conflictDeletionEnqueue.inserted,
          customerDeleted: true,
        } as
          | { recorded: true; duplicate: false; customerDeleted: true }
          | { recorded: false; duplicate: true; customerDeleted: true };
      }
      // The provider returned a raw customer locator that cannot become this
      // owner's canonical profile. Persist it under the exact physical tuple
      // before clearing the active slot; otherwise the losing concurrent
      // customer-create response would be permanently orphaned.
      const lateResult = await persistStripeLateResult(
        ctx,
        operation,
        args,
        tupleHash,
      );
      await ctx.db.patch(operation._id, {
        dispatchState: "idle",
        activeStep: undefined,
        activeAttemptId: undefined,
        activeRequestJson: undefined,
        activeRequestFingerprint: undefined,
        activeIdempotencyKey: undefined,
        providerDeadlineAt: undefined,
        quiescentAfterAt: undefined,
        nextReconcileAt: undefined,
        reconcileClaimId: undefined,
        reconcileClaimExpiresAt: undefined,
        lastStripeStep: args.step,
        lastStripeAttemptId: args.attemptId,
        lastStripeRequestFingerprint: args.requestFingerprint,
        lastStripeIdempotencyKey: args.idempotencyKey,
        lastStripeProviderDeadlineAt: args.providerDeadlineAt,
        lastStripeReconcileClaimId: args.reconcileClaimId,
        lastStripeDisposition: "succeeded",
        integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
        lifecycleIntegrityVersion: undefined,
        terminalizedByManualResolutionId: undefined,
        leaseExpiresAt: args.now,
        updatedAt: args.now,
      });
      return {
        recorded: lateResult.recorded as true | false,
        duplicate: !lateResult.recorded as true | false,
        customerDeleted: false,
      } as
        | { recorded: true; duplicate: false; customerDeleted: false }
        | { recorded: false; duplicate: true; customerDeleted: false };
    }
    await ctx.db.patch(operation._id, {
      dispatchState: "idle",
      activeStep: undefined,
      activeAttemptId: undefined,
      activeRequestJson: undefined,
      activeRequestFingerprint: undefined,
      activeIdempotencyKey: undefined,
      providerDeadlineAt: undefined,
      quiescentAfterAt: undefined,
      nextReconcileAt: undefined,
      reconcileClaimId: undefined,
      reconcileClaimExpiresAt: undefined,
      // A canonical active attempt may finish while older physical results
      // remain independently pending in the append-only late-result ledger.
      // Completing this attempt must not erase those debts.
      manualDebtReason:
        operation.manualDebtReason === "late_result_conflict"
          ? "late_result_conflict"
          : undefined,
      lastStripeStep: args.step,
      lastStripeAttemptId: args.attemptId,
      lastStripeRequestFingerprint: args.requestFingerprint,
      lastStripeIdempotencyKey: args.idempotencyKey,
      lastStripeProviderDeadlineAt: args.providerDeadlineAt,
      lastStripeReconcileClaimId: args.reconcileClaimId,
      lastStripeDisposition: "succeeded",
      integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
      lifecycleIntegrityVersion: undefined,
      terminalizedByManualResolutionId: undefined,
      ...(stripeCustomerId && !customerDeleted
        ? { stripeCustomerMetadataOwnerId: operation.ownerId }
        : {}),
      ...(stripeCustomerId ? { stripeCustomerId } : {}),
      ...(stripeCheckoutSessionId ? { stripeCheckoutSessionId } : {}),
      ...(stripePortalSessionId ? { stripePortalSessionId } : {}),
      state:
        args.step === "customer_create" ? "reserved" : "provider_succeeded",
      leaseExpiresAt: args.now,
      updatedAt: args.now,
    });
    await enqueueForDeletingOwner();
    return {
      recorded: true as const,
      duplicate: false as const,
      customerDeleted,
    };
  },
});

export const settleStripeOperationNotCreatedInternal = internalMutation({
  args: stripeDispatchTupleArgs,
  returns: settleResultValidator,
  handler: async (ctx, args) => {
    const operation = await readOperation(ctx, args.operationId);
    if (!operation) {
      throw conflict("Stripe operation receipt is missing or changed.");
    }
    if (operation.manualDebtReason === "late_result_conflict") {
      await ensureProjectedLateResultRow(ctx, operation, args.now);
    }
    if (
      operation.manualDebtReason === "late_result_conflict"
        ? !(await ensureLateConflictStripeOperationIntegrity(
            ctx,
            operation,
            args.now,
          ))
        : !(await ensureCurrentStripeOperationIntegrity(
            ctx,
            operation,
            args.now,
          ))
    ) {
      throw conflict("Stripe operation integrity requires reconciliation.");
    }
    const sameActive = sameActivePhysicalTuple(operation, args);
    const sameLast = sameLastPhysicalTuple(operation, args);
    const tupleHash = await hashStripeDeletedOperationTuple(args);
    const physicalReceipts = await ctx.db
      .query("billing_stripe_physical_receipts")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
      .take(2);
    if (
      physicalReceipts.length > 1 ||
      (physicalReceipts[0] &&
        physicalReceipts[0].operationId !== operation.operationId)
    ) {
      throw conflict("Stripe physical receipt authority is duplicated.");
    }
    const physicalAuthorized =
      physicalReceipts.length === 1 &&
      physicalReceipts[0]!.operationId === operation.operationId;
    if (!physicalAuthorized) {
      throw conflict("Stripe physical receipt authority is missing.");
    }
    if (
      !(await hasStripeCleanupProviderOwnerAuthority({
        providerOwnerHash: physicalReceipts[0]!.providerOwnerHash ?? "",
        providerOwnerId: args.ownerId,
      }))
    ) {
      throw conflict("Stripe physical receipt provider owner changed.");
    }
    if (
      (operation.ownerId !== args.ownerId ||
        operation.ownerGeneration !== args.ownerGeneration) &&
      !physicalAuthorized
    ) {
      throw conflict("Stripe operation receipt is missing or changed.");
    }
    if (operation.manualDebtReason === "late_result_conflict") {
      const lateRows = await ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
        .take(2);
      if (lateRows.length > 1) {
        throw conflict("Stripe late-result tuple is duplicated.");
      }
      // A result already observed as provider success wins over a stale
      // reconciler's not-created disposition. Only that reconciler's claim is
      // cleared; the independent success debt and raw locators remain intact.
      if (lateRows[0]) {
        if (
          lateRows[0].operationId !== operation.operationId ||
          lateRows[0].attemptId !== args.attemptId ||
          lateRows[0].step !== args.step ||
          lateRows[0].requestFingerprint !== args.requestFingerprint ||
          lateRows[0].idempotencyKey !== args.idempotencyKey ||
          lateRows[0].providerDeadlineAt !== args.providerDeadlineAt
        ) {
          throw conflict(
            "Stripe late-result debt received a foreign disposition.",
          );
        }
        if (
          operation.reconcileClaimId !== undefined &&
          operation.reconcileClaimId === args.reconcileClaimId
        ) {
          await ctx.db.patch(operation._id, {
            reconcileClaimId: undefined,
            reconcileClaimExpiresAt: undefined,
            updatedAt: args.now,
          });
        }
        return {
          recorded: false as const,
          duplicate: true as const,
          customerDeleted: false,
        };
      }
      // A different currently-active attempt may settle not-created while
      // older successes await operator resolution.
      if (!sameActive && !sameLast) {
        throw conflict(
          "Stripe late-result debt received a foreign disposition.",
        );
      }
    }
    if (sameLast) {
      if (operation.lastStripeDisposition !== "not_created") {
        throw conflict("Stripe step disposition changed during replay.");
      }
      return {
        recorded: false as const,
        duplicate: true as const,
        customerDeleted: false,
      };
    }
    if (
      !sameActive ||
      !physicalAuthorized ||
      !hasCompleteActiveDispatchFields(operation)
    ) {
      throw conflict("Stripe dispatch receipt tuple changed.");
    }
    await ctx.db.patch(physicalReceipts[0]!._id, {
      notCreatedTerminalized: true,
    });
    await ctx.db.patch(operation._id, {
      dispatchState: "idle",
      activeStep: undefined,
      activeAttemptId: undefined,
      activeRequestJson: undefined,
      activeRequestFingerprint: undefined,
      activeIdempotencyKey: undefined,
      providerDeadlineAt: undefined,
      quiescentAfterAt: undefined,
      nextReconcileAt: undefined,
      reconcileClaimId: undefined,
      reconcileClaimExpiresAt: undefined,
      manualDebtReason:
        operation.manualDebtReason === "late_result_conflict"
          ? "late_result_conflict"
          : undefined,
      lastStripeStep: args.step,
      lastStripeAttemptId: args.attemptId,
      lastStripeRequestFingerprint: args.requestFingerprint,
      lastStripeIdempotencyKey: args.idempotencyKey,
      lastStripeProviderDeadlineAt: args.providerDeadlineAt,
      lastStripeReconcileClaimId: args.reconcileClaimId,
      lastStripeDisposition: "not_created",
      integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
      lifecycleIntegrityVersion: undefined,
      terminalizedByManualResolutionId: undefined,
      leaseExpiresAt: args.now,
      updatedAt: args.now,
    });
    return {
      recorded: true as const,
      duplicate: false as const,
      customerDeleted: false,
    };
  },
});

/**
 * Audited operator recovery for provider debt that Stripe cannot reconcile
 * automatically. This deliberately has no arbitrary "drop" branch: after the
 * physical transport and reconciliation claim are quiescent, the operator
 * must either provide the exact step-shaped remote locator or attest—with
 * externally retained evidence—that Stripe created no resource.
 *
 * The mutation is internal-only. Deployment access is the operator authority;
 * the supplied operator/evidence strings are domain-separated and hashed so
 * the durable audit remains useful without retaining employee identity or
 * ticket contents in product data.
 */
export const resolveStripeOperationManualDebtInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    resolutionId: v.string(),
    expectedStep: stripeStepValidator,
    expectedAttemptId: v.optional(v.string()),
    resolution: manualResolutionValidator,
    resolvedBy: v.string(),
    evidence: v.string(),
    now: v.number(),
  },
  returns: manualResolutionResultValidator,
  handler: async (ctx, args) => {
    const resolutionId = args.resolutionId.trim();
    const resolvedBy = args.resolvedBy.trim();
    const evidence = args.evidence.trim();
    if (!SAFE_ATTEMPT_ID.test(resolutionId)) {
      throw conflict("Stripe manual resolution ID is invalid.");
    }
    if (
      args.expectedAttemptId !== undefined &&
      !SAFE_ATTEMPT_ID.test(args.expectedAttemptId)
    ) {
      throw conflict("Stripe manual resolution attempt ID is invalid.");
    }
    if (
      !SAFE_OPERATOR_ID.test(resolvedBy) ||
      !evidence ||
      evidence.length > MAX_MANUAL_RESOLUTION_EVIDENCE_LENGTH
    ) {
      throw conflict("Stripe manual resolution evidence is invalid.");
    }

    const normalizedResolution =
      args.resolution.kind === "recovered_customer"
        ? {
            kind: args.resolution.kind,
            stripeCustomerId: args.resolution.stripeCustomerId.trim(),
          }
        : args.resolution.kind === "recovered_checkout"
          ? {
              kind: args.resolution.kind,
              stripeCustomerId: args.resolution.stripeCustomerId.trim(),
              stripeCheckoutSessionId:
                args.resolution.stripeCheckoutSessionId.trim(),
            }
          : args.resolution.kind === "recovered_portal"
            ? {
                kind: args.resolution.kind,
                stripeCustomerId: args.resolution.stripeCustomerId.trim(),
                stripePortalSessionId:
                  args.resolution.stripePortalSessionId.trim(),
              }
            : { kind: args.resolution.kind };
    const recoveredLocators =
      normalizedResolution.kind === "recovered_customer"
        ? { stripeCustomerId: normalizedResolution.stripeCustomerId }
        : normalizedResolution.kind === "recovered_checkout"
          ? {
              stripeCustomerId: normalizedResolution.stripeCustomerId,
              stripeCheckoutSessionId:
                normalizedResolution.stripeCheckoutSessionId,
            }
          : normalizedResolution.kind === "recovered_portal"
            ? {
                stripeCustomerId: normalizedResolution.stripeCustomerId,
                stripePortalSessionId:
                  normalizedResolution.stripePortalSessionId,
              }
            : {};
    for (const locator of Object.values(recoveredLocators)) {
      if (!SAFE_STRIPE_LOCATOR.test(locator)) {
        throw conflict("Recovered Stripe provider locator is invalid.");
      }
    }
    const locatorHash =
      Object.keys(recoveredLocators).length === 0
        ? undefined
        : await stripeResolutionAuditHash(
            "locator",
            JSON.stringify(recoveredLocators),
          );
    const [resolvedByHash, evidenceHash] = await Promise.all([
      stripeResolutionAuditHash("operator", resolvedBy),
      stripeResolutionAuditHash("evidence", evidence),
    ]);

    const existingResolution = await ctx.db
      .query("billing_stripe_operation_resolutions")
      .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
      .unique();
    if (existingResolution) {
      if (
        existingResolution.ownerId !== args.ownerId ||
        existingResolution.ownerGeneration !== args.ownerGeneration ||
        existingResolution.operationId !== args.operationId ||
        existingResolution.attemptId !== args.expectedAttemptId ||
        existingResolution.step !== args.expectedStep ||
        existingResolution.resolution !== normalizedResolution.kind ||
        existingResolution.locatorHash !== locatorHash ||
        existingResolution.resolvedByHash !== resolvedByHash ||
        existingResolution.evidenceHash !== evidenceHash
      ) {
        throw conflict("Stripe manual resolution does not match its audit.");
      }
      return {
        resolution: existingResolution.resolution,
        replayed: true,
      };
    }

    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      operation.ownerId !== args.ownerId ||
      operation.ownerGeneration !== args.ownerGeneration
    ) {
      throw conflict("Stripe manual debt receipt is missing or changed.");
    }
    const debtReason = operation.manualDebtReason;
    if (!debtReason) {
      throw conflict(
        "Stripe provider debt has not reached an audited manual state.",
      );
    }
    if (
      debtReason !== "late_result_conflict" &&
      operation.state !== "reserved"
    ) {
      throw conflict("Stripe manual debt receipt state changed.");
    }

    let step: StripeStep;
    let attemptId: string | undefined;
    const resolvingLateResult = debtReason === "late_result_conflict";
    let lateResultRow: StripeLateResult | undefined;
    if (resolvingLateResult) {
      // The pre-ledger singleton may not have an immutable receipt or ledger
      // row yet. Materialize both inside this transaction, then require the
      // exhaustive operation-wide proof before changing/deleting any debt.
      await ensureProjectedLateResultRow(ctx, operation, args.now);
      if (
        !(await ensureLateConflictStripeOperationIntegrity(
          ctx,
          operation,
          args.now,
        ))
      ) {
        throw conflict(
          "Stripe operation physical receipt provenance requires reconciliation.",
        );
      }
      if (!locatorHash) {
        throw conflict(
          "Stripe late-result resolution must acknowledge observed locators.",
        );
      }
      if (!args.expectedAttemptId) {
        throw conflict(
          "Stripe late-result resolution requires the exact physical attempt.",
        );
      }
      const matchingRows = await ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_operationId_and_attemptId", (q) =>
          q
            .eq("operationId", operation.operationId)
            .eq("attemptId", args.expectedAttemptId!),
        )
        .take(2);
      if (
        matchingRows.length !== 1 ||
        matchingRows[0]!.locatorHash !== locatorHash
      ) {
        throw conflict(
          "Stripe late-result debt tuple is missing, changed, or ambiguous.",
        );
      }
      lateResultRow = matchingRows[0];
      const recomputedLateTupleHash = await hashStripeDeletedOperationTuple({
        operationId: lateResultRow.operationId,
        attemptId: lateResultRow.attemptId,
        step: lateResultRow.step,
        requestFingerprint: lateResultRow.requestFingerprint,
        idempotencyKey: lateResultRow.idempotencyKey,
        providerDeadlineAt: lateResultRow.providerDeadlineAt,
      });
      if (
        recomputedLateTupleHash !== lateResultRow.tupleHash ||
        !(await hasMatchingStripePhysicalReceipt(ctx, {
          operationId: lateResultRow.operationId,
          attemptId: lateResultRow.attemptId,
          step: lateResultRow.step,
          requestFingerprint: lateResultRow.requestFingerprint,
          idempotencyKey: lateResultRow.idempotencyKey,
          providerDeadlineAt: lateResultRow.providerDeadlineAt,
        }))
      ) {
        throw conflict("Stripe late-result physical authority is missing.");
      }
      if (args.now < lateResultRow.quiescentAfterAt) {
        throw conflict(
          "Stripe late-result provider authority is still active.",
        );
      }
      if (operation.dispatchState === "may_have_dispatched") {
        const selectedIsActive =
          operation.activeAttemptId === lateResultRow.attemptId &&
          operation.activeStep === lateResultRow.step &&
          operation.activeRequestFingerprint ===
            lateResultRow.requestFingerprint &&
          operation.activeIdempotencyKey === lateResultRow.idempotencyKey &&
          operation.providerDeadlineAt === lateResultRow.providerDeadlineAt;
        if (
          !selectedIsActive ||
          (operation.reconcileClaimId !== undefined &&
            (operation.reconcileClaimExpiresAt === undefined ||
              args.now < operation.reconcileClaimExpiresAt))
        ) {
          // A newer attempt is still authoritative. It must independently
          // settle before an older result can be acknowledged.
          throw conflict(
            "Stripe late-result provider authority is still active.",
          );
        }
      }
      step = lateResultRow.step;
      attemptId = lateResultRow.attemptId;
    } else if (operation.dispatchState === "may_have_dispatched") {
      if (
        !(await ensureCurrentStripeOperationIntegrity(
          ctx,
          operation,
          args.now,
          { strictTransport: true, allowManualDebt: true },
        )) ||
        !operation.activeStep ||
        !operation.activeAttemptId ||
        !operation.activeRequestFingerprint ||
        !operation.activeIdempotencyKey ||
        operation.quiescentAfterAt === undefined ||
        operation.providerDeadlineAt === undefined
      ) {
        throw conflict("Stripe manual debt receipt is malformed.");
      }
      if (operation.reconcileClaimId || operation.reconcileClaimExpiresAt) {
        throw conflict("Stripe provider reconciliation is still active.");
      }
      if (args.now < operation.quiescentAfterAt) {
        throw conflict("Stripe provider authority is still active.");
      }
      if (
        args.expectedAttemptId === undefined ||
        args.expectedAttemptId !== operation.activeAttemptId
      ) {
        throw conflict(
          "Stripe manual resolution requires the exact physical attempt.",
        );
      }
      step = operation.activeStep;
      attemptId = operation.activeAttemptId;
    } else if (
      operation.dispatchState === undefined &&
      debtReason === "legacy_missing_receipt" &&
      hasLegacyStripeOperationIntegrityVersion(operation) &&
      hasValidStripeOperationStateLocators(operation) &&
      !hasUnexpectedIdleDispatchFields(operation, { allowManualDebt: true }) &&
      operation.leaseExpiresAt <= args.now
    ) {
      if (args.expectedAttemptId !== undefined) {
        throw conflict(
          "Stripe tuple-less legacy resolution must not name a physical attempt.",
        );
      }
      if (
        !(await ensureLegacyStripeOperationPhysicalReceiptProvenance(
          ctx,
          operation,
        ))
      ) {
        throw conflict(
          "Stripe legacy manual debt receipt provenance requires reconciliation.",
        );
      }
      step =
        operation.kind === "billing_portal"
          ? "portal_create"
          : !operation.stripeCustomerId
            ? "customer_create"
            : "checkout_create";
    } else {
      throw conflict("Stripe operation is not eligible for manual recovery.");
    }
    if (step !== args.expectedStep) {
      throw conflict("Stripe manual resolution step changed.");
    }
    const expectedResolutionKind =
      step === "customer_create"
        ? "recovered_customer"
        : step === "checkout_create"
          ? "recovered_checkout"
          : "recovered_portal";
    if (
      normalizedResolution.kind !== "provider_confirmed_not_created" &&
      normalizedResolution.kind !== expectedResolutionKind
    ) {
      throw conflict("Stripe manual resolution locator shape is invalid.");
    }

    if (
      resolvingLateResult &&
      (normalizedResolution.kind === "provider_confirmed_not_created" ||
        normalizedResolution.stripeCustomerId !==
          lateResultRow!.stripeCustomerId ||
        (step === "checkout_create" &&
          normalizedResolution.kind === "recovered_checkout" &&
          normalizedResolution.stripeCheckoutSessionId !==
            lateResultRow!.stripeCheckoutSessionId) ||
        (step === "portal_create" &&
          normalizedResolution.kind === "recovered_portal" &&
          normalizedResolution.stripePortalSessionId !==
            lateResultRow!.stripePortalSessionId))
    ) {
      throw conflict(
        "Stripe late-result resolution must acknowledge the exact observed locators.",
      );
    }

    const recovered =
      normalizedResolution.kind !== "provider_confirmed_not_created";
    const debtKey = attemptId
      ? resolvingLateResult
        ? lateResultDebtKey(
            lateResultRow!.tupleHash,
            lateResultRow!.locatorHash,
          )
        : `attempt:${attemptId}:${debtReason}`
      : `legacy:${step}:${debtReason}`;
    const existingDebtResolution = await ctx.db
      .query("billing_stripe_operation_resolutions")
      .withIndex("by_operationId_and_debtKey", (q) =>
        q.eq("operationId", operation.operationId).eq("debtKey", debtKey),
      )
      .unique();
    if (existingDebtResolution) {
      throw conflict("Stripe manual debt was already resolved.");
    }
    if (
      !(await hasStripeOperationResolutionCapacityForInsert(
        ctx,
        operation.operationId,
      ))
    ) {
      throw conflict(
        "Stripe resolution audit capacity requires lifecycle repair.",
      );
    }

    if (!resolvingLateResult) {
      assertLocatorCompatible(operation, recoveredLocators);
    }
    let lateResultProviderOwnerCompatible = !resolvingLateResult;
    if (resolvingLateResult) {
      lateResultProviderOwnerCompatible =
        lateResultRow!.providerOwnerId === operation.ownerId;
      if (
        !lateResultProviderOwnerCompatible &&
        lateResultRow!.providerOwnerId &&
        lateResultRow!.stripeCustomerId &&
        lateResultRow!.stripeCustomerId === operation.stripeCustomerId &&
        operation.stripeCustomerMetadataOwnerId === operation.ownerId
      ) {
        const [sourceOwnerHash, destinationOwnerHash] = await Promise.all([
          ownershipMigrationSourceDigest(lateResultRow!.providerOwnerId),
          ownershipMigrationSourceDigest(operation.ownerId),
        ]);
        const alias = await ctx.db
          .query("billing_stripe_owner_aliases")
          .withIndex("by_sourceOwnerHash_and_destinationOwnerHash", (q) =>
            q
              .eq("sourceOwnerHash", sourceOwnerHash)
              .eq("destinationOwnerHash", destinationOwnerHash),
          )
          .unique();
        lateResultProviderOwnerCompatible = Boolean(alias);
      }
    }
    const lateResultConflictsWithCanonical = Boolean(
      resolvingLateResult &&
        (!lateResultProviderOwnerCompatible ||
          (operation.stripeCustomerId &&
            operation.stripeCustomerId !==
              recoveredLocators.stripeCustomerId) ||
          (step === "checkout_create" &&
            operation.stripeCheckoutSessionId &&
            operation.stripeCheckoutSessionId !==
              ("stripeCheckoutSessionId" in recoveredLocators
                ? recoveredLocators.stripeCheckoutSessionId
                : undefined)) ||
          (step === "portal_create" &&
            operation.stripePortalSessionId &&
            operation.stripePortalSessionId !==
              ("stripePortalSessionId" in recoveredLocators
                ? recoveredLocators.stripePortalSessionId
                : undefined))),
    );
    const customerConvergence =
      normalizedResolution.kind !== "provider_confirmed_not_created" &&
      !lateResultConflictsWithCanonical
        ? await convergeStripeCustomerProfile(ctx, {
            ownerId: operation.ownerId,
            stripeCustomerId: normalizedResolution.stripeCustomerId,
            expectedCustomerAuthorityEpoch:
              operation.stripeCustomerAuthorityEpoch ?? 0,
            now: args.now,
          })
        : undefined;

    if (customerConvergence === "foreign_customer") {
      throw conflict(
        "Recovered Stripe customer is linked to another owner and requires repair.",
      );
    }
    if (
      normalizedResolution.kind !== "provider_confirmed_not_created" &&
      !resolvingLateResult &&
      customerConvergence !== "linked"
    ) {
      throw conflict(
        "Recovered Stripe customer conflicts with the owner's canonical customer.",
      );
    }
    const cleanupLateResult =
      lateResultConflictsWithCanonical ||
      (resolvingLateResult &&
        customerConvergence !== undefined &&
        customerConvergence !== "linked");

    const adoptRecoveredResult =
      recovered && !cleanupLateResult && customerConvergence === "linked";
    // A delayed customer_create result can be acknowledged after the same
    // customer has already completed a later checkout/portal step. In that
    // case the append-only resolution audit deduplicates future callbacks,
    // but the ancillary customer tuple must not replace the terminal step's
    // canonical history (which is the proof behind completion/URL return).
    const replaceCanonicalHistoricalResult =
      adoptRecoveredResult &&
      (step !== "customer_create" || operation.state === "reserved");
    if (resolvingLateResult && cleanupLateResult) {
      // The operation already has a different canonical result. The operator
      // acknowledgement authorizes exact cleanup of this independently
      // persisted stray result; it must never overwrite (or make us forget)
      // the canonical locator.
      await enqueueLateStripeCleanupLocators(ctx, {
        ownerId: operation.ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        attemptId: lateResultRow!.attemptId,
        step: lateResultRow!.step,
        requestFingerprint: lateResultRow!.requestFingerprint,
        idempotencyKey: lateResultRow!.idempotencyKey,
        providerDeadlineAt: lateResultRow!.providerDeadlineAt,
        reconcileClaimId: lateResultRow!.reconcileClaimId,
        providerOwnerId: lateResultRow!.providerOwnerId ?? operation.ownerId,
        stripeCustomerId: lateResultRow!.stripeCustomerId,
        stripeCheckoutSessionId: lateResultRow!.stripeCheckoutSessionId,
        stripePortalSessionId: lateResultRow!.stripePortalSessionId,
        deleteStripeCustomerId:
          lateResultRow!.stripeCustomerId !== operation.stripeCustomerId
            ? lateResultRow!.stripeCustomerId
            : null,
        deleteStripeCheckoutSessionId:
          lateResultRow!.stripeCheckoutSessionId !==
          operation.stripeCheckoutSessionId
            ? lateResultRow!.stripeCheckoutSessionId
            : null,
        // Billing Portal sessions have no deletion endpoint. Their raw value
        // is removed with the resolved row; the hash-only resolution audit is
        // the durable evidence that it was acknowledged.
        now: args.now,
        tupleHash: lateResultRow!.tupleHash,
      });
    }
    if (resolvingLateResult) {
      await ctx.db.delete(lateResultRow!._id);
    }
    const nextLateResult = resolvingLateResult
      ? await ctx.db
          .query("billing_stripe_late_results")
          .withIndex("by_operationId_and_createdAt", (q) =>
            q.eq("operationId", operation.operationId),
          )
          .first()
      : null;
    await ctx.db.patch(operation._id, {
      dispatchState: "idle",
      activeStep: undefined,
      activeAttemptId: undefined,
      activeRequestJson: undefined,
      activeRequestFingerprint: undefined,
      activeIdempotencyKey: undefined,
      providerDeadlineAt: undefined,
      quiescentAfterAt: undefined,
      nextReconcileAt: undefined,
      reconcileClaimId: undefined,
      reconcileClaimExpiresAt: undefined,
      manualDebtReason: nextLateResult ? "late_result_conflict" : undefined,
      lateResultConflictStep: nextLateResult?.step,
      lateResultConflictAttemptId: nextLateResult?.attemptId,
      lateResultRequestFingerprint: nextLateResult?.requestFingerprint,
      lateResultIdempotencyKey: nextLateResult?.idempotencyKey,
      lateResultProviderDeadlineAt: nextLateResult?.providerDeadlineAt,
      lateResultReconcileClaimId: nextLateResult?.reconcileClaimId,
      lateResultStripeCustomerId: nextLateResult?.stripeCustomerId,
      lateResultStripeCheckoutSessionId:
        nextLateResult?.stripeCheckoutSessionId,
      lateResultStripePortalSessionId: nextLateResult?.stripePortalSessionId,
      lateResultConflictAt: nextLateResult?.createdAt,
      lateResultConflictQuiescentAfterAt: nextLateResult?.quiescentAfterAt,
      ...(attemptId
        ? resolvingLateResult
          ? replaceCanonicalHistoricalResult
            ? {
                lastStripeStep: step,
                lastStripeAttemptId: attemptId,
                lastStripeRequestFingerprint: lateResultRow!.requestFingerprint,
                lastStripeIdempotencyKey: lateResultRow!.idempotencyKey,
                lastStripeProviderDeadlineAt: lateResultRow!.providerDeadlineAt,
                lastStripeReconcileClaimId: lateResultRow!.reconcileClaimId,
                lastStripeDisposition: "succeeded" as const,
              }
            : {}
          : {
              lastStripeStep: step,
              lastStripeAttemptId: attemptId,
              lastStripeRequestFingerprint: operation.activeRequestFingerprint!,
              lastStripeIdempotencyKey: operation.activeIdempotencyKey!,
              lastStripeProviderDeadlineAt: operation.providerDeadlineAt!,
              lastStripeReconcileClaimId: undefined,
              lastStripeDisposition: recovered
                ? ("succeeded" as const)
                : ("not_created" as const),
            }
        : {}),
      ...(adoptRecoveredResult ? recoveredLocators : {}),
      ...(adoptRecoveredResult
        ? {
            stripeCustomerMetadataOwnerId: operation.ownerId,
            ...(step === "customer_create"
              ? {}
              : { terminalizedByManualResolutionId: resolutionId }),
          }
        : {}),
      integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
      lifecycleIntegrityVersion: undefined,
      state: resolvingLateResult
        ? adoptRecoveredResult &&
          step !== "customer_create" &&
          operation.state !== "completed"
          ? ("provider_succeeded" as const)
          : operation.state
        : adoptRecoveredResult && step !== "customer_create"
          ? ("provider_succeeded" as const)
          : ("reserved" as const),
      leaseExpiresAt: args.now,
      updatedAt: args.now,
    });
    await ctx.db.insert("billing_stripe_operation_resolutions", {
      ownerId: operation.ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      resolutionId,
      debtKey,
      ...(attemptId ? { attemptId } : {}),
      step,
      resolution: normalizedResolution.kind,
      debtReason,
      ...(locatorHash ? { locatorHash } : {}),
      resolvedByHash,
      evidenceHash,
      resolvedAt: args.now,
    });
    return { resolution: normalizedResolution.kind, replayed: false };
  },
});

export const claimStripeOperationReconcileCommandInternal = internalMutation({
  args: {
    operationId: v.string(),
    attemptId: v.string(),
    claimId: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      ownerGeneration: v.string(),
      operationId: v.string(),
      attemptId: v.string(),
      step: stripeStepValidator,
      requestJson: v.string(),
      requestFingerprint: v.string(),
      idempotencyKey: v.string(),
      providerDeadlineAt: v.number(),
      reconcileProviderDeadlineAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    if (!SAFE_ATTEMPT_ID.test(args.claimId)) return null;
    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      !(await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now, {
        strictTransport: true,
      })) ||
      operation.dispatchState !== "may_have_dispatched" ||
      operation.activeAttemptId !== args.attemptId ||
      !operation.activeStep ||
      !operation.activeRequestJson ||
      !operation.activeRequestFingerprint ||
      !operation.activeIdempotencyKey ||
      operation.providerDeadlineAt === undefined ||
      operation.quiescentAfterAt === undefined ||
      (operation.nextReconcileAt ?? operation.quiescentAfterAt) > args.now ||
      operation.manualDebtReason !== undefined
    ) {
      return null;
    }
    if (
      operation.reconcileClaimId &&
      operation.reconcileClaimExpiresAt !== undefined &&
      operation.reconcileClaimExpiresAt > args.now
    ) {
      return null;
    }
    const reconcileProviderDeadlineAt = args.now + STRIPE_PROVIDER_TIMEOUT_MS;
    const claimExpiresAt =
      reconcileProviderDeadlineAt + STRIPE_PROVIDER_ABORT_GRACE_MS;
    await ctx.db.patch(operation._id, {
      reconcileClaimId: args.claimId,
      reconcileClaimExpiresAt: claimExpiresAt,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAt(claimExpiresAt, reconcileActionRef, {
      operationId: operation.operationId,
      attemptId: operation.activeAttemptId,
    });
    return {
      ownerId: operation.ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      attemptId: operation.activeAttemptId,
      step: operation.activeStep,
      requestJson: operation.activeRequestJson,
      requestFingerprint: operation.activeRequestFingerprint,
      idempotencyKey: operation.activeIdempotencyKey,
      providerDeadlineAt: operation.providerDeadlineAt,
      reconcileProviderDeadlineAt,
    };
  },
});

/** Exact final authority check immediately before each autonomous provider I/O. */
export const revalidateStripeReconcileProviderCallInternal = internalMutation({
  args: {
    operationId: v.string(),
    attemptId: v.string(),
    claimId: v.string(),
    allowRevokedCustomerAuthority: v.boolean(),
    now: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      providerCallDeadlineAt: v.number(),
      customerAuthorityCurrent: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      !(await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now, {
        strictTransport: true,
      })) ||
      operation.dispatchState !== "may_have_dispatched" ||
      operation.activeAttemptId !== args.attemptId ||
      operation.reconcileClaimId !== args.claimId ||
      operation.reconcileClaimExpiresAt === undefined ||
      operation.manualDebtReason !== undefined
    ) {
      return null;
    }
    const providerCallDeadlineAt =
      operation.reconcileClaimExpiresAt - STRIPE_PROVIDER_ABORT_GRACE_MS;
    if (args.now >= providerCallDeadlineAt) return null;
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", operation.ownerId))
      .unique();
    const epochCurrent =
      Boolean(profile) &&
      (profile!.stripeCustomerAuthorityEpoch ?? 0) ===
        (operation.stripeCustomerAuthorityEpoch ?? 0);
    const customerKeyCurrent =
      operation.activeStep !== "customer_create" ||
      (!profile?.stripeCustomerId.trim() &&
        Boolean(profile?.stripeCustomerCreateIdempotencyKey) &&
        profile!.stripeCustomerCreateIdempotencyKey ===
          operation.stripeCustomerCreateIdempotencyKey &&
        profile!.stripeCustomerCreateIdempotencyKey ===
          operation.activeIdempotencyKey);
    const customerAuthorityCurrent = epochCurrent && customerKeyCurrent;
    if (!customerAuthorityCurrent && !args.allowRevokedCustomerAuthority) {
      return null;
    }
    return { providerCallDeadlineAt, customerAuthorityCurrent };
  },
});

/**
 * Convert one exact autonomous claim into hash-minimized operator debt. Only a
 * claim that still owns the physical tuple can publish the reason; this also
 * revokes every stale worker before an operator may resolve it.
 */
export const recordStripeOperationManualDebtInternal = internalMutation({
  args: {
    operationId: v.string(),
    attemptId: v.string(),
    claimId: v.string(),
    reason: stripeManualDebtReasonValidator,
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      !(await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now, {
        strictTransport: true,
      })) ||
      operation.dispatchState !== "may_have_dispatched" ||
      operation.activeAttemptId !== args.attemptId ||
      operation.reconcileClaimId !== args.claimId ||
      operation.reconcileClaimExpiresAt === undefined
    ) {
      throw conflict(
        "Stripe reconciliation claim changed before debt capture.",
      );
    }
    await ctx.db.patch(operation._id, {
      manualDebtReason: args.reason,
      reconcileClaimId: undefined,
      reconcileClaimExpiresAt: undefined,
      updatedAt: args.now,
    });
    return null;
  },
});

export const deferStripeOperationReconciliationInternal = internalMutation({
  args: {
    operationId: v.string(),
    attemptId: v.string(),
    claimId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await readOperation(ctx, args.operationId);
    if (
      operation?.dispatchState === "may_have_dispatched" &&
      (await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now, {
        strictTransport: true,
      })) &&
      operation.activeAttemptId === args.attemptId &&
      operation.reconcileClaimId === args.claimId &&
      operation.manualDebtReason === undefined
    ) {
      const retryAt = args.now + STRIPE_RECONCILE_RETRY_MS;
      await ctx.db.patch(operation._id, {
        nextReconcileAt: retryAt,
        // Legacy purge reconciliation still consults the coarse lease. Keep
        // it aligned with the exact dispatch receipt so it can never race the
        // durable same-idempotency-key replay owned by this module.
        leaseExpiresAt: retryAt,
        reconcileClaimId: undefined,
        reconcileClaimExpiresAt: undefined,
        updatedAt: args.now,
      });
      await ctx.scheduler.runAt(retryAt, reconcileActionRef, {
        operationId: operation.operationId,
        attemptId: args.attemptId,
      });
    }
    return null;
  },
});

export const isDefinitiveStripeNoCreateError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    type?: unknown;
    name?: unknown;
    statusCode?: unknown;
    raw?: { code?: unknown; type?: unknown };
  };
  const errorSignals = [
    candidate.code,
    candidate.type,
    candidate.name,
    candidate.raw?.code,
    candidate.raw?.type,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  // Stripe can report an idempotency mismatch as HTTP 400 even though an
  // earlier request with that exact key created a resource. Such a response
  // is ambiguous and must remain in reconciliation debt.
  if (errorSignals.some((value) => value.includes("idempotency"))) {
    return false;
  }
  const status = candidate.statusCode;
  return (
    typeof status === "number" &&
    [400, 401, 402, 403, 404, 405, 413, 415, 422].includes(status)
  );
};

class StripeProviderAuthorityExpiredError extends Error {
  constructor() {
    super("Stripe provider-call authority expired before physical I/O.");
    this.name = "StripeProviderAuthorityExpiredError";
  }
}

export const reconcileStripeOperationDispatchInternal = internalAction({
  args: { operationId: v.string(), attemptId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claimId = crypto.randomUUID();
    const command = await ctx.runMutation(claimReconcileCommandRef, {
      ...args,
      claimId,
      now: Date.now(),
    });
    if (!command) return null;
    const tuple = {
      ownerId: command.ownerId,
      ownerGeneration: command.ownerGeneration,
      operationId: command.operationId,
      attemptId: command.attemptId,
      step: command.step,
      requestFingerprint: command.requestFingerprint,
      idempotencyKey: command.idempotencyKey,
      providerDeadlineAt: command.providerDeadlineAt,
      reconcileClaimId: claimId,
    } as const;
    const withProviderAuthority = async <T>(
      call: (stripe: Stripe) => Promise<T>,
      allowRevokedCustomerAuthority = false,
    ): Promise<T> => {
      const authority = await ctx.runMutation(
        revalidateReconcileProviderCallRef,
        {
          operationId: command.operationId,
          attemptId: command.attemptId,
          claimId,
          allowRevokedCustomerAuthority,
          now: Date.now(),
        },
      );
      if (!authority) throw new StripeProviderAuthorityExpiredError();
      // No await is permitted between the absolute-budget check and invoking
      // the provider method. A suspended stale worker therefore resumes into
      // an expired local check and performs zero physical calls.
      const stripe = getStripeClient(
        remainingStripeProviderBudgetMs(authority.providerCallDeadlineAt),
      );
      return await call(stripe);
    };
    const recordManualDebt = async (reason: StripeManualDebtReason) => {
      await ctx.runMutation(recordManualDebtRef, {
        operationId: command.operationId,
        attemptId: command.attemptId,
        claimId,
        reason,
        now: Date.now(),
      });
    };
    let allowDefinitiveCreateFailureSettlement = true;
    try {
      const request = JSON.parse(command.requestJson) as Record<
        string,
        unknown
      >;
      const firstDispatchAt =
        command.providerDeadlineAt - STRIPE_PROVIDER_TIMEOUT_MS;
      const automaticReplayUntilAt =
        firstDispatchAt + STRIPE_IDEMPOTENCY_REPLAY_HORIZON_MS;
      const authorityState = await ctx.runMutation(
        revalidateReconcileProviderCallRef,
        {
          operationId: command.operationId,
          attemptId: command.attemptId,
          claimId,
          allowRevokedCustomerAuthority: true,
          now: Date.now(),
        },
      );
      if (!authorityState) return null;
      const customerAuthorityRevoked = !authorityState.customerAuthorityCurrent;
      if (Date.now() >= automaticReplayUntilAt || customerAuthorityRevoked) {
        // Discovery errors never prove absence. Only a successful exhaustive
        // exact metadata search/list below may settle `not_created`.
        allowDefinitiveCreateFailureSettlement = false;
        if (command.step === "portal_create") {
          await recordManualDebt("portal_lookup_unavailable");
          return null;
        }
        if (command.step === "customer_create") {
          const metadata =
            request.metadata && typeof request.metadata === "object"
              ? (request.metadata as Record<string, unknown>)
              : null;
          const discoveryKey =
            typeof metadata?.stellaCustomerAuthorityId === "string"
              ? metadata.stellaCustomerAuthorityId
              : typeof metadata?.stellaOperationId === "string"
                ? metadata.stellaOperationId
                : "";
          const discoveryField =
            typeof metadata?.stellaCustomerAuthorityId === "string"
              ? "stellaCustomerAuthorityId"
              : "stellaOperationId";
          if (!discoveryKey) {
            await recordManualDebt("customer_lookup_unavailable");
            return null;
          }
          const escapedDiscoveryKey = discoveryKey
            .replaceAll("\\", "\\\\")
            .replaceAll("'", "\\'");
          const result = await withProviderAuthority(
            async (stripe) =>
              await stripe.customers.search({
                query: `metadata['${discoveryField}']:'${escapedDiscoveryKey}'`,
                limit: 10,
              }),
            true,
          );
          const matches = result.data.filter(
            (customer) => customer.metadata?.[discoveryField] === discoveryKey,
          );
          if (matches.length > 1) {
            await recordManualDebt("customer_duplicate");
            return null;
          }
          if (result.has_more) {
            await recordManualDebt("customer_scan_horizon");
            return null;
          }
          if (matches.length === 1) {
            await ctx.runMutation(settleSuccessRef, {
              ...tuple,
              stripeCustomerId: matches[0]!.id,
              now: Date.now(),
            });
          } else if (customerAuthorityRevoked) {
            // Stripe Search is not read-after-write. A lost successful create
            // can remain temporarily absent from search after its authority
            // was revoked. Recording explicit debt keeps all distinct
            // customer-create operations fenced instead of treating absence
            // as proof and issuing a second create under a newer key.
            await recordManualDebt("customer_authority_revoked");
          } else {
            await ctx.runMutation(settleNotCreatedRef, {
              ...tuple,
              now: Date.now(),
            });
          }
          return null;
        }

        const customer =
          typeof request.customer === "string" ? request.customer : "";
        const metadata =
          request.metadata && typeof request.metadata === "object"
            ? (request.metadata as Record<string, unknown>)
            : null;
        if (!customer || metadata?.stellaOperationId !== command.operationId) {
          await recordManualDebt("checkout_lookup_unavailable");
          return null;
        }
        const discovery = await discoverUniqueStripeCheckoutSession({
          operationId: command.operationId,
          listPage: async (startingAfter) =>
            await withProviderAuthority(
              async (stripe) =>
                await stripe.checkout.sessions.list({
                  customer,
                  limit: 100,
                  ...(startingAfter ? { starting_after: startingAfter } : {}),
                }),
              true,
            ),
        });
        if (discovery.kind === "found") {
          await ctx.runMutation(settleSuccessRef, {
            ...tuple,
            stripeCustomerId: customer,
            stripeCheckoutSessionId: discovery.sessionId,
            now: Date.now(),
          });
          return null;
        }
        if (discovery.kind === "not_found") {
          await ctx.runMutation(settleNotCreatedRef, {
            ...tuple,
            now: Date.now(),
          });
          return null;
        }
        await recordManualDebt(
          discovery.reason === "duplicate"
            ? "checkout_duplicate"
            : "checkout_scan_horizon",
        );
        return null;
      }
      if (command.step === "customer_create") {
        const customer = await withProviderAuthority(
          async (stripe) =>
            await stripe.customers.create(
              request as Stripe.CustomerCreateParams,
              { idempotencyKey: command.idempotencyKey },
            ),
        );
        await ctx.runMutation(settleSuccessRef, {
          ...tuple,
          stripeCustomerId: customer.id,
          now: Date.now(),
        });
      } else if (command.step === "checkout_create") {
        const session = await withProviderAuthority(
          async (stripe) =>
            await stripe.checkout.sessions.create(
              request as Stripe.Checkout.SessionCreateParams,
              { idempotencyKey: command.idempotencyKey },
            ),
        );
        const customer =
          typeof request.customer === "string" ? request.customer : undefined;
        await ctx.runMutation(settleSuccessRef, {
          ...tuple,
          ...(customer ? { stripeCustomerId: customer } : {}),
          stripeCheckoutSessionId: session.id,
          now: Date.now(),
        });
      } else {
        const session = await withProviderAuthority(
          async (stripe) =>
            await stripe.billingPortal.sessions.create(
              request as Stripe.BillingPortal.SessionCreateParams,
              { idempotencyKey: command.idempotencyKey },
            ),
        );
        const customer =
          typeof request.customer === "string" ? request.customer : undefined;
        await ctx.runMutation(settleSuccessRef, {
          ...tuple,
          ...(customer ? { stripeCustomerId: customer } : {}),
          stripePortalSessionId: session.id,
          now: Date.now(),
        });
      }
    } catch (error) {
      if (error instanceof StripeProviderAuthorityExpiredError) return null;
      if (
        allowDefinitiveCreateFailureSettlement &&
        isDefinitiveStripeNoCreateError(error)
      ) {
        await ctx.runMutation(settleNotCreatedRef, {
          ...tuple,
          now: Date.now(),
        });
      } else {
        await ctx.runMutation(deferReconcileRef, {
          operationId: command.operationId,
          attemptId: command.attemptId,
          claimId,
          now: Date.now(),
        });
      }
    }
    return null;
  },
});

export const hasValidLateStripeCleanupRowProof = async (
  ctx: Pick<QueryCtx, "db">,
  row: Doc<"billing_stripe_late_cleanup_locators">,
): Promise<boolean> => {
  if (
    !/^[a-f0-9]{64}$/u.test(row.tupleHash) ||
    !/^[a-f0-9]{64}$/u.test(row.ownerHash) ||
    !/^[a-f0-9]{64}$/u.test(row.providerOwnerHash) ||
    !/^[a-f0-9]{64}$/u.test(row.successLocatorHash) ||
    !/^[a-f0-9]{64}$/u.test(row.locatorHash)
  ) {
    return false;
  }
  const successStripeCustomerId = row.successStripeCustomerId?.trim();
  const successStripeCheckoutSessionId =
    row.successStripeCheckoutSessionId?.trim();
  const successStripePortalSessionId = row.successStripePortalSessionId?.trim();
  if (
    !successStripeCustomerId ||
    (successStripeCheckoutSessionId && successStripePortalSessionId)
  ) {
    return false;
  }
  const expectedLocatorValue =
    row.locatorKind === "customer"
      ? successStripeCustomerId
      : successStripeCheckoutSessionId;
  if (
    !expectedLocatorValue ||
    expectedLocatorValue !== row.locatorValue.trim()
  ) {
    return false;
  }
  const [locatorHash, successLocatorHash, expectedCustomerLocatorHash] =
    await Promise.all([
      hashStripeBillingLocator(row.locatorKind, row.locatorValue),
      hashStripePhysicalSuccessLocators({
        stripeCustomerId: successStripeCustomerId,
        ...(successStripeCheckoutSessionId
          ? { stripeCheckoutSessionId: successStripeCheckoutSessionId }
          : {}),
        ...(successStripePortalSessionId
          ? { stripePortalSessionId: successStripePortalSessionId }
          : {}),
      }),
      hashStripeBillingLocator("customer", successStripeCustomerId),
    ]);
  if (
    locatorHash !== row.locatorHash ||
    successLocatorHash !== row.successLocatorHash ||
    (row.locatorKind === "checkout_session"
      ? row.customerLocatorHash !== expectedCustomerLocatorHash
      : row.customerLocatorHash !== undefined)
  ) {
    return false;
  }
  const receiptRows = await ctx.db
    .query("billing_stripe_physical_receipts")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", row.tupleHash))
    .take(2);
  if (
    receiptRows.length !== 1 ||
    receiptRows[0]!.providerOwnerHash !== row.providerOwnerHash ||
    receiptRows[0]!.successLocatorHash !== row.successLocatorHash
  ) {
    return false;
  }
  const [operations, tombstones] = await Promise.all([
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_operationId", (q) =>
        q.eq("operationId", receiptRows[0]!.operationId),
      )
      .take(2),
    ctx.db
      .query("billing_stripe_operation_tombstones")
      .withIndex("by_operationId", (q) =>
        q.eq("operationId", receiptRows[0]!.operationId),
      )
      .take(2),
  ]);
  if (operations.length > 1 || tombstones.length > 1) return false;
  const liveOwnerHash = operations[0]
    ? await ownershipMigrationSourceDigest(operations[0].ownerId)
    : undefined;
  return (
    liveOwnerHash === row.ownerHash ||
    tombstones[0]?.ownerHash === row.ownerHash
  );
};

export const authorizeLateStripeCleanupRowInternal = internalQuery({
  args: { tupleHash: v.string(), locatorHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash_and_locatorHash", (q) =>
        q.eq("tupleHash", args.tupleHash).eq("locatorHash", args.locatorHash),
      )
      .unique();
    return row ? await hasValidLateStripeCleanupRowProof(ctx, row) : false;
  },
});

export const getPendingLateStripeCleanupInternal = internalQuery({
  args: { now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      tupleHash: v.string(),
      ownerHash: v.string(),
      providerOwnerHash: v.string(),
      successLocatorHash: v.string(),
      locatorHash: v.string(),
      locatorKind: v.union(
        v.literal("customer"),
        v.literal("checkout_session"),
      ),
      locatorValue: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const checkoutRows = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_kind_and_nextAttemptAt", (q) =>
        q.eq("locatorKind", "checkout_session").lte("nextAttemptAt", args.now),
      )
      .take(33);
    const checkout = checkoutRows.find(
      (candidate) =>
        candidate.cleanupClaimExpiresAt === undefined ||
        candidate.cleanupClaimExpiresAt <= args.now,
    );
    const customerRows = checkout
      ? []
      : await ctx.db
          .query("billing_stripe_late_cleanup_locators")
          .withIndex("by_kind_and_nextAttemptAt", (q) =>
            q.eq("locatorKind", "customer").lte("nextAttemptAt", args.now),
          )
          .take(33);
    const row =
      checkout ??
      customerRows.find(
        (candidate) =>
          candidate.cleanupClaimExpiresAt === undefined ||
          candidate.cleanupClaimExpiresAt <= args.now,
      );
    return row
      ? {
          tupleHash: row.tupleHash,
          ownerHash: row.ownerHash,
          providerOwnerHash: row.providerOwnerHash,
          successLocatorHash: row.successLocatorHash,
          locatorHash: row.locatorHash,
          locatorKind: row.locatorKind,
          locatorValue: row.locatorValue,
        }
      : null;
  },
});

export const claimLateStripeCleanupInternal = internalMutation({
  args: {
    tupleHash: v.string(),
    locatorHash: v.string(),
    claimId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!SAFE_ATTEMPT_ID.test(args.claimId)) return false;
    const row = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash_and_locatorHash", (q) =>
        q.eq("tupleHash", args.tupleHash).eq("locatorHash", args.locatorHash),
      )
      .unique();
    if (!row || !(await hasValidLateStripeCleanupRowProof(ctx, row))) {
      return false;
    }
    const retained = await readValidScopedStripeRetentionFence(ctx, {
      ownerHash: row.ownerHash,
      locatorHash: row.locatorHash,
      locatorKind: row.locatorKind,
    });
    if (retained) {
      if (row.cleanupClaimId !== undefined) return false;
      const receiptRows = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", row.tupleHash))
        .take(2);
      if (receiptRows.length !== 1) {
        throw conflict(
          "Stripe cleanup physical receipt is missing or changed.",
        );
      }
      const resolutionId = await inheritLateStripeCleanupRetention(ctx, {
        receipt: receiptRows[0]!,
        ownerHash: row.ownerHash,
        retained: [
          {
            locatorHash: row.locatorHash,
            locatorKind: row.locatorKind,
          },
        ],
        now: args.now,
      });
      await ctx.db.delete(row._id);
      const remainingTupleLocator = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", row.tupleHash))
        .first();
      if (!remainingTupleLocator) {
        await finalizeLateStripeCleanupTuple(ctx, receiptRows[0]!, args.now, {
          kind: "retained",
          resolutionId,
        });
      }
      return false;
    }
    if (
      row.cleanupClaimExpiresAt !== undefined &&
      row.cleanupClaimExpiresAt > args.now
    ) {
      return false;
    }
    if (row.locatorKind === "customer") {
      const pendingCheckout = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_customerLocatorHash", (q) =>
          q.eq("customerLocatorHash", row.locatorHash),
        )
        .first();
      if (pendingCheckout) {
        // Derive readiness from the authoritative Checkout row. Deferring one
        // customer at a time avoids a fan-out transaction over every tuple
        // that references a shared customer, so an arbitrarily large set
        // cannot roll back the callback that created cleanup authority.
        await ctx.db.patch(row._id, {
          checkoutBlocked: true,
          nextAttemptAt: Math.max(row.nextAttemptAt, args.now + 60_000),
          updatedAt: args.now,
        });
        return false;
      }
    }
    await ctx.db.patch(row._id, {
      cleanupClaimId: args.claimId,
      ...(row.locatorKind === "customer" ? { checkoutBlocked: false } : {}),
      // Worst-case Checkout cleanup can perform four sequential Stripe calls
      // (session, customer, expire, readback), each with a 20s timeout.
      cleanupClaimExpiresAt: args.now + STRIPE_LATE_CLEANUP_DISCOVERY_CLAIM_MS,
      updatedAt: args.now,
    });
    return true;
  },
});

/**
 * Atomically revalidates the exact cleanup claim immediately before provider
 * mutation. Expiry permits a replacement worker to take the claim, but never
 * permits a retained-resource audit to overtake an in-flight claimant: the
 * resolver requires the claim id itself to have been cleared by a recorded
 * failure.
 */
export const revalidateLateStripeCleanupClaimInternal = internalMutation({
  args: {
    tupleHash: v.string(),
    locatorHash: v.string(),
    claimId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!SAFE_ATTEMPT_ID.test(args.claimId)) return false;
    const row = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash_and_locatorHash", (q) =>
        q.eq("tupleHash", args.tupleHash).eq("locatorHash", args.locatorHash),
      )
      .unique();
    if (
      !row ||
      row.cleanupClaimId !== args.claimId ||
      !(await hasValidLateStripeCleanupRowProof(ctx, row))
    ) {
      return false;
    }
    if (
      await readValidScopedStripeRetentionFence(ctx, {
        ownerHash: row.ownerHash,
        locatorHash: row.locatorHash,
        locatorKind: row.locatorKind,
      })
    ) {
      return false;
    }
    if (row.locatorKind === "customer") {
      const pendingCheckout = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_customerLocatorHash", (q) =>
          q.eq("customerLocatorHash", row.locatorHash),
        )
        .first();
      if (pendingCheckout) return false;
    }
    await ctx.db.patch(row._id, {
      cleanupClaimExpiresAt: args.now + STRIPE_LATE_CLEANUP_MUTATION_CLAIM_MS,
      updatedAt: args.now,
    });
    return true;
  },
});

export const authorizeLateStripeCleanupProviderOwnerInternal = internalQuery({
  args: {
    providerOwnerHash: v.string(),
    cleanupOwnerHash: v.optional(v.string()),
    providerOwnerId: v.string(),
  },
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    const ownerHash = await ownershipMigrationSourceDigest(
      args.providerOwnerId,
    );
    return (
      ownerHash === args.providerOwnerHash ||
      (args.cleanupOwnerHash !== undefined &&
        ownerHash === args.cleanupOwnerHash)
    );
  },
});

export const hasTerminalStripeCleanupCustomerInternal = internalQuery({
  args: { locatorHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const tombstone = await ctx.db
      .query("billing_stripe_deletion_tombstones")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", args.locatorHash))
      .unique();
    return tombstone?.locatorKind === "customer";
  },
});

const finalizeLateStripeCleanupTuple = async (
  ctx: MutationCtx,
  receipt: Doc<"billing_stripe_physical_receipts">,
  now: number,
  disposition: { kind: "deleted" } | { kind: "retained"; resolutionId: string },
): Promise<void> => {
  await ctx.db.patch(
    receipt._id,
    disposition.kind === "deleted"
      ? {
          deletionCleanupTerminalized: true,
          cleanupResolutionId: undefined,
        }
      : {
          deletionCleanupTerminalized: undefined,
          cleanupResolutionId: disposition.resolutionId,
        },
  );
  const lateResults = await ctx.db
    .query("billing_stripe_late_results")
    .withIndex("by_tupleHash", (q) => q.eq("tupleHash", receipt.tupleHash))
    .take(2);
  if (lateResults.length > 1) {
    throw conflict("Stripe cleanup late-result tuple is duplicated.");
  }
  const lateResult = lateResults[0];
  if (!lateResult) return;
  await ctx.db.delete(lateResult._id);
  const operation = await readOperation(ctx, lateResult.operationId);
  if (
    operation?.manualDebtReason !== "late_result_conflict" ||
    operation.lateResultConflictAttemptId !== lateResult.attemptId
  ) {
    return;
  }
  const nextLateResult = await ctx.db
    .query("billing_stripe_late_results")
    .withIndex("by_operationId_and_createdAt", (q) =>
      q.eq("operationId", lateResult.operationId),
    )
    .first();
  await ctx.db.patch(operation._id, {
    manualDebtReason: nextLateResult ? "late_result_conflict" : undefined,
    lateResultConflictStep: nextLateResult?.step,
    lateResultConflictAttemptId: nextLateResult?.attemptId,
    lateResultRequestFingerprint: nextLateResult?.requestFingerprint,
    lateResultIdempotencyKey: nextLateResult?.idempotencyKey,
    lateResultProviderDeadlineAt: nextLateResult?.providerDeadlineAt,
    lateResultReconcileClaimId: nextLateResult?.reconcileClaimId,
    lateResultStripeCustomerId: nextLateResult?.stripeCustomerId,
    lateResultStripeCheckoutSessionId: nextLateResult?.stripeCheckoutSessionId,
    lateResultStripePortalSessionId: nextLateResult?.stripePortalSessionId,
    lateResultConflictAt: nextLateResult?.createdAt,
    lateResultConflictQuiescentAfterAt: nextLateResult?.quiescentAfterAt,
    lifecycleIntegrityVersion: undefined,
    updatedAt: now,
  });
};

export const markLateStripeCleanupTerminalInternal = internalMutation({
  args: {
    tupleHash: v.string(),
    locatorHash: v.string(),
    claimId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash_and_locatorHash", (q) =>
        q.eq("tupleHash", args.tupleHash).eq("locatorHash", args.locatorHash),
      )
      .unique();
    if (!row) return null;
    if (row.cleanupClaimId !== args.claimId) {
      throw conflict("Stripe cleanup claim changed before terminalization.");
    }
    if (!(await hasValidLateStripeCleanupRowProof(ctx, row))) {
      throw conflict("Stripe cleanup row proof is missing or changed.");
    }
    const physicalReceipts = await ctx.db
      .query("billing_stripe_physical_receipts")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", row.tupleHash))
      .take(2);
    if (
      physicalReceipts.length !== 1 ||
      physicalReceipts[0]!.providerOwnerHash !== row.providerOwnerHash ||
      physicalReceipts[0]!.successLocatorHash !== row.successLocatorHash
    ) {
      throw conflict("Stripe cleanup physical receipt is missing or changed.");
    }
    const terminal = await ctx.db
      .query("billing_stripe_deletion_tombstones")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", args.locatorHash))
      .unique();
    if (terminal && terminal.locatorKind !== row.locatorKind) {
      throw conflict("Stripe cleanup deletion tombstone kind changed.");
    }
    if (!terminal) {
      await ctx.db.insert("billing_stripe_deletion_tombstones", {
        locatorHash: row.locatorHash,
        locatorKind: row.locatorKind,
        createdAt: args.now,
      });
    }
    await ctx.db.delete(row._id);
    const remainingTupleLocator = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", row.tupleHash))
      .first();
    if (!remainingTupleLocator) {
      const cleanupResolutionId =
        physicalReceipts[0]!.cleanupResolutionId?.trim();
      if (
        cleanupResolutionId &&
        !(await hasMatchingLateStripeCleanupRetentionResolution(
          ctx,
          physicalReceipts[0]!,
        ))
      ) {
        throw conflict("Stripe cleanup retention audit is missing or changed.");
      }
      await finalizeLateStripeCleanupTuple(
        ctx,
        physicalReceipts[0]!,
        args.now,
        cleanupResolutionId
          ? { kind: "retained", resolutionId: cleanupResolutionId }
          : { kind: "deleted" },
      );
    }
    return null;
  },
});

export const resolveLateStripeCleanupRetentionInternal = internalMutation({
  args: {
    tupleHash: v.string(),
    successLocatorHash: v.string(),
    resolutionId: v.string(),
    resolvedBy: v.string(),
    evidence: v.string(),
    now: v.number(),
  },
  returns: v.object({
    resolution: v.literal("provider_resource_retained"),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const resolutionId = args.resolutionId.trim();
    const resolvedBy = args.resolvedBy.trim();
    const evidence = args.evidence.trim();
    if (
      !SAFE_ATTEMPT_ID.test(resolutionId) ||
      !SAFE_OPERATOR_ID.test(resolvedBy) ||
      !evidence ||
      evidence.length > MAX_MANUAL_RESOLUTION_EVIDENCE_LENGTH ||
      !/^[a-f0-9]{64}$/u.test(args.tupleHash) ||
      !/^[a-f0-9]{64}$/u.test(args.successLocatorHash)
    ) {
      throw conflict("Stripe cleanup retention audit is invalid.");
    }
    const [resolvedByHash, evidenceHash] = await Promise.all([
      stripeResolutionAuditHash("operator", resolvedBy),
      stripeResolutionAuditHash("evidence", evidence),
    ]);
    const existingById = await ctx.db
      .query("billing_stripe_late_cleanup_resolutions")
      .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
      .unique();
    if (existingById) {
      if (
        existingById.tupleHash !== args.tupleHash ||
        existingById.successLocatorHash !== args.successLocatorHash ||
        existingById.resolution !== "provider_resource_retained" ||
        existingById.resolvedByHash !== resolvedByHash ||
        existingById.evidenceHash !== evidenceHash
      ) {
        throw conflict("Stripe cleanup retention resolution changed.");
      }
      const replayReceipts = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", args.tupleHash))
        .take(2);
      if (
        replayReceipts.length !== 1 ||
        replayReceipts[0]!.cleanupResolutionId !== resolutionId ||
        !(await hasMatchingLateStripeCleanupRetentionResolution(
          ctx,
          replayReceipts[0]!,
        ))
      ) {
        throw conflict(
          "Stripe cleanup retention receipt is missing or changed.",
        );
      }
      return {
        resolution: "provider_resource_retained" as const,
        replayed: true,
      };
    }
    const existingForTuple = await ctx.db
      .query("billing_stripe_late_cleanup_resolutions")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", args.tupleHash))
      .take(2);
    if (existingForTuple.length > 1) {
      throw conflict("Stripe cleanup tuple was already resolved.");
    }
    const inheritedResolution = existingForTuple[0] ?? null;
    if (
      inheritedResolution &&
      inheritedResolution.resolutionId !== `retained-fence-${args.tupleHash}`
    ) {
      throw conflict("Stripe cleanup tuple was already resolved.");
    }
    const rows = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", args.tupleHash))
      .take(3);
    const failedRows = rows.filter((row) => row.attempts >= 1 && row.lastError);
    const failedCheckoutCustomerHashes = new Set(
      failedRows
        .filter((row) => row.locatorKind === "checkout_session")
        .map((row) => row.customerLocatorHash)
        .filter((value): value is string => value !== undefined),
    );
    if (
      rows.length === 0 ||
      rows.length > 2 ||
      failedRows.length === 0 ||
      rows.some(
        (row) =>
          row.successLocatorHash !== args.successLocatorHash ||
          (row.attempts >= 1 && !row.lastError) ||
          row.cleanupClaimId !== undefined ||
          (row.attempts < 1 &&
            !(
              row.locatorKind === "customer" &&
              row.checkoutBlocked === true &&
              failedCheckoutCustomerHashes.has(row.locatorHash)
            )),
      )
    ) {
      throw conflict(
        "Stripe cleanup retention requires exact failed provider debt.",
      );
    }
    for (const row of rows) {
      if (!(await hasValidLateStripeCleanupRowProof(ctx, row))) {
        throw conflict("Stripe cleanup row proof is missing or changed.");
      }
      const conflictingClaims = await ctx.db
        .query("billing_stripe_late_cleanup_locators")
        .withIndex("by_ownerHash_and_locatorHash", (q) =>
          q.eq("ownerHash", row.ownerHash).eq("locatorHash", row.locatorHash),
        )
        .take(3);
      if (
        conflictingClaims.some(
          (candidate) => candidate.cleanupClaimId !== undefined,
        )
      ) {
        throw conflict(
          "Stripe cleanup retention conflicts with an in-flight provider claim.",
        );
      }
      const deletionTombstone = await ctx.db
        .query("billing_stripe_deletion_tombstones")
        .withIndex("by_locatorHash", (q) =>
          q.eq("locatorHash", row.locatorHash),
        )
        .unique();
      if (deletionTombstone) {
        if (deletionTombstone.locatorKind !== row.locatorKind) {
          throw conflict("Stripe cleanup deletion tombstone kind changed.");
        }
        throw conflict(
          "Stripe cleanup resource is already deletion-terminal and cannot be retained.",
        );
      }
    }
    const receiptRows = await ctx.db
      .query("billing_stripe_physical_receipts")
      .withIndex("by_tupleHash", (q) => q.eq("tupleHash", args.tupleHash))
      .take(2);
    if (
      receiptRows.length !== 1 ||
      receiptRows[0]!.successLocatorHash !== args.successLocatorHash ||
      receiptRows[0]!.deletionCleanupTerminalized === true ||
      (inheritedResolution
        ? receiptRows[0]!.cleanupResolutionId !==
          inheritedResolution.resolutionId
        : receiptRows[0]!.cleanupResolutionId !== undefined)
    ) {
      throw conflict("Stripe cleanup physical receipt is missing or changed.");
    }
    const inheritedLocators = inheritedResolution
      ? await ctx.db
          .query("billing_stripe_retained_locators")
          .withIndex("by_resolutionId", (q) =>
            q.eq("resolutionId", inheritedResolution.resolutionId),
          )
          .take(3)
      : [];
    if (inheritedResolution) {
      const inheritedLocatorSetHash =
        await hashStripeRetainedLocatorSet(inheritedLocators);
      const [expectedSystemResolverHash, expectedSystemEvidenceHash] =
        await Promise.all([
          stripeResolutionAuditHash(
            "operator",
            "system-retained-locator-fence",
          ),
          stripeResolutionAuditHash(
            "evidence",
            `inherited-locator-set:${inheritedLocatorSetHash}`,
          ),
        ]);
      if (
        !(await hasMatchingLateStripeCleanupRetentionResolution(
          ctx,
          receiptRows[0]!,
        )) ||
        inheritedResolution.resolvedByHash !== expectedSystemResolverHash ||
        inheritedResolution.evidenceHash !== expectedSystemEvidenceHash
      ) {
        throw conflict("Stripe inherited cleanup retention audit changed.");
      }
    }
    const localLocators = await Promise.all(
      rows.map(
        async (row) =>
          await ctx.db
            .query("billing_owner_deletion_locators")
            .withIndex("by_locatorHash", (q) =>
              q.eq("locatorHash", row.locatorHash),
            )
            .unique(),
      ),
    );
    for (const [index, localLocator] of localLocators.entries()) {
      if (!localLocator) continue;
      const localOwnerHash = await ownershipMigrationSourceDigest(
        localLocator.ownerId,
      );
      if (
        localOwnerHash === rows[index]!.ownerHash &&
        localLocator.providerClaimId !== undefined
      ) {
        throw conflict(
          "Stripe cleanup retention conflicts with an in-flight provider claim.",
        );
      }
    }
    const retainedByHash = new Map(
      inheritedLocators.map((row) => [
        row.locatorHash,
        {
          locatorHash: row.locatorHash,
          locatorKind: row.locatorKind,
          ownerHash: row.ownerHash,
        },
      ]),
    );
    for (const row of rows) {
      const existing = retainedByHash.get(row.locatorHash);
      if (
        existing &&
        (existing.locatorKind !== row.locatorKind ||
          existing.ownerHash !== row.ownerHash)
      ) {
        throw conflict("Stripe retained cleanup locator changed.");
      }
      retainedByHash.set(row.locatorHash, {
        locatorHash: row.locatorHash,
        locatorKind: row.locatorKind,
        ownerHash: row.ownerHash,
      });
    }
    const retainedSet = [...retainedByHash.values()];
    if (
      retainedSet.length === 0 ||
      retainedSet.length > 2 ||
      new Set(retainedSet.map((row) => row.ownerHash)).size !== 1
    ) {
      throw conflict("Stripe retained cleanup locator set is invalid.");
    }
    const locatorSetHash = await hashStripeRetainedLocatorSet(retainedSet);
    if (inheritedResolution) {
      await ctx.db.delete(inheritedResolution._id);
      for (const locator of inheritedLocators) {
        await ctx.db.patch(locator._id, { resolutionId });
      }
    }
    await ctx.db.insert("billing_stripe_late_cleanup_resolutions", {
      tupleHash: args.tupleHash,
      successLocatorHash: args.successLocatorHash,
      resolutionId,
      resolution: "provider_resource_retained",
      locatorCount: retainedSet.length,
      locatorSetHash,
      resolvedByHash,
      evidenceHash,
      resolvedAt: args.now,
    });
    for (const [index, row] of rows.entries()) {
      const retainedRows = await ctx.db
        .query("billing_stripe_retained_locators")
        .withIndex("by_tupleHash_and_locatorHash", (q) =>
          q.eq("tupleHash", row.tupleHash).eq("locatorHash", row.locatorHash),
        )
        .take(2);
      if (retainedRows.length !== 0) {
        throw conflict("Stripe retained cleanup locator is duplicated.");
      }
      await ctx.db.insert("billing_stripe_retained_locators", {
        tupleHash: row.tupleHash,
        locatorHash: row.locatorHash,
        ownerHash: row.ownerHash,
        locatorKind: row.locatorKind,
        resolutionId,
        createdAt: args.now,
      });
      const localLocator = localLocators[index];
      if (localLocator) {
        const localOwnerHash = await ownershipMigrationSourceDigest(
          localLocator.ownerId,
        );
        if (localOwnerHash === row.ownerHash) {
          await ctx.db.delete(localLocator._id);
        }
      }
    }
    for (const row of rows) await ctx.db.delete(row._id);
    await finalizeLateStripeCleanupTuple(ctx, receiptRows[0]!, args.now, {
      kind: "retained",
      resolutionId,
    });
    return {
      resolution: "provider_resource_retained" as const,
      replayed: false,
    };
  },
});

export const recordLateStripeCleanupFailureInternal = internalMutation({
  args: {
    tupleHash: v.string(),
    locatorHash: v.string(),
    claimId: v.optional(v.string()),
    error: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_stripe_late_cleanup_locators")
      .withIndex("by_tupleHash_and_locatorHash", (q) =>
        q.eq("tupleHash", args.tupleHash).eq("locatorHash", args.locatorHash),
      )
      .unique();
    if (!row) return null;
    if (
      args.claimId !== undefined
        ? row.cleanupClaimId !== args.claimId
        : row.cleanupClaimExpiresAt !== undefined &&
          row.cleanupClaimExpiresAt > args.now
    ) {
      return null;
    }
    await ctx.db.patch(row._id, {
      attempts: row.attempts + 1,
      lastError: args.error.slice(0, 2_000),
      nextAttemptAt: args.now + 60_000,
      cleanupClaimId: undefined,
      cleanupClaimExpiresAt: undefined,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAt(args.now + 60_000, drainLateStripeCleanupRef, {});
    return null;
  },
});

export const scheduleLateStripeCleanupContinuationInternal = internalMutation({
  args: { delayMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delayMs = Math.max(0, Math.min(60_000, Math.trunc(args.delayMs)));
    await ctx.scheduler.runAfter(delayMs, drainLateStripeCleanupRef, {});
    return null;
  },
});

const isStripeCleanupResourceMissing = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.code === "resource_missing" || candidate.statusCode === 404;
};

/**
 * Global, owner-free cleanup for exact Stripe results that arrive only after
 * permanent owner deletion removed the original operation row. The scheduled
 * wake is backed by a periodic sweep, and every provider mutation is
 * idempotent/resource-missing safe.
 */
export const drainLateStripeCleanupInternal = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (let index = 0; index < 8; index += 1) {
      const row = await ctx.runQuery(getPendingLateStripeCleanupRef, {
        now: Date.now(),
      });
      if (!row) break;
      let cleanupClaimId: string | undefined;
      try {
        if (
          !(await ctx.runQuery(authorizeLateStripeCleanupRowRef, {
            tupleHash: row.tupleHash,
            locatorHash: row.locatorHash,
          }))
        ) {
          throw new Error("Stripe cleanup row proof is missing or changed.");
        }
        const candidateClaimId = crypto.randomUUID();
        const claimed = await ctx.runMutation(claimLateStripeCleanupRef, {
          tupleHash: row.tupleHash,
          locatorHash: row.locatorHash,
          claimId: candidateClaimId,
          now: Date.now(),
        });
        if (!claimed) continue;
        cleanupClaimId = candidateClaimId;
        const stripe = getStripeClient(STRIPE_LATE_CLEANUP_PROVIDER_TIMEOUT_MS);
        const requestOptions = {
          idempotencyKey: `stella-billing-late-delete-v1-${row.locatorHash}`,
        };
        if (row.locatorKind === "customer") {
          const customer = await stripe.customers.retrieve(row.locatorValue);
          if (!("deleted" in customer && customer.deleted)) {
            const providerOwnerId = customer.metadata?.ownerId?.trim();
            if (
              !providerOwnerId ||
              !(await ctx.runQuery(authorizeLateStripeCleanupProviderOwnerRef, {
                providerOwnerHash: row.providerOwnerHash,
                cleanupOwnerHash: row.ownerHash,
                providerOwnerId,
              }))
            ) {
              throw new Error(
                "Stripe cleanup customer metadata has no owner authority.",
              );
            }
            const claimRevalidated = await ctx.runMutation(
              revalidateLateStripeCleanupClaimRef,
              {
                tupleHash: row.tupleHash,
                locatorHash: row.locatorHash,
                claimId: cleanupClaimId,
                now: Date.now(),
              },
            );
            if (!claimRevalidated) continue;
            await stripe.customers.del(row.locatorValue, {}, requestOptions);
          }
        } else {
          const session = await stripe.checkout.sessions.retrieve(
            row.locatorValue,
          );
          const providerOwnerId = session.metadata?.ownerId?.trim();
          if (
            !providerOwnerId ||
            !(await ctx.runQuery(authorizeLateStripeCleanupProviderOwnerRef, {
              providerOwnerHash: row.providerOwnerHash,
              providerOwnerId,
            }))
          ) {
            throw new Error(
              "Stripe cleanup Checkout metadata has no owner authority.",
            );
          }
          if (session.status !== "open") {
            await ctx.runMutation(markLateStripeCleanupTerminalRef, {
              tupleHash: row.tupleHash,
              locatorHash: row.locatorHash,
              claimId: cleanupClaimId,
              now: Date.now(),
            });
            continue;
          }
          const attachedCustomerId =
            typeof session.customer === "string"
              ? session.customer
              : session.customer?.id;
          if (!attachedCustomerId) {
            throw new Error(
              "Stripe cleanup Checkout has no attached customer authority.",
            );
          }
          let attachedCustomer:
            | Stripe.Customer
            | Stripe.DeletedCustomer
            | null = null;
          try {
            attachedCustomer =
              await stripe.customers.retrieve(attachedCustomerId);
          } catch (error) {
            if (isStripeCleanupResourceMissing(error)) {
              const attachedCustomerLocatorHash =
                await hashStripeBillingLocator("customer", attachedCustomerId);
              const terminalCustomer = await ctx.runQuery(
                hasTerminalStripeCleanupCustomerRef,
                { locatorHash: attachedCustomerLocatorHash },
              );
              if (!terminalCustomer) {
                throw new Error(
                  "Stripe cleanup Checkout attached customer is missing.",
                );
              }
            } else {
              throw error;
            }
          }
          if (attachedCustomer) {
            if ("deleted" in attachedCustomer && attachedCustomer.deleted) {
              const attachedCustomerLocatorHash =
                await hashStripeBillingLocator("customer", attachedCustomerId);
              const terminalCustomer = await ctx.runQuery(
                hasTerminalStripeCleanupCustomerRef,
                { locatorHash: attachedCustomerLocatorHash },
              );
              if (!terminalCustomer) {
                throw new Error(
                  "Stripe cleanup Checkout customer authority was deleted.",
                );
              }
            } else {
              const attachedCustomerOwnerId =
                attachedCustomer.metadata?.ownerId?.trim();
              if (
                !attachedCustomerOwnerId ||
                !(await ctx.runQuery(
                  authorizeLateStripeCleanupProviderOwnerRef,
                  {
                    providerOwnerHash: row.providerOwnerHash,
                    cleanupOwnerHash: row.ownerHash,
                    providerOwnerId: attachedCustomerOwnerId,
                  },
                ))
              ) {
                throw new Error(
                  "Stripe cleanup Checkout customer has no owner authority.",
                );
              }
            }
          }
          try {
            const claimRevalidated = await ctx.runMutation(
              revalidateLateStripeCleanupClaimRef,
              {
                tupleHash: row.tupleHash,
                locatorHash: row.locatorHash,
                claimId: cleanupClaimId,
                now: Date.now(),
              },
            );
            if (!claimRevalidated) continue;
            await stripe.checkout.sessions.expire(
              row.locatorValue,
              {},
              requestOptions,
            );
          } catch (error) {
            if (!isStripeCleanupResourceMissing(error)) {
              const readback = await stripe.checkout.sessions.retrieve(
                row.locatorValue,
              );
              if (readback.status === "open") throw error;
            }
          }
        }
        await ctx.runMutation(markLateStripeCleanupTerminalRef, {
          tupleHash: row.tupleHash,
          locatorHash: row.locatorHash,
          claimId: cleanupClaimId,
          now: Date.now(),
        });
      } catch (error) {
        if (isStripeCleanupResourceMissing(error)) {
          await ctx.runMutation(markLateStripeCleanupTerminalRef, {
            tupleHash: row.tupleHash,
            locatorHash: row.locatorHash,
            claimId: cleanupClaimId!,
            now: Date.now(),
          });
          continue;
        }
        await ctx.runMutation(recordLateStripeCleanupFailureRef, {
          tupleHash: row.tupleHash,
          locatorHash: row.locatorHash,
          ...(cleanupClaimId ? { claimId: cleanupClaimId } : {}),
          error: error instanceof Error ? error.message : String(error),
          now: Date.now(),
        });
      }
    }
    // The action is intentionally bounded, but due work must make forward
    // progress even when more than one batch was waiting. A periodic cron
    // recovers a killed pre-claim action; this explicit continuation avoids a
    // full cron interval between immediately-due batches.
    const remainingDue = await ctx.runQuery(getPendingLateStripeCleanupRef, {
      now: Date.now(),
    });
    if (remainingDue) {
      await ctx.runMutation(scheduleLateStripeCleanupContinuationRef, {
        delayMs: 0,
      });
    }
    return null;
  },
});

const metadataTransferTupleMatches = (
  operation: StripeOperation,
  args: {
    stripeCustomerId: string;
    sourceOwnerId: string;
    destinationOwnerId: string;
    attemptId: string;
    idempotencyKey: string;
    providerDeadlineAt: number;
    quiescentAfterAt: number;
  },
): boolean =>
  operation.ownerId === args.sourceOwnerId &&
  operation.stripeCustomerId === args.stripeCustomerId &&
  operation.stripeCustomerMetadataTransferState === "may_have_dispatched" &&
  operation.stripeCustomerMetadataTransferToOwnerId ===
    args.destinationOwnerId &&
  operation.stripeCustomerMetadataTransferAttemptId === args.attemptId &&
  operation.stripeCustomerMetadataTransferIdempotencyKey ===
    args.idempotencyKey &&
  operation.stripeCustomerMetadataTransferProviderDeadlineAt ===
    args.providerDeadlineAt &&
  operation.stripeCustomerMetadataTransferQuiescentAfterAt ===
    args.quiescentAfterAt;

const hasLiveMetadataTransferMigration = async (
  ctx: MutationCtx,
  sourceOwnerId: string,
  destinationOwnerId: string,
): Promise<boolean> => {
  const migration = await ctx.db
    .query("auth_owner_migrations")
    .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
      q.eq("fromOwnerId", sourceOwnerId).eq("toOwnerId", destinationOwnerId),
    )
    .unique();
  return migration?.status === "pending" || migration?.status === "running";
};

/**
 * Owner-free recovery command for a transfer whose account-link workflow is
 * no longer live. It is available only after the original provider deadline
 * plus grace, and every provider call re-enters this exact mutation.
 */
export const getInactiveStripeMetadataTransferRecoveryInternal =
  internalMutation({
    args: { operationId: v.string(), now: v.number() },
    returns: v.union(
      v.null(),
      v.object({
        operationId: v.string(),
        stripeCustomerId: v.string(),
        sourceOwnerId: v.string(),
        destinationOwnerId: v.string(),
        attemptId: v.string(),
        idempotencyKey: v.string(),
        providerDeadlineAt: v.number(),
        quiescentAfterAt: v.number(),
        rollbackIdempotencyKey: v.string(),
      }),
    ),
    handler: async (ctx, args) => {
      const operation = await readOperation(ctx, args.operationId);
      if (
        !operation ||
        !(await hasValidatedStripeMetadataTransferAuthority(ctx, operation)) ||
        stripeMetadataTransferShape(operation) !== "active" ||
        operation.stripeCustomerMetadataTransferDebtReason !== undefined ||
        !operation.stripeCustomerId ||
        args.now < operation.stripeCustomerMetadataTransferQuiescentAfterAt!
      ) {
        return null;
      }
      const destinationOwnerId =
        operation.stripeCustomerMetadataTransferToOwnerId!;
      if (
        await hasLiveMetadataTransferMigration(
          ctx,
          operation.ownerId,
          destinationOwnerId,
        )
      ) {
        return null;
      }
      const rollbackHash = await hashSha256Hex(
        `stella-stripe-owner-transfer-rollback-v1\u0000${operation.operationId}\u0000${operation.stripeCustomerMetadataTransferAttemptId!}\u0000${operation.stripeCustomerMetadataTransferIdempotencyKey!}`,
      );
      return {
        operationId: operation.operationId,
        stripeCustomerId: operation.stripeCustomerId,
        sourceOwnerId: operation.ownerId,
        destinationOwnerId,
        attemptId: operation.stripeCustomerMetadataTransferAttemptId!,
        idempotencyKey: operation.stripeCustomerMetadataTransferIdempotencyKey!,
        providerDeadlineAt:
          operation.stripeCustomerMetadataTransferProviderDeadlineAt!,
        quiescentAfterAt:
          operation.stripeCustomerMetadataTransferQuiescentAfterAt!,
        rollbackIdempotencyKey: `stella-stripe-owner-transfer-rollback-v1-${rollbackHash}`,
      };
    },
  });

export const settleInactiveStripeMetadataTransferRecoveryInternal =
  internalMutation({
    args: {
      operationId: v.string(),
      stripeCustomerId: v.string(),
      sourceOwnerId: v.string(),
      destinationOwnerId: v.string(),
      attemptId: v.string(),
      idempotencyKey: v.string(),
      providerDeadlineAt: v.number(),
      quiescentAfterAt: v.number(),
      outcome: v.union(
        v.literal("source_restored"),
        v.literal("customer_deleted"),
        v.literal("foreign_owner"),
      ),
      now: v.number(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
      const operation = await readOperation(ctx, args.operationId);
      if (
        !operation ||
        !(await hasValidatedStripeMetadataTransferAuthority(ctx, operation)) ||
        !metadataTransferTupleMatches(operation, args) ||
        args.now < args.quiescentAfterAt ||
        (await hasLiveMetadataTransferMigration(
          ctx,
          args.sourceOwnerId,
          args.destinationOwnerId,
        ))
      ) {
        return false;
      }
      if (args.outcome === "source_restored") {
        await ctx.db.patch(operation._id, {
          stripeCustomerMetadataTransferState: "idle",
          stripeCustomerMetadataTransferToOwnerId: undefined,
          stripeCustomerMetadataTransferAttemptId: undefined,
          stripeCustomerMetadataTransferIdempotencyKey: undefined,
          stripeCustomerMetadataTransferProviderDeadlineAt: undefined,
          stripeCustomerMetadataTransferQuiescentAfterAt: undefined,
          stripeCustomerMetadataTransferDebtReason: undefined,
          lifecycleIntegrityVersion: undefined,
          updatedAt: args.now,
        });
      } else {
        await ctx.db.patch(operation._id, {
          stripeCustomerMetadataTransferDebtReason:
            args.outcome === "customer_deleted"
              ? "customer_deleted"
              : "foreign_owner",
          lifecycleIntegrityVersion: undefined,
          updatedAt: args.now,
        });
      }
      return true;
    },
  });

export const scheduleInactiveStripeMetadataTransferRecoveryInternal =
  internalMutation({
    args: { operationId: v.string(), delayMs: v.number() },
    returns: v.null(),
    handler: async (ctx, args) => {
      await ctx.scheduler.runAfter(
        Math.max(0, Math.min(60_000, Math.trunc(args.delayMs))),
        reconcileInactiveStripeMetadataTransferRef,
        { operationId: args.operationId },
      );
      return null;
    },
  });

export const reconcileInactiveStripeMetadataTransferInternal = internalAction({
  args: { operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const initial = await ctx.runMutation(
      getInactiveStripeMetadataTransferRecoveryRef,
      { operationId: args.operationId, now: Date.now() },
    );
    if (!initial) return null;
    const withAuthority = async <T>(
      call: (
        stripe: Stripe,
        command: NonNullable<typeof initial>,
      ) => Promise<T>,
    ): Promise<T> => {
      const command = await ctx.runMutation(
        getInactiveStripeMetadataTransferRecoveryRef,
        { operationId: args.operationId, now: Date.now() },
      );
      if (!command)
        throw conflict("Stripe metadata rollback authority changed.");
      return await call(getStripeClient(20_000), command);
    };
    const settle = async (
      outcome: "source_restored" | "customer_deleted" | "foreign_owner",
    ) =>
      await ctx.runMutation(settleInactiveStripeMetadataTransferRecoveryRef, {
        operationId: initial.operationId,
        stripeCustomerId: initial.stripeCustomerId,
        sourceOwnerId: initial.sourceOwnerId,
        destinationOwnerId: initial.destinationOwnerId,
        attemptId: initial.attemptId,
        idempotencyKey: initial.idempotencyKey,
        providerDeadlineAt: initial.providerDeadlineAt,
        quiescentAfterAt: initial.quiescentAfterAt,
        outcome,
        now: Date.now(),
      });
    try {
      const current = await withAuthority(
        async (stripe, command) =>
          await stripe.customers.retrieve(command.stripeCustomerId),
      );
      if ("deleted" in current && current.deleted) {
        await settle("customer_deleted");
        return null;
      }
      const currentOwnerId = current.metadata?.ownerId?.trim() ?? "";
      if (currentOwnerId === initial.sourceOwnerId) {
        await settle("source_restored");
        return null;
      }
      if (currentOwnerId !== initial.destinationOwnerId) {
        await settle("foreign_owner");
        return null;
      }
      await withAuthority(
        async (stripe, command) =>
          await stripe.customers.update(
            command.stripeCustomerId,
            { metadata: { ownerId: command.sourceOwnerId } },
            { idempotencyKey: command.rollbackIdempotencyKey },
          ),
      );
      const readback = await withAuthority(
        async (stripe, command) =>
          await stripe.customers.retrieve(command.stripeCustomerId),
      );
      if ("deleted" in readback && readback.deleted) {
        await settle("customer_deleted");
      } else if (
        (readback as Stripe.Customer).metadata?.ownerId?.trim() ===
        initial.sourceOwnerId
      ) {
        await settle("source_restored");
      } else {
        await settle("foreign_owner");
      }
    } catch (error) {
      console.error("[stripe] metadata transfer rollback will retry", {
        operationId: args.operationId,
        message: error instanceof Error ? error.message : String(error),
      });
      await ctx.runMutation(scheduleInactiveStripeMetadataTransferRecoveryRef, {
        operationId: args.operationId,
        delayMs: 60_000,
      });
    }
    return null;
  },
});

export const resolveStripeMetadataTransferDebtInternal = internalMutation({
  args: {
    operationId: v.string(),
    expectedAttemptId: v.string(),
    expectedSourceOwnerId: v.string(),
    expectedDestinationOwnerId: v.string(),
    resolutionId: v.string(),
    resolution: v.union(
      v.literal("provider_restored_source"),
      v.literal("provider_confirmed_deleted"),
    ),
    resolvedBy: v.string(),
    evidence: v.string(),
    now: v.number(),
  },
  returns: v.object({
    resolution: v.union(
      v.literal("provider_restored_source"),
      v.literal("provider_confirmed_deleted"),
    ),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const resolutionId = args.resolutionId.trim();
    const resolvedBy = args.resolvedBy.trim();
    const evidence = args.evidence.trim();
    const expectedSourceOwnerId = args.expectedSourceOwnerId.trim();
    const expectedDestinationOwnerId = args.expectedDestinationOwnerId.trim();
    if (
      !SAFE_ATTEMPT_ID.test(args.expectedAttemptId) ||
      !SAFE_ATTEMPT_ID.test(resolutionId) ||
      !SAFE_OPERATOR_ID.test(resolvedBy) ||
      !expectedSourceOwnerId ||
      !expectedDestinationOwnerId ||
      !evidence ||
      evidence.length > MAX_MANUAL_RESOLUTION_EVIDENCE_LENGTH
    ) {
      throw conflict(
        "Stripe metadata-transfer resolution evidence is invalid.",
      );
    }
    const [
      sourceOwnerHash,
      destinationOwnerHash,
      resolvedByHash,
      evidenceHash,
    ] = await Promise.all([
      ownershipMigrationSourceDigest(expectedSourceOwnerId),
      ownershipMigrationSourceDigest(expectedDestinationOwnerId),
      stripeResolutionAuditHash("operator", resolvedBy),
      stripeResolutionAuditHash("evidence", evidence),
    ]);
    const replay = await ctx.db
      .query("billing_stripe_metadata_transfer_resolutions")
      .withIndex("by_resolutionId", (q) => q.eq("resolutionId", resolutionId))
      .unique();
    if (replay) {
      if (
        replay.operationId !== args.operationId ||
        replay.transferAttemptId !== args.expectedAttemptId ||
        replay.resolution !== args.resolution ||
        replay.sourceOwnerHash !== sourceOwnerHash ||
        replay.destinationOwnerHash !== destinationOwnerHash ||
        replay.resolvedByHash !== resolvedByHash ||
        replay.evidenceHash !== evidenceHash
      ) {
        throw conflict("Stripe metadata-transfer resolution ID was reused.");
      }
      return { resolution: replay.resolution, replayed: true };
    }
    const operation = await readOperation(ctx, args.operationId);
    if (
      !operation ||
      !(await hasValidatedStripeMetadataTransferAuthority(ctx, operation)) ||
      stripeMetadataTransferShape(operation) !== "active" ||
      operation.stripeCustomerMetadataTransferAttemptId !==
        args.expectedAttemptId ||
      operation.ownerId !== expectedSourceOwnerId ||
      operation.stripeCustomerMetadataTransferToOwnerId !==
        expectedDestinationOwnerId ||
      operation.stripeCustomerMetadataTransferDebtReason === undefined ||
      !operation.stripeCustomerId ||
      args.now < operation.stripeCustomerMetadataTransferQuiescentAfterAt!
    ) {
      throw conflict("Stripe metadata-transfer debt is missing or changed.");
    }
    const destinationOwnerId =
      operation.stripeCustomerMetadataTransferToOwnerId!;
    if (
      await hasLiveMetadataTransferMigration(
        ctx,
        operation.ownerId,
        destinationOwnerId,
      )
    ) {
      throw conflict("Stripe metadata-transfer migration is still active.");
    }
    if (
      (operation.stripeCustomerMetadataTransferDebtReason ===
        "customer_deleted") !==
      (args.resolution === "provider_confirmed_deleted")
    ) {
      throw conflict("Stripe metadata-transfer resolution is incompatible.");
    }
    if (args.resolution === "provider_confirmed_deleted") {
      const locatorHash = await hashStripeBillingLocator(
        "customer",
        operation.stripeCustomerId,
      );
      const tombstone = await ctx.db
        .query("billing_stripe_deletion_tombstones")
        .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
        .unique();
      if (!tombstone) {
        await ctx.db.insert("billing_stripe_deletion_tombstones", {
          locatorHash,
          locatorKind: "customer",
          createdAt: args.now,
        });
      }
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", operation.ownerId))
        .unique();
      if (profile?.stripeCustomerId === operation.stripeCustomerId) {
        const nextCustomerAuthorityEpoch =
          (profile.stripeCustomerAuthorityEpoch ?? 0) + 1;
        await ctx.db.patch(profile._id, {
          activePlan: "free",
          subscriptionStatus: "customer_deleted",
          stripeCustomerId: "",
          stripeSubscriptionId: "",
          stripePriceId: "",
          defaultPaymentMethodId: "",
          paymentMethodBrand: "",
          paymentMethodLast4: "",
          currentPeriodStart: 0,
          currentPeriodEnd: 0,
          cancelAtPeriodEnd: false,
          stripeCustomerUpdatedAt: args.now,
          stripeCustomerEventId: undefined,
          stripeCustomerTerminal: true,
          stripeCustomerAuthorityEpoch: nextCustomerAuthorityEpoch,
          stripeCustomerCreateIdempotencyKey: undefined,
          stripeCustomerAdoptionScanEpoch: nextCustomerAuthorityEpoch,
          stripeSubscriptionTerminal: true,
          updatedAt: args.now,
        });
      }
    }
    await ctx.db.insert("billing_stripe_metadata_transfer_resolutions", {
      operationId: operation.operationId,
      transferAttemptId: args.expectedAttemptId,
      resolutionId,
      sourceOwnerHash,
      destinationOwnerHash,
      resolution: args.resolution,
      resolvedByHash,
      evidenceHash,
      resolvedAt: args.now,
    });
    await ctx.db.patch(operation._id, {
      stripeCustomerMetadataTransferState: "idle",
      stripeCustomerMetadataTransferToOwnerId: undefined,
      stripeCustomerMetadataTransferAttemptId: undefined,
      stripeCustomerMetadataTransferIdempotencyKey: undefined,
      stripeCustomerMetadataTransferProviderDeadlineAt: undefined,
      stripeCustomerMetadataTransferQuiescentAfterAt: undefined,
      stripeCustomerMetadataTransferDebtReason: undefined,
      lifecycleIntegrityVersion: undefined,
      updatedAt: args.now,
    });
    return { resolution: args.resolution, replayed: false };
  },
});

export type StripeOperationQuiescenceResult = {
  ready: boolean;
  pending: string[];
  retryAt: number | null;
};

/**
 * Transaction-safe lifecycle seam. It is intentionally owner-only so auth
 * migration can call it for both source and destination under its already
 * asserted migration lease. Marked steps never disappear: after the transport
 * grace they are replayed from the immutable receipt with the same Stripe
 * idempotency key while Stripe guarantees it. Beyond that bounded horizon the
 * worker uses exact metadata discovery, or retains explicit manual debt when
 * the provider has no exact lookup.
 */
export const quiesceOwnerStripeOperations = async (
  ctx: MutationCtx,
  args: { ownerId: string; now: number },
): Promise<StripeOperationQuiescenceResult> => {
  const [
    marked,
    ledgerLateResults,
    legacy,
    uncheckedIdle,
    previousIntegrity,
    unknownLowIntegrity,
    unknownMiddleIntegrity,
    unknownHighIntegrity,
    customerStepRows,
    checkoutStepRows,
    portalStepRows,
    lateConflicts,
    projectedCustomerRows,
    projectedCheckoutRows,
    projectedPortalRows,
    sourceMetadataTransfers,
    targetMetadataTransfers,
    unauditedCurrentRows,
  ] = await Promise.all([
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_dispatchState_and_quiescentAfterAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("dispatchState", "may_have_dispatched"),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_late_results")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_dispatchState_and_quiescentAfterAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("dispatchState", undefined),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("integrityVersion", undefined),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("integrityVersion", 1),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).lt("integrityVersion", 1),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .gt("integrityVersion", 1)
          .lt("integrityVersion", STRIPE_RECEIPT_INTEGRITY_VERSION),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .gt("integrityVersion", STRIPE_RECEIPT_INTEGRITY_VERSION),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_activeStep_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("activeStep", "customer_create"),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_activeStep_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("activeStep", "checkout_create"),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_activeStep_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("activeStep", "portal_create"),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_manualDebtReason_and_createdAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("manualDebtReason", "late_result_conflict"),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_lateResultCustomerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).gt("lateResultStripeCustomerId", ""),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_lateResultCheckoutId_and_createdAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .gt("lateResultStripeCheckoutSessionId", ""),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_lateResultPortalId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).gt("lateResultStripePortalSessionId", ""),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_metadataTransferState_and_createdAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("stripeCustomerMetadataTransferState", "may_have_dispatched"),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_metadataTransferToOwnerId_and_state_and_createdAt", (q) =>
        q
          .eq("stripeCustomerMetadataTransferToOwnerId", args.ownerId)
          .eq("stripeCustomerMetadataTransferState", "may_have_dispatched"),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
    ctx.db
      .query("billing_stripe_operations")
      .withIndex(
        "by_ownerId_and_lifecycleIntegrityVersion_and_createdAt",
        (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("lifecycleIntegrityVersion", undefined),
      )
      .take(MAX_OWNER_OPERATIONS_PER_PASS + 1),
  ]);
  const pending: string[] = [];
  const retryTimes: number[] = [];
  for (const operation of unauditedCurrentRows.slice(
    0,
    MAX_OWNER_OPERATIONS_PER_PASS,
  )) {
    if (operation.integrityVersion !== STRIPE_RECEIPT_INTEGRITY_VERSION) {
      continue;
    }
    if (!(await hasValidStripeOperationLifecycleAuditShape(ctx, operation))) {
      pending.push(`stripe_operation_malformed:${operation.operationId}`);
      continue;
    }
    await ctx.db.patch(operation._id, {
      lifecycleIntegrityVersion: 1,
      updatedAt: args.now,
    });
  }
  for (const row of ledgerLateResults.slice(0, MAX_OWNER_OPERATIONS_PER_PASS)) {
    pending.push(
      `stripe_operation_manual_reconciliation:late_result_conflict:${row.operationId}:${row.attemptId}`,
    );
    if (args.now < row.quiescentAfterAt) retryTimes.push(row.quiescentAfterAt);
  }
  const metadataTransfers = [
    ...sourceMetadataTransfers,
    ...targetMetadataTransfers,
  ].filter(
    (row, index, rows) =>
      rows.findIndex((candidate) => candidate._id === row._id) === index,
  );
  for (const operation of metadataTransfers.slice(
    0,
    MAX_OWNER_OPERATIONS_PER_PASS,
  )) {
    const shape = stripeMetadataTransferShape(operation);
    if (
      shape !== "active" ||
      !(await hasValidatedStripeMetadataTransferAuthority(ctx, operation))
    ) {
      pending.push(
        `stripe_customer_metadata_transfer_malformed:${operation.operationId}`,
      );
      continue;
    }
    const quiescentAfterAt =
      operation.stripeCustomerMetadataTransferQuiescentAfterAt!;
    if (operation.stripeCustomerMetadataTransferDebtReason) {
      pending.push(
        `stripe_customer_metadata_transfer_manual_reconciliation:${operation.stripeCustomerMetadataTransferDebtReason}:${operation.operationId}`,
      );
      continue;
    }
    pending.push(
      `${
        args.now < quiescentAfterAt
          ? "stripe_customer_metadata_transfer_dispatching"
          : "stripe_customer_metadata_transfer_outcome_unknown"
      }:${operation.operationId}`,
    );
    if (args.now < quiescentAfterAt) {
      retryTimes.push(quiescentAfterAt);
      continue;
    }
    // The ownership-migration state machine owns exact provider readback and
    // commit for this tuple. Its durable watchdog is the primary recovery;
    // lifecycle quiescence also republishes a lost wake once the physical
    // deadline is hard-quiescent. No deletion is allowed to infer success.
    const migration = await ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
        q
          .eq("fromOwnerId", operation.ownerId)
          .eq("toOwnerId", operation.stripeCustomerMetadataTransferToOwnerId!),
      )
      .unique();
    if (migration?.status === "pending") {
      await ctx.scheduler.runAfter(0, resumeOwnershipMigrationRef, {
        fromOwnerId: migration.fromOwnerId,
        toOwnerId: migration.toOwnerId,
      });
      retryTimes.push(args.now + 1_000);
    } else if (migration?.status === "running") {
      const leaseExpiresAt = migration.leaseExpiresAt ?? args.now;
      if (leaseExpiresAt <= args.now) {
        await ctx.scheduler.runAfter(0, resumeOwnershipMigrationRef, {
          fromOwnerId: migration.fromOwnerId,
          toOwnerId: migration.toOwnerId,
          ...(migration.leaseGeneration !== undefined
            ? { expectedLeaseGeneration: migration.leaseGeneration }
            : {}),
        });
        retryTimes.push(args.now + 1_000);
      } else {
        retryTimes.push(leaseExpiresAt);
      }
    } else {
      // The account-link workflow is terminal or absent, so it can no longer
      // commit destination ownership. Reconcile the exact remote customer
      // owner back to the still-local source before reset/delete proceeds.
      await ctx.scheduler.runAfter(
        0,
        reconcileInactiveStripeMetadataTransferRef,
        { operationId: operation.operationId },
      );
      retryTimes.push(args.now + 1_000);
    }
  }
  for (const operation of marked.slice(0, MAX_OWNER_OPERATIONS_PER_PASS)) {
    if (
      !(await ensureCurrentStripeOperationIntegrity(ctx, operation, args.now))
    ) {
      pending.push(`stripe_operation_malformed:${operation.operationId}`);
      continue;
    }
    if (
      !operation.activeAttemptId ||
      !operation.activeStep ||
      !operation.activeRequestJson ||
      !operation.activeRequestFingerprint ||
      !operation.activeIdempotencyKey ||
      operation.providerDeadlineAt === undefined
    ) {
      pending.push(`stripe_operation_malformed:${operation.operationId}`);
      continue;
    }
    if (
      !hasCompleteActiveDispatchFields(operation) ||
      !(await hasMatchingStripePhysicalReceipt(ctx, {
        operationId: operation.operationId,
        attemptId: operation.activeAttemptId,
        step: operation.activeStep,
        requestFingerprint: operation.activeRequestFingerprint,
        idempotencyKey: operation.activeIdempotencyKey,
        providerDeadlineAt: operation.providerDeadlineAt,
      }))
    ) {
      pending.push(`stripe_operation_malformed:${operation.operationId}`);
      continue;
    }
    const automaticReplayUntilAt =
      operation.providerDeadlineAt -
      STRIPE_PROVIDER_TIMEOUT_MS +
      STRIPE_IDEMPOTENCY_REPLAY_HORIZON_MS;
    const beyondIdempotencyHorizon = args.now >= automaticReplayUntilAt;
    if (operation.manualDebtReason) {
      if (
        operation.reconcileClaimId &&
        operation.reconcileClaimExpiresAt !== undefined
      ) {
        if (args.now < operation.reconcileClaimExpiresAt) {
          retryTimes.push(operation.reconcileClaimExpiresAt);
        } else {
          await ctx.db.patch(operation._id, {
            reconcileClaimId: undefined,
            reconcileClaimExpiresAt: undefined,
            updatedAt: args.now,
          });
        }
      }
      pending.push(
        `stripe_operation_manual_reconciliation:${operation.manualDebtReason}:${operation.operationId}`,
      );
      continue;
    }
    const quiescentAfterAt =
      operation.quiescentAfterAt ?? operation.leaseExpiresAt;
    if (args.now < quiescentAfterAt) {
      pending.push(
        `${
          beyondIdempotencyHorizon
            ? "stripe_operation_discovery_wait"
            : "stripe_operation_dispatching"
        }:${operation.operationId}`,
      );
      retryTimes.push(quiescentAfterAt);
      continue;
    }
    if (
      operation.reconcileClaimId &&
      operation.reconcileClaimExpiresAt !== undefined &&
      args.now < operation.reconcileClaimExpiresAt
    ) {
      pending.push(`stripe_operation_reconciling:${operation.operationId}`);
      retryTimes.push(operation.reconcileClaimExpiresAt);
      continue;
    }
    if (beyondIdempotencyHorizon && operation.activeStep === "portal_create") {
      await ctx.db.patch(operation._id, {
        manualDebtReason: "portal_lookup_unavailable",
        reconcileClaimId: undefined,
        reconcileClaimExpiresAt: undefined,
        updatedAt: args.now,
      });
      pending.push(
        `stripe_operation_manual_reconciliation:portal_lookup_unavailable:${operation.operationId}`,
      );
      continue;
    }
    const nextReconcileAt =
      operation.nextReconcileAt ??
      operation.quiescentAfterAt ??
      quiescentAfterAt;
    if (args.now < nextReconcileAt) {
      pending.push(`stripe_operation_reconcile_wait:${operation.operationId}`);
      retryTimes.push(nextReconcileAt);
      continue;
    }
    await ctx.scheduler.runAfter(0, reconcileActionRef, {
      operationId: operation.operationId,
      attemptId: operation.activeAttemptId,
    });
    pending.push(
      `${
        beyondIdempotencyHorizon
          ? "stripe_operation_discovering"
          : "stripe_operation_reconciling"
      }:${operation.operationId}`,
    );
    retryTimes.push(args.now + STRIPE_RECONCILE_RETRY_MS);
  }
  const integrityRows = [
    ...uncheckedIdle,
    ...previousIntegrity,
    ...unknownLowIntegrity,
    ...unknownMiddleIntegrity,
    ...unknownHighIntegrity,
    ...projectedCustomerRows,
    ...projectedCheckoutRows,
    ...projectedPortalRows,
  ].filter(
    (row, index, rows) =>
      rows.findIndex((candidate) => candidate._id === row._id) === index,
  );
  const scannedIntegrityIds = new Set<string>();
  for (const operation of integrityRows.slice(
    0,
    MAX_OWNER_OPERATIONS_PER_PASS,
  )) {
    if (
      operation.dispatchState === undefined &&
      operation.state === "reserved" &&
      hasLegacyStripeOperationIntegrityVersion(operation)
    ) {
      // The coarse pre-rollout lease cannot prove that provider I/O did not
      // cross the boundary. Leave this exact subset for the legacy debt path.
      continue;
    }
    scannedIntegrityIds.add(operation._id);
    const mayNormalizeLegacyTerminal =
      operation.dispatchState === undefined &&
      operation.state !== "reserved" &&
      hasLegacyStripeOperationIntegrityVersion(operation);
    if (operation.dispatchState === undefined && !mayNormalizeLegacyTerminal) {
      pending.push(`stripe_operation_malformed:${operation.operationId}`);
      continue;
    }
    const normalizedOperation = mayNormalizeLegacyTerminal
      ? ({
          ...operation,
          dispatchState: "idle" as const,
        } satisfies StripeOperation)
      : operation;
    if (
      !(await ensureCurrentStripeOperationIntegrity(
        ctx,
        normalizedOperation,
        args.now,
        { strictTransport: true, allowManualDebt: true },
      ))
    ) {
      pending.push(`stripe_operation_malformed:${operation.operationId}`);
      continue;
    }
    await ctx.db.patch(operation._id, {
      ...(mayNormalizeLegacyTerminal ? { dispatchState: "idle" as const } : {}),
      lifecycleIntegrityVersion: 1,
      updatedAt: args.now,
    });
  }
  const orphanedActiveSteps = [
    ...customerStepRows,
    ...checkoutStepRows,
    ...portalStepRows,
  ].filter(
    (row, index, rows) =>
      row.dispatchState !== "may_have_dispatched" &&
      rows.findIndex((candidate) => candidate._id === row._id) === index,
  );
  for (const operation of orphanedActiveSteps.slice(
    0,
    MAX_OWNER_OPERATIONS_PER_PASS,
  )) {
    pending.push(`stripe_operation_malformed:${operation.operationId}`);
  }
  if (
    integrityRows.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    previousIntegrity.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    unknownLowIntegrity.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    unknownMiddleIntegrity.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    unknownHighIntegrity.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    projectedCustomerRows.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    projectedCheckoutRows.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    projectedPortalRows.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    customerStepRows.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    checkoutStepRows.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    portalStepRows.length > MAX_OWNER_OPERATIONS_PER_PASS
  ) {
    pending.push("stripe_operation_integrity_scan:additional_rows");
    retryTimes.push(args.now);
  }
  for (const operation of lateConflicts.slice(
    0,
    MAX_OWNER_OPERATIONS_PER_PASS,
  )) {
    pending.push(
      `stripe_operation_manual_reconciliation:late_result_conflict:${operation.operationId}`,
    );
    if (
      operation.lateResultConflictQuiescentAfterAt !== undefined &&
      args.now < operation.lateResultConflictQuiescentAfterAt
    ) {
      retryTimes.push(operation.lateResultConflictQuiescentAfterAt);
    }
  }
  // Pre-rollout rows had only a coarse lease. Query that exact optional-field
  // subset rather than repeatedly rereading modern idle receipts. Safe legacy
  // terminal rows are normalized in bounded batches, so every immediate retry
  // advances the scan.
  for (const operation of legacy.slice(0, MAX_OWNER_OPERATIONS_PER_PASS)) {
    if (scannedIntegrityIds.has(operation._id)) continue;
    if (!hasLegacyStripeOperationIntegrityVersion(operation)) {
      pending.push(`stripe_operation_malformed:${operation.operationId}`);
      continue;
    }
    if (
      hasUnexpectedIdleDispatchFields(operation, { allowManualDebt: true }) ||
      (operation.manualDebtReason !== undefined &&
        operation.manualDebtReason !== "legacy_missing_receipt")
    ) {
      pending.push(`stripe_operation_malformed:${operation.operationId}`);
      continue;
    }
    if (operation.manualDebtReason === "legacy_missing_receipt") {
      pending.push(
        `stripe_operation_legacy_manual_reconciliation:${operation.operationId}`,
      );
      continue;
    }
    if (operation.state !== "reserved") {
      const normalizedOperation = {
        ...operation,
        dispatchState: "idle" as const,
      } satisfies StripeOperation;
      if (
        !(await ensureCurrentStripeOperationIntegrity(
          ctx,
          normalizedOperation,
          args.now,
          { strictTransport: true, allowManualDebt: true },
        ))
      ) {
        pending.push(`stripe_operation_malformed:${operation.operationId}`);
        continue;
      }
      await ctx.db.patch(operation._id, {
        dispatchState: "idle",
        lifecycleIntegrityVersion: 1,
        updatedAt: args.now,
      });
      continue;
    }
    if (operation.leaseExpiresAt > args.now) {
      pending.push(`stripe_operation_legacy_dispatch:${operation.operationId}`);
      retryTimes.push(operation.leaseExpiresAt);
    } else {
      // Pre-rollout rows do not contain the exact frozen provider request.
      // Synthesizing parameters and replaying their key can create a second
      // resource or idempotency mismatch, so lifecycle work fails closed.
      if (operation.manualDebtReason !== "legacy_missing_receipt") {
        await ctx.db.patch(operation._id, {
          manualDebtReason: "legacy_missing_receipt",
          updatedAt: args.now,
        });
      }
      pending.push(
        `stripe_operation_legacy_manual_reconciliation:${operation.operationId}`,
      );
    }
  }
  if (
    marked.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    legacy.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    lateConflicts.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    ledgerLateResults.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    sourceMetadataTransfers.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    targetMetadataTransfers.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    unauditedCurrentRows.length > MAX_OWNER_OPERATIONS_PER_PASS ||
    orphanedActiveSteps.length > MAX_OWNER_OPERATIONS_PER_PASS
  ) {
    pending.push("stripe_operation_dispatch:additional_rows");
    retryTimes.push(args.now);
  }
  const uniquePending = [...new Set(pending)].slice(0, MAX_PENDING_LABELS);
  return {
    ready: uniquePending.length === 0,
    pending: uniquePending,
    retryAt:
      uniquePending.length === 0 || retryTimes.length === 0
        ? null
        : Math.min(...retryTimes),
  };
};

const convergeRecoveredStripeCustomerForReset = async (
  ctx: MutationCtx,
  args: { ownerId: string; now: number },
): Promise<StripeOperationQuiescenceResult> => {
  const profile = await ctx.db
    .query("billing_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
    .unique();
  if (!profile) {
    const [operation, lateResult] = await Promise.all([
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
    ]);
    if (!operation && !lateResult) {
      return { ready: true, pending: [], retryAt: null };
    }
    return {
      ready: false,
      pending: ["stripe_customer_adoption:missing_profile"],
      retryAt: null,
    };
  }
  const authorityEpoch = profile.stripeCustomerAuthorityEpoch ?? 0;
  const scanEpoch = profile.stripeCustomerAdoptionScanEpoch ?? -1;
  if (
    !Number.isSafeInteger(authorityEpoch) ||
    authorityEpoch < 0 ||
    !Number.isSafeInteger(scanEpoch) ||
    scanEpoch < -1 ||
    scanEpoch > authorityEpoch
  ) {
    return {
      ready: false,
      pending: ["stripe_customer_adoption:malformed_epoch"],
      retryAt: null,
    };
  }
  if (scanEpoch === authorityEpoch) {
    return { ready: true, pending: [], retryAt: null };
  }
  const operations = await ctx.db
    .query("billing_stripe_operations")
    .withIndex(
      "by_ownerId_and_stripeCustomerAuthorityEpoch_and_createdAt",
      (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq(
            "stripeCustomerAuthorityEpoch",
            scanEpoch === -1 ? undefined : scanEpoch,
          ),
    )
    .take(MAX_OWNER_OPERATIONS_PER_PASS + 1);
  const canonicalCustomerCreateIdempotencyKey =
    await resolvePinnedStripeCustomerAuthorityKey(ctx, {
      profile,
      ownerId: args.ownerId,
      authorityEpoch,
      now: args.now,
    });
  for (const operation of operations.slice(0, MAX_OWNER_OPERATIONS_PER_PASS)) {
    const stripeCustomerId = operation.stripeCustomerId?.trim();
    if (stripeCustomerId) {
      const status = await convergeStripeCustomerProfile(ctx, {
        ownerId: args.ownerId,
        stripeCustomerId,
        now: args.now,
      });
      if (status === "missing_profile") {
        return {
          ready: false,
          pending: ["stripe_customer_adoption:missing_profile"],
          retryAt: null,
        };
      }
      if (status === "deleted_customer" || status === "stale_authority") {
        // Never promote a revoked operation into the current customer epoch.
        // The profile's deletion projection normally closes the adoption scan
        // at the new epoch; this fail-closed branch covers rolling or manually
        // repaired data without reviving an old provider key.
        return {
          ready: false,
          pending: [`stripe_customer_adoption:${status}`],
          retryAt: null,
        };
      }
      if (status === "conflicting_customer" || status === "foreign_customer") {
        throw conflict(
          status === "foreign_customer"
            ? "Stripe customer is linked to another owner."
            : "Account already has a different active Stripe customer.",
        );
      }
    }
    await ctx.db.patch(operation._id, {
      stripeCustomerAuthorityEpoch: authorityEpoch,
      stripeCustomerCreateIdempotencyKey: canonicalCustomerCreateIdempotencyKey,
      updatedAt: args.now,
    });
  }
  if (operations.length > MAX_OWNER_OPERATIONS_PER_PASS) {
    return {
      ready: false,
      pending: ["stripe_customer_adoption:additional_rows"],
      retryAt: args.now,
    };
  }
  const nextScanEpoch = scanEpoch + 1;
  await ctx.db.patch(profile._id, {
    stripeCustomerAdoptionScanEpoch: nextScanEpoch,
    updatedAt: args.now,
  });
  return nextScanEpoch === authorityEpoch
    ? { ready: true, pending: [], retryAt: null }
    : {
        ready: false,
        pending: ["stripe_customer_adoption:next_epoch"],
        retryAt: args.now,
      };
};

export const quiesceOwnerStripeOperationsForPurgeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: v.union(v.literal("reset"), v.literal("delete")),
    now: v.number(),
  },
  returns: pendingResultValidator,
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, { ...args, stage: "core" });
    const dispatches = await quiesceOwnerStripeOperations(ctx, args);
    if (!dispatches.ready || args.mode === "delete") return dispatches;
    // Backfill receipts settled before customer/profile convergence became
    // atomic. Reset may advance only after the one exact recovered locator is
    // visible to future logical requestIds.
    return await convergeRecoveredStripeCustomerForReset(ctx, args);
  },
});

export const remainingOwnerStripeOperationDispatchesInternal = internalQuery({
  args: { ownerId: v.string(), now: v.number() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const [
      marked,
      lateConflicts,
      projectedCustomerRows,
      projectedCheckoutRows,
      projectedPortalRows,
      ledgerLateResults,
      legacy,
      uncheckedIdle,
      previousIntegrity,
      unknownLowIntegrity,
      unknownMiddleIntegrity,
      unknownHighIntegrity,
      customerStepRows,
      checkoutStepRows,
      portalStepRows,
      sourceMetadataTransfers,
      targetMetadataTransfers,
      unauditedCurrentRows,
    ] = await Promise.all([
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_dispatchState_and_quiescentAfterAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("dispatchState", "may_have_dispatched"),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_manualDebtReason_and_createdAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("manualDebtReason", "late_result_conflict"),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_lateResultCustomerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).gt("lateResultStripeCustomerId", ""),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_lateResultCheckoutId_and_createdAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .gt("lateResultStripeCheckoutSessionId", ""),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_lateResultPortalId_and_createdAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .gt("lateResultStripePortalSessionId", ""),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_late_results")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_dispatchState_and_quiescentAfterAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("dispatchState", undefined),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("integrityVersion", undefined),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("integrityVersion", 1),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).lt("integrityVersion", 1),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .gt("integrityVersion", 1)
            .lt("integrityVersion", STRIPE_RECEIPT_INTEGRITY_VERSION),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_integrityVersion_and_createdAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .gt("integrityVersion", STRIPE_RECEIPT_INTEGRITY_VERSION),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_activeStep_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("activeStep", "customer_create"),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_activeStep_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("activeStep", "checkout_create"),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_activeStep_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("activeStep", "portal_create"),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex("by_ownerId_and_metadataTransferState_and_createdAt", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("stripeCustomerMetadataTransferState", "may_have_dispatched"),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex(
          "by_metadataTransferToOwnerId_and_state_and_createdAt",
          (q) =>
            q
              .eq("stripeCustomerMetadataTransferToOwnerId", args.ownerId)
              .eq("stripeCustomerMetadataTransferState", "may_have_dispatched"),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("billing_stripe_operations")
        .withIndex(
          "by_ownerId_and_lifecycleIntegrityVersion_and_createdAt",
          (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("lifecycleIntegrityVersion", undefined),
        )
        .take(MAX_PENDING_LABELS + 1),
    ]);
    const labels: string[] = [];
    for (const row of unauditedCurrentRows.slice(0, MAX_PENDING_LABELS)) {
      if (row.integrityVersion !== STRIPE_RECEIPT_INTEGRITY_VERSION) continue;
      labels.push(
        (await hasValidStripeOperationLifecycleAuditShape(ctx, row))
          ? `stripe_operation_integrity_unchecked:${row.operationId}`
          : `stripe_operation_malformed:${row.operationId}`,
      );
    }
    for (const row of marked.slice(0, MAX_PENDING_LABELS)) {
      if (
        (row.integrityVersion !== STRIPE_RECEIPT_INTEGRITY_VERSION &&
          row.integrityVersion !== 2) ||
        !hasValidStripeOperationStateLocators(row) ||
        !hasCompleteActiveDispatchFields(row)
      ) {
        labels.push(`stripe_operation_malformed:${row.operationId}`);
        continue;
      }
      const tupleHash = await hashStripeDeletedOperationTuple({
        operationId: row.operationId,
        attemptId: row.activeAttemptId!,
        step: row.activeStep!,
        requestFingerprint: row.activeRequestFingerprint!,
        idempotencyKey: row.activeIdempotencyKey!,
        providerDeadlineAt: row.providerDeadlineAt!,
      });
      const receipts = await ctx.db
        .query("billing_stripe_physical_receipts")
        .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
        .take(2);
      if (
        receipts.length !== 1 ||
        receipts[0]!.operationId !== row.operationId
      ) {
        labels.push(`stripe_operation_malformed:${row.operationId}`);
        continue;
      }
      labels.push(
        row.integrityVersion === STRIPE_RECEIPT_INTEGRITY_VERSION
          ? `stripe_operation_${row.activeStep}:${row.operationId}`
          : `stripe_operation_integrity_unchecked:${row.operationId}`,
      );
    }
    for (const row of legacy.slice(0, MAX_PENDING_LABELS)) {
      if (
        hasUnexpectedIdleDispatchFields(row, { allowManualDebt: true }) ||
        (row.manualDebtReason !== undefined &&
          row.manualDebtReason !== "legacy_missing_receipt")
      ) {
        labels.push(`stripe_operation_malformed:${row.operationId}`);
      } else if (row.manualDebtReason === "legacy_missing_receipt") {
        labels.push(
          `stripe_operation_legacy_manual_reconciliation:${row.operationId}`,
        );
      } else if (row.state === "reserved") {
        labels.push(
          `${
            row.leaseExpiresAt > args.now
              ? "stripe_operation_legacy_dispatch"
              : "stripe_operation_legacy_manual_reconciliation"
          }:${row.operationId}`,
        );
      }
    }
    const integrityRows = [
      ...uncheckedIdle,
      ...previousIntegrity,
      ...unknownLowIntegrity,
      ...unknownMiddleIntegrity,
      ...unknownHighIntegrity,
      ...projectedCustomerRows,
      ...projectedCheckoutRows,
      ...projectedPortalRows,
    ].filter(
      (row, index, rows) =>
        rows.findIndex((candidate) => candidate._id === row._id) === index,
    );
    for (const row of integrityRows.slice(0, MAX_PENDING_LABELS)) {
      if (
        row.integrityVersion !== undefined &&
        row.integrityVersion !== 1 &&
        row.integrityVersion !== 2 &&
        row.integrityVersion !== STRIPE_RECEIPT_INTEGRITY_VERSION
      ) {
        labels.push(`stripe_operation_malformed:${row.operationId}`);
      } else if (!hasValidStripeOperationStateLocators(row)) {
        labels.push(`stripe_operation_malformed:${row.operationId}`);
      } else if (row.dispatchState === "may_have_dispatched") {
        if (!hasCompleteActiveDispatchFields(row)) {
          labels.push(`stripe_operation_malformed:${row.operationId}`);
        } else {
          const tupleHash = await hashStripeDeletedOperationTuple({
            operationId: row.operationId,
            attemptId: row.activeAttemptId!,
            step: row.activeStep!,
            requestFingerprint: row.activeRequestFingerprint!,
            idempotencyKey: row.activeIdempotencyKey!,
            providerDeadlineAt: row.providerDeadlineAt!,
          });
          const receipts = await ctx.db
            .query("billing_stripe_physical_receipts")
            .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
            .take(2);
          labels.push(
            receipts.length === 1 &&
              receipts[0]!.operationId === row.operationId
              ? `stripe_operation_integrity_unchecked:${row.operationId}`
              : `stripe_operation_malformed:${row.operationId}`,
          );
        }
      } else if (
        row.dispatchState === undefined &&
        row.manualDebtReason === "legacy_missing_receipt" &&
        !hasUnexpectedIdleDispatchFields(row, { allowManualDebt: true })
      ) {
        labels.push(
          `stripe_operation_legacy_manual_reconciliation:${row.operationId}`,
        );
      } else if (stripeHistoricalResultShape(row) === "malformed") {
        labels.push(`stripe_operation_malformed:${row.operationId}`);
      } else if (hasUnexpectedIdleDispatchFields(row)) {
        labels.push(`stripe_operation_malformed:${row.operationId}`);
      } else {
        const historicalShape = stripeHistoricalResultShape(row);
        if (historicalShape === "complete") {
          const tupleHash = await hashStripeDeletedOperationTuple({
            operationId: row.operationId,
            attemptId: row.lastStripeAttemptId!,
            step: row.lastStripeStep!,
            requestFingerprint: row.lastStripeRequestFingerprint!,
            idempotencyKey: row.lastStripeIdempotencyKey!,
            providerDeadlineAt: row.lastStripeProviderDeadlineAt!,
          });
          const receipts = await ctx.db
            .query("billing_stripe_physical_receipts")
            .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
            .take(2);
          labels.push(
            receipts.length === 1 &&
              receipts[0]!.operationId === row.operationId
              ? `stripe_operation_integrity_unchecked:${row.operationId}`
              : `stripe_operation_malformed:${row.operationId}`,
          );
        } else {
          labels.push(
            `stripe_operation_integrity_unchecked:${row.operationId}`,
          );
        }
      }
    }
    const orphanedActiveSteps = [
      ...customerStepRows,
      ...checkoutStepRows,
      ...portalStepRows,
    ].filter(
      (row, index, rows) =>
        row.dispatchState !== "may_have_dispatched" &&
        rows.findIndex((candidate) => candidate._id === row._id) === index,
    );
    for (const row of orphanedActiveSteps.slice(0, MAX_PENDING_LABELS)) {
      labels.push(`stripe_operation_malformed:${row.operationId}`);
    }
    for (const row of lateConflicts.slice(0, MAX_PENDING_LABELS)) {
      labels.push(
        `stripe_operation_manual_reconciliation:late_result_conflict:${row.operationId}`,
      );
    }
    for (const row of ledgerLateResults.slice(0, MAX_PENDING_LABELS)) {
      labels.push(
        `stripe_operation_manual_reconciliation:late_result_conflict:${row.operationId}:${row.attemptId}`,
      );
    }
    const metadataTransfers = [
      ...sourceMetadataTransfers,
      ...targetMetadataTransfers,
    ].filter(
      (row, index, rows) =>
        rows.findIndex((candidate) => candidate._id === row._id) === index,
    );
    for (const row of metadataTransfers.slice(0, MAX_PENDING_LABELS)) {
      labels.push(
        stripeMetadataTransferShape(row) !== "active"
          ? `stripe_customer_metadata_transfer_malformed:${row.operationId}`
          : row.stripeCustomerMetadataTransferDebtReason
            ? `stripe_customer_metadata_transfer_manual_reconciliation:${row.stripeCustomerMetadataTransferDebtReason}:${row.operationId}`
            : `stripe_customer_metadata_transfer:${row.operationId}`,
      );
    }
    if (
      marked.length > MAX_PENDING_LABELS ||
      legacy.length > MAX_PENDING_LABELS ||
      lateConflicts.length > MAX_PENDING_LABELS ||
      projectedCustomerRows.length > MAX_PENDING_LABELS ||
      projectedCheckoutRows.length > MAX_PENDING_LABELS ||
      projectedPortalRows.length > MAX_PENDING_LABELS ||
      ledgerLateResults.length > MAX_PENDING_LABELS ||
      sourceMetadataTransfers.length > MAX_PENDING_LABELS ||
      targetMetadataTransfers.length > MAX_PENDING_LABELS ||
      customerStepRows.length > MAX_PENDING_LABELS ||
      checkoutStepRows.length > MAX_PENDING_LABELS ||
      portalStepRows.length > MAX_PENDING_LABELS ||
      unauditedCurrentRows.length > MAX_PENDING_LABELS
    ) {
      labels.push("stripe_operation_dispatch:additional_rows");
    }
    if (
      integrityRows.length > MAX_PENDING_LABELS ||
      previousIntegrity.length > MAX_PENDING_LABELS ||
      unknownLowIntegrity.length > MAX_PENDING_LABELS ||
      unknownMiddleIntegrity.length > MAX_PENDING_LABELS ||
      unknownHighIntegrity.length > MAX_PENDING_LABELS
    ) {
      labels.push("stripe_operation_integrity_scan:additional_rows");
    }
    return [...new Set(labels)].slice(0, MAX_PENDING_LABELS + 1);
  },
});

export { stripeOperationKindValidator };
