import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const MAX_THREADS_PER_CONVERSATION = 16;
/**
 * Upper bound for thread_messages reads (compaction / load).
 *
 * Keep this comfortably below Convex's 8192 array-return limit so a runaway
 * thread can't blow the response-size cap. Callers receive `truncated: true`
 * when this limit is hit, which signals them to compact and retry rather than
 * relying on a complete view.
 */
const MAX_THREAD_MESSAGES_PER_QUERY = 4_000;
const MAX_CONTENT_LENGTH = 500_000;
const THREAD_SWEEP_BATCH_SIZE = 200;

export const THREAD_IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const THREAD_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const loadConversationForOwner = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
  ownerId: string,
) => {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    return null;
  }
  return conversation;
};

const loadThreadForOwner = async (
  ctx: QueryCtx | MutationCtx,
  threadId: Id<"threads">,
  ownerId: string,
) => {
  const thread = await ctx.db.get(threadId);
  if (!thread) {
    return null;
  }
  const conversation = await loadConversationForOwner(ctx, thread.conversationId, ownerId);
  if (!conversation) {
    return null;
  }
  return thread;
};

type ThreadLifecycleStatus = "active" | "idle" | "archived";

const normalizeLifecycleStatus = (status: string): ThreadLifecycleStatus =>
  status === "idle" || status === "archived" ? status : "active";

const threadStatusRank = (status: string): number => {
  switch (normalizeLifecycleStatus(status)) {
    case "active":
      return 0;
    case "idle":
      return 1;
    case "archived":
      return 2;
  }
};

export const deriveThreadLifecycleStatus = (args: {
  status: string;
  lastUsedAt: number;
  now: number;
  idleAfterMs?: number;
  archiveAfterMs?: number;
}): ThreadLifecycleStatus => {
  const idleAfterMs = args.idleAfterMs ?? THREAD_IDLE_AFTER_MS;
  const archiveAfterMs = args.archiveAfterMs ?? THREAD_ARCHIVE_AFTER_MS;
  const current = normalizeLifecycleStatus(args.status);

  if (current === "archived") {
    return "archived";
  }
  if (args.now - args.lastUsedAt >= archiveAfterMs) {
    return "archived";
  }
  if (args.now - args.lastUsedAt >= idleAfterMs) {
    return "idle";
  }
  return "active";
};

// ---------------------------------------------------------------------------
// Truncate large content to prevent DB bloat
// ---------------------------------------------------------------------------

const truncateContent = (raw: string): string => {
  if (raw.length > MAX_CONTENT_LENGTH) {
    return raw.slice(0, MAX_CONTENT_LENGTH) + '"...[truncated]"';
  }
  return raw;
};

const activeThreadStatePatch = (thread: { status: string }, now: number) => ({
  lastUsedAt: now,
  ...(thread.status !== "active"
    ? {
        status: "active" as const,
        resurfacedAt: now,
      }
    : {}),
});

// ---------------------------------------------------------------------------
// createThread
// ---------------------------------------------------------------------------

export const createThread = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await loadConversationForOwner(
      ctx,
      args.conversationId,
      args.ownerId,
    );
    if (!conversation) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }

    // Check active thread count and evict if at limit. We bound the read at
    // `MAX_THREADS_PER_CONVERSATION + 1` because that's all we need to detect
    // the over-limit condition.
    const activeThreads = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_status_and_lastUsedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .take(MAX_THREADS_PER_CONVERSATION + 1);

    let evictedThreadName: string | null = null;
    if (activeThreads.length >= MAX_THREADS_PER_CONVERSATION) {
      // Evict the oldest (least recently used)
      const sorted = activeThreads.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const oldest = sorted[0];
      if (oldest) {
        evictedThreadName = oldest.name;
        await ctx.db.patch(oldest._id, {
          status: "archived",
          closedAt: Date.now(),
        });
      }
    }

    const now = Date.now();
    const threadId = await ctx.db.insert("threads", {
      conversationId: args.conversationId,
      name: args.name,
      status: "active",
      messageCount: 0,
      totalTokenEstimate: 0,
      createdAt: now,
      lastUsedAt: now,
    });

    return { threadId, evictedThreadName };
  },
});

// ---------------------------------------------------------------------------
// getThreadByName
// ---------------------------------------------------------------------------



export const getThreadByName = internalQuery({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await loadConversationForOwner(
      ctx,
      args.conversationId,
      args.ownerId,
    );
    if (!conversation) {
      return null;
    }

    // Cap on duplicate-name matches we'll consider. Names are scoped to a
    // conversation and rarely duplicated; a tight bound keeps this O(1) even
    // if a user accidentally creates many same-named threads.
    const MAX_DUPLICATE_THREAD_NAMES = 32;
    const matches = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_name", (q) =>
        q.eq("conversationId", args.conversationId).eq("name", args.name),
      )
      .take(MAX_DUPLICATE_THREAD_NAMES);

    if (matches.length === 0) {
      return null;
    }

    matches.sort(
      (a, b) =>
        threadStatusRank(a.status) - threadStatusRank(b.status) ||
        b.lastUsedAt - a.lastUsedAt ||
        String(a._id).localeCompare(String(b._id)),
    );

    return matches[0];
  },
});

