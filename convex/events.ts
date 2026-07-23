import { query, internalQuery, internalMutation } from "./_generated/server";
import { v, ConvexError, Infer, type Value } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getUserIdOrNull } from "./auth";
import {
  jsonValueValidator,
  optionalChannelEnvelopeValidator,
} from "./shared_validators";
import { normalizeOptionalInt } from "./lib/number_utils";
import {
  estimateContextEventTokens,
  selectRecentByTokenBudget,
} from "./lib/context_window";
import { eventTypeValidator } from "./schema/conversations";
import { CONNECTOR_TURN_PAYLOAD_REF } from "./channels/connector_privacy";

const eventValidator = v.object({
  _id: v.id("events"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  timestamp: v.number(),
  type: eventTypeValidator,
  deviceId: v.optional(v.string()),
  requestId: v.optional(v.string()),
  targetDeviceId: v.optional(v.string()),
  requestState: v.optional(
    v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("fulfilled"),
      v.literal("cancelled"),
    ),
  ),
  claimedByDeviceId: v.optional(v.string()),
  claimedAt: v.optional(v.number()),
  fulfilledAt: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
  payload: jsonValueValidator,
  channelEnvelope: optionalChannelEnvelopeValidator,
});

const usageSummaryValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
});

const MAX_EVENTS_QUERY_LIMIT = 2000;
const MAX_SYNC_EVENTS_QUERY_LIMIT = 1000;
const MAX_CONTEXT_TOKENS = 120_000;
const MIN_SCAN_LIMIT = 240;
const MAX_SCAN_LIMIT = 2400;

const sanitizeEventForRead = <
  T extends { type: string; payload: Value } | null,
>(
  event: T,
): T => {
  if (!event) {
    return event;
  }
  return {
    ...event,
    payload: event.payload ?? {},
  } as T;
};

const hydrateConnectorRemoteTurnPayload = async (
  ctx: QueryCtx,
  event: Infer<typeof eventValidator>,
): Promise<Infer<typeof eventValidator> | null> => {
  if (event.type !== "remote_turn_request" || !event.requestId) {
    return sanitizeEventForRead(event);
  }

  const eventPayload =
    event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  if (eventPayload.payloadRef !== CONNECTOR_TURN_PAYLOAD_REF) {
    return sanitizeEventForRead(event);
  }

  const payloadRow = await ctx.db
    .query("connector_turn_payloads")
    .withIndex("by_requestId", (q) => q.eq("requestId", event.requestId!))
    .unique();
  if (!payloadRow || payloadRow.expiresAt <= Date.now()) {
    return null;
  }

  return sanitizeEventForRead({
    ...event,
    payload: {
      ...eventPayload,
      ...(payloadRow.payload as Record<string, unknown>),
    } as Value,
  });
};

/**
 * Returns the number of events in a conversation. Reads the denormalized
 * `eventCount` counter on the conversation doc, which is initialised to 0
 * on `createConversation`/`getOrCreateDefaultConversation` and bumped by
 * `appendEventCore`.
 */
export const countByConversation = internalQuery({
  args: { conversationId: v.id("conversations") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    return conversation?.eventCount ?? 0;
  },
});

export const listOlderMessages = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    beforeTimestamp: v.number(),
    afterTimestamp: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const afterTs = args.afterTimestamp ?? 0;
    // Use by_conversation_type index for efficient type-scoped queries.
    const [userMessages, assistantMessages] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("type", "user_message")
            .gt("timestamp", afterTs)
            .lt("timestamp", args.beforeTimestamp),
        )
        .order("asc")
        .take(args.limit),
      ctx.db
        .query("events")
        .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("type", "assistant_message")
            .gt("timestamp", afterTs)
            .lt("timestamp", args.beforeTimestamp),
        )
        .order("asc")
        .take(args.limit),
    ]);

    return orderEventsChronologically([
      ...userMessages,
      ...assistantMessages,
    ]).slice(0, args.limit);
  },
});

