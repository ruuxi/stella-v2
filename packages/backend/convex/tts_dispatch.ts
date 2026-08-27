import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  assertOwnerMigrationWriteAllowed,
  hasOwnerMigrationWriteFence,
} from "./auth";
import { assertOwnerPurgeLease } from "./owner_lifecycle";
import {
  internalTtsUsageStatusValidator,
  ttsProviderDispatchKindValidator,
  ttsProviderDispatchOutcomeValidator,
  ttsProviderDispatchStateValidator,
} from "./schema/billing";
import { ownerPurgeModeValidator } from "./schema/owner_lifecycle";
import {
  computeInworldTtsCostMicroCents,
  computeTtsUsageCostMicroCents,
} from "./lib/billing_money";

/**
 * Workers must heartbeat more frequently than this. Missing the soft deadline
 * stops cooperative work, but does not by itself prove that a fetch has ended.
 */
export const TTS_DISPATCH_HEARTBEAT_LEASE_MS = 90_000;

/**
 * Provider AbortControllers must use the returned `hardExpiresAt` as their
 * absolute deadline. This remains below Convex's action lifetime so the worker
 * has time to cancel its response body and release the exact attempt.
 */
export const TTS_DISPATCH_HARD_DEADLINE_MS = 8 * 60_000;

/**
 * A crashed worker is presumed quiescent only after its provider abort deadline
 * plus this grace. Reset/deletion retains the row as cleanup debt until then.
 */
export const TTS_DISPATCH_ABORT_GRACE_MS = 30_000;

const DEFAULT_PURGE_BATCH = 24;
const MAX_PURGE_BATCH = 64;
const MAX_PENDING_PREVIEW = 8;

export type TtsProviderDispatchOutcome =
  | "settled"
  | "not_dispatched"
  | "may_have_dispatched";

export type TtsDispatchUsageEnvelope = {
  provider: "inworld" | "openai";
  model: string;
  voice?: string;
  conversationId?: Doc<"conversations">["_id"];
  streaming: boolean;
  requestChars: number;
  textInputTokens?: number;
  audioOutputTokens?: number;
};

export type TtsDispatchUsageSettlement = {
  status: "completed" | "failed" | "interrupted" | "partial";
  synthesizedChars: number;
  audioBytes: number;
  textInputTokens?: number;
  audioOutputTokens?: number;
  durationMs: number;
};

const dispatchStateValidator = v.union(
  v.literal("active"),
  v.literal("cancel_requested"),
);

const reserveStatusValidator = v.union(
  v.literal("reserved"),
  v.literal("busy"),
  v.literal("canceled"),
  v.literal("completed"),
);

const reserveResultValidator = v.object({
  acquired: v.boolean(),
  status: reserveStatusValidator,
  leaseExpiresAt: v.number(),
  hardExpiresAt: v.number(),
  quiescentAfterAt: v.number(),
});

const pollResultValidator = v.object({
  found: v.boolean(),
  allowed: v.boolean(),
  cancelRequested: v.boolean(),
  state: v.union(dispatchStateValidator, v.null()),
  leaseExpiresAt: v.union(v.number(), v.null()),
  hardExpiresAt: v.union(v.number(), v.null()),
  quiescentAfterAt: v.union(v.number(), v.null()),
});

const usageEnvelopeValidator = v.object({
  provider: v.union(v.literal("inworld"), v.literal("openai")),
  model: v.string(),
  voice: v.optional(v.string()),
  conversationId: v.optional(v.id("conversations")),
  streaming: v.boolean(),
  requestChars: v.number(),
  textInputTokens: v.optional(v.number()),
  audioOutputTokens: v.optional(v.number()),
});

const usageSettlementValidator = v.object({
  status: internalTtsUsageStatusValidator,
  synthesizedChars: v.number(),
  audioBytes: v.number(),
  textInputTokens: v.optional(v.number()),
  audioOutputTokens: v.optional(v.number()),
  durationMs: v.number(),
});