// ---------------------------------------------------------------------------
// getThreadById
// ---------------------------------------------------------------------------

export const getThreadById = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.threadId);
  },
});

// ---------------------------------------------------------------------------
// listActiveThreads
// ---------------------------------------------------------------------------

export const listActiveThreads = internalQuery({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await loadConversationForOwner(
      ctx,
      args.conversationId,
      args.ownerId,
    );
    if (!conversation) {
      return [];
    }

    const threads = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_status_and_lastUsedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .order("desc")
      .take(MAX_THREADS_PER_CONVERSATION);

    return threads;
  },
});

// ---------------------------------------------------------------------------
// touchThread
// ---------------------------------------------------------------------------

export const touchThread = internalMutation({
  args: {
    ownerId: v.string(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) return null;

    await ctx.db.patch(args.threadId, activeThreadStatePatch(thread, now));
    return null;
  },
});

export const activateThread = internalMutation({
  args: {
    ownerId: v.string(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(args.threadId, activeThreadStatePatch(thread, now));

    return await ctx.db.get(args.threadId);
  },
});

// ---------------------------------------------------------------------------
// closeThread
// ---------------------------------------------------------------------------

export const closeThread = internalMutation({
  args: {
    ownerId: v.string(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) return null;
    const now = Date.now();
    await ctx.db.patch(args.threadId, {
      status: "archived",
      closedAt: now,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// loadThreadMessages
// ---------------------------------------------------------------------------

export const loadThreadMessages = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) =>
        q.eq("threadId", args.threadId),
      )
      .take(MAX_THREAD_MESSAGES_PER_QUERY);
  },
});

// ---------------------------------------------------------------------------
// saveThreadMessages
// ---------------------------------------------------------------------------

export const saveThreadMessages = internalMutation({
  args: {
    ownerId: v.string(),
    threadId: v.id("threads"),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        toolCallId: v.optional(v.string()),
        tokenEstimate: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.messages.length === 0) return null;

    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) return null;

    // Get the current max ordinal
    const lastMessage = await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) =>
        q.eq("threadId", args.threadId),
      )
      .order("desc")
      .first();

    const baseOrdinal = (lastMessage?.ordinal ?? -1) + 1;
    const now = Date.now();

    // Pre-compute everything synchronously, then issue inserts in parallel.
    // Each `await ctx.db.insert` round-trip is independent — running them
    // serially blocked the mutation on N sequential RTTs for large batches.
    const prepared = args.messages.map((msg, index) => {
      const safeContent = truncateContent(msg.content);
      const estimate = msg.tokenEstimate ?? Math.ceil(safeContent.length / 4);
      return {
        record: {
          threadId: args.threadId,
          ordinal: baseOrdinal + index,
          role: msg.role,
          content: safeContent,
          toolCallId: msg.toolCallId,
          tokenEstimate: estimate,
          createdAt: now,
        },
        tokenEstimate: estimate,
      };
    });
    const addedTokens = prepared.reduce((sum, p) => sum + p.tokenEstimate, 0);
    await Promise.all(
      prepared.map(({ record }) => ctx.db.insert("thread_messages", record)),
    );

    // Update thread counters
    await ctx.db.patch(args.threadId, {
      messageCount: thread.messageCount + args.messages.length,
      totalTokenEstimate: thread.totalTokenEstimate + addedTokens,
      ...activeThreadStatePatch(thread, now),
    });

    return null;
  },
});

// ---------------------------------------------------------------------------
// deleteMessagesBefore
// ---------------------------------------------------------------------------

/** Maximum messages to delete in a single transaction batch. */
const DELETE_MESSAGES_BATCH_SIZE = 500;

export const deleteMessagesBefore = internalMutation({
  args: {
    ownerId: v.string(),
    threadId: v.id("threads"),
    beforeOrdinal: v.number(),
  },
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) return { deleted: 0, hasMore: false };

    // Bounded batch so a long thread doesn't blow the mutation transaction
    // limit. Callers should re-invoke until `hasMore` is false.
    const messages = await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) =>
        q.eq("threadId", args.threadId).lt("ordinal", args.beforeOrdinal),
      )
      .take(DELETE_MESSAGES_BATCH_SIZE);

    await Promise.all(messages.map((msg) => ctx.db.delete(msg._id)));
    return {
      deleted: messages.length,
      hasMore: messages.length === DELETE_MESSAGES_BATCH_SIZE,
    };
  },
});

