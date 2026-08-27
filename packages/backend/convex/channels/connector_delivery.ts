/**
 * Connector Delivery: Handles async delivery of responses back to connectors
 * when using inverted execution (local device runs the AI turn).
 *
 * Flow:
 * 1. Local device finishes a remote turn request
 * 2. Local device calls `completeRemoteTurn` (public mutation)
 * 3. Mutation inserts a fulfilled marker and schedules `deliverToConnector`
 * 4. `deliverToConnector` sends the response to the appropriate connector
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v, ConvexError, type Value } from "convex/values";
import { jsonValueValidator } from "../shared_validators";
import {
  assertOwnerMigrationWriteAllowed,
  hasOwnerMigrationSourceFence,
  requireConversationOwner,
} from "../auth";
import { enforceMutationRateLimit, RATE_HOT_PATH } from "../lib/rate_limits";
import {
  managedExecutionOutcomeFromError,
  runAgentTurn,
  type RunAgentTurnResult,
} from "../automation/runner";
import { createManagedUsageDispatchGuard } from "../lib/managed_billing";
import { composeManagedDispatchGuards } from "../runtime_ai/managed";
import { acquireRemoteTurnAttemptGuard } from "../lib/remote_turn_attempt_guard";
import { createManagedDispatchRequestFingerprint } from "../lib/managed_dispatch";
import { appendEventCore } from "../events";
import type { Doc, Id } from "../_generated/dataModel";
import { assertOwnerPurgeLease } from "../owner_lifecycle";
import {
  EXECUTION_NOT_AVAILABLE_MESSAGE,
  shouldUseOfflineResponderForProvider,
} from "./execution_policy";
import {
  connectorMediaRefArrayValidator,
  extractDeliveryMediaFromOutput,
  type ConnectorMediaRef,
} from "./connector_media_types";
import {
  remoteTurnAttemptSourceValidator,
  remoteTurnDispatchOutcomeValidator,
} from "../schema/conversations";

const BACKEND_FALLBACK_AGENT_TYPE = "offline_responder";
const EMPTY_RESPONSE_TEXT = "(Stella had nothing to say.)";
const RELAYED_MEDIA_DELETE_DELAY_MS = 10 * 60_000;
export const REMOTE_TURN_ATTEMPT_LEASE_MS = 120_000;
export const REMOTE_TURN_PROVIDER_DEADLINE_MS = 60_000;
export const REMOTE_TURN_ATTEMPT_HARD_MS = 8 * 60_000;
export const REMOTE_TURN_ATTEMPT_QUIESCENCE_GRACE_MS = 30_000;
const REMOTE_TURN_PURGE_BATCH = 64;
const REMOTE_TURN_PURGE_CONVERSATION_PAGE = 8;
const REMOTE_TURN_PURGE_PER_CONVERSATION_BATCH = 4;

const isOwnerDataFenceError = (error: unknown): boolean => {
  const code =
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null
      ? (error.data as { code?: unknown }).code
      : undefined;
  return (
    code === "OWNER_DATA_PURGE_ACTIVE" ||
    code === "OWNER_DATA_GENERATION_STALE" ||
    code === "OWNERSHIP_MIGRATED"
  );
};

/**
 * Look up the original `remote_turn_request` event by `requestId`. The
 * lifecycle (`pending` / `claimed` / `fulfilled` / `cancelled`) lives directly on this
 * row — there are no longer any separate `remote_turn_claimed` /
 * `remote_turn_fulfilled` event rows to chase.
 */
const findRemoteTurnRequest = async (
  ctx: QueryCtx | MutationCtx,
  requestId: string,
) =>
  await ctx.db
    .query("events")
    .withIndex("by_type_and_requestId", (q) =>
      q.eq("type", "remote_turn_request").eq("requestId", requestId),
    )
    .unique();

type RemoteTurnAttemptSource =
  | "desktop"
  | "fast_rescue"
  | "orphan_watchdog"
  | "cron_watchdog";
type RemoteTurnDispatchOutcome =
  | "succeeded"
  | "failed"
  | "aborted"
  | "timed_out"
  | "outcome_unknown";

const remoteTurnAttemptResultValidator = v.object({
  acquired: v.boolean(),
  status: v.union(
    v.literal("reserved"),
    v.literal("busy"),
    v.literal("cancelled"),
    v.literal("legacy_unbound"),
  ),
  attemptId: v.string(),
  leaseExpiresAt: v.number(),
  hardExpiresAt: v.number(),
  quiescentAfterAt: v.number(),
});

const remoteTurnHeartbeatResultValidator = v.object({
  allowed: v.boolean(),
  cancelRequested: v.boolean(),
  leaseExpiresAt: v.union(v.number(), v.null()),
  hardExpiresAt: v.union(v.number(), v.null()),
  quiescentAfterAt: v.union(v.number(), v.null()),
});

const remoteTurnSettledOutcomeValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("aborted"),
  v.literal("timed_out"),
  v.literal("outcome_unknown"),
);

const remoteTurnFinishResultValidator = v.object({
  acknowledged: v.literal(true),
  requestState: v.union(
    v.literal("pending"),
    v.literal("claimed"),
    v.literal("fulfilled"),
    v.literal("cancelled"),
  ),
});

const remoteTurnFulfillmentResultValidator = v.object({
  acknowledged: v.boolean(),
  requestState: v.union(v.literal("fulfilled"), v.literal("cancelled")),
});

const emptyAttemptTimes = () => ({
  leaseExpiresAt: 0,
  hardExpiresAt: 0,
  quiescentAfterAt: 0,
});

const validateAttemptId = (attemptId: string): void => {
  if (!attemptId.trim() || attemptId.length > 256) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "A bounded remote-turn attempt id is required.",
    });
  }
};

const attemptTupleMatches = (
  request: Doc<"events">,
  args: {
    attemptId: string;
    source: RemoteTurnAttemptSource;
    deviceId?: string;
    ownerId: string;
    ownerGeneration: string;
  },
): boolean =>
  request.activeAttemptId === args.attemptId &&
  request.activeAttemptSource === args.source &&
  request.activeAttemptDeviceId === args.deviceId &&
  request.ownerId === args.ownerId &&
  request.ownerGeneration === args.ownerGeneration;

const resolveRemoteTurnCancellationBounds = (
  request: Doc<"events">,
  now: number,
) => {
  // Legacy rows can be missing the full attempt tuple, but discovery must not
  // grant an old transport a fresh hard lifetime. Anchor the synthesized bound
  // to immutable persisted time and then retain it on the first cancellation
  // patch. `now` is only a defensive fallback for corrupt non-finite data.
  const persistedAttemptStartedAt =
    typeof request.attemptStartedAt === "number" &&
    Number.isFinite(request.attemptStartedAt)
      ? request.attemptStartedAt
      : typeof request.timestamp === "number" &&
          Number.isFinite(request.timestamp)
        ? request.timestamp
        : now;
  const providerDeadlineAt =
    (request.lastProviderDispatchAt ?? 0) + REMOTE_TURN_PROVIDER_DEADLINE_MS;
  const persistedLeaseExpiresAt = request.attemptLeaseExpiresAt;
  const persistedHardExpiresAt = request.attemptHardExpiresAt;
  const persistedQuiescentAfterAt = request.attemptQuiescentAfterAt;
  const persistedBoundsAreCoherent =
    persistedLeaseExpiresAt !== undefined &&
    Number.isFinite(persistedLeaseExpiresAt) &&
    persistedHardExpiresAt !== undefined &&
    Number.isFinite(persistedHardExpiresAt) &&
    persistedQuiescentAfterAt !== undefined &&
    Number.isFinite(persistedQuiescentAfterAt) &&
    persistedQuiescentAfterAt >= persistedLeaseExpiresAt &&
    persistedQuiescentAfterAt >= providerDeadlineAt;
  if (persistedBoundsAreCoherent) {
    return {
      leaseExpiresAt: persistedLeaseExpiresAt,
      hardExpiresAt: persistedHardExpiresAt,
      quiescentAfterAt: persistedQuiescentAfterAt,
    };
  }
  const hardExpiresAt = Math.max(
    persistedHardExpiresAt ?? 0,
    persistedAttemptStartedAt + REMOTE_TURN_ATTEMPT_HARD_MS,
    persistedLeaseExpiresAt ?? 0,
    providerDeadlineAt,
  );
  const leaseExpiresAt = persistedLeaseExpiresAt ?? hardExpiresAt;
  const quiescentAfterAt = Math.max(
    persistedQuiescentAfterAt ?? 0,
    Math.max(leaseExpiresAt, hardExpiresAt, providerDeadlineAt) +
      REMOTE_TURN_ATTEMPT_QUIESCENCE_GRACE_MS,
  );
  return { leaseExpiresAt, hardExpiresAt, quiescentAfterAt };
};

const markRemoteTurnAttemptCancellation = async (
  ctx: MutationCtx,
  request: Doc<"events">,
  reason:
    | "ownership_migrated"
    | "owner_data_changed"
    | "user_cancelled"
    | "legacy_unbound",
  now: number,
) => {
  let cancellationDebt:
    | {
        activeAttemptState: "cancel_requested";
        attemptCancelRequestedAt: number;
        attemptLeaseExpiresAt: number;
        attemptHardExpiresAt: number;
        attemptQuiescentAfterAt: number;
        attemptCleanupJobId: Id<"_scheduled_functions">;
      }
    | undefined;
  if (request.activeAttemptId && request.requestId) {
    // Never shorten below a physical provider try admitted immediately before
    // cancellation. Its AbortSignal is cooperative, so retain the prior bound
    // (normally soft lease + grace), or synthesize provider deadline + grace.
    const {
      leaseExpiresAt: attemptLeaseExpiresAt,
      hardExpiresAt: attemptHardExpiresAt,
      quiescentAfterAt: attemptQuiescentAfterAt,
    } = resolveRemoteTurnCancellationBounds(request, now);
    if (request.attemptCleanupJobId) {
      await ctx.scheduler.cancel(request.attemptCleanupJobId);
    }
    const attemptCleanupJobId = await ctx.scheduler.runAt(
      attemptQuiescentAfterAt,
      internal.channels.connector_delivery.expireRemoteTurnAttemptInternal,
      {
        requestId: request.requestId,
        attemptId: request.activeAttemptId,
        quiescentAfterAt: attemptQuiescentAfterAt,
      },
    );
    cancellationDebt = {
      activeAttemptState: "cancel_requested",
      attemptCancelRequestedAt: now,
      attemptLeaseExpiresAt,
      attemptHardExpiresAt,
      attemptQuiescentAfterAt,
      attemptCleanupJobId,
    };
  }
  await ctx.db.patch(request._id, {
    requestState: "cancelled",
    cancelledAt: request.cancelledAt ?? now,
    requestTerminalReason: reason,
    ...cancellationDebt,
  });
};

