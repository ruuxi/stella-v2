import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { relayResumeStatusValidator } from "../schema/relay_resume";
import {
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
  assertOwnerPurgeOperation,
} from "../owner_lifecycle";
import { resolveCurrentTurnToken } from "../cloud_apps";
import {
  mergeRelayBillingFinalization,
  type RelayBillingTerminalStatus,
  type RelayBillingUsage,
} from "./relay_billing";
import {
  STELLA_RELAY_CLEANUP_MAX_BATCHES,
  STELLA_RELAY_CLEANUP_MAX_BILLING_DOCS,
  STELLA_RELAY_CLEANUP_MAX_BYTES,
  STELLA_RELAY_CLEANUP_MAX_DOCS,
  STELLA_RELAY_CLEANUP_MAX_INTENT_DOCS,
  STELLA_RELAY_CLEANUP_MAX_LEASE_DOCS,
  STELLA_RELAY_CLEANUP_MAX_PURGE_DOCS,
  STELLA_RELAY_CANCEL_INTENT_TTL_MS,
  STELLA_RELAY_BILLING_RECEIPT_TTL_MS,
  STELLA_RELAY_OWNER_PURGE_TTL_MS,
  STELLA_RELAY_RESUME_HARD_TTL_MS,
  STELLA_RELAY_RESUME_LEASE_TTL_MS,
  STELLA_RELAY_RESUME_MAX_BYTES,
  STELLA_RELAY_RESUME_MAX_EVENT_BYTES,
  STELLA_RELAY_RESUME_MAX_EVENTS,
  STELLA_RELAY_RESUME_MAX_GLOBAL_BYTES,
  STELLA_RELAY_RESUME_MAX_GLOBAL_INTENTS,
  STELLA_RELAY_RESUME_MAX_GLOBAL_STREAMS,
  STELLA_RELAY_RESUME_MAX_OWNER_BYTES,
  STELLA_RELAY_RESUME_MAX_OWNER_INTENTS,
  STELLA_RELAY_RESUME_MAX_OWNER_LEASES,
  STELLA_RELAY_RESUME_MAX_OWNER_STREAMS,
  STELLA_RELAY_RESUME_MAX_STREAM_LEASES,
  STELLA_RELAY_RESUME_QUERY_MAX_CHUNKS,
  STELLA_RELAY_RESUME_TTL_MS,
  relayResumeChunkEvents,
  relayResumeEventBytes,
  type RelayResumeStatus,
} from "./relay_resume";

const GLOBAL_QUOTA_KEY = "global";
const GLOBAL_INTENT_QUOTA_KEY = "intents:global";
const CLEANUP_STATE_KEY = "relay-resume";
const RELAY_BILLING_DELIVERY_RETRY_TTL_MS = 60 * 60 * 1000;

const relayResumeEventValidator = v.object({
  sequence: v.number(),
  frame: v.string(),
  eventType: v.string(),
  responseId: v.optional(v.string()),
  responseStatus: v.optional(v.string()),
  terminalStatus: v.optional(
    v.union(
      v.literal("completed"),
      v.literal("incomplete"),
      v.literal("failed"),
      v.literal("error"),
    ),
  ),
});

const relayResumeStoredEventValidator = v.object({
  sequence: v.number(),
  frame: v.string(),
});

const relayBillingTerminalStatusValidator = v.union(
  v.literal("completed"),
  v.literal("incomplete"),
  v.literal("failed"),
  v.literal("error"),
  v.literal("canceled"),
  v.literal("upstream_eof"),
  v.literal("truncated"),
);

const relayBillingUsageValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  cacheWriteInputTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
  costMicroCents: v.optional(v.number()),
});

const ownerQuotaKey = (ownerId: string) => `owner:${ownerId}`;
const ownerIntentQuotaKey = (ownerId: string) => `intents:owner:${ownerId}`;

const getQuota = async (ctx: MutationCtx, scopeKey: string) =>
  await ctx.db
    .query("stella_relay_response_quotas")
    .withIndex("by_scopeKey", (q) => q.eq("scopeKey", scopeKey))
    .unique();

const adjustQuota = async (
  ctx: MutationCtx,
  scopeKey: string,
  streamDelta: number,
  byteDelta: number,
  nowMs: number,
) => {
  const quota = await getQuota(ctx, scopeKey);
  const streamCount = Math.max(0, (quota?.streamCount ?? 0) + streamDelta);
  const storedBytes = Math.max(0, (quota?.storedBytes ?? 0) + byteDelta);
  if (quota) {
    await ctx.db.patch(quota._id, {
      streamCount,
      storedBytes,
      updatedAt: nowMs,
    });
  } else {
    await ctx.db.insert("stella_relay_response_quotas", {
      scopeKey,
      streamCount,
      storedBytes,
      updatedAt: nowMs,
    });
  }
};

const releaseStreamQuota = async (
  ctx: MutationCtx,
  stream: { ownerId: string; storedBytes: number },
  nowMs: number,
) => {
  await adjustQuota(ctx, GLOBAL_QUOTA_KEY, -1, -stream.storedBytes, nowMs);
  await adjustQuota(
    ctx,
    ownerQuotaKey(stream.ownerId),
    -1,
    -stream.storedBytes,
    nowMs,
  );
};

// Cancellation tombstones are counted through the same quota table
// (streamCount holds the intent count) so they can never grow unmetered.
const adjustIntentCounts = async (
  ctx: MutationCtx,
  ownerId: string,
  delta: number,
  nowMs: number,
) => {
  await adjustQuota(ctx, GLOBAL_INTENT_QUOTA_KEY, delta, 0, nowMs);
  await adjustQuota(ctx, ownerIntentQuotaKey(ownerId), delta, 0, nowMs);
};

const deleteIntent = async (
  ctx: MutationCtx,
  intent: { _id: Id<"stella_relay_cancellation_intents">; ownerId: string },
  nowMs: number,
) => {
  await ctx.db.delete(intent._id);
  await adjustIntentCounts(ctx, intent.ownerId, -1, nowMs);
};

const activeOwnerPurge = async (
  ctx: MutationCtx | QueryCtx,
  ownerId: string,
  nowMs: number,
) => {
  const purge = await ctx.db
    .query("stella_relay_owner_purges")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  return purge !== null && purge.expiresAt > nowMs;
};

const getRelayBillingReceipt = async (
  ctx: MutationCtx | QueryCtx,
  relayRequestId: string,
) =>
  await ctx.db
    .query("stella_relay_billing_receipts")
    .withIndex("by_relayRequestId", (q) =>
      q.eq("relayRequestId", relayRequestId),
    )
    .unique();

