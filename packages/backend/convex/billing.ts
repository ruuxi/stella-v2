import Stripe from "stripe";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  assertOwnerMigrationWriteAllowed,
  getUserIdOrNull,
  hasOwnerMigrationSourceFence,
  requireSensitiveUserIdentityAction,
} from "./auth";
import { getMonthlyBounds, getWeekBounds } from "./lib/billing_date";
import {
  findPlanForStripePriceId,
  getPlanCatalog,
  getPlanConfig,
  getStripeGoFirstMonthCouponId,
  getStripePriceIdForPlan,
  type SubscriptionPlan,
} from "./lib/billing_plans";
import {
  centsToMicroCents,
  type TokenPriceConfig,
  computeRealtimeUsageCostMicroCents,
  computeUsageCostMicroCents,
  dollarsToMicroCents,
  microCentsToDollars,
} from "./lib/billing_money";
import {
  buildManagedModelPriceEntries,
  listManagedModelPriceLookupCandidates,
  STATIC_MANAGED_MODEL_PRICE_OVERRIDES,
  type ManagedModelPriceEntry,
  type ModelsDevApi,
} from "./lib/models_dev";
import {
  listManagedModelIds,
  resolveManagedModelAudience,
} from "./agent/model";
import { enforceActionRateLimit, RATE_EXPENSIVE } from "./lib/rate_limits";
import {
  ANON_DEVICE_USAGE_RETENTION_DAYS,
  getMaxAnonRequests,
  getMaxAnonRequestsPerIp,
} from "./lib/anonymous_usage";
import {
  hashStripeBillingLocator,
  hashStripeDeletedOperationTuple,
  stripeHistoricalResultShape,
} from "./lib/billing_deletion";
import {
  ensureLegacyStripeOperationPhysicalReceiptProvenance,
  hasStripePhysicalReceiptCapacityForInsert,
  hasCleanIdleStripeOperationTransport,
  hasCleanLegacyStripeOperationTransport,
  hasCurrentStripeOperationIntegrity,
  hasLegacyStripeOperationIntegrityVersion,
  hasMatchingStripeManualResolutionProof,
  hasValidStripeOperationStateLocators,
  moveStripeOperationResolutionProofs,
  STRIPE_RECEIPT_INTEGRITY_VERSION,
} from "./lib/stripe_operation_integrity";
import { hashSha256Hex } from "./lib/crypto_utils";
import { scheduleOwnerSnapshotChanged } from "./lib/owner_snapshot_notify";
import { emitInferenceTelemetryMetric } from "./lib/telemetry_metric";
import { ownershipMigrationSourceDigest } from "./lib/auth_migration_paths";
import {
  activeManagedUsageReservationMicroCents,
  adjustManagedUsageReservationAuthorized,
} from "./lib/managed_usage_reservation";
import {
  createManagedDispatchRequestFingerprint,
  MANAGED_USAGE_BILLING_KIND,
  managedDispatchOutcomeRequiresQuiescence,
  PARALLEL_SEARCH_FAST_AGENT_TYPE,
  PARALLEL_SEARCH_FAST_BILLING_KIND,
  PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
  PARALLEL_SEARCH_FAST_MODEL,
  type DurableManagedDispatchOutcome,
  type ManagedDispatchBillingEnvelope,
  type ManagedDispatchCapturedUsage,
} from "./lib/managed_dispatch";
import {
  assertOwnerDataAccessActive,
  LEGACY_OWNER_GENERATION,
} from "./owner_lifecycle";
import {
  isDefinitiveStripeNoCreateError,
  remainingStripeProviderBudgetMs,
  resolvePinnedStripeCustomerAuthorityKey,
} from "./stripe_operation_dispatch";
import {
  anonymousIpBucketDeviceId,
  anonymousTrialDeviceId,
  consumeDeviceAllowanceAuthorized,
} from "./ai_proxy_data";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "./http_shared/anon_device";
import { managedModelAudienceValidator } from "./schema/gateway";
import {
  managedDispatchBillingEnvelopeValidator,
  managedDispatchCapturedUsageValidator,
  managedProviderDispatchOutcomeValidator,
} from "./schema/billing";
import { readExactVoiceProviderAttempt } from "./voice_dispatch";
import {
  VOICE_REALTIME_AUTHORITY_LEASE_MS,
  VOICE_REALTIME_AUTHORITY_POLL_MS,
  VOICE_REALTIME_AUTHORITY_QUIESCENCE_MS,
  voiceAuthorityQuiescentAfter,
} from "./lib/voice_authority";

export {
  VOICE_REALTIME_AUTHORITY_LEASE_MS,
  VOICE_REALTIME_AUTHORITY_POLL_MS,
  VOICE_REALTIME_AUTHORITY_QUIESCENCE_MS,
} from "./lib/voice_authority";

export const MANAGED_PROVIDER_DISPATCH_DEADLINE_MS = 90_000;
export const MANAGED_PROVIDER_DISPATCH_LEASE_MS = 120_000;
export const MANAGED_PROVIDER_DISPATCH_QUIESCENCE_MS = 15_000;
const MANAGED_PROVIDER_DISPATCH_TERMINAL_RETENTION_MS = 5 * 60_000;
const MANAGED_PROVIDER_DISPATCH_SWEEP_BATCH = 100;
export const MANAGED_EXECUTION_HEARTBEAT_MS = 15_000;
export const MANAGED_EXECUTION_LEASE_MS = 60_000;
export const MANAGED_EXECUTION_HARD_MS = 10 * 60_000;
export const MANAGED_EXECUTION_QUIESCENCE_MS = 15_000;

const planValidator = v.union(
  v.literal("free"),
  v.literal("go"),
  v.literal("pro"),
);

const paidPlanValidator = v.union(v.literal("go"), v.literal("pro"));

const usageModeValidator = v.union(
  v.literal("default"),
  v.literal("unlimited"),
);

const voiceRealtimeProviderValidator = v.union(
  v.literal("openai"),
  v.literal("xai"),
  v.literal("inworld"),
);

const voiceRealtimeLeaseEventValidator = v.union(
  v.literal("heartbeat"),
  v.literal("ended"),
  v.literal("expired"),
  v.literal("lost"),
  v.literal("cancel_ack"),
);

const voiceRealtimeTerminalUsageDispositionValidator = v.union(
  v.literal("drained"),
  v.literal("unresolved"),
);

const voiceRealtimeAuthorityValidDirectiveValidator = v.union(
  v.literal("continue"),
  v.literal("cancel"),
  v.literal("closed"),
);

/**
 * `Retry-After` advertised once a lifetime allowance is spent. Nothing
 * resets, so this is purely a "stop hammering the relay" hint — an upgrade
 * (or a credit purchase) is what actually unblocks the account.
 */
const LIFETIME_LIMIT_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const VOICE_REALTIME_LEASE_DURATION_MS = 5 * 60 * 1000;
// OpenAI Realtime sessions have a provider-enforced 60 minute maximum. The
// full horizon is reserved because a create response can be lost before its
// Location revocation handle reaches Stella.
const OPENAI_REALTIME_PROVIDER_HARD_MAX_MS = 60 * 60 * 1000;
const VOICE_REALTIME_LEASE_HEARTBEAT_GRACE_MS = 30 * 1000;
const VOICE_REALTIME_LEASE_EXPIRY_GRACE_MS = 15 * 1000;
const VOICE_REALTIME_MINT_REAPER_MS = 91 * 1000;
const VOICE_REALTIME_HANGUP_INITIAL_RETRY_MS = 1_000;
const VOICE_REALTIME_HANGUP_MAX_RETRY_MS = 5 * 60 * 1000;
const VOICE_REALTIME_HANGUP_ATTEMPT_LEASE_MS = 20_000;
const VOICE_REALTIME_USAGE_BILLING_QUANTUM_MS = 1_000;
const VOICE_REALTIME_FALLBACK_PRICING_REVISION = "voice-duplex-2026-08-26-v1";
/**
 * Conservative continuously-open duplex envelopes, pinned with the revision
 * above rather than read from mutable environment pricing. OpenAI assumes
 * continuous audio input (10 tokens/s) plus output (20 tokens/s) at the
 * catalog's $32/$64 per-million audio rates. xAI uses its $0.05/minute audio
 * meter, rounded up. Inworld covers simultaneous STT, LLM, and TTS at a
 * deliberately conservative speech-rate envelope.
 */
const VOICE_REALTIME_FALLBACK_RATE_MICRO_CENTS_PER_SECOND = {
  openai: 160_000,
  xai: 83_334,
  inworld: 50_000,
} as const;
const voiceRealtimeAuthorityResultValidator = v.union(
  v.object({
    recorded: v.boolean(),
    directive: v.literal("invalid"),
    authorityEpoch: v.null(),
    authorityExpiresAt: v.null(),
    cancelReason: v.null(),
  }),
  v.object({
    recorded: v.boolean(),
    directive: voiceRealtimeAuthorityValidDirectiveValidator,
    authorityEpoch: v.number(),
    authorityExpiresAt: v.number(),
    cancelReason: v.union(v.string(), v.null()),
  }),
);

const planConfigShapeValidator = v.object({
  label: v.string(),
  monthlyPriceCents: v.number(),
  introFirstMonthPriceCents: v.optional(v.number()),
  rollingLimitUsd: v.number(),
  rollingWindowHours: v.number(),
  weeklyLimitUsd: v.number(),
  monthlyLimitUsd: v.number(),
  lifetimeLimitUsd: v.optional(v.number()),
});

const subscriptionStatusReturnValidator = v.object({
  authenticated: v.boolean(),
  isAnonymous: v.boolean(),
  plan: planValidator,
  subscriptionStatus: v.string(),
  cancelAtPeriodEnd: v.boolean(),
  currentPeriodEnd: v.union(v.number(), v.null()),
  usage: v.union(
    v.object({
      rollingUsedUsd: v.number(),
      rollingLimitUsd: v.number(),
      weeklyUsedUsd: v.number(),
      weeklyLimitUsd: v.number(),
      monthlyUsedUsd: v.number(),
      monthlyLimitUsd: v.number(),
      /**
       * Cumulative spend that never resets, and the one-shot allowance it is
       * checked against. `lifetimeLimitUsd` is null on plans without a
       * lifetime cap, which is how the UI knows not to show the allowance.
       */
      lifetimeUsedUsd: v.number(),
      lifetimeLimitUsd: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  usagePolicy: v.union(
    v.object({
      kind: v.literal("anonymous_requests"),
      requestLimit: v.number(),
      perIpRequestLimit: v.number(),
      resetAfterInactivityDays: v.number(),
    }),
    v.object({ kind: v.literal("managed_cost") }),
  ),
  plans: v.object({
    free: planConfigShapeValidator,
    go: planConfigShapeValidator,
    pro: planConfigShapeValidator,
  }),
});

const STRIPE_API_VERSION = "2026-05-27.dahlia";
const STRIPE_PROVIDER_TIMEOUT_MS = 30_000;
const STRIPE_EVENT_CLAIM_MS = 5 * 60_000;
const STRIPE_OPERATION_LEASE_MS = 2 * 60_000;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
]);
const emptyString = "";
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const USAGE_CREDIT_CURRENCY = "usd";
const USAGE_CREDIT_MIN_PURCHASE_CENTS = 100;
const USAGE_CREDIT_MAX_PURCHASE_CENTS = 50_000;
const USAGE_CREDIT_PRESET_AMOUNTS_CENTS = [500, 1_000, 2_500, 5_000] as const;

const stripeOperationKindValidator = v.union(
  v.literal("subscription_checkout"),
  v.literal("usage_credit_checkout"),
  v.literal("billing_portal"),
);

const STRIPE_REQUEST_ID_MAX_BYTES = 256;

const stripeOperationRequestIdentity = async (
  kind: "subscription_checkout" | "usage_credit_checkout" | "billing_portal",
  requestId: string,
  parts: readonly unknown[],
) => {
  const requestScope = requestId.trim();
  if (!requestScope) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Billing request ID is required.",
    });
  }
  if (
    new TextEncoder().encode(requestScope).byteLength >
    STRIPE_REQUEST_ID_MAX_BYTES
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Billing request ID is too long.",
    });
  }
  const requestKey = await hashSha256Hex(requestScope);
  const requestFingerprint = await hashSha256Hex(
    JSON.stringify({
      kind,
      requestKey,
      parts,
    }),
  );
  return { requestKey, requestFingerprint };
};

type StripeOperationStep =
  | "customer_create"
  | "checkout_create"
  | "portal_create";

type StripeDispatchMark = {
  attemptId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  providerDeadlineAt: number;
  quiescentAfterAt: number;
  replayed: boolean;
};

/**
 * A replayed durable mark names provider work already owned by the winning
 * action (or by its crash-recovery worker). It is never fresh authority for a
 * second physical Stripe request, even though Stripe would deduplicate the
 * remote resource by idempotency key.
 */
export const assertFreshStripeProviderDispatch = (
  marked: Pick<StripeDispatchMark, "replayed">,
): void => {
  if (marked.replayed) {
    throw new ConvexError({
      code: "CONFLICT",
      message:
        "This Stripe request already has a provider dispatch in progress.",
    });
  }
};

type StripeDispatchTuple = {
  ownerId: string;
  ownerGeneration: string;
  operationId: string;
  attemptId: string;
  step: StripeOperationStep;
  requestFingerprint: string;
  idempotencyKey: string;
  providerDeadlineAt: number;
};

const markStripeOperationDispatchRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    attemptId: string;
    step: StripeOperationStep;
    requestJson: string;
    now: number;
  },
  StripeDispatchMark
>("stripe_operation_dispatch:markStripeOperationDispatchInternal");

const settleStripeOperationDispatchRef = makeFunctionReference<
  "mutation",
  StripeDispatchTuple & {
    stripeCustomerId?: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
    now: number;
  },
  { recorded: boolean; duplicate: boolean; customerDeleted: boolean }
>("stripe_operation_dispatch:settleStripeOperationDispatchInternal");

const settleStripeOperationNotCreatedRef = makeFunctionReference<
  "mutation",
  StripeDispatchTuple & { now: number },
  { recorded: boolean; duplicate: boolean; customerDeleted: boolean }
>("stripe_operation_dispatch:settleStripeOperationNotCreatedInternal");

const markStripeStep = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    step: StripeOperationStep;
    requestJson: string;
  },
): Promise<StripeDispatchTuple> => {
  const marked = await ctx.runMutation(markStripeOperationDispatchRef, {
    ...args,
    attemptId: crypto.randomUUID(),
    now: Date.now(),
  });
  assertFreshStripeProviderDispatch(marked);
  return {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    operationId: args.operationId,
    attemptId: marked.attemptId,
    step: args.step,
    requestFingerprint: marked.requestFingerprint,
    idempotencyKey: marked.idempotencyKey,
    providerDeadlineAt: marked.providerDeadlineAt,
  };
};

const revalidateStripeInitialProviderCallRef = makeFunctionReference<
  "mutation",
  StripeDispatchTuple & { now: number },
  { providerCallDeadlineAt: number } | null
>("stripe_operation_dispatch:revalidateStripeInitialProviderCallInternal");

const adoptStripeOperationCustomerRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    stripeCustomerId: string;
    now: number;
  },
  { adopted: boolean; customerDeleted: boolean }
>("stripe_operation_dispatch:adoptStripeOperationCustomerInternal");

const completeStripeOperationRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    now: number;
  },
  boolean
>("stripe_operation_dispatch:completeStripeOperationInternal");

const authorizeStripeOperationResultReturnRef = makeFunctionReference<
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

const assertStripeOperationResultReturn = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    operationId: string;
    stripeCustomerId: string;
    stripeCheckoutSessionId?: string;
    stripePortalSessionId?: string;
  },
): Promise<void> => {
  const authorized = await ctx.runMutation(
    authorizeStripeOperationResultReturnRef,
    args,
  );
  if (!authorized) {
    throw new ConvexError({
      code: "CONFLICT",
      message: "Stripe result authority changed before delivery.",
    });
  }
};

const stripeCustomerReferenceId = (
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null =>
  typeof customer === "string" ? customer : customer?.id?.trim() || null;

const assertStripeCheckoutSessionProviderBinding = (
  session: Stripe.Checkout.Session,
  args: {
    operationId: string;
    stripeCustomerId: string;
    expectedSessionId?: string;
  },
): void => {
  if (
    (args.expectedSessionId && session.id !== args.expectedSessionId) ||
    stripeCustomerReferenceId(session.customer) !== args.stripeCustomerId ||
    session.metadata?.stellaOperationId !== args.operationId
  ) {
    throw new ConvexError({
      code: "CONFLICT",
      message: "Stripe checkout result is bound to another operation.",
    });
  }
};

const assertStripePortalSessionProviderBinding = (
  session: Stripe.BillingPortal.Session,
  stripeCustomerId: string,
): void => {
  if (stripeCustomerReferenceId(session.customer) !== stripeCustomerId) {
    throw new ConvexError({
      code: "CONFLICT",
      message: "Stripe portal result is bound to another customer.",
    });
  }
};

const settleDefinitiveStripeNoCreate = async (
  ctx: ActionCtx,
  tuple: StripeDispatchTuple,
  error: unknown,
) => {
  if (isDefinitiveStripeNoCreateError(error)) {
    await ctx.runMutation(settleStripeOperationNotCreatedRef, {
      ...tuple,
      now: Date.now(),
    });
  }
};

const shouldApplyStripeResourceEvent = (args: {
  storedAt: number;
  storedEventId?: string;
  storedTerminal?: boolean;
  incomingAt: number;
  incomingEventId?: string;
  incomingTerminal?: boolean;
}): boolean => {
  if (args.incomingAt !== args.storedAt) {
    return args.incomingAt > args.storedAt;
  }
  if (args.storedTerminal !== args.incomingTerminal) {
    return args.incomingTerminal === true;
  }
  // Stripe event ids are unique but are not documented as a causal ordering.
  // Same-second nonterminal handlers read the current provider resource before
  // projecting it, so accepting the tie converges instead of inventing an id
  // ordering that could resurrect stale state.
  return true;
};

const isAnonymousIdentity = (identity: unknown) =>
  Boolean(
    identity &&
      typeof identity === "object" &&
      (identity as Record<string, unknown>).isAnonymous === true,
  );

const hasUnlimitedUsage = (profile: { usageMode?: string }) =>
  profile.usageMode === "unlimited";

const getStripeClient = (timeoutMs = STRIPE_PROVIDER_TIMEOUT_MS) => {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Stripe is not configured.",
    });
  }

  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    // Operation rows + idempotency keys own retries. Disabling SDK-internal
    // retries ensures every provider attempt first re-enters the exact owner
    // generation/operation dispatch fence.
    maxNetworkRetries: 0,
    timeout: timeoutMs,
  });
};

class StripeProviderAuthorityExpiredError extends Error {
  constructor() {
    super("Stripe provider-call authority expired before physical I/O.");
    this.name = "StripeProviderAuthorityExpiredError";
  }
}

const withInitialStripeProviderAuthority = async <T>(
  ctx: ActionCtx,
  tuple: StripeDispatchTuple,
  call: (stripe: Stripe) => Promise<T>,
): Promise<T> => {
  const authority = await ctx.runMutation(
    revalidateStripeInitialProviderCallRef,
    { ...tuple, now: Date.now() },
  );
  if (!authority) throw new StripeProviderAuthorityExpiredError();
  // Invoke synchronously after checking the persisted absolute deadline. If a
  // suspended action resumes after the tuple was cleared or its deadline, it
  // performs zero provider I/O.
  const stripe = getStripeClient(
    remainingStripeProviderBudgetMs(authority.providerCallDeadlineAt),
  );
  return await call(stripe);
};

const toCurrencyAmount = (microCents: number) =>
  Number(microCentsToDollars(microCents).toFixed(4));

const toNonNegativeInt = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

const toSafeString = (value: string | null | undefined) =>
  value?.trim() ?? emptyString;

const getOwnerBillingProfile = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
) =>
  await ctx.db
    .query("billing_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const getOwnerUsageRow = async (ctx: Pick<QueryCtx, "db">, ownerId: string) =>
  await ctx.db
    .query("billing_usage_windows")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const getOwnerUsageCreditRow = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
) =>
  await ctx.db
    .query("billing_usage_credits")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const createDefaultProfile = (
  ownerId: string,
  now: number,
): Omit<Doc<"billing_profiles">, "_id" | "_creationTime"> => ({
  ownerId,
  activePlan: "free",
  subscriptionStatus: "none",
  stripeCustomerId: emptyString,
  stripeCustomerAuthorityEpoch: 0,
  stripeCustomerAdoptionScanEpoch: -1,
  stripeSubscriptionId: emptyString,
  stripePriceId: emptyString,
  defaultPaymentMethodId: emptyString,
  paymentMethodBrand: emptyString,
  paymentMethodLast4: emptyString,
  currentPeriodStart: 0,
  currentPeriodEnd: 0,
  cancelAtPeriodEnd: false,
  monthlyAnchorAt: now,
  createdAt: now,
  updatedAt: now,
});

const createDefaultUsage = (ownerId: string, now: number) => {
  const week = getWeekBounds(new Date(now));
  const month = getMonthlyBounds(new Date(now), new Date(now));

  return {
    ownerId,
    activeReservedMicroCents: 0,
    rollingUsageMicroCents: 0,
    rollingWindowStartedAt: now,
    weeklyUsageMicroCents: 0,
    weeklyWindowStartedAt: week.start.getTime(),
    monthlyUsageMicroCents: 0,
    monthlyWindowStartedAt: month.start.getTime(),
    totalUsageMicroCents: 0,
    createdAt: now,
    updatedAt: now,
  };
};

const readBillingRecordsForOwner = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  now: number,
) => {
  const [profile, usage] = await Promise.all([
    getOwnerBillingProfile(ctx, ownerId),
    getOwnerUsageRow(ctx, ownerId),
  ]);
  return {
    profile: profile ?? createDefaultProfile(ownerId, now),
    usage: usage ?? createDefaultUsage(ownerId, now),
  };
};

const createDefaultUsageCredit = (ownerId: string, now: number) => ({
  ownerId,
  balanceMicroCents: 0,
  totalPurchasedMicroCents: 0,
  totalConsumedMicroCents: 0,
  currency: USAGE_CREDIT_CURRENCY,
  createdAt: now,
  updatedAt: now,
});

const ensureBillingRecordsForOwnerAuthorized = async (
  ctx: MutationCtx,
  ownerId: string,
) => {
  const now = Date.now();

  let [profile, usage] = await Promise.all([
    getOwnerBillingProfile(ctx, ownerId),
    getOwnerUsageRow(ctx, ownerId),
  ]);

  if (!profile) {
    const created = createDefaultProfile(ownerId, now);
    await ctx.db.insert("billing_profiles", created);
    profile = await getOwnerBillingProfile(ctx, ownerId);
  }

  if (!profile) {
    throw new ConvexError({
      code: "INTERNAL_ERROR",
      message: "Failed to initialize billing profile.",
    });
  }

  if (!usage) {
    const created = createDefaultUsage(ownerId, now);
    await ctx.db.insert("billing_usage_windows", created);
    usage = await getOwnerUsageRow(ctx, ownerId);
  }

  if (!usage) {
    throw new ConvexError({
      code: "INTERNAL_ERROR",
      message: "Failed to initialize billing usage windows.",
    });
  }

  return { profile, usage };
};

const ensureBillingRecordsForOwner = async (
  ctx: MutationCtx,
  ownerId: string,
  expectedGeneration?: string,
) => {
  await assertOwnerMigrationWriteAllowed(ctx, ownerId, expectedGeneration);
  return await ensureBillingRecordsForOwnerAuthorized(ctx, ownerId);
};

const ensureUsageCreditForOwner = async (ctx: MutationCtx, ownerId: string) => {
  await assertOwnerMigrationWriteAllowed(ctx, ownerId);
  const now = Date.now();
  let credit = await getOwnerUsageCreditRow(ctx, ownerId);
  if (!credit) {
    await ctx.db.insert(
      "billing_usage_credits",
      createDefaultUsageCredit(ownerId, now),
    );
    credit = await getOwnerUsageCreditRow(ctx, ownerId);
  }
  if (!credit) {
    throw new ConvexError({
      code: "INTERNAL_ERROR",
      message: "Failed to initialize usage credit balance.",
    });
  }
  return credit;
};

type UsageSnapshot = {
  normalizedUsage: {
    rollingUsageMicroCents: number;
    rollingWindowStartedAt: number;
    weeklyUsageMicroCents: number;
    weeklyWindowStartedAt: number;
    monthlyUsageMicroCents: number;
    monthlyWindowStartedAt: number;
  };
  rolling: {
    used: number;
    limit: number;
    resetAt: number;
    exceeded: boolean;
  };
  weekly: {
    used: number;
    limit: number;
    resetAt: number;
    exceeded: boolean;
  };
  monthly: {
    used: number;
    limit: number;
    resetAt: number;
    exceeded: boolean;
  };
  /**
   * The Free plan's one-shot allowance. `null` on every plan that leaves
   * `lifetimeLimitUsd` unset, so paid plans keep purely windowed limits and
   * never pay for the extra check.
   */
  lifetime: {
    used: number;
    limit: number;
    resetAt: number;
    exceeded: boolean;
  } | null;
  changed: boolean;
};

const getUsageCreditBalanceMicroCents = (
  credit: { balanceMicroCents: number } | null,
) => Math.max(0, Math.floor(credit?.balanceMicroCents ?? 0));

const getIncludedUsageHeadroomMicroCents = (snapshot: UsageSnapshot) =>
  Math.max(
    0,
    Math.min(
      Math.max(0, snapshot.rolling.limit - snapshot.rolling.used),
      Math.max(0, snapshot.weekly.limit - snapshot.weekly.used),
      Math.max(0, snapshot.monthly.limit - snapshot.monthly.used),
      // A spent lifetime allowance leaves no included headroom, so further
      // spend draws on purchased credits exactly like an exhausted window.
      snapshot.lifetime
        ? Math.max(0, snapshot.lifetime.limit - snapshot.lifetime.used)
        : Number.POSITIVE_INFINITY,
    ),
  );

const computeUsageCreditToConsume = (args: {
  costMicroCents: number;
  snapshot: UsageSnapshot;
  unlimited: boolean;
}) => {
  if (args.unlimited) return 0;
  const costMicroCents = Math.max(0, Math.floor(args.costMicroCents));
  if (costMicroCents <= 0) return 0;
  return Math.max(
    0,
    costMicroCents - getIncludedUsageHeadroomMicroCents(args.snapshot),
  );
};