const assertExactBoundRequest = async (
  ctx: MutationCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
  },
): Promise<Doc<"events"> | null> => {
  const request = await findRemoteTurnRequest(ctx, args.requestId);
  if (
    !request ||
    request.type !== "remote_turn_request" ||
    request.conversationId !== args.conversationId ||
    request.ownerBindingState !== "bound" ||
    request.ownerId !== args.ownerId ||
    request.ownerGeneration !== args.ownerGeneration
  ) {
    return null;
  }
  return request;
};

const acquireRemoteTurnAttemptCore = async (
  ctx: MutationCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    source: RemoteTurnAttemptSource;
    deviceId?: string;
    now: number;
  },
) => {
  validateAttemptId(args.attemptId);
  const request = await findRemoteTurnRequest(ctx, args.requestId);
  if (
    !request ||
    request.type !== "remote_turn_request" ||
    request.conversationId !== args.conversationId
  ) {
    return {
      acquired: false,
      status: "cancelled" as const,
      attemptId: args.attemptId,
      ...emptyAttemptTimes(),
    };
  }
  if (
    request.ownerBindingState !== "bound" ||
    !request.ownerId ||
    !request.ownerGeneration
  ) {
    if (!request.activeAttemptId) {
      await ctx.db.patch(request._id, {
        ownerBindingState: "legacy_unbound",
        requestState: "cancelled",
        cancelledAt: args.now,
        requestTerminalReason: "legacy_unbound",
      });
    }
    return {
      acquired: false,
      status: "legacy_unbound" as const,
      attemptId: args.attemptId,
      ...emptyAttemptTimes(),
    };
  }
  if (
    request.ownerId !== args.ownerId ||
    request.ownerGeneration !== args.ownerGeneration
  ) {
    return {
      acquired: false,
      status: "cancelled" as const,
      attemptId: args.attemptId,
      ...emptyAttemptTimes(),
    };
  }

  const conversation = await ctx.db.get(args.conversationId);
  if (!conversation || conversation.ownerId !== args.ownerId) {
    await markRemoteTurnAttemptCancellation(
      ctx,
      request,
      "ownership_migrated",
      args.now,
    );
    return {
      acquired: false,
      status: "cancelled" as const,
      attemptId: args.attemptId,
      leaseExpiresAt: request.attemptLeaseExpiresAt ?? 0,
      hardExpiresAt: request.attemptHardExpiresAt ?? 0,
      quiescentAfterAt: request.attemptQuiescentAfterAt ?? 0,
    };
  }
  if (
    request.requestState === "fulfilled" ||
    request.requestState === "cancelled"
  ) {
    return {
      acquired: false,
      status: "cancelled" as const,
      attemptId: args.attemptId,
      leaseExpiresAt: request.attemptLeaseExpiresAt ?? 0,
      hardExpiresAt: request.attemptHardExpiresAt ?? 0,
      quiescentAfterAt: request.attemptQuiescentAfterAt ?? 0,
    };
  }

  if (request.activeAttemptId) {
    if (
      attemptTupleMatches(request, args) &&
      request.activeAttemptState === "active" &&
      args.now < (request.attemptLeaseExpiresAt ?? 0) &&
      args.now < (request.attemptHardExpiresAt ?? 0)
    ) {
      return {
        acquired: true,
        status: "reserved" as const,
        attemptId: args.attemptId,
        leaseExpiresAt: request.attemptLeaseExpiresAt ?? 0,
        hardExpiresAt: request.attemptHardExpiresAt ?? 0,
        quiescentAfterAt: request.attemptQuiescentAfterAt ?? 0,
      };
    }
    if (
      args.now < (request.attemptQuiescentAfterAt ?? Number.MAX_SAFE_INTEGER)
    ) {
      return {
        acquired: false,
        status:
          request.activeAttemptState === "cancel_requested"
            ? ("cancelled" as const)
            : ("busy" as const),
        attemptId: args.attemptId,
        leaseExpiresAt: request.attemptLeaseExpiresAt ?? 0,
        hardExpiresAt: request.attemptHardExpiresAt ?? 0,
        quiescentAfterAt: request.attemptQuiescentAfterAt ?? 0,
      };
    }
    if (request.attemptCleanupJobId) {
      await ctx.scheduler.cancel(request.attemptCleanupJobId);
    }
  }

  try {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
  } catch {
    const migrated = await hasOwnerMigrationSourceFence(ctx, args.ownerId);
    await markRemoteTurnAttemptCancellation(
      ctx,
      request,
      migrated ? "ownership_migrated" : "owner_data_changed",
      args.now,
    );
    return {
      acquired: false,
      status: "cancelled" as const,
      attemptId: args.attemptId,
      leaseExpiresAt: request.attemptLeaseExpiresAt ?? 0,
      hardExpiresAt: request.attemptHardExpiresAt ?? 0,
      quiescentAfterAt: request.attemptQuiescentAfterAt ?? 0,
    };
  }

  const leaseExpiresAt = args.now + REMOTE_TURN_ATTEMPT_LEASE_MS;
  const hardExpiresAt = args.now + REMOTE_TURN_ATTEMPT_HARD_MS;
  const quiescentAfterAt =
    leaseExpiresAt + REMOTE_TURN_ATTEMPT_QUIESCENCE_GRACE_MS;
  const cleanupJobId = await ctx.scheduler.runAt(
    quiescentAfterAt,
    internal.channels.connector_delivery.expireRemoteTurnAttemptInternal,
    {
      requestId: args.requestId,
      attemptId: args.attemptId,
      quiescentAfterAt,
    },
  );
  await ctx.db.patch(request._id, {
    requestState: "claimed",
    claimedAt: args.now,
    ...(args.deviceId ? { claimedByDeviceId: args.deviceId } : {}),
    activeAttemptId: args.attemptId,
    activeAttemptSource: args.source,
    activeAttemptDeviceId: args.deviceId,
    activeAttemptState: "active",
    activeAttemptPhase: "running",
    attemptStartedAt: args.now,
    attemptLastHeartbeatAt: args.now,
    attemptLeaseExpiresAt: leaseExpiresAt,
    attemptHardExpiresAt: hardExpiresAt,
    attemptQuiescentAfterAt: quiescentAfterAt,
    attemptCleanupJobId: cleanupJobId,
    attemptCancelRequestedAt: undefined,
    requestTerminalReason: undefined,
  });
  return {
    acquired: true,
    status: "reserved" as const,
    attemptId: args.attemptId,
    leaseExpiresAt,
    hardExpiresAt,
    quiescentAfterAt,
  };
};

const heartbeatRemoteTurnAttemptCore = async (
  ctx: MutationCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    source: RemoteTurnAttemptSource;
    deviceId?: string;
    now: number;
  },
) => {
  const request = await assertExactBoundRequest(ctx, args);
  if (!request || !attemptTupleMatches(request, args)) {
    return {
      allowed: false,
      cancelRequested: true,
      leaseExpiresAt: null,
      hardExpiresAt: null,
      quiescentAfterAt: null,
    };
  }
  const currentTimes = {
    leaseExpiresAt: request.attemptLeaseExpiresAt ?? null,
    hardExpiresAt: request.attemptHardExpiresAt ?? null,
    quiescentAfterAt: request.attemptQuiescentAfterAt ?? null,
  };
  if (
    request.requestState === "cancelled" ||
    request.requestState === "fulfilled" ||
    request.activeAttemptState !== "active" ||
    args.now >= (request.attemptLeaseExpiresAt ?? 0) ||
    args.now >= (request.attemptHardExpiresAt ?? 0)
  ) {
    return { allowed: false, cancelRequested: true, ...currentTimes };
  }
  const conversation = await ctx.db.get(args.conversationId);
  if (!conversation || conversation.ownerId !== args.ownerId) {
    await markRemoteTurnAttemptCancellation(
      ctx,
      request,
      "ownership_migrated",
      args.now,
    );
    return { allowed: false, cancelRequested: true, ...currentTimes };
  }
  try {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
  } catch {
    const migrated = await hasOwnerMigrationSourceFence(ctx, args.ownerId);
    await markRemoteTurnAttemptCancellation(
      ctx,
      request,
      migrated ? "ownership_migrated" : "owner_data_changed",
      args.now,
    );
    return { allowed: false, cancelRequested: true, ...currentTimes };
  }

  // The hard deadline is immutable from acquisition for every executor. A
  // heartbeat can extend only the rolling soft lease; otherwise a live
  // desktop could keep migration/account deletion waiting forever.
  const hardExpiresAt = request.attemptHardExpiresAt ?? args.now;
  const leaseExpiresAt = Math.min(
    hardExpiresAt,
    args.now + REMOTE_TURN_ATTEMPT_LEASE_MS,
  );
  const quiescentAfterAt =
    leaseExpiresAt + REMOTE_TURN_ATTEMPT_QUIESCENCE_GRACE_MS;
  if (request.attemptCleanupJobId) {
    await ctx.scheduler.cancel(request.attemptCleanupJobId);
  }
  const cleanupJobId = await ctx.scheduler.runAt(
    quiescentAfterAt,
    internal.channels.connector_delivery.expireRemoteTurnAttemptInternal,
    {
      requestId: args.requestId,
      attemptId: args.attemptId,
      quiescentAfterAt,
    },
  );
  await ctx.db.patch(request._id, {
    attemptLastHeartbeatAt: args.now,
    attemptLeaseExpiresAt: leaseExpiresAt,
    attemptHardExpiresAt: hardExpiresAt,
    attemptQuiescentAfterAt: quiescentAfterAt,
    attemptCleanupJobId: cleanupJobId,
  });
  return {
    allowed: true,
    cancelRequested: false,
    leaseExpiresAt,
    hardExpiresAt,
    quiescentAfterAt,
  };
};

const staleRemoteTurnAttemptError = () =>
  new ConvexError({
    code: "REMOTE_TURN_ATTEMPT_STALE",
    message: "The remote-turn execution attempt is no longer authoritative.",
  });