const actualUsageFromReceipt = (receipt: {
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualTotalTokens?: number;
  actualCachedInputTokens?: number;
  actualCacheWriteInputTokens?: number;
  actualReasoningTokens?: number;
  actualCostMicroCents?: number;
}): RelayBillingUsage | undefined => {
  const usage = {
    inputTokens: receipt.actualInputTokens,
    outputTokens: receipt.actualOutputTokens,
    totalTokens: receipt.actualTotalTokens,
    cachedInputTokens: receipt.actualCachedInputTokens,
    cacheWriteInputTokens: receipt.actualCacheWriteInputTokens,
    reasoningTokens: receipt.actualReasoningTokens,
    costMicroCents: receipt.actualCostMicroCents,
  };
  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
};

const finalizeRelayBillingReceiptInMutation = async (
  ctx: MutationCtx,
  args: {
    relayRequestId: string;
    ownerId: string;
    requestBinding: string;
    terminalStatus: RelayBillingTerminalStatus;
    success: boolean;
    durationMs: number;
    actualUsage?: RelayBillingUsage;
    nowMs: number;
    settleBilling?: boolean;
  },
): Promise<
  "finalized" | "upgraded" | "duplicate" | "not_found" | "conflict"
> => {
  const receipt = await getRelayBillingReceipt(ctx, args.relayRequestId);
  if (!receipt) return "not_found";
  if (
    receipt.ownerId !== args.ownerId ||
    receipt.requestBinding !== args.requestBinding
  ) {
    return "conflict";
  }
  const wasTerminal = receipt.terminalStatus !== undefined;
  const patch = mergeRelayBillingFinalization(
    {
      terminalStatus: receipt.terminalStatus,
      success: receipt.success,
      durationMs: receipt.durationMs,
      hasActualUsage: receipt.hasActualUsage,
      actualUsage: actualUsageFromReceipt(receipt),
      billedAt: receipt.billedAt,
    },
    {
      terminalStatus: args.terminalStatus,
      success: args.success,
      durationMs: args.durationMs,
      actualUsage: args.actualUsage,
    },
  );
  const shouldSettleBilling =
    receipt.billingAuthority !== "managed_dispatch" &&
    args.settleBilling === true &&
    receipt.billingReady !== true;
  if (!patch && !shouldSettleBilling) return "duplicate";

  const actualUsage = patch?.actualUsage;
  await ctx.db.patch(receipt._id, {
    ...(patch?.terminalStatus !== undefined
      ? {
          phase: "terminal" as const,
          terminalStatus: patch.terminalStatus,
          success: patch.success,
        }
      : {}),
    ...(patch?.durationMs !== undefined
      ? { durationMs: patch.durationMs }
      : {}),
    ...(patch?.hasActualUsage !== undefined
      ? { hasActualUsage: patch.hasActualUsage }
      : {}),
    ...(actualUsage
      ? {
          actualInputTokens: actualUsage.inputTokens,
          actualOutputTokens: actualUsage.outputTokens,
          actualTotalTokens: actualUsage.totalTokens,
          actualCachedInputTokens: actualUsage.cachedInputTokens,
          actualCacheWriteInputTokens: actualUsage.cacheWriteInputTokens,
          actualReasoningTokens: actualUsage.reasoningTokens,
          actualCostMicroCents: actualUsage.costMicroCents,
        }
      : {}),
    ...(shouldSettleBilling
      ? { billingReady: true, billingReadyAt: args.nowMs }
      : {}),
    updatedAt: args.nowMs,
  });
  if (receipt.billingReady === true || shouldSettleBilling) {
    await ctx.scheduler.runAfter(
      0,
      internal.stella_provider.relay_resume_store.deliverRelayBillingReceipt,
      {
        relayRequestId: args.relayRequestId,
        requestBinding: args.requestBinding,
      },
    );
  }
  return wasTerminal ? "upgraded" : "finalized";
};

export const markRelayBillingDispatched = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    turnAuthority: v.optional(
      v.object({ tokenHash: v.string(), turnId: v.string() }),
    ),
    requestBinding: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("dispatched"),
    v.literal("terminal"),
    v.literal("turn_inactive"),
    v.literal("not_found"),
    v.literal("conflict"),
  ),
  handler: async (ctx, args) => {
    // This is the resumable request's final transaction-plane dispatch check.
    // If reset/deletion raced admission, the mutation rolls back before the
    // receipt can claim the provider was contacted.
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    if (
      args.turnAuthority &&
      !(await resolveCurrentTurnToken(
        ctx,
        {
          tokenHash: args.turnAuthority.tokenHash,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnAuthority.turnId,
          now: args.nowMs,
        },
        true,
      ))?.turn
    ) {
      return "turn_inactive";
    }
    const receipt = await getRelayBillingReceipt(ctx, args.relayRequestId);
    if (!receipt) return "not_found";
    if (
      receipt.ownerId !== args.ownerId ||
      receipt.requestBinding !== args.requestBinding
    ) {
      return "conflict";
    }
    if (receipt.phase === "terminal") return "terminal";
    if (receipt.phase === "reserved") {
      await ctx.db.patch(receipt._id, {
        phase: "dispatched",
        updatedAt: args.nowMs,
      });
    }
    return "dispatched";
  },
});

export const abandonUndispatchedRelayReservation = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    requestBinding: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("abandoned"),
    v.literal("not_found"),
    v.literal("active"),
  ),
  handler: async (ctx, args) => {
    const [stream, receipt] = await Promise.all([
      ctx.db
        .query("stella_relay_response_streams")
        .withIndex("by_relayRequestId", (q) =>
          q.eq("relayRequestId", args.relayRequestId),
        )
        .unique(),
      getRelayBillingReceipt(ctx, args.relayRequestId),
    ]);
    if (
      !stream ||
      !receipt ||
      stream.ownerId !== args.ownerId ||
      receipt.ownerId !== args.ownerId ||
      stream.requestBinding !== args.requestBinding ||
      receipt.requestBinding !== args.requestBinding
    ) {
      return "not_found";
    }
    if (
      stream.status !== "streaming" ||
      stream.eventCount !== 0 ||
      receipt.phase !== "reserved"
    ) {
      return "active";
    }
    const leases = await ctx.db
      .query("stella_relay_response_leases")
      .withIndex("by_relayRequestId_and_expiresAt", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .take(STELLA_RELAY_RESUME_MAX_STREAM_LEASES);
    await Promise.all(leases.map((lease) => ctx.db.delete(lease._id)));
    await ctx.db.delete(receipt._id);
    await ctx.db.delete(stream._id);
    await releaseStreamQuota(ctx, stream, args.nowMs);
    return "abandoned";
  },
});