const normalizeUsageCreditPurchaseAmountCents = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Enter a valid credit amount.",
    });
  }
  const amountCents = Math.floor(value);
  if (
    amountCents < USAGE_CREDIT_MIN_PURCHASE_CENTS ||
    amountCents > USAGE_CREDIT_MAX_PURCHASE_CENTS
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Credit amount must be between $${USAGE_CREDIT_MIN_PURCHASE_CENTS / 100} and $${USAGE_CREDIT_MAX_PURCHASE_CENTS / 100}.`,
    });
  }
  return amountCents;
};

const buildUsageSnapshot = (args: {
  profile: {
    monthlyAnchorAt: number;
  };
  usage: {
    rollingUsageMicroCents: number;
    rollingWindowStartedAt: number;
    weeklyUsageMicroCents: number;
    weeklyWindowStartedAt: number;
    monthlyUsageMicroCents: number;
    monthlyWindowStartedAt: number;
    totalUsageMicroCents: number;
  };
  plan: SubscriptionPlan;
  now: number;
}): UsageSnapshot => {
  const planConfig = getPlanConfig(args.plan);
  const nowDate = new Date(args.now);

  const rollingWindowMs = Math.max(
    1,
    Math.floor(planConfig.rollingWindowHours * 60 * 60 * 1000),
  );
  const rollingLimitMicroCents = dollarsToMicroCents(
    planConfig.rollingLimitUsd,
  );
  const rollingWindowStartThreshold = args.now - rollingWindowMs;
  const rollingActive =
    args.usage.rollingWindowStartedAt > 0 &&
    args.usage.rollingWindowStartedAt >= rollingWindowStartThreshold;
  const rollingUsed = rollingActive ? args.usage.rollingUsageMicroCents : 0;
  const rollingStart = rollingActive
    ? args.usage.rollingWindowStartedAt
    : args.now;
  const rollingResetAt = rollingStart + rollingWindowMs;

  const week = getWeekBounds(nowDate);
  const weeklyLimitMicroCents = dollarsToMicroCents(planConfig.weeklyLimitUsd);
  const weeklyActive = args.usage.weeklyWindowStartedAt >= week.start.getTime();
  const weeklyUsed = weeklyActive ? args.usage.weeklyUsageMicroCents : 0;
  const weeklyStart = weeklyActive
    ? args.usage.weeklyWindowStartedAt
    : week.start.getTime();
  const weeklyResetAt = week.end.getTime();

  const anchor =
    args.profile.monthlyAnchorAt > 0
      ? new Date(args.profile.monthlyAnchorAt)
      : nowDate;
  const month = getMonthlyBounds(nowDate, anchor);
  const monthlyLimitMicroCents = dollarsToMicroCents(
    planConfig.monthlyLimitUsd,
  );
  const monthlyActive =
    args.usage.monthlyWindowStartedAt >= month.start.getTime();
  const monthlyUsed = monthlyActive ? args.usage.monthlyUsageMicroCents : 0;
  const monthlyStart = monthlyActive
    ? args.usage.monthlyWindowStartedAt
    : month.start.getTime();
  const monthlyResetAt = month.end.getTime();

  // The lifetime allowance never refreshes, so there is no window to
  // normalize and nothing to reset — `totalUsageMicroCents` already
  // accumulates forever. `resetAt` exists only to keep the shared
  // `Retry-After` math honest; it advertises a re-check horizon, not a
  // moment when the allowance comes back.
  const lifetimeLimitUsd = planConfig.lifetimeLimitUsd;
  const lifetimeUsed = Math.max(0, args.usage.totalUsageMicroCents);
  const lifetime =
    lifetimeLimitUsd === undefined
      ? null
      : (() => {
          const limit = dollarsToMicroCents(lifetimeLimitUsd);
          return {
            used: lifetimeUsed,
            limit,
            resetAt: args.now + LIFETIME_LIMIT_RETRY_AFTER_MS,
            exceeded: lifetimeUsed >= limit,
          };
        })();

  const normalizedUsage = {
    rollingUsageMicroCents: rollingUsed,
    rollingWindowStartedAt: rollingStart,
    weeklyUsageMicroCents: weeklyUsed,
    weeklyWindowStartedAt: weeklyStart,
    monthlyUsageMicroCents: monthlyUsed,
    monthlyWindowStartedAt: monthlyStart,
  };

  const changed =
    normalizedUsage.rollingUsageMicroCents !==
      args.usage.rollingUsageMicroCents ||
    normalizedUsage.rollingWindowStartedAt !==
      args.usage.rollingWindowStartedAt ||
    normalizedUsage.weeklyUsageMicroCents !==
      args.usage.weeklyUsageMicroCents ||
    normalizedUsage.weeklyWindowStartedAt !==
      args.usage.weeklyWindowStartedAt ||
    normalizedUsage.monthlyUsageMicroCents !==
      args.usage.monthlyUsageMicroCents ||
    normalizedUsage.monthlyWindowStartedAt !==
      args.usage.monthlyWindowStartedAt;

  return {
    normalizedUsage,
    rolling: {
      used: rollingUsed,
      limit: rollingLimitMicroCents,
      resetAt: rollingResetAt,
      exceeded: rollingUsed >= rollingLimitMicroCents,
    },
    weekly: {
      used: weeklyUsed,
      limit: weeklyLimitMicroCents,
      resetAt: weeklyResetAt,
      exceeded: weeklyUsed >= weeklyLimitMicroCents,
    },
    monthly: {
      used: monthlyUsed,
      limit: monthlyLimitMicroCents,
      resetAt: monthlyResetAt,
      exceeded: monthlyUsed >= monthlyLimitMicroCents,
    },
    lifetime,
    changed,
  };
};

/**
 * Spend an owner may still make on managed models right now: included
 * headroom across every usage window (lifetime included), plus purchased
 * credits, minus the ceilings held by admitted-but-unbilled attempts. May be
 * negative. The usage-limit gate, voice reservations, and gateway capability
 * budgets all read this one number so no admission path drifts.
 */
const computeManagedUsageRemainingMicroCents = (args: {
  snapshot: UsageSnapshot;
  credit: { balanceMicroCents: number } | null;
  usage: { activeReservedMicroCents?: number };
}): number =>
  getIncludedUsageHeadroomMicroCents(args.snapshot) +
  getUsageCreditBalanceMicroCents(args.credit) -
  activeManagedUsageReservationMicroCents(args.usage);

const getOwnerAvailableManagedUsageMicroCents = async (
  ctx: MutationCtx,
  args: { ownerId: string; now: number },
): Promise<number> => {
  const { profile, usage } = await ensureBillingRecordsForOwnerAuthorized(
    ctx,
    args.ownerId,
  );
  if (hasUnlimitedUsage(profile)) return Number.POSITIVE_INFINITY;
  const snapshot = buildUsageSnapshot({
    profile,
    usage,
    plan: profile.activePlan as SubscriptionPlan,
    now: args.now,
  });
  if (snapshot.changed) {
    await ctx.db.patch(usage._id, {
      ...snapshot.normalizedUsage,
      updatedAt: args.now,
    });
  }
  const credit = await getOwnerUsageCreditRow(ctx, args.ownerId);
  return Math.max(
    0,
    computeManagedUsageRemainingMicroCents({ snapshot, credit, usage }),
  );
};

/**
 * Picks the window that blocks a request, lifetime first: when the one-shot
 * allowance is gone the shorter windows are irrelevant, and reporting the
 * lifetime bucket is what makes the message say "upgrade" instead of
 * "try again in five hours".
 */
const findExceededWindow = (
  snapshot: UsageSnapshot,
  isBlocked?: (window: UsageSnapshot["rolling"]) => boolean,
) => {
  // A supplied predicate is the complete admission decision for a window.
  // This lets callers combine included headroom, purchased credits, and the
  // OCC-serialized reservation aggregate without an exhausted free bucket
  // short-circuiting before those paid credits are considered.
  const blocks =
    isBlocked ?? ((window: UsageSnapshot["rolling"]) => window.exceeded);
  if (snapshot.lifetime && blocks(snapshot.lifetime)) {
    return { window: snapshot.lifetime, lifetime: true as const };
  }
  const windowed = blocks(snapshot.rolling)
    ? snapshot.rolling
    : blocks(snapshot.weekly)
      ? snapshot.weekly
      : blocks(snapshot.monthly)
        ? snapshot.monthly
        : null;
  return windowed ? { window: windowed, lifetime: false as const } : null;
};

const buildLimitMessage = (plan: SubscriptionPlan, lifetime = false) => {
  if (lifetime) {
    // Deliberately different from the windowed message: this one does not
    // come back, and telling someone to wait would be a lie.
    return "You've used your free Stella allowance. Upgrade to keep going.";
  }
  if (plan === "free") {
    return "Free plan usage limit reached. Upgrade to continue.";
  }
  return `${getPlanConfig(plan).label} plan usage limit reached.`;
};

const buildDowngradeMessage = (plan: Exclude<SubscriptionPlan, "free">) =>
  `${getPlanConfig(plan).label} plan managed-model limits reached. Falling back until usage resets.`;

export type ManagedModelAccessResult = {
  allowed: boolean;
  plan: SubscriptionPlan;
  unlimited: boolean;
  downgraded: boolean;
  modelAudience: ReturnType<typeof resolveManagedModelAudience>;
  retryAfterMs: number;
  message: string;
};

const buildManagedModelAccessResult = (args: {
  plan: SubscriptionPlan;
  isAnonymous?: boolean;
  unlimited?: boolean;
  exceededWindow:
    | UsageSnapshot["rolling"]
    | UsageSnapshot["weekly"]
    | UsageSnapshot["monthly"]
    | null;
  /** The blocking bucket is the never-refreshing lifetime allowance. */
  lifetimeExhausted?: boolean;
  now: number;
}): ManagedModelAccessResult => {
  const { plan, exceededWindow, now } = args;
  const unlimited = args.unlimited === true;

  if (!exceededWindow || unlimited) {
    return {
      allowed: true,
      plan,
      unlimited,
      downgraded: false,
      modelAudience: resolveManagedModelAudience({
        plan,
        isAnonymous: args.isAnonymous,
      }),
      retryAfterMs: 0,
      message: emptyString,
    };
  }

  const retryAfterMs = Math.max(1_000, exceededWindow.resetAt - now);
  if (plan === "free") {
    return {
      allowed: false,
      plan,
      unlimited: false,
      downgraded: false,
      modelAudience: resolveManagedModelAudience({
        plan,
        isAnonymous: args.isAnonymous,
      }),
      retryAfterMs,
      message: buildLimitMessage(plan, args.lifetimeExhausted === true),
    };
  }

  return {
    allowed: true,
    plan,
    unlimited: false,
    downgraded: true,
    modelAudience: resolveManagedModelAudience({
      plan,
      downgraded: true,
    }),
    retryAfterMs,
    message: buildDowngradeMessage(plan),
  };
};

export type ManagedUsageRecordArgs = {
  ownerId: string;
  ownerGeneration: string;
  agentType: string;
  model: string;
  durationMs: number;
  success: boolean;
  conversationId?: Id<"conversations"> | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  costMicroCents?: number;
  fallbackUsed?: boolean;
  toolCalls?: number;
};

const getManagedModelPriceRow = async (
  ctx: Pick<QueryCtx, "db">,
  model: string,
) => {
  for (const candidate of listManagedModelPriceLookupCandidates(model)) {
    const row = await ctx.db
      .query("billing_model_prices")
      .withIndex("by_model", (q) => q.eq("model", candidate))
      .unique();
    if (row) return row;
  }
  return null;
};

const toTokenPriceConfig = (
  row: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd: number;
    cacheWritePerMillionUsd: number;
    reasoningPerMillionUsd: number;
  } | null,
): TokenPriceConfig | undefined =>
  row
    ? {
        inputPerMillionUsd: row.inputPerMillionUsd,
        outputPerMillionUsd: row.outputPerMillionUsd,
        cacheReadPerMillionUsd: row.cacheReadPerMillionUsd,
        cacheWritePerMillionUsd: row.cacheWritePerMillionUsd,
        reasoningPerMillionUsd: row.reasoningPerMillionUsd,
      }
    : undefined;

const getDefaultConversationIdForOwner = async (
  ctx: MutationCtx,
  ownerId: string,
) => {
  const conversation = await ctx.db
    .query("conversations")
    .withIndex("by_ownerId_and_isDefault", (q) =>
      q.eq("ownerId", ownerId).eq("isDefault", true),
    )
    .first();
  return conversation?._id ?? null;
};

const persistManagedUsageAuthorized = async (
  ctx: MutationCtx,
  args: ManagedUsageRecordArgs,
) => {
  const inputTokens = toNonNegativeInt(args.inputTokens);
  const outputTokens = toNonNegativeInt(args.outputTokens);
  const cachedInputTokens = toNonNegativeInt(args.cachedInputTokens);
  const cacheWriteInputTokens = toNonNegativeInt(args.cacheWriteInputTokens);
  const reasoningTokens = toNonNegativeInt(args.reasoningTokens);
  const totalTokens =
    typeof args.totalTokens === "number" && Number.isFinite(args.totalTokens)
      ? Math.max(0, Math.floor(args.totalTokens))
      : inputTokens + outputTokens;
  const modelPrice = toTokenPriceConfig(
    await getManagedModelPriceRow(ctx, args.model),
  );
  const costMicroCents =
    typeof args.costMicroCents === "number" &&
    Number.isFinite(args.costMicroCents)
      ? Math.max(0, Math.floor(args.costMicroCents))
      : computeUsageCostMicroCents({
          model: args.model,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
          reasoningTokens,
          price: modelPrice,
        });

  const { profile, usage } = await ensureBillingRecordsForOwnerAuthorized(
    ctx,
    args.ownerId,
  );
  const plan = profile.activePlan as SubscriptionPlan;
  const now = Date.now();
  const unlimited = hasUnlimitedUsage(profile);

  const snapshot = buildUsageSnapshot({
    profile,
    usage,
    plan,
    now,
  });
  const creditToConsumeMicroCents = computeUsageCreditToConsume({
    costMicroCents,
    snapshot,
    unlimited,
  });
  let creditConsumedMicroCents = 0;

  await ctx.db.patch(usage._id, {
    rollingUsageMicroCents:
      snapshot.normalizedUsage.rollingUsageMicroCents + costMicroCents,
    rollingWindowStartedAt: snapshot.normalizedUsage.rollingWindowStartedAt,
    weeklyUsageMicroCents:
      snapshot.normalizedUsage.weeklyUsageMicroCents + costMicroCents,
    weeklyWindowStartedAt: snapshot.normalizedUsage.weeklyWindowStartedAt,
    monthlyUsageMicroCents:
      snapshot.normalizedUsage.monthlyUsageMicroCents + costMicroCents,
    monthlyWindowStartedAt: snapshot.normalizedUsage.monthlyWindowStartedAt,
    totalUsageMicroCents: usage.totalUsageMicroCents + costMicroCents,
    totalRequestCount: toNonNegativeInt(usage.totalRequestCount) + 1,
    updatedAt: now,
  });

  if (creditToConsumeMicroCents > 0) {
    const credit = await getOwnerUsageCreditRow(ctx, args.ownerId);
    if (credit) {
      creditConsumedMicroCents = Math.min(
        getUsageCreditBalanceMicroCents(credit),
        creditToConsumeMicroCents,
      );
      if (creditConsumedMicroCents > 0) {
        await ctx.db.patch(credit._id, {
          balanceMicroCents:
            getUsageCreditBalanceMicroCents(credit) - creditConsumedMicroCents,
          totalConsumedMicroCents:
            Math.max(0, Math.floor(credit.totalConsumedMicroCents)) +
            creditConsumedMicroCents,
          updatedAt: now,
        });
      }
    }
  }

  const conversationId =
    args.conversationId ??
    (await getDefaultConversationIdForOwner(ctx, args.ownerId));
  if (conversationId) {
    await ctx.db.insert("usage_logs", {
      ownerId: args.ownerId,
      conversationId,
      agentType: args.agentType,
      model: args.model,
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      costMicroCents,
      billingPlan: plan,
      durationMs: Math.max(0, Math.floor(args.durationMs)),
      success: args.success,
      ...(args.fallbackUsed !== undefined
        ? { fallbackUsed: args.fallbackUsed }
        : {}),
      ...(args.toolCalls !== undefined ? { toolCalls: args.toolCalls } : {}),
      createdAt: now,
    });
  }

  await emitInferenceTelemetryMetric({
    ownerId: args.ownerId,
    occurredAtMs: now,
    model: args.model,
    agentType: args.agentType,
    durationMs: Math.max(0, Math.floor(args.durationMs)),
    success: args.success,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
    totalTokens,
    costMicroCents,
    fallbackUsed: args.fallbackUsed,
    toolCalls: args.toolCalls,
  });

  return {
    costMicroCents,
    creditConsumedMicroCents,
    plan,
  };
};

export const persistManagedUsage = async (
  ctx: MutationCtx,
  args: ManagedUsageRecordArgs,
) => {
  // This read is deliberately in the same transaction as every billing
  // mutation below. A reset/delete fence racing this mutation therefore
  // causes an OCC retry, which observes the blocked lifecycle. Carrying the
  // admission generation additionally rejects delayed callbacks after reset.
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  return await persistManagedUsageAuthorized(ctx, args);
};

const getExistingVoiceUsageReceipt = async (
  ctx: MutationCtx,
  ownerId: string,
  responseId: string,
) =>
  await ctx.db
    .query("billing_voice_usage_receipts")
    .withIndex("by_ownerId_and_responseId", (q) =>
      q.eq("ownerId", ownerId).eq("responseId", responseId),
    )
    .unique();

const getExistingMediaUsageReceipt = async (
  ctx: MutationCtx,
  ownerId: string,
  jobId: string,
) =>
  await ctx.db
    .query("billing_media_usage_receipts")
    .withIndex("by_ownerId_and_jobId", (q) =>
      q.eq("ownerId", ownerId).eq("jobId", jobId),
    )
    .unique();

const isVoiceLeaseReported = (lease: {
  heartbeatCount?: number;
  responseCount?: number;
  lastHeartbeatAt?: number;
  lastUsageAt?: number;
}) =>
  (lease.heartbeatCount ?? 0) > 0 ||
  (lease.responseCount ?? 0) > 0 ||
  typeof lease.lastHeartbeatAt === "number" ||
  typeof lease.lastUsageAt === "number";

const getVoiceRealtimeLease = async (
  ctx: Pick<QueryCtx, "db">,
  stellaSessionId: string,
) =>
  await ctx.db
    .query("billing_voice_sessions")
    .withIndex("by_stellaSessionId", (q) =>
      q.eq("stellaSessionId", stellaSessionId),
    )
    .unique();

type VoiceRealtimeLeaseRow = Doc<"billing_voice_sessions">;

const getVoiceRealtimeFallbackRate = (provider: string): number => {
  switch (provider) {
    case "openai":
    case "xai":
    case "inworld":
      return VOICE_REALTIME_FALLBACK_RATE_MICRO_CENTS_PER_SECOND[provider];
    default:
      throw new Error("Unsupported realtime voice fallback provider.");
  }
};

const voiceFallbackReceiptId = (
  stellaSessionId: string,
  providerAttemptId: string,
) => `voice-fallback:${stellaSessionId}:${providerAttemptId}`;

const voiceUsageAuthorityEpochAllowed = (
  lease: VoiceRealtimeLeaseRow,
  authorityEpoch: number,
): boolean => {
  const currentEpoch = lease.authorityEpoch;
  if (!Number.isSafeInteger(currentEpoch) || (currentEpoch ?? 0) < 1) {
    return false;
  }
  if (lease.authorityState === "active") {
    return authorityEpoch === currentEpoch;
  }
  // Lifecycle cancellation advances the renderer fence exactly once. Usage
  // already posted under the immediately preceding epoch remains authorized
  // until the exact cancel acknowledgement closes the shared authority.
  return (
    lease.authorityState === "cancel_requested" &&
    (authorityEpoch === currentEpoch || authorityEpoch + 1 === currentEpoch)
  );
};

const voiceUsageAuthorityMatches = (
  lease: VoiceRealtimeLeaseRow,
  args: {
    ownerId: string;
    ownerGeneration: string;
    stellaSessionId: string;
    providerDispatchId: string;
    providerAttemptId: string;
    authorityLeaseId: string;
    authorityEpoch: number;
  },
): boolean =>
  lease.ownerId === args.ownerId &&
  (lease.ownerGeneration ?? "legacy") === args.ownerGeneration &&
  lease.stellaSessionId === args.stellaSessionId &&
  lease.providerDispatchId === args.providerDispatchId &&
  lease.providerAttemptId === args.providerAttemptId &&
  lease.authorityLeaseId === args.authorityLeaseId &&
  voiceUsageAuthorityEpochAllowed(lease, args.authorityEpoch) &&
  // Time does not silently close spend authority. The renderer ACK, terminal
  // event, or expiry mutation must win the OCC race and atomically change the
  // authority/disposition before a new exact receipt is rejected.
  (lease.usageDisposition ?? "pending") === "pending";

const voiceUsageRequestFingerprint = async (args: {
  ownerGeneration: string;
  providerDispatchId: string;
  providerAttemptId: string;
  authorityLeaseId: string;
  authorityEpoch: number;
  stellaSessionId: string;
  responseId: string;
  model: string;
  conversationId?: Id<"conversations">;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  textInputTokens: number;
  textCachedInputTokens: number;
  textOutputTokens: number;
  audioInputTokens: number;
  audioCachedInputTokens: number;
  audioOutputTokens: number;
  imageInputTokens: number;
  imageCachedInputTokens: number;
  exactCostMicroCents?: number;
  realtimeAudioSeconds?: number;
  realtimeTextInputMessages?: number;
  sttModel?: string;
  sttAudioSeconds?: number;
}): Promise<string> =>
  await hashSha256Hex(
    JSON.stringify({
      ownerGeneration: args.ownerGeneration,
      providerDispatchId: args.providerDispatchId,
      providerAttemptId: args.providerAttemptId,
      authorityLeaseId: args.authorityLeaseId,
      authorityEpoch: args.authorityEpoch,
      stellaSessionId: args.stellaSessionId,
      responseId: args.responseId,
      model: args.model,
      conversationId: args.conversationId ?? null,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.totalTokens,
      textInputTokens: args.textInputTokens,
      textCachedInputTokens: args.textCachedInputTokens,
      textOutputTokens: args.textOutputTokens,
      audioInputTokens: args.audioInputTokens,
      audioCachedInputTokens: args.audioCachedInputTokens,
      audioOutputTokens: args.audioOutputTokens,
      imageInputTokens: args.imageInputTokens,
      imageCachedInputTokens: args.imageCachedInputTokens,
      exactCostMicroCents: args.exactCostMicroCents ?? null,
      realtimeAudioSeconds: args.realtimeAudioSeconds ?? null,
      realtimeTextInputMessages: args.realtimeTextInputMessages ?? null,
      sttModel: args.sttModel ?? null,
      sttAudioSeconds: args.sttAudioSeconds ?? null,
    }),
  );

/**
 * Narrow late-receipt writer. This is intentionally private to billing.ts and
 * couples the authorized ledger write to the exact still-open physical voice
 * authority in the same Convex transaction. Lifecycle generation may already
 * be fenced while reset/delete waits for this authority to close.
 */
const persistExactVoiceRealtimeUsageAuthorized = async (
  ctx: MutationCtx,
  lease: VoiceRealtimeLeaseRow,
  args: {
    ownerId: string;
    ownerGeneration: string;
    stellaSessionId: string;
    providerDispatchId: string;
    providerAttemptId: string;
    authorityLeaseId: string;
    authorityEpoch: number;
    usage: ManagedUsageRecordArgs;
  },
) => {
  if (!voiceUsageAuthorityMatches(lease, args)) {
    throw new ConvexError({
      code: "VOICE_USAGE_AUTHORITY_CLOSED",
      message: "The realtime voice usage authority is closed.",
    });
  }
  return await persistManagedUsageAuthorized(ctx, args.usage);
};

const consumeVoiceUsageReservationAuthorized = async (
  ctx: MutationCtx,
  lease: VoiceRealtimeLeaseRow,
  costMicroCents: number,
  now: number,
): Promise<number> => {
  if (lease.usageReservationState !== "active") return 0;
  const remaining = Math.max(0, Math.floor(lease.usageReservedMicroCents ?? 0));
  const consumed = Math.min(remaining, Math.max(0, Math.floor(costMicroCents)));
  if (consumed > 0) {
    await adjustManagedUsageReservationAuthorized(ctx, {
      ownerId: lease.ownerId,
      deltaMicroCents: -consumed,
      now,
    });
  }
  return remaining - consumed;
};

const releaseVoiceUsageReservationAuthorized = async (
  ctx: MutationCtx,
  lease: VoiceRealtimeLeaseRow,
  now: number,
): Promise<void> => {
  if (lease.usageReservationState !== "active") return;
  const remaining = Math.max(0, Math.floor(lease.usageReservedMicroCents ?? 0));
  if (remaining > 0) {
    await adjustManagedUsageReservationAuthorized(ctx, {
      ownerId: lease.ownerId,
      deltaMicroCents: -remaining,
      now,
    });
  }
};

const finalizeVoiceRealtimeUsageAuthority = async (
  ctx: MutationCtx,
  lease: VoiceRealtimeLeaseRow,
  args: {
    now: number;
    reason: string;
    disposition: "drained" | "unresolved";
    /** Untrusted renderer telemetry; never sufficient to release spend. */
    transportClosedAt?: number;
    /** Stella-observed OpenAI hangup success (or provider-terminal 404). */
    providerVerifiedClosedAt?: number;
  },
): Promise<void> => {
  const existingDisposition = lease.usageDisposition ?? "pending";
  if (
    existingDisposition === "exact" ||
    existingDisposition === "conservative_fallback"
  ) {
    if (lease.usageReservationState === "active") {
      await releaseVoiceUsageReservationAuthorized(ctx, lease, args.now);
      await ctx.db.patch(lease._id, {
        usageReservationState: "released",
        usageReservedMicroCents: 0,
        updatedAt: args.now,
      });
    }
    return;
  }
  const claimedTransportCloseAt =
    typeof args.transportClosedAt === "number" &&
    Number.isFinite(args.transportClosedAt)
      ? Math.floor(args.transportClosedAt)
      : null;

  if (claimedTransportCloseAt !== null) {
    await ctx.db.patch(lease._id, {
      clientTransportClosedAt: claimedTransportCloseAt,
      updatedAt: args.now,
    });
  }

  // A managed OpenAI call can be closed only with the server-held Location
  // locator. Renderer ACK/drained claims are telemetry and never release the
  // reservation. The durable action is replay-safe across crashes/restarts.
  if (lease.providerCallId && args.providerVerifiedClosedAt === undefined) {
    const retryAt = args.now;
    const hardReapAt = lease.providerHardExpiresAt;
    await ctx.db.patch(lease._id, {
      usageDisposition: "revocation_pending",
      usageAuthorityClosedAt: lease.usageAuthorityClosedAt ?? args.now,
      usageAuthorityClosedReason: args.reason,
      providerHangupState:
        lease.providerHangupState === "ambiguous" ? "ambiguous" : "requested",
      providerHangupRequestedReason:
        lease.providerHangupRequestedReason ?? args.reason,
      providerHangupNextRetryAt: retryAt,
      ...(hardReapAt !== undefined ? { sessionReapAt: hardReapAt } : {}),
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.billing.hangupOpenAiVoiceCallInternal,
      {
        ownerId: lease.ownerId,
        ownerGeneration: lease.ownerGeneration ?? "legacy",
        stellaSessionId: lease.stellaSessionId,
        providerCallId: lease.providerCallId,
      },
    );
    if (hardReapAt !== undefined && hardReapAt > args.now) {
      await ctx.scheduler.runAt(
        hardReapAt,
        internal.billing.reapVoiceRealtimeSessionInternal,
        {
          ownerId: lease.ownerId,
          ownerGeneration: lease.ownerGeneration ?? "legacy",
          stellaSessionId: lease.stellaSessionId,
          reapAt: hardReapAt,
        },
      );
    }
    return;
  }

  // No provider call locator means either the renderer never started SDP, or
  // the provider-create attempt is still ambiguous. Release only after the
  // exact dispatch-debt row is absent in this OCC transaction.
  if (!lease.providerCallId) {
    if (lease.provider !== "openai") {
      await ctx.db.patch(lease._id, {
        usageDisposition: "unresolved",
        usageAuthorityClosedAt: lease.usageAuthorityClosedAt ?? args.now,
        usageAuthorityClosedReason: "managed_provider_without_revocation",
        updatedAt: args.now,
      });
      return;
    }
    const providerAttempt = await ctx.db
      .query("voice_provider_dispatch_leases")
      .withIndex("by_ownerId_and_stellaSessionId_and_createdAt", (q) =>
        q
          .eq("ownerId", lease.ownerId)
          .eq("stellaSessionId", lease.stellaSessionId),
      )
      .first();
    if (providerAttempt) {
      const reapAt = Math.max(args.now + 1, providerAttempt.quiescentAfterAt);
      await ctx.db.patch(lease._id, {
        usageDisposition: "unresolved",
        usageAuthorityClosedAt: lease.usageAuthorityClosedAt ?? args.now,
        usageAuthorityClosedReason: args.reason,
        sessionReapAt: reapAt,
        updatedAt: args.now,
      });
      await ctx.scheduler.runAt(
        reapAt,
        internal.billing.reapVoiceRealtimeSessionInternal,
        {
          ownerId: lease.ownerId,
          ownerGeneration: lease.ownerGeneration ?? "legacy",
          stellaSessionId: lease.stellaSessionId,
          reapAt,
        },
      );
      return;
    }

    if (
      lease.providerCallCreateStartedAt !== undefined &&
      args.providerVerifiedClosedAt === undefined
    ) {
      const hardReapAt = Math.max(
        args.now + 1,
        lease.providerHardExpiresAt ??
          lease.providerCallCreateStartedAt +
            OPENAI_REALTIME_PROVIDER_HARD_MAX_MS,
      );
      await ctx.db.patch(lease._id, {
        usageDisposition: "unresolved",
        usageAuthorityClosedAt: lease.usageAuthorityClosedAt ?? args.now,
        usageAuthorityClosedReason: "provider_call_response_lost",
        providerHangupState: "ambiguous",
        providerHangupLastError: "provider_call_response_lost",
        sessionReapAt: hardReapAt,
        updatedAt: args.now,
      });
      await ctx.scheduler.runAt(
        hardReapAt,
        internal.billing.reapVoiceRealtimeSessionInternal,
        {
          ownerId: lease.ownerId,
          ownerGeneration: lease.ownerGeneration ?? "legacy",
          stellaSessionId: lease.stellaSessionId,
          reapAt: hardReapAt,
        },
      );
      return;
    }

    if (lease.providerCallCreateStartedAt === undefined) {
      await releaseVoiceUsageReservationAuthorized(ctx, lease, args.now);
      await ctx.db.patch(lease._id, {
        usageDisposition: "exact",
        usageDispositionAt: args.now,
        usageAuthorityClosedAt: args.now,
        usageAuthorityClosedReason: args.reason,
        usageReservationState: "released",
        usageReservedMicroCents: 0,
        updatedAt: args.now,
      });
      return;
    }
  }

  const openedAt = Math.max(
    lease.leaseStartedAt,
    lease.providerCallCreateStartedAt ??
      lease.providerCallBoundAt ??
      lease.providerOpenedAt ??
      lease.leaseStartedAt,
  );
  const boundedCloseAt = Math.max(
    openedAt,
    Math.floor(args.providerVerifiedClosedAt ?? openedAt),
  );
  const lastProvenOpenAt = Math.max(
    openedAt,
    Math.min(boundedCloseAt, lease.providerLastProvenOpenAt ?? openedAt),
  );

  const providerDispatchId =
    lease.providerDispatchId ?? `legacy-dispatch:${lease.stellaSessionId}`;
  const providerAttemptId =
    lease.providerAttemptId ??
    lease.authorityLeaseId ??
    `legacy-attempt:${lease.stellaSessionId}`;
  const authorityLeaseId = lease.authorityLeaseId ?? providerAttemptId;
  const authorityEpoch = Math.max(1, Math.floor(lease.authorityEpoch ?? 1));
  const quantumMs = Math.max(
    1,
    Math.floor(
      lease.usageBillingQuantumMs ?? VOICE_REALTIME_USAGE_BILLING_QUANTUM_MS,
    ),
  );
  const rateMicroCents = Math.max(
    1,
    Math.floor(
      lease.usageFallbackRateMicroCentsPerQuantum ??
        getVoiceRealtimeFallbackRate(lease.provider),
    ),
  );
  const fallbackDurationMs = Math.max(0, boundedCloseAt - openedAt);
  const billedQuanta = Math.max(1, Math.ceil(fallbackDurationMs / quantumMs));
  const defaultCap = Math.max(
    0,
    Math.floor(lease.usageReservedMicroCents ?? 0) +
      Math.max(0, Math.floor(lease.estimatedCostMicroCents)),
  );
  const chargeCapMicroCents = Math.max(
    0,
    Math.floor(lease.usageFallbackChargeCapMicroCents ?? defaultCap),
  );
  const conservativeEnvelopeMicroCents = Math.min(
    chargeCapMicroCents,
    billedQuanta * rateMicroCents,
  );
  // Exact response receipts already charged against this physical session are
  // subtracted, so the fallback is a conservative residual, never a double
  // charge for responses that successfully crossed the receipt boundary.
  const fallbackCostMicroCents = Math.min(
    Math.max(0, Math.floor(lease.usageReservedMicroCents ?? 0)),
    Math.max(
      0,
      conservativeEnvelopeMicroCents -
        Math.max(0, Math.floor(lease.estimatedCostMicroCents)),
    ),
  );
  const responseId = voiceFallbackReceiptId(
    lease.stellaSessionId,
    providerAttemptId,
  );
  const requestFingerprint = await hashSha256Hex(
    JSON.stringify({
      disposition: "conservative_fallback",
      ownerGeneration: lease.ownerGeneration ?? "legacy",
      stellaSessionId: lease.stellaSessionId,
      providerDispatchId,
      providerAttemptId,
      authorityLeaseId,
      authorityEpoch,
      pricingRevision:
        lease.usagePricingRevision ?? VOICE_REALTIME_FALLBACK_PRICING_REVISION,
      quantumMs,
      rateMicroCents,
      chargeCapMicroCents,
      openedAt,
      lastProvenOpenAt,
      boundedCloseAt,
      fallbackDurationMs,
      fallbackCostMicroCents,
    }),
  );
  const existingReceipt = await getExistingVoiceUsageReceipt(
    ctx,
    lease.ownerId,
    responseId,
  );
  if (existingReceipt) {
    if (
      existingReceipt.providerDispatchId !== providerDispatchId ||
      existingReceipt.providerAttemptId !== providerAttemptId ||
      existingReceipt.requestFingerprint !== requestFingerprint ||
      existingReceipt.disposition !== "conservative_fallback" ||
      existingReceipt.costMicroCents !== fallbackCostMicroCents
    ) {
      throw new Error("Realtime voice fallback receipt changed on replay.");
    }
  } else {
    if (fallbackCostMicroCents > 0) {
      await persistManagedUsageAuthorized(ctx, {
        ownerId: lease.ownerId,
        ownerGeneration: lease.ownerGeneration ?? "legacy",
        conversationId: lease.conversationId ?? null,
        agentType: "service:voice:realtime:fallback",
        model: lease.model,
        durationMs: fallbackDurationMs,
        success: false,
        costMicroCents: fallbackCostMicroCents,
      });
    }
    await ctx.db.insert("billing_voice_usage_receipts", {
      ownerId: lease.ownerId,
      ownerGeneration: lease.ownerGeneration ?? "legacy",
      providerDispatchId,
      providerAttemptId,
      stellaSessionId: lease.stellaSessionId,
      authorityLeaseId,
      authorityEpoch,
      requestFingerprint,
      disposition: "conservative_fallback",
      responseId,
      model: lease.model,
      ...(lease.conversationId ? { conversationId: lease.conversationId } : {}),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      textInputTokens: 0,
      textCachedInputTokens: 0,
      textOutputTokens: 0,
      audioInputTokens: 0,
      audioCachedInputTokens: 0,
      audioOutputTokens: 0,
      imageInputTokens: 0,
      imageCachedInputTokens: 0,
      costMicroCents: fallbackCostMicroCents,
      createdAt: args.now,
    });
  }
  await releaseVoiceUsageReservationAuthorized(ctx, lease, args.now);
  await ctx.db.patch(lease._id, {
    usageDisposition: "conservative_fallback",
    usageDispositionAt: args.now,
    usageAuthorityClosedAt: args.now,
    usageAuthorityClosedReason:
      args.disposition === "drained"
        ? `client_drained_unverified:${args.reason}`.slice(0, 160)
        : args.reason,
    providerClosedAt: boundedCloseAt,
    providerHangupState: "confirmed",
    providerHangupConfirmedAt: boundedCloseAt,
    providerHangupActiveAttemptId: undefined,
    providerHangupLeaseExpiresAt: undefined,
    providerHangupNextRetryAt: undefined,
    providerHangupLastError: undefined,
    fallbackDurationMs,
    fallbackCostMicroCents,
    usageReservationState: "released",
    usageReservedMicroCents: 0,
    updatedAt: args.now,
  });
};

const voiceDispatchKindMatchesProvider = (
  kind:
    | "xai_client_secret"
    | "openai_client_secret"
    | "openai_call"
    | "inworld_ice_servers"
    | "inworld_sdp",
  provider: string,
): boolean =>
  (kind === "xai_client_secret" && provider === "xai") ||
  ((kind === "openai_client_secret" || kind === "openai_call") &&
    provider === "openai") ||
  ((kind === "inworld_ice_servers" || kind === "inworld_sdp") &&
    provider === "inworld");

const exactVoiceProviderAttemptActive = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    stellaSessionId: string;
    dispatchId: string;
    attemptId: string;
    provider: string;
    now: number;
  },
): Promise<boolean> => {
  const attempt = await readExactVoiceProviderAttempt(
    ctx,
    args.dispatchId,
    args.attemptId,
  );
  return Boolean(
    attempt &&
      attempt.ownerId === args.ownerId &&
      attempt.ownerGeneration === args.ownerGeneration &&
      attempt.stellaSessionId === args.stellaSessionId &&
      voiceDispatchKindMatchesProvider(attempt.kind, args.provider) &&
      attempt.state === "active" &&
      args.now < attempt.providerDeadlineAt &&
      args.now < attempt.leaseExpiresAt,
  );
};

export const getVoiceRealtimeLeaseFence = internalQuery({
  args: {
    ownerId: v.string(),
    stellaSessionId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      ownerGeneration: v.string(),
      provider: voiceRealtimeProviderValidator,
      status: v.string(),
      providerDispatchId: v.union(v.string(), v.null()),
      providerAttemptId: v.union(v.string(), v.null()),
      authorityLeaseId: v.union(v.string(), v.null()),
      authorityEpoch: v.union(v.number(), v.null()),
      authorityExpiresAt: v.union(v.number(), v.null()),
      authorityState: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (!lease || lease.ownerId !== args.ownerId) return null;
    const provider = lease.provider;
    let normalizedProvider: "openai" | "xai" | "inworld";
    switch (provider) {
      case "openai":
      case "xai":
      case "inworld":
        normalizedProvider = provider;
        break;
      default:
        return null;
    }
    return {
      ownerGeneration: lease.ownerGeneration ?? "legacy",
      provider: normalizedProvider,
      status: lease.status,
      providerDispatchId: lease.providerDispatchId ?? null,
      providerAttemptId: lease.providerAttemptId ?? null,
      authorityLeaseId: lease.authorityLeaseId ?? null,
      authorityEpoch: lease.authorityEpoch ?? null,
      authorityExpiresAt: lease.authorityExpiresAt ?? null,
      authorityState: lease.authorityState ?? null,
    };
  },
});

/** Final transaction-plane fence immediately before realtime provider IO. */
export const assertVoiceRealtimeProviderDispatchAllowed = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    provider: voiceRealtimeProviderValidator,
    phase: v.union(v.literal("minting"), v.literal("active")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    return Boolean(
      lease &&
        lease.ownerId === args.ownerId &&
        (lease.ownerGeneration ?? "legacy") === args.ownerGeneration &&
        lease.provider === args.provider &&
        lease.status === args.phase,
    );
  },
});

export const prepareVoiceRealtimeLease = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    provider: voiceRealtimeProviderValidator,
    model: v.string(),
    voice: v.string(),
    stellaSessionId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    providerSessionConfigJson: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      allowed: v.literal(false),
      message: v.string(),
      blockedSessionId: v.string(),
    }),
    v.object({
      allowed: v.literal(true),
      ownerGeneration: v.string(),
      stellaSessionId: v.string(),
      leaseExpiresAt: v.number(),
      leaseDurationMs: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const { generation: ownerGeneration } =
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    const now = Date.now();
    if (args.provider !== "openai") {
      return {
        allowed: false as const,
        message:
          "Managed realtime voice is unavailable for providers without a Stella-verifiable revocation boundary.",
        blockedSessionId: args.stellaSessionId,
      };
    }
    const [activeVoiceLeases, mintingVoiceLeases, unreportedGraceVoiceLeases] =
      await Promise.all([
        ctx.db
          .query("billing_voice_sessions")
          .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
            q.eq("ownerId", args.ownerId).eq("status", "active"),
          )
          .take(20),
        ctx.db
          .query("billing_voice_sessions")
          .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
            q.eq("ownerId", args.ownerId).eq("status", "minting"),
          )
          .take(20),
        ctx.db
          .query("billing_voice_sessions")
          .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("status", "superseded_unreported_grace"),
          )
          .take(20),
      ]);
    const activeLeases = [
      ...activeVoiceLeases,
      ...mintingVoiceLeases,
      ...unreportedGraceVoiceLeases,
    ];

    for (const lease of activeLeases) {
      if ((lease.ownerGeneration ?? "legacy") !== ownerGeneration) continue;
      // Superseding a managed session is a server-side cancellation event,
      // not merely a renderer hint. A bound OpenAI call is moved to durable
      // revocation debt and its hangup action is scheduled immediately. An
      // exactly-undispatched prepare is released in this same OCC transaction;
      // an in-flight or response-lost create remains reserved until its fixed
      // provider-safety boundary proves settlement.
      await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
        now,
        reason: "new_lease",
        disposition: "unresolved",
      });
      const reported = isVoiceLeaseReported(lease);
      const authorityCancelPatch =
        lease.authorityState === "active" &&
        lease.authorityLeaseId &&
        typeof lease.authorityEpoch === "number" &&
        typeof lease.authorityExpiresAt === "number"
          ? {
              authorityState: "cancel_requested" as const,
              authorityEpoch: Math.max(1, Math.floor(lease.authorityEpoch)) + 1,
              authorityCancelReason: "new_lease",
              authorityCancelRequestedAt: now,
            }
          : {};
      const pastHeartbeatGrace =
        now - lease.createdAt > VOICE_REALTIME_LEASE_HEARTBEAT_GRACE_MS;
      const pastExpiryGrace =
        now > lease.leaseExpiresAt + VOICE_REALTIME_LEASE_EXPIRY_GRACE_MS;

      if (!reported && (pastHeartbeatGrace || pastExpiryGrace)) {
        await ctx.db.patch(lease._id, {
          status: "blocked_missing_report",
          endedAt: now,
          endReason: "missing_report",
          ...authorityCancelPatch,
          updatedAt: now,
        });
        return {
          allowed: false as const,
          message:
            "Realtime voice paused because the previous session did not report usage. Restart Stella and try again.",
          blockedSessionId: lease.stellaSessionId,
        };
      }

      if (reported) {
        await ctx.db.patch(lease._id, {
          status: "superseded",
          endedAt: now,
          endReason: "new_lease",
          ...authorityCancelPatch,
          updatedAt: now,
        });
      } else if (lease.status !== "superseded_unreported_grace") {
        await ctx.db.patch(lease._id, {
          status: "superseded_unreported_grace",
          endedAt: now,
          endReason: "new_lease",
          ...authorityCancelPatch,
          updatedAt: now,
        });
      }
    }

    const outstandingReservation = await ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_usageReservationState_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("usageReservationState", "active"),
      )
      .first();
    if (outstandingReservation) {
      return {
        allowed: false as const,
        message:
          "Realtime voice is waiting for the previous managed-usage reservation to settle.",
        blockedSessionId: outstandingReservation.stellaSessionId,
      };
    }

    const usageFallbackRateMicroCentsPerQuantum = getVoiceRealtimeFallbackRate(
      args.provider,
    );
    const maximumSessionReservationMicroCents =
      Math.ceil(
        OPENAI_REALTIME_PROVIDER_HARD_MAX_MS /
          VOICE_REALTIME_USAGE_BILLING_QUANTUM_MS,
      ) * usageFallbackRateMicroCentsPerQuantum;
    const availableManagedUsageMicroCents =
      await getOwnerAvailableManagedUsageMicroCents(ctx, {
        ownerId: args.ownerId,
        now,
      });
    if (
      Number.isFinite(availableManagedUsageMicroCents) &&
      availableManagedUsageMicroCents < maximumSessionReservationMicroCents
    ) {
      return {
        allowed: false as const,
        message:
          "Realtime voice needs enough unreserved managed usage for its bounded session lease.",
        blockedSessionId:
          activeLeases[0]?.stellaSessionId ?? args.stellaSessionId,
      };
    }
    const usageFallbackChargeCapMicroCents =
      maximumSessionReservationMicroCents;
    const leaseExpiresAt = now + VOICE_REALTIME_LEASE_DURATION_MS;
    const sessionReapAt = now + VOICE_REALTIME_MINT_REAPER_MS;
    await adjustManagedUsageReservationAuthorized(ctx, {
      ownerId: args.ownerId,
      deltaMicroCents: usageFallbackChargeCapMicroCents,
      now,
    });
    await ctx.db.insert("billing_voice_sessions", {
      ownerId: args.ownerId,
      ownerGeneration,
      stellaSessionId: args.stellaSessionId,
      provider: args.provider,
      model: args.model,
      voice: args.voice,
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      ...(args.providerSessionConfigJson
        ? { providerSessionConfigJson: args.providerSessionConfigJson }
        : {}),
      status: "minting",
      usageDisposition: "pending",
      usagePricingRevision: VOICE_REALTIME_FALLBACK_PRICING_REVISION,
      usageBillingQuantumMs: VOICE_REALTIME_USAGE_BILLING_QUANTUM_MS,
      usageFallbackRateMicroCentsPerQuantum,
      usageFallbackChargeCapMicroCents,
      usageReservationState: "active",
      usageReservedMicroCents: usageFallbackChargeCapMicroCents,
      providerHardExpiresAt: now + OPENAI_REALTIME_PROVIDER_HARD_MAX_MS,
      leaseStartedAt: now,
      leaseExpiresAt,
      sessionReapAt,
      heartbeatCount: 0,
      responseCount: 0,
      estimatedCostMicroCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      realtimeAudioSeconds: 0,
      sttAudioSeconds: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      sessionReapAt,
      internal.billing.reapVoiceRealtimeSessionInternal,
      {
        ownerId: args.ownerId,
        ownerGeneration,
        stellaSessionId: args.stellaSessionId,
        reapAt: sessionReapAt,
      },
    );

    return {
      allowed: true as const,
      ownerGeneration,
      stellaSessionId: args.stellaSessionId,
      leaseExpiresAt,
      leaseDurationMs: VOICE_REALTIME_LEASE_DURATION_MS,
    };
  },
});

/**
 * Compensates the narrow prepare -> provider-dispatch race without reopening
 * lifecycle authority. The empty exact-attempt index range and the session
 * patch share one OCC transaction with reservation release: a concurrent
 * provider reservation either wins first (and this returns false) or retries
 * after the session becomes non-dispatchable.
 */
export const releaseUndispatchedVoiceRealtimeLeaseInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    reason: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.providerDispatchId !== undefined ||
      lease.providerAttemptId !== undefined ||
      lease.providerOpenedAt !== undefined ||
      (lease.usageDisposition ?? "pending") !== "pending"
    ) {
      return false;
    }
    const providerAttempt = await ctx.db
      .query("voice_provider_dispatch_leases")
      .withIndex("by_ownerId_and_stellaSessionId_and_createdAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("stellaSessionId", args.stellaSessionId),
      )
      .first();
    if (providerAttempt) return false;
    const now = Date.now();
    await releaseVoiceUsageReservationAuthorized(ctx, lease, now);
    await ctx.db.patch(lease._id, {
      status: "failed",
      usageDisposition: "exact",
      usageDispositionAt: now,
      usageAuthorityClosedAt: now,
      usageAuthorityClosedReason: args.reason.slice(0, 120),
      usageReservationState: "released",
      usageReservedMicroCents: 0,
      endedAt: now,
      endReason: args.reason.slice(0, 120),
      updatedAt: now,
    });
    return true;
  },
});

const openAiVoiceAuthorityResultValidator = v.union(
  v.object({ activated: v.literal(false) }),
  v.object({
    activated: v.literal(true),
    ownerGeneration: v.string(),
    providerDispatchId: v.string(),
    providerAttemptId: v.string(),
    authorityLeaseId: v.string(),
    authorityEpoch: v.number(),
    authorityExpiresAt: v.number(),
    authorityLeaseDurationMs: v.number(),
    authorityPollIntervalMs: v.number(),
  }),
);

/**
 * Issues renderer authority without minting a provider credential. The exact
 * provider attempt id is pre-bound so the later SDP action cannot switch the
 * physical call behind an already-issued usage tuple.
 */
export const issueOpenAiVoiceRealtimeAuthority = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    providerDispatchId: v.string(),
    providerAttemptId: v.string(),
  },
  returns: openAiVoiceAuthorityResultValidator,
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    const expectedDispatchId = `voice:openai_call:${args.stellaSessionId}`;
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.provider !== "openai" ||
      lease.status !== "minting" ||
      args.providerDispatchId !== expectedDispatchId ||
      !args.providerAttemptId.trim() ||
      !lease.providerSessionConfigJson
    ) {
      return { activated: false as const };
    }
    const now = Date.now();
    const authorityLeaseId = args.providerAttemptId;
    const authorityEpoch = 1;
    const authorityExpiresAt = Math.min(
      lease.leaseExpiresAt,
      now + VOICE_REALTIME_AUTHORITY_LEASE_MS,
    );
    const sessionReapAt = voiceAuthorityQuiescentAfter(authorityExpiresAt);
    await ctx.db.patch(lease._id, {
      status: "active",
      providerDispatchId: args.providerDispatchId,
      providerAttemptId: args.providerAttemptId,
      authorityLeaseId,
      authorityEpoch,
      authorityState: "active",
      authorityExpiresAt,
      usageDisposition: "pending",
      sessionReapAt,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      sessionReapAt,
      internal.billing.reapVoiceRealtimeSessionInternal,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        stellaSessionId: args.stellaSessionId,
        reapAt: sessionReapAt,
      },
    );
    return {
      activated: true as const,
      ownerGeneration: args.ownerGeneration,
      providerDispatchId: args.providerDispatchId,
      providerAttemptId: args.providerAttemptId,
      authorityLeaseId,
      authorityEpoch,
      authorityExpiresAt,
      authorityLeaseDurationMs: VOICE_REALTIME_AUTHORITY_LEASE_MS,
      authorityPollIntervalMs: VOICE_REALTIME_AUTHORITY_POLL_MS,
    };
  },
});

export const getOpenAiVoiceCallFence = internalQuery({
  args: {
    ownerId: v.string(),
    stellaSessionId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      ownerGeneration: v.string(),
      providerDispatchId: v.string(),
      providerAttemptId: v.string(),
      authorityLeaseId: v.string(),
      authorityEpoch: v.number(),
      authorityExpiresAt: v.number(),
      status: v.string(),
      authorityState: v.string(),
      usageDisposition: v.string(),
      model: v.string(),
      providerSessionConfigJson: v.string(),
      providerCallId: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      lease.provider !== "openai" ||
      !lease.providerDispatchId ||
      !lease.providerAttemptId ||
      !lease.authorityLeaseId ||
      typeof lease.authorityEpoch !== "number" ||
      typeof lease.authorityExpiresAt !== "number" ||
      !lease.authorityState ||
      !lease.providerSessionConfigJson
    ) {
      return null;
    }
    return {
      ownerGeneration: lease.ownerGeneration ?? "legacy",
      providerDispatchId: lease.providerDispatchId,
      providerAttemptId: lease.providerAttemptId,
      authorityLeaseId: lease.authorityLeaseId,
      authorityEpoch: lease.authorityEpoch,
      authorityExpiresAt: lease.authorityExpiresAt,
      status: lease.status,
      authorityState: lease.authorityState,
      usageDisposition: lease.usageDisposition ?? "pending",
      model: lease.model,
      providerSessionConfigJson: lease.providerSessionConfigJson,
      providerCallId: lease.providerCallId ?? null,
    };
  },
});

export const markOpenAiVoiceProviderCallStarted = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    providerDispatchId: v.string(),
    providerAttemptId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.provider !== "openai" ||
      lease.status !== "active" ||
      lease.authorityState !== "active" ||
      lease.providerCallCreateStartedAt !== undefined ||
      lease.providerDispatchId !== args.providerDispatchId ||
      lease.providerAttemptId !== args.providerAttemptId ||
      !(await exactVoiceProviderAttemptActive(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        stellaSessionId: args.stellaSessionId,
        dispatchId: args.providerDispatchId,
        attemptId: args.providerAttemptId,
        provider: "openai",
        now: Date.now(),
      }))
    ) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(lease._id, {
      providerCallCreateStartedAt: now,
      providerHardExpiresAt: now + OPENAI_REALTIME_PROVIDER_HARD_MAX_MS,
      providerLastProvenOpenAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** A consumed non-success response proves this exact create made no call. */
export const markOpenAiVoiceProviderCallNotCreated = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    providerDispatchId: v.string(),
    providerAttemptId: v.string(),
    providerStatus: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    const attempt = await readExactVoiceProviderAttempt(
      ctx,
      args.providerDispatchId,
      args.providerAttemptId,
    );
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.provider !== "openai" ||
      lease.providerDispatchId !== args.providerDispatchId ||
      lease.providerAttemptId !== args.providerAttemptId ||
      lease.providerCallCreateStartedAt === undefined ||
      lease.providerCallId !== undefined ||
      !attempt ||
      attempt.ownerId !== args.ownerId ||
      attempt.ownerGeneration !== args.ownerGeneration ||
      attempt.stellaSessionId !== args.stellaSessionId ||
      attempt.kind !== "openai_call"
    ) {
      return false;
    }
    const now = Date.now();
    await releaseVoiceUsageReservationAuthorized(ctx, lease, now);
    await ctx.db.patch(lease._id, {
      status: "failed",
      authorityState: "released",
      authorityExpiresAt: now,
      usageDisposition: "exact",
      usageDispositionAt: now,
      usageAuthorityClosedAt: now,
      usageAuthorityClosedReason: `openai_call_not_created_${Math.floor(args.providerStatus)}`,
      usageReservationState: "released",
      usageReservedMicroCents: 0,
      sessionReapAt: undefined,
      endedAt: now,
      endReason: `openai_call_not_created_${Math.floor(args.providerStatus)}`,
      updatedAt: now,
    });
    return true;
  },
});

/** Capture the OpenAI Location call id before the SDP answer is publishable. */
export const bindOpenAiVoiceProviderCall = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    providerDispatchId: v.string(),
    providerAttemptId: v.string(),
    providerCallId: v.string(),
  },
  returns: v.object({ bound: v.boolean(), deliveryAllowed: v.boolean() }),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    const attempt = await readExactVoiceProviderAttempt(
      ctx,
      args.providerDispatchId,
      args.providerAttemptId,
    );
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.provider !== "openai" ||
      lease.providerDispatchId !== args.providerDispatchId ||
      lease.providerAttemptId !== args.providerAttemptId ||
      !attempt ||
      attempt.ownerId !== args.ownerId ||
      attempt.ownerGeneration !== args.ownerGeneration ||
      attempt.stellaSessionId !== args.stellaSessionId ||
      attempt.kind !== "openai_call" ||
      !args.providerCallId.trim()
    ) {
      return { bound: false, deliveryAllowed: false };
    }
    if (lease.providerCallId && lease.providerCallId !== args.providerCallId) {
      throw new ConvexError({
        code: "VOICE_PROVIDER_CALL_CONFLICT",
        message: "The voice attempt is already bound to another provider call.",
      });
    }
    const now = Date.now();
    let lifecycleAllowed = true;
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      lifecycleAllowed = false;
    }
    const deliveryAllowed = Boolean(
      lifecycleAllowed &&
        lease.status === "active" &&
        lease.authorityState === "active" &&
        (lease.usageDisposition ?? "pending") === "pending" &&
        attempt.state === "active" &&
        now < attempt.providerDeadlineAt &&
        now < attempt.leaseExpiresAt,
    );
    await ctx.db.patch(lease._id, {
      providerCallId: args.providerCallId,
      providerCallBoundAt: lease.providerCallBoundAt ?? now,
      providerOpenedAt: lease.providerOpenedAt ?? now,
      providerLastProvenOpenAt: now,
      providerHangupState: deliveryAllowed ? "open" : "requested",
      ...(deliveryAllowed
        ? {}
        : {
            usageDisposition: "revocation_pending" as const,
            usageAuthorityClosedAt: now,
            usageAuthorityClosedReason: "provider_response_fenced",
            providerHangupRequestedReason: "provider_response_fenced",
            providerHangupNextRetryAt: now,
          }),
      updatedAt: now,
    });
    if (!deliveryAllowed) {
      await ctx.scheduler.runAfter(
        0,
        internal.billing.hangupOpenAiVoiceCallInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          stellaSessionId: args.stellaSessionId,
          providerCallId: args.providerCallId,
        },
      );
    }
    return { bound: true, deliveryAllowed };
  },
});

export const requestOpenAiVoiceHangupInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    providerCallId: v.string(),
    reason: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.provider !== "openai" ||
      lease.providerCallId !== args.providerCallId ||
      lease.providerHangupState === "confirmed"
    ) {
      return false;
    }
    await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
      now: Date.now(),
      reason: args.reason.slice(0, 160),
      disposition: "unresolved",
    });
    return true;
  },
});

export const activateVoiceRealtimeLease = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    clientSecretFingerprint: v.optional(v.string()),
    providerSessionId: v.optional(v.string()),
    providerExpiresAt: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ activated: v.literal(false) }),
    v.object({
      activated: v.literal(true),
      ownerGeneration: v.string(),
      providerDispatchId: v.string(),
      providerAttemptId: v.string(),
      authorityLeaseId: v.string(),
      authorityEpoch: v.number(),
      authorityExpiresAt: v.number(),
      authorityLeaseDurationMs: v.number(),
      authorityPollIntervalMs: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    const now = Date.now();
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.status !== "minting" ||
      !(await exactVoiceProviderAttemptActive(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        stellaSessionId: args.stellaSessionId,
        dispatchId: args.dispatchId,
        attemptId: args.attemptId,
        provider: lease.provider,
        now,
      }))
    ) {
      return { activated: false as const };
    }

    const authorityLeaseId = args.attemptId;
    const authorityEpoch = 1;
    const authorityExpiresAt = Math.min(
      lease.leaseExpiresAt,
      now + VOICE_REALTIME_AUTHORITY_LEASE_MS,
    );
    const sessionReapAt = voiceAuthorityQuiescentAfter(authorityExpiresAt);
    await ctx.db.patch(lease._id, {
      status: "active",
      providerDispatchId: args.dispatchId,
      providerAttemptId: args.attemptId,
      authorityLeaseId,
      authorityEpoch,
      authorityState: "active",
      authorityExpiresAt,
      sessionReapAt,
      usageDisposition: "pending",
      providerOpenedAt: now,
      providerLastProvenOpenAt: now,
      ...(args.clientSecretFingerprint
        ? { clientSecretFingerprint: args.clientSecretFingerprint }
        : {}),
      ...(args.providerSessionId
        ? { providerSessionId: args.providerSessionId }
        : {}),
      ...(args.providerExpiresAt !== undefined
        ? { providerExpiresAt: args.providerExpiresAt }
        : {}),
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      sessionReapAt,
      internal.billing.reapVoiceRealtimeSessionInternal,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        stellaSessionId: args.stellaSessionId,
        reapAt: sessionReapAt,
      },
    );
    return {
      activated: true as const,
      ownerGeneration: args.ownerGeneration,
      providerDispatchId: args.dispatchId,
      providerAttemptId: args.attemptId,
      authorityLeaseId,
      authorityEpoch,
      authorityExpiresAt,
      authorityLeaseDurationMs: VOICE_REALTIME_AUTHORITY_LEASE_MS,
      authorityPollIntervalMs: VOICE_REALTIME_AUTHORITY_POLL_MS,
    };
  },
});

export const failVoiceRealtimeLease = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    reason: v.string(),
  },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    const now = Date.now();
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      (lease.status !== "minting" && lease.status !== "active") ||
      !(await exactVoiceProviderAttemptActive(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        stellaSessionId: args.stellaSessionId,
        dispatchId: args.dispatchId,
        attemptId: args.attemptId,
        provider: lease.provider,
        now,
      }))
    ) {
      return { updated: false };
    }
    await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
      now,
      reason: args.reason.slice(0, 120),
      disposition: "drained",
    });
    await ctx.db.patch(lease._id, {
      status: "failed",
      ...(lease.authorityState
        ? {
            authorityState: "released" as const,
            authorityExpiresAt: now,
          }
        : {}),
      endedAt: now,
      endReason: args.reason.slice(0, 120),
      updatedAt: now,
    });
    return { updated: true };
  },
});

export const recordVoiceRealtimeLeaseEvent = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    authorityLeaseId: v.string(),
    authorityEpoch: v.number(),
    event: voiceRealtimeLeaseEventValidator,
    usageDisposition: v.optional(
      voiceRealtimeTerminalUsageDispositionValidator,
    ),
    transportClosedAt: v.optional(v.number()),
  },
  returns: voiceRealtimeAuthorityResultValidator,
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      !args.authorityLeaseId.trim() ||
      lease.authorityLeaseId !== args.authorityLeaseId ||
      !lease.authorityState ||
      typeof lease.authorityEpoch !== "number" ||
      typeof lease.authorityExpiresAt !== "number" ||
      !Number.isSafeInteger(args.authorityEpoch) ||
      args.authorityEpoch < 1
    ) {
      return {
        recorded: false,
        directive: "invalid" as const,
        authorityEpoch: null,
        authorityExpiresAt: null,
        cancelReason: null,
      };
    }

    const now = Date.now();
    const currentEpoch = Math.max(1, Math.floor(lease.authorityEpoch));
    const currentExpiry = lease.authorityExpiresAt;
    const cancelReason = lease.authorityCancelReason ?? null;

    if (
      args.event === "heartbeat" &&
      (args.usageDisposition !== undefined ||
        args.transportClosedAt !== undefined)
    ) {
      return {
        recorded: false,
        directive: "invalid" as const,
        authorityEpoch: null,
        authorityExpiresAt: null,
        cancelReason: null,
      };
    }

    if (lease.authorityState === "cancel_requested") {
      if (args.event === "cancel_ack" && args.authorityEpoch === currentEpoch) {
        await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
          now,
          reason: cancelReason ?? "server_cancel",
          disposition: args.usageDisposition ?? "unresolved",
          transportClosedAt: args.transportClosedAt,
        });
        await ctx.db.patch(lease._id, {
          status: "canceled",
          authorityState: "acknowledged",
          authorityExpiresAt: now,
          authorityAcknowledgedAt: now,
          authorityAcknowledgedEpoch: currentEpoch,
          endedAt: lease.endedAt ?? now,
          endReason: lease.endReason ?? cancelReason ?? "server_cancel",
          updatedAt: now,
        });
        return {
          recorded: true,
          directive: "closed" as const,
          authorityEpoch: currentEpoch,
          authorityExpiresAt: now,
          cancelReason,
        };
      }
      if (args.authorityEpoch <= currentEpoch) {
        return {
          recorded: false,
          directive: "cancel" as const,
          authorityEpoch: currentEpoch,
          authorityExpiresAt: currentExpiry,
          cancelReason,
        };
      }
      return {
        recorded: false,
        directive: "invalid" as const,
        authorityEpoch: null,
        authorityExpiresAt: null,
        cancelReason: null,
      };
    }

    if (
      lease.authorityState === "acknowledged" ||
      lease.authorityState === "expired" ||
      lease.authorityState === "released"
    ) {
      return {
        recorded: false,
        directive: "closed" as const,
        authorityEpoch: currentEpoch,
        authorityExpiresAt: currentExpiry,
        cancelReason,
      };
    }

    if (args.authorityEpoch !== currentEpoch) {
      return {
        recorded: false,
        directive: "invalid" as const,
        authorityEpoch: null,
        authorityExpiresAt: null,
        cancelReason: null,
      };
    }

    if (args.event === "cancel_ack") {
      return {
        recorded: false,
        directive: "invalid" as const,
        authorityEpoch: null,
        authorityExpiresAt: null,
        cancelReason: null,
      };
    }

    if (args.event !== "heartbeat") {
      const status =
        args.event === "ended"
          ? "ended"
          : args.event === "expired"
            ? "client_expired"
            : "connection_lost";
      await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
        now,
        reason: args.event,
        disposition: args.usageDisposition ?? "unresolved",
        transportClosedAt: args.transportClosedAt,
      });
      await ctx.db.patch(lease._id, {
        status,
        authorityState: "released",
        authorityExpiresAt: now,
        endedAt: now,
        endReason: args.event,
        updatedAt: now,
      });
      return {
        recorded: true,
        directive: "closed" as const,
        authorityEpoch: currentEpoch,
        authorityExpiresAt: now,
        cancelReason: null,
      };
    }

    let lifecycleAllowsRenewal = true;
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      lifecycleAllowsRenewal = false;
    }
    const authorityLive = now < currentExpiry;
    const sessionLive = now < lease.leaseExpiresAt;
    if (
      lifecycleAllowsRenewal &&
      authorityLive &&
      sessionLive &&
      lease.status === "active"
    ) {
      const renewedExpiresAt = Math.min(
        lease.leaseExpiresAt,
        now + VOICE_REALTIME_AUTHORITY_LEASE_MS,
      );
      const sessionReapAt = voiceAuthorityQuiescentAfter(renewedExpiresAt);
      await ctx.db.patch(lease._id, {
        heartbeatCount: Math.max(0, Math.floor(lease.heartbeatCount)) + 1,
        lastHeartbeatAt: now,
        providerLastProvenOpenAt: now,
        authorityExpiresAt: renewedExpiresAt,
        sessionReapAt,
        updatedAt: now,
      });
      await ctx.scheduler.runAt(
        sessionReapAt,
        internal.billing.reapVoiceRealtimeSessionInternal,
        {
          ownerId: lease.ownerId,
          ownerGeneration: lease.ownerGeneration ?? "legacy",
          stellaSessionId: lease.stellaSessionId,
          reapAt: sessionReapAt,
        },
      );
      return {
        recorded: true,
        directive: "continue" as const,
        authorityEpoch: currentEpoch,
        authorityExpiresAt: renewedExpiresAt,
        cancelReason: null,
      };
    }

    const nextEpoch = currentEpoch + 1;
    const nextCancelReason = !lifecycleAllowsRenewal
      ? "owner_lifecycle"
      : !authorityLive
        ? "authority_expired"
        : !sessionLive
          ? "session_expired"
          : "session_closed";
    await ctx.db.patch(lease._id, {
      authorityState: "cancel_requested",
      authorityEpoch: nextEpoch,
      authorityCancelReason: nextCancelReason,
      authorityCancelRequestedAt: now,
      updatedAt: now,
    });
    return {
      recorded: false,
      directive: "cancel" as const,
      authorityEpoch: nextEpoch,
      authorityExpiresAt: currentExpiry,
      cancelReason: nextCancelReason,
    };
  },
});

/**
 * Crash/offline expiry settlement. The lifecycle quiescence pass first closes
 * renderer and usage authority and leaves an explicit unresolved disposition;
 * this exact-tuple wake then materializes the bounded conservative receipt.
 */
export const finalizeExpiredVoiceRealtimeUsageInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    authorityLeaseId: v.string(),
    authorityEpoch: v.number(),
    authorityExpiresAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.authorityLeaseId !== args.authorityLeaseId ||
      lease.authorityEpoch !== args.authorityEpoch ||
      lease.authorityExpiresAt !== args.authorityExpiresAt ||
      lease.authorityState !== "expired" ||
      lease.usageDisposition !== "unresolved"
    ) {
      return false;
    }
    await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
      now: Date.now(),
      reason: lease.endReason ?? "authority_expired",
      disposition: "unresolved",
    });
    return true;
  },
});

/**
 * Exact scheduled reaper for both prepare crashes and renderer crashes. It
 * never treats disappearance of an ambiguous provider-create response as
 * proof that no remote call exists.
 */
export const reapVoiceRealtimeSessionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    reapAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    const now = Date.now();
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.sessionReapAt !== args.reapAt ||
      now < args.reapAt ||
      lease.usageReservationState !== "active" ||
      lease.usageDisposition === "exact" ||
      lease.usageDisposition === "conservative_fallback"
    ) {
      return false;
    }
    const providerAttempt = await ctx.db
      .query("voice_provider_dispatch_leases")
      .withIndex("by_ownerId_and_stellaSessionId_and_createdAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("stellaSessionId", args.stellaSessionId),
      )
      .first();
    if (providerAttempt) {
      const reapAt = Math.max(
        now + 1_000,
        providerAttempt.quiescentAfterAt + 1,
      );
      await ctx.db.patch(lease._id, { sessionReapAt: reapAt, updatedAt: now });
      await ctx.scheduler.runAt(
        reapAt,
        internal.billing.reapVoiceRealtimeSessionInternal,
        { ...args, reapAt },
      );
      return true;
    }

    if (lease.providerCallId) {
      const providerHardExpiresAt =
        lease.providerHardExpiresAt ??
        (lease.providerCallCreateStartedAt ??
          lease.providerCallBoundAt ??
          now) + OPENAI_REALTIME_PROVIDER_HARD_MAX_MS;
      await ctx.db.patch(lease._id, {
        authorityState:
          lease.authorityState === "acknowledged" ? "acknowledged" : "expired",
        authorityExpiresAt: Math.min(lease.authorityExpiresAt ?? now, now),
        status:
          lease.status === "canceled" || lease.status === "ended"
            ? lease.status
            : "client_expired",
        endedAt: lease.endedAt ?? now,
        endReason: lease.endReason ?? "authority_expired",
        updatedAt: now,
      });
      await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
        now,
        reason: lease.endReason ?? "authority_expired",
        disposition: "unresolved",
        ...(now >= providerHardExpiresAt
          ? { providerVerifiedClosedAt: providerHardExpiresAt }
          : {}),
      });
      return true;
    }

    if (lease.providerCallCreateStartedAt !== undefined) {
      const providerHardExpiresAt =
        lease.providerHardExpiresAt ??
        lease.providerCallCreateStartedAt +
          OPENAI_REALTIME_PROVIDER_HARD_MAX_MS;
      if (now < providerHardExpiresAt) {
        await ctx.db.patch(lease._id, {
          status: "blocked_missing_report",
          authorityState: lease.authorityState ? "expired" : undefined,
          authorityExpiresAt: lease.authorityState ? now : undefined,
          usageDisposition: "unresolved",
          usageAuthorityClosedAt: lease.usageAuthorityClosedAt ?? now,
          usageAuthorityClosedReason: "provider_call_response_lost",
          providerHangupState: "ambiguous",
          providerHangupLastError: "provider_call_response_lost",
          sessionReapAt: providerHardExpiresAt,
          endedAt: lease.endedAt ?? now,
          endReason: lease.endReason ?? "provider_call_response_lost",
          updatedAt: now,
        });
        await ctx.scheduler.runAt(
          providerHardExpiresAt,
          internal.billing.reapVoiceRealtimeSessionInternal,
          { ...args, reapAt: providerHardExpiresAt },
        );
        return true;
      }
      // At the documented provider hard horizon even an unlocated call is
      // terminal. Settle the pinned conservative envelope exactly once.
      await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
        now,
        reason: "provider_call_response_lost_hard_expiry",
        disposition: "unresolved",
        providerVerifiedClosedAt: providerHardExpiresAt,
      });
      await ctx.db.patch(lease._id, {
        status: "blocked_missing_report",
        authorityState: lease.authorityState ? "expired" : undefined,
        authorityExpiresAt: lease.authorityState ? now : undefined,
        sessionReapAt: undefined,
        endedAt: lease.endedAt ?? now,
        endReason: lease.endReason ?? "provider_call_response_lost_hard_expiry",
        updatedAt: now,
      });
      return true;
    }

    await releaseVoiceUsageReservationAuthorized(ctx, lease, now);
    await ctx.db.patch(lease._id, {
      status: "failed",
      authorityState: lease.authorityState ? "released" : undefined,
      authorityExpiresAt: lease.authorityState ? now : undefined,
      usageDisposition: "exact",
      usageDispositionAt: now,
      usageAuthorityClosedAt: now,
      usageAuthorityClosedReason: "session_reaped_undispatched",
      usageReservationState: "released",
      usageReservedMicroCents: 0,
      sessionReapAt: undefined,
      endedAt: lease.endedAt ?? now,
      endReason: lease.endReason ?? "session_reaped_undispatched",
      updatedAt: now,
    });
    return true;
  },
});

/**
 * Atomically acquire one exact provider-hangup attempt. The scheduled wake at
 * the lease boundary is the crash/restart recovery path when an action dies
 * after POSTing but before it can record the provider response.
 */
export const acquireOpenAiVoiceHangupCommandInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    providerCallId: v.string(),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: v.union(v.null(), v.object({ providerCallId: v.string() })),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.provider !== "openai" ||
      lease.providerCallId !== args.providerCallId ||
      lease.providerHangupState === "confirmed" ||
      !args.attemptId.trim()
    ) {
      return null;
    }
    if (
      lease.providerHangupActiveAttemptId &&
      typeof lease.providerHangupLeaseExpiresAt === "number" &&
      args.now < lease.providerHangupLeaseExpiresAt
    ) {
      return null;
    }
    const leaseExpiresAt = args.now + VOICE_REALTIME_HANGUP_ATTEMPT_LEASE_MS;
    await ctx.db.patch(lease._id, {
      providerHangupState:
        lease.providerHangupState === "ambiguous" ? "ambiguous" : "requested",
      providerHangupActiveAttemptId: args.attemptId,
      providerHangupLeaseExpiresAt: leaseExpiresAt,
      providerHangupLastAttemptAt: args.now,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.billing.hangupOpenAiVoiceCallInternal,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        stellaSessionId: args.stellaSessionId,
        providerCallId: args.providerCallId,
      },
    );
    return { providerCallId: lease.providerCallId };
  },
});

export const recordOpenAiVoiceHangupAttemptInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    providerCallId: v.string(),
    attemptId: v.string(),
    terminal: v.boolean(),
    providerStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      (lease.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      lease.provider !== "openai" ||
      lease.providerCallId !== args.providerCallId ||
      lease.providerHangupActiveAttemptId !== args.attemptId
    ) {
      return false;
    }
    if (lease.providerHangupState === "confirmed") return true;
    const attempts = Math.max(
      1,
      Math.floor(lease.providerHangupAttempts ?? 0) + 1,
    );
    const providerHardExpiresAt =
      lease.providerHardExpiresAt ??
      (lease.providerCallCreateStartedAt ??
        lease.providerCallBoundAt ??
        args.now) + OPENAI_REALTIME_PROVIDER_HARD_MAX_MS;
    if (args.terminal || args.now >= providerHardExpiresAt) {
      const verifiedClosedAt = args.terminal ? args.now : providerHardExpiresAt;
      await finalizeVoiceRealtimeUsageAuthority(ctx, lease, {
        now: args.now,
        reason: lease.providerHangupRequestedReason ?? "provider_hangup",
        disposition: "unresolved",
        providerVerifiedClosedAt: verifiedClosedAt,
      });
      await ctx.db.patch(lease._id, {
        providerHangupState: "confirmed",
        providerHangupAttempts: attempts,
        providerHangupLastAttemptAt: args.now,
        providerHangupConfirmedAt: verifiedClosedAt,
        providerHangupActiveAttemptId: undefined,
        providerHangupLeaseExpiresAt: undefined,
        providerHangupNextRetryAt: undefined,
        providerHangupLastError: undefined,
        sessionReapAt: undefined,
        updatedAt: args.now,
      });
      return true;
    }
    const retryDelay = Math.min(
      VOICE_REALTIME_HANGUP_MAX_RETRY_MS,
      VOICE_REALTIME_HANGUP_INITIAL_RETRY_MS *
        2 ** Math.min(8, Math.max(0, attempts - 1)),
    );
    const retryAt = args.now + retryDelay;
    await ctx.db.patch(lease._id, {
      usageDisposition: "revocation_pending",
      providerHangupState: "ambiguous",
      providerHangupAttempts: attempts,
      providerHangupLastAttemptAt: args.now,
      providerHangupActiveAttemptId: undefined,
      providerHangupLeaseExpiresAt: undefined,
      providerHangupNextRetryAt: retryAt,
      providerHangupLastError: (
        args.error ?? `provider_status_${args.providerStatus ?? "unknown"}`
      ).slice(0, 240),
      updatedAt: args.now,
    });
    await ctx.scheduler.runAt(
      retryAt,
      internal.billing.hangupOpenAiVoiceCallInternal,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        stellaSessionId: args.stellaSessionId,
        providerCallId: args.providerCallId,
      },
    );
    return true;
  },
});

/** Provider-verifiable, replay-safe OpenAI call revocation. */
export const hangupOpenAiVoiceCallInternal = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    providerCallId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attemptId = crypto.randomUUID();
    const command = await ctx.runMutation(
      internal.billing.acquireOpenAiVoiceHangupCommandInternal,
      {
        ...args,
        attemptId,
        now: Date.now(),
      },
    );
    if (!command) return null;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    let terminal = false;
    let providerStatus: number | undefined;
    let error: string | undefined;
    if (!apiKey) {
      error = "OPENAI_API_KEY is not configured";
    } else {
      try {
        const response = await fetch(
          `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(command.providerCallId)}/hangup`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        providerStatus = response.status;
        await response.body?.cancel().catch(() => undefined);
        terminal = response.ok || response.status === 404;
        if (!terminal) error = `OpenAI hangup returned ${response.status}`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    await ctx.runMutation(
      internal.billing.recordOpenAiVoiceHangupAttemptInternal,
      {
        ...args,
        attemptId,
        terminal,
        ...(providerStatus !== undefined ? { providerStatus } : {}),
        ...(error ? { error } : {}),
        now: Date.now(),
      },
    );
    return null;
  },
});

export const recordVoiceRealtimeUsage = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    providerDispatchId: v.string(),
    providerAttemptId: v.string(),
    authorityLeaseId: v.string(),
    authorityEpoch: v.number(),
    responseId: v.string(),
    model: v.string(),
    stellaSessionId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    inputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
    textInputTokens: v.number(),
    textCachedInputTokens: v.number(),
    textOutputTokens: v.number(),
    audioInputTokens: v.number(),
    audioCachedInputTokens: v.number(),
    audioOutputTokens: v.number(),
    imageInputTokens: v.number(),
    imageCachedInputTokens: v.number(),
    exactCostMicroCents: v.optional(v.number()),
    realtimeAudioSeconds: v.optional(v.number()),
    realtimeTextInputMessages: v.optional(v.number()),
    sttModel: v.optional(v.string()),
    sttAudioSeconds: v.optional(v.number()),
  },
  returns: v.union(
    v.object({
      recorded: v.literal(false),
      duplicate: v.literal(true),
      costMicroCents: v.number(),
    }),
    v.object({
      recorded: v.literal(true),
      duplicate: v.literal(false),
      costMicroCents: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!Number.isSafeInteger(args.authorityEpoch) || args.authorityEpoch < 1) {
      throw new ConvexError({
        code: "VOICE_USAGE_AUTHORITY_INVALID",
        message: "The realtime voice usage authority is invalid.",
      });
    }
    const requestFingerprint = await voiceUsageRequestFingerprint(args);
    const existing = await getExistingVoiceUsageReceipt(
      ctx,
      args.ownerId,
      args.responseId,
    );
    if (existing) {
      if (
        (existing.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
        existing.providerDispatchId !== args.providerDispatchId ||
        existing.providerAttemptId !== args.providerAttemptId ||
        (existing.stellaSessionId !== undefined &&
          existing.stellaSessionId !== args.stellaSessionId) ||
        (existing.authorityLeaseId !== undefined &&
          existing.authorityLeaseId !== args.authorityLeaseId) ||
        (existing.authorityEpoch !== undefined &&
          existing.authorityEpoch !== args.authorityEpoch) ||
        (existing.disposition !== undefined &&
          existing.disposition !== "exact") ||
        (existing.requestFingerprint !== undefined &&
          existing.requestFingerprint !== requestFingerprint)
      ) {
        throw new ConvexError({
          code: "VOICE_USAGE_IDEMPOTENCY_CONFLICT",
          message:
            "This voice response id is bound to a different usage receipt.",
        });
      }
      return {
        recorded: false as const,
        duplicate: true as const,
        costMicroCents: existing.costMicroCents,
      };
    }

    const lease = await getVoiceRealtimeLease(ctx, args.stellaSessionId);
    if (!lease) {
      throw new ConvexError({
        code: "VOICE_SESSION_UNAVAILABLE",
        message: "The realtime voice session is no longer available.",
      });
    }

    const reportedCostMicroCents = computeRealtimeUsageCostMicroCents({
      model: args.model,
      textInputTokens: args.textInputTokens,
      textCachedInputTokens: args.textCachedInputTokens,
      textOutputTokens: args.textOutputTokens,
      audioInputTokens: args.audioInputTokens,
      audioCachedInputTokens: args.audioCachedInputTokens,
      audioOutputTokens: args.audioOutputTokens,
      imageInputTokens: args.imageInputTokens,
      imageCachedInputTokens: args.imageCachedInputTokens,
      exactCostMicroCents: args.exactCostMicroCents,
      realtimeAudioSeconds: args.realtimeAudioSeconds,
      realtimeTextInputMessages: args.realtimeTextInputMessages,
      sttModel: args.sttModel,
      sttAudioSeconds: args.sttAudioSeconds,
    });
    const remainingSessionChargeCapMicroCents = Math.max(
      0,
      Math.floor(
        lease.usageFallbackChargeCapMicroCents ?? Number.MAX_SAFE_INTEGER,
      ) - Math.max(0, Math.floor(lease.estimatedCostMicroCents)),
    );
    // Renderer/provider-channel usage is useful exact telemetry, but it may be
    // fabricated by a modified client. Never let it charge beyond the exact
    // admission-time physical-session ceiling; conservative finalization later
    // fills any under-reporting residual to the server-known lease envelope.
    const costMicroCents = Math.min(
      reportedCostMicroCents,
      remainingSessionChargeCapMicroCents,
    );

    await persistExactVoiceRealtimeUsageAuthorized(ctx, lease, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      stellaSessionId: args.stellaSessionId,
      providerDispatchId: args.providerDispatchId,
      providerAttemptId: args.providerAttemptId,
      authorityLeaseId: args.authorityLeaseId,
      authorityEpoch: args.authorityEpoch,
      usage: {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        conversationId: args.conversationId ?? null,
        agentType: "service:voice:realtime",
        model: args.model,
        durationMs: 0,
        success: true,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        totalTokens: args.totalTokens,
        costMicroCents,
      },
    });
    const usageReservedMicroCents =
      await consumeVoiceUsageReservationAuthorized(
        ctx,
        lease,
        costMicroCents,
        now,
      );

    await ctx.db.insert("billing_voice_usage_receipts", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      providerDispatchId: args.providerDispatchId,
      providerAttemptId: args.providerAttemptId,
      stellaSessionId: args.stellaSessionId,
      authorityLeaseId: args.authorityLeaseId,
      authorityEpoch: args.authorityEpoch,
      requestFingerprint,
      disposition: "exact",
      responseId: args.responseId,
      model: args.model,
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.totalTokens,
      textInputTokens: args.textInputTokens,
      textCachedInputTokens: args.textCachedInputTokens,
      textOutputTokens: args.textOutputTokens,
      audioInputTokens: args.audioInputTokens,
      audioCachedInputTokens: args.audioCachedInputTokens,
      audioOutputTokens: args.audioOutputTokens,
      imageInputTokens: args.imageInputTokens,
      imageCachedInputTokens: args.imageCachedInputTokens,
      ...(args.exactCostMicroCents !== undefined
        ? { exactCostMicroCents: args.exactCostMicroCents }
        : {}),
      ...(args.realtimeAudioSeconds !== undefined
        ? { realtimeAudioSeconds: args.realtimeAudioSeconds }
        : {}),
      ...(args.realtimeTextInputMessages !== undefined
        ? { realtimeTextInputMessages: args.realtimeTextInputMessages }
        : {}),
      ...(args.sttModel ? { sttModel: args.sttModel } : {}),
      ...(args.sttAudioSeconds !== undefined
        ? { sttAudioSeconds: args.sttAudioSeconds }
        : {}),
      costMicroCents,
      createdAt: now,
    });

    await ctx.db.patch(lease._id, {
      lastUsageAt: now,
      responseCount: Math.max(0, Math.floor(lease.responseCount)) + 1,
      estimatedCostMicroCents:
        Math.max(0, Math.floor(lease.estimatedCostMicroCents)) + costMicroCents,
      inputTokens:
        Math.max(0, Math.floor(lease.inputTokens)) + args.inputTokens,
      outputTokens:
        Math.max(0, Math.floor(lease.outputTokens)) + args.outputTokens,
      totalTokens:
        Math.max(0, Math.floor(lease.totalTokens)) + args.totalTokens,
      realtimeAudioSeconds:
        Math.max(0, lease.realtimeAudioSeconds) +
        Math.max(0, args.realtimeAudioSeconds ?? 0),
      sttAudioSeconds:
        Math.max(0, lease.sttAudioSeconds) +
        Math.max(0, args.sttAudioSeconds ?? 0),
      usageReservedMicroCents,
      updatedAt: now,
    });

    return {
      recorded: true as const,
      duplicate: false as const,
      costMicroCents,
    };
  },
});

type MediaCompletedUsageArgs = {
  ownerId: string;
  ownerGeneration: string;
  jobId: string;
  providerRequestId?: string;
  endpointId: string;
  billingUnit: string;
  quantity: number;
  costMicroCents: number;
};

/**
 * Same-transaction media receipt finalizer. The caller must already hold an
 * exact owner-generation write authority in this transaction. Keeping this
 * helper lifecycle-independent lets a media success commit its billing
 * disposition before releasing provider authority, with no scheduled gap.
 */
export const recordMediaCompletedUsageAuthorized = async (
  ctx: MutationCtx,
  args: MediaCompletedUsageArgs,
) => {
  const existing = await getExistingMediaUsageReceipt(
    ctx,
    args.ownerId,
    args.jobId,
  );
  if (existing) {
    if ((existing.ownerGeneration ?? "legacy") !== args.ownerGeneration) {
      throw new ConvexError({
        code: "OWNER_DATA_GENERATION_STALE",
        message:
          "This media completion started before the account data was reset.",
      });
    }
    if (
      existing.providerRequestId !== args.providerRequestId ||
      existing.endpointId !== args.endpointId ||
      existing.billingUnit !== args.billingUnit ||
      existing.quantity !== args.quantity ||
      existing.costMicroCents !== args.costMicroCents
    ) {
      throw new ConvexError({
        code: "MEDIA_BILLING_RECEIPT_CONFLICT",
        message: "The media job billing disposition changed on replay.",
      });
    }
    return {
      recorded: false,
      duplicate: true,
      costMicroCents: existing.costMicroCents,
    };
  }

  await persistManagedUsageAuthorized(ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    agentType: "service:media",
    model: args.endpointId,
    durationMs: 0,
    success: true,
    costMicroCents: args.costMicroCents,
  });

  await ctx.db.insert("billing_media_usage_receipts", {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    jobId: args.jobId,
    ...(args.providerRequestId
      ? { providerRequestId: args.providerRequestId }
      : {}),
    endpointId: args.endpointId,
    billingUnit: args.billingUnit,
    quantity: args.quantity,
    costMicroCents: args.costMicroCents,
    createdAt: Date.now(),
  });

  return {
    recorded: true,
    duplicate: false,
    costMicroCents: args.costMicroCents,
  };
};

export const recordMediaCompletedUsage = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    jobId: v.string(),
    providerRequestId: v.optional(v.string()),
    endpointId: v.string(),
    billingUnit: v.string(),
    quantity: v.number(),
    costMicroCents: v.number(),
  },
  returns: v.object({
    recorded: v.boolean(),
    duplicate: v.boolean(),
    costMicroCents: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    return await recordMediaCompletedUsageAuthorized(ctx, args);
  },
});

const normalizeReturnUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Invalid return URL.",
    });
  }

  const host = parsed.hostname.toLowerCase();
  const isLocalHost =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocalHost && parsed.protocol !== "https:") {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Return URL must use HTTPS outside local development.",
    });
  }

  return parsed.toString();
};

const appendCheckoutStatus = (
  returnUrl: string,
  status: "success" | "cancel",
) => {
  const parsed = new URL(returnUrl);
  parsed.searchParams.set("checkout", status);
  return parsed.toString();
};

/**
 * Exact pre-provider gate for managed model calls. Keeping the lifecycle and
 * auth-migration source reads in one mutation transaction serializes dispatch
 * against both reset/delete and anonymous-owner transfer.
 */
export const assertManagedUsageDispatchAllowedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    return null;
  },
});

const requireManagedDispatchId = (value: string, field: string) => {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 256) {
    throw new Error(`Invalid managed dispatch ${field}.`);
  }
  return normalized;
};

const managedDispatchTimingValidator = v.object({
  providerDeadlineAt: v.number(),
  leaseExpiresAt: v.number(),
  quiescentAfterAt: v.number(),
});

const MANAGED_REQUEST_ROUTE_PATTERN = /^[a-z][a-z0-9:_-]{2,63}$/u;
const MANAGED_REQUEST_ID_PATTERN = /^[A-Za-z0-9:._-]{8,256}$/u;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Freeze one logical paid-provider request to its canonical provider body.
 * This durable binding outlives short-lived physical-attempt receipts, making
 * service retries idempotent while rejecting request-id rebinding before I/O.
 */
export const bindManagedProviderRequestInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    route: v.string(),
    requestId: v.string(),
    bodyFingerprint: v.string(),
    now: v.number(),
  },
  returns: v.object({
    requestFingerprint: v.string(),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = args.ownerId.trim();
    const { generation: ownerGeneration } =
      await assertOwnerMigrationWriteAllowed(
        ctx,
        ownerId,
        args.ownerGeneration,
      );
    const route = args.route.trim();
    const requestId = args.requestId.trim();
    const bodyFingerprint = args.bodyFingerprint.trim().toLowerCase();
    if (!MANAGED_REQUEST_ROUTE_PATTERN.test(route)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Managed provider request route is invalid.",
      });
    }
    if (!MANAGED_REQUEST_ID_PATTERN.test(requestId)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Managed provider request id is invalid.",
      });
    }
    if (!SHA256_HEX_PATTERN.test(bodyFingerprint)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Managed provider request body fingerprint is invalid.",
      });
    }

    const requestFingerprint = await createManagedDispatchRequestFingerprint(
      route,
      `${ownerId}\u0000${ownerGeneration}\u0000${requestId}`,
    );
    const existing = await ctx.db
      .query("billing_managed_request_bindings")
      .withIndex(
        "by_ownerId_and_ownerGeneration_and_route_and_requestId",
        (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("ownerGeneration", ownerGeneration)
            .eq("route", route)
            .eq("requestId", requestId),
      )
      .unique();
    if (existing) {
      if (
        existing.bodyFingerprint !== bodyFingerprint ||
        existing.requestFingerprint !== requestFingerprint
      ) {
        throw new ConvexError({
          code: "IDEMPOTENCY_CONFLICT",
          message:
            "Managed provider request id was reused with different input.",
        });
      }
      return { requestFingerprint, replayed: true };
    }

    await ctx.db.insert("billing_managed_request_bindings", {
      ownerId,
      ownerGeneration,
      route,
      requestId,
      bodyFingerprint,
      requestFingerprint,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return { requestFingerprint, replayed: false };
  },
});

type ManagedDispatchRow = Doc<"billing_managed_dispatch_leases">;

const normalizeManagedDispatchBillingEnvelope = (
  billing: ManagedDispatchBillingEnvelope,
): ManagedDispatchBillingEnvelope => {
  const requestFingerprint = billing.requestFingerprint.trim();
  if (requestFingerprint.length < 16 || requestFingerprint.length > 256) {
    throw new Error("Invalid managed dispatch billing fingerprint.");
  }
  if (billing.kind === PARALLEL_SEARCH_FAST_BILLING_KIND) {
    if (billing.chargeMicroCents !== PARALLEL_SEARCH_FAST_COST_MICRO_CENTS) {
      throw new Error("Unsupported managed dispatch billing envelope.");
    }
    return { ...billing, requestFingerprint };
  }

  if (billing.kind !== MANAGED_USAGE_BILLING_KIND) {
    throw new Error("Unsupported managed dispatch billing envelope.");
  }
  const agentType = billing.agentType.trim();
  const model = billing.model.trim();
  if (!agentType || agentType.length > 256 || !model || model.length > 512) {
    throw new Error("Invalid managed usage billing attribution.");
  }
  const fallbackCostMicroCents = Math.floor(billing.fallbackCostMicroCents);
  if (
    !Number.isFinite(billing.fallbackCostMicroCents) ||
    !Number.isSafeInteger(fallbackCostMicroCents) ||
    fallbackCostMicroCents <= 0
  ) {
    throw new Error("Managed usage fallback estimate must be positive.");
  }
  return {
    ...billing,
    requestFingerprint,
    agentType,
    model,
    fallbackCostMicroCents,
  };
};

const managedDispatchBillingEnvelopeMatches = (
  row: ManagedDispatchRow,
  billing: ManagedDispatchBillingEnvelope | undefined,
): boolean => {
  if (!row.billing || !billing) return row.billing === undefined && !billing;
  if (
    row.billing.kind !== billing.kind ||
    row.billing.requestFingerprint !== billing.requestFingerprint
  ) {
    return false;
  }
  if (row.billing.kind === PARALLEL_SEARCH_FAST_BILLING_KIND) {
    return (
      billing.kind === PARALLEL_SEARCH_FAST_BILLING_KIND &&
      row.billing.chargeMicroCents === billing.chargeMicroCents
    );
  }
  return (
    billing.kind === MANAGED_USAGE_BILLING_KIND &&
    row.billing.agentType === billing.agentType &&
    row.billing.model === billing.model &&
    row.billing.conversationId === billing.conversationId &&
    row.billing.fallbackCostMicroCents === billing.fallbackCostMicroCents
  );
};

const normalizeManagedDispatchCapturedUsage = (
  usage: ManagedDispatchCapturedUsage,
): ManagedDispatchCapturedUsage => {
  const nonNegativeInt = (value: number, field: string): number => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Managed usage ${field} must be finite and non-negative.`,
      );
    }
    const normalized = Math.floor(value);
    if (!Number.isSafeInteger(normalized)) {
      throw new Error(`Managed usage ${field} is outside the safe range.`);
    }
    return normalized;
  };
  const optionalCount = (value: number | undefined, field: string) =>
    value === undefined ? undefined : nonNegativeInt(value, field);
  const costMicroCents =
    usage.costMicroCents === undefined
      ? undefined
      : nonNegativeInt(usage.costMicroCents, "cost");
  const inputTokens = optionalCount(usage.inputTokens, "input token count");
  const outputTokens = optionalCount(usage.outputTokens, "output token count");
  const totalTokens = optionalCount(usage.totalTokens, "total token count");
  const cachedInputTokens = optionalCount(
    usage.cachedInputTokens,
    "cached input token count",
  );
  const cacheWriteInputTokens = optionalCount(
    usage.cacheWriteInputTokens,
    "cache-write input token count",
  );
  const reasoningTokens = optionalCount(
    usage.reasoningTokens,
    "reasoning token count",
  );
  return {
    durationMs: nonNegativeInt(usage.durationMs, "duration"),
    success: usage.success,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(costMicroCents !== undefined ? { costMicroCents } : {}),
  };
};

