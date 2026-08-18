import { defineTable } from "convex/server";
import { v } from "convex/values";

export const subscriptionPlanValidator = v.union(
  v.literal("free"),
  v.literal("go"),
  v.literal("pro"),
);

export const billingUsageModeValidator = v.union(
  v.literal("default"),
  v.literal("unlimited"),
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_stripeCustomerId", ["stripeCustomerId"])
    .index("by_stripeSubscriptionId", ["stripeSubscriptionId"]),

  billing_usage_windows: defineTable({
    ownerId: v.string(),
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
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  billing_media_usage_receipts: defineTable({
    ownerId: v.string(),
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
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    createdAt: v.number(),
    processedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_processedAt", ["processedAt"]),

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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_stripeInvoiceId", ["stripeInvoiceId"])
    .index("by_stripePaymentIntentId", ["stripePaymentIntentId"]),

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
    text: v.string(),
    voice: v.string(),
    model: v.string(),
    speed: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
    audio: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_ticket", ["ticket"])
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
    provider: v.union(v.literal("inworld"), v.literal("openai")),
    model: v.string(),
    voice: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    streaming: v.boolean(),
    // completed  → full text synthesized and delivered.
    // failed     → provider/setup error before any audio was delivered.
    // interrupted→ client aborted mid-stream (stop / navigate / unmount).
    // partial    → upstream ended early or errored after some audio.
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("interrupted"),
      v.literal("partial"),
    ),
    // Characters submitted to the provider (bounded input).
    requestChars: v.number(),
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
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_provider_and_createdAt", ["provider", "createdAt"]),
};
