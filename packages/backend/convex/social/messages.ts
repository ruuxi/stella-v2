import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  socialMessageValidator,
  requireRoomMembership,
  refreshRoomUpdatedAt,
} from "./shared";
import { requireBoundedString } from "../shared_validators";
import {
  assertOwnerMigrationWriteAllowed,
  getConnectedUserIdOrNull,
  requireConnectedUserId,
} from "../auth";
import { enforceMutationRateLimit, RATE_STANDARD } from "../lib/rate_limits";
import { assistantText, completeManagedChat } from "../runtime_ai/managed";
import { createManagedUsageDispatchGuard } from "../lib/managed_billing";
import { getModeConfig } from "../agent/model";
import { maskBannedTerms } from "./censor";
import {
  parseModerationResponse,
  TEXT_MODERATION_SYSTEM_PROMPT,
} from "../lib/text_moderation";
import { assertC8RetiredSurfaceUnavailable } from "../lib/c8_retired_surface";

const GLOBAL_CHAT_DISABLED_ERROR = "Global Chat is disabled.";

/**
 * Social text moderation is narrow, unbilled safety/control-plane overhead:
 * it protects a shared surface and is not a user-requested model capability.
 * Every physical try still uses the durable managed-provider attempt lease so
 * owner reset/migration cancellation and quiescence remain fail-closed. The
 * message row durably audits the terminal clean/censored/failed disposition.
 */
export const SOCIAL_MESSAGE_MODERATION_POLICY = {
  billing: "unbilled",
  purpose: "safety_control_plane",
  maxInputChars: 20_000,
  rateLimitKey: "social_send_room_message",
  auditOutcomes: ["clean", "censored", "failed"],
} as const;

// Per-page ceiling. The desktop hook requests 50/page by default; this
// is a safety cap for misbehaving clients, not the steady-state size.
// Kept close to the requested page size so a single round-trip never
// pulls more than ~2x the normal slice.
const MAX_MESSAGES_PER_PAGE = 100;

const paginatedRoomMessagesValidator = v.object({
  page: v.array(socialMessageValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(
      v.literal("SplitRecommended"),
      v.literal("SplitRequired"),
      v.null(),
    ),
  ),
});

const emptyMessagesPage = (): {
  page: never[];
  isDone: true;
  continueCursor: "";
} => ({ page: [], isDone: true, continueCursor: "" });

export const listRoomMessages = query({
  args: {
    roomId: v.id("social_rooms"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedRoomMessagesValidator,
  handler: async (ctx, args) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return emptyMessagesPage();
    }
    await requireRoomMembership(ctx, args.roomId, ownerId);
    const room = await ctx.db.get(args.roomId);
    if (room?.kind === "global") {
      return emptyMessagesPage();
    }
    // Cap requested page size so a misbehaving client can't pull a whole
    // room into one round-trip. The desktop hook ships 50/page; this is a
    // safety ceiling, not the steady-state size.
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      MAX_MESSAGES_PER_PAGE,
    );
    // Order desc so each page is the next-older slice. The renderer
    // re-sorts to oldest-first for display.
    return await ctx.db
      .query("social_messages")
      .withIndex("by_roomId_and_createdAt", (q) => q.eq("roomId", args.roomId))
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems,
      });
  },
});

export const getMessageForModerationInternal = internalQuery({
  args: {
    messageId: v.id("social_messages"),
  },
  returns: v.union(v.null(), socialMessageValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.messageId);
  },
});