const managedDispatchCapturedUsageMatches = (
  left: ManagedDispatchCapturedUsage,
  right: ManagedDispatchCapturedUsage,
): boolean =>
  left.durationMs === right.durationMs &&
  left.success === right.success &&
  left.inputTokens === right.inputTokens &&
  left.outputTokens === right.outputTokens &&
  left.totalTokens === right.totalTokens &&
  left.cachedInputTokens === right.cachedInputTokens &&
  left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
  left.reasoningTokens === right.reasoningTokens &&
  left.costMicroCents === right.costMicroCents;

export const managedDispatchHasPendingBilling = (
  row: ManagedDispatchRow,
): boolean => row.billing?.billingState === "pending";

const releaseManagedDispatchUsageReservation = async (
  ctx: MutationCtx,
  row: ManagedDispatchRow,
  now: number,
): Promise<void> => {
  if (row.usageReservationState !== "active") return;
  const reservedMicroCents = Math.max(
    0,
    Math.floor(row.usageReservedMicroCents ?? 0),
  );
  if (reservedMicroCents <= 0) {
    throw new Error("Managed dispatch has an empty active reservation.");
  }
  await adjustManagedUsageReservationAuthorized(ctx, {
    ownerId: row.ownerId,
    deltaMicroCents: -reservedMicroCents,
    now,
  });
  await ctx.db.patch(row._id, {
    usageReservationState: "released",
    usageReservedMicroCents: 0,
    updatedAt: now,
  });
};

