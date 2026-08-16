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
import { requireConversationOwner } from "../auth";
import { enforceMutationRateLimit, RATE_HOT_PATH } from "../lib/rate_limits";
import { runAgentTurn } from "../automation/runner";
import type { Id } from "../_generated/dataModel";
import {
  EXECUTION_NOT_AVAILABLE_MESSAGE,
  shouldUseOfflineResponderForProvider,
} from "./execution_policy";
import {
  connectorMediaRefArrayValidator,
  extractDeliveryMediaFromOutput,
  type ConnectorMediaRef,
} from "./connector_media_types";

const BACKEND_FALLBACK_AGENT_TYPE = "offline_responder";
const EMPTY_RESPONSE_TEXT = "(Stella had nothing to say.)";
const RELAYED_MEDIA_DELETE_DELAY_MS = 10 * 60_000;



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
    .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
    .first();


// ─── Public Mutation (called by local device via HTTP) ──────────────────────
export const claimRemoteTurn = mutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
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
      "connector_claim_remote_turn",
      conversation.ownerId,
      RATE_HOT_PATH,
    );

    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") return null;
    if (request.conversationId !== args.conversationId) return null;
    if (
      request.requestState === "claimed" ||
      request.requestState === "fulfilled" ||
      request.requestState === "cancelled"
    ) {
      return null;
    }

    await ctx.db.patch(request._id, {
      requestState: "claimed",
      claimedAt: Date.now(),
      ...(args.deviceId ? { claimedByDeviceId: args.deviceId } : {}),
    });
    await ctx.runMutation(
      internal.channels.connector_turn_payloads.deleteByRequestId,
      { requestId: args.requestId },
    );

    return null;
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

    await ctx.db.patch(request._id, {
      requestState: "cancelled",
      cancelledAt: Date.now(),
    });
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
      "connector_complete_remote_turn",
      conversation.ownerId,
      RATE_HOT_PATH,
    );

    // Read routing metadata from the original remote_turn_request event
    // (never trust caller-provided routing data)
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
      request.requestState === "fulfilled" ||
      request.requestState === "cancelled"
    ) {
      return null;
    }

    const reqPayload = request.payload as Record<string, unknown>;
    const provider = reqPayload.provider as string;
    const deliveryMeta = reqPayload.deliveryMeta as Record<string, unknown>;

    // Mark as claimed so subsequent reads see consistent state. The
    // delivery action will flip it to `fulfilled` after the connector POST
    // succeeds.
    if (request.requestState !== "claimed") {
      await ctx.db.patch(request._id, {
        requestState: "claimed",
        claimedAt: Date.now(),
        ...(args.deviceId ? { claimedByDeviceId: args.deviceId } : {}),
      });
    }

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
      },
    );
    await ctx.runMutation(
      internal.channels.connector_turn_payloads.deleteByRequestId,
      { requestId: args.requestId },
    );

    return null;
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

    const reqPayload = request.payload as Record<string, unknown>;
    const provider = reqPayload.provider as string;
    const deliveryMeta = reqPayload.deliveryMeta as Record<string, unknown>;

    await ctx.scheduler.runAfter(
      0,
      internal.channels.connector_delivery.deliverConnectorFollowup,
      {
        provider,
        deliveryMeta: JSON.parse(JSON.stringify(deliveryMeta ?? {})),
        text: trimmed,
      },
    );

    return null;
  },
});


// ─── Shared delivery logic (callable from any action in the same runtime) ───

type DeliveryCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

type DeliveryArgs = {
  requestId: string;
  conversationId: Id<"conversations">;
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
): Promise<void> {
  try {
    const requestState = (await ctx.runQuery(
      internal.channels.connector_delivery.getRemoteTurnState,
      { requestId: args.requestId },
    )) as "pending" | "claimed" | "fulfilled" | "cancelled" | null;
    if (requestState === "cancelled" || requestState === "fulfilled") return;

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
    await ctx.runMutation(
      internal.channels.connector_delivery.markRemoteTurnFulfilled,
      { requestId: args.requestId },
    );
  } catch (error) {
    // NOT marking fulfilled — watchdog will retry delivery
    console.error(
      `[connector_delivery] Delivery failed for ${args.provider}:`,
      error,
    );
  }
}

