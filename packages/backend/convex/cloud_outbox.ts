import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type {
  ConversationCreatedEvent,
  DispatchUpdatedEvent,
  ConversationDeletedEvent,
  ConversationIndexEvent,
  InteriorBuildRecordedEvent,
  BuildRecordedEvent,
  OutboxEvent,
  OutboxRejectReason,
  ThreadCompletedEvent,
  ThreadMessagesEvent,
  ThreadSpawnedEvent,
  TurnEventEvent,
  TurnStartedEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  CHAT_TITLE_MAX,
  THREAD_TURN_MESSAGE_LIMIT,
  THREAD_TURN_MESSAGE_MAX_BYTES,
  appendThreadMessage,
  appendTurnEventProjection,
  assertThreadMessagePayload,
  clip,
  collectThreadOutputFiles,
  completeAgentThread,
  conversationTombstoned,
  recordBuild,
  tombstoneConversation,
  upsertConversationIndex,
} from "./cloud_apps";
import { recordInteriorBuild } from "./cloud_deployments";
import { parseCloudBuildCallback } from "./lib/cloud_build_callback";
import { cloudAgentSandboxLeaseExpiresAt } from "./lib/computer_agent_thread";
import { parseInteriorBuildCandidate } from "./lib/interior_build_candidate";
import { parseOutboxEvent } from "./lib/outbox_events";
import { assertOwnerDataWriteAllowed } from "./owner_lifecycle";

/**
 * The outbox is the only write path from the cloud-builder data plane into
 * Convex's projections (`@stella/contracts/turn-plane/outbox`). One mutation
 * per event: the receipt and the projection commit together, a rejection
 * rolls nothing back, and a thrown infrastructure error fails only that
 * event's delivery (the consumer redelivers; the receipt makes it a
 * duplicate).
 */

export type OutboxApplyResult =
  | { status: "applied" }
  | { status: "duplicate" }
  | { status: "rejected"; reason: OutboxRejectReason };

const applied: OutboxApplyResult = { status: "applied" };
const duplicate: OutboxApplyResult = { status: "duplicate" };
const rejected = (reason: OutboxRejectReason): OutboxApplyResult => ({
  status: "rejected",
  reason,
});

const logOutbox = (event: string, fields: Record<string, unknown>) =>
  console.warn(
    JSON.stringify({ service: "convex-cloud-outbox", event, ...fields }),
  );

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const loadConversation = (ctx: MutationCtx, conversationId: string) =>
  ctx.db
    .query("cloud_conversations")
    .withIndex("by_conversationId", (q) => q.eq("conversationId", conversationId))
    .unique();

const loadThread = (ctx: MutationCtx, threadId: string) =>
  ctx.db
    .query("cloud_agent_threads")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .unique();

const loadTurn = (ctx: MutationCtx, turnId: string) =>
  ctx.db
    .query("agent_turns")
    .withIndex("by_turnId", (q) => q.eq("turnId", turnId))
    .unique();

// ---------------------------------------------------------------------------
// Per-kind appliers
// ---------------------------------------------------------------------------

const applyConversationCreated = async (
  ctx: MutationCtx,
  event: ConversationCreatedEvent,
): Promise<OutboxApplyResult> => {
  const row = await loadConversation(ctx, event.conversationId);
  if (row) {
    return row.ownerId === event.ownerId ? duplicate : rejected("owner_mismatch");
  }
  // A purged id must never come back as a fresh sidebar row.
  if (await conversationTombstoned(ctx, event.conversationId)) {
    return rejected("stale");
  }
  await ctx.db.insert("cloud_conversations", {
    conversationId: event.conversationId,
    ownerId: event.ownerId,
    title: clip(event.title.trim(), CHAT_TITLE_MAX),
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    ...(event.execution ? { execution: event.execution } : {}),
  });
  return applied;
};