/**
 * Materialize one fixed-cost provider-attempt charge from its exact durable
 * receipt. This is intentionally the sole post-lifecycle-fence billing path:
 * callers already hold the receipt row in their mutation transaction, so no
 * new provider work can be admitted and reset/delete/migration can safely wait
 * for or finalize the old generation before removing the receipt.
 */
export const finalizeManagedDispatchBillingFromReceipt = async (
  ctx: MutationCtx,
  row: ManagedDispatchRow,
  outcome: DurableManagedDispatchOutcome,
  now: number,
): Promise<"not_metered" | "not_chargeable" | "billed"> => {
  const billing = row.billing;
  if (!billing) return "not_metered";
  if (billing.billingState === "billed") {
    await releaseManagedDispatchUsageReservation(ctx, row, now);
    return "billed";
  }
  if (billing.billingState === "not_chargeable") {
    await releaseManagedDispatchUsageReservation(ctx, row, now);
    return "not_chargeable";
  }

  if (billing.providerState === "reserved") {
    await releaseManagedDispatchUsageReservation(ctx, row, now);
    await ctx.db.patch(row._id, {
      billing: {
        ...billing,
        billingState: "not_chargeable",
        finalizedAt: now,
      },
    });
    return "not_chargeable";
  }

  let billedReceipt: typeof billing;
  if (billing.kind === PARALLEL_SEARCH_FAST_BILLING_KIND) {
    if (billing.chargeMicroCents !== PARALLEL_SEARCH_FAST_COST_MICRO_CENTS) {
      throw new Error(
        "Managed dispatch receipt has invalid billing authority.",
      );
    }
    await persistManagedUsageAuthorized(ctx, {
      ownerId: row.ownerId,
      ownerGeneration: row.ownerGeneration,
      agentType: `proxy:${PARALLEL_SEARCH_FAST_AGENT_TYPE}`,
      model: PARALLEL_SEARCH_FAST_MODEL,
      durationMs: Math.max(0, now - row.createdAt),
      success: outcome === "succeeded",
      costMicroCents: billing.chargeMicroCents,
    });
    billedReceipt = billing;
  } else {
    const capturedUsage =
      billing.capturedUsage ??
      normalizeManagedDispatchCapturedUsage({
        durationMs: Math.max(0, now - row.createdAt),
        success: false,
        costMicroCents: billing.fallbackCostMicroCents,
      });
    await persistManagedUsageAuthorized(ctx, {
      ownerId: row.ownerId,
      ownerGeneration: row.ownerGeneration,
      agentType: billing.agentType,
      model: billing.model,
      conversationId: billing.conversationId,
      ...capturedUsage,
    });
    billedReceipt = { ...billing, capturedUsage };
  }
  await releaseManagedDispatchUsageReservation(ctx, row, now);
  await ctx.db.patch(row._id, {
    billing: {
      ...billedReceipt,
      billingState: "billed",
      finalizedAt: now,
      billedAt: now,
    },
  });
  return "billed";
};

