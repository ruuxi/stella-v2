import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import {
  computeRealtimeUsageCostMicroCents,
  computeUsageCostMicroCents,
} from "./lib/billing_money";
import { hashSha256Hex } from "./lib/crypto_utils";
import { readExactVoiceProviderAttempt } from "./voice_dispatch";
import {
  VOICE_REALTIME_AUTHORITY_LEASE_MS,
  VOICE_REALTIME_AUTHORITY_POLL_MS,
  voiceAuthorityQuiescentAfter,
} from "./lib/voice_authority";
import { scheduleBillingUsage } from "./billing_bridge";
import { getManagedModelPriceRow, toTokenPriceConfig } from "./model_prices";

/**
 * Receipts for the metered providers that still run in Convex: realtime
 * voice sessions and media jobs. Each physical charge is recorded here once
 * and reported to the owner's billing ledger on cloud-builder through the
 * bridge. Leaves with voice and media in their Cloudflare phase.
 */

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

/** Report one charge to the owner's ledger once this transaction commits. */
const persistProviderUsage = async (
  ctx: MutationCtx,
  usage: ManagedUsageRecordArgs,
): Promise<void> => {
  const costMicroCents =
    usage.costMicroCents ??
    computeUsageCostMicroCents({
      model: usage.model,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
        : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      price: toTokenPriceConfig(await getManagedModelPriceRow(ctx, usage.model)),
    });
  await scheduleBillingUsage(ctx, { ownerId: usage.ownerId, costMicroCents });
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
  return await persistProviderUsage(ctx, args.usage);
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
      internal.provider_usage.hangupOpenAiVoiceCallInternal,
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
        internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
        internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
        internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
      await persistProviderUsage(ctx, {
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
    /** From the owner's billing ledger; null when the owner is unlimited. */
    availableManagedUsageMicroCents: v.union(v.number(), v.null()),
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
      args.availableManagedUsageMicroCents ?? Number.POSITIVE_INFINITY;
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
      internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
      internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
        internal.provider_usage.hangupOpenAiVoiceCallInternal,
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
      internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
        internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
        internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
          internal.provider_usage.reapVoiceRealtimeSessionInternal,
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
      internal.provider_usage.hangupOpenAiVoiceCallInternal,
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
      internal.provider_usage.hangupOpenAiVoiceCallInternal,
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
      internal.provider_usage.acquireOpenAiVoiceHangupCommandInternal,
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
      internal.provider_usage.recordOpenAiVoiceHangupAttemptInternal,
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

  await persistProviderUsage(ctx, {
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