const applyConversationIndex = async (
  ctx: MutationCtx,
  event: ConversationIndexEvent,
): Promise<OutboxApplyResult> => {
  const result = await upsertConversationIndex(ctx, {
    conversationId: event.conversationId,
    ownerId: event.ownerId,
    ownerGeneration: event.ownerGeneration,
    epoch: event.epoch,
    lastSeq: event.lastSeq,
    updatedAt: event.updatedAt,
    ...(event.createdAt !== undefined ? { createdAt: event.createdAt } : {}),
    ...(event.title !== undefined ? { title: event.title } : {}),
    ...(event.lastPreview !== undefined ? { lastPreview: event.lastPreview } : {}),
    ...(event.lastRole !== undefined ? { lastRole: event.lastRole } : {}),
    ...(event.activity !== undefined ? { activity: event.activity } : {}),
    ...(event.excerpts.length > 0 ? { excerpts: event.excerpts } : {}),
    ...(event.force ? { force: true } : {}),
  });
  if (result.accepted) return applied;
  switch (result.reason) {
    case "stale":
      // Same-epoch replay: excerpts still landed, the head stayed put.
      return duplicate;
    case "stale_epoch":
      return rejected("stale_epoch");
    case "purged":
      return rejected("owner_purged");
    case "deleted":
      return rejected("stale");
    case "owner_mismatch":
      return rejected("owner_mismatch");
    default:
      return rejected("invalid");
  }
};

const applyConversationDeleted = async (
  ctx: MutationCtx,
  event: ConversationDeletedEvent,
): Promise<OutboxApplyResult> => {
  const row = await loadConversation(ctx, event.conversationId);
  if (!row) return rejected("invalid");
  if (row.ownerId !== event.ownerId) return rejected("owner_mismatch");
  if (row.deletedAt !== undefined) return duplicate;
  await tombstoneConversation(ctx, {
    conversationId: event.conversationId,
    ownerId: event.ownerId,
    now: event.deletedAt,
  });
  // The DO said it is gone; the purge handshake confirms its storage is.
  await ctx.scheduler.runAfter(
    0,
    internal.cloud_apps.purgeConversationInternal,
    { conversationId: event.conversationId, ownerId: event.ownerId },
  );
  return applied;
};

const applyTurnStarted = async (
  ctx: MutationCtx,
  event: TurnStartedEvent,
): Promise<OutboxApplyResult> => {
  const existing = await loadTurn(ctx, event.turnId);
  if (existing) {
    return existing.ownerId === event.ownerId
      ? duplicate
      : rejected("owner_mismatch");
  }
  const conversation = await loadConversation(ctx, event.conversationId);
  if (conversation && conversation.ownerId !== event.ownerId) {
    return rejected("owner_mismatch");
  }
  await ctx.db.insert("agent_turns", {
    turnId: event.turnId,
    sessionId: event.sessionId,
    ownerId: event.ownerId,
    ownerGeneration: event.ownerGeneration,
    conversationId: event.conversationId,
    prompt: event.prompt,
    status: "running",
    lane: event.lane,
    kind: event.turnKind === "app" ? "build" : event.turnKind,
    agentType: event.agentType,
    ...(event.turnKind === "agent" ? { placement: "cloud" as const } : {}),
    ...(event.source ? { source: event.source } : {}),
    ...(event.hidden ? { hidden: true } : {}),
    ...(event.clientMsgId ? { clientMsgId: event.clientMsgId } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.attemptGeneration !== undefined
      ? { attemptGeneration: event.attemptGeneration }
      : {}),
    execution: event.execution,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  });
  if (conversation && conversation.deletedAt === undefined) {
    // Display ordering is Convex's field: a fresh turn sorts its conversation
    // to the top before the DO's first index flush, and the first turn is
    // proof that an intentional empty conversation is empty no more.
    await ctx.db.patch(conversation._id, {
      updatedAt: Math.max(conversation.updatedAt, event.createdAt),
      ...(conversation.allowEmpty === true ? { allowEmpty: undefined } : {}),
      ...(conversation.execution ? {} : { execution: event.execution }),
    });
  }
  return applied;
};

const applyTurnEvent = async (
  ctx: MutationCtx,
  event: TurnEventEvent,
  connectedAccount: boolean | undefined,
): Promise<OutboxApplyResult> => {
  const result = await appendTurnEventProjection(ctx, {
    ownerId: event.ownerId,
    ownerGeneration: event.ownerGeneration,
    turnId: event.turnId,
    ...(event.attemptGeneration !== undefined
      ? { attemptGeneration: event.attemptGeneration }
      : {}),
    sessionId: event.sessionId,
    eventSeq: event.eventSeq,
    kind: event.eventKind,
    payloadJson: JSON.stringify(event.payload ?? {}),
    terminal: event.terminal,
    ...(connectedAccount !== undefined ? { connectedAccount } : {}),
    now: event.createdAt,
  });
  if (result.ok) return result.duplicate ? duplicate : applied;
  switch (result.reason) {
    case "unknown_turn":
      return rejected("unknown_turn");
    case "owner_mismatch":
      return rejected("owner_mismatch");
    case "generation_stale":
      return rejected("generation_stale");
    case "not_active":
      return rejected("stale");
    default:
      return rejected("invalid");
  }
};