/** Reserve one exact physical managed-provider request. */
export const acquireManagedProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    executionId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    billing: v.optional(managedDispatchBillingEnvelopeValidator),
    now: v.number(),
  },
  returns: managedDispatchTimingValidator,
  handler: async (ctx, args) => {
    const executionId = requireManagedDispatchId(
      args.executionId,
      "execution id",
    );
    const attemptId = requireManagedDispatchId(args.attemptId, "attempt id");
    const leaseId = requireManagedDispatchId(args.leaseId, "lease id");
    const billing = args.billing
      ? normalizeManagedDispatchBillingEnvelope(args.billing)
      : undefined;
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );

    const existing = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", attemptId))
      .unique();
    if (existing) {
      if (
        existing.ownerId !== args.ownerId ||
        existing.ownerGeneration !== args.ownerGeneration ||
        existing.executionId !== executionId ||
        existing.leaseId !== leaseId ||
        !managedDispatchBillingEnvelopeMatches(existing, billing)
      ) {
        throw new Error("Managed provider attempt id was reused.");
      }
      if (existing.state !== "active") {
        throw new Error("Managed provider attempt is already terminal.");
      }
      return {
        providerDeadlineAt: existing.providerDeadlineAt,
        leaseExpiresAt: existing.leaseExpiresAt,
        quiescentAfterAt: existing.quiescentAfterAt,
      };
    }

    const activeForExecution = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_ownerId_and_executionId_and_state_and_createdAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("executionId", executionId)
          .eq("state", "active"),
      )
      .first();
    if (activeForExecution) {
      throw new Error("Managed provider execution already has an active try.");
    }

    const providerDeadlineAt = args.now + MANAGED_PROVIDER_DISPATCH_DEADLINE_MS;
    const leaseExpiresAt = args.now + MANAGED_PROVIDER_DISPATCH_LEASE_MS;
    const quiescentAfterAt =
      leaseExpiresAt + MANAGED_PROVIDER_DISPATCH_QUIESCENCE_MS;
    await ctx.db.insert("billing_managed_dispatch_leases", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      executionId,
      attemptId,
      leaseId,
      state: "active",
      providerDeadlineAt,
      leaseExpiresAt,
      quiescentAfterAt,
      cleanupAt: quiescentAfterAt,
      ...(billing
        ? {
            billing: {
              ...billing,
              providerState: "reserved" as const,
              billingState: "pending" as const,
            },
          }
        : {}),
      createdAt: args.now,
      updatedAt: args.now,
    });
    if (billing) {
      await ctx.scheduler.runAt(
        quiescentAfterAt,
        internal.billing.finalizeManagedProviderDispatchBillingInternal,
        { attemptId, leaseId },
      );
    }
    return { providerDeadlineAt, leaseExpiresAt, quiescentAfterAt };
  },
});

/**
 * Last transaction before a metered physical provider request. Lifecycle and
 * migration fences plus fixed-cost admission commit with the durable
 * `may_have_dispatched` marker; after this point a crash is conservatively
 * billable because Stella can no longer prove the request stayed local.
 */
export const markManagedProviderDispatchMayHaveStartedInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      ownerGeneration: v.string(),
      executionId: v.string(),
      attemptId: v.string(),
      leaseId: v.string(),
      billing: managedDispatchBillingEnvelopeValidator,
      turnAuthority: v.optional(v.object({ turnId: v.string() })),
      now: v.number(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
      const billing = normalizeManagedDispatchBillingEnvelope(args.billing);
      const row = await ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
        .unique();
      if (!row) return false;
      if (
        row.ownerId !== args.ownerId ||
        row.ownerGeneration !== args.ownerGeneration ||
        row.executionId !== args.executionId ||
        row.leaseId !== args.leaseId ||
        !managedDispatchBillingEnvelopeMatches(row, billing)
      ) {
        throw new Error(
          "Managed provider dispatch marker lost exact authority.",
        );
      }
      if (row.state !== "active" || row.billing?.billingState !== "pending") {
        throw new Error("Managed provider dispatch marker is already closed.");
      }
      if (row.billing.providerState === "may_have_dispatched") return true;

      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
      if (args.turnAuthority) {
        // The turn capability authenticated the caller; the projected turn
        // row, once it exists, is the only thing that can say the turn ended.
        const turn = await ctx.db
          .query("agent_turns")
          .withIndex("by_turnId", (q) =>
            q.eq("turnId", args.turnAuthority!.turnId),
          )
          .unique();
        if (
          turn &&
          (turn.ownerId !== args.ownerId ||
            turn.status !== "running" ||
            turn.terminalKind)
        ) {
          throw new ConvexError({
            code: "TURN_NOT_ACTIVE",
            message: "Cloud turn is no longer active.",
          });
        }
      }
      const admission = await runEnforceManagedUsageLimit(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        minimumRemainingMicroCents:
          billing.kind === PARALLEL_SEARCH_FAST_BILLING_KIND
            ? billing.chargeMicroCents
            : billing.fallbackCostMicroCents,
      });
      if (!admission.allowed) {
        throw new ConvexError({
          code: "USAGE_LIMIT_REACHED",
          message: admission.message,
          retryAfterMs: admission.retryAfterMs,
        });
      }
      const reservedMicroCents =
        billing.kind === PARALLEL_SEARCH_FAST_BILLING_KIND
          ? billing.chargeMicroCents
          : billing.fallbackCostMicroCents;
      await adjustManagedUsageReservationAuthorized(ctx, {
        ownerId: row.ownerId,
        deltaMicroCents: reservedMicroCents,
        now: args.now,
      });
      await ctx.db.patch(row._id, {
        usageReservationState: "active",
        usageReservedMicroCents: reservedMicroCents,
        billing: {
          ...row.billing,
          providerState: "may_have_dispatched",
        },
        updatedAt: args.now,
      });
      return true;
    },
  });

/**
 * Attach and bill exact variable usage while the provider-attempt receipt is
 * authoritative. Unlike ordinary usage writes, this remains valid after a
 * lifecycle/migration fence only for the exact already-admitted lease tuple;
 * it cannot admit or recreate provider work.
 */
export const captureManagedProviderDispatchUsageInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    executionId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    billing: managedDispatchBillingEnvelopeValidator,
    usage: managedDispatchCapturedUsageValidator,
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const billingEnvelope = normalizeManagedDispatchBillingEnvelope(
      args.billing,
    );
    if (billingEnvelope.kind !== MANAGED_USAGE_BILLING_KIND) {
      throw new Error("Fixed-cost dispatches do not accept captured usage.");
    }
    const usage = normalizeManagedDispatchCapturedUsage(args.usage);
    const row = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
      .unique();
    if (!row) return false;
    if (
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      row.executionId !== args.executionId ||
      row.leaseId !== args.leaseId ||
      !managedDispatchBillingEnvelopeMatches(row, billingEnvelope)
    ) {
      throw new Error("Managed usage capture lost exact attempt authority.");
    }
    if (
      !row.billing ||
      row.billing.kind !== MANAGED_USAGE_BILLING_KIND ||
      row.billing.providerState !== "may_have_dispatched" ||
      row.billing.billingState === "not_chargeable"
    ) {
      throw new Error(
        "Managed usage capture has no billable provider attempt.",
      );
    }
    if (row.billing.capturedUsage) {
      if (
        !managedDispatchCapturedUsageMatches(row.billing.capturedUsage, usage)
      ) {
        throw new Error("Managed usage changed on exact-attempt replay.");
      }
      if (row.billing.billingState !== "billed") {
        throw new Error("Captured managed usage was not durably billed.");
      }
      return true;
    }
    if (row.state !== "active" || row.billing.billingState !== "pending") {
      throw new Error("Managed usage capture arrived after attempt closure.");
    }

    await persistManagedUsageAuthorized(ctx, {
      ownerId: row.ownerId,
      ownerGeneration: row.ownerGeneration,
      agentType: row.billing.agentType,
      model: row.billing.model,
      conversationId: row.billing.conversationId,
      ...usage,
    });
    await releaseManagedDispatchUsageReservation(ctx, row, args.now);
    await ctx.db.patch(row._id, {
      billing: {
        ...row.billing,
        capturedUsage: usage,
        billingState: "billed",
        finalizedAt: args.now,
        billedAt: args.now,
      },
      updatedAt: args.now,
    });
    return true;
  },
});

/** Exact-attempt terminal CAS; intentionally allowed after a purge fence. */
export const settleManagedProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    executionId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    outcome: managedProviderDispatchOutcomeValidator,
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
      .unique();
    if (!row) return false;
    if (
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      row.executionId !== args.executionId ||
      row.leaseId !== args.leaseId
    ) {
      throw new Error("Managed provider dispatch settlement lost its lease.");
    }
    if (row.state === "terminal") {
      if (row.outcome !== args.outcome) {
        throw new Error("Managed provider dispatch outcome changed on replay.");
      }
      await finalizeManagedDispatchBillingFromReceipt(
        ctx,
        row,
        args.outcome,
        args.now,
      );
      return true;
    }
    const cleanupAt = Math.max(
      args.now + MANAGED_PROVIDER_DISPATCH_TERMINAL_RETENTION_MS,
      managedDispatchOutcomeRequiresQuiescence(args.outcome)
        ? row.quiescentAfterAt
        : args.now,
    );
    await finalizeManagedDispatchBillingFromReceipt(
      ctx,
      row,
      args.outcome,
      args.now,
    );
    await ctx.db.patch(row._id, {
      state: "terminal",
      outcome: args.outcome,
      terminalAt: args.now,
      cleanupAt,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(
      Math.max(0, cleanupAt - args.now),
      internal.billing.cleanupManagedProviderDispatchInternal,
      { attemptId: args.attemptId, leaseId: args.leaseId, cleanupAt },
    );
    return true;
  },
});

/** Crash-safe wake for a metered attempt whose action never settled. */
export const finalizeManagedProviderDispatchBillingInternal = internalMutation({
  args: {
    attemptId: v.string(),
    leaseId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
      .unique();
    if (!row || row.leaseId !== args.leaseId || !row.billing) return null;
    const now = Date.now();
    if (row.state === "active" && row.quiescentAfterAt > now) return null;
    const outcome =
      row.state === "terminal" && row.outcome
        ? row.outcome
        : row.billing.providerState === "may_have_dispatched"
          ? "outcome_unknown"
          : "aborted";
    if (row.billing.billingState === "pending") {
      await finalizeManagedDispatchBillingFromReceipt(ctx, row, outcome, now);
    }
    if (row.state === "active") {
      const cleanupAt = now + MANAGED_PROVIDER_DISPATCH_TERMINAL_RETENTION_MS;
      await ctx.db.patch(row._id, {
        state: "terminal",
        outcome,
        terminalAt: now,
        cleanupAt,
        updatedAt: now,
      });
      await ctx.scheduler.runAt(
        cleanupAt,
        internal.billing.cleanupManagedProviderDispatchInternal,
        { attemptId: row.attemptId, leaseId: row.leaseId, cleanupAt },
      );
      return null;
    }
    await ctx.scheduler.runAfter(
      Math.max(0, row.cleanupAt - now),
      internal.billing.cleanupManagedProviderDispatchInternal,
      {
        attemptId: row.attemptId,
        leaseId: row.leaseId,
        cleanupAt: row.cleanupAt,
      },
    );
    return null;
  },
});

export const cleanupManagedProviderDispatchInternal = internalMutation({
  args: {
    attemptId: v.string(),
    leaseId: v.string(),
    cleanupAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
      .unique();
    if (
      row?.state === "terminal" &&
      row.leaseId === args.leaseId &&
      row.cleanupAt === args.cleanupAt &&
      row.cleanupAt <= Date.now()
    ) {
      if (managedDispatchHasPendingBilling(row)) {
        await ctx.scheduler.runAfter(
          0,
          internal.billing.finalizeManagedProviderDispatchBillingInternal,
          { attemptId: row.attemptId, leaseId: row.leaseId },
        );
        return null;
      }
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

const managedExecutionTimingValidator = v.object({
  leaseExpiresAt: v.number(),
  hardExpiresAt: v.number(),
  quiescentAfterAt: v.number(),
});

/** Reserve the enclosing model/tool execution before its first provider try. */
export const acquireManagedExecutionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    executionId: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: managedExecutionTimingValidator,
  handler: async (ctx, args) => {
    const executionId = requireManagedDispatchId(
      args.executionId,
      "execution id",
    );
    const leaseId = requireManagedDispatchId(args.leaseId, "execution lease");
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const existing = await ctx.db
      .query("billing_managed_execution_leases")
      .withIndex("by_executionId", (q) => q.eq("executionId", executionId))
      .unique();
    if (existing) {
      if (
        existing.ownerId !== args.ownerId ||
        existing.ownerGeneration !== args.ownerGeneration ||
        existing.leaseId !== leaseId ||
        existing.state !== "active"
      ) {
        throw new Error("Managed execution authority was reused or closed.");
      }
      return {
        leaseExpiresAt: existing.leaseExpiresAt,
        hardExpiresAt: existing.hardExpiresAt,
        quiescentAfterAt: existing.quiescentAfterAt,
      };
    }
    const hardExpiresAt = args.now + MANAGED_EXECUTION_HARD_MS;
    const leaseExpiresAt = Math.min(
      hardExpiresAt,
      args.now + MANAGED_EXECUTION_LEASE_MS,
    );
    const quiescentAfterAt = leaseExpiresAt + MANAGED_EXECUTION_QUIESCENCE_MS;
    await ctx.db.insert("billing_managed_execution_leases", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      executionId,
      leaseId,
      state: "active",
      leaseExpiresAt,
      hardExpiresAt,
      quiescentAfterAt,
      cleanupAt: quiescentAfterAt,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return { leaseExpiresAt, hardExpiresAt, quiescentAfterAt };
  },
});

/** Heartbeat also re-enters lifecycle and both auth-migration fences. */
export const heartbeatManagedExecutionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    executionId: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: v.union(v.null(), managedExecutionTimingValidator),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await ctx.db
      .query("billing_managed_execution_leases")
      .withIndex("by_executionId", (q) => q.eq("executionId", args.executionId))
      .unique();
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      row.leaseId !== args.leaseId ||
      row.state !== "active" ||
      row.hardExpiresAt <= args.now
    ) {
      return null;
    }
    const leaseExpiresAt = Math.min(
      row.hardExpiresAt,
      args.now + MANAGED_EXECUTION_LEASE_MS,
    );
    const quiescentAfterAt = leaseExpiresAt + MANAGED_EXECUTION_QUIESCENCE_MS;
    await ctx.db.patch(row._id, {
      leaseExpiresAt,
      quiescentAfterAt,
      cleanupAt: quiescentAfterAt,
      updatedAt: args.now,
    });
    return {
      leaseExpiresAt,
      hardExpiresAt: row.hardExpiresAt,
      quiescentAfterAt,
    };
  },
});

/** Exact execution settlement; permitted after a lifecycle fence is published. */
export const settleManagedExecutionInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    executionId: v.string(),
    leaseId: v.string(),
    outcome: managedProviderDispatchOutcomeValidator,
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("billing_managed_execution_leases")
      .withIndex("by_executionId", (q) => q.eq("executionId", args.executionId))
      .unique();
    if (!row) return false;
    if (
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      row.leaseId !== args.leaseId
    ) {
      throw new Error("Managed execution settlement lost exact authority.");
    }
    if (row.state === "terminal") {
      if (row.outcome !== args.outcome) {
        throw new Error("Managed execution outcome changed on replay.");
      }
      return true;
    }
    await ctx.db.patch(row._id, {
      state: "terminal",
      outcome: args.outcome,
      terminalAt: args.now,
      cleanupAt: args.now + MANAGED_PROVIDER_DISPATCH_TERMINAL_RETENTION_MS,
      updatedAt: args.now,
    });
    return true;
  },
});

/** Bounded crash recovery for attempts whose action never settled. */
export const sweepManagedProviderDispatchesInternal = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({ visited: v.number(), remaining: v.boolean() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const rows = await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_cleanupAt", (q) => q.lte("cleanupAt", now))
      .take(MANAGED_PROVIDER_DISPATCH_SWEEP_BATCH);
    for (const row of rows) {
      if (managedDispatchHasPendingBilling(row)) {
        if (row.state === "active" && row.quiescentAfterAt > now) continue;
        const outcome =
          row.state === "terminal" && row.outcome
            ? row.outcome
            : row.billing?.providerState === "may_have_dispatched"
              ? "outcome_unknown"
              : "aborted";
        await finalizeManagedDispatchBillingFromReceipt(ctx, row, outcome, now);
        if (row.state === "terminal") {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, {
            state: "terminal",
            outcome,
            terminalAt: now,
            cleanupAt: now + MANAGED_PROVIDER_DISPATCH_TERMINAL_RETENTION_MS,
            updatedAt: now,
          });
        }
      } else if (row.state === "terminal") {
        await ctx.db.delete(row._id);
      } else if (row.quiescentAfterAt <= now) {
        await ctx.db.patch(row._id, {
          state: "terminal",
          outcome: "outcome_unknown",
          terminalAt: now,
          cleanupAt: now + MANAGED_PROVIDER_DISPATCH_TERMINAL_RETENTION_MS,
          updatedAt: now,
        });
      }
    }
    const executions = await ctx.db
      .query("billing_managed_execution_leases")
      .withIndex("by_cleanupAt", (q) => q.lte("cleanupAt", now))
      .take(MANAGED_PROVIDER_DISPATCH_SWEEP_BATCH);
    for (const row of executions) {
      if (row.state === "terminal") {
        await ctx.db.delete(row._id);
      } else if (row.quiescentAfterAt <= now) {
        await ctx.db.patch(row._id, {
          state: "terminal",
          outcome: "aborted",
          terminalAt: now,
          cleanupAt: now + MANAGED_PROVIDER_DISPATCH_TERMINAL_RETENTION_MS,
          updatedAt: now,
        });
      }
    }
    return {
      visited: rows.length + executions.length,
      remaining:
        rows.length === MANAGED_PROVIDER_DISPATCH_SWEEP_BATCH ||
        executions.length === MANAGED_PROVIDER_DISPATCH_SWEEP_BATCH,
    };
  },
});

export const ensureBillingRecords = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.object({
    ownerId: v.string(),
    activePlan: planValidator,
    subscriptionStatus: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.string(),
    currentPeriodEnd: v.number(),
    usageUpdatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const { profile, usage } = await ensureBillingRecordsForOwner(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    return {
      ownerId: profile.ownerId,
      activePlan: profile.activePlan,
      subscriptionStatus: profile.subscriptionStatus,
      stripeCustomerId: profile.stripeCustomerId,
      stripeSubscriptionId: profile.stripeSubscriptionId,
      stripePriceId: profile.stripePriceId,
      currentPeriodEnd: profile.currentPeriodEnd,
      usageUpdatedAt: usage.updatedAt,
    };
  },
});

export const getBillingProfileByOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) =>
    await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique(),
});

export const updatePaymentMethodForCustomer = internalMutation({
  args: {
    stripeCustomerId: v.string(),
    ownerGeneration: v.string(),
    stripeEventCreatedAt: v.number(),
    stripeEventId: v.optional(v.string()),
    defaultPaymentMethodId: v.optional(v.string()),
    paymentMethodBrand: v.optional(v.string()),
    paymentMethodLast4: v.optional(v.string()),
  },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args) => {
    const customerId = args.stripeCustomerId.trim();
    if (!customerId) {
      return { updated: false };
    }

    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_stripeCustomerId", (q) =>
        q.eq("stripeCustomerId", customerId),
      )
      .unique();
    if (!profile) {
      return { updated: false };
    }

    await assertOwnerMigrationWriteAllowed(
      ctx,
      profile.ownerId,
      args.ownerGeneration,
    );
    if (profile.stripeCustomerTerminal === true) {
      return { updated: false };
    }
    if (
      !shouldApplyStripeResourceEvent({
        storedAt:
          profile.stripePaymentMethodUpdatedAt ?? profile.stripeUpdatedAt ?? 0,
        storedEventId: profile.stripePaymentMethodEventId,
        incomingAt: args.stripeEventCreatedAt,
        incomingEventId: args.stripeEventId,
      })
    ) {
      return { updated: false };
    }

    await ctx.db.patch(profile._id, {
      defaultPaymentMethodId: toSafeString(args.defaultPaymentMethodId),
      paymentMethodBrand: toSafeString(args.paymentMethodBrand),
      paymentMethodLast4: toSafeString(args.paymentMethodLast4),
      stripePaymentMethodUpdatedAt: args.stripeEventCreatedAt,
      stripePaymentMethodEventId: args.stripeEventId?.trim() || undefined,
      updatedAt: Date.now(),
    });
    return { updated: true };
  },
});

/**
 * Projects Stripe's terminal customer deletion transactionally. The hashed
 * customer tombstone is written before the raw customer locator is unlinked,
 * so a delayed subscription/customer webhook cannot recreate the profile.
 */
export const syncCustomerDeletionFromStripe = internalMutation({
  args: {
    stripeCustomerId: v.string(),
    ownerGeneration: v.string(),
    stripeEventCreatedAt: v.number(),
    stripeEventId: v.optional(v.string()),
  },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args) => {
    const customerId = args.stripeCustomerId.trim();
    if (!customerId) return { updated: false };

    // A signed customer.deleted event is global negative authority for this
    // immutable Stripe locator even when customer_create has returned but its
    // exact result has not yet converged into a billing profile. Persist the
    // tombstone before the owner lookup so a delayed settle cannot resurrect
    // the deleted customer. If a profile does exist, the lifecycle assertion
    // below remains in this transaction and rolls the insert back on a stale
    // owner-generation fence.
    const locatorHash = await hashStripeBillingLocator("customer", customerId);
    const tombstone = await ctx.db
      .query("billing_stripe_deletion_tombstones")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
      .unique();
    if (!tombstone) {
      await ctx.db.insert("billing_stripe_deletion_tombstones", {
        locatorHash,
        locatorKind: "customer",
        createdAt: Date.now(),
      });
    }

    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_stripeCustomerId", (q) =>
        q.eq("stripeCustomerId", customerId),
      )
      .unique();
    if (!profile) return { updated: false };

    await assertOwnerMigrationWriteAllowed(
      ctx,
      profile.ownerId,
      args.ownerGeneration,
    );
    if (
      !shouldApplyStripeResourceEvent({
        storedAt:
          profile.stripeCustomerUpdatedAt ?? profile.stripeUpdatedAt ?? 0,
        storedEventId: profile.stripeCustomerEventId,
        storedTerminal: profile.stripeCustomerTerminal,
        incomingAt: args.stripeEventCreatedAt,
        incomingEventId: args.stripeEventId,
        incomingTerminal: true,
      })
    ) {
      return { updated: false };
    }

    const now = Date.now();
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
      stripeCustomerUpdatedAt: args.stripeEventCreatedAt,
      stripeCustomerEventId: args.stripeEventId?.trim() || undefined,
      stripeCustomerTerminal: true,
      stripeCustomerAuthorityEpoch: nextCustomerAuthorityEpoch,
      stripeCustomerCreateIdempotencyKey: undefined,
      // A terminal customer event is an explicit revocation boundary, not an
      // adoption opportunity. Closing the scan at the new epoch prevents a
      // later reset from rewriting pre-deletion operations (and their old
      // customer-create idempotency keys) into the fresh authority epoch.
      stripeCustomerAdoptionScanEpoch: nextCustomerAuthorityEpoch,
      stripeSubscriptionTerminal: true,
      updatedAt: now,
    });
    return { updated: true };
  },
});