const clearRemoteTurnAttemptPatch = () => ({
  activeAttemptId: undefined,
  activeAttemptSource: undefined,
  activeAttemptDeviceId: undefined,
  activeAttemptState: undefined,
  activeAttemptPhase: undefined,
  attemptStartedAt: undefined,
  attemptLastHeartbeatAt: undefined,
  attemptLeaseExpiresAt: undefined,
  attemptHardExpiresAt: undefined,
  attemptQuiescentAfterAt: undefined,
  attemptCleanupJobId: undefined,
  attemptCancelRequestedAt: undefined,
});

const hasAmbiguousProviderSpend = (request: Doc<"events">): boolean =>
  request.lastProviderDispatchOutcome === "in_flight" ||
  request.lastProviderDispatchOutcome === "succeeded" ||
  request.lastProviderDispatchOutcome === "outcome_unknown";

const finishRemoteTurnAttemptCore = async (
  ctx: MutationCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    source: RemoteTurnAttemptSource;
    deviceId?: string;
    outcome: RemoteTurnDispatchOutcome;
    now: number;
  },
) => {
  const request = await assertExactBoundRequest(ctx, args);
  if (
    request &&
    !request.activeAttemptId &&
    request.lastAttemptId === args.attemptId
  ) {
    const requestState =
      request.requestState === "fulfilled"
        ? ("fulfilled" as const)
        : request.requestState === "cancelled"
          ? ("cancelled" as const)
          : request.requestState === "claimed"
            ? ("claimed" as const)
            : ("pending" as const);
    return { acknowledged: true as const, requestState };
  }
  if (!request || !attemptTupleMatches(request, args)) {
    throw staleRemoteTurnAttemptError();
  }
  if (args.outcome === "succeeded" && request.requestState !== "fulfilled") {
    throw new ConvexError({
      code: "REMOTE_TURN_COMPLETION_NOT_ACCEPTED",
      message: "A remote turn cannot ACK success before exact fulfillment.",
    });
  }
  if (request.attemptCleanupJobId) {
    await ctx.scheduler.cancel(request.attemptCleanupJobId);
  }
  const requestState =
    request.requestState === "cancelled"
      ? ("cancelled" as const)
      : request.requestState === "fulfilled"
        ? ("fulfilled" as const)
        : request.activeAttemptPhase === "running" &&
            !hasAmbiguousProviderSpend(request)
          ? ("pending" as const)
          : ("claimed" as const);
  await ctx.db.patch(request._id, {
    ...clearRemoteTurnAttemptPatch(),
    requestState,
    ...(requestState === "pending"
      ? {
          claimedAt: undefined,
          claimedByDeviceId: undefined,
        }
      : {}),
    lastAttemptId: args.attemptId,
    lastAttemptOutcome: args.outcome,
    lastAttemptFinishedAt: args.now,
  });
  return { acknowledged: true as const, requestState };
};

export const acquireRemoteTurnAttemptInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    now: v.number(),
  },
  returns: remoteTurnAttemptResultValidator,
  handler: async (ctx, args) => await acquireRemoteTurnAttemptCore(ctx, args),
});

export const heartbeatRemoteTurnAttemptInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    now: v.number(),
  },
  returns: remoteTurnHeartbeatResultValidator,
  handler: async (ctx, args) => await heartbeatRemoteTurnAttemptCore(ctx, args),
});

export const assertRemoteTurnAttemptActiveInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    now: v.number(),
  },
  returns: remoteTurnHeartbeatResultValidator,
  handler: async (ctx, args) => await heartbeatRemoteTurnAttemptCore(ctx, args),
});

export const beginRemoteTurnProviderDispatchInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    providerDispatchId: v.string(),
    now: v.number(),
  },
  returns: v.object({
    deadlineAt: v.number(),
    ordinal: v.number(),
  }),
  handler: async (ctx, args) => {
    validateAttemptId(args.providerDispatchId);
    const pulse = await heartbeatRemoteTurnAttemptCore(ctx, args);
    if (
      !pulse.allowed ||
      pulse.leaseExpiresAt === null ||
      pulse.hardExpiresAt === null
    ) {
      throw staleRemoteTurnAttemptError();
    }
    const deadlineAt = Math.min(
      args.now + REMOTE_TURN_PROVIDER_DEADLINE_MS,
      pulse.leaseExpiresAt - 1_000,
      pulse.hardExpiresAt - 1_000,
    );
    if (deadlineAt <= args.now) throw staleRemoteTurnAttemptError();
    const request = await assertExactBoundRequest(ctx, args);
    if (!request || !attemptTupleMatches(request, args)) {
      throw staleRemoteTurnAttemptError();
    }
    const ordinal = (request.providerDispatchOrdinal ?? 0) + 1;
    await ctx.db.patch(request._id, {
      providerDispatchCount: (request.providerDispatchCount ?? 0) + 1,
      providerDispatchOrdinal: ordinal,
      lastProviderDispatchId: args.providerDispatchId,
      lastProviderDispatchOutcome: "in_flight",
      lastProviderDispatchAt: args.now,
    });
    return { deadlineAt, ordinal };
  },
});

export const settleRemoteTurnProviderDispatchInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    providerDispatchId: v.string(),
    outcome: remoteTurnSettledOutcomeValidator,
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const request = await assertExactBoundRequest(ctx, args);
    if (
      !request ||
      !attemptTupleMatches(request, args) ||
      request.lastProviderDispatchId !== args.providerDispatchId
    ) {
      return false;
    }
    await ctx.db.patch(request._id, {
      lastProviderDispatchOutcome: args.outcome,
      lastProviderDispatchAt: args.now,
    });
    return true;
  },
});

/**
 * No-charge post-receipt ACK: every physical provider try is already billed
 * from its generic receipt. This mutation only proves the exact remote tuple
 * is still authoritative before assistant persistence and delivery.
 */
export const acknowledgeRemoteTurnUsageDispositionInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const request = await assertExactBoundRequest(ctx, args);
    if (
      !request ||
      !attemptTupleMatches(request, args) ||
      request.requestState !== "claimed" ||
      request.activeAttemptState !== "active" ||
      request.activeAttemptPhase !== "running" ||
      args.now >= (request.attemptLeaseExpiresAt ?? 0) ||
      args.now >= (request.attemptHardExpiresAt ?? 0)
    ) {
      return false;
    }
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.ownerId !== args.ownerId) {
      await markRemoteTurnAttemptCancellation(
        ctx,
        request,
        "ownership_migrated",
        args.now,
      );
      return false;
    }
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      const migrated = await hasOwnerMigrationSourceFence(ctx, args.ownerId);
      await markRemoteTurnAttemptCancellation(
        ctx,
        request,
        migrated ? "ownership_migrated" : "owner_data_changed",
        args.now,
      );
      return false;
    }
    return true;
  },
});

export const appendRemoteTurnAssistantMessageInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    provider: v.string(),
    text: v.string(),
    appendAssistantEvent: v.boolean(),
    usage: v.optional(
      v.object({
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
        totalTokens: v.optional(v.number()),
      }),
    ),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const request = await assertExactBoundRequest(ctx, args);
    if (
      !request ||
      !attemptTupleMatches(request, args) ||
      request.requestState !== "claimed" ||
      request.activeAttemptState !== "active" ||
      (request.activeAttemptPhase !== "running" &&
        request.activeAttemptPhase !== "completion_accepted") ||
      args.now >= (request.attemptLeaseExpiresAt ?? 0) ||
      args.now >= (request.attemptHardExpiresAt ?? 0)
    ) {
      return false;
    }
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.ownerId !== args.ownerId) {
      await markRemoteTurnAttemptCancellation(
        ctx,
        request,
        "ownership_migrated",
        args.now,
      );
      return false;
    }
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      const migrated = await hasOwnerMigrationSourceFence(ctx, args.ownerId);
      await markRemoteTurnAttemptCancellation(
        ctx,
        request,
        migrated ? "ownership_migrated" : "owner_data_changed",
        args.now,
      );
      return false;
    }
    if (args.appendAssistantEvent) {
      await appendEventCore(ctx, {
        conversationId: args.conversationId,
        type: "assistant_message",
        payload: {
          text: args.text,
          source: `channel:${args.provider}`,
          ...(args.usage ? { usage: args.usage } : {}),
        },
      });
    }
    await ctx.db.patch(request._id, {
      activeAttemptPhase: "completion_accepted",
      completionAttemptId: args.attemptId,
      completionText: args.text.slice(0, 200_000),
      completionAcceptedAt: args.now,
    });
    return true;
  },
});

export const finishRemoteTurnAttemptInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    outcome: remoteTurnSettledOutcomeValidator,
    now: v.number(),
  },
  returns: remoteTurnFinishResultValidator,
  handler: async (ctx, args) => await finishRemoteTurnAttemptCore(ctx, args),
});

export const expireRemoteTurnAttemptInternal = internalMutation({
  args: {
    requestId: v.string(),
    attemptId: v.string(),
    quiescentAfterAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (
      !request ||
      request.type !== "remote_turn_request" ||
      request.activeAttemptId !== args.attemptId ||
      request.attemptQuiescentAfterAt !== args.quiescentAfterAt
    ) {
      return null;
    }
    const now = Date.now();
    if (now < args.quiescentAfterAt) {
      const cleanupJobId = await ctx.scheduler.runAt(
        args.quiescentAfterAt,
        internal.channels.connector_delivery.expireRemoteTurnAttemptInternal,
        args,
      );
      await ctx.db.patch(request._id, { attemptCleanupJobId: cleanupJobId });
      return null;
    }
    const requestState =
      request.requestState === "cancelled"
        ? ("cancelled" as const)
        : request.requestState === "fulfilled"
          ? ("fulfilled" as const)
          : request.activeAttemptPhase === "running" &&
              !hasAmbiguousProviderSpend(request)
            ? ("pending" as const)
            : ("claimed" as const);
    await ctx.db.patch(request._id, {
      ...clearRemoteTurnAttemptPatch(),
      requestState,
      ...(requestState === "pending"
        ? { claimedAt: undefined, claimedByDeviceId: undefined }
        : {}),
      lastAttemptId: args.attemptId,
      lastAttemptOutcome: "timed_out",
      lastAttemptFinishedAt: now,
    });
    return null;
  },
});