export const finalizeRelayBillingReceipt = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    requestBinding: v.string(),
    terminalStatus: relayBillingTerminalStatusValidator,
    success: v.boolean(),
    durationMs: v.number(),
    actualUsage: v.optional(relayBillingUsageValidator),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("finalized"),
    v.literal("upgraded"),
    v.literal("duplicate"),
    v.literal("not_found"),
    v.literal("conflict"),
  ),
  handler: async (ctx, args) =>
    await finalizeRelayBillingReceiptInMutation(ctx, {
      ...args,
      // This callable is the producing action's final handshake. Low-level
      // stream/cancel mutations may record a terminal outcome earlier, but
      // they never make fallback billing race the final provider usage frame.
      settleBilling: true,
    }),
});

export const deliverRelayBillingReceipt = internalAction({
  args: { relayRequestId: v.string(), requestBinding: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const result: string = await ctx.runMutation(
        internal.billing.logRelayManagedUsage,
        {
          relayRequestId: args.relayRequestId,
          requestBinding: args.requestBinding,
          nowMs: Date.now(),
        },
      );
      // A not-ready receipt is intentionally dormant. Only the producer's
      // settlement mutation or the abandoned-work cleanup reschedules it.
      void result;
    } catch {
      await ctx.scheduler.runAfter(
        1_000,
        internal.stella_provider.relay_resume_store.deliverRelayBillingReceipt,
        args,
      );
    }
    return null;
  },
});

export const reserveRelayResumeStream = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    turnId: v.optional(v.string()),
    turnAuthority: v.optional(
      v.object({ tokenHash: v.string(), turnId: v.string() }),
    ),
    ownerGeneration: v.string(),
    provider: v.string(),
    model: v.string(),
    requestBinding: v.string(),
    agentType: v.string(),
    billingAuthority: v.optional(v.literal("managed_dispatch")),
    estimatedInputTokens: v.number(),
    estimatedOutputTokens: v.number(),
    startedAt: v.number(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("reserved"),
    v.literal("existing"),
    v.literal("expired"),
    v.literal("canceled"),
    v.literal("conflict"),
    v.literal("owner_quota"),
    v.literal("global_quota"),
    v.literal("owner_purged"),
    v.literal("turn_inactive"),
  ),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(ctx, args.ownerId, args.ownerGeneration);
    if (
      args.turnAuthority &&
      (!(await resolveCurrentTurnToken(
        ctx,
        {
          tokenHash: args.turnAuthority.tokenHash,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          turnId: args.turnAuthority.turnId,
          now: args.nowMs,
        },
        true,
      ))?.turn ||
        args.turnId !== args.turnAuthority.turnId)
    ) {
      return "turn_inactive";
    }
    // Transactional deletion gate: while this owner's relay data is being
    // purged (account deletion or cloud reset), no new stream may be
    // reserved, so a purge drain that observes zero rows stays at zero rows.
    if (await activeOwnerPurge(ctx, args.ownerId, args.nowMs)) {
      return "owner_purged";
    }
    const cancellationIntent = await ctx.db
      .query("stella_relay_cancellation_intents")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (cancellationIntent) {
      if (cancellationIntent.ownerId !== args.ownerId) return "conflict";
      if (
        args.turnId !== undefined &&
        cancellationIntent.turnId !== args.turnId
      ) {
        return "conflict";
      }
      if (cancellationIntent.expiresAt > args.nowMs) return "canceled";
      await deleteIntent(ctx, cancellationIntent, args.nowMs);
    }

    const existing = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (existing) {
      return existing.ownerId === args.ownerId &&
        (args.turnId === undefined || existing.turnId === args.turnId) &&
        existing.provider === args.provider &&
        existing.model === args.model &&
        existing.requestBinding === args.requestBinding
        ? "existing"
        : "conflict";
    }

    // Billing receipts outlive the plaintext stream. Once the stream has
    // expired, the same logical request must not dispatch again and charge a
    // second time; a changed owner/turn/body remains a hard conflict.
    const existingReceipt = await getRelayBillingReceipt(
      ctx,
      args.relayRequestId,
    );
    if (existingReceipt) {
      return existingReceipt.ownerId === args.ownerId &&
        (args.turnId === undefined || existingReceipt.turnId === args.turnId) &&
        existingReceipt.provider === args.provider &&
        existingReceipt.model === args.model &&
        existingReceipt.requestBinding === args.requestBinding
        ? "expired"
        : "conflict";
    }

    const [globalQuota, ownerQuota] = await Promise.all([
      getQuota(ctx, GLOBAL_QUOTA_KEY),
      getQuota(ctx, ownerQuotaKey(args.ownerId)),
    ]);
    if (
      (globalQuota?.streamCount ?? 0) >=
        STELLA_RELAY_RESUME_MAX_GLOBAL_STREAMS ||
      (globalQuota?.storedBytes ?? 0) >= STELLA_RELAY_RESUME_MAX_GLOBAL_BYTES
    ) {
      return "global_quota";
    }
    if (
      (ownerQuota?.streamCount ?? 0) >= STELLA_RELAY_RESUME_MAX_OWNER_STREAMS ||
      (ownerQuota?.storedBytes ?? 0) >= STELLA_RELAY_RESUME_MAX_OWNER_BYTES
    ) {
      return "owner_quota";
    }

    const hardExpiresAt = args.nowMs + STELLA_RELAY_RESUME_HARD_TTL_MS;
    await ctx.db.insert("stella_relay_response_streams", {
      relayRequestId: args.relayRequestId,
      ownerId: args.ownerId,
      turnId: args.turnId,
      provider: args.provider,
      model: args.model,
      requestBinding: args.requestBinding,
      status: "streaming",
      lastSequence: 0,
      eventCount: 0,
      storedBytes: 0,
      nextChunkIndex: 0,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
      expiresAt: Math.min(
        hardExpiresAt,
        args.nowMs + STELLA_RELAY_RESUME_TTL_MS,
      ),
      hardExpiresAt,
    });
    await ctx.db.insert("stella_relay_billing_receipts", {
      relayRequestId: args.relayRequestId,
      ownerId: args.ownerId,
      turnId: args.turnId,
      ownerGeneration: args.ownerGeneration,
      requestBinding: args.requestBinding,
      provider: args.provider,
      model: args.model,
      agentType: args.agentType,
      billingAuthority: args.billingAuthority,
      phase: "reserved",
      estimatedInputTokens: Math.max(0, args.estimatedInputTokens),
      estimatedOutputTokens: Math.max(0, args.estimatedOutputTokens),
      hasActualUsage: false,
      createdAt: args.startedAt,
      updatedAt: args.nowMs,
      hardExpiresAt: args.nowMs + STELLA_RELAY_BILLING_RECEIPT_TTL_MS,
    });
    await adjustQuota(ctx, GLOBAL_QUOTA_KEY, 1, 0, args.nowMs);
    await adjustQuota(ctx, ownerQuotaKey(args.ownerId), 1, 0, args.nowMs);
    return "reserved";
  },
});

