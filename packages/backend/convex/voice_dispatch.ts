import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import { assertOwnerPurgeLease } from "./owner_lifecycle";
import { voiceProviderDispatchKindValidator } from "./schema/billing";
import { ownerPurgeModeValidator } from "./schema/owner_lifecycle";
import {
  VOICE_REALTIME_AUTHORITY_LEASE_MS,
  VOICE_REALTIME_AUTHORITY_QUIESCENCE_MS,
  voiceAuthorityQuiescentAfter,
} from "./lib/voice_authority";
import { adjustManagedUsageReservationAuthorized } from "./lib/managed_usage_reservation";

export const VOICE_PROVIDER_TRANSPORT_TIMEOUT_MS = 45_000;
export const VOICE_PROVIDER_DISPATCH_LEASE_MS = 60_000;
export const VOICE_PROVIDER_DISPATCH_ABORT_GRACE_MS = 30_000;

const DEFAULT_QUIESCE_BATCH = 24;
const MAX_QUIESCE_BATCH = 64;
const MAX_PENDING_PREVIEW = 8;

const dispatchStateValidator = v.union(
  v.literal("active"),
  v.literal("cancel_requested"),
);

const reserveResultValidator = v.object({
  acquired: v.boolean(),
  status: v.union(
    v.literal("reserved"),
    v.literal("busy"),
    v.literal("canceled"),
  ),
  providerDeadlineAt: v.number(),
  leaseExpiresAt: v.number(),
  quiescentAfterAt: v.number(),
});

const pulseResultValidator = v.object({
  found: v.boolean(),
  allowed: v.boolean(),
  cancelRequested: v.boolean(),
  state: v.union(dispatchStateValidator, v.null()),
  providerDeadlineAt: v.union(v.number(), v.null()),
  leaseExpiresAt: v.union(v.number(), v.null()),
  quiescentAfterAt: v.union(v.number(), v.null()),
});

const quiesceResultValidator = v.object({
  ready: v.boolean(),
  canceled: v.number(),
  reaped: v.number(),
  pending: v.array(v.string()),
  retryAt: v.union(v.number(), v.null()),
});

export type VoiceProviderDispatchKind =
  | "xai_client_secret"
  | "openai_client_secret"
  | "openai_call"
  | "inworld_ice_servers"
  | "inworld_sdp";

const expectedProviderAndPhase = (
  kind: VoiceProviderDispatchKind,
): {
  provider: "openai" | "xai" | "inworld";
  phase: "minting" | "active";
} => {
  switch (kind) {
    case "xai_client_secret":
      return { provider: "xai", phase: "minting" };
    case "openai_client_secret":
      return { provider: "openai", phase: "minting" };
    case "openai_call":
      return { provider: "openai", phase: "active" };
    case "inworld_ice_servers":
      return { provider: "inworld", phase: "minting" };
    case "inworld_sdp":
      return { provider: "inworld", phase: "active" };
  }
};

export const voiceProviderDispatchId = (
  kind: VoiceProviderDispatchKind,
  stellaSessionId: string,
): string => `voice:${kind}:${stellaSessionId}`;

const clampBatch = (limit: number | undefined): number =>
  Math.min(
    MAX_QUIESCE_BATCH,
    Math.max(1, Math.floor(limit ?? DEFAULT_QUIESCE_BATCH)),
  );

const validateIds = (args: {
  stellaSessionId: string;
  dispatchId: string;
  attemptId: string;
  kind: VoiceProviderDispatchKind;
}): void => {
  if (
    !args.stellaSessionId.trim() ||
    !args.dispatchId.trim() ||
    !args.attemptId.trim()
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Voice session, dispatch, and attempt ids are required.",
    });
  }
  if (
    args.dispatchId !== voiceProviderDispatchId(args.kind, args.stellaSessionId)
  ) {
    throw new ConvexError({
      code: "VOICE_DISPATCH_IDEMPOTENCY_CONFLICT",
      message: "The voice dispatch id does not match the provider operation.",
    });
  }
};

