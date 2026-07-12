import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { relayResumeStatusValidator } from "../schema/relay_resume";
import {
  STELLA_RELAY_CLEANUP_MAX_BATCHES,
  STELLA_RELAY_CLEANUP_MAX_BYTES,
  STELLA_RELAY_CLEANUP_MAX_DOCS,
  STELLA_RELAY_CANCEL_INTENT_TTL_MS,
  STELLA_RELAY_RESUME_HARD_TTL_MS,
  STELLA_RELAY_RESUME_LEASE_TTL_MS,
  STELLA_RELAY_RESUME_MAX_BYTES,
  STELLA_RELAY_RESUME_MAX_EVENT_BYTES,
  STELLA_RELAY_RESUME_MAX_EVENTS,
  STELLA_RELAY_RESUME_MAX_GLOBAL_BYTES,
  STELLA_RELAY_RESUME_MAX_GLOBAL_STREAMS,
  STELLA_RELAY_RESUME_MAX_OWNER_BYTES,
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
const CLEANUP_STATE_KEY = "relay-resume";

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

const ownerQuotaKey = (ownerId: string) => `owner:${ownerId}`;

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

export const reserveRelayResumeStream = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    provider: v.string(),
    model: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("reserved"),
    v.literal("existing"),
    v.literal("canceled"),
    v.literal("conflict"),
    v.literal("owner_quota"),
    v.literal("global_quota"),
  ),
  handler: async (ctx, args) => {
    const cancellationIntent = await ctx.db
      .query("stella_relay_cancellation_intents")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (cancellationIntent) {
      if (cancellationIntent.ownerId !== args.ownerId) return "conflict";
      if (cancellationIntent.expiresAt > args.nowMs) return "canceled";
      await ctx.db.delete(cancellationIntent._id);
    }

    const existing = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (existing) {
      return existing.ownerId === args.ownerId ? "existing" : "conflict";
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
      provider: args.provider,
      model: args.model,
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
    return !stream || stream.ownerId !== args.ownerId
      ? "not_found"
      : stream.status;
  },
});

export const cancelRelayResumeStream = internalMutation({
  args: { relayRequestId: v.string(), ownerId: v.string(), nowMs: v.number() },
  returns: v.union(
    v.literal("not_found"),
    v.literal("expired"),
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
      if (existingIntent) {
        await ctx.db.patch(existingIntent._id, {
          expiresAt: args.nowMs + STELLA_RELAY_CANCEL_INTENT_TTL_MS,
        });
      } else {
        await ctx.db.insert("stella_relay_cancellation_intents", {
          relayRequestId: args.relayRequestId,
          ownerId: args.ownerId,
          createdAt: args.nowMs,
          expiresAt: args.nowMs + STELLA_RELAY_CANCEL_INTENT_TTL_MS,
        });
      }
      return "canceled";
    }
    if (stream.ownerId !== args.ownerId) return "not_found";
    if (stream.expiresAt <= args.nowMs || stream.hardExpiresAt <= args.nowMs) {
      return "expired";
    }
    if (stream.status !== "streaming") return stream.status;
    await ctx.db.patch(stream._id, {
      status: "canceled",
      updatedAt: args.nowMs,
    });
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
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const lease = await ctx.db
      .query("stella_relay_response_leases")
      .withIndex("by_leaseId", (q) => q.eq("leaseId", args.leaseId))
      .unique();
    if (
      !lease ||
      lease.ownerId !== args.ownerId ||
      lease.expiresAt <= args.nowMs
    ) {
      return false;
    }
    await ctx.db.patch(lease._id, {
      updatedAt: args.nowMs,
      expiresAt: args.nowMs + STELLA_RELAY_RESUME_LEASE_TTL_MS,
    });
    return true;
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

    const expiredCancellationIntents = await ctx.db
      .query("stella_relay_cancellation_intents")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.nowMs))
      .take(STELLA_RELAY_CLEANUP_MAX_DOCS);
    for (const intent of expiredCancellationIntents) {
      await ctx.db.delete(intent._id);
      deletedDocuments += 1;
    }

    const expiredLeases = await ctx.db
      .query("stella_relay_response_leases")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.nowMs))
      .take(STELLA_RELAY_CLEANUP_MAX_DOCS - deletedDocuments);
    for (const lease of expiredLeases) {
      await ctx.db.delete(lease._id);
      deletedDocuments += 1;
    }

    const [expiredStream] = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.nowMs))
      .take(1);
    const expiredTimestamps = [
      expiredCancellationIntents[0]?.expiresAt,
      expiredStream?.expiresAt,
      expiredLeases[0]?.expiresAt,
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

export const deleteOwnerRelayResumeBatch = internalMutation({
  args: { ownerId: v.string(), nowMs: v.number() },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const cancellationIntents = await ctx.db
      .query("stella_relay_cancellation_intents")
      .withIndex("by_ownerId_and_expiresAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(STELLA_RELAY_CLEANUP_MAX_DOCS);
    if (cancellationIntents.length > 0) {
      await Promise.all(
        cancellationIntents.map((intent) => ctx.db.delete(intent._id)),
      );
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
