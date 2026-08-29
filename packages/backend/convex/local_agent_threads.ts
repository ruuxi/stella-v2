import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireUserId } from "./auth";
import {
  cloudAgentSandboxLeaseExpiresAt,
  shouldApplyComputerAgentTerminal,
} from "./lib/computer_agent_thread";
import { enforceMutationRateLimit, RATE_HOT_PATH } from "./lib/rate_limits";
import { assertOwnerDataWriteAllowed } from "./owner_lifecycle";

const MAX_THREAD_ID_CHARS = 256;
const MAX_DEVICE_ID_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 1_000;
const MAX_AGENT_TYPE_CHARS = 100;
const MAX_RESULT_CHARS = 30_000;
const MAX_ERROR_CHARS = 10_000;

const terminalStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
);

const computerAgentSnapshotValidator = v.object({
  id: v.string(),
  status: v.union(
    v.literal("running"),
    v.literal("completed"),
    v.literal("error"),
    v.literal("canceled"),
  ),
  description: v.string(),
  startedAt: v.number(),
  completedAt: v.union(v.number(), v.null()),
  result: v.union(v.string(), v.null()),
  error: v.union(v.string(), v.null()),
});

type ComputerAgentSnapshot = {
  id: string;
  status: "running" | "completed" | "error" | "canceled";
  description: string;
  startedAt: number;
  completedAt: number | null;
  result: string | null;
  error: string | null;
};

const computerAgentStartRejected = (
  reason:
    | "conversation_not_found"
    | "thread_identity_conflict"
    | "attempt_stale"
    | "attempt_replay_conflict"
    | "attempt_not_next"
    | "initial_attempt_invalid",
  message: string,
) =>
  new ConvexError({
    code: "COMPUTER_AGENT_START_REJECTED",
    reason,
    message,
  });

const normalizeRequiredString = (
  value: string,
  field: string,
  maxChars: number,
): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars) {
    throw new ConvexError(`${field} must contain 1–${maxChars} characters.`);
  }
  return normalized;
};

const normalizeAttemptGeneration = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConvexError("attemptGeneration must be a positive integer.");
  }
  return value;
};

const requireOwnedCloudConversation = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  conversationId: string,
) => {
  const conversation = await ctx.db
    .query("cloud_conversations")
    .withIndex("by_conversationId", (q) =>
      q.eq("conversationId", conversationId),
    )
    .unique();
  if (
    !conversation ||
    conversation.ownerId !== ownerId ||
    conversation.deletedAt !== undefined
  ) {
    throw computerAgentStartRejected(
      "conversation_not_found",
      "Conversation not found.",
    );
  }
  return conversation;
};

const requireOwnedComputerThread = async (
  ctx: QueryCtx | MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    threadId: string;
    originDeviceId: string;
  },
) => {
  const thread = await ctx.db
    .query("cloud_agent_threads")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
    .unique();
  if (
    !thread ||
    thread.ownerId !== args.ownerId ||
    thread.ownerGeneration !== args.ownerGeneration ||
    thread.placement !== "computer" ||
    thread.originDeviceId !== args.originDeviceId
  ) {
    throw new ConvexError("Agent thread not found.");
  }
  return thread;
};

/**
 * Publish the start of one desktop-computer attempt into the canonical
 * Activity table. The local thread id is the cloud row id so browser state
 * and the desktop operational overlay reconcile instead of rendering twice.
 */