const dispatchConflict = () =>
  new ConvexError({
    code: "VOICE_DISPATCH_IDEMPOTENCY_CONFLICT",
    message: "The voice dispatch id is already bound to different work.",
  });

const readDispatch = async (ctx: Pick<QueryCtx, "db">, dispatchId: string) =>
  await ctx.db
    .query("voice_provider_dispatch_leases")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", dispatchId))
    .unique();

export const readExactVoiceProviderAttempt = async (
  ctx: Pick<QueryCtx, "db">,
  dispatchId: string,
  attemptId: string,
) =>
  await ctx.db
    .query("voice_provider_dispatch_leases")
    .withIndex("by_dispatchId_and_attemptId", (q) =>
      q.eq("dispatchId", dispatchId).eq("attemptId", attemptId),
    )
    .unique();

const readVoiceSession = async (
  ctx: Pick<QueryCtx, "db">,
  stellaSessionId: string,
) =>
  await ctx.db
    .query("billing_voice_sessions")
    .withIndex("by_stellaSessionId", (q) =>
      q.eq("stellaSessionId", stellaSessionId),
    )
    .unique();

const readVoiceSessionProviderAttempt = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  stellaSessionId: string,
) =>
  await ctx.db
    .query("voice_provider_dispatch_leases")
    .withIndex("by_ownerId_and_stellaSessionId_and_createdAt", (q) =>
      q.eq("ownerId", ownerId).eq("stellaSessionId", stellaSessionId),
    )
    .first();

const voiceSessionPhaseAllowed = async (
  ctx: QueryCtx | MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    stellaSessionId: string;
    kind: VoiceProviderDispatchKind;
  },
): Promise<boolean> => {
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const session = await readVoiceSession(ctx, args.stellaSessionId);
  const expected = expectedProviderAndPhase(args.kind);
  return Boolean(
    session &&
      session.ownerId === args.ownerId &&
      (session.ownerGeneration ?? "legacy") === args.ownerGeneration &&
      session.provider === expected.provider &&
      session.status === expected.phase,
  );
};

const canceledPulse = (
  row: Awaited<ReturnType<typeof readExactVoiceProviderAttempt>> | null,
) => ({
  found: row !== null,
  allowed: false,
  cancelRequested: true,
  state: row?.state ?? null,
  providerDeadlineAt: row?.providerDeadlineAt ?? null,
  leaseExpiresAt: row?.leaseExpiresAt ?? null,
  quiescentAfterAt: row?.quiescentAfterAt ?? null,
});

const markCancellationDebt = async (
  ctx: MutationCtx,
  row: NonNullable<Awaited<ReturnType<typeof readExactVoiceProviderAttempt>>>,
  now: number,
  extra?: {
    operationId?: string;
    generation?: string;
    ambiguous?: boolean;
  },
): Promise<void> => {
  await ctx.db.patch(row._id, {
    state: "cancel_requested",
    cancelRequestedAt: row.cancelRequestedAt ?? now,
    ...(extra?.operationId ? { cancelOperationId: extra.operationId } : {}),
    ...(extra?.generation ? { cancelGeneration: extra.generation } : {}),
    ...(extra?.ambiguous ? { ambiguousAt: row.ambiguousAt ?? now } : {}),
    updatedAt: now,
  });
};

/**
 * Serializable provider admission. The lifecycle generation, both migration
 * roles, voice-session phase, and exact dispatch tuple are checked in the same
 * transaction that publishes the durable in-flight row.
 */