export const terminalizeLegacyRemoteTurnInternal = internalMutation({
  args: {
    eventId: v.id("events"),
    requestId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.eventId);
    if (
      !request ||
      request.type !== "remote_turn_request" ||
      request.requestId !== args.requestId ||
      request.ownerBindingState === "bound"
    ) {
      return false;
    }
    await markRemoteTurnAttemptCancellation(
      ctx,
      request,
      "legacy_unbound",
      args.now,
    );
    await ctx.db.patch(request._id, { ownerBindingState: "legacy_unbound" });
    return true;
  },
});

/**
 * Close every live remote executor for a destructive owner purge without
 * recapturing the post-fence generation. The lifecycle fence prevents new
 * attempts; this bounded pass requests cancellation, retains each attempt's
 * pre-existing transport/quiescence bound, and clears authority only after
 * that bound. Conversation deletion must not start until `ready` is true.
 */
export const quiesceOwnerRemoteTurnsForPurgeInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: v.union(v.literal("reset"), v.literal("delete")),
    now: v.number(),
  },
  returns: v.object({
    ready: v.boolean(),
    processed: v.number(),
    cancellationRequested: v.number(),
    quiesced: v.number(),
    retryAfterAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, { ...args, stage: "core" });
    const processRows = async (rows: Doc<"events">[]) => {
      let cancellationRequested = 0;
      let quiesced = 0;
      let retryAfterAt: number | null = null;

      for (const request of rows) {
        const bounds = resolveRemoteTurnCancellationBounds(request, args.now);
        const exactOwnerBound =
          request.type === "remote_turn_request" &&
          request.ownerBindingState === "bound" &&
          request.ownerId === args.ownerId;
        const terminalReason =
          request.requestTerminalReason === "ownership_migrated"
            ? ("ownership_migrated" as const)
            : exactOwnerBound
              ? ("owner_data_changed" as const)
              : ("legacy_unbound" as const);

        if (args.now < bounds.quiescentAfterAt) {
          const needsCancellationPatch =
            request.activeAttemptState !== "cancel_requested" ||
            request.requestState !== "cancelled" ||
            request.attemptLeaseExpiresAt === undefined ||
            request.attemptHardExpiresAt === undefined ||
            request.attemptQuiescentAfterAt === undefined;
          if (needsCancellationPatch) {
            if (
              request.type === "remote_turn_request" &&
              request.requestId &&
              request.activeAttemptId
            ) {
              await markRemoteTurnAttemptCancellation(
                ctx,
                request,
                terminalReason,
                args.now,
              );
              if (!exactOwnerBound) {
                await ctx.db.patch(request._id, {
                  ownerBindingState: "legacy_unbound",
                });
              }
            } else {
              // Corrupt pre-binding rows cannot be addressed by request id,
              // but their transport debt is still real. Persist one fixed
              // conservative bound and wait it out instead of deleting early.
              await ctx.db.patch(request._id, {
                activeAttemptState: "cancel_requested",
                attemptCancelRequestedAt: args.now,
                attemptLeaseExpiresAt: bounds.leaseExpiresAt,
                attemptHardExpiresAt: bounds.hardExpiresAt,
                attemptQuiescentAfterAt: bounds.quiescentAfterAt,
                ...(request.type === "remote_turn_request"
                  ? {
                      requestState: "cancelled" as const,
                      cancelledAt: request.cancelledAt ?? args.now,
                      requestTerminalReason: "legacy_unbound" as const,
                      ownerBindingState: "legacy_unbound" as const,
                    }
                  : {}),
              });
            }
            cancellationRequested += 1;
          }
          retryAfterAt =
            retryAfterAt === null
              ? bounds.quiescentAfterAt
              : Math.min(retryAfterAt, bounds.quiescentAfterAt);
          continue;
        }

        if (request.attemptCleanupJobId) {
          await ctx.scheduler.cancel(request.attemptCleanupJobId);
        }
        await ctx.db.patch(request._id, {
          ...clearRemoteTurnAttemptPatch(),
          ...(request.type === "remote_turn_request"
            ? {
                requestState: "cancelled" as const,
                cancelledAt: request.cancelledAt ?? args.now,
                requestTerminalReason: terminalReason,
                ...(!exactOwnerBound
                  ? { ownerBindingState: "legacy_unbound" as const }
                  : {}),
              }
            : {}),
          ...(request.activeAttemptId
            ? {
                lastAttemptId: request.activeAttemptId,
                lastAttemptOutcome: "timed_out" as const,
                lastAttemptFinishedAt: args.now,
              }
            : {}),
        });
        quiesced += 1;
      }
      return { cancellationRequested, quiesced, retryAfterAt };
    };

    const readOwnerAttemptRows = async () => {
      const [active, cancelRequested] = await Promise.all([
        ctx.db
          .query("events")
          .withIndex("by_ownerId_activeAttemptState", (q) =>
            q.eq("ownerId", args.ownerId).eq("activeAttemptState", "active"),
          )
          .take(REMOTE_TURN_PURGE_BATCH),
        ctx.db
          .query("events")
          .withIndex("by_ownerId_activeAttemptState", (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("activeAttemptState", "cancel_requested"),
          )
          .take(REMOTE_TURN_PURGE_BATCH),
      ]);
      return [...active, ...cancelRequested].slice(0, REMOTE_TURN_PURGE_BATCH);
    };

    // Exact owner-bound rows are cheapest to enumerate and must drain before
    // the legacy conversation scan can be declared complete.
    let completedProcessed = 0;
    let completedCancellationRequested = 0;
    let completedQuiesced = 0;
    const ownerRows = await readOwnerAttemptRows();
    if (ownerRows.length > 0) {
      const progress = await processRows(ownerRows);
      if (
        progress.retryAfterAt !== null ||
        (await readOwnerAttemptRows()).length > 0
      ) {
        return {
          ready: false,
          processed: ownerRows.length,
          cancellationRequested: progress.cancellationRequested,
          quiesced: progress.quiesced,
          retryAfterAt: progress.retryAfterAt,
        };
      }
      completedProcessed = ownerRows.length;
      completedCancellationRequested = progress.cancellationRequested;
      completedQuiesced = progress.quiesced;
    }

    const purgeJob = await ctx.db
      .query("cloud_owner_purge_jobs")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (
      !purgeJob ||
      purgeJob.operationId !== args.operationId ||
      purgeJob.generation !== args.generation ||
      purgeJob.leaseId !== args.leaseId
    ) {
      throw new Error("Remote-turn purge scan lost its exact purge lease.");
    }
    if (purgeJob.remoteTurnConversationScanComplete === true) {
      return {
        ready: true,
        processed: completedProcessed,
        cancellationRequested: completedCancellationRequested,
        quiesced: completedQuiesced,
        retryAfterAt: null,
      };
    }

    const page = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .paginate({
        cursor: purgeJob.remoteTurnConversationCursor ?? null,
        numItems: REMOTE_TURN_PURGE_CONVERSATION_PAGE,
      });
    const legacyRowsById = new Map<string, Doc<"events">>();
    for (const conversation of page.page) {
      const [active, cancelRequested] = await Promise.all([
        ctx.db
          .query("events")
          .withIndex("by_conversationId_activeAttemptState", (q) =>
            q
              .eq("conversationId", conversation._id)
              .eq("activeAttemptState", "active"),
          )
          .take(REMOTE_TURN_PURGE_PER_CONVERSATION_BATCH),
        ctx.db
          .query("events")
          .withIndex("by_conversationId_activeAttemptState", (q) =>
            q
              .eq("conversationId", conversation._id)
              .eq("activeAttemptState", "cancel_requested"),
          )
          .take(REMOTE_TURN_PURGE_PER_CONVERSATION_BATCH),
      ]);
      for (const row of [...active, ...cancelRequested]) {
        legacyRowsById.set(String(row._id), row);
      }
    }
    const legacyRows = [...legacyRowsById.values()].slice(
      0,
      REMOTE_TURN_PURGE_BATCH,
    );
    if (legacyRows.length > 0) {
      // Replay this same page until every discovered active tuple has ACKed or
      // crossed its fixed bound; only then may the durable cursor advance.
      const progress = await processRows(legacyRows);
      return {
        ready: false,
        processed: completedProcessed + legacyRows.length,
        cancellationRequested:
          completedCancellationRequested + progress.cancellationRequested,
        quiesced: completedQuiesced + progress.quiesced,
        retryAfterAt: progress.retryAfterAt,
      };
    }

    await ctx.db.patch(purgeJob._id, {
      remoteTurnConversationCursor: page.isDone
        ? undefined
        : page.continueCursor,
      remoteTurnConversationScanComplete: page.isDone ? true : undefined,
      updatedAt: args.now,
    });
    return {
      ready: page.isDone,
      processed: completedProcessed,
      cancellationRequested: completedCancellationRequested,
      quiesced: completedQuiesced,
      retryAfterAt: null,
    };
  },
});

// ─── Public Mutation (called by local device via HTTP) ──────────────────────
export const claimRemoteTurn = mutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    attemptId: v.string(),
  },
  returns: remoteTurnAttemptResultValidator,
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    const identity = await ctx.auth.getUserIdentity();
    if (
      !request ||
      request.type !== "remote_turn_request" ||
      request.conversationId !== args.conversationId ||
      request.ownerBindingState !== "bound" ||
      request.targetDeviceId !== args.deviceId ||
      !request.ownerId ||
      !request.ownerGeneration ||
      identity?.tokenIdentifier !== request.ownerId
    ) {
      return {
        acquired: false,
        status: !request?.ownerGeneration
          ? ("legacy_unbound" as const)
          : ("cancelled" as const),
        attemptId: args.attemptId,
        ...emptyAttemptTimes(),
      };
    }
    const conversation = await requireConversationOwner(
      ctx,
      args.conversationId,
    );
    await enforceMutationRateLimit(
      ctx,
      "connector_claim_remote_turn",
      conversation.ownerId,
      RATE_HOT_PATH,
    );
    const result = await acquireRemoteTurnAttemptCore(ctx, {
      ...args,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration,
      source: "desktop",
      now: Date.now(),
    });
    if (result.acquired) {
      await ctx.runMutation(
        internal.channels.connector_turn_payloads.deleteByRequestId,
        { requestId: args.requestId },
      );
    }
    return result;
  },
});