export const listMessagesInWindow = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.endTimestamp <= args.startTimestamp) {
      return [];
    }

    const limit = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 400,
      min: 1,
      max: MAX_EVENTS_QUERY_LIMIT,
    });

    const types = [
      "user_message",
      "assistant_message",
      "agent-completed",
    ] as const;
    const perType = await Promise.all(
      types.map((type) =>
        ctx.db
          .query("events")
          .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
            q
              .eq("conversationId", args.conversationId)
              .eq("type", type)
              .gt("timestamp", args.startTimestamp)
              .lte("timestamp", args.endTimestamp),
          )
          .order("asc")
          .take(limit),
      ),
    );

    return orderEventsChronologically(perType.flat()).slice(0, limit);
  },
});
export const getById = internalQuery({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    return sanitizeEventForRead(await ctx.db.get(args.id));
  },
});

export const listRecentMessages = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? 20;
    if (requestedLimit <= 0) {
      return [];
    }
    const limit = Math.min(Math.floor(requestedLimit), 100);
    // 3x overfetch: we query 2 type-specific indexes and merge, so ~1/2 of rows match per type
    const take = Math.min(Math.max(limit * 3, 50), 200);

    // `beforeTimestamp` is part of the index range (not a JS post-filter) so
    // the newest `take` rows we read are already at-or-before the bound.
    const takeMessagesOfType = (
      type: "user_message" | "assistant_message",
    ) => {
      const base = ctx.db.query("events");
      const query =
        args.beforeTimestamp !== undefined
          ? base.withIndex("by_conversationId_and_type_and_timestamp", (q) =>
              q
                .eq("conversationId", args.conversationId)
                .eq("type", type)
                .lte("timestamp", args.beforeTimestamp!),
            )
          : base.withIndex("by_conversationId_and_type_and_timestamp", (q) =>
              q.eq("conversationId", args.conversationId).eq("type", type),
            );
      return query.order("desc").take(take);
    };

    const [userEvents, assistantEvents] = await Promise.all([
      takeMessagesOfType("user_message"),
      takeMessagesOfType("assistant_message"),
    ]);

    let combined = [...userEvents, ...assistantEvents];

    if (args.excludeEventId) {
      combined = combined.filter((event) => event._id !== args.excludeEventId);
    }

    combined = orderEventsChronologically(combined);

    if (combined.length > limit) {
      combined = combined.slice(-limit);
    }

    return combined;
  },
});

const MODEL_CONTEXT_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "microcompact_boundary",
  "agent-started",
  "agent-completed",
  "agent-failed",
]);

const CHAT_CONTEXT_EVENT_TYPES = new Set(["user_message", "assistant_message"]);

type ContextEvent = Infer<typeof eventValidator>;
type RecentConversationEventsArgs = {
  conversationId: Id<"conversations">;
  beforeTimestamp?: number;
  excludeEventId?: Id<"events">;
  take: number;
};

type ContextEventFilterOptions = {
  includeOperationalEvents?: boolean;
};

const fetchRecentConversationEvents = async (
  ctx: QueryCtx,
  args: RecentConversationEventsArgs,
): Promise<ContextEvent[]> => {
  // The two branches are kept explicit so the index hint doesn't depend on
  // a runtime conditional; the typed query builder generates the right index
  // range either way.
  const base = ctx.db.query("events");
  const query =
    args.beforeTimestamp !== undefined
      ? base.withIndex("by_conversationId_and_timestamp", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .lte("timestamp", args.beforeTimestamp!),
        )
      : base.withIndex("by_conversationId_and_timestamp", (q) =>
          q.eq("conversationId", args.conversationId),
        );

  let events = await query.order("desc").take(args.take);
  if (args.excludeEventId) {
    events = events.filter((event) => event._id !== args.excludeEventId);
  }
  return events;
};

const filterContextEvents = (
  eventsNewestFirst: ContextEvent[],
  options?: ContextEventFilterOptions,
): ContextEvent[] => {
  const modelEvents = eventsNewestFirst.filter((event) =>
    MODEL_CONTEXT_EVENT_TYPES.has(event.type),
  );
  if (options?.includeOperationalEvents === false) {
    return modelEvents.filter((event) =>
      CHAT_CONTEXT_EVENT_TYPES.has(event.type),
    );
  }
  return modelEvents;
};

const orderEventsChronologically = <
  T extends { timestamp: number; _id: Id<"events"> },