export const reserveVoiceProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    stellaSessionId: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    kind: voiceProviderDispatchKindValidator,
    now: v.number(),
  },
  returns: reserveResultValidator,
  handler: async (ctx, args) => {
    validateIds(args);
    if (!(await voiceSessionPhaseAllowed(ctx, args))) {
      throw new ConvexError({
        code: "VOICE_SESSION_UNAVAILABLE",
        message: "The realtime voice session is no longer dispatchable.",
      });
    }

    const existing = await readDispatch(ctx, args.dispatchId);
    if (existing) {
      if (
        existing.ownerId !== args.ownerId ||
        existing.ownerGeneration !== args.ownerGeneration ||
        existing.stellaSessionId !== args.stellaSessionId ||
        existing.kind !== args.kind
      ) {
        throw dispatchConflict();
      }
      if (existing.attemptId === args.attemptId) {
        return {
          acquired: false,
          status:
            existing.state === "cancel_requested"
              ? ("canceled" as const)
              : ("busy" as const),
          providerDeadlineAt: existing.providerDeadlineAt,
          leaseExpiresAt: existing.leaseExpiresAt,
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
          providerDeadlineAt: existing.providerDeadlineAt,
          leaseExpiresAt: existing.leaseExpiresAt,
          quiescentAfterAt: existing.quiescentAfterAt,
        };
      }
      await ctx.scheduler.cancel(existing.cleanupJobId);
      await ctx.db.delete(existing._id);
    }

    const providerDeadlineAt = args.now + VOICE_PROVIDER_TRANSPORT_TIMEOUT_MS;
    const leaseExpiresAt = args.now + VOICE_PROVIDER_DISPATCH_LEASE_MS;
    const quiescentAfterAt =
      leaseExpiresAt + VOICE_PROVIDER_DISPATCH_ABORT_GRACE_MS;
    if (!(providerDeadlineAt < leaseExpiresAt)) {
      throw new Error("Voice provider timeout must be shorter than its lease.");
    }
    const cleanupJobId = await ctx.scheduler.runAt(
      quiescentAfterAt,
      internal.voice_dispatch.expireVoiceProviderDispatchInternal,
      {
        dispatchId: args.dispatchId,
        attemptId: args.attemptId,
        quiescentAfterAt,
      },
    );
    await ctx.db.insert("voice_provider_dispatch_leases", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      stellaSessionId: args.stellaSessionId,
      dispatchId: args.dispatchId,
      attemptId: args.attemptId,
      kind: args.kind,
      state: "active",
      providerDeadlineAt,
      leaseExpiresAt,
      quiescentAfterAt,
      cleanupJobId,
      lastHeartbeatAt: args.now,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return {
      acquired: true,
      status: "reserved" as const,
      providerDeadlineAt,
      leaseExpiresAt,
      quiescentAfterAt,
    };
  },
});

/** Exact-attempt liveness check used before and after every provider fetch. */
export const heartbeatVoiceProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: pulseResultValidator,
  handler: async (ctx, args) => {
    const row = await readExactVoiceProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    ) {
      return canceledPulse(null);
    }
    let allowed =
      row.state === "active" &&
      args.now < row.providerDeadlineAt &&
      args.now < row.leaseExpiresAt;
    if (allowed) {
      try {
        allowed = await voiceSessionPhaseAllowed(ctx, row);
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      if (row.state === "active") {
        await markCancellationDebt(ctx, row, args.now, { ambiguous: true });
      }
      return canceledPulse({ ...row, state: "cancel_requested" });
    }
    await ctx.db.patch(row._id, {
      lastHeartbeatAt: args.now,
      updatedAt: args.now,
    });
    return {
      found: true,
      allowed: true,
      cancelRequested: false,
      state: "active" as const,
      providerDeadlineAt: row.providerDeadlineAt,
      leaseExpiresAt: row.leaseExpiresAt,
      quiescentAfterAt: row.quiescentAfterAt,
    };
  },
});

/**
 * A fully consumed provider response proves transport settlement, so the exact
 * attempt can be removed immediately even if a reset fence landed afterward.
 */
export const settleVoiceProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactVoiceProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    await ctx.scheduler.cancel(row.cleanupJobId);
    await ctx.db.delete(row._id);
    return true;
  },
});

/**
 * A timeout, cancellation, or network error has an ambiguous remote outcome.
 * Retain the locator as cancellation debt through the fixed safety bound.
 */