const resolveStripeEventOwner = async (
  ctx: MutationCtx,
  args: {
    ownerId?: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    stripePaymentMethodId?: string;
    stripeCheckoutSessionId?: string;
  },
): Promise<{
  ownerId: string;
  ownerGeneration: string;
  disposition: "allow" | "retry" | "discard";
}> => {
  let ownerId = toSafeString(args.ownerId);
  const customerId = toSafeString(args.stripeCustomerId);
  const subscriptionId = toSafeString(args.stripeSubscriptionId);
  const paymentMethodId = toSafeString(args.stripePaymentMethodId);
  const checkoutSessionId = toSafeString(args.stripeCheckoutSessionId);

  const hasActiveExactMigration = async (
    fromOwnerId: string,
    toOwnerId?: string,
  ): Promise<boolean> => {
    const rows = toOwnerId
      ? await ctx.db
          .query("auth_owner_migrations")
          .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
            q.eq("fromOwnerId", fromOwnerId).eq("toOwnerId", toOwnerId),
          )
          .take(2)
      : await ctx.db
          .query("auth_owner_migrations")
          .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
            q.eq("fromOwnerId", fromOwnerId),
          )
          .take(2);
    return rows.some((row) => row.status !== "complete");
  };

  const [customerProfiles, subscriptionProfiles, paymentMethodProfiles] =
    await Promise.all([
      customerId
        ? ctx.db
            .query("billing_profiles")
            .withIndex("by_stripeCustomerId", (q) =>
              q.eq("stripeCustomerId", customerId),
            )
            .take(2)
        : [],
      subscriptionId
        ? ctx.db
            .query("billing_profiles")
            .withIndex("by_stripeSubscriptionId", (q) =>
              q.eq("stripeSubscriptionId", subscriptionId),
            )
            .take(2)
        : [],
      paymentMethodId
        ? ctx.db
            .query("billing_profiles")
            .withIndex("by_defaultPaymentMethodId", (q) =>
              q.eq("defaultPaymentMethodId", paymentMethodId),
            )
            .take(2)
        : [],
    ]);
  const strongOwnerSignals = new Set(
    [
      ...customerProfiles.map((profile) => profile.ownerId),
      ...subscriptionProfiles.map((profile) => profile.ownerId),
      ...paymentMethodProfiles.map((profile) => profile.ownerId),
    ].filter((value): value is string => Boolean(value)),
  );
  if (strongOwnerSignals.size > 1) {
    return { ownerId, ownerGeneration: "", disposition: "discard" };
  }
  const strongOwnerId = strongOwnerSignals.values().next().value ?? "";
  if (ownerId && strongOwnerId && ownerId !== strongOwnerId) {
    const [sourceOwnerHash, destinationOwnerHash] = await Promise.all([
      ownershipMigrationSourceDigest(ownerId),
      ownershipMigrationSourceDigest(strongOwnerId),
    ]);
    const aliases = await ctx.db
      .query("billing_stripe_owner_aliases")
      .withIndex("by_sourceOwnerHash_and_destinationOwnerHash", (q) =>
        q
          .eq("sourceOwnerHash", sourceOwnerHash)
          .eq("destinationOwnerHash", destinationOwnerHash),
      )
      .take(2);
    if (aliases.length !== 1) {
      if (
        (await hasActiveExactMigration(ownerId, strongOwnerId)) ||
        (await hasActiveExactMigration(strongOwnerId, ownerId))
      ) {
        return {
          ownerId: strongOwnerId,
          ownerGeneration: "",
          disposition: "retry",
        };
      }
      return { ownerId, ownerGeneration: "", disposition: "discard" };
    }
    ownerId = strongOwnerId;
  } else {
    ownerId ||= strongOwnerId;
  }

  for (const [kind, value] of [
    ["customer", customerId],
    ["subscription", subscriptionId],
    ["payment_method", paymentMethodId],
    ["checkout_session", checkoutSessionId],
  ] as const) {
    if (!value) continue;
    const locatorHash = await hashStripeBillingLocator(kind, value);
    const tombstone = await ctx.db
      .query("billing_stripe_deletion_tombstones")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
      .unique();
    if (tombstone) {
      return { ownerId, ownerGeneration: "", disposition: "discard" };
    }
    const debtLocator = await ctx.db
      .query("billing_owner_deletion_locators")
      .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
      .unique();
    if (debtLocator) {
      ownerId ||= debtLocator.ownerId;
      return { ownerId, ownerGeneration: "", disposition: "discard" };
    }
  }

  if (!ownerId) {
    return { ownerId: "", ownerGeneration: "", disposition: "allow" };
  }
  if (await hasActiveExactMigration(ownerId)) {
    return { ownerId, ownerGeneration: "", disposition: "retry" };
  }
  const lifecycle = await ctx.db
    .query("cloud_owner_lifecycles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (lifecycle?.state === "deleting") {
    return {
      ownerId,
      ownerGeneration: lifecycle.generation,
      disposition: "discard",
    };
  }
  if (lifecycle?.state === "resetting") {
    return {
      ownerId,
      ownerGeneration: lifecycle.generation,
      disposition: "retry",
    };
  }
  if (await hasOwnerMigrationSourceFence(ctx, ownerId)) {
    return {
      ownerId,
      ownerGeneration: lifecycle?.generation ?? LEGACY_OWNER_GENERATION,
      disposition: "discard",
    };
  }
  try {
    const active = await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    return {
      ownerId,
      ownerGeneration: active.generation,
      disposition: "allow",
    };
  } catch {
    // Source owners are permanently discarded above. Any remaining canonical
    // write fence is an incoming migration (or a concurrent lifecycle
    // transition), so Stripe should retry after ownership settles and must not
    // materialize a destination-owned event meanwhile.
    return {
      ownerId,
      ownerGeneration: lifecycle?.generation ?? LEGACY_OWNER_GENERATION,
      disposition: "retry",
    };
  }
};

export const recordStripeEvent = internalMutation({
  args: {
    eventId: v.string(),
    claimId: v.string(),
    eventType: v.string(),
    ownerId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripePaymentMethodId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    createdAt: v.number(),
  },
  returns: v.object({
    accepted: v.boolean(),
    status: v.union(
      v.literal("accepted"),
      v.literal("duplicate"),
      v.literal("in_progress"),
      v.literal("retry"),
      v.literal("discarded"),
    ),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const owner = await resolveStripeEventOwner(ctx, args);
    if (owner.disposition === "discard") {
      return { accepted: false, status: "discarded" as const };
    }
    if (owner.disposition === "retry") {
      return { accepted: false, status: "retry" as const };
    }
    const existing = await ctx.db
      .query("billing_stripe_events")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();

    if (existing) {
      const processed =
        existing.processingState === "processed" ||
        (existing.processingState === undefined &&
          existing.processedAt !== undefined);
      if (processed) {
        return { accepted: false, status: "duplicate" as const };
      }
      if (
        existing.processingState === "processing" &&
        (existing.claimExpiresAt ?? 0) > now &&
        existing.claimId !== args.claimId
      ) {
        return { accepted: false, status: "in_progress" as const };
      }
      if (
        existing.processingState === "retry" &&
        (existing.nextRetryAt ?? 0) > now
      ) {
        return { accepted: false, status: "in_progress" as const };
      }
      await ctx.db.patch(existing._id, {
        eventType: args.eventType,
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration || undefined,
        stripeCustomerId: toSafeString(args.stripeCustomerId),
        stripeSubscriptionId: toSafeString(args.stripeSubscriptionId),
        stripePaymentMethodId:
          toSafeString(args.stripePaymentMethodId) || undefined,
        stripeCheckoutSessionId:
          toSafeString(args.stripeCheckoutSessionId) || undefined,
        processingState: "processing",
        claimId: args.claimId,
        claimExpiresAt: now + STRIPE_EVENT_CLAIM_MS,
        lastError: undefined,
        nextRetryAt: undefined,
        attempts: (existing.attempts ?? 0) + 1,
        updatedAt: now,
      });
      return { accepted: true, status: "accepted" as const };
    }

    await ctx.db.insert("billing_stripe_events", {
      eventId: args.eventId,
      eventType: args.eventType,
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration || undefined,
      stripeCustomerId: toSafeString(args.stripeCustomerId),
      stripeSubscriptionId: toSafeString(args.stripeSubscriptionId),
      stripePaymentMethodId:
        toSafeString(args.stripePaymentMethodId) || undefined,
      stripeCheckoutSessionId:
        toSafeString(args.stripeCheckoutSessionId) || undefined,
      createdAt: args.createdAt,
      receivedAt: now,
      processingState: "processing",
      claimId: args.claimId,
      claimExpiresAt: now + STRIPE_EVENT_CLAIM_MS,
      attempts: 1,
      updatedAt: now,
    });

    return { accepted: true, status: "accepted" as const };
  },
});

/** Reads the immutable admission fence for one active webhook claim. */
export const getStripeEventClaimFenceInternal = internalQuery({
  args: { eventId: v.string(), claimId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      ownerGeneration: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("billing_stripe_events")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (
      !event ||
      event.processingState !== "processing" ||
      event.claimId !== args.claimId
    ) {
      return null;
    }
    return {
      ownerId: event.ownerId,
      ownerGeneration: event.ownerGeneration ?? "",
    };
  },
});

export const completeStripeEvent = internalMutation({
  args: { eventId: v.string(), claimId: v.string(), processedAt: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("billing_stripe_events")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (
      !existing ||
      existing.processingState !== "processing" ||
      existing.claimId !== args.claimId
    ) {
      return false;
    }
    await ctx.db.patch(existing._id, {
      processingState: "processed",
      claimId: undefined,
      claimExpiresAt: undefined,
      processedAt: args.processedAt,
      updatedAt: args.processedAt,
    });
    return true;
  },
});

export const releaseStripeEventClaim = internalMutation({
  args: {
    eventId: v.string(),
    claimId: v.string(),
    error: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("billing_stripe_events")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (
      !existing ||
      existing.processingState !== "processing" ||
      existing.claimId !== args.claimId
    ) {
      return false;
    }
    const now = args.now ?? Date.now();
    const attempts = Math.max(1, existing.attempts ?? 1);
    await ctx.db.patch(existing._id, {
      processingState: "retry",
      claimId: undefined,
      claimExpiresAt: undefined,
      lastError: args.error?.slice(0, 2_000),
      nextRetryAt: now + Math.min(60_000, 1_000 * 2 ** (attempts - 1)),
      updatedAt: now,
    });
    return true;
  },
});

export const deleteStripeEvent = internalMutation({
  args: {
    eventId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("billing_stripe_events")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

export const syncSubscriptionFromStripe = internalMutation({
  args: {
    ownerId: v.optional(v.string()),
    ownerGeneration: v.string(),
    stripeEventCreatedAt: v.number(),
    stripeEventId: v.optional(v.string()),
    stripeEventTerminal: v.optional(v.boolean()),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.optional(v.string()),
    requestedPlan: v.optional(planValidator),
    subscriptionStatus: v.string(),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    defaultPaymentMethodId: v.optional(v.string()),
    paymentMethodBrand: v.optional(v.string()),
    paymentMethodLast4: v.optional(v.string()),
  },
  returns: v.object({
    updated: v.boolean(),
    ownerId: v.union(v.string(), v.null()),
    activePlan: planValidator,
  }),
  handler: async (ctx, args) => {
    const normalizedCustomerId = toSafeString(args.stripeCustomerId);
    const normalizedSubscriptionId = toSafeString(args.stripeSubscriptionId);
    let ownerId = toSafeString(args.ownerId);

    const [byCustomer, bySubscription] = await Promise.all([
      normalizedCustomerId
        ? ctx.db
            .query("billing_profiles")
            .withIndex("by_stripeCustomerId", (q) =>
              q.eq("stripeCustomerId", normalizedCustomerId),
            )
            .unique()
        : null,
      normalizedSubscriptionId
        ? ctx.db
            .query("billing_profiles")
            .withIndex("by_stripeSubscriptionId", (q) =>
              q.eq("stripeSubscriptionId", normalizedSubscriptionId),
            )
            .unique()
        : null,
    ]);
    for (const linked of [byCustomer, bySubscription]) {
      if (linked && ownerId && linked.ownerId !== ownerId) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Stripe subscription is linked to a different account.",
        });
      }
      ownerId ||= linked?.ownerId ?? "";
    }

    if (!ownerId) {
      return { updated: false, ownerId: null, activePlan: "free" as const };
    }

    if (normalizedCustomerId) {
      const customerLocatorHash = await hashStripeBillingLocator(
        "customer",
        normalizedCustomerId,
      );
      const deletedCustomer = await ctx.db
        .query("billing_stripe_deletion_tombstones")
        .withIndex("by_locatorHash", (q) =>
          q.eq("locatorHash", customerLocatorHash),
        )
        .unique();
      if (deletedCustomer) {
        return { updated: false, ownerId, activePlan: "free" as const };
      }
    }

    const { profile, usage } = await ensureBillingRecordsForOwner(
      ctx,
      ownerId,
      args.ownerGeneration,
    );
    if (profile.stripeCustomerTerminal === true) {
      return {
        updated: false,
        ownerId,
        activePlan: profile.activePlan as SubscriptionPlan,
      };
    }
    const normalizedStatus = args.subscriptionStatus.trim().toLowerCase();
    const incomingTerminal =
      args.stripeEventTerminal === true || normalizedStatus === "canceled";
    const differentSubscription = Boolean(
      normalizedSubscriptionId &&
        profile.stripeSubscriptionId &&
        profile.stripeSubscriptionId !== normalizedSubscriptionId,
    );
    if (differentSubscription && incomingTerminal) {
      return {
        updated: false,
        ownerId,
        activePlan: profile.activePlan as SubscriptionPlan,
      };
    }
    const sameTerminalSubscription =
      profile.stripeSubscriptionTerminal === true &&
      profile.stripeSubscriptionId === normalizedSubscriptionId;
    const replacingTerminalSubscription =
      differentSubscription &&
      profile.stripeSubscriptionTerminal === true &&
      !incomingTerminal;
    if (
      (sameTerminalSubscription && !incomingTerminal) ||
      (!replacingTerminalSubscription &&
        !shouldApplyStripeResourceEvent({
          storedAt:
            profile.stripeSubscriptionUpdatedAt ?? profile.stripeUpdatedAt ?? 0,
          storedEventId: profile.stripeSubscriptionEventId,
          storedTerminal: profile.stripeSubscriptionTerminal,
          incomingAt: args.stripeEventCreatedAt,
          incomingEventId: args.stripeEventId,
          incomingTerminal,
        }))
    ) {
      return {
        updated: false,
        ownerId,
        activePlan: profile.activePlan as SubscriptionPlan,
      };
    }
    if (
      normalizedCustomerId &&
      profile.stripeCustomerId &&
      profile.stripeCustomerId !== normalizedCustomerId
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Account already has a different Stripe customer.",
      });
    }
    if (
      normalizedSubscriptionId &&
      profile.stripeSubscriptionId &&
      profile.stripeSubscriptionId !== normalizedSubscriptionId &&
      profile.stripeSubscriptionTerminal !== true
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Account already has a different Stripe subscription.",
      });
    }
    const requestedPlan =
      args.requestedPlan && args.requestedPlan !== "free"
        ? args.requestedPlan
        : null;
    const planFromPriceId = findPlanForStripePriceId(args.stripePriceId);
    // The live Stripe price is authoritative. Subscription metadata is only a
    // bootstrap hint because Billing Portal plan changes do not rewrite it.
    const normalizedPriceId = toSafeString(args.stripePriceId);
    const resolvedPaidPlan = normalizedPriceId
      ? planFromPriceId
      : requestedPlan;
    const nextPlan: SubscriptionPlan =
      ACTIVE_SUBSCRIPTION_STATUSES.has(normalizedStatus) && resolvedPaidPlan
        ? resolvedPaidPlan
        : "free";

    const now = Date.now();
    const nextCurrentPeriodStart = toNonNegativeInt(args.currentPeriodStart);
    const nextCurrentPeriodEnd = toNonNegativeInt(args.currentPeriodEnd);
    const nextAnchor =
      nextPlan === "free"
        ? profile.monthlyAnchorAt > 0
          ? profile.monthlyAnchorAt
          : now
        : nextCurrentPeriodStart > 0
          ? nextCurrentPeriodStart
          : now;
    const applyPaymentMethod = shouldApplyStripeResourceEvent({
      storedAt:
        profile.stripePaymentMethodUpdatedAt ?? profile.stripeUpdatedAt ?? 0,
      storedEventId: profile.stripePaymentMethodEventId,
      incomingAt: args.stripeEventCreatedAt,
      incomingEventId: args.stripeEventId,
    });

    await ctx.db.patch(profile._id, {
      activePlan: nextPlan,
      subscriptionStatus: normalizedStatus,
      stripeCustomerId: normalizedCustomerId || profile.stripeCustomerId,
      ...(normalizedCustomerId &&
      normalizedCustomerId !== profile.stripeCustomerId
        ? {
            stripeCustomerUpdatedAt: args.stripeEventCreatedAt,
            stripeCustomerEventId: args.stripeEventId?.trim() || undefined,
            stripeCustomerTerminal: false,
          }
        : {}),
      stripeSubscriptionId:
        normalizedSubscriptionId || profile.stripeSubscriptionId,
      stripePriceId:
        nextPlan === "free" ? emptyString : toSafeString(args.stripePriceId),
      ...(applyPaymentMethod
        ? {
            defaultPaymentMethodId: toSafeString(args.defaultPaymentMethodId),
            paymentMethodBrand: toSafeString(args.paymentMethodBrand),
            paymentMethodLast4: toSafeString(args.paymentMethodLast4),
            stripePaymentMethodUpdatedAt: args.stripeEventCreatedAt,
            stripePaymentMethodEventId: args.stripeEventId?.trim() || undefined,
          }
        : {}),
      currentPeriodStart: nextCurrentPeriodStart,
      currentPeriodEnd: nextCurrentPeriodEnd,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd === true,
      monthlyAnchorAt: nextAnchor,
      stripeSubscriptionUpdatedAt: args.stripeEventCreatedAt,
      stripeSubscriptionEventId: args.stripeEventId?.trim() || undefined,
      stripeSubscriptionTerminal: incomingTerminal,
      updatedAt: now,
    });

    if (profile.activePlan !== nextPlan) {
      const week = getWeekBounds(new Date(now));
      const month = getMonthlyBounds(new Date(now), new Date(nextAnchor));
      await ctx.db.patch(usage._id, {
        rollingUsageMicroCents: 0,
        rollingWindowStartedAt: now,
        weeklyUsageMicroCents: 0,
        weeklyWindowStartedAt: week.start.getTime(),
        monthlyUsageMicroCents: 0,
        monthlyWindowStartedAt: month.start.getTime(),
        updatedAt: now,
      });
    }
    await scheduleOwnerSnapshotChanged(ctx, ownerId, "billing");

    return { updated: true, ownerId, activePlan: nextPlan };
  },
});

export const setAdminBillingPlan = internalMutation({
  args: {
    ownerId: v.string(),
    plan: v.optional(planValidator),
    usageMode: v.optional(usageModeValidator),
    subscriptionStatus: v.optional(v.string()),
    resetUsage: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const ownerId = args.ownerId.trim();
    if (!ownerId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "ownerId is required.",
      });
    }

    const { profile, usage } = await ensureBillingRecordsForOwner(ctx, ownerId);
    const now = Date.now();
    const nextPlan = args.plan ?? (profile.activePlan as SubscriptionPlan);
    const planChanged = profile.activePlan !== nextPlan;
    const nextUsageMode =
      args.usageMode ??
      (planChanged ? "default" : (profile.usageMode ?? "default"));
    const normalizedStatus =
      args.subscriptionStatus?.trim().toLowerCase() ||
      (nextPlan === "free" ? "none" : "active");
    const usageModeChanged = (profile.usageMode ?? "default") !== nextUsageMode;
    const shouldResetUsage =
      args.resetUsage ?? (planChanged || usageModeChanged);
    const nextAnchor =
      nextPlan === "free"
        ? profile.monthlyAnchorAt > 0
          ? profile.monthlyAnchorAt
          : now
        : now;

    await ctx.db.patch(profile._id, {
      activePlan: nextPlan,
      usageMode: nextUsageMode,
      subscriptionStatus: normalizedStatus,
      currentPeriodStart: nextPlan === "free" ? 0 : now,
      currentPeriodEnd: 0,
      cancelAtPeriodEnd: false,
      monthlyAnchorAt: nextAnchor,
      updatedAt: now,
    });

    if (shouldResetUsage) {
      const week = getWeekBounds(new Date(now));
      const month = getMonthlyBounds(new Date(now), new Date(nextAnchor));
      await ctx.db.patch(usage._id, {
        rollingUsageMicroCents: 0,
        rollingWindowStartedAt: now,
        weeklyUsageMicroCents: 0,
        weeklyWindowStartedAt: week.start.getTime(),
        monthlyUsageMicroCents: 0,
        monthlyWindowStartedAt: month.start.getTime(),
        updatedAt: now,
      });
    }

    await scheduleOwnerSnapshotChanged(ctx, ownerId, "billing");
    return {
      ownerId,
      activePlan: nextPlan,
      usageMode: nextUsageMode,
      subscriptionStatus: normalizedStatus,
      resetUsage: shouldResetUsage,
    };
  },
});

export const recordInvoicePayment = internalMutation({
  args: {
    ownerId: v.optional(v.string()),
    ownerGeneration: v.string(),
    stripeEventCreatedAt: v.number(),
    stripeCustomerId: v.optional(v.string()),
    stripeInvoiceId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    amountPaidCents: v.number(),
    currency: v.string(),
    billingReason: v.string(),
    status: v.string(),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, args) => {
    let ownerId = toSafeString(args.ownerId);
    const customerId = toSafeString(args.stripeCustomerId);
    const subscriptionId = toSafeString(args.stripeSubscriptionId);

    const [byCustomer, bySubscription] = await Promise.all([
      customerId
        ? ctx.db
            .query("billing_profiles")
            .withIndex("by_stripeCustomerId", (q) =>
              q.eq("stripeCustomerId", customerId),
            )
            .unique()
        : null,
      subscriptionId
        ? ctx.db
            .query("billing_profiles")
            .withIndex("by_stripeSubscriptionId", (q) =>
              q.eq("stripeSubscriptionId", subscriptionId),
            )
            .unique()
        : null,
    ]);
    for (const linked of [byCustomer, bySubscription]) {
      if (linked && ownerId && linked.ownerId !== ownerId) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Stripe invoice is linked to a different account.",
        });
      }
      ownerId ||= linked?.ownerId ?? "";
    }

    if (!ownerId) {
      return { recorded: false };
    }

    await ensureBillingRecordsForOwner(ctx, ownerId, args.ownerGeneration);

    const existing = await ctx.db
      .query("billing_invoice_payments")
      .withIndex("by_stripeInvoiceId", (q) =>
        q.eq("stripeInvoiceId", args.stripeInvoiceId),
      )
      .unique();

    const now = Date.now();
    const paymentIntentId = toSafeString(args.stripePaymentIntentId);
    const currency = args.currency.trim().toLowerCase();

    if (existing) {
      if (existing.ownerId !== ownerId) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Stripe invoice ownership cannot be changed.",
        });
      }
      if (
        existing.stripePaymentIntentId &&
        paymentIntentId &&
        existing.stripePaymentIntentId !== paymentIntentId
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Stripe invoice payment intent cannot be changed.",
        });
      }
      if (
        existing.stripeSubscriptionId &&
        subscriptionId &&
        existing.stripeSubscriptionId !== subscriptionId
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Stripe invoice subscription cannot be changed.",
        });
      }
      if (existing.currency.toLowerCase() !== currency) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Stripe invoice currency cannot be changed.",
        });
      }
      if (
        (existing.lastStripeEventCreatedAt ?? 0) > args.stripeEventCreatedAt
      ) {
        return { recorded: false };
      }
      const incomingStatus = args.status.trim().toLowerCase();
      const nextStatus =
        existing.status.toLowerCase() === "paid" ? "paid" : incomingStatus;
      await ctx.db.patch(existing._id, {
        stripePaymentIntentId:
          paymentIntentId || existing.stripePaymentIntentId,
        stripeSubscriptionId: subscriptionId || existing.stripeSubscriptionId,
        amountPaidCents: Math.max(
          existing.amountPaidCents,
          Math.max(0, Math.floor(args.amountPaidCents)),
        ),
        billingReason: args.billingReason,
        status: nextStatus,
        periodStart: toNonNegativeInt(args.periodStart),
        periodEnd: toNonNegativeInt(args.periodEnd),
        lastStripeEventCreatedAt: args.stripeEventCreatedAt,
        updatedAt: now,
      });
      return { recorded: true };
    }

    await ctx.db.insert("billing_invoice_payments", {
      ownerId,
      stripeInvoiceId: args.stripeInvoiceId,
      stripePaymentIntentId: paymentIntentId,
      stripeSubscriptionId: subscriptionId,
      amountPaidCents: Math.max(0, Math.floor(args.amountPaidCents)),
      currency,
      billingReason: args.billingReason,
      status: args.status,
      periodStart: toNonNegativeInt(args.periodStart),
      periodEnd: toNonNegativeInt(args.periodEnd),
      lastStripeEventCreatedAt: args.stripeEventCreatedAt,
      createdAt: now,
      updatedAt: now,
    });

    return { recorded: true };
  },
});

export const recordUsageCreditPurchase = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stripeEventCreatedAt: v.number(),
    stripeCheckoutSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    stripeCustomerId: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    status: v.string(),
  },
  returns: v.object({
    recorded: v.literal(true),
    credited: v.boolean(),
    amountMicroCents: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = args.ownerId.trim();
    const checkoutSessionId = args.stripeCheckoutSessionId.trim();
    if (!ownerId || !checkoutSessionId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Usage credit purchase is missing required identifiers.",
      });
    }

    const { profile } = await ensureBillingRecordsForOwner(
      ctx,
      ownerId,
      args.ownerGeneration,
    );
    const amountCents = normalizeUsageCreditPurchaseAmountCents(
      args.amountCents,
    );
    const amountMicroCents = centsToMicroCents(amountCents);
    const status = args.status.trim().toLowerCase() || "unknown";
    const paymentIntentId = toSafeString(args.stripePaymentIntentId);
    const customerId = toSafeString(args.stripeCustomerId);
    const currency =
      args.currency.trim().toLowerCase() || USAGE_CREDIT_CURRENCY;
    const now = Date.now();
    const customerTombstone = customerId
      ? await (async () => {
          const locatorHash = await hashStripeBillingLocator(
            "customer",
            customerId,
          );
          return await ctx.db
            .query("billing_stripe_deletion_tombstones")
            .withIndex("by_locatorHash", (q) =>
              q.eq("locatorHash", locatorHash),
            )
            .unique();
        })()
      : null;

    if (
      customerId &&
      !customerTombstone &&
      profile.stripeCustomerId &&
      profile.stripeCustomerId !== customerId
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Usage credit customer is linked to a different account.",
      });
    }
    if (customerId && !customerTombstone) {
      const linkedCustomer = await ctx.db
        .query("billing_profiles")
        .withIndex("by_stripeCustomerId", (q) =>
          q.eq("stripeCustomerId", customerId),
        )
        .first();
      if (linkedCustomer && linkedCustomer.ownerId !== ownerId) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Usage credit customer is linked to a different account.",
        });
      }
      if (
        !profile.stripeCustomerId &&
        profile.stripeCustomerTerminal !== true
      ) {
        await ctx.db.patch(profile._id, {
          stripeCustomerId: customerId,
          updatedAt: now,
        });
      }
    }

    const existing = await ctx.db
      .query("billing_usage_credit_purchases")
      .withIndex("by_stripeCheckoutSessionId", (q) =>
        q.eq("stripeCheckoutSessionId", checkoutSessionId),
      )
      .unique();
    const legacyCredited =
      existing?.creditedAt !== undefined || existing?.status === "paid";
    const shouldCredit = status === "paid" && !legacyCredited;

    if (existing) {
      if (
        existing.ownerId !== ownerId ||
        (existing.stripeCustomerId &&
          customerId &&
          existing.stripeCustomerId !== customerId) ||
        (existing.stripePaymentIntentId &&
          paymentIntentId &&
          existing.stripePaymentIntentId !== paymentIntentId) ||
        existing.amountMicroCents !== amountMicroCents ||
        existing.currency.toLowerCase() !== currency
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Usage credit purchase identity cannot be changed.",
        });
      }
      const stale =
        (existing.lastStripeEventCreatedAt ?? 0) > args.stripeEventCreatedAt;
      await ctx.db.patch(existing._id, {
        stripePaymentIntentId:
          paymentIntentId || existing.stripePaymentIntentId,
        stripeCustomerId: customerId || existing.stripeCustomerId,
        status:
          legacyCredited || shouldCredit
            ? "paid"
            : stale
              ? existing.status
              : status,
        ...(legacyCredited
          ? {
              creditedAt: existing.creditedAt ?? existing.updatedAt,
              creditedAmountMicroCents:
                existing.creditedAmountMicroCents ?? existing.amountMicroCents,
            }
          : shouldCredit
            ? {
                creditedAt: now,
                creditedAmountMicroCents: amountMicroCents,
              }
            : {}),
        lastStripeEventCreatedAt: Math.max(
          existing.lastStripeEventCreatedAt ?? 0,
          args.stripeEventCreatedAt,
        ),
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("billing_usage_credit_purchases", {
        ownerId,
        stripeCheckoutSessionId: checkoutSessionId,
        stripePaymentIntentId: paymentIntentId,
        stripeCustomerId: customerId,
        amountMicroCents,
        currency,
        status,
        ...(shouldCredit
          ? {
              creditedAt: now,
              creditedAmountMicroCents: amountMicroCents,
            }
          : {}),
        lastStripeEventCreatedAt: args.stripeEventCreatedAt,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!shouldCredit) {
      return {
        recorded: true as const,
        credited: false,
        amountMicroCents,
      };
    }

    const credit = await ensureUsageCreditForOwner(ctx, ownerId);
    await ctx.db.patch(credit._id, {
      balanceMicroCents:
        getUsageCreditBalanceMicroCents(credit) + amountMicroCents,
      totalPurchasedMicroCents:
        Math.max(0, Math.floor(credit.totalPurchasedMicroCents)) +
        amountMicroCents,
      currency,
      updatedAt: now,
    });

    return {
      recorded: true as const,
      credited: true,
      amountMicroCents,
    };
  },
});

export type ManagedUsageLimitResult = {
  allowed: boolean;
  plan: SubscriptionPlan;
  unlimited: boolean;
  retryAfterMs: number;
  message: string;
};

export type ManagedModelAllowanceResult = {
  access: ManagedModelAccessResult;
  /** Spend still available right now; `null` when the owner is unlimited. */
  remainingMicroCents: number | null;
};

type ResolveManagedModelAllowanceArgs = {
  ownerId: string;
  isAnonymous?: boolean;
  ownerGeneration: string;
};

type ManagedModelBillingProfile = Pick<
  Doc<"billing_profiles">,
  "activePlan" | "monthlyAnchorAt" | "usageMode"
>;

type ManagedModelBillingUsage = Pick<
  Doc<"billing_usage_windows">,
  | "activeReservedMicroCents"
  | "rollingUsageMicroCents"
  | "rollingWindowStartedAt"
  | "weeklyUsageMicroCents"
  | "weeklyWindowStartedAt"
  | "monthlyUsageMicroCents"
  | "monthlyWindowStartedAt"
  | "totalUsageMicroCents"
>;

type ManagedModelBillingCredit = Pick<
  Doc<"billing_usage_credits">,
  "balanceMicroCents"
>;