export const activateRelayResumeStream = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    upstreamStatus: v.number(),
    upstreamRequestId: v.optional(v.string()),
    nowMs: v.number(),
  },
  returns: v.union(v.literal("not_found"), relayResumeStatusValidator),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream || stream.ownerId !== args.ownerId) return "not_found";
    if (await activeOwnerPurge(ctx, args.ownerId, args.nowMs)) {
      return "canceled";
    }
    if (stream.status !== "streaming") return stream.status;
    await ctx.db.patch(stream._id, {
      upstreamStatus: args.upstreamStatus,
      upstreamRequestId: args.upstreamRequestId?.slice(0, 200),
      updatedAt: args.nowMs,
      expiresAt: Math.min(
        stream.hardExpiresAt,
        args.nowMs + STELLA_RELAY_RESUME_TTL_MS,
      ),
    });
    if (stream.requestBinding) {
      const receipt = await getRelayBillingReceipt(ctx, args.relayRequestId);
      if (
        receipt?.ownerId === args.ownerId &&
        receipt.requestBinding === stream.requestBinding &&
        receipt.phase !== "terminal"
      ) {
        await ctx.db.patch(receipt._id, {
          phase: "accepted",
          acceptedAt: args.nowMs,
          updatedAt: args.nowMs,
        });
      }
    }
    return "streaming";
  },
});

export const appendRelayResumeEvents = internalMutation({
  args: {
    relayRequestId: v.string(),
    events: v.array(relayResumeEventValidator),
    nowMs: v.number(),
  },
  returns: v.object({
    accepted: v.boolean(),
    status: relayResumeStatusValidator,
  }),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream) return { accepted: false, status: "truncated" as const };
    // Stop persisting immediately once the owner's purge begins so active
    // relay work halts and the purge drain converges.
    if (await activeOwnerPurge(ctx, stream.ownerId, args.nowMs)) {
      return { accepted: false, status: "canceled" as const };
    }
    if (
      stream.status !== "streaming" ||
      stream.hardExpiresAt <= args.nowMs ||
      stream.expiresAt <= args.nowMs
    ) {
      return { accepted: false, status: stream.status };
    }
    if (args.events.length === 0) {
      return { accepted: true, status: stream.status };
    }

    let expected = stream.lastSequence + 1;
    let addedBytes = 0;
    for (const event of args.events) {
      if (event.sequence !== expected) {
        throw new Error("Relay resume event sequence is not contiguous");
      }
      expected += 1;
      const eventBytes = relayResumeEventBytes(event);
      if (eventBytes > STELLA_RELAY_RESUME_MAX_EVENT_BYTES) {
        await ctx.db.patch(stream._id, {
          status: "truncated",
          lastEventType: event.eventType,
          updatedAt: args.nowMs,
        });
        if (stream.requestBinding) {
          await finalizeRelayBillingReceiptInMutation(ctx, {
            relayRequestId: args.relayRequestId,
            ownerId: stream.ownerId,
            requestBinding: stream.requestBinding,
            terminalStatus: "truncated",
            success: false,
            durationMs: args.nowMs - stream.createdAt,
            nowMs: args.nowMs,
          });
        }
        return { accepted: false, status: "truncated" as const };
      }
      addedBytes += eventBytes;
    }

    const [globalQuota, ownerQuota] = await Promise.all([
      getQuota(ctx, GLOBAL_QUOTA_KEY),
      getQuota(ctx, ownerQuotaKey(stream.ownerId)),
    ]);
    if (
      stream.eventCount + args.events.length > STELLA_RELAY_RESUME_MAX_EVENTS ||
      stream.storedBytes + addedBytes > STELLA_RELAY_RESUME_MAX_BYTES ||
      (globalQuota?.storedBytes ?? 0) + addedBytes >
        STELLA_RELAY_RESUME_MAX_GLOBAL_BYTES ||
      (ownerQuota?.storedBytes ?? 0) + addedBytes >
        STELLA_RELAY_RESUME_MAX_OWNER_BYTES
    ) {
      await ctx.db.patch(stream._id, {
        status: "truncated",
        lastEventType: args.events[args.events.length - 1]?.eventType,
        updatedAt: args.nowMs,
      });
      if (stream.requestBinding) {
        await finalizeRelayBillingReceiptInMutation(ctx, {
          relayRequestId: args.relayRequestId,
          ownerId: stream.ownerId,
          requestBinding: stream.requestBinding,
          terminalStatus: "truncated",
          success: false,
          durationMs: args.nowMs - stream.createdAt,
          nowMs: args.nowMs,
        });
      }
      return { accepted: false, status: "truncated" as const };
    }

    let chunkIndex = stream.nextChunkIndex;
    for (const events of relayResumeChunkEvents(args.events)) {
      const storedBytes = events.reduce(
        (sum, event) => sum + relayResumeEventBytes(event),
        0,
      );
      await ctx.db.insert("stella_relay_response_chunks", {
        relayRequestId: args.relayRequestId,
        chunkIndex,
        firstSequence: events[0]!.sequence,
        lastSequence: events[events.length - 1]!.sequence,
        events: events.map(({ sequence, frame }) => ({ sequence, frame })),
        storedBytes,
        createdAt: args.nowMs,
        hardExpiresAt: stream.hardExpiresAt,
      });
      chunkIndex += 1;
    }

    const lastEvent = args.events[args.events.length - 1]!;
    const terminal = args.events.find((event) => event.terminalStatus);
    const nextStatus: RelayResumeStatus =
      terminal?.terminalStatus ?? "streaming";
    await ctx.db.patch(stream._id, {
      status: nextStatus,
      responseId:
        [...args.events].reverse().find((event) => event.responseId)
          ?.responseId ?? stream.responseId,
      lastEventType: lastEvent.eventType,
      lastResponseStatus:
        [...args.events].reverse().find((event) => event.responseStatus)
          ?.responseStatus ?? stream.lastResponseStatus,
      lastSequence: lastEvent.sequence,
      eventCount: stream.eventCount + args.events.length,
      storedBytes: stream.storedBytes + addedBytes,
      nextChunkIndex: chunkIndex,
      updatedAt: args.nowMs,
      expiresAt: Math.min(
        stream.hardExpiresAt,
        args.nowMs + STELLA_RELAY_RESUME_TTL_MS,
      ),
    });
    await adjustQuota(ctx, GLOBAL_QUOTA_KEY, 0, addedBytes, args.nowMs);
    await adjustQuota(
      ctx,
      ownerQuotaKey(stream.ownerId),
      0,
      addedBytes,
      args.nowMs,
    );
    if (terminal?.terminalStatus && stream.requestBinding) {
      await finalizeRelayBillingReceiptInMutation(ctx, {
        relayRequestId: args.relayRequestId,
        ownerId: stream.ownerId,
        requestBinding: stream.requestBinding,
        terminalStatus: terminal.terminalStatus,
        success: terminal.terminalStatus === "completed",
        durationMs: args.nowMs - stream.createdAt,
        nowMs: args.nowMs,
      });
    }
    return {
      accepted: true,
      status: nextStatus,
    };
  },
});