export const abandonVoiceProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactVoiceProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    await markCancellationDebt(ctx, row, args.now, { ambiguous: true });
    return true;
  },
});

/** Scheduled crash cleanup, fenced to the exact tuple and safety deadline. */
export const expireVoiceProviderDispatchInternal = internalMutation({
  args: {
    dispatchId: v.string(),
    attemptId: v.string(),
    quiescentAfterAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactVoiceProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    if (
      !row ||
      row.quiescentAfterAt !== args.quiescentAfterAt ||
      Date.now() < row.quiescentAfterAt
    ) {
      return false;
    }
    await ctx.db.delete(row._id);
    return true;
  },
});

type VoiceSessionRow = NonNullable<
  Awaited<ReturnType<typeof readVoiceSession>>
>;

const expireVoiceAuthority = async (
  ctx: MutationCtx,
  session: VoiceSessionRow,
  now: number,
): Promise<void> => {
  const authorityLeaseId =
    session.authorityLeaseId ?? `legacy:${session.stellaSessionId}`;
  const authorityEpoch = Math.max(1, Math.floor(session.authorityEpoch ?? 1));
  const authorityExpiresAt =
    session.authorityExpiresAt ??
    Math.min(session.leaseExpiresAt, now);
  const usagePending =
    (session.usageDisposition ?? "pending") === "pending";
  const providerAttempt = await readVoiceSessionProviderAttempt(
    ctx,
    session.ownerId,
    session.stellaSessionId,
  );
  const exactUndispatched =
    usagePending &&
    !providerAttempt &&
    session.providerCallId === undefined &&
    session.providerCallCreateStartedAt === undefined;
  if (
    exactUndispatched &&
    session.usageReservationState === "active" &&
    (session.usageReservedMicroCents ?? 0) > 0
  ) {
    await adjustManagedUsageReservationAuthorized(ctx, {
      ownerId: session.ownerId,
      deltaMicroCents: -Math.max(
        0,
        Math.floor(session.usageReservedMicroCents ?? 0),
      ),
      now,
    });
  }
  await ctx.db.patch(session._id, {
    status: "client_expired",
    authorityState: "expired",
    authorityLeaseId,
    authorityEpoch,
    authorityExpiresAt,
    ...(exactUndispatched
      ? {
          usageDisposition: "exact" as const,
          usageDispositionAt: now,
          usageAuthorityClosedAt: now,
          usageAuthorityClosedReason:
            session.authorityCancelReason ?? "authority_expired_undispatched",
          usageReservationState: "released" as const,
          usageReservedMicroCents: 0,
        }
      : usagePending
      ? {
          usageDisposition: "unresolved" as const,
          usageAuthorityClosedAt: now,
          usageAuthorityClosedReason:
            session.authorityCancelReason ?? "authority_expired",
        }
      : {}),
    endedAt: session.endedAt ?? now,
    endReason:
      session.endReason ?? session.authorityCancelReason ?? "authority_expired",
    updatedAt: now,
  });
  if (usagePending && !exactUndispatched) {
    await ctx.scheduler.runAfter(
      0,
      internal.billing.finalizeExpiredVoiceRealtimeUsageInternal,
      {
        ownerId: session.ownerId,
        ownerGeneration: session.ownerGeneration ?? "legacy",
        stellaSessionId: session.stellaSessionId,
        authorityLeaseId,
        authorityEpoch,
        authorityExpiresAt,
      },
    );
  }
};