const quiesceResultValidator = v.object({
  ready: v.boolean(),
  canceled: v.number(),
  reaped: v.number(),
  pending: v.array(v.string()),
  retryAt: v.union(v.number(), v.null()),
});

const clampBatch = (limit: number | undefined): number =>
  Math.min(
    MAX_PURGE_BATCH,
    Math.max(1, Math.floor(limit ?? DEFAULT_PURGE_BATCH)),
  );

const validateLeaseIds = (dispatchId: string, attemptId: string): void => {
  if (!dispatchId.trim() || !attemptId.trim()) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "TTS dispatch and attempt ids are required.",
    });
  }
};

const dispatchConflict = () =>
  new ConvexError({
    code: "TTS_DISPATCH_IDEMPOTENCY_CONFLICT",
    message: "The TTS dispatch id is already bound to different work.",
  });

const readDispatch = async (ctx: Pick<QueryCtx, "db">, dispatchId: string) =>
  await ctx.db
    .query("tts_provider_dispatch_leases")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", dispatchId))
    .unique();

const readExactAttempt = async (
  ctx: Pick<QueryCtx, "db">,
  dispatchId: string,
  attemptId: string,
) =>
  await ctx.db
    .query("tts_provider_dispatch_leases")
    .withIndex("by_dispatchId_and_attemptId", (q) =>
      q.eq("dispatchId", dispatchId).eq("attemptId", attemptId),
    )
    .unique();

type TtsDispatchRow = Doc<"tts_provider_dispatch_leases">;

const effectiveLeaseId = (row: TtsDispatchRow): string => row.leaseId;

const effectiveProviderState = (
  row: TtsDispatchRow,
): "reserved" | "may_have_dispatched" => row.providerState;