const applyThreadSpawned = async (
  ctx: MutationCtx,
  event: ThreadSpawnedEvent,
): Promise<OutboxApplyResult> => {
  const conversation = await loadConversation(ctx, event.conversationId);
  if (conversation && conversation.ownerId !== event.ownerId) {
    return rejected("owner_mismatch");
  }
  const thread = await loadThread(ctx, event.threadId);
  if (thread) {
    if (thread.ownerId !== event.ownerId) return rejected("owner_mismatch");
    const current = thread.attemptGeneration ?? 0;
    // Convex may already hold this attempt: a desktop spawn writes the row
    // optimistically before the builder ever sees the turn.
    if (event.attemptGeneration <= current) return duplicate;
    // A continuation: the same thread identity, a new attempt.
    await ctx.db.patch(thread._id, {
      status: "running",
      description: event.description,
      originDeliveryAckAt: undefined,
      resultJson: undefined,
      errorMessage: undefined,
      attemptGeneration: event.attemptGeneration,
      ...(event.originDeviceId ? { originDeviceId: event.originDeviceId } : {}),
      ...(event.originConversationId
        ? { originConversationId: event.originConversationId }
        : {}),
      execution: event.execution,
      sandboxLeaseExpiresAt: cloudAgentSandboxLeaseExpiresAt(
        "cloud",
        event.createdAt,
      ),
      updatedAt: event.createdAt,
    });
    return applied;
  }
  await ctx.db.insert("cloud_agent_threads", {
    threadId: event.threadId,
    ownerId: event.ownerId,
    ownerGeneration: event.ownerGeneration,
    conversationId: event.conversationId,
    parentTurnId: event.parentTurnId,
    ...(event.originDeviceId ? { originDeviceId: event.originDeviceId } : {}),
    ...(event.originConversationId
      ? { originConversationId: event.originConversationId }
      : {}),
    description: event.description,
    placement: "cloud",
    agentType: "general",
    attemptGeneration: event.attemptGeneration,
    execution: event.execution,
    sandboxLeaseExpiresAt: cloudAgentSandboxLeaseExpiresAt(
      "cloud",
      event.createdAt,
    ),
    status: "running",
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  });
  return applied;
};

