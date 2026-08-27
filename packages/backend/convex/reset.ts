import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type Infer, v } from "convex/values";
import { requireUserId } from "./auth";
import { enforceActionRateLimit, RATE_SENSITIVE } from "./lib/rate_limits";

const BATCH = 200;

const CONVERSATION_PAGE = 200;

const OWNER_TABLES = [
  ["user_preferences", "by_ownerId_and_key"],
  ["devices", "by_ownerId"],
  ["device_presence", "by_ownerId"],
  ["cloudflare_tunnels", "by_ownerId"],
  ["auth_revoked_sessions", "by_ownerId_and_sessionId"],
  ["usage_logs", "by_ownerId_and_createdAt"],
  ["usage_rollups", "by_ownerId_and_bucketStartMs"],
  ["billing_usage_windows", "by_ownerId"],
  ["billing_profiles", "by_ownerId"],
  ["user_counters", "by_ownerId"],
  ["x_oauth_states", "by_ownerId_and_expiresAt"],
  ["x_oauth_tokens", "by_ownerId"],
  ["connector_turn_payloads", "by_ownerId_and_createdAt"],
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number][0];

export const resetAllUserData = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);

    await enforceActionRateLimit(
      ctx,
      "reset_all_user_data",
      ownerId,
      RATE_SENSITIVE,
      "Too many account reset attempts. Please wait a minute and try again.",
    );

    let cursor: string | null = null;
    while (true) {
      const page: { ids: Id<"conversations">[]; nextCursor: string | null } =
        await ctx.runQuery(internal.reset._listConversationIdsPage, {
          ownerId,
          cursor,
        });

      for (const conversationId of page.ids) {
        let hasMore = true;
        while (hasMore) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.reset._deleteConversationBatch,
            { conversationId },
          );
          hasMore = result.hasMore;
        }
      }

      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    await Promise.all([
      ...OWNER_TABLES.map(async ([table]) => {
        let hasMore = true;
        while (hasMore) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.reset._deleteOwnerTableBatch,
            { ownerId, table },
          );
          hasMore = result.hasMore;
        }
      }),
    ]);

    return null;
  },
});

export const _listConversationIdsPage = internalQuery({
  args: {
    ownerId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    ids: v.array(v.id("conversations")),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { ownerId, cursor }) => {
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .paginate({ cursor, numItems: CONVERSATION_PAGE });
    return {
      ids: page.page.map((c) => c._id),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const _deleteConversationBatch = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, { conversationId }) => {

    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (events.length > 0) {
      await Promise.all(events.map((e) => ctx.db.delete(e._id)));
      return { hasMore: true };
    }

    const [thread] = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_lastUsedAt", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(1);
    if (thread) {
      const messages = await ctx.db
        .query("thread_messages")
        .withIndex("by_threadId_and_ordinal", (q) =>
          q.eq("threadId", thread._id),
        )
        .take(BATCH);
      if (messages.length > 0) {
        await Promise.all(messages.map((m) => ctx.db.delete(m._id)));
        return { hasMore: true };
      }

      await ctx.db.delete(thread._id);
      return { hasMore: true };
    }

    const turnPayloads = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (turnPayloads.length > 0) {
      await Promise.all(turnPayloads.map((row) => ctx.db.delete(row._id)));
      return { hasMore: true };
    }

    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (attachments.length > 0) {
      await Promise.all(
        attachments.map(async (row) => {
          await ctx.storage.delete(row.storageKey);
          await ctx.db.delete(row._id);
        }),
      );
      return { hasMore: true };
    }

    const pendingSelections = await ctx.db
      .query("pending_device_selections")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (pendingSelections.length > 0) {
      await Promise.all(pendingSelections.map((row) => ctx.db.delete(row._id)));

    }

    const conv = await ctx.db.get(conversationId);
    if (conv) {
      await ctx.db.delete(conversationId);
      const counter = await ctx.db
        .query("user_counters")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", conv.ownerId))
        .unique();
      if (counter) {
        const next = Math.max(0, (counter.conversationCount ?? 0) - 1);
        await ctx.db.patch(counter._id, {
          conversationCount: next,
          updatedAt: Date.now(),
        });
      }
    }
    return { hasMore: false };
  },
});

const ownerTableValidator = v.union(
  v.literal("user_preferences"),
  v.literal("devices"),
  v.literal("device_presence"),
  v.literal("cloudflare_tunnels"),
  v.literal("auth_revoked_sessions"),
  v.literal("usage_logs"),
  v.literal("usage_rollups"),
  v.literal("billing_usage_windows"),
  v.literal("billing_profiles"),
  v.literal("user_counters"),
  v.literal("x_oauth_states"),
  v.literal("x_oauth_tokens"),
  v.literal("connector_turn_payloads"),
);

type _OwnerTableMatchesValidator =
  OwnerTable extends Infer<typeof ownerTableValidator>
    ? Infer<typeof ownerTableValidator> extends OwnerTable
      ? true
      : never
    : never;
const _ownerTablesInSync: _OwnerTableMatchesValidator = true;
void _ownerTablesInSync;

export const _deleteOwnerTableBatch = internalMutation({
  args: {
    ownerId: v.string(),
    table: ownerTableValidator,
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, { ownerId, table }) => {
    const deleted = await deleteOneOwnerTableBatch(ctx, ownerId, table);
    return { hasMore: deleted === BATCH };
  },
});

async function deleteOneOwnerTableBatch(
  ctx: MutationCtx,
  ownerId: string,
  table: OwnerTable,
): Promise<number> {
  let ids: Id<OwnerTable>[] = [];
  switch (table) {
    case "user_preferences": {
      const rows = await ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "devices": {
      const rows = await ctx.db
        .query("devices")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "device_presence": {
      const rows = await ctx.db
        .query("device_presence")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "cloudflare_tunnels": {
      const rows = await ctx.db
        .query("cloudflare_tunnels")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "auth_revoked_sessions": {
      const rows = await ctx.db
        .query("auth_revoked_sessions")
        .withIndex("by_ownerId_and_sessionId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "usage_logs": {
      const rows = await ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "usage_rollups": {
      const rows = await ctx.db
        .query("usage_rollups")
        .withIndex("by_ownerId_and_bucketStartMs", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "billing_usage_windows": {
      const rows = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "billing_profiles": {
      const rows = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "user_counters": {
      const rows = await ctx.db
        .query("user_counters")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "x_oauth_states": {
      const rows = await ctx.db
        .query("x_oauth_states")
        .withIndex("by_ownerId_and_expiresAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "x_oauth_tokens": {
      const rows = await ctx.db
        .query("x_oauth_tokens")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "connector_turn_payloads": {
      const rows = await ctx.db
        .query("connector_turn_payloads")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length;
}