const resolveManagedModelAllowanceFromBillingState = (args: {
  profile: ManagedModelBillingProfile;
  usage: ManagedModelBillingUsage;
  credit: ManagedModelBillingCredit | null;
  isAnonymous?: boolean;
  now: number;
}): {
  allowance: ManagedModelAllowanceResult;
  normalizedUsage: UsageSnapshot["normalizedUsage"];
  usageChanged: boolean;
} => {
  const plan = args.profile.activePlan;
  const unlimited = hasUnlimitedUsage(args.profile);
  const snapshot = buildUsageSnapshot({
    profile: args.profile,
    usage: args.usage,
    plan,
    now: args.now,
  });
  const reservedMicroCents = unlimited
    ? 0
    : activeManagedUsageReservationMicroCents(args.usage);
  const availableCreditMicroCents = getUsageCreditBalanceMicroCents(
    args.credit,
  );
  // Voice admission reserves a real monetary ceiling. Other managed
  // admissions see included headroom and purchased credits net of those
  // reservations.
  const firstExceeded = findExceededWindow(
    snapshot,
    (window) =>
      Math.max(0, window.limit - window.used) + availableCreditMicroCents <=
      reservedMicroCents,
  );
  const exceededWindow = firstExceeded?.window ?? null;
  const access = buildManagedModelAccessResult({
    plan,
    isAnonymous: args.isAnonymous,
    unlimited,
    exceededWindow,
    lifetimeExhausted:
      exceededWindow !== null && firstExceeded?.lifetime === true,
    now: args.now,
  });
  return {
    allowance: {
      access,
      remainingMicroCents: unlimited
        ? null
        : Math.max(
            0,
            computeManagedUsageRemainingMicroCents({
              snapshot,
              credit: args.credit,
              usage: args.usage,
            }),
          ),
    },
    normalizedUsage: snapshot.normalizedUsage,
    usageChanged: snapshot.changed,
  };
};

const resolveManagedModelAllowanceForWrite = async (
  ctx: MutationCtx,
  args: ResolveManagedModelAllowanceArgs,
): Promise<ManagedModelAllowanceResult> => {
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const { profile, usage } = await ensureBillingRecordsForOwnerAuthorized(
    ctx,
    args.ownerId,
  );
  const now = Date.now();
  const credit = hasUnlimitedUsage(profile)
    ? null
    : await getOwnerUsageCreditRow(ctx, args.ownerId);
  const resolved = resolveManagedModelAllowanceFromBillingState({
    profile,
    usage,
    credit,
    isAnonymous: args.isAnonymous,
    now,
  });
  if (resolved.usageChanged) {
    await ctx.db.patch(usage._id, {
      ...resolved.normalizedUsage,
      updatedAt: now,
    });
  }
  return resolved.allowance;
};

/** Read-only allowance using stored rows or the defaults writers create. */
export const runPeekManagedModelAllowance = async (
  ctx: QueryCtx | MutationCtx,
  args: ResolveManagedModelAllowanceArgs,
): Promise<ManagedModelAllowanceResult> => {
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const now = Date.now();
  const { profile, usage } = await readBillingRecordsForOwner(
    ctx,
    args.ownerId,
    now,
  );
  const credit = hasUnlimitedUsage(profile)
    ? null
    : await getOwnerUsageCreditRow(ctx, args.ownerId);
  return resolveManagedModelAllowanceFromBillingState({
    profile,
    usage,
    credit,
    isAnonymous: args.isAnonymous,
    now,
  }).allowance;
};

export const runPeekManagedModelAccess = async (
  ctx: QueryCtx | MutationCtx,
  args: ResolveManagedModelAllowanceArgs,
): Promise<ManagedModelAccessResult> =>
  (await runPeekManagedModelAllowance(ctx, args)).access;

// Reusable cores let standalone mutations and the combined gate mutation run
// the same billing math. Writers still initialize missing rows and persist
// window normalization; snapshot readers do both in memory.
export const runResolveManagedModelAccess = async (
  ctx: MutationCtx,
  args: ResolveManagedModelAllowanceArgs,
): Promise<ManagedModelAccessResult> =>
  (await resolveManagedModelAllowanceForWrite(ctx, args)).access;

/**
 * Audience policy plus remaining spend, for callers that hand a fixed budget
 * to a party that cannot consult billing per request (gateway capabilities).
 * Audience comes from the same policy as `resolveManagedModelAccess`; the
 * remaining spend from the same math as `enforceManagedUsageLimit`.
 */
export const runResolveManagedModelAllowance = async (
  ctx: MutationCtx,
  args: ResolveManagedModelAllowanceArgs,
): Promise<ManagedModelAllowanceResult> =>
  await resolveManagedModelAllowanceForWrite(ctx, args);

export const runEnforceManagedUsageLimit = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    minimumRemainingMicroCents?: number;
    ownerGeneration: string;
  },
): Promise<ManagedUsageLimitResult> => {
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const { profile, usage } = await ensureBillingRecordsForOwner(
    ctx,
    args.ownerId,
  );
  const now = Date.now();
  const plan = profile.activePlan as SubscriptionPlan;
  const unlimited = hasUnlimitedUsage(profile);
  const snapshot = buildUsageSnapshot({
    profile,
    usage,
    plan,
    now,
  });

  if (snapshot.changed) {
    await ctx.db.patch(usage._id, {
      ...snapshot.normalizedUsage,
      updatedAt: now,
    });
  }

  if (unlimited) {
    return {
      allowed: true,
      plan,
      unlimited: true,
      retryAfterMs: 0,
      message: emptyString,
    };
  }

  const minimumRemainingMicroCents = Math.max(
    0,
    Math.floor(args.minimumRemainingMicroCents ?? 0),
  );
  const credit = await getOwnerUsageCreditRow(ctx, args.ownerId);
  const remainingMicroCents = computeManagedUsageRemainingMicroCents({
    snapshot,
    credit,
    usage,
  });
  const blocked =
    minimumRemainingMicroCents > 0
      ? remainingMicroCents < minimumRemainingMicroCents
      : remainingMicroCents <= 0;

  if (blocked) {
    // Name the bucket that ran out (lifetime first, then the shortest window)
    // so the message and Retry-After describe the blocking allowance.
    const reservedMicroCents = activeManagedUsageReservationMicroCents(usage);
    const availableCreditMicroCents = getUsageCreditBalanceMicroCents(credit);
    const exceeded = findExceededWindow(snapshot, (window) => {
      const availableMicroCents =
        Math.max(0, window.limit - window.used) + availableCreditMicroCents;
      return minimumRemainingMicroCents > 0
        ? availableMicroCents < minimumRemainingMicroCents + reservedMicroCents
        : availableMicroCents <= reservedMicroCents;
    }) ?? { window: snapshot.rolling, lifetime: false as const };
    return {
      allowed: false,
      plan,
      message: buildLimitMessage(plan, exceeded.lifetime),
      retryAfterMs: Math.max(1_000, exceeded.window.resetAt - now),
      unlimited: false,
    };
  }

  return {
    allowed: true,
    plan,
    retryAfterMs: 0,
    message: emptyString,
    unlimited: false,
  };
};

export const resolveManagedModelAccess = internalMutation({
  args: {
    ownerId: v.string(),
    isAnonymous: v.optional(v.boolean()),
    ownerGeneration: v.string(),
  },
  returns: v.object({
    allowed: v.boolean(),
    plan: planValidator,
    unlimited: v.boolean(),
    downgraded: v.boolean(),
    modelAudience: v.union(
      v.literal("anonymous"),
      v.literal("free"),
      v.literal("go"),
      v.literal("pro"),
      v.literal("go_fallback"),
      v.literal("pro_fallback"),
    ),
    retryAfterMs: v.number(),
    message: v.string(),
  }),
  handler: async (ctx, args): Promise<ManagedModelAccessResult> =>
    await runResolveManagedModelAccess(ctx, args),
});

export const enforceManagedUsageLimit = internalMutation({
  args: {
    ownerId: v.string(),
    minimumRemainingMicroCents: v.optional(v.number()),
    ownerGeneration: v.string(),
  },
  returns: v.object({
    allowed: v.boolean(),
    plan: planValidator,
    unlimited: v.boolean(),
    retryAfterMs: v.number(),
    message: v.string(),
  }),
  handler: async (ctx, args): Promise<ManagedUsageLimitResult> =>
    await runEnforceManagedUsageLimit(ctx, args),
});

export const logManagedUsage = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    agentType: v.string(),
    model: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
    conversationId: v.optional(v.id("conversations")),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteInputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costMicroCents: v.optional(v.number()),
  },
  returns: v.object({
    costMicroCents: v.number(),
    creditConsumedMicroCents: v.number(),
    plan: planValidator,
  }),
  handler: async (ctx, args) =>
    await persistManagedUsage(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      conversationId: args.conversationId,
      agentType: `proxy:${args.agentType}`,
      model: args.model,
      durationMs: args.durationMs,
      success: args.success,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.totalTokens,
      cachedInputTokens: args.cachedInputTokens,
      cacheWriteInputTokens: args.cacheWriteInputTokens,
      reasoningTokens: args.reasoningTokens,
      costMicroCents: args.costMicroCents,
    }),
});

// ---------------------------------------------------------------------------
// Model gateway usage ingest
// ---------------------------------------------------------------------------

const gatewayUsageOutcomeValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("aborted"),
);

/** The subset of `GatewayUsageEvent` the ledger needs; the route projects onto it. */
export const gatewayUsageEventValidator = v.object({
  requestId: v.string(),
  ownerId: v.string(),
  ownerGeneration: v.string(),
  audience: managedModelAudienceValidator,
  agentType: v.string(),
  conversationId: v.optional(v.string()),
  resolvedModel: v.string(),
  usage: v.object({
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costMicroCents: v.optional(v.number()),
    reported: v.boolean(),
  }),
  chargedMicroCents: v.number(),
  outcome: gatewayUsageOutcomeValidator,
  startedAt: v.number(),
  finishedAt: v.number(),
  billable: v.boolean(),
  anonymous: v.optional(
    v.object({
      deviceId: v.optional(v.string()),
      ipHash: v.optional(v.string()),
    }),
  ),
});

type GatewayUsageEventInput = Infer<typeof gatewayUsageEventValidator>;

const gatewayUsageFenceReason = async (
  ctx: MutationCtx,
  event: GatewayUsageEventInput,
): Promise<string | null> => {
  try {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      event.ownerId,
      event.ownerGeneration,
    );
    return null;
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    const data = error.data as { code?: unknown } | string | undefined;
    const code =
      typeof data === "object" && data && typeof data.code === "string"
        ? data.code
        : "OWNER_FENCED";
    switch (code) {
      case "OWNER_DATA_GENERATION_STALE":
        return "generation_stale";
      case "OWNER_DATA_PURGE_ACTIVE":
        return "owner_purging";
      case "OWNERSHIP_MIGRATED":
        return "owner_migrated";
      default:
        return code.toLowerCase();
    }
  }
};

const resolveGatewayUsageConversationId = async (
  ctx: MutationCtx,
  ownerId: string,
  value: string | undefined,
): Promise<Id<"conversations"> | undefined> => {
  if (!value) return undefined;
  const conversationId = ctx.db.normalizeId("conversations", value);
  if (!conversationId) return undefined;
  const conversation = await ctx.db.get(conversationId);
  return conversation && conversation.ownerId === ownerId
    ? conversationId
    : undefined;
};

/**
 * Anonymous trials are metered by request, not money: bump the per-device
 * counter (the anonymous identity itself when the gateway named no device)
 * and the per-network bucket. Missing salt disables counting, never billing.
 */
const consumeGatewayAnonymousAllowance = async (
  ctx: MutationCtx,
  event: GatewayUsageEventInput,
) => {
  const deviceId =
    event.anonymous?.deviceId?.trim() || anonymousTrialDeviceId(event.ownerId);
  const ipHash = event.anonymous?.ipHash?.trim();
  try {
    await consumeDeviceAllowanceAuthorized(ctx, {
      deviceId,
      maxRequests: getMaxAnonRequests(),
    });
    if (ipHash) {
      await consumeDeviceAllowanceAuthorized(ctx, {
        deviceId: anonymousIpBucketDeviceId(ipHash),
        maxRequests: getMaxAnonRequestsPerIp(),
      });
    }
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) throw error;
    logMissingSaltOnce("gateway-usage");
  }
};

/**
 * Ledger write for model-gateway usage events. Idempotent on `requestId`
 * through `gateway_usage_receipts`: the receipt and the charge share one
 * transaction, so a retried batch can never bill twice. Failed and
 * non-billable events only leave a receipt; anonymous events consume the
 * trial counters; everything else charges exactly what the gateway settled.
 */
export const ingestGatewayUsageBatchInternal = internalMutation({
  args: {
    events: v.array(gatewayUsageEventValidator),
    now: v.number(),
  },
  returns: v.object({
    accepted: v.array(v.string()),
    duplicate: v.array(v.string()),
    rejected: v.array(v.object({ requestId: v.string(), reason: v.string() })),
  }),
  handler: async (ctx, args) => {
    const accepted: string[] = [];
    const duplicate: string[] = [];
    const rejected: Array<{ requestId: string; reason: string }> = [];
    const seen = new Set<string>();

    for (const event of args.events) {
      if (seen.has(event.requestId)) {
        duplicate.push(event.requestId);
        continue;
      }
      seen.add(event.requestId);
      const existing = await ctx.db
        .query("gateway_usage_receipts")
        .withIndex("by_requestId", (q) => q.eq("requestId", event.requestId))
        .unique();
      if (existing) {
        duplicate.push(event.requestId);
        continue;
      }

      const fenceReason = await gatewayUsageFenceReason(ctx, event);
      if (fenceReason) {
        rejected.push({ requestId: event.requestId, reason: fenceReason });
        continue;
      }

      const chargeable = event.billable && event.outcome !== "failed";
      if (chargeable && event.audience === "anonymous") {
        await consumeGatewayAnonymousAllowance(ctx, event);
      } else if (chargeable) {
        const inputTokens = toNonNegativeInt(event.usage.inputTokens);
        const outputTokens = toNonNegativeInt(event.usage.outputTokens);
        await persistManagedUsage(ctx, {
          ownerId: event.ownerId,
          ownerGeneration: event.ownerGeneration,
          agentType: `proxy:${event.agentType}`,
          model: event.resolvedModel,
          durationMs: Math.max(0, event.finishedAt - event.startedAt),
          success: event.outcome === "succeeded",
          conversationId: await resolveGatewayUsageConversationId(
            ctx,
            event.ownerId,
            event.conversationId,
          ),
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedInputTokens: event.usage.cachedInputTokens,
          cacheWriteInputTokens: event.usage.cacheWriteTokens,
          reasoningTokens: event.usage.reasoningTokens,
          costMicroCents: event.chargedMicroCents,
        });
      }

      await ctx.db.insert("gateway_usage_receipts", {
        requestId: event.requestId,
        ownerId: event.ownerId,
        ownerGeneration: event.ownerGeneration,
        chargedMicroCents: toNonNegativeInt(event.chargedMicroCents),
        createdAt: args.now,
      });
      accepted.push(event.requestId);
    }

    return { accepted, duplicate, rejected };
  },
});

const gatewayModelPriceValidator = v.object({
  model: v.string(),
  inputPerMillionUsd: v.number(),
  outputPerMillionUsd: v.number(),
  cacheReadPerMillionUsd: v.number(),
  cacheWritePerMillionUsd: v.number(),
  reasoningPerMillionUsd: v.number(),
});

/**
 * Prices the gateway uses to estimate and settle managed requests: the synced
 * `billing_model_prices` row when present, else the static fill-in, for every
 * managed model id. Models with neither are omitted (the gateway falls back
 * to its default price).
 */
export const listGatewayModelPricesInternal = internalQuery({
  args: {},
  returns: v.object({
    prices: v.array(gatewayModelPriceValidator),
    updatedAt: v.number(),
  }),
  handler: async (ctx) => {
    const modelIds = Array.from(
      new Set([
        ...listManagedModelIds(),
        ...Object.keys(STATIC_MANAGED_MODEL_PRICE_OVERRIDES),
      ]),
    ).sort();
    const prices: Infer<typeof gatewayModelPriceValidator>[] = [];
    let updatedAt = 0;
    for (const model of modelIds) {
      const row = await getManagedModelPriceRow(ctx, model);
      if (row) {
        prices.push({
          model,
          inputPerMillionUsd: row.inputPerMillionUsd,
          outputPerMillionUsd: row.outputPerMillionUsd,
          cacheReadPerMillionUsd: row.cacheReadPerMillionUsd,
          cacheWritePerMillionUsd: row.cacheWritePerMillionUsd,
          reasoningPerMillionUsd: row.reasoningPerMillionUsd,
        });
        updatedAt = Math.max(updatedAt, row.syncedAt);
        continue;
      }
      const staticPrice = STATIC_MANAGED_MODEL_PRICE_OVERRIDES[model];
      if (!staticPrice) continue;
      prices.push({
        model,
        inputPerMillionUsd: staticPrice.inputPerMillionUsd,
        outputPerMillionUsd: staticPrice.outputPerMillionUsd,
        cacheReadPerMillionUsd: staticPrice.cacheReadPerMillionUsd ?? 0,
        cacheWritePerMillionUsd: staticPrice.cacheWritePerMillionUsd ?? 0,
        reasoningPerMillionUsd:
          staticPrice.reasoningPerMillionUsd ?? staticPrice.outputPerMillionUsd,
      });
    }
    return { prices, updatedAt };
  },
});

export const getManagedModelPrice = internalQuery({
  args: {
    model: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("billing_model_prices"),
      _creationTime: v.number(),
      model: v.string(),
      source: v.string(),
      sourceProvider: v.string(),
      sourceModelId: v.string(),
      inputPerMillionUsd: v.number(),
      outputPerMillionUsd: v.number(),
      cacheReadPerMillionUsd: v.number(),
      cacheWritePerMillionUsd: v.number(),
      reasoningPerMillionUsd: v.number(),
      modalitiesInput: v.optional(v.array(v.string())),
      modalitiesOutput: v.optional(v.array(v.string())),
      sourceUpdatedAt: v.string(),
      syncedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => await getManagedModelPriceRow(ctx, args.model),
});

export const upsertManagedModelPrices = internalMutation({
  args: {
    prices: v.array(
      v.object({
        model: v.string(),
        source: v.string(),
        sourceProvider: v.string(),
        sourceModelId: v.string(),
        inputPerMillionUsd: v.number(),
        outputPerMillionUsd: v.number(),
        cacheReadPerMillionUsd: v.number(),
        cacheWritePerMillionUsd: v.number(),
        reasoningPerMillionUsd: v.number(),
        modalitiesInput: v.array(v.string()),
        modalitiesOutput: v.array(v.string()),
        sourceUpdatedAt: v.string(),
        syncedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existingRows = await Promise.all(
      args.prices.map((price) =>
        ctx.db
          .query("billing_model_prices")
          .withIndex("by_model", (q) => q.eq("model", price.model))
          .unique(),
      ),
    );

    for (const [index, price] of args.prices.entries()) {
      const existing = existingRows[index];
      if (existing) {
        await ctx.db.patch(existing._id, price);
        continue;
      }

      await ctx.db.insert("billing_model_prices", price);
    }

    return {
      upserted: args.prices.length,
    };
  },
});

export const syncManagedModelPricesFromModelsDev = internalAction({
  args: {},
  returns: v.object({
    syncedAt: v.number(),
    upserted: v.number(),
    source: v.string(),
  }),
  handler: async (
    ctx,
  ): Promise<{ syncedAt: number; upserted: number; source: string }> => {
    const response = await fetch(MODELS_DEV_API_URL, { method: "GET" });
    if (!response.ok) {
      throw new ConvexError({
        code: "MODEL_PRICE_SYNC_FAILED",
        message: `models.dev sync failed with status ${response.status}`,
      });
    }

    const data = (await response.json()) as ModelsDevApi;
    const syncedAt = Date.now();
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data,
      modelIds: listManagedModelIds(),
      syncedAt,
    });

    // Persist every resolved row before surfacing an incomplete catalog. A
    // newly added model should not prevent unrelated current prices from
    // refreshing for another 24-hour cron cycle.
    const upserted: { upserted: number } =
      entries.length > 0
        ? await ctx.runMutation(internal.billing.upsertManagedModelPrices, {
            prices: entries as ManagedModelPriceEntry[] as never,
          })
        : { upserted: 0 };

    if (missingModels.length > 0) {
      throw new ConvexError({
        code: "MODEL_PRICE_SYNC_INCOMPLETE",
        message: `models.dev is missing prices for: ${missingModels.join(", ")}`,
      });
    }

    return {
      syncedAt,
      upserted: upserted.upserted,
      source: MODELS_DEV_API_URL,
    };
  },
});

/**
 * Public subscription/usage snapshot.
 *
 * `now` is optional. When omitted (e.g. callers that only need the plan
 * label), the query returns the usage figures **as stored** on the
 * `billing_usage_windows` row without recomputing window expiration. When
 * supplied, callers MUST bucket the value (e.g. floor to a minute) so
 * `useQuery` subscribers don't invalidate on every render — see
 * `packages/website/src/app/billing/billing-client.tsx` for the
 * canonical pattern
 * (60-second `setInterval`).
 */
export const getSubscriptionStatus = query({
  args: {
    now: v.optional(v.number()),
  },
  returns: subscriptionStatusReturnValidator,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const planCatalog = getPlanCatalog();

    const plans = {
      free: planCatalog.free,
      go: planCatalog.go,
      pro: planCatalog.pro,
    };

    if (!identity || isAnonymousIdentity(identity)) {
      return {
        authenticated: Boolean(identity),
        isAnonymous: true,
        plan: "free" as SubscriptionPlan,
        subscriptionStatus: "none",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        usage: null,
        usagePolicy: {
          kind: "anonymous_requests" as const,
          requestLimit: getMaxAnonRequests(),
          perIpRequestLimit: getMaxAnonRequestsPerIp(),
          resetAfterInactivityDays: ANON_DEVICE_USAGE_RETENTION_DAYS,
        },
        plans,
      };
    }

    const ownerId = identity.tokenIdentifier;
    const [profile, usage] = await Promise.all([
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    ]);

    // Use the stored `updatedAt` as a deterministic fallback when the caller
    // doesn't pass `now`. This keeps the query reactive on data changes
    // while avoiding per-render `Date.now()` cache invalidation.
    const fallbackNow = args.now ?? usage?.updatedAt ?? profile?.updatedAt ?? 0;
    const normalizedProfile =
      profile ?? createDefaultProfile(ownerId, fallbackNow);
    const normalizedUsage = usage ?? createDefaultUsage(ownerId, fallbackNow);
    const plan = normalizedProfile.activePlan as SubscriptionPlan;
    const planConfig = getPlanConfig(plan);

    const usageSection =
      args.now !== undefined
        ? (() => {
            const snapshot = buildUsageSnapshot({
              profile: normalizedProfile,
              usage: normalizedUsage,
              plan,
              now: args.now!,
            });
            return {
              rollingUsedUsd: toCurrencyAmount(snapshot.rolling.used),
              rollingLimitUsd: toCurrencyAmount(snapshot.rolling.limit),
              weeklyUsedUsd: toCurrencyAmount(snapshot.weekly.used),
              weeklyLimitUsd: toCurrencyAmount(snapshot.weekly.limit),
              monthlyUsedUsd: toCurrencyAmount(snapshot.monthly.used),
              monthlyLimitUsd: toCurrencyAmount(snapshot.monthly.limit),
              lifetimeUsedUsd: toCurrencyAmount(
                normalizedUsage.totalUsageMicroCents,
              ),
              lifetimeLimitUsd: snapshot.lifetime
                ? toCurrencyAmount(snapshot.lifetime.limit)
                : null,
            };
          })()
        : {
            rollingUsedUsd: toCurrencyAmount(
              normalizedUsage.rollingUsageMicroCents,
            ),
            rollingLimitUsd: toCurrencyAmount(
              dollarsToMicroCents(planConfig.rollingLimitUsd),
            ),
            weeklyUsedUsd: toCurrencyAmount(
              normalizedUsage.weeklyUsageMicroCents,
            ),
            weeklyLimitUsd: toCurrencyAmount(
              dollarsToMicroCents(planConfig.weeklyLimitUsd),
            ),
            monthlyUsedUsd: toCurrencyAmount(
              normalizedUsage.monthlyUsageMicroCents,
            ),
            monthlyLimitUsd: toCurrencyAmount(
              dollarsToMicroCents(planConfig.monthlyLimitUsd),
            ),
            lifetimeUsedUsd: toCurrencyAmount(
              normalizedUsage.totalUsageMicroCents,
            ),
            lifetimeLimitUsd:
              planConfig.lifetimeLimitUsd === undefined
                ? null
                : toCurrencyAmount(
                    dollarsToMicroCents(planConfig.lifetimeLimitUsd),
                  ),
          };

    return {
      authenticated: true,
      isAnonymous: isAnonymousIdentity(identity),
      plan,
      subscriptionStatus: normalizedProfile.subscriptionStatus,
      cancelAtPeriodEnd: normalizedProfile.cancelAtPeriodEnd,
      currentPeriodEnd:
        normalizedProfile.currentPeriodEnd > 0
          ? normalizedProfile.currentPeriodEnd
          : null,
      usage: usageSection,
      usagePolicy: { kind: "managed_cost" as const },
      plans,
    };
  },
});

export const reserveStripeOperationInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    kind: stripeOperationKindValidator,
    stripeCustomerId: v.optional(v.string()),
    requestKey: v.string(),
    requestFingerprint: v.string(),
    now: v.number(),
  },
  returns: v.object({
    operationId: v.string(),
    ownerGeneration: v.string(),
    idempotencyKey: v.string(),
    stripeCustomerCreateIdempotencyKey: v.string(),
    state: v.union(
      v.literal("reserved"),
      v.literal("provider_succeeded"),
      v.literal("completed"),
    ),
    dispatchState: v.union(v.literal("idle"), v.literal("may_have_dispatched")),
    activeStep: v.union(
      v.literal("customer_create"),
      v.literal("checkout_create"),
      v.literal("portal_create"),
      v.null(),
    ),
    stripeCustomerId: v.union(v.string(), v.null()),
    stripeCheckoutSessionId: v.union(v.string(), v.null()),
    stripePortalSessionId: v.union(v.string(), v.null()),
    blockedReason: v.union(
      v.literal("legacy_dispatch_active"),
      v.literal("legacy_missing_receipt"),
      v.null(),
    ),
  }),
  handler: async (ctx, args) => {
    const ownerId = args.ownerId.trim();
    const { generation } = await assertOwnerMigrationWriteAllowed(
      ctx,
      ownerId,
      args.ownerGeneration,
    );
    const requestFingerprint = args.requestFingerprint.trim();
    const requestKey = args.requestKey.trim();
    if (
      !/^[a-f0-9]{64}$/.test(requestKey) ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint)
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Stripe request identity is invalid.",
      });
    }
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (!profile) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Billing profile is missing for this Stripe request.",
      });
    }
    const customerAuthorityEpoch = profile.stripeCustomerAuthorityEpoch ?? 0;
    const canonicalCustomerCreateIdempotencyKey =
      await resolvePinnedStripeCustomerAuthorityKey(ctx, {
        profile,
        ownerId,
        authorityEpoch: customerAuthorityEpoch,
        now: args.now,
      });
    const requestedCustomerId = args.stripeCustomerId?.trim() ?? "";
    if (
      requestedCustomerId &&
      (profile.stripeCustomerId !== requestedCustomerId ||
        profile.stripeCustomerTerminal === true)
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Stripe customer authority is missing or has rotated.",
      });
    }
    if (requestedCustomerId) {
      const locatorHash = await hashStripeBillingLocator(
        "customer",
        requestedCustomerId,
      );
      const tombstone = await ctx.db
        .query("billing_stripe_deletion_tombstones")
        .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
        .unique();
      if (tombstone) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "The Stripe customer for this request was deleted.",
        });
      }
    }
    const requestRows = await ctx.db
      .query("billing_stripe_operations")
      .withIndex("by_ownerId_and_kind_and_requestKey", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("kind", args.kind)
          .eq("requestKey", requestKey),
      )
      .order("desc")
      .take(2);
    if (requestRows.length > 1) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Duplicate Stripe request receipts require reconciliation.",
      });
    }
    if (
      requestRows[0] &&
      requestRows[0].requestFingerprint !== requestFingerprint
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Billing request ID was already used with different details.",
      });
    }
    const legacyRows = requestRows[0]
      ? []
      : await ctx.db
          .query("billing_stripe_operations")
          .withIndex("by_ownerId_and_kind_and_requestFingerprint", (q) =>
            q
              .eq("ownerId", ownerId)
              .eq("kind", args.kind)
              .eq("requestFingerprint", requestFingerprint),
          )
          .order("desc")
          .take(2);
    if (legacyRows.length > 1) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Duplicate Stripe request receipts require reconciliation.",
      });
    }
    const existing = requestRows[0] ?? legacyRows[0];
    if (existing) {
      // Reset and destination-owner migration preserve operation receipts.
      // Adopting the exact logical request also preserves every Stripe
      // idempotency key, so a post-fence retry cannot create a second remote
      // customer/session. A marked physical step is never adopted or replayed
      // here; lifecycle quiescence owns its exact frozen-request recovery.
      if (
        existing.state === "reserved" &&
        existing.dispatchState === undefined
      ) {
        if (existing.leaseExpiresAt <= args.now) {
          await ctx.db.patch(existing._id, {
            manualDebtReason: "legacy_missing_receipt",
            updatedAt: args.now,
          });
        }
        return {
          operationId: existing.operationId,
          ownerGeneration: existing.ownerGeneration,
          idempotencyKey: existing.idempotencyKey,
          stripeCustomerCreateIdempotencyKey:
            existing.stripeCustomerCreateIdempotencyKey,
          state: existing.state,
          dispatchState: "idle" as const,
          activeStep: null,
          stripeCustomerId: existing.stripeCustomerId ?? null,
          stripeCheckoutSessionId: existing.stripeCheckoutSessionId ?? null,
          stripePortalSessionId: existing.stripePortalSessionId ?? null,
          blockedReason:
            existing.leaseExpiresAt <= args.now
              ? ("legacy_missing_receipt" as const)
              : ("legacy_dispatch_active" as const),
        };
      }
      if (
        existing.ownerGeneration !== generation &&
        existing.dispatchState === "may_have_dispatched"
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Stripe request reconciliation is still in progress.",
        });
      }
      if (
        (existing.stripeCustomerAuthorityEpoch ?? 0) !== customerAuthorityEpoch
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message:
            "This billing request belongs to a deleted Stripe customer authority. Start a new request.",
        });
      }
      const historicalResultShape = stripeHistoricalResultShape(existing);
      if (historicalResultShape === "malformed") {
        throw new ConvexError({
          code: "CONFLICT",
          message:
            "Stripe physical receipt history is malformed and requires reconciliation.",
        });
      }
      if (historicalResultShape === "complete") {
        const tupleHash = await hashStripeDeletedOperationTuple({
          operationId: existing.operationId,
          attemptId: existing.lastStripeAttemptId!,
          step: existing.lastStripeStep!,
          requestFingerprint: existing.lastStripeRequestFingerprint!,
          idempotencyKey: existing.lastStripeIdempotencyKey!,
          providerDeadlineAt: existing.lastStripeProviderDeadlineAt!,
        });
        const physicalReceipts = await ctx.db
          .query("billing_stripe_physical_receipts")
          .withIndex("by_tupleHash", (q) => q.eq("tupleHash", tupleHash))
          .take(2);
        if (
          physicalReceipts.length > 1 ||
          (physicalReceipts[0] &&
            physicalReceipts[0].operationId !== existing.operationId)
        ) {
          throw new ConvexError({
            code: "CONFLICT",
            message:
              "Stripe physical receipt history is duplicated and requires reconciliation.",
          });
        }
        if (!physicalReceipts[0]) {
          if (
            hasCurrentStripeOperationIntegrity(existing) ||
            !hasLegacyStripeOperationIntegrityVersion(existing) ||
            !hasValidStripeOperationStateLocators(existing) ||
            !hasCleanLegacyStripeOperationTransport(existing)
          ) {
            throw new ConvexError({
              code: "CONFLICT",
              message:
                "Stripe physical receipt authority is missing and requires reconciliation.",
            });
          }
          if (
            !(await hasStripePhysicalReceiptCapacityForInsert(
              ctx,
              existing.operationId,
            ))
          ) {
            throw new ConvexError({
              code: "CONFLICT",
              message:
                "Stripe physical receipt capacity requires lifecycle repair.",
            });
          }
          await ctx.db.insert("billing_stripe_physical_receipts", {
            operationId: existing.operationId,
            tupleHash,
            createdAt: args.now,
          });
        }
      }
      if (
        !(await ensureLegacyStripeOperationPhysicalReceiptProvenance(
          ctx,
          existing,
        ))
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message:
            "Stripe physical receipt provenance is incomplete and requires reconciliation.",
        });
      }
      if (
        hasCurrentStripeOperationIntegrity(existing) &&
        !hasCleanIdleStripeOperationTransport(existing)
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message:
            "Stripe operation transport requires lifecycle reconciliation before replay.",
        });
      }
      if (
        existing.terminalizedByManualResolutionId !== undefined &&
        !(await hasMatchingStripeManualResolutionProof(ctx, existing))
      ) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "Stripe manual-resolution authority is missing or changed.",
        });
      }
      if (!hasCurrentStripeOperationIntegrity(existing)) {
        if (
          !hasLegacyStripeOperationIntegrityVersion(existing) ||
          !hasValidStripeOperationStateLocators(existing) ||
          !hasCleanLegacyStripeOperationTransport(existing)
        ) {
          throw new ConvexError({
            code: "CONFLICT",
            message:
              "Stripe operation integrity requires lifecycle reconciliation before replay.",
          });
        }
        await ctx.db.patch(existing._id, {
          dispatchState: "idle",
          integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
          lifecycleIntegrityVersion: undefined,
          updatedAt: args.now,
        });
      }
      if (existing.stripeCustomerId) {
        const locatorHash = await hashStripeBillingLocator(
          "customer",
          existing.stripeCustomerId,
        );
        const tombstone = await ctx.db
          .query("billing_stripe_deletion_tombstones")
          .withIndex("by_locatorHash", (q) => q.eq("locatorHash", locatorHash))
          .unique();
        if (tombstone) {
          throw new ConvexError({
            code: "CONFLICT",
            message:
              "This billing request references a deleted Stripe customer.",
          });
        }
      }
      const canAdoptCanonicalCustomerKey =
        (existing.dispatchState === "idle" ||
          (hasLegacyStripeOperationIntegrityVersion(existing) &&
            existing.dispatchState === undefined)) &&
        existing.activeStep === undefined &&
        existing.activeAttemptId === undefined &&
        existing.activeRequestJson === undefined &&
        existing.activeRequestFingerprint === undefined &&
        existing.activeIdempotencyKey === undefined &&
        existing.providerDeadlineAt === undefined &&
        existing.quiescentAfterAt === undefined &&
        existing.reconcileClaimId === undefined &&
        existing.reconcileClaimExpiresAt === undefined;
      if (existing.ownerGeneration !== generation) {
        if (
          !(await moveStripeOperationResolutionProofs(ctx, existing, {
            fromOwnerId: existing.ownerId,
            fromOwnerGeneration: existing.ownerGeneration,
            toOwnerId: existing.ownerId,
            toOwnerGeneration: generation,
          }))
        ) {
          throw new ConvexError({
            code: "CONFLICT",
            message:
              "Stripe resolution authority changed during reset adoption.",
          });
        }
      }
      await ctx.db.patch(existing._id, {
        ownerGeneration: generation,
        requestKey,
        ...(canAdoptCanonicalCustomerKey
          ? {
              stripeCustomerCreateIdempotencyKey:
                canonicalCustomerCreateIdempotencyKey,
            }
          : {}),
        leaseExpiresAt: args.now + STRIPE_OPERATION_LEASE_MS,
        lifecycleIntegrityVersion: undefined,
        updatedAt: args.now,
      });
      return {
        operationId: existing.operationId,
        ownerGeneration: generation,
        idempotencyKey: existing.idempotencyKey,
        stripeCustomerCreateIdempotencyKey: canAdoptCanonicalCustomerKey
          ? canonicalCustomerCreateIdempotencyKey
          : existing.stripeCustomerCreateIdempotencyKey,
        state: existing.state,
        dispatchState: existing.dispatchState ?? "idle",
        activeStep: existing.activeStep ?? null,
        stripeCustomerId: existing.stripeCustomerId ?? null,
        stripeCheckoutSessionId: existing.stripeCheckoutSessionId ?? null,
        stripePortalSessionId: existing.stripePortalSessionId ?? null,
        blockedReason: null,
      };
    }
    const operationId = crypto.randomUUID();
    const idempotencyKey = `stella-billing-operation-v1-${operationId}`;
    const stripeCustomerCreateIdempotencyKey =
      canonicalCustomerCreateIdempotencyKey;
    await ctx.db.insert("billing_stripe_operations", {
      ownerId,
      ownerGeneration: generation,
      operationId,
      kind: args.kind,
      state: "reserved",
      dispatchState: "idle",
      idempotencyKey,
      stripeCustomerCreateIdempotencyKey,
      stripeCustomerAuthorityEpoch: customerAuthorityEpoch,
      integrityVersion: STRIPE_RECEIPT_INTEGRITY_VERSION,
      requestKey,
      requestFingerprint,
      ...(requestedCustomerId
        ? {
            stripeCustomerId: requestedCustomerId,
            stripeCustomerMetadataOwnerId: ownerId,
          }
        : {}),
      leaseExpiresAt: args.now + STRIPE_OPERATION_LEASE_MS,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return {
      operationId,
      ownerGeneration: generation,
      idempotencyKey,
      stripeCustomerCreateIdempotencyKey,
      state: "reserved" as const,
      dispatchState: "idle" as const,
      activeStep: null,
      stripeCustomerId: args.stripeCustomerId?.trim() || null,
      stripeCheckoutSessionId: null,
      stripePortalSessionId: null,
      blockedReason: null,
    };
  },
});