export const touchRelayResumeStream = internalMutation({
  args: { relayRequestId: v.string(), ownerId: v.string(), nowMs: v.number() },
  returns: v.union(v.literal("not_found"), relayResumeStatusValidator),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream || stream.ownerId !== args.ownerId) return "not_found";
    if (await activeOwnerPurge(ctx, args.ownerId, args.nowMs)) {
      return "canceled";
    }
    if (stream.status === "streaming" && stream.hardExpiresAt > args.nowMs) {
      await ctx.db.patch(stream._id, {
        updatedAt: args.nowMs,
        expiresAt: Math.min(
          stream.hardExpiresAt,
          args.nowMs + STELLA_RELAY_RESUME_TTL_MS,
        ),
      });
    }
    return stream.status;
  },
});

export const getRelayResumeStatus = internalQuery({
  args: { relayRequestId: v.string(), ownerId: v.string() },
  returns: v.union(v.literal("not_found"), relayResumeStatusValidator),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream || stream.ownerId !== args.ownerId) return "not_found";
    return (await activeOwnerPurge(ctx, args.ownerId, Date.now()))
      ? "canceled"
      : stream.status;
  },
});

/**
 * Cheap pre-admission idempotency lookup. Duplicate POSTs use this before
 * anonymous counters, mutable model resolution, or spend-headroom checks, so
 * the same logical request can resume even when the first dispatch consumed
 * the caller's remaining allowance.
 */
export const getRelayResumeReservationState = internalQuery({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    turnId: v.optional(v.string()),
    requestBinding: v.string(),
  },
  returns: v.union(
    v.literal("not_found"),
    v.literal("conflict"),
    v.literal("existing"),
    v.literal("expired"),
  ),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (stream) {
      return stream.ownerId === args.ownerId &&
        (args.turnId === undefined || stream.turnId === args.turnId) &&
        stream.requestBinding === args.requestBinding
        ? "existing"
        : "conflict";
    }
    const receipt = await getRelayBillingReceipt(ctx, args.relayRequestId);
    if (!receipt) return "not_found";
    return receipt.ownerId === args.ownerId &&
      (args.turnId === undefined || receipt.turnId === args.turnId) &&
      receipt.requestBinding === args.requestBinding
      ? "expired"
      : "conflict";
  },
});

export const cancelRelayResumeStream = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    turnId: v.optional(v.string()),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("not_found"),
    v.literal("expired"),
    v.literal("intent_quota"),
    relayResumeStatusValidator,
  ),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream) {
      const existingIntent = await ctx.db
        .query("stella_relay_cancellation_intents")
        .withIndex("by_relayRequestId", (q) =>
          q.eq("relayRequestId", args.relayRequestId),
        )
        .unique();
      if (
        existingIntent?.ownerId !== undefined &&
        existingIntent.ownerId !== args.ownerId
      ) {
        return "not_found";
      }
      if (
        existingIntent &&
        args.turnId !== undefined &&
        existingIntent.turnId !== args.turnId
      ) {
        return "not_found";
      }
      // A deleting owner must not be able to create or extend a tombstone.
      // Check the gate before the idempotent refresh as well as before insert.
      if (await activeOwnerPurge(ctx, args.ownerId, args.nowMs)) {
        return "canceled";
      }
      if (existingIntent) {
        await ctx.db.patch(existingIntent._id, {
          expiresAt: args.nowMs + STELLA_RELAY_CANCEL_INTENT_TTL_MS,
        });
        return "canceled";
      }
      const [globalIntents, ownerIntents] = await Promise.all([
        getQuota(ctx, GLOBAL_INTENT_QUOTA_KEY),
        getQuota(ctx, ownerIntentQuotaKey(args.ownerId)),
      ]);
      if (
        (globalIntents?.streamCount ?? 0) >=
          STELLA_RELAY_RESUME_MAX_GLOBAL_INTENTS ||
        (ownerIntents?.streamCount ?? 0) >=
          STELLA_RELAY_RESUME_MAX_OWNER_INTENTS
      ) {
        return "intent_quota";
      }
      await ctx.db.insert("stella_relay_cancellation_intents", {
        relayRequestId: args.relayRequestId,
        ownerId: args.ownerId,
        turnId: args.turnId,
        createdAt: args.nowMs,
        expiresAt: args.nowMs + STELLA_RELAY_CANCEL_INTENT_TTL_MS,
      });
      await adjustIntentCounts(ctx, args.ownerId, 1, args.nowMs);
      return "canceled";
    }
    if (stream.ownerId !== args.ownerId) return "not_found";
    if (args.turnId !== undefined && stream.turnId !== args.turnId) {
      return "not_found";
    }
    if (stream.expiresAt <= args.nowMs || stream.hardExpiresAt <= args.nowMs) {
      return "expired";
    }
    if (stream.status !== "streaming") return stream.status;
    await ctx.db.patch(stream._id, {
      status: "canceled",
      updatedAt: args.nowMs,
    });
    if (stream.requestBinding) {
      const receipt = await getRelayBillingReceipt(ctx, args.relayRequestId);
      const canceledBeforeDispatch = receipt?.phase === "reserved";
      await finalizeRelayBillingReceiptInMutation(ctx, {
        relayRequestId: args.relayRequestId,
        ownerId: stream.ownerId,
        requestBinding: stream.requestBinding,
        terminalStatus: "canceled",
        success: false,
        durationMs: args.nowMs - stream.createdAt,
        ...(canceledBeforeDispatch
          ? {
              // The upstream was provably never contacted. Preserve the
              // idempotency tombstone while making the charge explicitly zero
              // instead of applying the dispatched-request input fallback.
              actualUsage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                costMicroCents: 0,
              },
              settleBilling: true,
            }
          : {}),
        nowMs: args.nowMs,
      });
    }
    return "canceled";
  },
});

export const finishRelayResumeStream = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    status: v.union(
      v.literal("upstream_eof"),
      v.literal("error"),
      v.literal("truncated"),
    ),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (stream?.ownerId === args.ownerId && stream.status === "streaming") {
      await ctx.db.patch(stream._id, {
        status: args.status,
        updatedAt: args.nowMs,
        expiresAt: Math.min(
          stream.hardExpiresAt,
          args.nowMs + STELLA_RELAY_RESUME_TTL_MS,
        ),
      });
      if (stream.requestBinding) {
        await finalizeRelayBillingReceiptInMutation(ctx, {
          relayRequestId: args.relayRequestId,
          ownerId: stream.ownerId,
          requestBinding: stream.requestBinding,
          terminalStatus: args.status,
          success: false,
          durationMs: args.nowMs - stream.createdAt,
          nowMs: args.nowMs,
        });
      }
    }
    return null;
  },
});