export const heartbeatRemoteTurn = mutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    attemptId: v.string(),
  },
  returns: remoteTurnHeartbeatResultValidator,
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    const identity = await ctx.auth.getUserIdentity();
    if (
      !request ||
      request.type !== "remote_turn_request" ||
      request.conversationId !== args.conversationId ||
      request.ownerBindingState !== "bound" ||
      !request.ownerId ||
      !request.ownerGeneration ||
      identity?.tokenIdentifier !== request.ownerId
    ) {
      return {
        allowed: false,
        cancelRequested: true,
        leaseExpiresAt: null,
        hardExpiresAt: null,
        quiescentAfterAt: null,
      };
    }
    return await heartbeatRemoteTurnAttemptCore(ctx, {
      ...args,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration,
      source: "desktop",
      now: Date.now(),
    });
  },
});

/**
 * Caller-initiated cancellation of an in-flight remote turn. Patches the
 * `remote_turn_request` row to `cancelled` so:
 *   1. If the local device hasn't claimed it yet, the device's
 *      `subscribeRemoteTurnRequestsForDevice` snapshot drops the row at the
 *      next reactive update and the bridge garbage-collects its pending
 *      entry.
 *   2. If the local device has already claimed and started the run, the
 *      device subscribes to `subscribeRemoteTurnCancelsForDevice` and aborts
 *      the active orchestrator run on the next snapshot.
 *
 * Idempotent: a cancel against a `fulfilled` row is a no-op (the reply has
 * already been delivered). A second cancel against an already-`cancelled`
 * row is also a no-op.
 */
export const cancelRemoteTurn = mutation({
  args: {
    requestId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") return null;
    // Verify the caller owns the conversation this request belongs to;
    // the conversationId is derived from the request row rather than
    // trusted from the caller (the mobile client only knows requestId).
    const conversation = await requireConversationOwner(
      ctx,
      request.conversationId,
    );
    await enforceMutationRateLimit(
      ctx,
      "connector_cancel_remote_turn",
      conversation.ownerId,
      RATE_HOT_PATH,
    );

    if (
      request.requestState === "fulfilled" ||
      request.requestState === "cancelled"
    ) {
      return null;
    }

    await markRemoteTurnAttemptCancellation(
      ctx,
      request,
      "user_cancelled",
      Date.now(),
    );
    await ctx.runMutation(
      internal.channels.connector_turn_payloads.deleteByRequestId,
      { requestId: args.requestId },
    );

    return null;
  },
});

export const completeRemoteTurn = mutation({
  args: {
    requestId: v.string(),
    text: v.string(),
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    attemptId: v.string(),
  },
  returns: v.object({
    accepted: v.literal(true),
    status: v.union(v.literal("completion_accepted"), v.literal("fulfilled")),
  }),
  handler: async (ctx, args) => {
    // Read routing metadata from the original remote_turn_request event
    // (never trust caller-provided routing data)
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    const identity = await ctx.auth.getUserIdentity();
    if (!request || request.type !== "remote_turn_request") {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Invalid or missing remote_turn_request",
      });
    }
    if (request.conversationId !== args.conversationId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Request does not belong to this conversation",
      });
    }
    if (
      request.ownerBindingState !== "bound" ||
      !request.ownerId ||
      !request.ownerGeneration ||
      identity?.tokenIdentifier !== request.ownerId
    ) {
      throw staleRemoteTurnAttemptError();
    }
    await enforceMutationRateLimit(
      ctx,
      "connector_complete_remote_turn",
      request.ownerId,
      RATE_HOT_PATH,
    );
    if (
      request.requestState === "fulfilled" &&
      request.lastAttemptId === args.attemptId
    ) {
      return { accepted: true as const, status: "fulfilled" as const };
    }
    const pulse = await heartbeatRemoteTurnAttemptCore(ctx, {
      ...args,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration,
      source: "desktop",
      now: Date.now(),
    });
    if (!pulse.allowed) throw staleRemoteTurnAttemptError();

    const current = await assertExactBoundRequest(ctx, {
      requestId: args.requestId,
      conversationId: args.conversationId,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration,
    });
    if (
      !current ||
      !attemptTupleMatches(current, {
        ...args,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        source: "desktop",
      })
    ) {
      throw staleRemoteTurnAttemptError();
    }
    if (
      current.activeAttemptPhase === "completion_accepted" ||
      current.activeAttemptPhase === "delivering"
    ) {
      return {
        accepted: true as const,
        status: "completion_accepted" as const,
      };
    }

    const reqPayload = current.payload as Record<string, unknown>;
    const provider = reqPayload.provider as string;
    const deliveryMeta = reqPayload.deliveryMeta as Record<string, unknown>;

    await ctx.db.patch(current._id, {
      activeAttemptPhase: "completion_accepted",
      completionAttemptId: args.attemptId,
      completionText: args.text.slice(0, 200_000),
      completionAcceptedAt: Date.now(),
    });

    // Schedule async delivery — fulfilled marker is set by
    // deliverToConnector AFTER successful delivery
    await ctx.scheduler.runAfter(
      0,
      internal.channels.connector_delivery.deliverToConnector,
      {
        requestId: args.requestId,
        conversationId: args.conversationId,
        provider,
        deliveryMeta: JSON.parse(JSON.stringify(deliveryMeta ?? {})),
        text: args.text,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        attemptId: args.attemptId,
        source: "desktop",
        deviceId: args.deviceId,
      },
    );
    await ctx.runMutation(
      internal.channels.connector_turn_payloads.deleteByRequestId,
      { requestId: args.requestId },
    );

    return {
      accepted: true as const,
      status: "completion_accepted" as const,
    };
  },
});

export const finishRemoteTurnAttempt = mutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    attemptId: v.string(),
    outcome: v.union(
      v.literal("failed"),
      v.literal("aborted"),
      v.literal("timed_out"),
    ),
  },
  returns: remoteTurnFinishResultValidator,
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    const identity = await ctx.auth.getUserIdentity();
    if (
      !request ||
      request.type !== "remote_turn_request" ||
      request.conversationId !== args.conversationId ||
      request.ownerBindingState !== "bound" ||
      !request.ownerId ||
      !request.ownerGeneration ||
      identity?.tokenIdentifier !== request.ownerId
    ) {
      throw staleRemoteTurnAttemptError();
    }
    if (request.lastAttemptId === args.attemptId && !request.activeAttemptId) {
      const requestState =
        request.requestState === "fulfilled"
          ? ("fulfilled" as const)
          : request.requestState === "cancelled"
            ? ("cancelled" as const)
            : ("pending" as const);
      return { acknowledged: true as const, requestState };
    }
    return await finishRemoteTurnAttemptCore(ctx, {
      ...args,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration,
      source: "desktop",
      now: Date.now(),
    });
  },
});

/**
 * Send an unsolicited follow-up message to the connector that initiated
 * the most recent remote turn for a conversation. Routing metadata is
 * read from the original `remote_turn_request` row (never trust the
 * caller). Unlike `completeRemoteTurn`, this does NOT flip any request
 * lifecycle state — the original request stays in its existing terminal
 * state ("fulfilled" after the first reply landed).
 *
 * Used by the desktop runtime to forward later assistant messages
 * produced after the orchestrator's first turn (e.g. responses to
 * spawned-agent completion notices) back to the user's device.
 * while the conversation is still being driven from that connector.
 */
export const sendConnectorFollowup = mutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    text: v.string(),
    deviceId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await requireConversationOwner(
      ctx,
      args.conversationId,
    );
    await enforceMutationRateLimit(
      ctx,
      "connector_send_followup",
      conversation.ownerId,
      RATE_HOT_PATH,
    );

    const trimmed = args.text.trim();
    if (!trimmed) return null;

    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Invalid or missing remote_turn_request",
      });
    }
    if (request.conversationId !== args.conversationId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Request does not belong to this conversation",
      });
    }
    if (
      request.ownerBindingState !== "bound" ||
      request.ownerId !== conversation.ownerId ||
      !request.ownerGeneration ||
      request.requestState !== "fulfilled" ||
      request.requestTerminalReason !== undefined
    ) {
      throw staleRemoteTurnAttemptError();
    }
    await assertOwnerMigrationWriteAllowed(
      ctx,
      request.ownerId,
      request.ownerGeneration,
    );

    await ctx.scheduler.runAfter(
      0,
      internal.channels.connector_delivery.deliverConnectorFollowup,
      {
        text: trimmed,
        requestId: args.requestId,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
      },
    );

    return null;
  },
});

// ─── Shared delivery logic (callable from any action in the same runtime) ───

type DeliveryCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

type RemoteTurnAttemptBinding = {
  requestId: string;
  conversationId: Id<"conversations">;
  ownerId: string;
  ownerGeneration: string;
  attemptId: string;
  source: RemoteTurnAttemptSource;
  deviceId?: string;
};

type DeliveryArgs = RemoteTurnAttemptBinding & {
  provider: string;
  deliveryMeta: Record<string, unknown>;
  text: string;
  media?: ConnectorMediaRef[];
};