const applyThreadMessages = async (
  ctx: MutationCtx,
  event: ThreadMessagesEvent,
  now: number,
): Promise<OutboxApplyResult> => {
  if (
    event.messages.length < 1 ||
    event.messages.length > THREAD_TURN_MESSAGE_LIMIT
  ) {
    return rejected("invalid");
  }
  const thread = await loadThread(ctx, event.threadId);
  if (thread && thread.ownerId !== event.ownerId) {
    return rejected("owner_mismatch");
  }
  const turn = await loadTurn(ctx, event.turnId);
  if (turn && (turn.ownerId !== event.ownerId || turn.threadId !== event.threadId)) {
    return rejected("owner_mismatch");
  }
  const ordinals = new Set<number>();
  let totalBytes = 0;
  for (const message of event.messages) {
    if (
      message.ordinal >= THREAD_TURN_MESSAGE_LIMIT ||
      ordinals.has(message.ordinal)
    ) {
      return rejected("invalid");
    }
    ordinals.add(message.ordinal);
    assertThreadMessagePayload(message.role, message.payloadJson);
    totalBytes += utf8ByteLength(message.payloadJson);
    if (totalBytes > THREAD_TURN_MESSAGE_MAX_BYTES) return rejected("invalid");
  }
  let inserted = 0;
  for (const message of event.messages) {
    const result = await appendThreadMessage(ctx, {
      threadId: event.threadId,
      ownerId: event.ownerId,
      turnId: event.turnId,
      ordinal: message.ordinal,
      role: message.role,
      payloadJson: message.payloadJson,
      now,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted > 0 ? applied : duplicate;
};

const applyThreadCompleted = async (
  ctx: MutationCtx,
  event: ThreadCompletedEvent,
): Promise<OutboxApplyResult> => {
  const result = await completeAgentThread(ctx, {
    ownerId: event.ownerId,
    ownerGeneration: event.ownerGeneration,
    threadId: event.threadId,
    turnId: event.turnId,
    attemptGeneration: event.attemptGeneration,
    status: event.status,
    ...(event.resultJson !== undefined ? { resultJson: event.resultJson } : {}),
    ...(event.errorMessage !== undefined
      ? { errorMessage: event.errorMessage }
      : {}),
    now: event.completedAt,
  });
  if (!result.applied) {
    switch (result.reason) {
      case "duplicate":
        return duplicate;
      case "unknown_thread":
        return rejected("unknown_thread");
      case "owner_mismatch":
        return rejected("owner_mismatch");
      default:
        return rejected("stale");
    }
  }
  // C4: the files a thread produced belong where the user reads the
  // orchestrator's relay of its report — the cloud conversation. Desktop
  // origin threads deliver through the device subscription instead.
  if (event.status === "completed" && !result.originDelivery) {
    const files = await collectThreadOutputFiles(ctx, event.threadId);
    if (files.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.cloud_apps.postConversationCardInternal,
        {
          ownerId: event.ownerId,
          ownerGeneration: event.ownerGeneration,
          conversationId: result.conversationId,
          sourceTurnId: event.turnId,
          card: { type: "files", files },
        },
      );
    }
  }
  return applied;
};

const applyBuildRecorded = async (
  ctx: MutationCtx,
  event: BuildRecordedEvent,
  now: number,
): Promise<OutboxApplyResult> => {
  let callback: ReturnType<typeof parseCloudBuildCallback>;
  try {
    callback = parseCloudBuildCallback(event.payload);
  } catch {
    return rejected("invalid");
  }
  if (callback.buildId !== event.buildId) return rejected("invalid");
  if (callback.ownerId !== event.ownerId) return rejected("owner_mismatch");
  if (callback.ownerGeneration !== event.ownerGeneration) {
    return rejected("generation_stale");
  }
  return (await recordBuild(ctx, { ...callback, now })) ? applied : duplicate;
};

const applyInteriorBuildRecorded = async (
  ctx: MutationCtx,
  event: InteriorBuildRecordedEvent,
  now: number,
): Promise<OutboxApplyResult> => {
  let candidate: ReturnType<typeof parseInteriorBuildCandidate>;
  try {
    candidate = parseInteriorBuildCandidate(event.payload);
  } catch {
    return rejected("invalid");
  }
  if (candidate.buildId !== event.buildId) return rejected("invalid");
  if (candidate.ownerId !== event.ownerId) return rejected("owner_mismatch");
  if (candidate.ownerGeneration !== event.ownerGeneration) {
    return rejected("generation_stale");
  }
  const result = await recordInteriorBuild(ctx, { ...candidate, now });
  return result.created ? applied : duplicate;
};

/**
 * Placement projection. The owner gate is the authority; this row exists so
 * the activity UI can list what ran where. Delivery reorders, so the stored
 * revision fences every apply — an older revision arriving after a newer one
 * is a duplicate, not a rewrite.
 */
const applyDispatchUpdated = async (
  ctx: MutationCtx,
  event: DispatchUpdatedEvent,
): Promise<OutboxApplyResult> => {
  const summary = event.dispatch;
  const existing = await ctx.db
    .query("cloud_dispatches")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", event.dispatchId))
    .unique();
  const fields = {
    dispatchId: summary.dispatchId,
    ownerId: event.ownerId,
    ownerGeneration: event.ownerGeneration,
    idempotencyKey: summary.idempotencyKey,
    kind: summary.kind,
    ingress: summary.ingress,
    subject: summary.subject,
    requestedTargetMode: summary.requestedTargetMode,
    requestedExecutorDeviceId: summary.requestedExecutorDeviceId,
    conversationId: summary.conversationId,
    parentTurnId: summary.parentTurnId,
    threadId: summary.threadId,
    state: summary.state,
    placement: summary.placement,
    executorDeviceId: summary.executorDeviceId,
    executorPresenceSessionId: summary.executorPresenceSessionId,
    revision: summary.revision,
    fallbackReason: summary.fallbackReason,
    cancelRequestId: summary.cancelRequestId,
    cancelReason: summary.cancelReason,
    errorCode: summary.errorCode,
    errorMessage: summary.errorMessage,
    cloudTurnId: summary.cloudTurnId,
    cloudThreadId: summary.cloudThreadId,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
  if (!existing) {
    await ctx.db.insert("cloud_dispatches", fields);
    return applied;
  }
  if (existing.ownerId !== event.ownerId) return rejected("owner_mismatch");
  if (existing.revision >= summary.revision) return duplicate;
  // `replace` rather than `patch`: a field the newer revision dropped (a
  // cleared cancel request, a resolved error) must not survive as residue.
  await ctx.db.replace(existing._id, {
    ...fields,
    createdAt: existing.createdAt,
  });
  return applied;
};

const applyEvent = async (
  ctx: MutationCtx,
  event: OutboxEvent,
  options: { connectedAccount?: boolean; now: number },
): Promise<OutboxApplyResult> => {
  switch (event.kind) {
    case "conversation.created":
      return await applyConversationCreated(ctx, event);
    case "conversation.index":
      return await applyConversationIndex(ctx, event);
    case "conversation.deleted":
      return await applyConversationDeleted(ctx, event);
    case "turn.started":
      return await applyTurnStarted(ctx, event);
    case "turn.event":
      return await applyTurnEvent(ctx, event, options.connectedAccount);
    case "thread.spawned":
      return await applyThreadSpawned(ctx, event);
    case "thread.messages":
      return await applyThreadMessages(ctx, event, options.now);
    case "thread.completed":
      return await applyThreadCompleted(ctx, event);
    case "build.recorded":
      return await applyBuildRecorded(ctx, event, options.now);
    case "interior-build.recorded":
      return await applyInteriorBuildRecorded(ctx, event, options.now);
    case "dispatch.updated":
      return await applyDispatchUpdated(ctx, event);
  }
};

const convexErrorCode = (error: unknown): string | null => {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: unknown } | string | undefined;
  return typeof data === "object" && data && typeof data.code === "string"
    ? data.code
    : null;
};

const outboxApplyResultValidator = v.union(
  v.object({ status: v.literal("applied") }),
  v.object({ status: v.literal("duplicate") }),
  v.object({ status: v.literal("rejected"), reason: v.string() }),
);

/**
 * Applies one outbox event, idempotent by `(kind, key)`.
 *
 * Owner fence first: an event from a purged owner or a generation the owner
 * has since reset is rejected before any projection is touched. Rejections
 * are permanent by contract (the consumer acks and logs); only infrastructure
 * errors propagate so the consumer redelivers.
 */
export const applyOutboxEventInternal = internalMutation({
  args: {
    event: v.any(),
    /** Resolved by the route for hosted-browser waits (needs the auth component). */
    connectedAccount: v.optional(v.boolean()),
    now: v.number(),
  },
  returns: outboxApplyResultValidator,
  handler: async (ctx, args): Promise<OutboxApplyResult> => {
    const parsed = parseOutboxEvent(args.event);
    if (!parsed.ok) return rejected("invalid");
    const { event } = parsed;
    const receipt = await ctx.db
      .query("cloud_outbox_receipts")
      .withIndex("by_kind_and_key", (q) =>
        q.eq("kind", event.kind).eq("key", event.key),
      )
      .first();
    if (receipt) return duplicate;
    try {
      await assertOwnerDataWriteAllowed(
        ctx,
        event.ownerId,
        event.ownerGeneration,
      );
    } catch (error) {
      switch (convexErrorCode(error)) {
        case "OWNER_DATA_PURGE_ACTIVE":
          return rejected("owner_purged");
        case "OWNER_DATA_GENERATION_STALE":
          return rejected("generation_stale");
        default:
          throw error;
      }
    }
    let result: OutboxApplyResult;
    try {
      result = await applyEvent(ctx, event, {
        ...(args.connectedAccount !== undefined
          ? { connectedAccount: args.connectedAccount }
          : {}),
        now: args.now,
      });
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      // A ConvexError out of a projection writer is a contract violation by
      // the event (bad payload, mismatched build artifacts): permanent.
      logOutbox("outbox_event_rejected", {
        kind: event.kind,
        key: event.key,
        message: String(error.data),
      });
      return rejected("invalid");
    }
    if (result.status !== "rejected") {
      await ctx.db.insert("cloud_outbox_receipts", {
        kind: event.kind,
        key: event.key,
        ownerId: event.ownerId,
        ownerGeneration: event.ownerGeneration,
        createdAt: args.now,
      });
    }
    return result;
  },
});