>(
  events: T[],
): T[] => {
  events.sort(
    (a, b) =>
      a.timestamp - b.timestamp || String(a._id).localeCompare(String(b._id)),
  );
  return events;
};

export const listRecentContextEvents = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? 20;
    if (requestedLimit <= 0) {
      return [];
    }
    const limit = Math.min(Math.floor(requestedLimit), 120);
    // 8x overfetch: context events include many non-message types (tool calls, task events, etc.) that get filtered
    const take = Math.min(Math.max(limit * 8, 80), 800);
    let events = await fetchRecentConversationEvents(ctx, {
      conversationId: args.conversationId,
      beforeTimestamp: args.beforeTimestamp,
      excludeEventId: args.excludeEventId,
      take,
    });
    events = orderEventsChronologically(filterContextEvents(events));

    if (events.length > limit) {
      events = events.slice(-limit);
    }

    return events.map((event) => sanitizeEventForRead(event));
  },
});

/**
 * Hard cap on session-context event reads. Stays comfortably below Convex's
 * 8192 array-return limit so a session-restore query can't fail at runtime
 * the moment a busy conversation grows past a few thousand events.
 */
const MAX_SESSION_CONTEXT_EVENTS = 4_000;

export const listSessionContextEvents = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
    includeOperationalEvents: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeOptionalInt({
      value: args.limit,
      defaultValue: MAX_SESSION_CONTEXT_EVENTS,
      min: 1,
      max: MAX_SESSION_CONTEXT_EVENTS,
    });
    let events = await fetchRecentConversationEvents(ctx, {
      conversationId: args.conversationId,
      beforeTimestamp: args.beforeTimestamp,
      excludeEventId: args.excludeEventId,
      take: limit,
    });
    events = orderEventsChronologically(
      filterContextEvents(events, {
        includeOperationalEvents: args.includeOperationalEvents,
      }),
    );
    return events.map((event) => sanitizeEventForRead(event));
  },
});

export const listRecentContextEventsByTokens = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    maxTokens: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
    includeOperationalEvents: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const maxTokens = Math.min(
      Math.max(Math.floor(args.maxTokens ?? 24_000), 1),
      MAX_CONTEXT_TOKENS,
    );
    // Approximate how many recent rows we may need to cover maxTokens.
    // Clamp for predictable query cost.
    const scanLimit = Math.min(
      Math.max(Math.ceil(maxTokens / 6), MIN_SCAN_LIMIT),
      MAX_SCAN_LIMIT,
    );
    const events = await fetchRecentConversationEvents(ctx, {
      conversationId: args.conversationId,
      beforeTimestamp: args.beforeTimestamp,
      excludeEventId: args.excludeEventId,
      take: scanLimit,
    });
    const contextEvents = filterContextEvents(events, {
      includeOperationalEvents: args.includeOperationalEvents,
    });

    const selectedNewestFirst = selectRecentByTokenBudget({
      itemsNewestFirst: contextEvents,
      maxTokens,
      estimateTokens: (event) =>
        estimateContextEventTokens({
          type: event.type,
          payload: event.payload,
          requestId: event.requestId,
        }),
    });

    const sorted = orderEventsChronologically(selectedNewestFirst);

    return sorted.map((event) => sanitizeEventForRead(event));
  },
});

export const getLatestDeviceIdForConversation = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
        q.eq("conversationId", args.conversationId).eq("type", "user_message"),
      )
      .order("desc")
      .first();
    const deviceId =
      typeof event?.deviceId === "string" ? event.deviceId.trim() : "";
    return deviceId || null;
  },
});

export const saveAssistantMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    text: v.string(),
    userMessageId: v.optional(v.id("events")),
    usage: v.optional(usageSummaryValidator),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const eventId = await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp,
      type: "assistant_message",
      payload: {
        text: args.text,
        ...(args.userMessageId && { userMessageId: args.userMessageId }),
        ...(args.usage && { usage: args.usage }),
      },
    });
    await ctx.db.patch(args.conversationId, { updatedAt: timestamp });
    return eventId;
  },
});

const deviceRequiredTypes = new Set(["user_message", "screen_event"]);