const requestBoundOpenAiHangup = async (
  ctx: MutationCtx,
  session: VoiceSessionRow,
  args: { now: number; reason: string },
): Promise<void> => {
  if (
    session.provider !== "openai" ||
    !session.providerCallId ||
    session.providerHangupState === "confirmed"
  ) {
    return;
  }
  const terminalUsage =
    session.usageDisposition === "exact" ||
    session.usageDisposition === "conservative_fallback";
  await ctx.db.patch(session._id, {
    ...(terminalUsage
      ? {}
      : {
          usageDisposition: "revocation_pending" as const,
          usageAuthorityClosedAt: session.usageAuthorityClosedAt ?? args.now,
          usageAuthorityClosedReason: args.reason,
        }),
    providerHangupState:
      session.providerHangupState === "ambiguous"
        ? "ambiguous"
        : "requested",
    providerHangupRequestedReason:
      session.providerHangupRequestedReason ?? args.reason,
    providerHangupNextRetryAt: args.now,
    updatedAt: args.now,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.billing.hangupOpenAiVoiceCallInternal,
    {
      ownerId: session.ownerId,
      ownerGeneration: session.ownerGeneration ?? "legacy",
      stellaSessionId: session.stellaSessionId,
      providerCallId: session.providerCallId,
    },
  );
};

const requestVoiceAuthorityCancellation = async (
  ctx: MutationCtx,
  session: VoiceSessionRow,
  args: { now: number; reason: string },
): Promise<void> => {

  if (
    session.authorityState === "active" &&
    session.authorityLeaseId &&
    typeof session.authorityEpoch === "number" &&
    typeof session.authorityExpiresAt === "number"
  ) {
    await ctx.db.patch(session._id, {
      authorityState: "cancel_requested",
      authorityEpoch: Math.max(1, Math.floor(session.authorityEpoch)) + 1,
      authorityCancelReason: args.reason,
      authorityCancelRequestedAt: args.now,
      updatedAt: args.now,
    });
    await requestBoundOpenAiHangup(ctx, session, args);
    return;
  }

  // Rows activated before the authority protocol cannot acknowledge a server
  // epoch. Convert them to bounded cancellation debt so lifecycle completion
  // waits one short lease rather than the old five-minute session deadline.
  await ctx.db.patch(session._id, {
    authorityLeaseId: `legacy:${session.stellaSessionId}`,
    authorityEpoch: 1,
    authorityState: "cancel_requested",
    authorityExpiresAt: args.now + VOICE_REALTIME_AUTHORITY_LEASE_MS,
    authorityCancelReason: args.reason,
    authorityCancelRequestedAt: args.now,
    updatedAt: args.now,
  });
  await requestBoundOpenAiHangup(ctx, session, args);
};

const quiesceOwnerRows = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    now: number;
    limit?: number;
    operationId?: string;
    generation?: string;
    cancelReason: string;
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
      .query("voice_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state_and_quiescentAfterAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("state", state)
          .lte("quiescentAfterAt", args.now),
      )
      .take(budget);
    for (const row of expired) {
      await ctx.scheduler.cancel(row.cleanupJobId);
      await ctx.db.delete(row._id);
    }
    reaped += expired.length;
    budget -= expired.length;
  }

  let canceled = 0;
  if (budget > 0) {
    const active = await ctx.db
      .query("voice_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "active"),
      )
      .take(budget);
    for (const row of active) {
      await markCancellationDebt(ctx, row, args.now, {
        operationId: args.operationId,
        generation: args.generation,
        ambiguous: true,
      });
    }
    canceled = active.length;
    budget -= active.length;
  }

  // Provider revocation is an independent lifecycle obligation. Do not rely
  // on a renderer authority ACK or on the billing reservation remaining live:
  // reset, deletion, and migration all keep waiting until OpenAI itself has
  // confirmed the server-owned call terminal (or its documented hard bound).
  for (const state of ["open", "requested", "ambiguous"] as const) {
    if (budget <= 0) break;
    const calls = await ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_providerHangupState_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("providerHangupState", state),
      )
      .take(budget);
    for (const session of calls) {
      await requestBoundOpenAiHangup(ctx, session, {
        now: args.now,
        reason: args.cancelReason,
      });
    }
    canceled += calls.length;
    budget -= calls.length;
  }

  const authorityExpiredBefore =
    args.now - VOICE_REALTIME_AUTHORITY_QUIESCENCE_MS;
  for (const state of ["cancel_requested", "active"] as const) {
    if (budget <= 0) break;
    const expired = await ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_authorityState_and_authorityExpiresAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("authorityState", state)
          .lte("authorityExpiresAt", authorityExpiredBefore),
      )
      .take(budget);
    for (const session of expired) {
      await expireVoiceAuthority(ctx, session, args.now);
    }
    reaped += expired.length;
    budget -= expired.length;
  }

  if (budget > 0) {
    const activeAuthority = await ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_authorityState_and_authorityExpiresAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("authorityState", "active"),
      )
      .take(budget);
    for (const session of activeAuthority) {
      await requestVoiceAuthorityCancellation(ctx, session, {
        now: args.now,
        reason: args.cancelReason,
      });
    }
    canceled += activeAuthority.length;
    budget -= activeAuthority.length;
  }

  if (budget > 0) {
    const activeSessions = await ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "active"),
      )
      .take(MAX_QUIESCE_BATCH);
    const legacySessions = activeSessions
      .filter((session) => session.authorityState === undefined)
      .slice(0, budget);
    for (const session of legacySessions) {
      await requestVoiceAuthorityCancellation(ctx, session, {
        now: args.now,
        reason: args.cancelReason,
      });
    }
    canceled += legacySessions.length;
    budget -= legacySessions.length;
  }

  // Prepare reserves managed usage before the action can acquire its provider
  // dispatch guard. Lifecycle fencing may win in that narrow gap. Schedule an
  // exact OCC compensation for authority-less reservation rows; the billing
  // mutation releases only if the provider-attempt index range is still empty.
  if (budget > 0) {
    const reservations = await ctx.db
      .query("billing_voice_sessions")
      .withIndex(
        "by_ownerId_and_usageReservationState_and_createdAt",
        (q) =>
          q.eq("ownerId", args.ownerId).eq("usageReservationState", "active"),
      )
      .take(budget);
    let scheduled = 0;
    for (const session of reservations) {
      if (
        session.authorityState === "active" ||
        session.authorityState === "cancel_requested"
      ) {
        continue;
      }
      const providerAttempt = await readVoiceSessionProviderAttempt(
        ctx,
        session.ownerId,
        session.stellaSessionId,
      );
      if (
        !providerAttempt &&
        session.providerCallId === undefined &&
        session.providerCallCreateStartedAt === undefined
      ) {
        const remaining = Math.max(
          0,
          Math.floor(session.usageReservedMicroCents ?? 0),
        );
        if (remaining > 0) {
          await adjustManagedUsageReservationAuthorized(ctx, {
            ownerId: session.ownerId,
            deltaMicroCents: -remaining,
            now: args.now,
          });
        }
        await ctx.db.patch(session._id, {
          status: "failed",
          usageDisposition: "exact",
          usageDispositionAt: args.now,
          usageAuthorityClosedAt: args.now,
          usageAuthorityClosedReason: args.cancelReason,
          usageReservationState: "released",
          usageReservedMicroCents: 0,
          endedAt: session.endedAt ?? args.now,
          endReason: session.endReason ?? args.cancelReason,
          updatedAt: args.now,
        });
        scheduled += 1;
        continue;
      }
      await ctx.scheduler.runAfter(
        0,
        internal.billing.releaseUndispatchedVoiceRealtimeLeaseInternal,
        {
          ownerId: session.ownerId,
          ownerGeneration: session.ownerGeneration ?? "legacy",
          stellaSessionId: session.stellaSessionId,
          reason: args.cancelReason,
        },
      );
      scheduled += 1;
    }
    canceled += scheduled;
    budget -= scheduled;
  }

  const previewLimit = Math.min(limit, MAX_PENDING_PREVIEW);
  const [
    activePending,
    openHangupPending,
    requestedHangupPending,
    ambiguousHangupPending,
    debtPending,
    activeAuthorityPending,
    activeReservationPending,
    cancelAuthorityPending,
    unresolvedUsagePending,
    activeSessionCandidates,
  ] = await Promise.all([
    ctx.db
      .query("voice_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "active"),
      )
      .take(previewLimit),
    ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_providerHangupState_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("providerHangupState", "open"),
      )
      .take(previewLimit),
    ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_providerHangupState_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("providerHangupState", "requested"),
      )
      .take(previewLimit),
    ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_providerHangupState_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("providerHangupState", "ambiguous"),
      )
      .take(previewLimit),
    ctx.db
      .query("voice_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "cancel_requested"),
      )
      .take(previewLimit),
    ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_authorityState_and_authorityExpiresAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("authorityState", "active"),
      )
      .take(previewLimit),
    ctx.db
      .query("billing_voice_sessions")
      .withIndex(
        "by_ownerId_and_usageReservationState_and_createdAt",
        (q) =>
          q.eq("ownerId", args.ownerId).eq("usageReservationState", "active"),
      )
      .take(previewLimit),
    ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_authorityState_and_authorityExpiresAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("authorityState", "cancel_requested"),
      )
      .take(previewLimit),
    ctx.db
      .query("billing_voice_sessions")
      .withIndex(
        "by_ownerId_and_usageDisposition_and_authorityExpiresAt",
        (q) =>
          q.eq("ownerId", args.ownerId).eq("usageDisposition", "unresolved"),
      )
      .take(previewLimit),
    ctx.db
      .query("billing_voice_sessions")
      .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "active"),
      )
      .take(MAX_QUIESCE_BATCH),
  ]);
  const legacyPending = activeSessionCandidates
    .filter((session) => session.authorityState === undefined)
    .slice(0, previewLimit);
  const pending = [
    ...activePending.map((row) => ({
      label: `${row.state}:${row.kind}:${row.dispatchId}`,
      retryAt: row.quiescentAfterAt,
    })),
    ...debtPending.map((row) => ({
      label: `${row.state}:${row.kind}:${row.dispatchId}`,
      retryAt: row.quiescentAfterAt,
    })),
    ...[
      ...openHangupPending,
      ...requestedHangupPending,
      ...ambiguousHangupPending,
    ].map((session) => ({
      label: `provider_hangup_${session.providerHangupState}:${session.stellaSessionId}`,
      retryAt: Math.max(
        args.now + 1_000,
        session.providerHangupLeaseExpiresAt ??
          session.providerHangupNextRetryAt ??
          args.now + 1_000,
      ),
    })),
    ...activeAuthorityPending.map((session) => ({
      label: `authority_active:${session.stellaSessionId}`,
      retryAt:
        typeof session.authorityExpiresAt === "number"
          ? voiceAuthorityQuiescentAfter(session.authorityExpiresAt)
          : args.now,
    })),
    ...cancelAuthorityPending.map((session) => ({
      label: `authority_cancel_requested:${session.stellaSessionId}`,
      retryAt:
        typeof session.authorityExpiresAt === "number"
          ? voiceAuthorityQuiescentAfter(session.authorityExpiresAt)
          : args.now,
    })),
    ...unresolvedUsagePending.map((session) => ({
      label: `usage_unresolved:${session.stellaSessionId}`,
      retryAt: args.now + 1_000,
    })),
    ...activeReservationPending.map((session) => ({
      label: `usage_reserved:${session.stellaSessionId}`,
      retryAt: args.now + 1_000,
    })),
    ...legacyPending.map((session) => ({
      label: `authority_legacy:${session.stellaSessionId}`,
      retryAt: args.now,
    })),
  ].slice(0, MAX_PENDING_PREVIEW);
  return {
    ready: pending.length === 0,
    canceled,
    reaped,
    pending: pending.map((item) => item.label),
    retryAt:
      pending.length === 0
        ? null
        : Math.min(...pending.map((item) => item.retryAt)),
  };
};

