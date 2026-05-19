import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { requireSensitiveUserIdAction } from "./auth";
import { enforceActionRateLimit, RATE_STANDARD } from "./lib/rate_limits";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_BATCH_SIZE = 100;
const MAX_TOKEN_LENGTH = 256;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_PLATFORM_LENGTH = 32;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 400;
const MAX_TOKENS_PER_OWNER = 25;

/**
 * Stable shape for the structured `data` payload tapped on a notification —
 * mobile uses it to route the user into the right place when they tap.
 */
const pushDataValidator = v.object({
  kind: v.union(v.literal("computer_reply"), v.literal("agent_activity")),
});

const activityNotificationKindValidator = v.union(
  v.literal("started"),
  v.literal("completed"),
  v.literal("failed"),
);

const activityNotificationCopy = (kind: ActivityNotificationKind) => {
  switch (kind) {
    case "started":
      return {
        title: "Stella is working",
        body: "Stella started on your desktop.",
      };
    case "completed":
      return {
        title: "Stella finished",
        body: "Stella finished on your desktop.",
      };
    case "failed":
      return {
        title: "Stella needs attention",
        body: "Stella could not finish on your desktop.",
      };
  }
};

type ActivityNotificationKind =
  | "started"
  | "completed"
  | "failed";

export const sendActivityNotification = action({
  args: {
    kind: activityNotificationKindValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "mobile_activity_push",
      ownerId,
      RATE_STANDARD,
      "Slow down a moment and try again.",
    );

    const copy = activityNotificationCopy(args.kind);
    await ctx.runAction(internal.mobile_push.sendToOwner, {
      ownerId,
      title: copy.title,
      body: copy.body,
      data: { kind: "agent_activity" },
    });
    return null;
  },
});

export const upsertToken = internalMutation({
  args: {
    ownerId: v.string(),
    mobileDeviceId: v.string(),
    expoPushToken: v.string(),
    platform: v.optional(v.string()),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const expoPushToken = args.expoPushToken.trim().slice(0, MAX_TOKEN_LENGTH);
    const mobileDeviceId = args.mobileDeviceId
      .trim()
      .slice(0, MAX_DEVICE_ID_LENGTH);
    if (!expoPushToken || !mobileDeviceId) {
      return null;
    }
    const platform = args.platform?.trim().slice(0, MAX_PLATFORM_LENGTH);

    // Reclaim a row that holds this exact token under a different owner —
    // happens when a user signs out of one account and into another on the
    // same phone.
    const tokenHolders = await ctx.db
      .query("mobile_push_tokens")
      .withIndex("by_expoPushToken", (q) =>
        q.eq("expoPushToken", expoPushToken),
      )
      .take(8);
    for (const holder of tokenHolders) {
      if (holder.ownerId !== args.ownerId) {
        await ctx.db.delete(holder._id);
      }
    }

    const existing = await ctx.db
      .query("mobile_push_tokens")
      .withIndex("by_ownerId_and_mobileDeviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("mobileDeviceId", mobileDeviceId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        expoPushToken,
        ...(platform ? { platform } : {}),
        updatedAt: args.nowMs,
      });
      return null;
    }

    await ctx.db.insert("mobile_push_tokens", {
      ownerId: args.ownerId,
      mobileDeviceId,
      expoPushToken,
      ...(platform ? { platform } : {}),
      updatedAt: args.nowMs,
    });
    return null;
  },
});

export const deleteToken = internalMutation({
  args: {
    expoPushToken: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const tokenHolders = await ctx.db
      .query("mobile_push_tokens")
      .withIndex("by_expoPushToken", (q) =>
        q.eq("expoPushToken", args.expoPushToken),
      )
      .take(8);
    for (const holder of tokenHolders) {
      await ctx.db.delete(holder._id);
    }
    return null;
  },
});

export const listTokensForOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  returns: v.array(
    v.object({
      expoPushToken: v.string(),
      mobileDeviceId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("mobile_push_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(MAX_TOKENS_PER_OWNER);
    return rows.map((row) => ({
      expoPushToken: row.expoPushToken,
      mobileDeviceId: row.mobileDeviceId,
    }));
  },
});

type ExpoPushTicket =
  | { status: "ok"; id?: string }
  | {
      status: "error";
      message?: string;
      details?: { error?: string };
    };

type ExpoPushResponse = {
  data?: ExpoPushTicket | ExpoPushTicket[];
};

export const sendToOwner = internalAction({
  args: {
    ownerId: v.string(),
    title: v.string(),
    body: v.string(),
    data: pushDataValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const title = args.title.slice(0, MAX_TITLE_LENGTH);
    const body = args.body.slice(0, MAX_BODY_LENGTH);

    const tokens = await ctx.runQuery(
      internal.mobile_push.listTokensForOwner,
      { ownerId: args.ownerId },
    );
    if (tokens.length === 0) {
      return null;
    }

    for (let i = 0; i < tokens.length; i += EXPO_PUSH_BATCH_SIZE) {
      const batch = tokens.slice(i, i + EXPO_PUSH_BATCH_SIZE);
      // Group together pushes of the same kind so iOS coalesces them in
      // the Lock Screen / Notification Center, and Android stacks them on
      // a single channel. `categoryId` opts the iOS notification into
      // the interactive actions registered on the mobile client.
      const threadId = args.data.kind;
      const messages: Record<string, unknown>[] = batch.map((entry) => ({
        to: entry.expoPushToken,
        title,
        body,
        sound: "default",
        data: args.data,
        categoryId: threadId,
        threadId,
        collapseId: threadId,
      }));

      let response: Response;
      try {
        response = await fetch(EXPO_PUSH_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
          },
          body: JSON.stringify(messages),
        });
      } catch (error) {
        console.warn(
          "[mobile_push] Expo push request failed:",
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }

      if (!response.ok) {
        console.warn(
          `[mobile_push] Expo push returned ${response.status}:`,
          await response.text().catch(() => "<unreadable>"),
        );
        continue;
      }

      let parsed: ExpoPushResponse | null = null;
      try {
        parsed = (await response.json()) as ExpoPushResponse;
      } catch {
        // Expo returned non-JSON; nothing actionable.
        continue;
      }

      const tickets: ExpoPushTicket[] = Array.isArray(parsed?.data)
        ? parsed.data
        : parsed?.data
          ? [parsed.data]
          : [];

      for (let j = 0; j < tickets.length; j += 1) {
        const ticket = tickets[j];
        const entry = batch[j];
        if (!ticket || !entry) continue;
        if (
          ticket.status === "error" &&
          (ticket.details?.error === "DeviceNotRegistered" ||
            ticket.details?.error === "InvalidCredentials")
        ) {
          await ctx.runMutation(internal.mobile_push.deleteToken, {
            expoPushToken: entry.expoPushToken,
          });
        }
      }
    }

    return null;
  },
});
