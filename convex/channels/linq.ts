import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v, ConvexError } from "convex/values";
import { handleConnectorIncomingMessage } from "./message_pipeline";
import { formatLinkCodeResultMessage, processLinkCode } from "./link_codes";
import { SIGN_IN_REQUIRED_ERROR } from "./routing_flow";
import { retryFetch } from "../lib/retry_fetch";
import { enforceActionRateLimit, RATE_VERY_EXPENSIVE } from "../lib/rate_limits";
import { hashLinqPhone } from "./linq_phone_hash";
import {
  channelAttachmentValidator,
  jsonValueValidator,
  optionalChannelEnvelopeValidator,
} from "../shared_validators";

// ---------------------------------------------------------------------------
// Linq API Helpers
// ---------------------------------------------------------------------------

const LINQ_API_BASE = "https://api.linqapp.com/api/partner";
const PRIMARY_LINQ_CONVEX_URL = "https://benevolent-minnow-586.convex.cloud";
const LINQ_NON_PRIMARY_OVERRIDE_ENV = "LINQ_ALLOW_NON_PRIMARY_DEPLOYMENT";
type LinkCodeResult = Awaited<ReturnType<typeof processLinkCode>>;

const linqFetch = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const token = process.env.LINQ_API_TOKEN;
  if (!token) throw new Error("Missing LINQ_API_TOKEN");

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");

  return retryFetch(`${LINQ_API_BASE}${path}`, {
    ...init,
    headers,
  });
};

export const isLinqLiveDeployment = (): boolean => {
  if (process.env[LINQ_NON_PRIMARY_OVERRIDE_ENV]?.trim() === "1") {
    return true;
  }
  return process.env.CONVEX_URL?.trim() === PRIMARY_LINQ_CONVEX_URL;
};

type LinqMessagePart =
  | {
      type: "text";
      value: string;
      text_decorations?: Array<Record<string, unknown>>;
    }
  | { type: "media"; url?: string; attachment_id?: string }
  | { type: "link"; value: string };