/** Reset/delete cancellation pass guarded by the exact core purge lease. */
export const cancelOwnerVoiceProviderDispatchesInternal = internalMutation({
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
    return await quiesceOwnerRows(ctx, {
      ...args,
      cancelReason: args.mode,
    });
  },
});

/**
 * Migration cancellation pass. The row itself proves the caller names one of
 * the exact migration's two owners; reservations are already fenced for both
 * roles by `assertOwnerMigrationWriteAllowed`.
 */
export const cancelOwnerVoiceProviderDispatchesForMigrationInternal =
  internalMutation({
    args: {
      migrationId: v.id("auth_owner_migrations"),
      ownerId: v.string(),
      now: v.number(),
      limit: v.optional(v.number()),
    },
    returns: quiesceResultValidator,
    handler: async (ctx, args) => {
      const migration = await ctx.db.get(args.migrationId);
      if (
        !migration ||
        (migration.fromOwnerId !== args.ownerId &&
          migration.toOwnerId !== args.ownerId)
      ) {
        throw new ConvexError({
          code: "OWNERSHIP_MIGRATION_SUPERSEDED",
          message: "The owner is not part of this migration.",
        });
      }
      return await quiesceOwnerRows(ctx, {
        ...args,
        cancelReason: "migration",
      });
    },
  });

