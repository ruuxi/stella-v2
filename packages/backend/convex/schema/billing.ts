import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  MANAGED_USAGE_BILLING_KIND,
  PARALLEL_SEARCH_FAST_BILLING_KIND,
  PARALLEL_SEARCH_FAST_COST_MICRO_CENTS,
} from "../lib/managed_dispatch";

export const subscriptionPlanValidator = v.union(
  v.literal("free"),
  v.literal("go"),
  v.literal("pro"),
);

export const billingUsageModeValidator = v.union(
  v.literal("default"),
  v.literal("unlimited"),
);

export const ttsProviderDispatchKindValidator = v.union(
  v.literal("buffered"),
  v.literal("desktop_stream"),
  v.literal("hls"),
  v.literal("oneshot_inworld"),
  v.literal("oneshot_openai"),
);

export const ttsProviderDispatchStateValidator = v.union(
  v.literal("reserved"),
  v.literal("may_have_dispatched"),
);

export const ttsProviderDispatchOutcomeValidator = v.union(
  v.literal("settled"),
  v.literal("not_dispatched"),
  v.literal("may_have_dispatched"),
);

export const internalTtsUsageStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("interrupted"),
  v.literal("partial"),
);

export const voiceProviderDispatchKindValidator = v.union(
  v.literal("xai_client_secret"),
  v.literal("openai_client_secret"),
  v.literal("openai_call"),
  v.literal("inworld_ice_servers"),
  v.literal("inworld_sdp"),
);

export const voiceRealtimeAuthorityStateValidator = v.union(
  v.literal("active"),
  v.literal("cancel_requested"),
  v.literal("acknowledged"),
  v.literal("expired"),
  v.literal("released"),
);

export const voiceRealtimeUsageDispositionValidator = v.union(
  v.literal("pending"),
  v.literal("exact"),
  v.literal("unresolved"),
  v.literal("revocation_pending"),
  v.literal("conservative_fallback"),
);

export const voiceRealtimeProviderHangupStateValidator = v.union(
  v.literal("open"),
  v.literal("requested"),
  v.literal("ambiguous"),
  v.literal("confirmed"),
);

export const voiceRealtimeUsageReceiptDispositionValidator = v.union(
  v.literal("exact"),
  v.literal("conservative_fallback"),
);

export const managedProviderDispatchOutcomeValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("aborted"),
  v.literal("timed_out"),
  v.literal("outcome_unknown"),
);

export const managedDispatchCapturedUsageValidator = v.object({
  durationMs: v.number(),
  success: v.boolean(),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  cacheWriteInputTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
  costMicroCents: v.optional(v.number()),
});

export const managedDispatchBillingEnvelopeValidator = v.union(
  v.object({
    kind: v.literal(PARALLEL_SEARCH_FAST_BILLING_KIND),
    requestFingerprint: v.string(),
    chargeMicroCents: v.literal(PARALLEL_SEARCH_FAST_COST_MICRO_CENTS),
  }),
  v.object({
    kind: v.literal(MANAGED_USAGE_BILLING_KIND),
    requestFingerprint: v.string(),
    agentType: v.string(),
    model: v.string(),
    conversationId: v.optional(v.id("conversations")),
    fallbackCostMicroCents: v.number(),
  }),
);

export const managedDispatchProviderStateValidator = v.union(
  v.literal("reserved"),
  v.literal("may_have_dispatched"),
);

export const managedDispatchBillingStateValidator = v.union(
  v.literal("pending"),
  v.literal("not_chargeable"),
  v.literal("billed"),
);