export const createCheckoutSession = action({
  args: {
    plan: paidPlanValidator,
    returnUrl: v.string(),
    // Optional caller context. The mobile app sends source "ios" plus the
    // StoreKit storefront country so the server can enforce the U.S.-only
    // in-app purchase policy. Desktop/web omit both and are unaffected.
    source: v.optional(v.string()),
    appStoreCountry: v.optional(v.string()),
    requestId: v.string(),
  },
  returns: v.object({
    url: v.string(),
    sessionId: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; sessionId: string }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    if (isAnonymousIdentity(identity)) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Please sign in with an account before subscribing.",
      });
    }

    const ownerId = identity.tokenIdentifier;
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    // iOS in-app purchase is offered only where the App Store storefront is
    // the United States. The client gates its UI on StoreKit's storefront and
    // attests it here; this is the server-side backstop that fails closed for
    // any non-US or unknown storefront. Desktop/web callers omit `source`.
    const checkoutSource = args.source?.trim().toLowerCase() || "web";
    if (checkoutSource === "ios") {
      const appStoreCountry = args.appStoreCountry?.trim().toUpperCase();
      if (appStoreCountry !== "USA") {
        console.warn("[billing] iOS checkout blocked off US storefront", {
          appStoreCountry: appStoreCountry || "unknown",
        });
        throw new ConvexError({
          code: "FORBIDDEN",
          message:
            "In-app subscriptions aren't available in your App Store region.",
        });
      }
    }
    // Each call hits the live Stripe API (customer.create / checkout.create);
    // tight cap protects both Stripe rate limits and our cost.
    await enforceActionRateLimit(
      ctx,
      "billing_create_checkout_session",
      ownerId,
      RATE_EXPENSIVE,
      "Too many checkout requests. Please wait a moment and try again.",
    );
    const normalizedReturnUrl = normalizeReturnUrl(args.returnUrl);
    const successUrl = appendCheckoutStatus(normalizedReturnUrl, "success");
    const cancelUrl = appendCheckoutStatus(normalizedReturnUrl, "cancel");
    const requestIdentity = await stripeOperationRequestIdentity(
      "subscription_checkout",
      args.requestId,
      [args.plan, checkoutSource, normalizedReturnUrl],
    );
    const stripe = getStripeClient();

    const billing: {
      ownerId: string;
      activePlan: string;
      subscriptionStatus: string;
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripePriceId: string;
      currentPeriodEnd: number;
      usageUpdatedAt: number;
    } = await ctx.runMutation(internal.billing.ensureBillingRecords, {
      ownerId,
      ownerGeneration,
    });

    if (
      billing.activePlan !== "free" &&
      ACTIVE_SUBSCRIPTION_STATUSES.has(billing.subscriptionStatus)
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message:
          "You already have an active subscription. Use billing management to change plans.",
      });
    }

    const operation: {
      operationId: string;
      ownerGeneration: string;
      idempotencyKey: string;
      stripeCustomerCreateIdempotencyKey: string;
      state: "reserved" | "provider_succeeded" | "completed";
      dispatchState: "idle" | "may_have_dispatched";
      activeStep:
        | "customer_create"
        | "checkout_create"
        | "portal_create"
        | null;
      stripeCustomerId: string | null;
      stripeCheckoutSessionId: string | null;
      stripePortalSessionId: string | null;
      blockedReason: "legacy_dispatch_active" | "legacy_missing_receipt" | null;
    } = await ctx.runMutation(internal.billing.reserveStripeOperationInternal, {
      ownerId,
      ownerGeneration,
      kind: "subscription_checkout",
      stripeCustomerId: billing.stripeCustomerId || undefined,
      ...requestIdentity,
      now: Date.now(),
    });

    if (operation.blockedReason) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "This legacy Stripe request requires reconciliation.",
      });
    }

    if (operation.dispatchState === "may_have_dispatched") {
      throw new ConvexError({
        code: "CONFLICT",
        message: "This Stripe request is still being reconciled.",
      });
    }

    if (operation.state !== "reserved" && operation.stripeCheckoutSessionId) {
      const existingSession = await stripe.checkout.sessions.retrieve(
        operation.stripeCheckoutSessionId,
      );
      assertStripeCheckoutSessionProviderBinding(existingSession, {
        operationId: operation.operationId,
        stripeCustomerId: operation.stripeCustomerId!,
        expectedSessionId: operation.stripeCheckoutSessionId,
      });
      if (!existingSession.url) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "This checkout request has already finished.",
        });
      }
      if (operation.state !== "completed") {
        const completed = await ctx.runMutation(completeStripeOperationRef, {
          ownerId,
          ownerGeneration: operation.ownerGeneration,
          operationId: operation.operationId,
          now: Date.now(),
        });
        if (!completed) {
          throw new ConvexError({
            code: "CONFLICT",
            message: "Stripe checkout completion authority changed.",
          });
        }
      }
      await assertStripeOperationResultReturn(ctx, {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        stripeCustomerId: operation.stripeCustomerId!,
        stripeCheckoutSessionId: existingSession.id,
      });
      return {
        url: existingSession.url,
        sessionId: existingSession.id,
      };
    }

    let stripeCustomerId =
      billing.stripeCustomerId || operation.stripeCustomerId || "";

    if (!stripeCustomerId) {
      const customerParams = {
        // The customer idempotency key is intentionally shared by every
        // logical checkout in one owner generation. Its request bytes must be
        // shared too, or concurrent requestIds produce a Stripe idempotency
        // mismatch instead of converging on one customer.
        metadata: {
          ownerId,
          stellaCustomerAuthorityId:
            operation.stripeCustomerCreateIdempotencyKey,
        },
      } satisfies Stripe.CustomerCreateParams;
      const customerDispatch = await markStripeStep(ctx, {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        step: "customer_create",
        requestJson: JSON.stringify(customerParams),
      });
      let customer: Stripe.Customer;
      try {
        customer = await withInitialStripeProviderAuthority(
          ctx,
          customerDispatch,
          async (provider) =>
            await provider.customers.create(customerParams, {
              idempotencyKey: customerDispatch.idempotencyKey,
            }),
        );
      } catch (error) {
        await settleDefinitiveStripeNoCreate(ctx, customerDispatch, error);
        throw error;
      }
      stripeCustomerId = customer.id;
      const customerSettlement = await ctx.runMutation(
        settleStripeOperationDispatchRef,
        {
          ...customerDispatch,
          stripeCustomerId,
          now: Date.now(),
        },
      );
      if (customerSettlement.customerDeleted) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "The Stripe customer was deleted during checkout setup.",
        });
      }
    } else if (!billing.stripeCustomerId) {
      // A receipt-authorized late/reconciled customer capture intentionally
      // does not recreate billing profile state after a reset fence. Once the
      // owner is open again, adopt that exact locator before creating Checkout.
      const adoption = await ctx.runMutation(adoptStripeOperationCustomerRef, {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        stripeCustomerId,
        now: Date.now(),
      });
      if (!adoption.adopted) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "The captured Stripe customer is no longer active.",
        });
      }
    }

    // Stripe-hosted Checkout: returns a `url` we open in the user's
    // system browser. This avoids the awkward in-app embedding we
    // experimented with — Stripe owns the entire payment surface, the
    // user comes back to `/billing` once Stripe redirects to the
    // success/cancel URL, and Stella's webhook updates the local plan.
    //
    // `managed_payments` is a preview feature that lets Stripe handle
    // payment-method orchestration (saved methods, dynamic ordering,
    // etc.) without us having to enumerate `payment_method_types`.
    // The Stripe SDK's typings don't include it yet, hence the cast.
    const goFirstMonthCoupon =
      args.plan === "go" ? getStripeGoFirstMonthCouponId() : undefined;

    const sessionParams = {
      mode: "subscription",
      ui_mode: "hosted_page",
      customer: stripeCustomerId,
      line_items: [
        {
          price: getStripePriceIdForPlan(args.plan),
          quantity: 1,
        },
      ],
      ...(goFirstMonthCoupon
        ? { discounts: [{ coupon: goFirstMonthCoupon }] }
        : {}),
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      managed_payments: { enabled: true },
      // Persist whatever Checkout collects back onto the Stripe Customer
      // so subsequent subscription renewals — which run without an
      // interactive Checkout — still have the address Managed Payments
      // needs for correct tax determination.
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
      metadata: {
        ownerId,
        plan: args.plan,
        source: checkoutSource,
        stellaOperationId: operation.operationId,
      },
      subscription_data: {
        metadata: {
          ownerId,
          plan: args.plan,
          source: checkoutSource,
          stellaOperationId: operation.operationId,
        },
      },
    } as Stripe.Checkout.SessionCreateParams;

    const checkoutDispatch = await markStripeStep(ctx, {
      ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      step: "checkout_create",
      requestJson: JSON.stringify(sessionParams),
    });
    let checkoutSession: Stripe.Checkout.Session;
    try {
      checkoutSession = await withInitialStripeProviderAuthority(
        ctx,
        checkoutDispatch,
        async (provider) =>
          await provider.checkout.sessions.create(sessionParams, {
            idempotencyKey: checkoutDispatch.idempotencyKey,
          }),
      );
    } catch (error) {
      await settleDefinitiveStripeNoCreate(ctx, checkoutDispatch, error);
      throw error;
    }
    const checkoutSettlement = await ctx.runMutation(
      settleStripeOperationDispatchRef,
      {
        ...checkoutDispatch,
        stripeCustomerId,
        stripeCheckoutSessionId: checkoutSession.id,
        now: Date.now(),
      },
    );
    if (checkoutSettlement.customerDeleted) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "The Stripe customer was deleted during checkout setup.",
      });
    }
    assertStripeCheckoutSessionProviderBinding(checkoutSession, {
      operationId: operation.operationId,
      stripeCustomerId,
    });

    if (!checkoutSession.url) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Stripe did not return a checkout URL.",
      });
    }

    const completed: boolean = await ctx.runMutation(
      completeStripeOperationRef,
      {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        now: Date.now(),
      },
    );
    if (!completed)
      throw new Error("Stripe checkout completion was superseded.");

    await assertStripeOperationResultReturn(ctx, {
      ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      stripeCustomerId,
      stripeCheckoutSessionId: checkoutSession.id,
    });

    return {
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    };
  },
});

export const getUsageCreditPurchaseOptions = query({
  args: {},
  returns: v.object({
    currency: v.string(),
    minAmountCents: v.number(),
    maxAmountCents: v.number(),
    presetAmountCents: v.array(v.number()),
  }),
  handler: async () => ({
    currency: USAGE_CREDIT_CURRENCY,
    minAmountCents: USAGE_CREDIT_MIN_PURCHASE_CENTS,
    maxAmountCents: USAGE_CREDIT_MAX_PURCHASE_CENTS,
    presetAmountCents: [...USAGE_CREDIT_PRESET_AMOUNTS_CENTS],
  }),
});

export const getUsageCreditStatus = query({
  args: {},
  returns: v.object({
    authenticated: v.boolean(),
    currency: v.string(),
    balanceUsd: v.number(),
    totalPurchasedUsd: v.number(),
    totalConsumedUsd: v.number(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || isAnonymousIdentity(identity)) {
      return {
        authenticated: false,
        currency: USAGE_CREDIT_CURRENCY,
        balanceUsd: 0,
        totalPurchasedUsd: 0,
        totalConsumedUsd: 0,
      };
    }

    const credit = await ctx.db
      .query("billing_usage_credits")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", identity.tokenIdentifier))
      .unique();

    return {
      authenticated: true,
      currency: credit?.currency ?? USAGE_CREDIT_CURRENCY,
      balanceUsd: toCurrencyAmount(
        getUsageCreditBalanceMicroCents(credit ?? null),
      ),
      totalPurchasedUsd: toCurrencyAmount(
        credit?.totalPurchasedMicroCents ?? 0,
      ),
      totalConsumedUsd: toCurrencyAmount(credit?.totalConsumedMicroCents ?? 0),
    };
  },
});

export const createUsageCreditCheckoutSession = action({
  args: {
    amountCents: v.number(),
    returnUrl: v.string(),
    requestId: v.string(),
  },
  returns: v.object({
    url: v.string(),
    sessionId: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; sessionId: string }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    if (isAnonymousIdentity(identity)) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Please sign in with an account before buying usage credit.",
      });
    }

    const ownerId = identity.tokenIdentifier;
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    await enforceActionRateLimit(
      ctx,
      "billing_create_usage_credit_checkout_session",
      ownerId,
      RATE_EXPENSIVE,
      "Too many checkout requests. Please wait a moment and try again.",
    );

    const amountCents = normalizeUsageCreditPurchaseAmountCents(
      args.amountCents,
    );
    const normalizedReturnUrl = normalizeReturnUrl(args.returnUrl);
    const successUrl = appendCheckoutStatus(normalizedReturnUrl, "success");
    const cancelUrl = appendCheckoutStatus(normalizedReturnUrl, "cancel");
    const requestIdentity = await stripeOperationRequestIdentity(
      "usage_credit_checkout",
      args.requestId,
      [amountCents, normalizedReturnUrl],
    );
    const stripe = getStripeClient();
    const billing: {
      ownerId: string;
      activePlan: string;
      subscriptionStatus: string;
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripePriceId: string;
      currentPeriodEnd: number;
      usageUpdatedAt: number;
    } = await ctx.runMutation(internal.billing.ensureBillingRecords, {
      ownerId,
      ownerGeneration,
    });

    const operation: {
      operationId: string;
      ownerGeneration: string;
      idempotencyKey: string;
      stripeCustomerCreateIdempotencyKey: string;
      state: "reserved" | "provider_succeeded" | "completed";
      dispatchState: "idle" | "may_have_dispatched";
      activeStep:
        | "customer_create"
        | "checkout_create"
        | "portal_create"
        | null;
      stripeCustomerId: string | null;
      stripeCheckoutSessionId: string | null;
      stripePortalSessionId: string | null;
      blockedReason: "legacy_dispatch_active" | "legacy_missing_receipt" | null;
    } = await ctx.runMutation(internal.billing.reserveStripeOperationInternal, {
      ownerId,
      ownerGeneration,
      kind: "usage_credit_checkout",
      stripeCustomerId: billing.stripeCustomerId || undefined,
      ...requestIdentity,
      now: Date.now(),
    });

    if (operation.blockedReason) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "This legacy Stripe request requires reconciliation.",
      });
    }

    if (operation.dispatchState === "may_have_dispatched") {
      throw new ConvexError({
        code: "CONFLICT",
        message: "This Stripe request is still being reconciled.",
      });
    }

    if (operation.state !== "reserved" && operation.stripeCheckoutSessionId) {
      const existingSession = await stripe.checkout.sessions.retrieve(
        operation.stripeCheckoutSessionId,
      );
      assertStripeCheckoutSessionProviderBinding(existingSession, {
        operationId: operation.operationId,
        stripeCustomerId: operation.stripeCustomerId!,
        expectedSessionId: operation.stripeCheckoutSessionId,
      });
      if (!existingSession.url) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "This checkout request has already finished.",
        });
      }
      if (operation.state !== "completed") {
        const completed = await ctx.runMutation(completeStripeOperationRef, {
          ownerId,
          ownerGeneration: operation.ownerGeneration,
          operationId: operation.operationId,
          now: Date.now(),
        });
        if (!completed) {
          throw new ConvexError({
            code: "CONFLICT",
            message: "Stripe checkout completion authority changed.",
          });
        }
      }
      await assertStripeOperationResultReturn(ctx, {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        stripeCustomerId: operation.stripeCustomerId!,
        stripeCheckoutSessionId: existingSession.id,
      });
      return {
        url: existingSession.url,
        sessionId: existingSession.id,
      };
    }

    let stripeCustomerId =
      billing.stripeCustomerId || operation.stripeCustomerId || "";
    if (!stripeCustomerId) {
      const customerParams = {
        metadata: {
          ownerId,
          stellaCustomerAuthorityId:
            operation.stripeCustomerCreateIdempotencyKey,
        },
      } satisfies Stripe.CustomerCreateParams;
      const customerDispatch = await markStripeStep(ctx, {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        step: "customer_create",
        requestJson: JSON.stringify(customerParams),
      });
      let customer: Stripe.Customer;
      try {
        customer = await withInitialStripeProviderAuthority(
          ctx,
          customerDispatch,
          async (provider) =>
            await provider.customers.create(customerParams, {
              idempotencyKey: customerDispatch.idempotencyKey,
            }),
        );
      } catch (error) {
        await settleDefinitiveStripeNoCreate(ctx, customerDispatch, error);
        throw error;
      }
      stripeCustomerId = customer.id;
      const customerSettlement = await ctx.runMutation(
        settleStripeOperationDispatchRef,
        {
          ...customerDispatch,
          stripeCustomerId,
          now: Date.now(),
        },
      );
      if (customerSettlement.customerDeleted) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "The Stripe customer was deleted during checkout setup.",
        });
      }
    } else if (!billing.stripeCustomerId) {
      const adoption = await ctx.runMutation(adoptStripeOperationCustomerRef, {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        stripeCustomerId,
        now: Date.now(),
      });
      if (!adoption.adopted) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "The captured Stripe customer is no longer active.",
        });
      }
    }

    const metadata = {
      ownerId,
      purpose: "usage_credit",
      amountCents: String(amountCents),
      stellaOperationId: operation.operationId,
    };
    const sessionParams = {
      mode: "payment",
      ui_mode: "hosted_page",
      customer: stripeCustomerId,
      line_items: [
        {
          price_data: {
            currency: USAGE_CREDIT_CURRENCY,
            unit_amount: amountCents,
            product_data: {
              name: "Stella extra usage credit",
            },
          },
          quantity: 1,
        },
      ],
      allow_promotion_codes: false,
      success_url: successUrl,
      cancel_url: cancelUrl,
      managed_payments: { enabled: true },
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
      metadata,
      payment_intent_data: {
        metadata,
      },
    } as Stripe.Checkout.SessionCreateParams;

    const checkoutDispatch = await markStripeStep(ctx, {
      ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      step: "checkout_create",
      requestJson: JSON.stringify(sessionParams),
    });
    let checkoutSession: Stripe.Checkout.Session;
    try {
      checkoutSession = await withInitialStripeProviderAuthority(
        ctx,
        checkoutDispatch,
        async (provider) =>
          await provider.checkout.sessions.create(sessionParams, {
            idempotencyKey: checkoutDispatch.idempotencyKey,
          }),
      );
    } catch (error) {
      await settleDefinitiveStripeNoCreate(ctx, checkoutDispatch, error);
      throw error;
    }
    const checkoutSettlement = await ctx.runMutation(
      settleStripeOperationDispatchRef,
      {
        ...checkoutDispatch,
        stripeCustomerId,
        stripeCheckoutSessionId: checkoutSession.id,
        now: Date.now(),
      },
    );
    if (checkoutSettlement.customerDeleted) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "The Stripe customer was deleted during checkout setup.",
      });
    }
    assertStripeCheckoutSessionProviderBinding(checkoutSession, {
      operationId: operation.operationId,
      stripeCustomerId,
    });
    if (!checkoutSession.url) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Stripe did not return a checkout URL.",
      });
    }

    const completed: boolean = await ctx.runMutation(
      completeStripeOperationRef,
      {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        now: Date.now(),
      },
    );
    if (!completed)
      throw new Error("Stripe checkout completion was superseded.");

    await assertStripeOperationResultReturn(ctx, {
      ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      stripeCustomerId,
      stripeCheckoutSessionId: checkoutSession.id,
    });

    return {
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    };
  },
});

export const createBillingPortalSession = action({
  args: {
    returnUrl: v.string(),
    requestId: v.string(),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    if (isAnonymousIdentity(identity)) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Please sign in with an account before opening billing.",
      });
    }

    const ownerId = identity.tokenIdentifier;
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    await enforceActionRateLimit(
      ctx,
      "billing_create_portal_session",
      ownerId,
      RATE_EXPENSIVE,
      "Too many billing portal requests. Please wait a moment and try again.",
    );
    const billing: {
      ownerId: string;
      activePlan: string;
      subscriptionStatus: string;
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripePriceId: string;
      currentPeriodEnd: number;
      usageUpdatedAt: number;
    } = await ctx.runMutation(internal.billing.ensureBillingRecords, {
      ownerId,
      ownerGeneration,
    });

    if (!billing.stripeCustomerId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "No billing customer is linked to this account yet.",
      });
    }

    const normalizedReturnUrl = normalizeReturnUrl(args.returnUrl);
    const requestIdentity = await stripeOperationRequestIdentity(
      "billing_portal",
      args.requestId,
      [normalizedReturnUrl],
    );
    const operation: {
      operationId: string;
      ownerGeneration: string;
      idempotencyKey: string;
      stripeCustomerCreateIdempotencyKey: string;
      state: "reserved" | "provider_succeeded" | "completed";
      dispatchState: "idle" | "may_have_dispatched";
      activeStep:
        | "customer_create"
        | "checkout_create"
        | "portal_create"
        | null;
      stripeCustomerId: string | null;
      stripeCheckoutSessionId: string | null;
      stripePortalSessionId: string | null;
      blockedReason: "legacy_dispatch_active" | "legacy_missing_receipt" | null;
    } = await ctx.runMutation(internal.billing.reserveStripeOperationInternal, {
      ownerId,
      ownerGeneration,
      kind: "billing_portal",
      stripeCustomerId: billing.stripeCustomerId,
      ...requestIdentity,
      now: Date.now(),
    });
    if (operation.blockedReason) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "This legacy Stripe request requires reconciliation.",
      });
    }
    if (operation.dispatchState === "may_have_dispatched") {
      throw new ConvexError({
        code: "CONFLICT",
        message: "This Stripe request is still being reconciled.",
      });
    }
    if (operation.state !== "reserved") {
      throw new ConvexError({
        code: "CONFLICT",
        message: "This billing portal request has already been completed.",
      });
    }
    const stripe = getStripeClient();
    const sessionParams = {
      customer: billing.stripeCustomerId,
      return_url: normalizedReturnUrl,
    } satisfies Stripe.BillingPortal.SessionCreateParams;
    const portalDispatch = await markStripeStep(ctx, {
      ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      step: "portal_create",
      requestJson: JSON.stringify(sessionParams),
    });
    let session: Stripe.BillingPortal.Session;
    try {
      session = await withInitialStripeProviderAuthority(
        ctx,
        portalDispatch,
        async (provider) =>
          await provider.billingPortal.sessions.create(sessionParams, {
            idempotencyKey: portalDispatch.idempotencyKey,
          }),
      );
    } catch (error) {
      await settleDefinitiveStripeNoCreate(ctx, portalDispatch, error);
      throw error;
    }
    const portalSettlement = await ctx.runMutation(
      settleStripeOperationDispatchRef,
      {
        ...portalDispatch,
        stripeCustomerId: billing.stripeCustomerId,
        stripePortalSessionId: session.id,
        now: Date.now(),
      },
    );
    if (portalSettlement.customerDeleted) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "The Stripe customer was deleted during portal setup.",
      });
    }
    assertStripePortalSessionProviderBinding(session, billing.stripeCustomerId);
    const published: boolean = await ctx.runMutation(
      completeStripeOperationRef,
      {
        ownerId,
        ownerGeneration: operation.ownerGeneration,
        operationId: operation.operationId,
        now: Date.now(),
      },
    );
    if (!published) throw new Error("Stripe portal result was superseded.");

    await assertStripeOperationResultReturn(ctx, {
      ownerId,
      ownerGeneration: operation.ownerGeneration,
      operationId: operation.operationId,
      stripeCustomerId: billing.stripeCustomerId,
      stripePortalSessionId: session.id,
    });

    return {
      url: session.url,
    };
  },
});

export const getCurrentPlan = query({
  args: {},
  returns: planValidator,
  handler: async (ctx) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) {
      return "free";
    }
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    return (profile?.activePlan as SubscriptionPlan | undefined) ?? "free";
  },
});