/** Strict bounded readback shared by reset, deletion, and migration. */
export const remainingOwnerVoiceProviderDispatchesInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const [
      active,
      openHangup,
      requestedHangup,
      ambiguousHangup,
      debt,
      activeAuthority,
      activeReservation,
      unresolvedUsage,
      cancelAuthority,
      activeSessionCandidates,
    ] = await Promise.all([
      ctx.db
        .query("voice_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "active"),
        )
        .take(1),
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_providerHangupState_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("providerHangupState", "open"),
        )
        .take(1),
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_providerHangupState_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("providerHangupState", "requested"),
        )
        .take(1),
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_providerHangupState_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("providerHangupState", "ambiguous"),
        )
        .take(1),
      ctx.db
        .query("voice_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "cancel_requested"),
        )
        .take(1),
      ctx.db
        .query("billing_voice_sessions")
        .withIndex(
          "by_ownerId_and_authorityState_and_authorityExpiresAt",
          (q) => q.eq("ownerId", args.ownerId).eq("authorityState", "active"),
        )
        .take(1),
      ctx.db
        .query("billing_voice_sessions")
        .withIndex(
          "by_ownerId_and_usageReservationState_and_createdAt",
          (q) =>
            q.eq("ownerId", args.ownerId).eq("usageReservationState", "active"),
        )
        .take(1),
      ctx.db
        .query("billing_voice_sessions")
        .withIndex(
          "by_ownerId_and_usageDisposition_and_authorityExpiresAt",
          (q) =>
            q.eq("ownerId", args.ownerId).eq("usageDisposition", "unresolved"),
        )
        .take(1),
      ctx.db
        .query("billing_voice_sessions")
        .withIndex(
          "by_ownerId_and_authorityState_and_authorityExpiresAt",
          (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("authorityState", "cancel_requested"),
        )
        .take(1),
      ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_status_and_leaseExpiresAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("status", "active"),
        )
        .take(MAX_QUIESCE_BATCH),
    ]);
    const legacyAuthority = activeSessionCandidates.some(
      (session) => session.authorityState === undefined,
    );
    return [
      ...(active.length > 0 ? ["voice_provider_dispatch_active"] : []),
      ...(debt.length > 0 ? ["voice_provider_dispatch_debt"] : []),
      ...(openHangup.length > 0 ||
      requestedHangup.length > 0 ||
      ambiguousHangup.length > 0
        ? ["voice_provider_hangup_pending"]
        : []),
      ...(activeAuthority.length > 0 ? ["voice_authority_active"] : []),
      ...(cancelAuthority.length > 0 ? ["voice_authority_cancel_debt"] : []),
      ...(unresolvedUsage.length > 0 ? ["voice_usage_unresolved"] : []),
      ...(activeReservation.length > 0 ? ["voice_usage_reserved"] : []),
      ...(legacyAuthority ? ["voice_authority_legacy_active"] : []),
    ];
  },
});