export const billingSchema = {
  billing_profiles: defineTable({
    ownerId: v.string(),
    activePlan: subscriptionPlanValidator,
    usageMode: v.optional(billingUsageModeValidator),
    subscriptionStatus: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.string(),
    defaultPaymentMethodId: v.string(),
    paymentMethodBrand: v.string(),
    paymentMethodLast4: v.string(),
    currentPeriodStart: v.number(),
    currentPeriodEnd: v.number(),
    cancelAtPeriodEnd: v.boolean(),
    monthlyAnchorAt: v.number(),
    /** Legacy shared watermark retained for rows created before per-resource ordering. */
    stripeUpdatedAt: v.optional(v.number()),
    stripeCustomerUpdatedAt: v.optional(v.number()),
    stripeCustomerEventId: v.optional(v.string()),
    stripeCustomerTerminal: v.optional(v.boolean()),
    /**
     * Rotates whenever the currently linked Stripe customer is deleted. New
     * customer-create idempotency keys include this epoch, so Stripe can never
     * replay a key whose remote customer has already been tombstoned.
     */
    stripeCustomerAuthorityEpoch: v.optional(v.number()),
    /**
     * Canonical customer-create key pinned for the current authority epoch.
     * It bridges rolling deployments and owner-generation reset boundaries:
     * an already-marked older tuple wins the pin until customer deletion
     * advances the epoch and clears it.
     */
    stripeCustomerCreateIdempotencyKey: v.optional(v.string()),
    /**
     * Old operation receipts are adopted in bounded, crash-resumable epochs.
     * -1 means pre-epoch receipts; a value equal to the authority epoch means
     * every older receipt has been inspected under the current tombstones.
     */
    stripeCustomerAdoptionScanEpoch: v.optional(v.number()),
    stripePaymentMethodUpdatedAt: v.optional(v.number()),
    stripePaymentMethodEventId: v.optional(v.string()),
    stripeSubscriptionUpdatedAt: v.optional(v.number()),
    stripeSubscriptionEventId: v.optional(v.string()),
    stripeSubscriptionTerminal: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_stripeCustomerId", ["stripeCustomerId"])
    .index("by_stripeSubscriptionId", ["stripeSubscriptionId"])
    .index("by_defaultPaymentMethodId", ["defaultPaymentMethodId"]),

  billing_usage_windows: defineTable({
    ownerId: v.string(),
    /** Atomic ceiling held by every admitted but not-yet-billed attempt. */
    activeReservedMicroCents: v.optional(v.number()),
    rollingUsageMicroCents: v.number(),
    rollingWindowStartedAt: v.number(),
    weeklyUsageMicroCents: v.number(),
    weeklyWindowStartedAt: v.number(),
    monthlyUsageMicroCents: v.number(),
    monthlyWindowStartedAt: v.number(),
    /**
     * Cumulative managed-model spend that never resets. Doubles as the
     * counter the Free plan's lifetime allowance
     * (`STELLA_FREE_LIFETIME_LIMIT_USD`) is checked against.
     */
    totalUsageMicroCents: v.number(),
    /**
     * Cumulative billed requests, never reset. Measurement only — pairing it
     * with `totalUsageMicroCents` is what makes requests-per-dollar
     * answerable. Optional because rows predate the counter.
     */
    totalRequestCount: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  billing_usage_credits: defineTable({
    ownerId: v.string(),
    balanceMicroCents: v.number(),
    totalPurchasedMicroCents: v.number(),
    totalConsumedMicroCents: v.number(),
    currency: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  billing_usage_credit_purchases: defineTable({
    ownerId: v.string(),
    stripeCheckoutSessionId: v.string(),
    stripePaymentIntentId: v.string(),
    stripeCustomerId: v.string(),
    amountMicroCents: v.number(),
    currency: v.string(),
    status: v.string(),
    creditedAt: v.optional(v.number()),
    creditedAmountMicroCents: v.optional(v.number()),
    lastStripeEventCreatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_stripeCheckoutSessionId", ["stripeCheckoutSessionId"])
    .index("by_stripePaymentIntentId", ["stripePaymentIntentId"]),

  billing_model_prices: defineTable({
    model: v.string(),
    source: v.string(),
    sourceProvider: v.string(),
    sourceModelId: v.string(),
    inputPerMillionUsd: v.number(),
    outputPerMillionUsd: v.number(),
    cacheReadPerMillionUsd: v.number(),
    cacheWritePerMillionUsd: v.number(),
    reasoningPerMillionUsd: v.number(),
    /**
     * Input modalities advertised by models.dev (or its fallback). Optional
     * because pre-existing rows pre-date the modality sync; readers default
     * to ["text"] when missing so unknown models drop images at the gateway
     * boundary instead of being silently forwarded as data URLs.
     */
    modalitiesInput: v.optional(v.array(v.string())),
    /** Output modalities advertised by models.dev. Defaults to ["text"]. */
    modalitiesOutput: v.optional(v.array(v.string())),
    sourceUpdatedAt: v.string(),
    syncedAt: v.number(),
  })
    .index("by_model", ["model"])
    .index("by_syncedAt", ["syncedAt"]),

  billing_voice_usage_receipts: defineTable({
    ownerId: v.string(),
    /** Admission generation of the realtime session that produced this usage. */
    ownerGeneration: v.optional(v.string()),
    /** Immutable provider-mint attempt bound when the session was activated. */
    providerDispatchId: v.optional(v.string()),
    providerAttemptId: v.optional(v.string()),
    stellaSessionId: v.optional(v.string()),
    authorityLeaseId: v.optional(v.string()),
    authorityEpoch: v.optional(v.number()),
    requestFingerprint: v.optional(v.string()),
    disposition: v.optional(voiceRealtimeUsageReceiptDispositionValidator),
    responseId: v.string(),
    model: v.string(),
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
    costMicroCents: v.number(),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_responseId", ["ownerId", "responseId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  billing_voice_sessions: defineTable({
    ownerId: v.string(),
    /** Captured transactionally when the provider lease is admitted. */
    ownerGeneration: v.optional(v.string()),
    /** Exact provider-mint attempt whose response activated this session. */
    providerDispatchId: v.optional(v.string()),
    providerAttemptId: v.optional(v.string()),
    stellaSessionId: v.string(),
    diagnosticId: v.optional(v.string()),
    provider: v.string(),
    model: v.string(),
    voice: v.string(),
    conversationId: v.optional(v.id("conversations")),
    status: v.string(),
    clientSecretFingerprint: v.optional(v.string()),
    providerSessionId: v.optional(v.string()),
    providerExpiresAt: v.optional(v.number()),
    /** Documented provider-enforced OpenAI Realtime maximum call horizon. */
    providerHardExpiresAt: v.optional(v.number()),
    /**
     * Managed OpenAI is signaled through Stella's server-created-call API.
     * The Location call id is captured before the SDP answer can be returned,
     * and is the only billing-authoritative revocation handle.
     */
    providerCallId: v.optional(v.string()),
    providerCallCreateStartedAt: v.optional(v.number()),
    providerCallBoundAt: v.optional(v.number()),
    providerSessionConfigJson: v.optional(v.string()),
    providerHangupState: v.optional(voiceRealtimeProviderHangupStateValidator),
    /**
     * Exact in-flight Stella hangup attempt. Optional for rows created before
     * the server-owned call rollout. The short lease serializes concurrent
     * scheduled/manual retry actions and lets a later wake recover an action
     * that crashed after provider I/O but before recording its result.
     */
    providerHangupActiveAttemptId: v.optional(v.string()),
    providerHangupLeaseExpiresAt: v.optional(v.number()),
    providerHangupAttempts: v.optional(v.number()),
    providerHangupLastAttemptAt: v.optional(v.number()),
    providerHangupNextRetryAt: v.optional(v.number()),
    providerHangupConfirmedAt: v.optional(v.number()),
    providerHangupLastError: v.optional(v.string()),
    providerHangupRequestedReason: v.optional(v.string()),
    /** Exact scheduled crash reaper fence for minting/renderer authority. */
    sessionReapAt: v.optional(v.number()),
    /**
     * Short renderer authority lease. The exact id/epoch pair prevents a
     * restarted or superseded client from renewing or acknowledging a newer
     * cancellation request. These fields are optional only for pre-migration
     * rows; every newly activated managed session writes the complete tuple.
     */
    authorityLeaseId: v.optional(v.string()),
    authorityEpoch: v.optional(v.number()),
    authorityState: v.optional(voiceRealtimeAuthorityStateValidator),
    authorityExpiresAt: v.optional(v.number()),
    authorityCancelReason: v.optional(v.string()),
    authorityCancelRequestedAt: v.optional(v.number()),
    authorityAcknowledgedAt: v.optional(v.number()),
    authorityAcknowledgedEpoch: v.optional(v.number()),
    /**
     * Billing authority shares the renderer lease tuple but closes only after
     * the renderer has physically closed its provider transport and drained
     * every response.done usage POST. Optional fields preserve existing rows.
     */
    usageDisposition: v.optional(voiceRealtimeUsageDispositionValidator),
    usageDispositionAt: v.optional(v.number()),
    usageAuthorityClosedAt: v.optional(v.number()),
    usageAuthorityClosedReason: v.optional(v.string()),
    /** Pinned conservative fallback envelope for an exact managed attempt. */
    usagePricingRevision: v.optional(v.string()),
    usageBillingQuantumMs: v.optional(v.number()),
    usageFallbackRateMicroCentsPerQuantum: v.optional(v.number()),
    usageFallbackChargeCapMicroCents: v.optional(v.number()),
    usageReservationState: v.optional(
      v.union(v.literal("active"), v.literal("released")),
    ),
    usageReservedMicroCents: v.optional(v.number()),
    providerOpenedAt: v.optional(v.number()),
    providerLastProvenOpenAt: v.optional(v.number()),
    providerClosedAt: v.optional(v.number()),
    /** Untrusted renderer telemetry; never a managed-billing close proof. */
    clientTransportClosedAt: v.optional(v.number()),
    fallbackDurationMs: v.optional(v.number()),
    fallbackCostMicroCents: v.optional(v.number()),
    leaseStartedAt: v.number(),
    leaseExpiresAt: v.number(),
    heartbeatCount: v.number(),
    lastHeartbeatAt: v.optional(v.number()),
    lastUsageAt: v.optional(v.number()),
    responseCount: v.number(),
    estimatedCostMicroCents: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
    realtimeAudioSeconds: v.number(),
    sttAudioSeconds: v.number(),
    endedAt: v.optional(v.number()),
    endReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_stellaSessionId", ["stellaSessionId"])
    .index("by_ownerId_and_status_and_leaseExpiresAt", [
      "ownerId",
      "status",
      "leaseExpiresAt",
    ])
    .index("by_ownerId_and_authorityState_and_authorityExpiresAt", [
      "ownerId",
      "authorityState",
      "authorityExpiresAt",
    ])
    .index("by_ownerId_and_usageDisposition_and_authorityExpiresAt", [
      "ownerId",
      "usageDisposition",
      "authorityExpiresAt",
    ])
    .index("by_ownerId_and_usageReservationState_and_createdAt", [
      "ownerId",
      "usageReservationState",
      "createdAt",
    ])
    .index("by_ownerId_and_providerHangupState_and_createdAt", [
      "ownerId",
      "providerHangupState",
      "createdAt",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  billing_media_usage_receipts: defineTable({
    ownerId: v.string(),
    /** Admission generation of the media job that produced this receipt. */
    ownerGeneration: v.optional(v.string()),
    jobId: v.string(),
    providerRequestId: v.optional(v.string()),
    endpointId: v.string(),
    billingUnit: v.string(),
    quantity: v.number(),
    costMicroCents: v.number(),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_jobId", ["ownerId", "jobId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  billing_stripe_events: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    ownerId: v.string(),
    /** Owner data generation captured when this webhook claim was admitted. */
    ownerGeneration: v.optional(v.string()),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePaymentMethodId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    createdAt: v.number(),
    receivedAt: v.optional(v.number()),
    processingState: v.optional(
      v.union(
        v.literal("processing"),
        v.literal("processed"),
        v.literal("retry"),
      ),
    ),
    claimId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    attempts: v.optional(v.number()),
    lastError: v.optional(v.string()),
    nextRetryAt: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index("by_eventId", ["eventId"])
    .index("by_ownerId", ["ownerId"])
    .index("by_stripeCustomerId", ["stripeCustomerId"])
    .index("by_stripeSubscriptionId", ["stripeSubscriptionId"])
    .index("by_stripePaymentMethodId", ["stripePaymentMethodId"])
    .index("by_stripeCheckoutSessionId", ["stripeCheckoutSessionId"])
    .index("by_processedAt", ["processedAt"]),

  /**
   * Durable provider-before-row debt for permanent account deletion. Raw
   * Stripe locators stay here until the remote customer/subscription has a
   * terminal deletion result and every local billing row has been drained.
   * The row is then removed last.
   */
  billing_owner_deletion_debts: defineTable({
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    profileCaptured: v.boolean(),
    purchasesCaptured: v.boolean(),
    invoicesCaptured: v.boolean(),
    eventsCaptured: v.boolean(),
    operationsCaptured: v.boolean(),
    profileCursor: v.optional(v.string()),
    purchaseCursor: v.optional(v.string()),
    invoiceCursor: v.optional(v.string()),
    eventCursor: v.optional(v.string()),
    operationCursor: v.optional(v.string()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_operationId_and_generation", ["operationId", "generation"]),

  billing_owner_deletion_locators: defineTable({
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    locatorHash: v.string(),
    locatorKind: v.union(
      v.literal("customer"),
      v.literal("subscription"),
      v.literal("payment_method"),
      v.literal("checkout_session"),
    ),
    locatorValue: v.string(),
    ownerVerified: v.boolean(),
    state: v.union(v.literal("pending"), v.literal("terminal")),
    eventsDrained: v.boolean(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    providerClaimId: v.optional(v.string()),
    providerClaimExpiresAt: v.optional(v.number()),
    terminalAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_state", ["ownerId", "state"])
    .index("by_ownerId_and_state_and_kind", ["ownerId", "state", "locatorKind"])
    .index("by_ownerId_and_state_and_eventsDrained", [
      "ownerId",
      "state",
      "eventsDrained",
    ])
    .index("by_ownerId_and_locatorHash", ["ownerId", "locatorHash"])
    .index("by_locatorHash", ["locatorHash"]),

  /**
   * Pseudonymous suppression keys retained after deletion so a delayed Stripe
   * webhook cannot recreate an owner profile after the raw locators and owner
   * data have been erased. No owner id or raw Stripe id is stored here.
   */
  billing_stripe_deletion_tombstones: defineTable({
    locatorHash: v.string(),
    locatorKind: v.union(
      v.literal("customer"),
      v.literal("subscription"),
      v.literal("payment_method"),
      v.literal("checkout_session"),
    ),
    createdAt: v.number(),
  }).index("by_locatorHash", ["locatorHash"]),

  /**
   * Permanent hash-minimized authority for one exact Stripe physical tuple
   * whose owner-scoped operation row was removed by account deletion. A late
   * platform-resumed settlement can match this tuple and enqueue its raw
   * locator for provider cleanup without restoring deleted owner data.
   */
  billing_stripe_operation_tombstones: defineTable({
    operationId: v.string(),
    ownerHash: v.string(),
    createdAt: v.number(),
  }).index("by_operationId", ["operationId"]),

  /** One immutable hash-only receipt per physical Stripe tuple, written by
   * the durable mark before provider I/O and retained across owner moves and
   * deletion. Reconcile claims intentionally share the same physical hash. */
  billing_stripe_physical_receipts: defineTable({
    operationId: v.string(),
    tupleHash: v.string(),
    /** Owner metadata frozen when this tuple crossed the provider boundary. */
    providerOwnerHash: v.optional(v.string()),
    /** First successful locator envelope returned for this physical tuple. */
    successLocatorHash: v.optional(v.string()),
    /** Last terminal observation was not-created; cleared by a later success. */
    notCreatedTerminalized: v.optional(v.boolean()),
    /** Every deletable locator in that success envelope reached terminal cleanup. */
    deletionCleanupTerminalized: v.optional(v.boolean()),
    /** Hash-only operator audit when the proven resource must be retained. */
    cleanupResolutionId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_operationId", ["operationId"])
    .index("by_tupleHash", ["tupleHash"]),

  /** Hash-minimized operator audit for unrecoverable metadata-owner reads. */
  billing_stripe_metadata_transfer_resolutions: defineTable({
    operationId: v.string(),
    transferAttemptId: v.string(),
    resolutionId: v.string(),
    sourceOwnerHash: v.string(),
    destinationOwnerHash: v.string(),
    resolution: v.union(
      v.literal("provider_restored_source"),
      v.literal("provider_confirmed_deleted"),
    ),
    resolvedByHash: v.string(),
    evidenceHash: v.string(),
    resolvedAt: v.number(),
  })
    .index("by_resolutionId", ["resolutionId"])
    .index("by_operationId", ["operationId"]),

  /**
   * One durable row per non-canonical physical success. A single logical
   * operation can have several provider attempts (and therefore several late
   * results), so these cannot be represented by the operation's historical
   * single late/prior slots. Raw locators remain only while an audited
   * resolution is pending; resolution either adopts the result or publishes
   * its exact competing locators into autonomous cleanup debt.
   */
  billing_stripe_late_results: defineTable({
    ownerId: v.string(),
    /** Owner frozen by the physical action; absent only on legacy backfill. */
    providerOwnerId: v.optional(v.string()),
    operationId: v.string(),
    tupleHash: v.string(),
    locatorHash: v.string(),
    step: v.union(
      v.literal("customer_create"),
      v.literal("checkout_create"),
      v.literal("portal_create"),
    ),
    attemptId: v.string(),
    requestFingerprint: v.string(),
    idempotencyKey: v.string(),
    providerDeadlineAt: v.number(),
    reconcileClaimId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePortalSessionId: v.optional(v.string()),
    quiescentAfterAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tupleHash", ["tupleHash"])
    .index("by_operationId_and_createdAt", ["operationId", "createdAt"])
    .index("by_operationId_and_attemptId", ["operationId", "attemptId"])
    .index("by_operationId_and_locatorHash", ["operationId", "locatorHash"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  /**
   * Short-lived raw provider locators discovered after owner deletion. The
   * autonomous Stripe cleanup worker deletes each row immediately after the
   * remote resource reaches a terminal state; only the ordinary locator hash
   * tombstone survives.
   */
  billing_stripe_late_cleanup_locators: defineTable({
    tupleHash: v.string(),
    ownerHash: v.string(),
    providerOwnerHash: v.string(),
    successLocatorHash: v.string(),
    locatorHash: v.string(),
    locatorKind: v.union(v.literal("customer"), v.literal("checkout_session")),
    locatorValue: v.string(),
    /** Exact successful result envelope used to prove this raw locator before
     * provider I/O. Optional only so already-persisted rollout rows fail closed
     * instead of making a schema deployment impossible. */
    successStripeCustomerId: v.optional(v.string()),
    successStripeCheckoutSessionId: v.optional(v.string()),
    successStripePortalSessionId: v.optional(v.string()),
    /** Customer cleanup cannot run while any linked Checkout cleanup remains. */
    customerLocatorHash: v.optional(v.string()),
    /** Indexed dependency state for customer rows. Missing rollout rows remain
     * fail-closed until repaired or manually resolved. */
    checkoutBlocked: v.optional(v.boolean()),
    cleanupClaimId: v.optional(v.string()),
    cleanupClaimExpiresAt: v.optional(v.number()),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_locatorHash", ["locatorHash"])
    .index("by_tupleHash", ["tupleHash"])
    .index("by_tupleHash_and_locatorHash", ["tupleHash", "locatorHash"])
    .index("by_ownerHash_and_locatorHash", ["ownerHash", "locatorHash"])
    .index("by_customerLocatorHash", ["customerLocatorHash"])
    .index("by_kind_and_checkoutBlocked_and_nextAttemptAt", [
      "locatorKind",
      "checkoutBlocked",
      "nextAttemptAt",
    ])
    .index("by_ownerHash", ["ownerHash"])
    .index("by_kind_and_nextAttemptAt", ["locatorKind", "nextAttemptAt"]),

  /** Hash-only operator audit for a proven late Stripe result that cannot be
   * deleted safely (for example, immutable metadata now names a foreign
   * owner). Resolving it scrubs the short-lived raw cleanup locators while the
   * physical receipt continues suppressing exact callback replay. */
  billing_stripe_late_cleanup_resolutions: defineTable({
    tupleHash: v.string(),
    successLocatorHash: v.string(),
    resolutionId: v.string(),
    resolution: v.literal("provider_resource_retained"),
    locatorCount: v.number(),
    locatorSetHash: v.string(),
    resolvedByHash: v.string(),
    evidenceHash: v.string(),
    resolvedAt: v.number(),
  })
    .index("by_tupleHash", ["tupleHash"])
    .index("by_resolutionId", ["resolutionId"]),

  /** Individual hash-only locators covered by a provider-resource-retained
   * audit. Both cleanup channels consult this before provider mutation. */
  billing_stripe_retained_locators: defineTable({
    tupleHash: v.string(),
    locatorHash: v.string(),
    ownerHash: v.string(),
    locatorKind: v.union(v.literal("customer"), v.literal("checkout_session")),
    resolutionId: v.string(),
    createdAt: v.number(),
  })
    .index("by_locatorHash", ["locatorHash"])
    .index("by_ownerHash_and_locatorHash", ["ownerHash", "locatorHash"])
    .index("by_resolutionId", ["resolutionId"])
    .index("by_tupleHash_and_locatorHash", ["tupleHash", "locatorHash"]),

  /**
   * Short-lived reservation around every Stripe action. A deletion fence can
   * race the network only after this row exists, so returned provider locators
   * can still be published into cleanup debt after the owner closes.
   */
  billing_stripe_operations: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    kind: v.union(
      v.literal("subscription_checkout"),
      v.literal("usage_credit_checkout"),
      v.literal("billing_portal"),
    ),
    state: v.union(
      v.literal("reserved"),
      v.literal("provider_succeeded"),
      v.literal("completed"),
    ),
    idempotencyKey: v.string(),
    stripeCustomerCreateIdempotencyKey: v.string(),
    /** Customer authority epoch frozen when this logical operation begins. */
    stripeCustomerAuthorityEpoch: v.optional(v.number()),
    /** Durable one-time integrity backfill for pre-rollout idle receipts. */
    integrityVersion: v.optional(v.number()),
    /** Bounded lifecycle audit marker for exhaustive current-row validation. */
    lifecycleIntegrityVersion: v.optional(v.literal(1)),
    /**
     * Permanent deletion proved this reservation never crossed provider I/O.
     * This is the only terminal operation shape that need not carry the
     * kind-specific provider result locators.
     */
    terminalizedWithoutProviderDispatch: v.optional(v.boolean()),
    /** Exact returned locators were published to global cleanup during delete. */
    terminalizedForDeletionCleanup: v.optional(v.boolean()),
    /** Audited operator recovery is the proof for a terminal locator-only row. */
    terminalizedByManualResolutionId: v.optional(v.string()),
    /**
     * Hash of the caller's validated logical request id. Optional only for
     * receipts written before request/body binding was introduced.
     */
    requestKey: v.optional(v.string()),
    requestFingerprint: v.string(),
    stripeCustomerId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePortalSessionId: v.optional(v.string()),
    /** Conflicting provider locators retained until deletion captures both. */
    priorStripeCustomerId: v.optional(v.string()),
    priorStripeCheckoutSessionId: v.optional(v.string()),
    priorStripePortalSessionId: v.optional(v.string()),
    /**
     * Exact physical Stripe step that crossed the final pre-I/O marker. These
     * fields are optional only for rows written before the durable-step
     * rollout. A marked row remains authoritative after reset, deletion, or
     * owner migration so its frozen request can be replayed with the same
     * Stripe idempotency key and its returned locator captured exactly once.
     */
    dispatchState: v.optional(
      v.union(v.literal("idle"), v.literal("may_have_dispatched")),
    ),
    activeStep: v.optional(
      v.union(
        v.literal("customer_create"),
        v.literal("checkout_create"),
        v.literal("portal_create"),
      ),
    ),
    activeAttemptId: v.optional(v.string()),
    activeRequestJson: v.optional(v.string()),
    activeRequestFingerprint: v.optional(v.string()),
    activeIdempotencyKey: v.optional(v.string()),
    providerDeadlineAt: v.optional(v.number()),
    /** Immutable physical transport timeout plus abort grace. */
    quiescentAfterAt: v.optional(v.number()),
    /** Mutable retry gate; lifecycle scheduling never extends this value. */
    nextReconcileAt: v.optional(v.number()),
    /** Crash-safe single-worker claim for autonomous exact-key replay. */
    reconcileClaimId: v.optional(v.string()),
    reconcileClaimExpiresAt: v.optional(v.number()),
    /** Exact persisted reason operator intervention is permitted. */
    manualDebtReason: v.optional(
      v.union(
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
      ),
    ),
    /**
     * Provider-side customer ownership is migrated before the local receipt.
     * The may-have-dispatched tuple is retained until Stripe metadata readback
     * proves the destination owner, so an action crash cannot orphan authority.
     */
    stripeCustomerMetadataOwnerId: v.optional(v.string()),
    stripeCustomerMetadataTransferState: v.optional(
      v.union(v.literal("idle"), v.literal("may_have_dispatched")),
    ),
    stripeCustomerMetadataTransferToOwnerId: v.optional(v.string()),
    stripeCustomerMetadataTransferAttemptId: v.optional(v.string()),
    stripeCustomerMetadataTransferIdempotencyKey: v.optional(v.string()),
    stripeCustomerMetadataTransferProviderDeadlineAt: v.optional(v.number()),
    stripeCustomerMetadataTransferQuiescentAfterAt: v.optional(v.number()),
    stripeCustomerMetadataTransferDebtReason: v.optional(
      v.union(v.literal("customer_deleted"), v.literal("foreign_owner")),
    ),
    lastStripeStep: v.optional(
      v.union(
        v.literal("customer_create"),
        v.literal("checkout_create"),
        v.literal("portal_create"),
      ),
    ),
    lastStripeAttemptId: v.optional(v.string()),
    lastStripeRequestFingerprint: v.optional(v.string()),
    lastStripeIdempotencyKey: v.optional(v.string()),
    lastStripeProviderDeadlineAt: v.optional(v.number()),
    lastStripeReconcileClaimId: v.optional(v.string()),
    lastStripeDisposition: v.optional(
      v.union(v.literal("succeeded"), v.literal("not_created")),
    ),
    /** Exact provider success observed after a contradictory manual outcome. */
    lateResultConflictStep: v.optional(
      v.union(
        v.literal("customer_create"),
        v.literal("checkout_create"),
        v.literal("portal_create"),
      ),
    ),
    lateResultConflictAttemptId: v.optional(v.string()),
    lateResultRequestFingerprint: v.optional(v.string()),
    lateResultIdempotencyKey: v.optional(v.string()),
    lateResultProviderDeadlineAt: v.optional(v.number()),
    lateResultReconcileClaimId: v.optional(v.string()),
    lateResultStripeCustomerId: v.optional(v.string()),
    lateResultStripeCheckoutSessionId: v.optional(v.string()),
    lateResultStripePortalSessionId: v.optional(v.string()),
    lateResultConflictAt: v.optional(v.number()),
    lateResultConflictQuiescentAfterAt: v.optional(v.number()),
    leaseExpiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operationId", ["operationId"])
    .index("by_ownerId_and_kind_and_requestFingerprint", [
      "ownerId",
      "kind",
      "requestFingerprint",
    ])
    .index("by_ownerId_and_kind_and_requestKey", [
      "ownerId",
      "kind",
      "requestKey",
    ])
    .index("by_ownerId_and_state", ["ownerId", "state"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_ownerId_and_integrityVersion_and_createdAt", [
      "ownerId",
      "integrityVersion",
      "createdAt",
    ])
    .index("by_ownerId_and_lifecycleIntegrityVersion_and_createdAt", [
      "ownerId",
      "lifecycleIntegrityVersion",
      "createdAt",
    ])
    .index("by_ownerId_and_stripeCustomerAuthorityEpoch_and_createdAt", [
      "ownerId",
      "stripeCustomerAuthorityEpoch",
      "createdAt",
    ])
    .index("by_ownerId_and_manualDebtReason_and_createdAt", [
      "ownerId",
      "manualDebtReason",
      "createdAt",
    ])
    .index("by_ownerId_and_lateResultCustomerId_and_createdAt", [
      "ownerId",
      "lateResultStripeCustomerId",
      "createdAt",
    ])
    .index("by_ownerId_and_lateResultCheckoutId_and_createdAt", [
      "ownerId",
      "lateResultStripeCheckoutSessionId",
      "createdAt",
    ])
    .index("by_ownerId_and_lateResultPortalId_and_createdAt", [
      "ownerId",
      "lateResultStripePortalSessionId",
      "createdAt",
    ])
    .index("by_ownerId_and_dispatchState_and_quiescentAfterAt", [
      "ownerId",
      "dispatchState",
      "quiescentAfterAt",
    ])
    .index("by_ownerId_and_activeStep_and_createdAt", [
      "ownerId",
      "activeStep",
      "createdAt",
    ])
    .index("by_ownerId_and_metadataTransferState_and_createdAt", [
      "ownerId",
      "stripeCustomerMetadataTransferState",
      "createdAt",
    ])
    .index("by_metadataTransferToOwnerId_and_state_and_createdAt", [
      "stripeCustomerMetadataTransferToOwnerId",
      "stripeCustomerMetadataTransferState",
      "createdAt",
    ])
    .index("by_leaseExpiresAt", ["leaseExpiresAt"]),

  /**
   * Immutable, hash-minimized evidence for an operator resolution of Stripe
   * provider debt that cannot be reconciled automatically (for example, a
   * Billing Portal create beyond Stripe's idempotency-key horizon). Raw
   * operator identity/evidence is never stored here; recovered provider
   * locators remain only on the authoritative operation row.
   */
  billing_stripe_operation_resolutions: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    operationId: v.string(),
    resolutionId: v.string(),
    /** One immutable audit per exact provider attempt (or legacy debt step). */
    debtKey: v.string(),
    attemptId: v.optional(v.string()),
    step: v.union(
      v.literal("customer_create"),
      v.literal("checkout_create"),
      v.literal("portal_create"),
    ),
    resolution: v.union(
      v.literal("recovered_customer"),
      v.literal("recovered_checkout"),
      v.literal("recovered_portal"),
      v.literal("provider_confirmed_not_created"),
    ),
    debtReason: v.optional(
      v.union(
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
      ),
    ),
    locatorHash: v.optional(v.string()),
    resolvedByHash: v.string(),
    evidenceHash: v.string(),
    resolvedAt: v.number(),
  })
    .index("by_resolutionId", ["resolutionId"])
    .index("by_operationId_and_debtKey", ["operationId", "debtKey"])
    .index("by_operationId_and_resolvedAt", ["operationId", "resolvedAt"])
    .index("by_ownerId_and_resolvedAt", ["ownerId", "resolvedAt"]),

  /**
   * Hash-minimized source -> destination aliases retained after ownership
   * migration so immutable Stripe event metadata can be reconciled against a
   * destination-owned exact customer/subscription locator.
   */
  billing_stripe_owner_aliases: defineTable({
    sourceOwnerHash: v.string(),
    destinationOwnerHash: v.string(),
    createdAt: v.number(),
  })
    .index("by_sourceOwnerHash", ["sourceOwnerHash"])
    .index("by_sourceOwnerHash_and_destinationOwnerHash", [
      "sourceOwnerHash",
      "destinationOwnerHash",
    ])
    .index("by_destinationOwnerHash", ["destinationOwnerHash"]),

  /**
   * One durable barrier per physical managed-provider request. Reset, account
   * deletion, and auth-owner migration publish their fence first, then wait
   * for these exact attempts to settle or pass their hard expiry plus abort
   * grace. Terminal rows are short-lived idempotency receipts, not usage or
   * entitlement state.
   */
  billing_managed_dispatch_leases: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    executionId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    state: v.union(v.literal("active"), v.literal("terminal")),
    providerDeadlineAt: v.number(),
    leaseExpiresAt: v.number(),
    quiescentAfterAt: v.number(),
    outcome: v.optional(managedProviderDispatchOutcomeValidator),
    usageReservationState: v.optional(
      v.union(v.literal("active"), v.literal("released")),
    ),
    usageReservedMicroCents: v.optional(v.number()),
    billing: v.optional(
      v.union(
        v.object({
          kind: v.literal(PARALLEL_SEARCH_FAST_BILLING_KIND),
          requestFingerprint: v.string(),
          chargeMicroCents: v.literal(PARALLEL_SEARCH_FAST_COST_MICRO_CENTS),
          providerState: managedDispatchProviderStateValidator,
          billingState: managedDispatchBillingStateValidator,
          finalizedAt: v.optional(v.number()),
          billedAt: v.optional(v.number()),
        }),
        v.object({
          kind: v.literal(MANAGED_USAGE_BILLING_KIND),
          requestFingerprint: v.string(),
          agentType: v.string(),
          model: v.string(),
          conversationId: v.optional(v.id("conversations")),
          fallbackCostMicroCents: v.number(),
          capturedUsage: v.optional(managedDispatchCapturedUsageValidator),
          providerState: managedDispatchProviderStateValidator,
          billingState: managedDispatchBillingStateValidator,
          finalizedAt: v.optional(v.number()),
          billedAt: v.optional(v.number()),
        }),
      ),
    ),
    terminalAt: v.optional(v.number()),
    cleanupAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_attemptId", ["attemptId"])
    .index("by_executionId_and_createdAt", ["executionId", "createdAt"])
    .index("by_ownerId_and_executionId_and_state_and_createdAt", [
      "ownerId",
      "executionId",
      "state",
      "createdAt",
    ])
    .index("by_ownerId_and_state_and_quiescentAfterAt", [
      "ownerId",
      "state",
      "quiescentAfterAt",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_cleanupAt", ["cleanupAt"]),

  /**
   * Durable logical-request identity for paid managed provider calls. Attempt
   * leases are intentionally short-lived; this binding survives their cleanup
   * so a caller can never reuse one request id with different provider bytes.
   */
  billing_managed_request_bindings: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    route: v.string(),
    requestId: v.string(),
    bodyFingerprint: v.string(),
    requestFingerprint: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_ownerGeneration_and_route_and_requestId", [
      "ownerId",
      "ownerGeneration",
      "route",
      "requestId",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  /**
   * Enclosing authority for an owner-scoped model/tool loop. Physical model
   * requests still use `billing_managed_dispatch_leases`; this row keeps reset,
   * deletion, and migration joined while a nested tool is running between
   * model requests.
   */
  billing_managed_execution_leases: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    executionId: v.string(),
    leaseId: v.string(),
    state: v.union(v.literal("active"), v.literal("terminal")),
    leaseExpiresAt: v.number(),
    hardExpiresAt: v.number(),
    quiescentAfterAt: v.number(),
    outcome: v.optional(managedProviderDispatchOutcomeValidator),
    terminalAt: v.optional(v.number()),
    cleanupAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_executionId", ["executionId"])
    .index("by_ownerId_and_state_and_quiescentAfterAt", [
      "ownerId",
      "state",
      "quiescentAfterAt",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_cleanupAt", ["cleanupAt"]),

  billing_invoice_payments: defineTable({
    ownerId: v.string(),
    stripeInvoiceId: v.string(),
    stripePaymentIntentId: v.string(),
    stripeSubscriptionId: v.string(),
    amountPaidCents: v.number(),
    currency: v.string(),
    billingReason: v.string(),
    status: v.string(),
    periodStart: v.number(),
    periodEnd: v.number(),
    lastStripeEventCreatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_stripeInvoiceId", ["stripeInvoiceId"])
    .index("by_stripePaymentIntentId", ["stripePaymentIntentId"]),

  /**
   * Exact-attempt provider dispatch barriers for TTS. Every network action
   * reserves one row transactionally with the owner's lifecycle generation
   * before touching a provider, then polls/heartbeats the row while work is
   * live. Reset and deletion turn active rows into cancellation debt and wait
   * for an exact release (or the fixed action hard deadline plus abort grace)
   * before removing the final owner-scoped locator.
   */
  tts_provider_dispatch_leases: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    /** Exact authority token shared by the dispatch locator and its receipt. */
    leaseId: v.string(),
    kind: ttsProviderDispatchKindValidator,
    state: v.union(v.literal("active"), v.literal("cancel_requested")),
    /** Durable point-of-no-return marker written immediately before fetch. */
    providerState: ttsProviderDispatchStateValidator,
    /** Receipt finalized before this locator is allowed to disappear. */
    usageId: v.id("internal_tts_usage"),
    outcome: v.optional(ttsProviderDispatchOutcomeValidator),
    ambiguousAt: v.optional(v.number()),
    leaseExpiresAt: v.number(),
    hardExpiresAt: v.number(),
    quiescentAfterAt: v.number(),
    cleanupJobId: v.id("_scheduled_functions"),
    lastHeartbeatAt: v.number(),
    cancelOperationId: v.optional(v.string()),
    cancelGeneration: v.optional(v.string()),
    cancelRequestedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dispatchId", ["dispatchId"])
    .index("by_dispatchId_and_attemptId", ["dispatchId", "attemptId"])
    .index("by_ownerId_and_state", ["ownerId", "state"])
    .index("by_ownerId_and_state_and_providerState", [
      "ownerId",
      "state",
      "providerState",
    ])
    .index("by_ownerId_and_state_and_leaseExpiresAt", [
      "ownerId",
      "state",
      "leaseExpiresAt",
    ])
    .index("by_ownerId_and_state_and_quiescentAfterAt", [
      "ownerId",
      "state",
      "quiescentAfterAt",
    ])
    .index("by_quiescentAfterAt", ["quiescentAfterAt"]),

  /**
   * Exact-attempt barriers for realtime voice provider HTTP calls. The
   * provider AbortSignal deadline is strictly earlier than `leaseExpiresAt`;
   * an ambiguous/aborted transport remains cancellation debt until the later
   * `quiescentAfterAt` crash-safety bound. Reset, deletion, and either side of
   * an auth-owner migration must drain these rows before reporting success.
   */
  voice_provider_dispatch_leases: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    kind: voiceProviderDispatchKindValidator,
    state: v.union(v.literal("active"), v.literal("cancel_requested")),
    providerDeadlineAt: v.number(),
    leaseExpiresAt: v.number(),
    quiescentAfterAt: v.number(),
    cleanupJobId: v.id("_scheduled_functions"),
    lastHeartbeatAt: v.number(),
    cancelOperationId: v.optional(v.string()),
    cancelGeneration: v.optional(v.string()),
    cancelRequestedAt: v.optional(v.number()),
    ambiguousAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dispatchId", ["dispatchId"])
    .index("by_dispatchId_and_attemptId", ["dispatchId", "attemptId"])
    .index("by_ownerId_and_stellaSessionId_and_createdAt", [
      "ownerId",
      "stellaSessionId",
      "createdAt",
    ])
    .index("by_ownerId_and_state", ["ownerId", "state"])
    .index("by_ownerId_and_state_and_quiescentAfterAt", [
      "ownerId",
      "state",
      "quiescentAfterAt",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_quiescentAfterAt", ["quiescentAfterAt"]),

  // Short-lived, single-use tickets that bridge a POSTed read-aloud request
  // to a GET audio stream. Mobile's native audio player (AVPlayer/ExoPlayer)
  // fetches a seekable resource and issues multiple (ranged) requests per
  // playback, and the assistant text is far too long to place in a query
  // string — so the client POSTs the text to `/api/voice/tts/stream/prepare`,
  // receives an opaque ticket, and the player GETs
  // `/api/voice/tts/stream/audio/reply.mp3?ticket=…`. Rows are owner-bound,
  // expire in ~2 minutes, are reusable within that window (so the player's
  // range requests all succeed), and are swept by a cron — so the assistant
  // text never lands in a URL, log, or long-lived store. `audio` caches the
  // synthesized MP3 (base64) after the first request so the player's follow-up
  // range requests are served from cache instead of re-synthesizing.
  tts_stream_tickets: defineTable({
    ticket: v.string(),
    ownerId: v.string(),
    // Captured when the ticket is created. Background synthesis and cache
    // writers must present the same generation so a reset cannot reopen and
    // accept an old ticket's delayed output.
    ownerGeneration: v.optional(v.string()),
    /** Stable logical read-aloud operation shared across transport fallback. */
    providerDispatchId: v.optional(v.string()),
    text: v.string(),
    voice: v.string(),
    model: v.string(),
    speed: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
    audio: v.optional(v.string()),
    // HLS progressive-playback session state (mobile). A background action
    // streams Inworld once and appends MP3 segments to `tts_hls_segments`; this
    // row holds the live playlist manifest so a `playlist.m3u8` read never has
    // to load segment audio. `hlsStatus` walks pending → synthesizing → done
    // (or error). `hlsSegments` grows as segments land; the playlist gains
    // `#EXT-X-ENDLIST` once `hlsDone` is set. `hlsCanceledAt` is a cooperative
    // stop beacon the synthesis loop polls so a user "stop" ends provider spend
    // early and is metered as interrupted.
    hlsStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("synthesizing"),
        v.literal("done"),
        v.literal("error"),
      ),
    ),
    hlsSegments: v.optional(
      v.array(v.object({ seq: v.number(), durationSec: v.number() })),
    ),
    hlsDone: v.optional(v.boolean()),
    hlsCanceledAt: v.optional(v.number()),
    hlsAttemptId: v.optional(v.string()),
    // Exact-attempt crash recovery. A replacement action may claim only after
    // this hard lease expires; the previous action's attempt id then fences
    // every delayed append/finalizer.
    hlsLeaseExpiresAt: v.optional(v.number()),
    synthesisTransport: v.optional(
      v.union(v.literal("hls"), v.literal("buffered")),
    ),
    bufferStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("synthesizing"),
        v.literal("done"),
        v.literal("error"),
      ),
    ),
    bufferAttemptId: v.optional(v.string()),
    bufferLeaseExpiresAt: v.optional(v.number()),
    bufferTooLarge: v.optional(v.boolean()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_ticket", ["ticket"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),

  // Per-segment MP3 payloads for the mobile HLS transport. Each row is one
  // packed-audio segment (ID3 transport-stream-timestamp tag + whole MP3
  // frames), base64-encoded. Owner-bound + short TTL like the parent ticket,
  // swept by the same cron. Kept in a side table (not on the ticket row) so a
  // playlist read stays tiny and only a segment GET pays for the audio bytes.
  tts_hls_segments: defineTable({
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.optional(v.string()),
    seq: v.number(),
    audio: v.string(),
    durationSec: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_ticket_and_seq", ["ticket", "seq"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),

  // Internal provider-spend ledger for read-aloud / TTS synthesis.
  //
  // Read-aloud is user-facing FREE on every plan, so its provider cost must
  // never touch the user's usage windows, credit balance, or plan
  // entitlements. This table is write-only telemetry consumed by internal
  // spend reporting only — it is deliberately NOT wired into
  // `persistManagedUsage`, `usage_logs`, or any capability gate. One row is
  // written per synthesis attempt, capturing whether it completed, failed
  // before audio, was interrupted by the client, or ended partial, so
  // provider spend (including cancellations) can be reconstructed without
  // ever charging a user.
  internal_tts_usage: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.optional(v.string()),
    /** Exact provider-attempt receipt fields; absent only on legacy rows. */
    dispatchId: v.optional(v.string()),
    attemptId: v.optional(v.string()),
    leaseId: v.optional(v.string()),
    providerDispatchOutcome: v.optional(ttsProviderDispatchOutcomeValidator),
    provider: v.union(v.literal("inworld"), v.literal("openai")),
    model: v.string(),
    voice: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    streaming: v.boolean(),
    // completed  → full text synthesized and delivered.
    // failed     → provider/setup error before any audio was delivered.
    // interrupted→ client aborted mid-stream (stop / navigate / unmount).
    // partial    → upstream ended early or errored after some audio.
    status: internalTtsUsageStatusValidator,
    // Characters submitted to the provider (bounded input).
    requestChars: v.number(),
    /** Conservative full-request estimates retained before provider dispatch. */
    requestedTextInputTokens: v.optional(v.number()),
    requestedAudioOutputTokens: v.optional(v.number()),
    // Best estimate of characters actually synthesized (== requestChars on a
    // clean completion; scaled down by delivered audio on interrupt/partial).
    synthesizedChars: v.number(),
    // Audio bytes delivered downstream, a provider-agnostic progress proxy.
    audioBytes: v.number(),
    textInputTokens: v.number(),
    audioOutputTokens: v.number(),
    // Internal provider-cost estimate in micro-cents. NOT billed to the user.
    costMicroCents: v.number(),
    durationMs: v.number(),
    createdAt: v.number(),
  })
    .index("by_dispatchId_and_attemptId", ["dispatchId", "attemptId"])
    .index("by_ownerId_and_dispatchId_and_providerDispatchOutcome_and_status", [
      "ownerId",
      "dispatchId",
      "providerDispatchOutcome",
      "status",
    ])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_provider_and_createdAt", ["provider", "createdAt"]),
};