async function dispatchConnectorDelivery(
  ctx: DeliveryCtx,
  args: {
    requestId?: string;
    conversationId?: Id<"conversations">;
    provider: string;
    deliveryMeta: Record<string, unknown>;
    text: string;
    media?: ConnectorMediaRef[];
  },
): Promise<void> {
  switch (args.provider) {
    case "stella_app":
      // Mobile chat replies travel over the authenticated desktop bridge, so
      // the reply text never lands in Convex — there is nothing to deliver.
      return;
    default:
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Unknown delivery provider: ${args.provider}`,
      });
  }
}

async function deliverToConnectorCore(
  ctx: DeliveryCtx,
  args: DeliveryArgs,
): Promise<boolean> {
  try {
    const allowed: boolean = await ctx.runMutation(
      internal.channels.connector_delivery.beginRemoteTurnDeliveryInternal,
      {
        requestId: args.requestId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId: args.attemptId,
        source: args.source,
        deviceId: args.deviceId,
        now: Date.now(),
      },
    );
    if (!allowed) throw staleRemoteTurnAttemptError();

    await dispatchConnectorDelivery(ctx, {
      requestId: args.requestId,
      conversationId: args.conversationId,
      provider: args.provider,
      deliveryMeta: args.deliveryMeta,
      text: args.text,
      media: args.media,
    });

    // Mark fulfilled AFTER successful delivery — patches the original
    // `remote_turn_request` row in place.
    const fulfillment: { acknowledged: boolean } = await ctx.runMutation(
      internal.channels.connector_delivery.markRemoteTurnFulfilled,
      {
        requestId: args.requestId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId: args.attemptId,
        source: args.source,
        deviceId: args.deviceId,
        now: Date.now(),
      },
    );
    if (!fulfillment.acknowledged) throw staleRemoteTurnAttemptError();
    return true;
  } catch (error) {
    console.error(
      `[connector_delivery] Delivery failed for ${args.provider}:`,
      error,
    );
    return false;
  }
}

type SettleExecution = RunAgentTurnResult["settleExecution"];

/**
 * The enclosing model/tool lease is the final authority for provider-adjacent
 * work. Release it only after the synchronous usage/persistence/delivery CAS,
 * then acknowledge the wider remote attempt. Both releases are attempted, but
 * neither failure is hidden.
 */
export async function settleExecutionThenRemoteAttempt(args: {
  settleExecution?: SettleExecution;
  finishRemoteAttempt: (
    outcome: RemoteTurnDispatchOutcome,
  ) => Promise<void>;
  outcome: RemoteTurnDispatchOutcome;
}): Promise<void> {
  const failures: unknown[] = [];
  if (args.settleExecution) {
    try {
      await args.settleExecution(args.outcome);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await args.finishRemoteAttempt(args.outcome);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Managed execution and remote-turn attempt settlement both failed.",
    );
  }
}

/**
 * Keep the enclosing managed execution alive across the connector's durable
 * assistant write and delivery CAS. `runAgent` may return only after every
 * physical model receipt plus the exact remote usage-disposition ACK is
 * durable; this sequence then owns both enclosing settlements exactly once.
 */
export async function runConnectorAgentTurnCommitSequence(args: {
  runAgent: () => Promise<RunAgentTurnResult>;
  persistAssistant: (result: RunAgentTurnResult) => Promise<void>;
  deliver: (result: RunAgentTurnResult) => Promise<boolean>;
  executionSignal: () => AbortSignal;
  finishRemoteAttempt: (
    outcome: RemoteTurnDispatchOutcome,
  ) => Promise<void>;
}): Promise<RunAgentTurnResult> {
  let result: RunAgentTurnResult | undefined;
  let outcome: RemoteTurnDispatchOutcome = "failed";
  try {
    result = await args.runAgent();
    await args.persistAssistant(result);
    const delivered = await args.deliver(result);
    if (!delivered) throw new Error("Connector delivery was not accepted.");
    outcome = "succeeded";
    return result;
  } catch (error) {
    outcome = managedExecutionOutcomeFromError(error, args.executionSignal());
    throw error;
  } finally {
    await settleExecutionThenRemoteAttempt({
      settleExecution: result?.settleExecution,
      finishRemoteAttempt: args.finishRemoteAttempt,
      outcome,
    });
  }
}

// ─── Shared: run backend fallback agent + deliver to connector ──────────────

async function runFallbackAndDeliver(
  ctx: ActionCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
    source: Exclude<RemoteTurnAttemptSource, "desktop">;
    prompt: string;
    provider: string;
    deliveryMeta: Record<string, unknown>;
    userMessageId?: string;
  },
): Promise<boolean> {
  const attempt = await acquireRemoteTurnAttemptGuard(ctx, {
    requestId: args.requestId,
    conversationId: args.conversationId,
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    source: args.source,
  });
  if (!attempt) return false;

  let executionSignal: AbortSignal = attempt.signal;
  let responseText = EMPTY_RESPONSE_TEXT;
  await runConnectorAgentTurnCommitSequence({
    runAgent: async () => {
      const modelDispatchGuard = composeManagedDispatchGuards(
        createManagedUsageDispatchGuard(ctx, {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          executionId: attempt.attemptId,
          spanExecution: true,
        }),
        attempt.modelDispatchGuard,
      );
      executionSignal = modelDispatchGuard.signal;
      const billingRequestFingerprint =
        await createManagedDispatchRequestFingerprint(
          "connector-agent-turn",
          JSON.stringify({
            requestId: args.requestId,
            attemptId: attempt.attemptId,
            source: args.source,
            conversationId: args.conversationId,
          }),
        );
      const result = await runAgentTurn({
        ctx,
        conversationId: args.conversationId,
        prompt: args.prompt,
        agentType: BACKEND_FALLBACK_AGENT_TYPE,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        modelDispatchGuard,
        billingIdentity: {
          requestFingerprint: billingRequestFingerprint,
          agentType: `proxy:${BACKEND_FALLBACK_AGENT_TYPE}`,
          conversationId: args.conversationId,
        },
        acknowledgeUsageDisposition: async () => {
          const accepted: boolean = await ctx.runMutation(
            internal.channels.connector_delivery
              .acknowledgeRemoteTurnUsageDispositionInternal,
            {
              requestId: args.requestId,
              conversationId: args.conversationId,
              ownerId: args.ownerId,
              ownerGeneration: args.ownerGeneration,
              attemptId: attempt.attemptId,
              source: args.source,
              now: Date.now(),
            },
          );
          if (!accepted) throw staleRemoteTurnAttemptError();
        },
        userMessageId: args.userMessageId as Id<"events"> | undefined,
        modelOverride:
          typeof args.deliveryMeta.mobileModel === "string"
            ? args.deliveryMeta.mobileModel
            : null,
      });
      responseText = result.text.trim() || EMPTY_RESPONSE_TEXT;
      return result;
    },
    persistAssistant: async (result) => {
      await persistConnectorAssistantMessage(ctx, {
        requestId: args.requestId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId: attempt.attemptId,
        source: args.source,
        provider: args.provider,
        text: responseText,
        appendAssistantEvent: Boolean(result.text.trim() && !result.silent),
        usage: result.usage,
      });
    },
    deliver: async () =>
      await deliverToConnectorCore(ctx, {
        requestId: args.requestId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId: attempt.attemptId,
        source: args.source,
        provider: args.provider,
        deliveryMeta: args.deliveryMeta,
        text: responseText,
      }),
    executionSignal: () => executionSignal,
    finishRemoteAttempt: attempt.finish,
  });
  return true;
}

async function persistConnectorAssistantMessage(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    source: RemoteTurnAttemptSource;
    deviceId?: string;
    provider: string;
    text: string;
    appendAssistantEvent: boolean;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  },
): Promise<void> {
  if (!shouldUseOfflineResponderForProvider(args.provider)) {
    return;
  }
  const accepted: boolean = await ctx.runMutation(
    internal.channels.connector_delivery
      .appendRemoteTurnAssistantMessageInternal,
    {
      requestId: args.requestId,
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      attemptId: args.attemptId,
      source: args.source,
      deviceId: args.deviceId,
      provider: args.provider,
      text: args.text,
      appendAssistantEvent: args.appendAssistantEvent,
      usage: args.usage,
      now: Date.now(),
    },
  );
  if (!accepted) throw staleRemoteTurnAttemptError();
}

async function deliverExecutionUnavailable(
  ctx: ActionCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
    source: Exclude<RemoteTurnAttemptSource, "desktop">;
    provider: string;
    deliveryMeta: Record<string, unknown>;
  },
): Promise<void> {
  const attempt = await acquireRemoteTurnAttemptGuard(ctx, {
    requestId: args.requestId,
    conversationId: args.conversationId,
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    source: args.source,
  });
  if (!attempt) return;
  let outcome: RemoteTurnDispatchOutcome = "failed";
  try {
    await persistConnectorAssistantMessage(ctx, {
      requestId: args.requestId,
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      attemptId: attempt.attemptId,
      source: args.source,
      provider: args.provider,
      text: EXECUTION_NOT_AVAILABLE_MESSAGE,
      appendAssistantEvent: true,
    });
    const delivered = await deliverToConnectorCore(ctx, {
      requestId: args.requestId,
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      attemptId: attempt.attemptId,
      source: args.source,
      provider: args.provider,
      deliveryMeta: args.deliveryMeta,
      text: EXECUTION_NOT_AVAILABLE_MESSAGE,
    });
    outcome = delivered ? "succeeded" : "failed";
  } finally {
    await attempt.finish(outcome).catch(() => undefined);
  }
}

// ─── Per-request fallback (scheduled by message_pipeline) ───────────────────
// Runs a few seconds after a remote_turn_request is inserted. This fast rescue
// exists only for the mobile app's backend offline responder. Other connectors
// must wait for the normal desktop flow or the slower orphan watchdog; an
// unclaimed request after a few seconds does not mean the desktop is offline.
export const rescueSingleTurn = internalAction({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    prompt: v.string(),
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    userMessageId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Check if desktop already claimed or fulfilled this request — both
    // states live on the original `remote_turn_request` row now, so a
    // single read is enough.
    const requestState = (await ctx.runQuery(
      internal.channels.connector_delivery.getRemoteTurnState,
      { requestId: args.requestId },
    )) as "pending" | "claimed" | "fulfilled" | "cancelled" | null;

    console.log(
      `[rescue:trace] requestId=${args.requestId}, state=${requestState ?? "missing"}`,
    );
    if (
      requestState === "claimed" ||
      requestState === "fulfilled" ||
      requestState === "cancelled"
    ) {
      return null;
    }

    if (!shouldUseOfflineResponderForProvider(args.provider)) {
      console.log(
        `[rescue:trace] Skipping fast rescue for provider=${args.provider}; waiting for desktop claim or orphan watchdog.`,
      );
      return null;
    }

    console.log(
      `[rescue:trace] Desktop did not claim ${args.requestId}, running offline responder`,
    );

    await runFallbackAndDeliver(ctx, {
      requestId: args.requestId,
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      source: "fast_rescue",
      prompt: args.prompt,
      provider: args.provider,
      deliveryMeta: args.deliveryMeta as Record<string, unknown>,
      userMessageId: args.userMessageId,
    });

    return null;
  },
});

// ─── Internal Action (delivers a follow-up message — no lifecycle update) ───
export const deliverConnectorFollowup = internalAction({
  args: {
    requestId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const target = await ctx.runMutation(
        internal.channels.connector_delivery
          .assertRemoteTurnBoundDeliveryAllowedInternal,
        {
          requestId: args.requestId,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
        },
      );
      if (!target) return null;
      await dispatchConnectorDelivery(ctx, {
        requestId: args.requestId,
        conversationId: target.conversationId,
        provider: target.provider,
        deliveryMeta: target.deliveryMeta as Record<string, unknown>,
        text: args.text,
      });
    } catch (error) {
      console.error(
        `[connector_delivery] Follow-up delivery failed for ${args.requestId}:`,
        error,
      );
    }
    return null;
  },
});

// ─── Internal Action (delivers message to connector) ────────────────────────
export const deliverToConnector = internalAction({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    text: v.string(),
    media: v.optional(connectorMediaRefArrayValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let outcome: RemoteTurnDispatchOutcome = "failed";
    try {
      const delivered = await deliverToConnectorCore(ctx, {
        requestId: args.requestId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId: args.attemptId,
        source: args.source,
        deviceId: args.deviceId,
        provider: args.provider,
        deliveryMeta: args.deliveryMeta as Record<string, unknown>,
        text: args.text,
        media: args.media,
      });
      outcome = delivered ? "succeeded" : "failed";
    } finally {
      await ctx.runMutation(
        internal.channels.connector_delivery.finishRemoteTurnAttemptInternal,
        {
          requestId: args.requestId,
          conversationId: args.conversationId,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          attemptId: args.attemptId,
          source: args.source,
          deviceId: args.deviceId,
          outcome,
          now: Date.now(),
        },
      );
    }
    return null;
  },
});

export const getRemoteTurnDeliveryTarget = internalQuery({
  args: { requestId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      conversationId: v.id("conversations"),
      provider: v.string(),
      deliveryMeta: jsonValueValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") return null;
    const payload = request.payload as Record<string, unknown>;
    const provider = payload.provider;
    if (typeof provider !== "string") return null;
    const deliveryMeta: Value =
      payload.deliveryMeta && typeof payload.deliveryMeta === "object"
        ? (JSON.parse(JSON.stringify(payload.deliveryMeta)) as Value)
        : ({} as Value);
    return { conversationId: request.conversationId, provider, deliveryMeta };
  },
});

/** Exact final transport gate; moving phase and checking authority are atomic. */
export const beginRemoteTurnDeliveryInternal = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pulse = await heartbeatRemoteTurnAttemptCore(ctx, args);
    if (!pulse.allowed) return false;
    const request = await assertExactBoundRequest(ctx, args);
    if (!request || !attemptTupleMatches(request, args)) return false;
    await ctx.db.patch(request._id, { activeAttemptPhase: "delivering" });
    return true;
  },
});

/**
 * Exact immutable-owner gate for delayed connector media/follow-up delivery.
 * Fulfilled requests remain valid delivery locators; cancelled requests never
 * dispatch. The lifecycle and migration reads share this mutation transaction.
 */
export const assertRemoteTurnBoundDeliveryAllowedInternal = internalMutation({
  args: {
    requestId: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      conversationId: v.id("conversations"),
      provider: v.string(),
      deliveryMeta: jsonValueValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (
      !request ||
      request.type !== "remote_turn_request" ||
      request.ownerBindingState !== "bound" ||
      request.ownerId !== args.ownerId ||
      request.ownerGeneration !== args.ownerGeneration ||
      request.requestState === "cancelled" ||
      request.requestTerminalReason !== undefined
    ) {
      return null;
    }
    const conversation = await ctx.db.get(request.conversationId);
    if (!conversation || conversation.ownerId !== args.ownerId) return null;
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const payload = request.payload as Record<string, unknown>;
    if (typeof payload.provider !== "string") return null;
    const deliveryMeta: Value =
      payload.deliveryMeta && typeof payload.deliveryMeta === "object"
        ? (JSON.parse(JSON.stringify(payload.deliveryMeta)) as Value)
        : ({} as Value);
    return {
      conversationId: request.conversationId,
      provider: payload.provider,
      deliveryMeta,
    };
  },
});

export const deliverMediaJobToConnector = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    jobId: v.string(),
    output: jsonValueValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const mediaInputs = extractDeliveryMediaFromOutput(args.output);
    if (mediaInputs.length === 0) return null;

    await ctx.runMutation(
      internal.media_jobs.assertConnectorMediaDispatchAllowed,
      {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: args.jobId,
        requestId: args.requestId,
      },
    );
    const target = await ctx.runMutation(
      internal.channels.connector_delivery
        .assertRemoteTurnBoundDeliveryAllowedInternal,
      {
        requestId: args.requestId,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
      },
    );
    if (!target) return null;

    const media = (await ctx.runAction(
      internal.channels.connector_media.materializeRemoteMedia,
      {
        scopeId: `out:${args.jobId}`,
        media: mediaInputs,
      },
    )) as ConnectorMediaRef[];
    if (media.length === 0) return null;

    let transportStarted = false;
    try {
      // Materialization can fetch several remote objects. Close that
      // preparation window before the connector transport receives the media.
      await ctx.runMutation(
        internal.media_jobs.assertConnectorMediaDispatchAllowed,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          jobId: args.jobId,
          requestId: args.requestId,
        },
      );
      const currentTarget = await ctx.runMutation(
        internal.channels.connector_delivery
          .assertRemoteTurnBoundDeliveryAllowedInternal,
        {
          requestId: args.requestId,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
        },
      );
      if (!currentTarget) return null;
      transportStarted = true;
      await dispatchConnectorDelivery(ctx, {
        requestId: args.requestId,
        conversationId: currentTarget.conversationId,
        provider: currentTarget.provider,
        deliveryMeta: currentTarget.deliveryMeta as Record<string, unknown>,
        text: "",
        media,
      });
      await ctx.runMutation(internal.media_jobs.markConnectorMediaDelivered, {
        jobId: args.jobId,
        ownerGeneration: args.ownerGeneration,
        deliveredAt: Date.now(),
      });
    } catch (error) {
      if (transportStarted) {
        await ctx
          .runMutation(internal.media_jobs.markConnectorMediaDeliveryFailed, {
            jobId: args.jobId,
            ownerGeneration: args.ownerGeneration,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch((writeError) => {
            if (!isOwnerDataFenceError(writeError)) throw writeError;
          });
      }
      throw error;
    } finally {
      // Every retry materializes a fresh relay copy. Delete this attempt's
      // copy whether delivery succeeds, fails, or is fenced after download.
      await ctx.scheduler.runAfter(
        RELAYED_MEDIA_DELETE_DELAY_MS,
        internal.channels.connector_media.deleteRelayedMedia,
        { media },
      );
    }
    return null;
  },
});

const RESCUE_DELAY_MS = 5_000;

export const scheduleRescue = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    prompt: v.string(),
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    userMessageId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      RESCUE_DELAY_MS,
      internal.channels.connector_delivery.rescueSingleTurn,
      {
        requestId: args.requestId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        prompt: args.prompt,
        provider: args.provider,
        deliveryMeta: args.deliveryMeta,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
      },
    );
    return null;
  },
});

/**
 * Returns the lifecycle state of a remote turn — `null` if the request
 * itself doesn't exist. Replaces the previous pair of `findClaimedEvent` /
 * `getRemoteTurnFulfilled` lookups, each of which hit the `by_requestId`
 * index separately.
 */
export const getRemoteTurnState = internalQuery({
  args: { requestId: v.string() },
  returns: v.union(
    v.null(),
    v.literal("pending"),
    v.literal("claimed"),
    v.literal("fulfilled"),
    v.literal("cancelled"),
  ),
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") return null;
    return request.requestState ?? "pending";
  },
});

/**
 * Patch a `remote_turn_request` row to `fulfilled` after successful
 * delivery. Idempotent: a second call is a no-op.
 */
export const markRemoteTurnFulfilled = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: remoteTurnAttemptSourceValidator,
    deviceId: v.optional(v.string()),
    now: v.number(),
  },
  returns: remoteTurnFulfillmentResultValidator,
  handler: async (ctx, args) => {
    const request = await assertExactBoundRequest(ctx, args);
    if (
      !request ||
      !attemptTupleMatches(request, args) ||
      request.activeAttemptState !== "active" ||
      request.requestState === "cancelled" ||
      args.now >= (request.attemptLeaseExpiresAt ?? 0) ||
      args.now >= (request.attemptHardExpiresAt ?? 0)
    ) {
      return { acknowledged: false, requestState: "cancelled" as const };
    }
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.ownerId !== args.ownerId) {
      await markRemoteTurnAttemptCancellation(
        ctx,
        request,
        "ownership_migrated",
        args.now,
      );
      return { acknowledged: false, requestState: "cancelled" as const };
    }
    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch {
      const migrated = await hasOwnerMigrationSourceFence(ctx, args.ownerId);
      await markRemoteTurnAttemptCancellation(
        ctx,
        request,
        migrated ? "ownership_migrated" : "owner_data_changed",
        args.now,
      );
      return { acknowledged: false, requestState: "cancelled" as const };
    }
    await ctx.db.patch(request._id, {
      requestState: "fulfilled",
      fulfilledAt: args.now,
      activeAttemptPhase: "delivering",
    });
    await ctx.runMutation(
      internal.channels.connector_turn_payloads.deleteByRequestId,
      { requestId: args.requestId },
    );
    return { acknowledged: true as const, requestState: "fulfilled" as const };
  },
});

async function retryClaimedRemoteTurnDelivery(
  ctx: ActionCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
    source: "orphan_watchdog" | "cron_watchdog";
    provider: string;
    deliveryMeta: Record<string, unknown>;
    text: string;
  },
): Promise<boolean> {
  const attempt = await acquireRemoteTurnAttemptGuard(ctx, {
    requestId: args.requestId,
    conversationId: args.conversationId,
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    source: args.source,
  });
  if (!attempt) return false;
  let outcome: RemoteTurnDispatchOutcome = "failed";
  let settleExecution: SettleExecution | undefined;
  let executionSignal: AbortSignal = attempt.signal;
  try {
    const delivered = await deliverToConnectorCore(ctx, {
      ...args,
      attemptId: attempt.attemptId,
    });
    outcome = delivered ? "succeeded" : "failed";
    return delivered;
  } finally {
    await attempt.finish(outcome).catch(() => undefined);
  }
}

async function runCronWatchdogTurn(
  ctx: ActionCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    ownerGeneration: string;
    prompt: string;
    userMessageId?: string;
    completionText?: string;
    executeModel: boolean;
  },
): Promise<boolean> {
  const attempt = await acquireRemoteTurnAttemptGuard(ctx, {
    requestId: args.requestId,
    conversationId: args.conversationId,
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    source: "cron_watchdog",
  });
  if (!attempt) return false;
  let outcome: RemoteTurnDispatchOutcome = "failed";
  let settleExecution: SettleExecution | undefined;
  let executionSignal: AbortSignal = attempt.signal;
  try {
    let text = args.completionText?.trim() ?? "";
    let status: "ok" | "error" = text ? "ok" : "error";
    let error = text
      ? undefined
      : "Cron turn completed without a durable exact completion receipt.";
    if (args.executeModel) {
      const modelDispatchGuard = composeManagedDispatchGuards(
        createManagedUsageDispatchGuard(ctx, {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          executionId: attempt.attemptId,
          spanExecution: true,
        }),
        attempt.modelDispatchGuard,
      );
      executionSignal = modelDispatchGuard.signal;
      const billingRequestFingerprint =
        await createManagedDispatchRequestFingerprint(
          "connector-cron-turn",
          JSON.stringify({
            requestId: args.requestId,
            attemptId: attempt.attemptId,
            source: "cron_watchdog",
            conversationId: args.conversationId,
          }),
        );
      const result = await runAgentTurn({
        ctx,
        conversationId: args.conversationId,
        prompt: args.prompt,
        agentType: BACKEND_FALLBACK_AGENT_TYPE,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        modelDispatchGuard,
        billingIdentity: {
          requestFingerprint: billingRequestFingerprint,
          agentType: `proxy:${BACKEND_FALLBACK_AGENT_TYPE}`,
          conversationId: args.conversationId,
        },
        acknowledgeUsageDisposition: async () => {
          const accepted: boolean = await ctx.runMutation(
            internal.channels.connector_delivery
              .acknowledgeRemoteTurnUsageDispositionInternal,
            {
              requestId: args.requestId,
              conversationId: args.conversationId,
              ownerId: args.ownerId,
              ownerGeneration: args.ownerGeneration,
              attemptId: attempt.attemptId,
              source: "cron_watchdog",
              now: Date.now(),
            },
          );
          if (!accepted) throw staleRemoteTurnAttemptError();
        },
        userMessageId: args.userMessageId as Id<"events"> | undefined,
      });
      settleExecution = result.settleExecution;
      text = result.text.trim();
      status = "ok";
      error = undefined;
    }
    const accepted: boolean = await ctx.runMutation(
      internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
      {
        requestId: args.requestId,
        conversationId: args.conversationId,
        text,
        status,
        error,
        skipAssistantMessage: status === "error",
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId: attempt.attemptId,
        source: "cron_watchdog",
      },
    );
    if (!accepted) throw staleRemoteTurnAttemptError();
    outcome = status === "ok" ? "succeeded" : "failed";
    return true;
  } catch (error) {
    outcome = managedExecutionOutcomeFromError(error, executionSignal);
    throw error;
  } finally {
    await settleExecutionThenRemoteAttempt({
      settleExecution,
      finishRemoteAttempt: attempt.finish,
      outcome,
    });
  }
}

const ORPHAN_MIN_AGE_MS = 90_000; // must be at least 90s old
// A desktop can discover a request during its 5m startup lookback and then
// hold the fixed 8m attempt hard bound plus quiescence grace. Keep the sweep
// horizon beyond that full lifecycle so late completion receipts cannot strand.
const ORPHAN_MAX_AGE_MS = 20 * 60_000;

// Cap per-state scan; orphans are normally 0 and any backlog beyond this is
// picked up by the next 60s sweep.
const ORPHAN_SCAN_LIMIT = 100;

type OrphanResult = {
  eventId: Id<"events">;
  requestId: string;
  conversationId: Id<"conversations">;
  targetDeviceId: string;
  ownerId?: string;
  ownerGeneration?: string;
  ownerBindingState?: "bound" | "legacy_unbound";
  activeAttemptPhase?: "running" | "completion_accepted" | "delivering";
  completionAttemptId?: string;
  completionText?: string;
  payload: Record<string, string | undefined>;
  claimed: boolean;
};

/**
 * Shared read for the orphan watchdog. Queries the unfulfilled remote turns
 * directly by lifecycle state + age. This is independent of how many devices
 * are registered — only the (usually zero) `pending`/`claimed` request rows in
 * the orphan window are read, instead of scanning every device's event stream
 * each minute. Callable from both a query (`findOrphanedTurnRequests`) and the
 * cheap gating mutation (`sweepOrphanedTurns`).
 */
const collectOrphanedTurnRequests = async (
  ctx: QueryCtx | MutationCtx,
  nowMs: number,
): Promise<OrphanResult[]> => {
  const minTimestamp = nowMs - ORPHAN_MAX_AGE_MS;
  const maxTimestamp = nowMs - ORPHAN_MIN_AGE_MS;

  const collectForState = async (
    state: "pending" | "claimed",
  ): Promise<OrphanResult[]> => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_requestState_and_timestamp", (q) =>
        q
          .eq("requestState", state)
          .gte("timestamp", minTimestamp)
          .lte("timestamp", maxTimestamp),
      )
      .take(ORPHAN_SCAN_LIMIT);

    const out: OrphanResult[] = [];
    for (const event of events) {
      if (event.type !== "remote_turn_request") continue;
      if (!event.requestId) continue;

      const p = event.payload as Record<string, unknown>;
      out.push({
        eventId: event._id,
        requestId: event.requestId,
        conversationId: event.conversationId,
        targetDeviceId: event.targetDeviceId ?? "",
        ownerId: event.ownerId,
        ownerGeneration: event.ownerGeneration,
        ownerBindingState: event.ownerBindingState,
        activeAttemptPhase: event.activeAttemptPhase,
        completionAttemptId: event.completionAttemptId,
        completionText: event.completionText,
        payload: JSON.parse(JSON.stringify(p)),
        claimed: state === "claimed",
      });
    }
    return out;
  };

  const [pending, claimed] = await Promise.all([
    collectForState("pending"),
    collectForState("claimed"),
  ]);

  return [...pending, ...claimed];
};

export const findOrphanedTurnRequests = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args) => collectOrphanedTurnRequests(ctx, args.nowMs),
});

/**
 * Cheap per-minute gate for the orphan watchdog. `rescueOrphanedTurns` is an
 * `internalAction` (Node isolate) that is comparatively expensive to spin up,
 * yet the orphan set is empty in the overwhelming majority of sweeps. Run the
 * bounded index read in a mutation and only schedule the action when there is
 * actually something to rescue.
 */
export const sweepOrphanedTurns = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const orphans = await collectOrphanedTurnRequests(ctx, Date.now());
    if (orphans.length === 0) return null;

    await ctx.scheduler.runAfter(
      0,
      internal.channels.connector_delivery.rescueOrphanedTurns,
      {},
    );
    return null;
  },
});

export const rescueOrphanedTurns = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const orphans = await ctx.runQuery(
      internal.channels.connector_delivery.findOrphanedTurnRequests,
      { nowMs: Date.now() },
    );

    if (orphans.length === 0) return null;

    console.log(
      `[watchdog] Found ${orphans.length} orphaned remote turn request(s)`,
    );

    for (const orphan of orphans) {
      const payload = orphan.payload as Record<string, unknown>;
      const source = (payload.source as string | undefined) ?? "connector";
      const isCronRequest = source === "cron";
      const conversationId = orphan.conversationId;
      const userMessageId = payload.userMessageId as string | undefined;
      const prompt = (payload.text as string) ?? "";
      const provider = (payload.provider as string) ?? "";
      const deliveryMeta =
        (payload.deliveryMeta as Record<string, unknown>) ?? {};

      try {
        if (
          orphan.ownerBindingState !== "bound" ||
          !orphan.ownerId ||
          !orphan.ownerGeneration
        ) {
          await ctx.runMutation(
            internal.channels.connector_delivery
              .terminalizeLegacyRemoteTurnInternal,
            {
              eventId: orphan.eventId,
              requestId: orphan.requestId,
              now: Date.now(),
            },
          );
          continue;
        }
        const ownerId = orphan.ownerId;
        const ownerGeneration = orphan.ownerGeneration;

        if (isCronRequest) {
          await runCronWatchdogTurn(ctx, {
            requestId: orphan.requestId,
            conversationId,
            ownerId,
            ownerGeneration,
            prompt,
            userMessageId,
            completionText: orphan.completionText,
            executeModel: !orphan.claimed,
          });
          console.log(
            `[watchdog] Rescued cron orphan ${orphan.requestId} (${orphan.claimed ? "delivery-only" : "backend execution"})`,
          );
          continue;
        }

        if (orphan.claimed) {
          console.log(
            `[watchdog] Retrying delivery for claimed turn ${orphan.requestId}`,
          );
          if (orphan.completionText !== undefined) {
            await retryClaimedRemoteTurnDelivery(ctx, {
              requestId: orphan.requestId,
              conversationId: orphan.conversationId,
              ownerId,
              ownerGeneration,
              source: "orphan_watchdog",
              provider,
              deliveryMeta: JSON.parse(JSON.stringify(deliveryMeta)),
              text: orphan.completionText,
            });
          } else {
            // Never infer a response from another conversation event. A legacy
            // claimed row without an exact receipt gets a bounded failure reply.
            await deliverExecutionUnavailable(ctx, {
              requestId: orphan.requestId,
              conversationId,
              ownerId,
              ownerGeneration,
              source: "orphan_watchdog",
              provider,
              deliveryMeta,
            });
          }
        } else {
          // Case 2: Not claimed — device went offline before picking up the
          // request. Non-mobile connectors should never use the offline
          // responder; return the execution-unavailable message instead.
          if (!shouldUseOfflineResponderForProvider(provider)) {
            await deliverExecutionUnavailable(ctx, {
              requestId: orphan.requestId,
              conversationId,
              ownerId,
              ownerGeneration,
              source: "orphan_watchdog",
              provider,
              deliveryMeta,
            });
            await ctx.runMutation(
              internal.channels.connector_turn_payloads.deleteByRequestId,
              { requestId: orphan.requestId },
            );
            console.log(
              `[watchdog] Rescued orphan ${orphan.requestId} (execution unavailable) → ${provider}`,
            );
            continue;
          }

          await runFallbackAndDeliver(ctx, {
            requestId: orphan.requestId,
            conversationId,
            ownerId,
            ownerGeneration,
            source: "orphan_watchdog",
            prompt,
            provider,
            deliveryMeta,
            userMessageId,
          });
        }

        console.log(
          `[watchdog] Rescued orphan ${orphan.requestId} (${orphan.claimed ? "delivery retry" : "full rescue"}) → ${provider}`,
        );
      } catch (error) {
        console.error(
          `[watchdog] Failed to rescue orphan ${orphan.requestId}:`,
          error,
        );
      }
    }

    return null;
  },
});