export const applyMessageModerationInternal = internalMutation({
  args: {
    messageId: v.id("social_messages"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    originalBody: v.string(),
    moderatedBody: v.optional(v.string()),
    status: v.union(
      v.literal("clean"),
      v.literal("censored"),
      v.literal("failed"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Social messages");
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const message = await ctx.db.get(args.messageId);
    if (!message || message.kind !== "text") {
      return null;
    }
    if (message.moderationStatus !== "pending") {
      return null;
    }
    if (
      message.senderOwnerId !== args.ownerId ||
      (message.senderOwnerGeneration ?? "legacy") !== args.ownerGeneration
    ) {
      return null;
    }
    if (message.body !== args.originalBody) {
      return null;
    }

    const now = Date.now();
    if (args.status === "censored" && args.moderatedBody) {
      await ctx.db.patch(args.messageId, {
        body: args.moderatedBody,
        originalBody: args.originalBody,
        moderationStatus: "censored",
        moderatedAt: now,
      });
      return null;
    }

    await ctx.db.patch(args.messageId, {
      moderationStatus: args.status,
      moderatedAt: now,
    });
    return null;
  },
});

export const assertMessageModerationDispatchInternal = internalMutation({
  args: {
    messageId: v.id("social_messages"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Social messages");
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const message = await ctx.db.get(args.messageId);
    return Boolean(
      message &&
      message.kind === "text" &&
      message.moderationStatus === "pending" &&
      message.senderOwnerId === args.ownerId &&
      (message.senderOwnerGeneration ?? "legacy") === args.ownerGeneration,
    );
  },
});

export const moderateRoomMessageInternal = internalAction({
  args: {
    messageId: v.id("social_messages"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Social messages");
    const message = await ctx.runQuery(
      internal.social.messages.getMessageForModerationInternal,
      { messageId: args.messageId },
    );
    if (
      !message ||
      message.kind !== "text" ||
      message.moderationStatus !== "pending"
    ) {
      return null;
    }

    const assertDispatch = async () => {
      const allowed = await ctx.runMutation(
        internal.social.messages.assertMessageModerationDispatchInternal,
        {
          messageId: args.messageId,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
        },
      );
      if (!allowed) {
        throw new Error("Message moderation dispatch is no longer current.");
      }
    };

    try {
      await assertDispatch();
      const result = await completeManagedChat({
        config: getModeConfig("light"),
        fallbackConfig: {
          ...getModeConfig("standard"),
          temperature: 0.7,
          maxOutputTokens: 512,
        },
        context: {
          systemPrompt: TEXT_MODERATION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: message.body,
              timestamp: Date.now(),
            },
          ],
        },
        dispatchGuard: createManagedUsageDispatchGuard(ctx, {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          beforeDispatch: assertDispatch,
        }),
      });
      const parsed = parseModerationResponse(assistantText(result));
      if (parsed === "failed") {
        throw new Error("Moderation model returned an invalid decision");
      }
      await ctx.runMutation(
        internal.social.messages.applyMessageModerationInternal,
        {
          messageId: args.messageId,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          originalBody: message.body,
          moderatedBody:
            parsed === "censored" ? maskBannedTerms(message.body) : undefined,
          status: parsed,
        },
      );
    } catch (error) {
      console.warn("[social-moderation] Failed to moderate message", error);
      await ctx.runMutation(
        internal.social.messages.applyMessageModerationInternal,
        {
          messageId: args.messageId,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          originalBody: message.body,
          status: "failed",
        },
      );
    }
    return null;
  },
});

export const sendRoomMessage = mutation({
  args: {
    roomId: v.id("social_rooms"),
    body: v.string(),
    clientMessageId: v.optional(v.string()),
  },
  returns: socialMessageValidator,
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Social messages");
    const ownerId = await requireConnectedUserId(ctx);
    const { generation: ownerGeneration } =
      await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    // Standard chat rate: enough for normal typing, low enough that a
    // misbehaving client can't firehose a shared room.
    await enforceMutationRateLimit(
      ctx,
      SOCIAL_MESSAGE_MODERATION_POLICY.rateLimitKey,
      ownerId,
      RATE_STANDARD,
      "You're sending messages too fast. Please slow down.",
    );
    const membership = await requireRoomMembership(ctx, args.roomId, ownerId);
    const room = await ctx.db.get(args.roomId);
    if (room?.kind === "global") {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: GLOBAL_CHAT_DISABLED_ERROR,
      });
    }

    const body = args.body.trim();
    if (!body) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Message body is required",
      });
    }
    requireBoundedString(
      body,
      "body",
      SOCIAL_MESSAGE_MODERATION_POLICY.maxInputChars,
    );

    const clientMessageId = args.clientMessageId?.trim() || undefined;
    if (clientMessageId) {
      requireBoundedString(clientMessageId, "clientMessageId", 128);
      const existing = await ctx.db
        .query("social_messages")
        .withIndex("by_roomId_and_clientMessageId", (q) =>
          q.eq("roomId", args.roomId).eq("clientMessageId", clientMessageId),
        )
        .unique();
      if (existing) {
        return existing;
      }
    }

    const now = Date.now();
    const id = await ctx.db.insert("social_messages", {
      roomId: args.roomId,
      senderOwnerId: ownerId,
      senderOwnerGeneration: ownerGeneration,
      clientMessageId,
      kind: "text",
      body,
      moderationStatus: "pending",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.social.messages.moderateRoomMessageInternal,
      {
        messageId: id,
        ownerId,
        ownerGeneration,
      },
    );
    await ctx.db.patch(membership._id, {
      lastReadMessageId: id,
      lastReadAt: now,
      updatedAt: now,
    });
    await refreshRoomUpdatedAt(ctx, args.roomId, now);
    const created = await ctx.db.get(id);
    if (!created) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to create message",
      });
    }
    return created;
  },
});