// ─── Shared: run backend fallback agent + deliver to connector ──────────────

async function runFallbackAndDeliver(
  ctx: ActionCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    prompt: string;
    provider: string;
    deliveryMeta: Record<string, unknown>;
    userMessageId?: string;
  },
): Promise<void> {
  const result = await runAgentTurn({
    ctx,
    conversationId: args.conversationId,
    prompt: args.prompt,
    agentType: BACKEND_FALLBACK_AGENT_TYPE,
    ownerId: args.ownerId,
    userMessageId: args.userMessageId as Id<"events"> | undefined,
    modelOverride:
      typeof args.deliveryMeta.mobileModel === "string"
        ? args.deliveryMeta.mobileModel
        : null,
  });

  if (result.text.trim() && !result.silent) {
    await persistConnectorAssistantMessage(ctx, {
      conversationId: args.conversationId,
      provider: args.provider,
      text: result.text,
      usage: result.usage,
    });
  }

  const responseText = result.text.trim() || EMPTY_RESPONSE_TEXT;
  await deliverToConnectorCore(ctx, {
    requestId: args.requestId,
    conversationId: args.conversationId,
    provider: args.provider,
    deliveryMeta: args.deliveryMeta,
    text: responseText,
  });
}

async function persistConnectorAssistantMessage(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    conversationId: Id<"conversations">;
    provider: string;
    text: string;
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
  await ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId: args.conversationId,
    type: "assistant_message",
    payload: {
      text: args.text,
      source: `channel:${args.provider}`,
      ...(args.usage ? { usage: args.usage } : {}),
    },
  });
}

async function deliverExecutionUnavailable(
  ctx: ActionCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    provider: string;
    deliveryMeta: Record<string, unknown>;
  },
): Promise<void> {
  await persistConnectorAssistantMessage(ctx, {
    conversationId: args.conversationId,
    provider: args.provider,
    text: EXECUTION_NOT_AVAILABLE_MESSAGE,
  });

  await deliverToConnectorCore(ctx, {
    requestId: args.requestId,
    conversationId: args.conversationId,
    provider: args.provider,
    deliveryMeta: args.deliveryMeta,
    text: EXECUTION_NOT_AVAILABLE_MESSAGE,
  });
}