type AppendEventArgs = {
  conversationId: Id<"conversations">;
  type: Infer<typeof eventTypeValidator>;
  timestamp?: number;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  /**
   * Initial lifecycle state for `remote_turn_request` events. Defaults to
   * `"pending"` if the caller doesn't provide one. Ignored for every other
   * event type.
   */
  requestState?: "pending" | "claimed" | "fulfilled" | "cancelled";
  payload: Value;
  channelEnvelope?: Infer<typeof optionalChannelEnvelopeValidator>;
};

const resolveAppendEventPayload = (args: AppendEventArgs) => {
  if (deviceRequiredTypes.has(args.type) && !args.deviceId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `deviceId required for ${args.type}`,
    });
  }

  if (args.type === "user_message") {
    const text = (args.payload as Record<string, unknown>)?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "user_message requires non-empty text",
      });
    }
    if (text.length > 100_000) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message:
          "user_message text exceeds maximum allowed length of 100,000 characters",
      });
    }
  }

  return {
    payload: args.payload ?? {},
    targetDeviceId: args.targetDeviceId,
    timestamp: args.timestamp ?? Date.now(),
  };
};

const appendEventCore = async (ctx: MutationCtx, args: AppendEventArgs) => {
  const { payload, targetDeviceId, timestamp } =
    resolveAppendEventPayload(args);

  const conversation = await ctx.db.get(args.conversationId);
  // Stamp `requestState: "pending"` on freshly-inserted remote-turn requests
  // so the device subscription can filter unhandled rows at the index level
  // without doing per-event extra reads.
  const requestState =
    args.type === "remote_turn_request"
      ? (args.requestState ?? "pending")
      : args.requestState;
  const eventId = await ctx.db.insert("events", {
    conversationId: args.conversationId,
    timestamp,
    type: args.type,
    deviceId: args.deviceId,
    requestId: args.requestId,
    targetDeviceId,
    ...(requestState !== undefined ? { requestState } : {}),
    payload,
    channelEnvelope: args.channelEnvelope,
  });

  // Maintain the denormalized event counter so `countByConversation` can
  // serve in O(1) without paginating the events table.
  await ctx.db.patch(args.conversationId, {
    updatedAt: timestamp,
    eventCount: (conversation?.eventCount ?? 0) + 1,
  });
  const inserted = await ctx.db.get(eventId);
  return sanitizeEventForRead(inserted);
};

export const appendInternalEvent = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    type: eventTypeValidator,
    timestamp: v.optional(v.number()),
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    payload: jsonValueValidator,
    channelEnvelope: optionalChannelEnvelopeValidator,
  },
  handler: async (ctx, args) => {
    return await appendEventCore(ctx, args);
  },
});

export const listEventsSince = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    afterTimestamp: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const afterTimestamp = args.afterTimestamp ?? 0;
    const limit = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 400,
      min: 1,
      max: MAX_SYNC_EVENTS_QUERY_LIMIT,
    });

    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .gt("timestamp", afterTimestamp),
      )
      .order("asc")
      .take(limit);

    return events.map((event) => sanitizeEventForRead(event));
  },
});

export const getConversationEventHead = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();

    return {
      latestTimestamp: latest?.timestamp ?? 0,
      latestEventId: latest?._id ?? null,
    };
  },
});

/**
 * Batch-load conversation ownership for a set of (possibly repeated)
 * conversation ids so the device subscription queries don't issue one
 * sequential `ctx.db.get` per candidate event.
 */
const loadConversationOwnership = async (
  ctx: QueryCtx,
  conversationIds: Id<"conversations">[],
  ownerId: string,
): Promise<Map<Id<"conversations">, boolean>> => {
  const uniqueIds = [...new Set(conversationIds)];
  const conversations = await Promise.all(
    uniqueIds.map((conversationId) => ctx.db.get(conversationId)),
  );
  const ownership = new Map<Id<"conversations">, boolean>();
  uniqueIds.forEach((conversationId, index) => {
    const conversation = conversations[index];
    ownership.set(
      conversationId,
      Boolean(conversation && conversation.ownerId === ownerId),
    );
  });
  return ownership;
};

