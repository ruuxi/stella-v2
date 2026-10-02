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
  v.literal("desktop_stream"),
  v.literal("hls"),
  v.literal("oneshot_gemini"),
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

  // Short-lived tickets that bridge a POSTed read-aloud request to the mobile
  // HLS stream. The assistant text is far too long for a query string, so the
  // client POSTs it to `/api/voice/tts/stream/prepare`, receives an opaque
  // ticket, and plays `/api/voice/tts/stream/hls/<ticket>/playlist.m3u8`. Rows
  // are owner-bound, short-lived, and swept by a cron, so the assistant text
  // never lands in a URL, log, or long-lived store.
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
    conversationId: v.optional(v.id("conversations")),
    // HLS progressive-playback session state (mobile). A background action
    // streams Gemini once and appends MP3 segments to `tts_hls_segments`; this
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
    // `inworld` only on historical ledger rows from before Gemini read-aloud.
    provider: v.union(
      v.literal("gemini"),
      v.literal("inworld"),
      v.literal("openai"),
    ),
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