export const finalizeThreadCompaction = internalMutation({
  args: {
    threadId: v.id("threads"),
    keepFromOrdinal: v.number(),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.status !== "active") {
      return null;
    }

    // Read only the rows we'll keep — using the ordinal range filter rather
    // than reading every message and JS-filtering keeps us inside the array
    // return limit even for very long threads.
    const retained = await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) =>
        q.eq("threadId", args.threadId).gte("ordinal", args.keepFromOrdinal),
      )
      .take(MAX_THREAD_MESSAGES_PER_QUERY);
    const dropped = await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) =>
        q.eq("threadId", args.threadId).lt("ordinal", args.keepFromOrdinal),
      )
      .take(MAX_THREAD_MESSAGES_PER_QUERY);
    await Promise.all(dropped.map((msg) => ctx.db.delete(msg._id)));

    const remainingTokens = retained.reduce(
      (sum, msg) => sum + (msg.tokenEstimate ?? 0),
      0,
    );
    const remainingCount = retained.length;

    if (thread.name !== "Main") {
      await ctx.db.patch(args.threadId, {
        summary: args.summary,
        messageCount: remainingCount,
        totalTokenEstimate: remainingTokens,
        lastUsedAt: now,
      });
      return null;
    }

    const conversation = await ctx.db.get(thread.conversationId);
    if (!conversation || conversation.activeThreadId !== args.threadId) {
      await ctx.db.patch(args.threadId, {
        summary: args.summary,
        messageCount: remainingCount,
        totalTokenEstimate: remainingTokens,
        lastUsedAt: now,
      });
      return null;
    }

    const rolloverThreadId = await ctx.db.insert("threads", {
      conversationId: thread.conversationId,
      name: "Main",
      status: "active",
      summary: args.summary,
      messageCount: remainingCount,
      totalTokenEstimate: remainingTokens,
      createdAt: now,
      lastUsedAt: now,
    });

    let nextOrdinal = 0;
    const promises = [];
    for (const msg of retained) {
      promises.push(
        ctx.db.insert("thread_messages", {
          threadId: rolloverThreadId,
          ordinal: nextOrdinal,
          role: msg.role,
          content: msg.content,
          ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
          ...(typeof msg.tokenEstimate === "number"
            ? { tokenEstimate: msg.tokenEstimate }
            : {}),
          createdAt: msg.createdAt,
        })
      );
      promises.push(ctx.db.delete(msg._id));
      nextOrdinal += 1;
    }
    await Promise.all(promises);

    await ctx.db.patch(args.threadId, {
      summary: args.summary,
      messageCount: 0,
      totalTokenEstimate: 0,
      status: "archived",
      closedAt: now,
      lastUsedAt: now,
    });

    await ctx.db.patch(thread.conversationId, {
      activeThreadId: rolloverThreadId,
      updatedAt: now,
    });

    return null;
  },
});

export const sweepThreadLifecycle = internalMutation({
  args: {
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const idleCutoff = now - THREAD_IDLE_AFTER_MS;
    const archiveCutoff = now - THREAD_ARCHIVE_AFTER_MS;

    const activeCandidates = await ctx.db
      .query("threads")
      .withIndex("by_status_and_lastUsedAt", (q) =>
        q.eq("status", "active").lt("lastUsedAt", idleCutoff),
      )
      .take(THREAD_SWEEP_BATCH_SIZE);

    let idled = 0;
    const activePromises = [];
    for (const thread of activeCandidates) {
      const nextStatus = deriveThreadLifecycleStatus({
        status: thread.status,
        lastUsedAt: thread.lastUsedAt,
        now,
      });
      if (nextStatus === "idle") {
        activePromises.push(ctx.db.patch(thread._id, { status: "idle" }));
        idled += 1;
      } else if (nextStatus === "archived") {
        activePromises.push(ctx.db.patch(thread._id, {
          status: "archived",
          closedAt: now,
        }));
      }
    }
    await Promise.all(activePromises);

    const idleCandidates = await ctx.db
      .query("threads")
      .withIndex("by_status_and_lastUsedAt", (q) =>
        q.eq("status", "idle").lt("lastUsedAt", archiveCutoff),
      )
      .take(THREAD_SWEEP_BATCH_SIZE);

    let archived = 0;
    const idlePromises = [];
    for (const thread of idleCandidates) {
      const nextStatus = deriveThreadLifecycleStatus({
        status: thread.status,
        lastUsedAt: thread.lastUsedAt,
        now,
      });
      if (nextStatus === "archived") {
        idlePromises.push(ctx.db.patch(thread._id, {
          status: "archived",
          closedAt: now,
        }));
        archived += 1;
      }
    }
    await Promise.all(idlePromises);

    return { idled, archived };
  },
});