const relayResumePageValidator = v.union(
  v.null(),
  v.object({
    ownerId: v.string(),
    status: relayResumeStatusValidator,
    expiresAt: v.number(),
    hardExpiresAt: v.number(),
    updatedAt: v.number(),
    lastSequence: v.number(),
    responseId: v.optional(v.string()),
    upstreamRequestId: v.optional(v.string()),
    lastEventType: v.optional(v.string()),
    lastResponseStatus: v.optional(v.string()),
    events: v.array(relayResumeStoredEventValidator),
    hasMore: v.boolean(),
    chunksRead: v.number(),
    bytesRead: v.number(),
  }),
);

export const getRelayResumePage = internalQuery({
  args: { relayRequestId: v.string(), startingAfter: v.number() },
  returns: relayResumePageValidator,
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream) return null;
    const chunks = await ctx.db
      .query("stella_relay_response_chunks")
      .withIndex("by_relayRequestId_and_lastSequence", (q) =>
        q
          .eq("relayRequestId", args.relayRequestId)
          .gt("lastSequence", args.startingAfter),
      )
      .order("asc")
      .take(STELLA_RELAY_RESUME_QUERY_MAX_CHUNKS);
    const events = chunks.flatMap((chunk) =>
      chunk.events.filter((event) => event.sequence > args.startingAfter),
    );
    const lastReturnedSequence =
      events[events.length - 1]?.sequence ?? args.startingAfter;
    return {
      ownerId: stream.ownerId,
      status: stream.status,
      expiresAt: stream.expiresAt,
      hardExpiresAt: stream.hardExpiresAt,
      updatedAt: stream.updatedAt,
      lastSequence: stream.lastSequence,
      responseId: stream.responseId,
      upstreamRequestId: stream.upstreamRequestId,
      lastEventType: stream.lastEventType,
      lastResponseStatus: stream.lastResponseStatus,
      events,
      hasMore: lastReturnedSequence < stream.lastSequence,
      chunksRead: chunks.length,
      bytesRead: chunks.reduce((sum, chunk) => sum + chunk.storedBytes, 0),
    };
  },
});

export const acquireRelayResumeLease = internalMutation({
  args: {
    leaseId: v.string(),
    relayRequestId: v.string(),
    ownerId: v.string(),
    turnId: v.optional(v.string()),
    startingAfter: v.number(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("acquired"),
    v.literal("not_found"),
    v.literal("expired"),
    v.literal("cursor_ahead"),
    v.literal("stream_limit"),
    v.literal("owner_limit"),
  ),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream || stream.ownerId !== args.ownerId) return "not_found";
    if (args.turnId !== undefined && stream.turnId !== args.turnId) {
      return "not_found";
    }
    if (await activeOwnerPurge(ctx, args.ownerId, args.nowMs)) {
      return "not_found";
    }
    if (stream.expiresAt <= args.nowMs || stream.hardExpiresAt <= args.nowMs) {
      return "expired";
    }
    if (args.startingAfter > stream.lastSequence) return "cursor_ahead";

    const [streamLeases, ownerLeases] = await Promise.all([
      ctx.db
        .query("stella_relay_response_leases")
        .withIndex("by_relayRequestId_and_expiresAt", (q) =>
          q
            .eq("relayRequestId", args.relayRequestId)
            .gt("expiresAt", args.nowMs),
        )
        .take(STELLA_RELAY_RESUME_MAX_STREAM_LEASES + 1),
      ctx.db
        .query("stella_relay_response_leases")
        .withIndex("by_ownerId_and_expiresAt", (q) =>
          q.eq("ownerId", args.ownerId).gt("expiresAt", args.nowMs),
        )
        .take(STELLA_RELAY_RESUME_MAX_OWNER_LEASES + 1),
    ]);
    if (streamLeases.length >= STELLA_RELAY_RESUME_MAX_STREAM_LEASES) {
      return "stream_limit";
    }
    if (ownerLeases.length >= STELLA_RELAY_RESUME_MAX_OWNER_LEASES) {
      return "owner_limit";
    }
    await ctx.db.insert("stella_relay_response_leases", {
      leaseId: args.leaseId,
      relayRequestId: args.relayRequestId,
      ownerId: args.ownerId,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
      expiresAt: args.nowMs + STELLA_RELAY_RESUME_LEASE_TTL_MS,
    });
    return "acquired";
  },
});

export const refreshRelayResumeLease = internalMutation({
  args: { leaseId: v.string(), ownerId: v.string(), nowMs: v.number() },
  returns: v.union(
    v.object({ accessExpiresAt: v.number() }),
    v.literal("not_found"),
    v.literal("expired"),
  ),
  handler: async (ctx, args) => {
    const lease = await ctx.db
      .query("stella_relay_response_leases")
      .withIndex("by_leaseId", (q) => q.eq("leaseId", args.leaseId))
      .unique();
    if (!lease || lease.ownerId !== args.ownerId) return "not_found";
    if (lease.expiresAt <= args.nowMs) return "expired";
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", lease.relayRequestId),
      )
      .unique();
    if (!stream || stream.ownerId !== args.ownerId) return "not_found";
    if (await activeOwnerPurge(ctx, args.ownerId, args.nowMs)) {
      return "not_found";
    }
    const accessExpiresAt = Math.min(stream.expiresAt, stream.hardExpiresAt);
    if (accessExpiresAt <= args.nowMs) return "expired";
    await ctx.db.patch(lease._id, {
      updatedAt: args.nowMs,
      expiresAt: args.nowMs + STELLA_RELAY_RESUME_LEASE_TTL_MS,
    });
    return { accessExpiresAt };
  },
});

export const releaseRelayResumeLease = internalMutation({
  args: { leaseId: v.string(), ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lease = await ctx.db
      .query("stella_relay_response_leases")
      .withIndex("by_leaseId", (q) => q.eq("leaseId", args.leaseId))
      .unique();
    if (lease?.ownerId === args.ownerId) await ctx.db.delete(lease._id);
    return null;
  },
});