const requireBoundedDispatchString = (
  value: string,
  label: string,
  maxLength = 256,
): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Invalid TTS ${label}.`,
    });
  }
  return normalized;
};

const boundedWholeNumber = (value: number, max: number): number =>
  Math.min(max, Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));

const normalizeUsageEnvelope = (
  usage: TtsDispatchUsageEnvelope,
): TtsDispatchUsageEnvelope => ({
  provider: usage.provider,
  model: requireBoundedDispatchString(usage.model, "model"),
  ...(usage.voice !== undefined
    ? { voice: requireBoundedDispatchString(usage.voice, "voice") }
    : {}),
  ...(usage.conversationId ? { conversationId: usage.conversationId } : {}),
  streaming: usage.streaming,
  requestChars: boundedWholeNumber(usage.requestChars, 100_000),
  ...(usage.textInputTokens !== undefined
    ? { textInputTokens: boundedWholeNumber(usage.textInputTokens, 10_000_000) }
    : {}),
  ...(usage.audioOutputTokens !== undefined
    ? {
        audioOutputTokens: boundedWholeNumber(
          usage.audioOutputTokens,
          10_000_000,
        ),
      }
    : {}),
});

const usageCostMicroCents = (args: {
  provider: "inworld" | "openai";
  model: string;
  synthesizedChars: number;
  textInputTokens: number;
  audioOutputTokens: number;
}): number =>
  args.provider === "inworld"
    ? computeInworldTtsCostMicroCents({
        model: args.model,
        chars: args.synthesizedChars,
      })
    : computeTtsUsageCostMicroCents({
        model: args.model,
        textInputTokens: args.textInputTokens,
        audioOutputTokens: args.audioOutputTokens,
      });

const updateUsageReceipt = async (
  ctx: MutationCtx,
  row: TtsDispatchRow,
  args: {
    outcome: TtsProviderDispatchOutcome;
    now: number;
    settlement?: TtsDispatchUsageSettlement;
  },
): Promise<void> => {
  const usage = await ctx.db.get(row.usageId);
  if (!usage) {
    throw new Error("TTS provider dispatch lost its durable usage receipt.");
  }
  if (
    usage.ownerId !== row.ownerId ||
    (usage.ownerGeneration ?? "legacy") !== row.ownerGeneration ||
    usage.dispatchId !== row.dispatchId ||
    usage.attemptId !== row.attemptId ||
    usage.leaseId !== effectiveLeaseId(row)
  ) {
    throw new Error("TTS usage receipt lost exact attempt authority.");
  }

  if (args.outcome === "not_dispatched") {
    if (effectiveProviderState(row) !== "reserved") {
      throw new Error("A dispatched TTS attempt cannot become not-dispatched.");
    }
    await ctx.db.patch(usage._id, {
      providerDispatchOutcome: "not_dispatched",
      status: "failed",
      synthesizedChars: 0,
      audioBytes: 0,
      textInputTokens: 0,
      audioOutputTokens: 0,
      costMicroCents: 0,
      durationMs: Math.max(0, args.now - usage.createdAt),
    });
    return;
  }

  if (args.outcome === "may_have_dispatched") {
    const audioBytes = boundedWholeNumber(
      Math.max(usage.audioBytes, args.settlement?.audioBytes ?? 0),
      1_000_000_000,
    );
    const synthesizedChars = usage.requestChars;
    const textInputTokens = Math.max(
      usage.requestedTextInputTokens ?? usage.textInputTokens,
      Math.ceil(usage.requestChars / 4),
    );
    const audioOutputTokens = Math.max(
      usage.requestedAudioOutputTokens ?? 0,
      usage.audioOutputTokens,
    );
    await ctx.db.patch(usage._id, {
      providerDispatchOutcome: "may_have_dispatched",
      status: audioBytes > 0 ? "partial" : "interrupted",
      synthesizedChars,
      audioBytes,
      textInputTokens,
      audioOutputTokens,
      costMicroCents: usageCostMicroCents({
        provider: usage.provider,
        model: usage.model,
        synthesizedChars,
        textInputTokens,
        audioOutputTokens,
      }),
      durationMs: Math.max(
        usage.durationMs,
        boundedWholeNumber(
          args.settlement?.durationMs ?? args.now - usage.createdAt,
          TTS_DISPATCH_HARD_DEADLINE_MS + TTS_DISPATCH_ABORT_GRACE_MS,
        ),
      ),
    });
    return;
  }

  if (!args.settlement) {
    throw new Error("Settled TTS usage requires a terminal disposition.");
  }
  const synthesizedChars = Math.min(
    usage.requestChars,
    boundedWholeNumber(args.settlement.synthesizedChars, usage.requestChars),
  );
  const audioBytes = boundedWholeNumber(
    args.settlement.audioBytes,
    1_000_000_000,
  );
  const textInputTokens = boundedWholeNumber(
    args.settlement.textInputTokens ?? Math.ceil(synthesizedChars / 4),
    10_000_000,
  );
  const audioOutputTokens = boundedWholeNumber(
    args.settlement.audioOutputTokens ?? 0,
    10_000_000,
  );
  await ctx.db.patch(usage._id, {
    providerDispatchOutcome: "settled",
    status: args.settlement.status,
    synthesizedChars,
    audioBytes,
    textInputTokens,
    audioOutputTokens,
    costMicroCents: usageCostMicroCents({
      provider: usage.provider,
      model: usage.model,
      synthesizedChars,
      textInputTokens,
      audioOutputTokens,
    }),
    durationMs: boundedWholeNumber(
      args.settlement.durationMs,
      TTS_DISPATCH_HARD_DEADLINE_MS + TTS_DISPATCH_ABORT_GRACE_MS,
    ),
  });
};

const finalizeAndDeleteDispatch = async (
  ctx: MutationCtx,
  row: TtsDispatchRow,
  args: {
    outcome: "settled" | "not_dispatched";
    now: number;
    settlement?: TtsDispatchUsageSettlement;
  },
): Promise<void> => {
  await updateUsageReceipt(ctx, row, args);
  await ctx.scheduler.cancel(row.cleanupJobId);
  await ctx.db.delete(row._id);
};

/**
 * Transactional provider admission. Reading the migration and lifecycle rows
 * in the same mutation as this insert gives reset/deletion a serializable
 * ordering against provider dispatch. A different attempt cannot take over
 * until the prior action's hard deadline and abort grace have elapsed.
 */
export const reserveTtsProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    kind: ttsProviderDispatchKindValidator,
    usage: usageEnvelopeValidator,
    now: v.number(),
  },
  returns: reserveResultValidator,
  handler: async (ctx, args) => {
    validateLeaseIds(args.dispatchId, args.attemptId);
    const leaseId = requireBoundedDispatchString(args.leaseId, "lease id");
    const usage = normalizeUsageEnvelope(args.usage);
    if ((args.kind === "oneshot_openai") !== (usage.provider === "openai")) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "TTS dispatch kind does not match its provider receipt.",
      });
    }
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );

    const existing = await readDispatch(ctx, args.dispatchId);
    if (existing) {
      if (existing.ownerId !== args.ownerId) {
        throw dispatchConflict();
      }
      if (existing.attemptId === args.attemptId) {
        if (
          existing.kind !== args.kind ||
          existing.ownerGeneration !== args.ownerGeneration ||
          effectiveLeaseId(existing) !== leaseId
        ) {
          throw dispatchConflict();
        }
        return {
          acquired: false,
          status:
            existing.state === "cancel_requested"
              ? ("canceled" as const)
              : ("busy" as const),
          leaseExpiresAt: existing.leaseExpiresAt,
          hardExpiresAt: existing.hardExpiresAt,
          quiescentAfterAt: existing.quiescentAfterAt,
        };
      }

      if (args.now < existing.quiescentAfterAt) {
        return {
          acquired: false,
          status:
            existing.state === "cancel_requested"
              ? ("canceled" as const)
              : ("busy" as const),
          leaseExpiresAt: existing.leaseExpiresAt,
          hardExpiresAt: existing.hardExpiresAt,
          quiescentAfterAt: existing.quiescentAfterAt,
        };
      }
      await updateUsageReceipt(ctx, existing, {
        outcome:
          effectiveProviderState(existing) === "reserved"
            ? "not_dispatched"
            : "may_have_dispatched",
        now: args.now,
      });
      await ctx.scheduler.cancel(existing.cleanupJobId);
      await ctx.db.delete(existing._id);
    }

    // A clean completed provider receipt is the durable idempotency tombstone
    // for a logical read-aloud operation. If the HTTP response to the client
    // was lost after provider EOF, a stream-to-one-shot fallback must not pay
    // for the same speech again. Settled failures, pre-dispatch failures, and
    // quiesced ambiguity remain retryable.
    const completedReceipt = await ctx.db
      .query("internal_tts_usage")
      .withIndex(
        "by_ownerId_and_dispatchId_and_providerDispatchOutcome_and_status",
        (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("dispatchId", args.dispatchId)
            .eq("providerDispatchOutcome", "settled")
            .eq("status", "completed"),
      )
      .first();
    if (completedReceipt) {
      return {
        acquired: false,
        status: "completed" as const,
        leaseExpiresAt: args.now,
        hardExpiresAt: args.now,
        quiescentAfterAt: args.now,
      };
    }

    const leaseExpiresAt = args.now + TTS_DISPATCH_HEARTBEAT_LEASE_MS;
    const hardExpiresAt = args.now + TTS_DISPATCH_HARD_DEADLINE_MS;
    const quiescentAfterAt = hardExpiresAt + TTS_DISPATCH_ABORT_GRACE_MS;
    const cleanupJobId = await ctx.scheduler.runAt(
      quiescentAfterAt,
      internal.tts_dispatch.expireTtsProviderDispatchInternal,
      {
        dispatchId: args.dispatchId,
        attemptId: args.attemptId,
        leaseId,
        quiescentAfterAt,
      },
    );
    const usageId = await ctx.db.insert("internal_tts_usage", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      dispatchId: args.dispatchId,
      attemptId: args.attemptId,
      leaseId,
      provider: usage.provider,
      model: usage.model,
      ...(usage.voice ? { voice: usage.voice } : {}),
      ...(usage.conversationId ? { conversationId: usage.conversationId } : {}),
      streaming: usage.streaming,
      status: "failed",
      requestChars: usage.requestChars,
      ...(usage.textInputTokens !== undefined
        ? { requestedTextInputTokens: usage.textInputTokens }
        : {}),
      ...(usage.audioOutputTokens !== undefined
        ? { requestedAudioOutputTokens: usage.audioOutputTokens }
        : {}),
      synthesizedChars: 0,
      audioBytes: 0,
      textInputTokens: 0,
      audioOutputTokens: 0,
      costMicroCents: 0,
      durationMs: 0,
      createdAt: args.now,
    });
    await ctx.db.insert("tts_provider_dispatch_leases", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      dispatchId: args.dispatchId,
      attemptId: args.attemptId,
      leaseId,
      kind: args.kind,
      state: "active",
      providerState: "reserved",
      usageId,
      leaseExpiresAt,
      hardExpiresAt,
      quiescentAfterAt,
      cleanupJobId,
      lastHeartbeatAt: args.now,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return {
      acquired: true,
      status: "reserved" as const,
      leaseExpiresAt,
      hardExpiresAt,
      quiescentAfterAt,
    };
  },
});

/**
 * Point-of-no-return transaction immediately before provider fetch. The exact
 * attempt, lifecycle generation, both migration roles, and pessimistic spend
 * receipt move together, so a subsequent crash cannot erase possible spend.
 */
export const markTtsProviderDispatchMayHaveStartedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactAttempt(ctx, args.dispatchId, args.attemptId);
    if (!row) return false;
    if (
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      effectiveLeaseId(row) !== args.leaseId
    ) {
      throw new Error("TTS provider marker lost exact attempt authority.");
    }
    if (row.state !== "active") {
      throw new Error("TTS provider attempt was canceled before dispatch.");
    }
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    if (effectiveProviderState(row) === "may_have_dispatched") return true;
    const usage = await ctx.db.get(row.usageId);
    if (
      !usage ||
      usage.ownerId !== row.ownerId ||
      (usage.ownerGeneration ?? "legacy") !== row.ownerGeneration ||
      usage.dispatchId !== row.dispatchId ||
      usage.attemptId !== row.attemptId ||
      usage.leaseId !== effectiveLeaseId(row)
    ) {
      throw new Error("TTS provider marker lost its usage receipt.");
    }

    const synthesizedChars = usage.requestChars;
    const textInputTokens = Math.max(
      usage.requestedTextInputTokens ?? usage.textInputTokens,
      Math.ceil(usage.requestChars / 4),
    );
    const audioOutputTokens = Math.max(
      usage.requestedAudioOutputTokens ?? 0,
      usage.audioOutputTokens,
    );
    await ctx.db.patch(usage._id, {
      providerDispatchOutcome: "may_have_dispatched",
      status: "interrupted",
      synthesizedChars,
      textInputTokens,
      audioOutputTokens,
      costMicroCents: usageCostMicroCents({
        provider: usage.provider,
        model: usage.model,
        synthesizedChars,
        textInputTokens,
        audioOutputTokens,
      }),
      durationMs: Math.max(0, args.now - usage.createdAt),
    });
    await ctx.db.patch(row._id, {
      providerState: "may_have_dispatched",
      updatedAt: args.now,
    });
    return true;
  },
});

/**
 * Exact-attempt liveness update. A lifecycle or migration fence is converted
 * into a cancellation result and the lease is never extended past its fixed
 * provider deadline.
 */
export const heartbeatTtsProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: pollResultValidator,
  handler: async (ctx, args) => {
    const row = await readExactAttempt(ctx, args.dispatchId, args.attemptId);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      effectiveLeaseId(row) !== args.leaseId
    ) {
      return {
        found: false,
        allowed: false,
        cancelRequested: true,
        state: null,
        leaseExpiresAt: null,
        hardExpiresAt: null,
        quiescentAfterAt: null,
      };
    }

    if (
      row.state !== "active" ||
      args.now >= row.leaseExpiresAt ||
      args.now >= row.hardExpiresAt
    ) {
      return {
        found: true,
        allowed: false,
        cancelRequested: true,
        state: row.state,
        leaseExpiresAt: row.leaseExpiresAt,
        hardExpiresAt: row.hardExpiresAt,
        quiescentAfterAt: row.quiescentAfterAt,
      };
    }

    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      await ctx.db.patch(row._id, {
        state: "cancel_requested",
        leaseExpiresAt: Math.min(row.leaseExpiresAt, args.now),
        cancelRequestedAt: args.now,
        updatedAt: args.now,
      });
      return {
        found: true,
        allowed: false,
        cancelRequested: true,
        state: "cancel_requested" as const,
        leaseExpiresAt: Math.min(row.leaseExpiresAt, args.now),
        hardExpiresAt: row.hardExpiresAt,
        quiescentAfterAt: row.quiescentAfterAt,
      };
    }

    const leaseExpiresAt = Math.min(
      row.hardExpiresAt,
      args.now + TTS_DISPATCH_HEARTBEAT_LEASE_MS,
    );
    await ctx.db.patch(row._id, {
      leaseExpiresAt,
      lastHeartbeatAt: args.now,
      updatedAt: args.now,
    });
    return {
      found: true,
      allowed: true,
      cancelRequested: false,
      state: "active" as const,
      leaseExpiresAt,
      hardExpiresAt: row.hardExpiresAt,
      quiescentAfterAt: row.quiescentAfterAt,
    };
  },
});

/** Read-only cooperative cancellation poll for a provider action. */
export const pollTtsProviderDispatchInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: pollResultValidator,
  handler: async (ctx, args) => {
    const row = await readExactAttempt(ctx, args.dispatchId, args.attemptId);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      effectiveLeaseId(row) !== args.leaseId
    ) {
      return {
        found: false,
        allowed: false,
        cancelRequested: true,
        state: null,
        leaseExpiresAt: null,
        hardExpiresAt: null,
        quiescentAfterAt: null,
      };
    }

    let ownerAllowed = true;
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      ownerAllowed = false;
    }
    const allowed =
      ownerAllowed &&
      row.state === "active" &&
      args.now < row.leaseExpiresAt &&
      args.now < row.hardExpiresAt;
    return {
      found: true,
      allowed,
      cancelRequested: !allowed,
      state: row.state,
      leaseExpiresAt: row.leaseExpiresAt,
      hardExpiresAt: row.hardExpiresAt,
      quiescentAfterAt: row.quiescentAfterAt,
    };
  },
});

/**
 * Exact terminal settlement. Receipt finalization and locator removal share
 * one transaction and deliberately remain authorized after a lifecycle fence:
 * the pre-fence exact lease is the authority to close old-generation spend.
 */
export const settleTtsProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    outcome: v.union(v.literal("settled"), v.literal("not_dispatched")),
    settlement: v.optional(usageSettlementValidator),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactAttempt(ctx, args.dispatchId, args.attemptId);
    if (!row) {
      const usage = await ctx.db
        .query("internal_tts_usage")
        .withIndex("by_dispatchId_and_attemptId", (q) =>
          q.eq("dispatchId", args.dispatchId).eq("attemptId", args.attemptId),
        )
        .unique();
      return (
        usage?.ownerId === args.ownerId &&
        usage.ownerGeneration === args.ownerGeneration &&
        usage.leaseId === args.leaseId &&
        usage.providerDispatchOutcome === args.outcome
      );
    }
    if (
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      effectiveLeaseId(row) !== args.leaseId
    ) {
      return false;
    }
    if (args.outcome === "settled" && !args.settlement) {
      throw new Error("Settled TTS provider work requires usage disposition.");
    }
    if (
      args.outcome === "settled" &&
      effectiveProviderState(row) !== "may_have_dispatched"
    ) {
      throw new Error(
        "TTS provider work must cross the dispatch marker before settlement.",
      );
    }
    await finalizeAndDeleteDispatch(ctx, row, {
      outcome: args.outcome,
      now: args.now,
      ...(args.settlement ? { settlement: args.settlement } : {}),
    });
    return true;
  },
});

/**
 * Fetch rejection, timeout, cancellation, or body failure has an ambiguous
 * remote outcome. Preserve its pessimistic receipt and locator until the
 * immutable crash-safety bound proves that no provider work can remain live.
 */
export const abandonTtsProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    settlement: v.optional(usageSettlementValidator),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactAttempt(ctx, args.dispatchId, args.attemptId);
    if (!row) {
      const usage = await ctx.db
        .query("internal_tts_usage")
        .withIndex("by_dispatchId_and_attemptId", (q) =>
          q.eq("dispatchId", args.dispatchId).eq("attemptId", args.attemptId),
        )
        .unique();
      return (
        usage?.ownerId === args.ownerId &&
        usage.ownerGeneration === args.ownerGeneration &&
        usage.leaseId === args.leaseId &&
        usage.providerDispatchOutcome === "may_have_dispatched"
      );
    }
    if (
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration ||
      effectiveLeaseId(row) !== args.leaseId
    ) {
      return false;
    }
    if (effectiveProviderState(row) === "reserved") {
      throw new Error(
        "A TTS attempt that never crossed dispatch must settle not-dispatched.",
      );
    }
    await updateUsageReceipt(ctx, row, {
      outcome: "may_have_dispatched",
      now: args.now,
      ...(args.settlement ? { settlement: args.settlement } : {}),
    });
    await ctx.db.patch(row._id, {
      state: "cancel_requested",
      outcome: "may_have_dispatched",
      ambiguousAt: row.ambiguousAt ?? args.now,
      cancelRequestedAt: row.cancelRequestedAt ?? args.now,
      leaseExpiresAt: Math.min(row.leaseExpiresAt, args.now),
      updatedAt: args.now,
    });
    return true;
  },
});

/** Scheduled crash cleanup, fenced to the exact attempt and hard deadline. */
export const expireTtsProviderDispatchInternal = internalMutation({
  args: {
    dispatchId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    quiescentAfterAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactAttempt(ctx, args.dispatchId, args.attemptId);
    if (
      !row ||
      effectiveLeaseId(row) !== args.leaseId ||
      row.quiescentAfterAt !== args.quiescentAfterAt ||
      Date.now() < row.quiescentAfterAt
    ) {
      return false;
    }
    await updateUsageReceipt(ctx, row, {
      outcome:
        effectiveProviderState(row) === "reserved"
          ? "not_dispatched"
          : "may_have_dispatched",
      now: Date.now(),
    });
    await ctx.db.delete(row._id);
    return true;
  },
});

const quiesceOwnerTtsProviderDispatches = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    now: number;
    limit?: number;
    operationId?: string;
    generation?: string;
  },
): Promise<{
  ready: boolean;
  canceled: number;
  reaped: number;
  pending: string[];
  retryAt: number | null;
}> => {
  const limit = clampBatch(args.limit);
  let budget = limit;
  let reaped = 0;
  for (const state of ["cancel_requested", "active"] as const) {
    if (budget <= 0) break;
    const expired = await ctx.db
      .query("tts_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state_and_quiescentAfterAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("state", state)
          .lte("quiescentAfterAt", args.now),
      )
      .take(budget);
    for (const row of expired) {
      await updateUsageReceipt(ctx, row, {
        outcome:
          effectiveProviderState(row) === "reserved"
            ? "not_dispatched"
            : "may_have_dispatched",
        now: args.now,
      });
      await ctx.scheduler.cancel(row.cleanupJobId);
      await ctx.db.delete(row._id);
    }
    reaped += expired.length;
    budget -= expired.length;
  }

  // Once the owner fence is present, the transactional pre-fetch marker can
  // no longer succeed. Exact rows that are still reserved therefore prove no
  // provider request was admitted and can close immediately at zero cost.
  for (const state of ["cancel_requested", "active"] as const) {
    if (budget <= 0) break;
    const reserved = await ctx.db
      .query("tts_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state_and_providerState", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("state", state)
          .eq("providerState", "reserved"),
      )
      .take(budget);
    for (const row of reserved) {
      await finalizeAndDeleteDispatch(ctx, row, {
        outcome: "not_dispatched",
        now: args.now,
      });
    }
    reaped += reserved.length;
    budget -= reserved.length;
  }

  let canceled = 0;
  if (budget > 0) {
    const active = await ctx.db
      .query("tts_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "active"),
      )
      .take(budget);
    for (const row of active) {
      const mayHaveDispatched =
        effectiveProviderState(row) === "may_have_dispatched";
      await ctx.db.patch(row._id, {
        state: "cancel_requested",
        leaseExpiresAt: Math.min(row.leaseExpiresAt, args.now),
        ...(args.operationId ? { cancelOperationId: args.operationId } : {}),
        ...(args.generation ? { cancelGeneration: args.generation } : {}),
        cancelRequestedAt: row.cancelRequestedAt ?? args.now,
        ...(mayHaveDispatched
          ? {
              outcome: "may_have_dispatched" as const,
              ambiguousAt: row.ambiguousAt ?? args.now,
            }
          : {}),
        updatedAt: args.now,
      });
    }
    canceled = active.length;
  }

  const previewLimit = Math.min(limit, MAX_PENDING_PREVIEW);
  const [activePending, debtPending, activeRetry, debtRetry] =
    await Promise.all([
      ctx.db
        .query("tts_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "active"),
        )
        .take(previewLimit),
      ctx.db
        .query("tts_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "cancel_requested"),
        )
        .take(previewLimit),
      ctx.db
        .query("tts_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state_and_quiescentAfterAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "active"),
        )
        .first(),
      ctx.db
        .query("tts_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state_and_quiescentAfterAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "cancel_requested"),
        )
        .first(),
    ]);
  const pending = [
    ...activePending.map((row) => `active:${row.kind}:${row.dispatchId}`),
    ...debtPending.map((row) => `debt:${row.kind}:${row.dispatchId}`),
  ].slice(0, MAX_PENDING_PREVIEW);
  const retryCandidates = [
    activeRetry?.quiescentAfterAt,
    debtRetry?.quiescentAfterAt,
  ].filter((value): value is number => value !== undefined);
  return {
    ready: activePending.length === 0 && debtPending.length === 0,
    canceled,
    reaped,
    pending,
    retryAt: retryCandidates.length > 0 ? Math.min(...retryCandidates) : null,
  };
};

/**
 * Bounded reset/delete cancellation pass. Only the exact owner of the current
 * core purge lease can create cancellation debt or reap rows whose fixed
 * provider abort deadline and grace have elapsed.
 */
export const cancelOwnerTtsProviderDispatchesInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: ownerPurgeModeValidator,
    now: v.number(),
    limit: v.optional(v.number()),
  },
  returns: quiesceResultValidator,
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      stage: "core",
      leaseId: args.leaseId,
      mode: args.mode,
    });
    return await quiesceOwnerTtsProviderDispatches(ctx, args);
  },
});

/** Two-owner auth migration cancellation pass; never transfers live authority. */
export const quiesceOwnerTtsProviderDispatchesForMigrationInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      now: v.number(),
      limit: v.optional(v.number()),
    },
    returns: quiesceResultValidator,
    handler: async (ctx, args) => {
      if (!(await hasOwnerMigrationWriteFence(ctx, args.ownerId))) {
        throw new Error(
          "TTS migration quiescence requires an active owner migration fence.",
        );
      }
      return await quiesceOwnerTtsProviderDispatches(ctx, args);
    },
  });

/** Strict, bounded owner readback for reset/deletion completeness. */
export const remainingOwnerTtsProviderDispatchesInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const [active, debt] = await Promise.all([
      ctx.db
        .query("tts_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "active"),
        )
        .take(1),
      ctx.db
        .query("tts_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "cancel_requested"),
        )
        .take(1),
    ]);
    return [
      ...(active.length > 0 ? ["tts_provider_dispatch_active"] : []),
      ...(debt.length > 0 ? ["tts_provider_dispatch_debt"] : []),
    ];
  },
});