const linqCreateChat = async (
  from: string,
  to: string[],
  text: string,
  extraParts?: LinqMessagePart[],
): Promise<string> => {
  const parts: LinqMessagePart[] = [{ type: "text", value: text }];
  if (extraParts) parts.push(...extraParts);
  const res = await linqFetch("/v3/chats", {
    method: "POST",
    body: JSON.stringify({
      from,
      to,
      message: { parts },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Linq createChat failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const chat = data.chat as Record<string, unknown> | undefined;
  const chatId = chat?.id as string | undefined;
  if (!chatId) {
    console.error("[linq] createChat response has no chat ID:", JSON.stringify(data));
    throw new Error(`Linq createChat returned no chat ID: ${JSON.stringify(data)}`);
  }
  return chatId;
};

const linqSendMessage = async (
  chatId: string,
  text: string,
  extraParts?: LinqMessagePart[],
): Promise<void> => {
  const parts: LinqMessagePart[] = [{ type: "text", value: text }];
  if (extraParts) parts.push(...extraParts);
  const res = await linqFetch(`/v3/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      message: { parts },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linq sendMessage failed: ${res.status} ${body}`);
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const LINQ_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const readLinqMessageId = (value: unknown): string | undefined => {
  const stringValue = readString(value);
  return stringValue && LINQ_UUID_RE.test(stringValue)
    ? stringValue
    : undefined;
};

const requireString = (value: unknown, field: string): string => {
  const stringValue = readString(value);
  if (!stringValue) throw new ConvexError(`${field} is required.`);
  return stringValue;
};

const boundedString = (
  value: unknown,
  field: string,
  maxLength: number,
): string => {
  const stringValue = requireString(value, field);
  if (stringValue.length > maxLength) {
    throw new ConvexError(`${field} is too long.`);
  }
  return stringValue;
};

const LINQ_SCREEN_EFFECTS = new Set([
  "confetti",
  "fireworks",
  "lasers",
  "sparkles",
  "celebration",
  "hearts",
  "love",
  "balloons",
  "happy_birthday",
  "echo",
  "spotlight",
]);
const LINQ_BUBBLE_EFFECTS = new Set(["slam", "loud", "gentle", "invisible"]);
const LINQ_REACTION_TYPES = new Set([
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
  "custom",
]);

const parseTextDecorations = (
  value: unknown,
): Array<Record<string, unknown>> | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.slice(0, 20).map((entry) => {
    const record = asRecord(entry);
    const range = Array.isArray(record.range) ? record.range : [];
    const start = Number(range[0]);
    const end = Number(range[1]);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start
    ) {
      throw new ConvexError("text_decorations range must be [start, end].");
    }
    const style = readString(record.style);
    const animation = readString(record.animation);
    if ((style ? 1 : 0) + (animation ? 1 : 0) !== 1) {
      throw new ConvexError(
        "Each text decoration must include exactly one style or animation.",
      );
    }
    return {
      range: [Math.floor(start), Math.floor(end)],
      ...(style ? { style } : {}),
      ...(animation ? { animation } : {}),
    };
  });
};

const parseLinqMessageParts = (value: unknown): LinqMessagePart[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConvexError("parts must include at least one message part.");
  }
  if (value.length > 40) {
    throw new ConvexError("parts may include at most 40 items.");
  }
  const parts = value.map((entry): LinqMessagePart => {
    const record = asRecord(entry);
    const type = readString(record.type);
    if (type === "text") {
      const text = boundedString(record.value, "text part value", 10_000);
      const textDecorations = parseTextDecorations(record.text_decorations);
      return {
        type: "text",
        value: text,
        ...(textDecorations ? { text_decorations: textDecorations } : {}),
      };
    }
    if (type === "media") {
      const url = readString(record.url);
      const attachmentId = readString(record.attachment_id);
      if ((url ? 1 : 0) + (attachmentId ? 1 : 0) !== 1) {
        throw new ConvexError(
          "media parts require exactly one of url or attachment_id.",
        );
      }
      return {
        type: "media",
        ...(url ? { url } : {}),
        ...(attachmentId ? { attachment_id: attachmentId } : {}),
      };
    }
    if (type === "link") {
      return {
        type: "link",
        value: boundedString(record.value, "link part value", 2_048),
      };
    }
    throw new ConvexError("Unsupported Linq message part type.");
  });
  if (parts.some((part) => part.type === "link") && parts.length !== 1) {
    throw new ConvexError("A link part must be the only message part.");
  }
  return parts;
};

const parseLinqEffect = (
  value: unknown,
): { type: "screen" | "bubble"; name: string } | undefined => {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const type = readString(record.type);
  const name = readString(record.name);
  if (
    (type === "screen" && name && LINQ_SCREEN_EFFECTS.has(name)) ||
    (type === "bubble" && name && LINQ_BUBBLE_EFFECTS.has(name))
  ) {
    return { type, name };
  }
  throw new ConvexError("Invalid Linq message effect.");
};

const linqFetchJson = async (
  path: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const res = await linqFetch(path, init);
  const bodyText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Linq API request failed: ${res.status} ${bodyText}`);
  }
  if (!bodyText.trim()) return { success: true };
  try {
    return JSON.parse(bodyText);
  } catch {
    return { success: true, body: bodyText };
  }
};

// ---------------------------------------------------------------------------
// HMAC Signature Verification
// ---------------------------------------------------------------------------

export async function verifyLinqSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  secret: string,
): Promise<boolean> {
  if (!signature || !timestamp || !secret) return false;

  // Replay protection: reject timestamps older than 5 minutes
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const message = `${timestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Internal Queries / Mutations — Chat ID Cache
// ---------------------------------------------------------------------------

export const getCachedChatId = internalQuery({
  args: { phoneHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("linq_chats")
      .withIndex("by_phoneHash", (q) => q.eq("phoneHash", args.phoneHash))
      .unique();
    return row?.linqChatId ?? null;
  },
});

export const cacheChatId = internalMutation({
  args: {
    phoneHash: v.string(),
    linqChatId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("linq_chats")
      .withIndex("by_phoneHash", (q) => q.eq("phoneHash", args.phoneHash))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { linqChatId: args.linqChatId });
    } else {
      await ctx.db.insert("linq_chats", {
        phoneHash: args.phoneHash,
        linqChatId: args.linqChatId,
        createdAt: Date.now(),
      });
    }
    return null;
  },
});

export const getAuthorizedLinqRemoteTurnTarget = internalQuery({
  args: {
    ownerId: v.string(),
    requestId: v.string(),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.ownerId !== args.ownerId) {
      return null;
    }
    const request = await ctx.db
      .query("events")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .first();
    if (
      !request ||
      request.type !== "remote_turn_request" ||
      request.conversationId !== args.conversationId
    ) {
      return null;
    }
    const payload = asRecord(request.payload);
    if (payload.provider !== "linq") return null;
    const deliveryMeta = asRecord(payload.deliveryMeta);
    const incomingChatId = readString(deliveryMeta.incomingChatId);
    if (!incomingChatId) return null;
    const channelEnvelope = asRecord(request.channelEnvelope);
    const externalMessageId = readLinqMessageId(channelEnvelope.externalMessageId);
    return {
      incomingChatId,
      ...(externalMessageId ? { externalMessageId } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// Send Reply Helper (get-or-create chat + send)
// ---------------------------------------------------------------------------

/**
 * Sends a reply to a phone number via Linq.
 * If `incomingChatId` is provided, tries that first.
 * Falls back to creating a new chat if needed.
 *
 * `phoneNumber` is consumed live for the Linq API call (we have to pass
 * the actual number to send an SMS) but only its HMAC hash is ever
 * persisted, as the lookup key for the chat-ID cache.
 */
const sendLinqReply = async (
  ctx: ActionCtx,
  phoneNumber: string,
  text: string,
  incomingChatId?: string,
  extraParts?: LinqMessagePart[],
): Promise<void> => {
  if (!isLinqLiveDeployment()) {
    console.log(
      `[linq] Skipping outbound Linq send on non-primary deployment (${process.env.CONVEX_URL ?? "unknown"}).`,
    );
    return;
  }

  const fromNumber = process.env.LINQ_FROM_NUMBER;
  if (!fromNumber) {
    console.error("[linq] Missing LINQ_FROM_NUMBER — cannot send reply!");
    return;
  }

  const phoneHash = await hashLinqPhone(phoneNumber);

  // Try incoming chat ID first (most reliable — same conversation thread)
  if (incomingChatId) {
    try {
      await linqSendMessage(incomingChatId, text, extraParts);
      await ctx.runMutation(internal.channels.linq.cacheChatId, {
        phoneHash,
        linqChatId: incomingChatId,
      });
      return;
    } catch (error) {
      console.error("[linq] Send via incomingChatId failed, trying cached/new:", error);
    }
  }

  // Try cached chat ID
  const cachedChatId = await ctx.runQuery(internal.channels.linq.getCachedChatId, {
    phoneHash,
  });

  if (cachedChatId) {
    try {
      await linqSendMessage(cachedChatId, text, extraParts);
      return;
    } catch (error) {
      console.error("[linq] Cached chatId stale, creating new:", error);
    }
  }

  // Create new chat (sends initial message as part of creation)
  const newChatId = await linqCreateChat(fromNumber, [phoneNumber], text, extraParts);
  await ctx.runMutation(internal.channels.linq.cacheChatId, {
    phoneHash,
    linqChatId: newChatId,
  });
};

// ---------------------------------------------------------------------------
// Internal Actions (scheduled from webhook)
// ---------------------------------------------------------------------------

export const handleStartCommand = internalAction({
  args: {
    senderPhone: v.string(),
    text: v.string(),
    incomingChatId: v.string(),
  },
  handler: async (ctx, args) => {
    // Extract 6-digit code from text like "link ABC123" or just "ABC123"
    const codeMatch = args.text.match(/\b([A-Z0-9]{6})\b/i);
    const code = codeMatch?.[1]?.toUpperCase();

    if (!code) {
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "Welcome to Stella! To link your number:\n\n" +
          "1. Open Stella desktop app\n" +
          "2. Go to Settings \u2192 Text Stella\n" +
          "3. Copy the 6-digit code\n" +
          "4. Text it here",
        args.incomingChatId,
      );
      return null;
    }

    const senderPhoneHash = await hashLinqPhone(args.senderPhone);
    const result = await processLinkCode({
      ctx,
      provider: "linq",
      externalUserId: senderPhoneHash,
      code,
    });

    await sendLinqReply(
      ctx,
      args.senderPhone,
      formatLinkCodeResultMessage(result as LinkCodeResult, {
        providerName: "Linq",
        accountName: "number",
        linkedMessage: "Linked! You can now message Stella directly here via iMessage/SMS.",
      }),
      args.incomingChatId,
    );
    return null;
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    senderPhone: v.string(),
    text: v.string(),
    incomingChatId: v.string(),
    groupId: v.optional(v.string()),
    attachments: v.optional(v.array(channelAttachmentValidator)),
    channelEnvelope: optionalChannelEnvelopeValidator,
    respond: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const senderPhoneHash = await hashLinqPhone(args.senderPhone);
    console.log(`[linq:trace] Incoming message from sender=${senderPhoneHash.slice(0, 8)}…`);
    await handleConnectorIncomingMessage({
      ctx,
      provider: "linq",
      externalUserId: senderPhoneHash,
      text: args.text,
      groupId: args.groupId,
      attachments: args.attachments,
      channelEnvelope: args.channelEnvelope,
      respond: args.respond,
      // `deliveryMeta` is persisted on the `remote_turn_request` event and
      // on `conversations.pendingDeviceSelection`. We deliberately do NOT
      // include the sender's phone number here — outbound delivery uses
      // `incomingChatId` exclusively (see `deliverLinq`), so the persisted
      // metadata stays phone-free.
      deliveryMeta: {
        incomingChatId: args.incomingChatId,
      },
      logPrefix: "[linq]",
      notLinkedText: "Your number isn't linked yet. Open Stella \u2192 Settings \u2192 Text Stella, then text your 6-digit code here.",
      sendReply: (text) => sendLinqReply(ctx, args.senderPhone, text, args.incomingChatId),
      onResult: (result) => {
        console.log(`[linq:trace] processIncomingMessage result: deferred=${result?.deferred}, hasText=${!!result?.text}`);
      },
    });
    return null;
  },
});

export const sendWelcomeMessage = internalAction({
  args: { phoneNumber: v.string() },
  handler: async (ctx, args) => {
    await sendLinqReply(
      ctx,
      args.phoneNumber,
      "You\u2019re connected! Text me anytime and I\u2019ll respond right here. " +
        "I can also take actions on your computer while we chat.",
    );
    return null;
  },
});

export const executeLinqConnectorTool = action({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    operation: v.string(),
    payload: jsonValueValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || (identity as Record<string, unknown>).isAnonymous === true) {
      throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    }

    const target = (await ctx.runQuery(
      internal.channels.linq.getAuthorizedLinqRemoteTurnTarget,
      {
        ownerId: identity.tokenIdentifier,
        requestId: args.requestId,
        conversationId: args.conversationId,
      },
    )) as { incomingChatId: string; externalMessageId?: string } | null;
    if (!target) {
      throw new ConvexError("No authorized Linq connector turn found.");
    }
    if (!isLinqLiveDeployment()) {
      return {
        success: false,
        skipped: true,
        reason: "Linq sends are disabled on this deployment.",
      };
    }

    const payload = asRecord(args.payload);
    const chatPath = `/v3/chats/${encodeURIComponent(target.incomingChatId)}`;

    switch (args.operation) {
      case "send_message": {
        const message: Record<string, unknown> = {
          parts: parseLinqMessageParts(payload.parts),
        };
        const effect = parseLinqEffect(payload.effect);
        if (effect) message.effect = effect;
        const preferredService = readString(payload.preferred_service);
        if (preferredService) {
          if (!["iMessage", "RCS", "SMS"].includes(preferredService)) {
            throw new ConvexError("Invalid preferred_service.");
          }
          message.preferred_service = preferredService;
        }
        const replyTo = readString(payload.reply_to);
        if (replyTo) message.reply_to = replyTo;
        const idempotencyKey = readString(payload.idempotency_key);
        if (idempotencyKey) message.idempotency_key = idempotencyKey.slice(0, 255);
        const response = await linqFetchJson(`${chatPath}/messages`, {
          method: "POST",
          body: JSON.stringify({ message }),
        });
        return { success: true, operation: args.operation, response };
      }
      case "typing": {
        const actionName = requireString(payload.action, "action");
        if (actionName !== "start" && actionName !== "stop") {
          throw new ConvexError("typing action must be start or stop.");
        }
        await linqFetchJson(`${chatPath}/typing`, {
          method: actionName === "start" ? "POST" : "DELETE",
        });
        return { success: true, operation: args.operation, action: actionName };
      }
      case "read": {
        await linqFetchJson(`${chatPath}/read`, { method: "POST" });
        return { success: true, operation: args.operation };
      }
      case "share_contact_card": {
        await linqFetchJson(`${chatPath}/share_contact_card`, {
          method: "POST",
        });
        return { success: true, operation: args.operation };
      }
      case "voice_memo": {
        const voiceMemoUrl = readString(payload.voice_memo_url);
        const attachmentId = readString(payload.attachment_id);
        if ((voiceMemoUrl ? 1 : 0) + (attachmentId ? 1 : 0) !== 1) {
          throw new ConvexError(
            "voice_memo requires exactly one of voice_memo_url or attachment_id.",
          );
        }
        const response = await linqFetchJson(`${chatPath}/voicememo`, {
          method: "POST",
          body: JSON.stringify({
            ...(voiceMemoUrl ? { voice_memo_url: voiceMemoUrl } : {}),
            ...(attachmentId ? { attachment_id: attachmentId } : {}),
          }),
        });
        return { success: true, operation: args.operation, response };
      }
      case "reaction": {
        const messageId =
          readLinqMessageId(payload.message_id) ?? target.externalMessageId;
        if (!messageId) {
          throw new ConvexError(
            "message_id must be a valid Linq message UUID. Omit it to react to the current inbound Linq message.",
          );
        }
        const operation = requireString(payload.operation, "operation");
        if (operation !== "add" && operation !== "remove") {
          throw new ConvexError("reaction operation must be add or remove.");
        }
        const reactionType = requireString(payload.type, "type");
        if (!LINQ_REACTION_TYPES.has(reactionType)) {
          throw new ConvexError("Invalid reaction type.");
        }
        const body: Record<string, unknown> = {
          operation,
          type: reactionType,
        };
        const customEmoji = readString(payload.custom_emoji);
        if (reactionType === "custom") {
          if (!customEmoji) {
            throw new ConvexError("custom_emoji is required for custom reactions.");
          }
          body.custom_emoji = customEmoji;
        }
        if (typeof payload.part_index === "number") {
          if (
            !Number.isFinite(payload.part_index) ||
            payload.part_index < 0
          ) {
            throw new ConvexError("part_index must be a non-negative number.");
          }
          body.part_index = Math.floor(payload.part_index);
        }
        const response = await linqFetchJson(
          `/v3/messages/${encodeURIComponent(messageId)}/reactions`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        );
        return { success: true, operation: args.operation, response };
      }
      default:
        throw new ConvexError(`Unsupported Linq connector operation: ${args.operation}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Public Action — Desktop initiates SMS to the user's phone
// ---------------------------------------------------------------------------

const E164_REGEX = /^\+[1-9]\d{6,14}$/;
const STELLA_VCARD_URL = "https://benevolent-minnow-586.convex.site/stella.vcf";

export const sendLinqLinkSms = action({
  args: { phoneNumber: v.string() },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    if ((identity as Record<string, unknown>).isAnonymous === true) {
      throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    }

    const phone = args.phoneNumber.replace(/[\s\-().]/g, "");
    if (!E164_REGEX.test(phone)) {
      throw new ConvexError("Please enter a valid phone number with country code (e.g. +1…).");
    }
    const phoneHash = await hashLinqPhone(phone);

    // Each call dispatches a paid SMS via the Linq partner API. Throttle on
    // *both* the caller and the destination number so a single account
    // can't be used to SMS-pump a phone, and a leaked token can't be used
    // to flood many numbers either. We rate-limit on the phone *hash* (not
    // plaintext) so this transient key matches everywhere else and the
    // rate-limit component never sees a recoverable phone number.
    await enforceActionRateLimit(
      ctx,
      "send_linq_link_sms_owner",
      identity.tokenIdentifier,
      RATE_VERY_EXPENSIVE,
      "Too many link-code SMS requests. Please wait a minute and try again.",
    );
    await enforceActionRateLimit(
      ctx,
      "send_linq_link_sms_phone",
      phoneHash,
      RATE_VERY_EXPENSIVE,
      "Too many link-code SMS requests for this number. Please wait a minute and try again.",
    );

    const fromNumber = process.env.LINQ_FROM_NUMBER;
    if (!fromNumber) throw new Error("Missing LINQ_FROM_NUMBER");

    const { code } = await ctx.runMutation(
      internal.channels.link_codes.generateAndStoreLinkCode,
      { ownerId: identity.tokenIdentifier, provider: "linq" },
    );

    const message =
      `Your Stella code is: ${code}\n\n` +
      `Enter this code on your desktop to connect.\n\n` +
      `Tap the contact card below to save Stella to your contacts.`;

    await sendLinqReply(ctx, phone, message, undefined, [
      { type: "media", url: STELLA_VCARD_URL },
    ]);

    return { success: true };
  },
});