const recordCleanupState = async (
  ctx: MutationCtx,
  args: {
    nowMs: number;
    oldestExpiredAt?: number;
    deletedDocuments: number;
    deletedBytes: number;
  },
) => {
  const existing = await ctx.db
    .query("stella_relay_resume_cleanup_state")
    .withIndex("by_key", (q) => q.eq("key", CLEANUP_STATE_KEY))
    .unique();
  const patch = {
    lastSweepAt: args.nowMs,
    lastSuccessfulSweepAt: args.nowMs,
    oldestObservedExpiredAt: args.oldestExpiredAt,
    lastObservedLagMs: args.oldestExpiredAt
      ? Math.max(0, args.nowMs - args.oldestExpiredAt)
      : 0,
    consecutiveFailures: 0,
    lastFailureAt: undefined,
    lastFailureCode: undefined,
    lastDeletedDocuments: args.deletedDocuments,
    lastDeletedBytes: args.deletedBytes,
  };
  if (existing) await ctx.db.patch(existing._id, patch);
  else
    await ctx.db.insert("stella_relay_resume_cleanup_state", {
      key: CLEANUP_STATE_KEY,
      ...patch,
    });
};

export const cleanupRelayResumeBatch = internalMutation({
  args: { nowMs: v.number() },
  returns: v.object({
    deletedDocuments: v.number(),
    deletedBytes: v.number(),
    hasMore: v.boolean(),
    oldestExpiredAt: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    let deletedDocuments = 0;
    let deletedBytes = 0;

    // Per-class budgets keep the sweep fair: a tombstone or lease backlog can
    // never starve stream/chunk deletion, which always receives the remaining
    // document budget below.
    const expiredCancellationIntents = await ctx.db
      .query("stella_relay_cancellation_intents")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.nowMs))
      .take(STELLA_RELAY_CLEANUP_MAX_INTENT_DOCS);
    for (const intent of expiredCancellationIntents) {
      await deleteIntent(ctx, intent, args.nowMs);
      deletedDocuments += 1;
    }

    const expiredLeases = await ctx.db
      .query("stella_relay_response_leases")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.nowMs))
      .take(STELLA_RELAY_CLEANUP_MAX_LEASE_DOCS);
    for (const lease of expiredLeases) {
      await ctx.db.delete(lease._id);
      deletedDocuments += 1;
    }

    const expiredPurges = await ctx.db
      .query("stella_relay_owner_purges")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.nowMs))
      .take(STELLA_RELAY_CLEANUP_MAX_PURGE_DOCS);
    for (const purge of expiredPurges) {
      await ctx.db.delete(purge._id);
      deletedDocuments += 1;
    }

    const expiredBillingReceipts = await ctx.db
      .query("stella_relay_billing_receipts")
      .withIndex("by_hardExpiresAt", (q) => q.lte("hardExpiresAt", args.nowMs))
      .take(STELLA_RELAY_CLEANUP_MAX_BILLING_DOCS);
    for (const receipt of expiredBillingReceipts) {
      if (receipt.billingAuthority === "managed_dispatch") {
        // The generic physical-attempt receipt is the sole charging authority.
        // This row remains only as the resumable request's idempotency tombstone
        // and is safe to remove once that retention window expires.
        await ctx.db.delete(receipt._id);
        deletedDocuments += 1;
        continue;
      }
      if (receipt.billedAt !== undefined || receipt.phase === "reserved") {
        // Reserved-only work never reached the upstream. Billed receipts have
        // already served their idempotency tombstone window.
        await ctx.db.delete(receipt._id);
        deletedDocuments += 1;
        continue;
      }
      if (receipt.phase === "terminal" && receipt.billingReady === true) {
        await ctx.scheduler.runAfter(
          0,
          internal.stella_provider.relay_resume_store
            .deliverRelayBillingReceipt,
          {
            relayRequestId: receipt.relayRequestId,
            requestBinding: receipt.requestBinding,
          },
        );
      } else {
        // An action that died after dispatch but before its terminal callback
        // still owes at most the conservative failed-request fallback.
        await finalizeRelayBillingReceiptInMutation(ctx, {
          relayRequestId: receipt.relayRequestId,
          ownerId: receipt.ownerId,
          requestBinding: receipt.requestBinding,
          terminalStatus: "error",
          success: false,
          durationMs: Math.max(0, args.nowMs - receipt.createdAt),
          nowMs: args.nowMs,
          settleBilling: true,
        });
      }
      // Never discard an unbilled terminal receipt merely because its normal
      // idempotency TTL elapsed. Give durable delivery another bounded window.
      await ctx.db.patch(receipt._id, {
        hardExpiresAt: args.nowMs + RELAY_BILLING_DELIVERY_RETRY_TTL_MS,
        updatedAt: args.nowMs,
      });
    }

    const [expiredStream] = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.nowMs))
      .take(1);
    const expiredTimestamps = [
      expiredCancellationIntents[0]?.expiresAt,
      expiredStream?.expiresAt,
      expiredLeases[0]?.expiresAt,
      expiredPurges[0]?.expiresAt,
      expiredBillingReceipts[0]?.hardExpiresAt,
    ].filter((value): value is number => value !== undefined);
    let oldestExpiredAt =
      expiredTimestamps.length > 0 ? Math.min(...expiredTimestamps) : undefined;
    if (expiredStream && deletedDocuments < STELLA_RELAY_CLEANUP_MAX_DOCS) {
      const chunks = await ctx.db
        .query("stella_relay_response_chunks")
        .withIndex("by_relayRequestId_and_chunkIndex", (q) =>
          q.eq("relayRequestId", expiredStream.relayRequestId),
        )
        .take(STELLA_RELAY_CLEANUP_MAX_DOCS - deletedDocuments);
      for (const chunk of chunks) {
        if (
          deletedDocuments > 0 &&
          deletedBytes + chunk.storedBytes > STELLA_RELAY_CLEANUP_MAX_BYTES
        ) {
          break;
        }
        await ctx.db.delete(chunk._id);
        deletedDocuments += 1;
        deletedBytes += chunk.storedBytes;
      }
      if (chunks.length === 0) {
        await releaseStreamQuota(ctx, expiredStream, args.nowMs);
        await ctx.db.delete(expiredStream._id);
        deletedDocuments += 1;
      }
    }

    if (!expiredStream && deletedDocuments < STELLA_RELAY_CLEANUP_MAX_DOCS) {
      const orphanChunks = await ctx.db
        .query("stella_relay_response_chunks")
        .withIndex("by_hardExpiresAt", (q) =>
          q.lte("hardExpiresAt", args.nowMs),
        )
        .take(STELLA_RELAY_CLEANUP_MAX_DOCS - deletedDocuments);
      oldestExpiredAt ??= orphanChunks[0]?.hardExpiresAt;
      for (const chunk of orphanChunks) {
        if (
          deletedDocuments > 0 &&
          deletedBytes + chunk.storedBytes > STELLA_RELAY_CLEANUP_MAX_BYTES
        ) {
          break;
        }
        await ctx.db.delete(chunk._id);
        deletedDocuments += 1;
        deletedBytes += chunk.storedBytes;
      }
    }

    const hasMore = deletedDocuments > 0;
    await recordCleanupState(ctx, {
      nowMs: args.nowMs,
      oldestExpiredAt,
      deletedDocuments,
      deletedBytes,
    });
    return { deletedDocuments, deletedBytes, hasMore, oldestExpiredAt };
  },
});