export const subscribeRemoteTurnRequestsForDevice = query({
  args: {
    deviceId: v.string(),
    since: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(eventValidator),
  handler: async (ctx, args) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    const maxItems = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 10,
      min: 1,
      max: 50,
    });

    // Type-scoped index lets us read exactly the rows we need; ownership
    // still has to be confirmed per row because the index is keyed on the
    // device, not the conversation owner. The lifecycle filter is now an
    // O(1) field read on each row instead of two extra index lookups.
    const events = await ctx.db
      .query("events")
      .withIndex("by_targetDeviceId_and_type_and_timestamp", (q) =>
        q
          .eq("targetDeviceId", args.deviceId)
          .eq("type", "remote_turn_request")
          .gte("timestamp", args.since),
      )
      .order("desc")
      .take(maxItems * 2);

    const candidates = events.filter(
      (event) => !event.requestState || event.requestState === "pending",
    );
    const ownershipByConversation = await loadConversationOwnership(
      ctx,
      candidates.map((event) => event.conversationId),
      ownerId,
    );
    const filtered: Infer<typeof eventValidator>[] = [];

    for (const event of candidates) {
      if (!ownershipByConversation.get(event.conversationId)) continue;

      const hydrated = await hydrateConnectorRemoteTurnPayload(ctx, event);
      if (!hydrated) continue;

      filtered.push(hydrated);
      if (filtered.length >= maxItems) break;
    }

    return filtered;
  },
});

/**
 * Reactive feed of `remote_turn_request` rows targeted at this device that
 * have transitioned to `requestState: "cancelled"`. The local device's
 * remote-turn bridge subscribes here and, when a cancelled requestId
 * matches an in-flight orchestrator run, aborts it via the worker.
 *
 * Cancelled rows for not-yet-claimed requests are also surfaced — the
 * bridge can de-dup with its own pending map without harm.
 *
 * The cancel state is intentionally a separate query from
 * `subscribeRemoteTurnRequestsForDevice` (which filters out anything
 * non-`pending`): the request feed drives "should I start this turn?" while
 * the cancel feed drives "should I abort a turn I already started?".
 */
export const subscribeRemoteTurnCancelsForDevice = query({
  args: {
    deviceId: v.string(),
    since: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      requestId: v.string(),
      conversationId: v.id("conversations"),
      cancelledAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    const maxItems = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 20,
      min: 1,
      max: 100,
    });

    const events = await ctx.db
      .query("events")
      .withIndex("by_targetDeviceId_and_type_and_timestamp", (q) =>
        q
          .eq("targetDeviceId", args.deviceId)
          .eq("type", "remote_turn_request")
          .gte("timestamp", args.since),
      )
      .order("desc")
      .take(maxItems * 2);

    const candidates = events.filter(
      (event) =>
        event.requestState === "cancelled" &&
        Boolean(event.requestId) &&
        typeof event.cancelledAt === "number",
    );
    const ownershipByConversation = await loadConversationOwnership(
      ctx,
      candidates.map((event) => event.conversationId),
      ownerId,
    );
    const out: {
      requestId: string;
      conversationId: Id<"conversations">;
      cancelledAt: number;
    }[] = [];

    for (const event of candidates) {
      if (!ownershipByConversation.get(event.conversationId)) continue;

      out.push({
        requestId: event.requestId!,
        conversationId: event.conversationId,
        cancelledAt: event.cancelledAt!,
      });
      if (out.length >= maxItems) break;
    }

    return out;
  },
});

/** Look up the original `remote_turn_request` event by its requestId. */
const findRemoteTurnRequest = async (
  ctx: QueryCtx | MutationCtx,
  requestId: string,
) =>
  await ctx.db
    .query("events")
    .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
    .first();

/**
 * Public query — used by the local device runner for cross-restart dedup.
 *
 * Scoped to the caller's own conversation so this can't double as an
 * existence/state oracle for arbitrary `requestId` values: we treat any row
 * the caller doesn't own as if it didn't exist (returning `false`).
 */
export const isRemoteTurnClaimed = query({
  args: {
    requestId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const ownerId = await getUserIdOrNull(ctx);
    if (!ownerId) {
      return false;
    }
    const event = await findRemoteTurnRequest(ctx, args.requestId);
    if (!event) return false;
    const conversation = await ctx.db.get(event.conversationId);
    if (!conversation || conversation.ownerId !== ownerId) {
      return false;
    }
    return (
      event.requestState === "claimed" || event.requestState === "fulfilled"
    );
  },
});