export const startMyComputerAgentThread = mutation({
  args: {
    threadId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    originDeviceId: v.string(),
    description: v.string(),
    agentType: v.string(),
    attemptGeneration: v.number(),
  },
  returns: v.object({ agentId: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const ownerGeneration = normalizeRequiredString(
      args.ownerGeneration,
      "ownerGeneration",
      MAX_THREAD_ID_CHARS,
    );
    await assertOwnerDataWriteAllowed(ctx, ownerId, ownerGeneration);
    const threadId = normalizeRequiredString(
      args.threadId,
      "threadId",
      MAX_THREAD_ID_CHARS,
    );
    const conversationId = normalizeRequiredString(
      args.conversationId,
      "conversationId",
      MAX_THREAD_ID_CHARS,
    );
    const originDeviceId = normalizeRequiredString(
      args.originDeviceId,
      "originDeviceId",
      MAX_DEVICE_ID_CHARS,
    );
    const description = normalizeRequiredString(
      args.description,
      "description",
      MAX_DESCRIPTION_CHARS,
    );
    const agentType = normalizeRequiredString(
      args.agentType,
      "agentType",
      MAX_AGENT_TYPE_CHARS,
    );
    const attemptGeneration = normalizeAttemptGeneration(
      args.attemptGeneration,
    );
    await enforceMutationRateLimit(
      ctx,
      "computer_agent_start",
      ownerId,
      RATE_HOT_PATH,
    );
    await requireOwnedCloudConversation(ctx, ownerId, conversationId);

    const existing = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .unique();
    const now = Date.now();
    if (existing) {
      if (
        existing.ownerId !== ownerId ||
        existing.ownerGeneration !== ownerGeneration ||
        existing.placement !== "computer" ||
        existing.originDeviceId !== originDeviceId ||
        existing.conversationId !== conversationId
      ) {
        throw computerAgentStartRejected(
          "thread_identity_conflict",
          "Agent thread not found.",
        );
      }
      const currentGeneration = existing.attemptGeneration ?? 0;
      if (currentGeneration > attemptGeneration) {
        throw computerAgentStartRejected(
          "attempt_stale",
          "Computer agent attempt is stale.",
        );
      }
      if (currentGeneration === attemptGeneration) {
        if (
          existing.description !== description ||
          existing.agentType !== agentType
        ) {
          throw computerAgentStartRejected(
            "attempt_replay_conflict",
            "Computer agent attempt was replayed with different input.",
          );
        }
        return { agentId: threadId };
      }
      if (attemptGeneration !== currentGeneration + 1) {
        throw computerAgentStartRejected(
          "attempt_not_next",
          "Computer agent attempt generation is not next.",
        );
      }
      await ctx.db.patch(existing._id, {
        description,
        agentType,
        status: "running",
        resultJson: undefined,
        errorMessage: undefined,
        // Every attempt owns a distinct terminal-delivery receipt. A previous
        // generation's ACK must never hide this generation from the originating
        // device's recovery subscription.
        originDeliveryAckAt: undefined,
        attemptGeneration,
        sandboxLeaseExpiresAt: cloudAgentSandboxLeaseExpiresAt("computer", now),
        updatedAt: now,
      });
      return { agentId: threadId };
    }

    if (attemptGeneration !== 1) {
      throw computerAgentStartRejected(
        "initial_attempt_invalid",
        "A new computer agent must start at generation 1.",
      );
    }
    await ctx.db.insert("cloud_agent_threads", {
      threadId,
      ownerId,
      ownerGeneration,
      conversationId,
      originDeviceId,
      originConversationId: conversationId,
      // Deliberately unacknowledged. The local SQLite outbox publishes the
      // terminal row, and the originating device ACKs only after the exact
      // generation/revision has reached its durable orchestrator transcript.
      description,
      placement: "computer",
      agentType,
      attemptGeneration,
      sandboxLeaseExpiresAt: cloudAgentSandboxLeaseExpiresAt("computer", now),
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    return { agentId: threadId };
  },
});

export const completeMyComputerAgentThread = mutation({
  args: {
    threadId: v.string(),
    ownerGeneration: v.string(),
    originDeviceId: v.string(),
    attemptGeneration: v.number(),
    status: terminalStatusValidator,
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.object({ updated: v.boolean(), status: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const ownerGeneration = normalizeRequiredString(
      args.ownerGeneration,
      "ownerGeneration",
      MAX_THREAD_ID_CHARS,
    );
    await assertOwnerDataWriteAllowed(ctx, ownerId, ownerGeneration);
    const threadId = normalizeRequiredString(
      args.threadId,
      "threadId",
      MAX_THREAD_ID_CHARS,
    );
    const originDeviceId = normalizeRequiredString(
      args.originDeviceId,
      "originDeviceId",
      MAX_DEVICE_ID_CHARS,
    );
    const attemptGeneration = normalizeAttemptGeneration(
      args.attemptGeneration,
    );
    if ((args.result?.length ?? 0) > MAX_RESULT_CHARS) {
      throw new ConvexError(`result exceeds ${MAX_RESULT_CHARS} characters.`);
    }
    if ((args.error?.length ?? 0) > MAX_ERROR_CHARS) {
      throw new ConvexError(`error exceeds ${MAX_ERROR_CHARS} characters.`);
    }
    const thread = await requireOwnedComputerThread(ctx, {
      ownerId,
      ownerGeneration,
      threadId,
      originDeviceId,
    });
    if (
      !shouldApplyComputerAgentTerminal({
        currentAttemptGeneration: thread.attemptGeneration,
        requestedAttemptGeneration: attemptGeneration,
        currentStatus: thread.status,
      })
    ) {
      return { updated: false, status: thread.status };
    }
    await ctx.db.patch(thread._id, {
      status: args.status,
      resultJson:
        args.status === "completed" && args.result
          ? JSON.stringify({ finalText: args.result })
          : undefined,
      errorMessage:
        args.status === "completed"
          ? undefined
          : args.error?.trim() || undefined,
      updatedAt: Date.now(),
    });
    return { updated: true, status: args.status };
  },
});

export const getMyComputerAgentThread = query({
  args: {
    threadId: v.string(),
    ownerGeneration: v.string(),
    originDeviceId: v.string(),
  },
  returns: v.union(v.null(), computerAgentSnapshotValidator),
  handler: async (ctx, args): Promise<ComputerAgentSnapshot | null> => {
    const ownerId = await requireUserId(ctx);
    const ownerGeneration = args.ownerGeneration.trim();
    if (!ownerGeneration || ownerGeneration.length > MAX_THREAD_ID_CHARS) {
      return null;
    }
    await assertOwnerDataWriteAllowed(ctx, ownerId, ownerGeneration);
    const threadId = args.threadId.trim();
    const originDeviceId = args.originDeviceId.trim();
    if (
      !threadId ||
      threadId.length > MAX_THREAD_ID_CHARS ||
      !originDeviceId ||
      originDeviceId.length > MAX_DEVICE_ID_CHARS
    ) {
      return null;
    }
    const thread = await ctx.db
      .query("cloud_agent_threads")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .unique();
    if (
      !thread ||
      thread.ownerId !== ownerId ||
      thread.ownerGeneration !== ownerGeneration ||
      thread.placement !== "computer" ||
      thread.originDeviceId !== originDeviceId
    ) {
      return null;
    }
    let result: string | null = null;
    if (thread.resultJson) {
      try {
        const parsed = JSON.parse(thread.resultJson) as {
          finalText?: unknown;
        };
        result =
          typeof parsed.finalText === "string"
            ? parsed.finalText
            : thread.resultJson;
      } catch {
        result = thread.resultJson;
      }
    }
    const status =
      thread.status === "failed"
        ? ("error" as const)
        : thread.status === "completed" ||
            thread.status === "canceled" ||
            thread.status === "running"
          ? thread.status
          : ("error" as const);
    return {
      id: thread.threadId,
      status,
      description: thread.description,
      startedAt: thread.createdAt,
      completedAt: status === "running" ? null : thread.updatedAt,
      result,
      error: thread.errorMessage ?? null,
    };
  },
});

export const cancelMyComputerAgentThread = mutation({
  args: {
    threadId: v.string(),
    ownerGeneration: v.string(),
    originDeviceId: v.string(),
    attemptGeneration: v.number(),
    reason: v.optional(v.string()),
  },
  returns: v.object({ canceled: v.boolean(), status: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const ownerGeneration = normalizeRequiredString(
      args.ownerGeneration,
      "ownerGeneration",
      MAX_THREAD_ID_CHARS,
    );
    await assertOwnerDataWriteAllowed(ctx, ownerId, ownerGeneration);
    const threadId = normalizeRequiredString(
      args.threadId,
      "threadId",
      MAX_THREAD_ID_CHARS,
    );
    const originDeviceId = normalizeRequiredString(
      args.originDeviceId,
      "originDeviceId",
      MAX_DEVICE_ID_CHARS,
    );
    const attemptGeneration = normalizeAttemptGeneration(
      args.attemptGeneration,
    );
    if ((args.reason?.length ?? 0) > MAX_ERROR_CHARS) {
      throw new ConvexError(`reason exceeds ${MAX_ERROR_CHARS} characters.`);
    }
    const thread = await requireOwnedComputerThread(ctx, {
      ownerId,
      ownerGeneration,
      threadId,
      originDeviceId,
    });
    if (
      (thread.attemptGeneration ?? 0) !== attemptGeneration
    ) {
      return { canceled: false, status: thread.status };
    }
    if (thread.status !== "running") {
      return { canceled: true, status: thread.status };
    }
    await ctx.db.patch(thread._id, {
      status: "canceled",
      resultJson: undefined,
      errorMessage: args.reason?.trim() || "Canceled on this computer.",
      updatedAt: Date.now(),
    });
    return { canceled: true, status: "canceled" };
  },
});