export const recordRelayResumeCleanupFailure = internalMutation({
  args: { nowMs: v.number(), failureCode: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("stella_relay_resume_cleanup_state")
      .withIndex("by_key", (q) => q.eq("key", CLEANUP_STATE_KEY))
      .unique();
    const patch = {
      lastSweepAt: args.nowMs,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      lastFailureAt: args.nowMs,
      lastFailureCode: args.failureCode.slice(0, 100),
      lastDeletedDocuments: 0,
      lastDeletedBytes: 0,
      lastObservedLagMs: existing?.lastObservedLagMs ?? 0,
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else {
      await ctx.db.insert("stella_relay_resume_cleanup_state", {
        key: CLEANUP_STATE_KEY,
        ...patch,
      });
    }
    return null;
  },
});

export const drainExpiredRelayResumeStreams = internalAction({
  args: { nowMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now();
    try {
      for (
        let batch = 0;
        batch < STELLA_RELAY_CLEANUP_MAX_BATCHES;
        batch += 1
      ) {
        const result: { hasMore: boolean } = await ctx.runMutation(
          internal.stella_provider.relay_resume_store.cleanupRelayResumeBatch,
          { nowMs },
        );
        if (!result.hasMore) return null;
      }
      await ctx.scheduler.runAfter(
        100,
        internal.stella_provider.relay_resume_store
          .drainExpiredRelayResumeStreams,
        { nowMs },
      );
    } catch (error) {
      await ctx.runMutation(
        internal.stella_provider.relay_resume_store
          .recordRelayResumeCleanupFailure,
        {
          nowMs: Date.now(),
          failureCode: error instanceof Error ? error.name : "unknown",
        },
      );
      await ctx.scheduler.runAfter(
        5_000,
        internal.stella_provider.relay_resume_store
          .drainExpiredRelayResumeStreams,
        {},
      );
    }
    return null;
  },
});

/**
 * Open the owner purge gate. While the gate is active every mutation that
 * could create or extend this owner's relay resume data (stream reservation,
 * event appends, tombstone writes, resume leases) is transactionally refused,
 * which makes the drain below race-free against in-flight relay work.
 */
export const beginOwnerRelayResumePurge = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const existing = await ctx.db
      .query("stella_relay_owner_purges")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    const expiresAt = args.nowMs + STELLA_RELAY_OWNER_PURGE_TTL_MS;
    if (existing) await ctx.db.patch(existing._id, { expiresAt });
    else {
      await ctx.db.insert("stella_relay_owner_purges", {
        ownerId: args.ownerId,
        createdAt: args.nowMs,
        expiresAt,
      });
    }
    return null;
  },
});

/**
 * Close the owner purge gate after a completed cloud-data reset so the owner
 * can use relay resume again. Account deletion leaves the gate in place; the
 * cleanup sweep removes it after `STELLA_RELAY_OWNER_PURGE_TTL_MS`.
 */
export const finishOwnerRelayResumePurge = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ...args,
      stage: "cloud",
      mode: "reset",
    });
    const existing = await ctx.db
      .query("stella_relay_owner_purges")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

export const deleteOwnerRelayResumeBatch = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    nowMs: v.number(),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const billingReceipts = await ctx.db
      .query("stella_relay_billing_receipts")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(STELLA_RELAY_CLEANUP_MAX_DOCS);
    if (billingReceipts.length > 0) {
      await Promise.all(
        billingReceipts.map((receipt) => ctx.db.delete(receipt._id)),
      );
      return { hasMore: true };
    }
    const cancellationIntents = await ctx.db
      .query("stella_relay_cancellation_intents")
      .withIndex("by_ownerId_and_expiresAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(STELLA_RELAY_CLEANUP_MAX_DOCS);
    if (cancellationIntents.length > 0) {
      for (const intent of cancellationIntents) {
        await deleteIntent(ctx, intent, args.nowMs);
      }
      return { hasMore: true };
    }

    // Leases are owner-indexed independently of their stream. Drain that
    // index first so a partially deleted/corrupt stream cannot orphan a lease
    // containing owner-linked relay state after reset or account deletion.
    const ownerLeases = await ctx.db
      .query("stella_relay_response_leases")
      .withIndex("by_ownerId_and_expiresAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(STELLA_RELAY_CLEANUP_MAX_DOCS);
    if (ownerLeases.length > 0) {
      await Promise.all(ownerLeases.map((lease) => ctx.db.delete(lease._id)));
      return { hasMore: true };
    }

    const [stream] = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(1);
    if (!stream) {
      const quota = await getQuota(ctx, ownerQuotaKey(args.ownerId));
      if (quota) await ctx.db.delete(quota._id);
      const intentQuota = await getQuota(
        ctx,
        ownerIntentQuotaKey(args.ownerId),
      );
      if (intentQuota) await ctx.db.delete(intentQuota._id);
      return { hasMore: false };
    }

    const leases = await ctx.db
      .query("stella_relay_response_leases")
      .withIndex("by_relayRequestId_and_expiresAt", (q) =>
        q.eq("relayRequestId", stream.relayRequestId),
      )
      .take(STELLA_RELAY_CLEANUP_MAX_DOCS);
    await Promise.all(leases.map((lease) => ctx.db.delete(lease._id)));

    const remainingDocumentBudget =
      STELLA_RELAY_CLEANUP_MAX_DOCS - leases.length;
    const chunks =
      remainingDocumentBudget > 0
        ? await ctx.db
            .query("stella_relay_response_chunks")
            .withIndex("by_relayRequestId_and_chunkIndex", (q) =>
              q.eq("relayRequestId", stream.relayRequestId),
            )
            .take(remainingDocumentBudget)
        : [];
    let deletedBytes = 0;
    let deletedChunks = 0;
    for (const chunk of chunks) {
      if (
        deletedChunks > 0 &&
        deletedBytes + chunk.storedBytes > STELLA_RELAY_CLEANUP_MAX_BYTES
      ) {
        break;
      }
      await ctx.db.delete(chunk._id);
      deletedBytes += chunk.storedBytes;
      deletedChunks += 1;
    }
    if (remainingDocumentBudget > 0 && chunks.length === 0) {
      await releaseStreamQuota(ctx, stream, args.nowMs);
      await ctx.db.delete(stream._id);
    }
    return { hasMore: true };
  },
});
