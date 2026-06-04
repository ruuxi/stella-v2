import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { handleConnectorIncomingMessage } from "./message_pipeline";
import { formatLinkCodeResultMessage, processLinkCode } from "./link_codes";
import { channelAttachmentValidator, optionalChannelEnvelopeValidator } from "../shared_validators";
import { hexToUint8Array } from "../lib/crypto_utils";
import { DISCORD_MAX_MESSAGE_CHARS, truncateForConnector } from "./connector_constants";
import type { ConnectorMediaRef } from "./connector_media_types";

// ---------------------------------------------------------------------------
// Ed25519 Signature Verification (Discord Interactions Endpoint)
// ---------------------------------------------------------------------------

const DISCORD_SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;

export async function verifyDiscordSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestampSeconds = Number(timestamp);
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > DISCORD_SIGNATURE_MAX_SKEW_SECONDS
    ) {
      return false;
    }

    const encoder = new TextEncoder();
    const message = encoder.encode(timestamp + rawBody);
    const sigBytes = hexToUint8Array(signature);
    const keyBytes = hexToUint8Array(publicKey);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes.buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    return await crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      sigBytes.buffer as ArrayBuffer,
      message.buffer as ArrayBuffer,
    );
  } catch (error) {
    console.error("[discord] Signature verification failed:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discord REST API Helpers
// ---------------------------------------------------------------------------

const DISCORD_API = "https://discord.com/api/v10";

const discordApi = async (
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

  return await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};

const editInteractionResponse = async (
  applicationId: string,
  interactionToken: string,
  content: string,
) => {
  const truncated = truncateForConnector(content, DISCORD_MAX_MESSAGE_CHARS);

  const res = await fetch(
    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: truncated }),
    },
  );

  if (!res.ok) {
    console.error(
      "[discord] Failed to edit interaction response:",
      res.status,
      await res.text(),
    );
  }
};

const discordMediaLabel = (media: ConnectorMediaRef): string =>
  media.name?.trim() || media.mimeType?.trim() || `${media.kind} attachment`;

const appendDiscordMediaLinks = (text: string, media: ConnectorMediaRef[]): string => {
  if (media.length === 0) return text;
  const lines = media.map((item) => `${discordMediaLabel(item)}: ${item.url}`);
  return [text.trim(), ...lines].filter(Boolean).join("\n");
};

export const sendDiscordChannelMessage = async (
  channelId: string,
  content: string,
  media: ConnectorMediaRef[] = [],
) => {
  if (!channelId) {
    console.error("[discord] Cannot send channel message without channelId");
    return;
  }

  const imageMedia = media.filter((item) => item.kind === "image");
  const nonImageMedia = media.filter((item) => item.kind !== "image");
  const truncated = truncateForConnector(
    appendDiscordMediaLinks(content, nonImageMedia),
    DISCORD_MAX_MESSAGE_CHARS,
  );
  const embeds = imageMedia.map((item) => ({
    title: discordMediaLabel(item),
    image: { url: item.url },
  }));

  const res = await discordApi(`/channels/${encodeURIComponent(channelId)}/messages`, "POST", {
    content: truncated,
    ...(embeds.length > 0 ? { embeds } : {}),
  });

  if (!res.ok) {
    console.error(
      "[discord] Failed to send channel message:",
      res.status,
      await res.text(),
    );
  }
};

// ---------------------------------------------------------------------------
// Internal Actions (scheduled from webhook)
// ---------------------------------------------------------------------------

export const handleLinkCommand = internalAction({
  args: {
    applicationId: v.string(),
    interactionToken: v.string(),
    discordUserId: v.string(),
    codeArg: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await processLinkCode({
      ctx,
      provider: "discord",
      externalUserId: args.discordUserId,
      code: args.codeArg,
      displayName: args.displayName,
    });

    await editInteractionResponse(
      args.applicationId,
      args.interactionToken,
      formatLinkCodeResultMessage(result, {
        providerName: "Discord",
        linkedMessage: "Linked! You can now DM Stella directly.",
      }),
    );
    return null;
  },
});

export const handleAskCommand = internalAction({
  args: {
    applicationId: v.string(),
    interactionToken: v.string(),
    discordUserId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
    groupId: v.optional(v.string()),
    attachments: v.optional(v.array(channelAttachmentValidator)),
    channelEnvelope: optionalChannelEnvelopeValidator,
    respond: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await handleConnectorIncomingMessage({
      ctx,
      provider: "discord",
      externalUserId: args.discordUserId,
      text: args.text,
      groupId: args.groupId,
      attachments: args.attachments,
      channelEnvelope: args.channelEnvelope,
      respond: args.respond,
      deliveryMeta: {
        applicationId: args.applicationId,
        interactionToken: args.interactionToken,
      },
      logPrefix: "[discord]",
      notLinkedText: "Your account isn't linked yet. Use `/link` with your 6-digit code from Stella Settings.",
      sendReply: (text) => editInteractionResponse(
        args.applicationId,
        args.interactionToken,
        text,
      ),
    });
    return null;
  },
});

export const handleDirectMessage = internalAction({
  args: {
    discordUserId: v.string(),
    channelId: v.string(),
    messageId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
    attachments: v.optional(v.array(channelAttachmentValidator)),
    channelEnvelope: optionalChannelEnvelopeValidator,
    respond: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await handleConnectorIncomingMessage({
      ctx,
      provider: "discord",
      externalUserId: args.discordUserId,
      text: args.text,
      attachments: args.attachments,
      channelEnvelope: args.channelEnvelope,
      respond: args.respond,
      deliveryMeta: {
        channelId: args.channelId,
        messageId: args.messageId,
      },
      logPrefix: "[discord]",
      notLinkedText: "Your account isn't linked yet. Use `/link` with your 6-digit code from Stella Settings.",
      sendReply: (text) => sendDiscordChannelMessage(args.channelId, text),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// One-time Setup: Register Slash Commands
// ---------------------------------------------------------------------------

export const registerCommands = internalAction({
  args: {},
  handler: async () => {
    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (!applicationId) {
      throw new Error("Missing DISCORD_APPLICATION_ID");
    }

    const commands = [
      {
        name: "ask",
        description: "Send a message to Stella",
        type: 1,
        options: [
          {
            name: "message",
            description: "Your message to Stella",
            type: 3,
            required: false,
          },
          {
            name: "attachment",
            description: "Optional image/audio/file attachment",
            type: 11,
            required: false,
          },
        ],
        integration_types: [1],
        contexts: [1, 2],
      },
      {
        name: "link",
        description: "Link your Discord account to Stella with a 6-digit code",
        type: 1,
        options: [
          {
            name: "code",
            description: "The 6-digit code from Stella Settings",
            type: 3,
            required: true,
          },
        ],
        integration_types: [1],
        contexts: [1, 2],
      },
      {
        name: "status",
        description: "Check your Stella connection status",
        type: 1,
        integration_types: [1],
        contexts: [1, 2],
      },
    ];

    const res = await discordApi(
      `/applications/${applicationId}/commands`,
      "PUT",
      commands,
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to register commands: ${res.status} ${text}`);
    }

    const result = await res.json();
    const commandCount = Array.isArray(result) ? result.length : 0;
    return { ok: true, commandCount };
  },
});