async function isTargetDeviceStillFresh(
  ctx: ActionCtx,
  args: {
    ownerId: string;
    targetDeviceId?: string;
  },
): Promise<boolean> {
  if (!args.targetDeviceId) {
    return false;
  }

  const freshDevices = (await ctx.runQuery(
    internal.agent.device_resolver.listFreshDevicesForOwner,
    { ownerId: args.ownerId, nowMs: Date.now() },
  )) as Array<{ deviceId: string }>;
  return freshDevices.some((device) => device.deviceId === args.targetDeviceId);
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
    prompt: v.string(),
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    userMessageId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
  },
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

    if (
      await isTargetDeviceStillFresh(ctx, {
        ownerId: args.ownerId,
        targetDeviceId: args.targetDeviceId,
      })
    ) {
      console.log(
        `[rescue:trace] Skipping fast rescue for ${args.requestId}; target desktop is still online.`,
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
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    text: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      await dispatchConnectorDelivery(ctx, {
        provider: args.provider,
        deliveryMeta: args.deliveryMeta as Record<string, unknown>,
        text: args.text,
      });
    } catch (error) {
      console.error(
        `[connector_delivery] Follow-up delivery failed for ${args.provider}:`,
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
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    text: v.string(),
    media: v.optional(connectorMediaRefArrayValidator),
  },
  handler: async (ctx, args) => {
    await deliverToConnectorCore(ctx, {
      requestId: args.requestId,
      conversationId: args.conversationId,
      provider: args.provider,
      deliveryMeta: args.deliveryMeta as Record<string, unknown>,
      text: args.text,
      media: args.media,
    });
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

export const deliverMediaJobToConnector = internalAction({
  args: {
    requestId: v.string(),
    jobId: v.string(),
    output: jsonValueValidator,
  },
  handler: async (ctx, args) => {
    const mediaInputs = extractDeliveryMediaFromOutput(args.output);
    if (mediaInputs.length === 0) return null;

    const target = (await ctx.runQuery(
      internal.channels.connector_delivery.getRemoteTurnDeliveryTarget,
      { requestId: args.requestId },
    )) as {
      conversationId: Id<"conversations">;
      provider: string;
      deliveryMeta: Record<string, unknown>;
    } | null;
    if (!target) return null;

    const media = (await ctx.runAction(
      internal.channels.connector_media.materializeRemoteMedia,
      {
        scopeId: `out:${args.jobId}`,
        media: mediaInputs,
      },
    )) as ConnectorMediaRef[];
    if (media.length === 0) return null;

    try {
      await dispatchConnectorDelivery(ctx, {
        requestId: args.requestId,
        conversationId: target.conversationId,
        provider: target.provider,
        deliveryMeta: target.deliveryMeta,
        text: "",
        media,
      });
      await ctx.runMutation(internal.media_jobs.markConnectorMediaDelivered, {
        jobId: args.jobId,
        deliveredAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        RELAYED_MEDIA_DELETE_DELAY_MS,
        internal.channels.connector_media.deleteRelayedMedia,
        { media },
      );
    } catch (error) {
      await ctx.runMutation(
        internal.media_jobs.markConnectorMediaDeliveryFailed,
        {
          jobId: args.jobId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }
    return null;
  },
});

/** Fetch the most recent assistant_message text for a conversation. */
async function getLatestAssistantText(
  ctx: Pick<ActionCtx, "runQuery">,
  conversationId: Id<"conversations">,
): Promise<string> {
  const events = (await ctx.runQuery(internal.events.listRecentMessages, {
    conversationId,
    limit: 20,
  })) as Array<{ type: string; payload: Record<string, unknown> }> | null;

  if (!events) return EMPTY_RESPONSE_TEXT;

  // listRecentMessages returns asc order — walk backwards to find the latest
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "assistant_message") {
      return (events[i].payload?.text as string) ?? EMPTY_RESPONSE_TEXT;
    }
  }
  return EMPTY_RESPONSE_TEXT;
}

const RESCUE_DELAY_MS = 5_000;

export const scheduleRescue = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    prompt: v.string(),
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    userMessageId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      RESCUE_DELAY_MS,
      internal.channels.connector_delivery.rescueSingleTurn,
      {
        requestId: args.requestId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        prompt: args.prompt,
        provider: args.provider,
        deliveryMeta: args.deliveryMeta,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
      },
    );
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
  args: { requestId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") return null;
    if (
      request.requestState === "fulfilled" ||
      request.requestState === "cancelled"
    ) {
      return null;
    }
    await ctx.db.patch(request._id, {
      requestState: "fulfilled",
      fulfilledAt: Date.now(),
    });
    await ctx.runMutation(
      internal.channels.connector_turn_payloads.deleteByRequestId,
      { requestId: args.requestId },
    );
    return null;
  },
});

const ORPHAN_MIN_AGE_MS = 90_000; // must be at least 90s old
const ORPHAN_MAX_AGE_MS = 10 * 60_000; // ignore anything older than 10 min

// Cap per-state scan; orphans are normally 0 and any backlog beyond this is
// picked up by the next 60s sweep.
const ORPHAN_SCAN_LIMIT = 100;

type OrphanResult = {
  eventId: Id<"events">;
  requestId: string;
  conversationId: Id<"conversations">;
  targetDeviceId: string;
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
        if (isCronRequest) {
          if (orphan.claimed) {
            // Claimed cron turns should be fulfilled atomically by desktop.
            // If they are still orphaned, mark as failed to unblock the job.
            await ctx.runMutation(
              internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
              {
                requestId: orphan.requestId,
                conversationId,
                text: "",
                status: "error",
                error:
                  "Cron turn was claimed by desktop but never fulfilled before watchdog timeout.",
                skipAssistantMessage: true,
              },
            );
            console.log(
              `[watchdog] Rescued cron orphan ${orphan.requestId} (claimed -> marked failed)`,
            );
            continue;
          }

          const conversation = await ctx.runQuery(
            internal.conversations.getById,
            {
              id: conversationId,
            },
          );
          if (!conversation) {
            await ctx.runMutation(
              internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
              {
                requestId: orphan.requestId,
                conversationId,
                text: "",
                status: "error",
                error: `Conversation ${String(conversationId)} not found during watchdog rescue.`,
                skipAssistantMessage: true,
              },
            );
            continue;
          }

          const result = await runAgentTurn({
            ctx,
            conversationId,
            prompt,
            agentType: BACKEND_FALLBACK_AGENT_TYPE,
            ownerId: conversation.ownerId,
            userMessageId: userMessageId as Id<"events"> | undefined,
          });

          await ctx.runMutation(
            internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
            {
              requestId: orphan.requestId,
              conversationId,
              text: result.text.trim(),
              status: "ok",
            },
          );
          console.log(
            `[watchdog] Rescued cron orphan ${orphan.requestId} (backend fallback execution)`,
          );
          continue;
        }

        if (orphan.claimed) {
          // Case 1: Claimed but not fulfilled — the local device ran the turn
          // but delivery failed. Retry delivery only (no re-execution).
          console.log(
            `[watchdog] Retrying delivery for claimed turn ${orphan.requestId}`,
          );
          await deliverToConnectorCore(ctx, {
            requestId: orphan.requestId,
            conversationId: orphan.conversationId,
            provider,
            deliveryMeta: JSON.parse(JSON.stringify(deliveryMeta)),
            text: await getLatestAssistantText(ctx, orphan.conversationId),
          });
        } else {
          // Case 2: Not claimed — device went offline before picking up the
          // request. Non-mobile connectors should never use the offline
          // responder; return the execution-unavailable message instead.
          if (!shouldUseOfflineResponderForProvider(provider)) {
            await deliverExecutionUnavailable(ctx, {
              requestId: orphan.requestId,
              conversationId,
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

          // Mobile app can still use the backend offline responder.
          const conversation = await ctx.runQuery(
            internal.conversations.getById,
            { id: conversationId },
          );
          if (!conversation) {
            console.error(
              `[watchdog] Conversation ${String(conversationId)} not found, skipping`,
            );
            continue;
          }

          if (
            await isTargetDeviceStillFresh(ctx, {
              ownerId: conversation.ownerId,
              targetDeviceId: orphan.targetDeviceId,
            })
          ) {
            console.log(
              `[watchdog] Skipping mobile fallback for ${orphan.requestId}; target desktop is still online.`,
            );
            continue;
          }

          await runFallbackAndDeliver(ctx, {
            requestId: orphan.requestId,
            conversationId,
            ownerId: conversation.ownerId,
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

        if (isCronRequest) {
          try {
            await ctx.runMutation(
              internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
              {
                requestId: orphan.requestId,
                conversationId,
                text: "",
                status: "error",
                error: String(error),
                skipAssistantMessage: true,
              },
            );
          } catch {
            // Best effort.
          }
          continue;
        }

        // Mark as fulfilled to prevent infinite retries
        try {
          await ctx.runMutation(
            internal.channels.connector_delivery.markRemoteTurnFulfilled,
            { requestId: orphan.requestId },
          );
        } catch {
          // Best effort — if this fails too, the orphan will age out after 10 min
        }
      }
    }

    return null;
  },
});
