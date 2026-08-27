import {
  mutation,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  assertOwnerMigrationWriteAllowed,
  requireConversationOwner,
} from "../auth";
import { enforceMutationRateLimit, RATE_HOT_PATH } from "../lib/rate_limits";

/**
 * Backend cron scheduling was removed. The remaining responsibility here is
 * completing cron-originated remote turn requests that were already handed to
 * a desktop device before the backend scheduler was retired.
 */
export const BACKEND_CRON_RUNTIME_REMOVED = true;

type CompleteCronTurnStatus = "ok" | "error";

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

async function completeCronTurnResultCore(
  ctx: MutationCtx,
  args: {
    requestId: string;
    text: string;
    conversationId: Id<"conversations">;
    status?: CompleteCronTurnStatus;
    error?: string;
    skipAssistantMessage?: boolean;
    rescuedByWatchdog?: boolean;
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    source: "desktop" | "cron_watchdog";
    deviceId?: string;
    now: number;
  },
): Promise<boolean> {
  const status: CompleteCronTurnStatus = args.status ?? "ok";
  const trimmedText = args.text.trim();

  const request = await ctx.db
    .query("events")
    .withIndex("by_type_and_requestId", (q) =>
      q.eq("type", "remote_turn_request").eq("requestId", args.requestId),
    )
    .unique();
  if (!request || request.type !== "remote_turn_request") {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Invalid or missing remote_turn_request",
    });
  }
  if (request.conversationId !== args.conversationId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Conversation mismatch",
    });
  }

  const requestPayload = request.payload as Record<string, unknown>;
  if (requestPayload.source !== "cron") {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Request is not a cron remote turn",
    });
  }

  if (
    request.requestState === "fulfilled" &&
    request.lastAttemptId === args.attemptId
  ) {
    return true;
  }
  if (
    request.requestState === "cancelled" ||
    request.ownerBindingState !== "bound" ||
    request.ownerId !== args.ownerId ||
    request.ownerGeneration !== args.ownerGeneration ||
    request.activeAttemptId !== args.attemptId ||
    request.activeAttemptSource !== args.source ||
    request.activeAttemptDeviceId !== args.deviceId ||
    request.activeAttemptState !== "active" ||
    args.now >= (request.attemptLeaseExpiresAt ?? 0) ||
    args.now >= (request.attemptHardExpiresAt ?? 0)
  ) {
    return false;
  }
  const conversation = await ctx.db.get(args.conversationId);
  if (!conversation || conversation.ownerId !== args.ownerId) return false;
  try {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
  } catch {
    return false;
  }

  const deliver = requestPayload.deliver as boolean | undefined;
  if (
    status === "ok" &&
    !args.skipAssistantMessage &&
    (deliver ?? true) &&
    trimmedText.length > 0
  ) {
    await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp: args.now,
      type: "assistant_message",
      payload: {
        text: trimmedText,
        source: "cron",
        cronJobId: asOptionalString(requestPayload.cronJobId),
        cronJobName: asOptionalString(requestPayload.cronJobName),
      },
    });
  }

  if (request.attemptCleanupJobId) {
    await ctx.scheduler.cancel(request.attemptCleanupJobId);
  }
  await ctx.db.patch(request._id, {
    requestState: "fulfilled",
    fulfilledAt: args.now,
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
    lastAttemptId: args.attemptId,
    lastAttemptOutcome: status === "ok" ? "succeeded" : "failed",
    lastAttemptFinishedAt: args.now,
  });

  if (status === "error" && args.error) {
    // Persist the error inline on the request payload so callers can
    // surface it without poking at separate event rows.
    const nextPayload = {
      ...(requestPayload as Record<string, unknown>),
      lastError: args.error,
      ...(args.rescuedByWatchdog ? { rescuedByWatchdog: true } : {}),
    };
    await ctx.db.patch(request._id, { payload: nextPayload });
  } else if (args.rescuedByWatchdog) {
    const nextPayload = {
      ...(requestPayload as Record<string, unknown>),
      rescuedByWatchdog: true,
    };
    await ctx.db.patch(request._id, { payload: nextPayload });
  }
  return true;
}

export const completeCronTurnResult = mutation({
  args: {
    requestId: v.string(),
    text: v.string(),
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    attemptId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await requireConversationOwner(
      ctx,
      args.conversationId,
    );
    await enforceMutationRateLimit(
      ctx,
      "cron_complete_turn_result",
      conversation.ownerId,
      RATE_HOT_PATH,
    );
    const request = await ctx.db
      .query("events")
      .withIndex("by_type_and_requestId", (q) =>
        q.eq("type", "remote_turn_request").eq("requestId", args.requestId),
      )
      .unique();
    if (
      !request ||
      request.conversationId !== args.conversationId ||
      request.ownerId !== conversation.ownerId ||
      typeof request.ownerGeneration !== "string" ||
      request.targetDeviceId !== args.deviceId
    ) {
      throw new ConvexError({
        code: "REMOTE_TURN_ATTEMPT_STALE",
        message: "Cron completion lost exact remote-turn authority.",
      });
    }
    const accepted = await completeCronTurnResultCore(ctx, {
      requestId: args.requestId,
      text: args.text,
      conversationId: args.conversationId,
      status: "ok",
      ownerId: conversation.ownerId,
      ownerGeneration: request.ownerGeneration,
      attemptId: args.attemptId,
      source: "desktop",
      deviceId: args.deviceId,
      now: Date.now(),
    });
    if (!accepted) {
      throw new ConvexError({
        code: "REMOTE_TURN_ATTEMPT_STALE",
        message: "Cron completion lost exact remote-turn authority.",
      });
    }
    return null;
  },
});

export const completeCronTurnResultFromWatchdog = internalMutation({
  args: {
    requestId: v.string(),
    text: v.string(),
    conversationId: v.id("conversations"),
    status: v.union(v.literal("ok"), v.literal("error")),
    error: v.optional(v.string()),
    skipAssistantMessage: v.optional(v.boolean()),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    source: v.literal("cron_watchdog"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    return await completeCronTurnResultCore(ctx, {
      requestId: args.requestId,
      text: args.text,
      conversationId: args.conversationId,
      status: args.status,
      error: args.error,
      skipAssistantMessage: args.skipAssistantMessage,
      rescuedByWatchdog: true,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      attemptId: args.attemptId,
      source: args.source,
      now: Date.now(),
    });
  },
});
