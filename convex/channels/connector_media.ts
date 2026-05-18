"use node";

import { randomUUID } from "node:crypto";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { r2 } from "../r2_files";
import { channelAttachmentValidator, jsonValueValidator } from "../shared_validators";
import { retryFetch } from "../lib/retry_fetch";
import { getGoogleAccessToken, getTeamsBotToken } from "./connector_auth";
import {
  connectorDeliveryMediaInputValidator,
  connectorMediaRefArrayValidator,
  type ConnectorMediaKind,
  type ConnectorMediaRef,
} from "./connector_media_types";

const MEDIA_URL_EXPIRES_IN_SECONDS = 15 * 60;
const MAX_CONNECTOR_MEDIA_ITEMS = 5;
const MAX_CONNECTOR_MEDIA_BYTES = 25 * 1024 * 1024;
const CACHE_CONTROL = "private, max-age=900";
const DEFAULT_R2_PREFIX = "ephemeral/connectors";

type ChannelAttachment = {
  id?: string;
  name?: string;
  mimeType?: string;
  url?: string;
  size?: number;
  kind?: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const inferKind = (args: {
  mimeType?: string;
  kind?: string;
  name?: string;
}): ConnectorMediaKind => {
  const mime = args.mimeType?.toLowerCase() ?? "";
  const kind = args.kind?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || kind.includes("image") || kind.includes("photo")) {
    return "image";
  }
  if (mime.startsWith("video/") || kind.includes("video")) {
    return "video";
  }
  if (
    mime.startsWith("audio/") ||
    kind.includes("audio") ||
    kind.includes("voice")
  ) {
    return "audio";
  }
  return "file";
};

const extensionForMime = (mimeType?: string, fallbackName?: string): string => {
  const fromName = fallbackName?.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  switch ((mimeType ?? "").split(";")[0]?.trim().toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
      return "m4a";
    case "audio/wav":
    case "audio/wave":
      return "wav";
    case "audio/ogg":
      return "ogg";
    default:
      return "bin";
  }
};

const mimeFromResponse = (response: Response, fallback?: string): string | undefined =>
  asString(response.headers.get("content-type"))?.split(";")[0]?.toLowerCase() ??
  fallback;

const buildR2Key = (args: {
  scopeId: string;
  mimeType?: string;
  name?: string;
}): string => {
  const prefix =
    process.env.R2_CONNECTOR_EPHEMERAL_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ||
    DEFAULT_R2_PREFIX;
  const ext = extensionForMime(args.mimeType, args.name);
  return `${prefix}/${args.scopeId}/${randomUUID()}.${ext}`;
};

const fetchBytes = async (
  url: string,
  headers?: Record<string, string>,
): Promise<{ bytes: Uint8Array; mimeType?: string; size: number }> => {
  const response = await retryFetch(url, { headers });
  if (!response.ok) {
    throw new Error(`media fetch failed (${response.status})`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_CONNECTOR_MEDIA_BYTES) {
    throw new Error(`media exceeds ${MAX_CONNECTOR_MEDIA_BYTES} bytes`);
  }
  return {
    bytes: buffer,
    mimeType: mimeFromResponse(response),
    size: buffer.byteLength,
  };
};

const telegramFileUrl = async (fileId: string): Promise<string | null> => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const response = await retryFetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    {},
  );
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; result?: { file_path?: string } }
    | null;
  const filePath = asString(payload?.result?.file_path);
  return filePath
    ? `https://api.telegram.org/file/bot${token}/${filePath}`
    : null;
};

const slackToken = async (
  ctx: ActionCtx,
  teamId?: string,
): Promise<string | null> => {
  if (teamId) {
    const installation = (await ctx.runQuery(
      internal.channels.slack_installations.getByTeamId,
      { teamId },
    )) as { botToken?: string } | null;
    if (installation?.botToken) return installation.botToken;
  }
  return process.env.SLACK_BOT_TOKEN ?? null;
};

const resolveProviderDownload = async (args: {
  ctx: ActionCtx;
  provider: string;
  deliveryMeta: Record<string, unknown>;
  attachment: ChannelAttachment;
}): Promise<{ url: string; headers?: Record<string, string> } | null> => {
  const directUrl = asString(args.attachment.url);
  switch (args.provider) {
    case "telegram": {
      const fileId = asString(args.attachment.id);
      const url = fileId ? await telegramFileUrl(fileId) : directUrl;
      return url ? { url } : null;
    }
    case "slack": {
      if (!directUrl) return null;
      const token = await slackToken(args.ctx, asString(args.deliveryMeta.teamId));
      return token
        ? { url: directUrl, headers: { Authorization: `Bearer ${token}` } }
        : null;
    }
    case "google_chat": {
      if (!directUrl) return null;
      const token = await getGoogleAccessToken();
      return { url: directUrl, headers: { Authorization: `Bearer ${token}` } };
    }
    case "teams": {
      if (!directUrl) return null;
      const token = await getTeamsBotToken();
      return { url: directUrl, headers: { Authorization: `Bearer ${token}` } };
    }
    default:
      return directUrl ? { url: directUrl } : null;
  }
};

const relayBytes = async (args: {
  ctx: ActionCtx;
  scopeId: string;
  bytes: Uint8Array;
  kind: ConnectorMediaKind;
  mimeType?: string;
  name?: string;
  size?: number;
}): Promise<ConnectorMediaRef> => {
  const key = buildR2Key({
    scopeId: args.scopeId,
    mimeType: args.mimeType,
    name: args.name,
  });
  await r2.store(args.ctx, args.bytes, {
    key,
    type: args.mimeType,
    cacheControl: CACHE_CONTROL,
  });
  return {
    id: randomUUID(),
    kind: args.kind,
    url: await r2.getUrl(key, { expiresIn: MEDIA_URL_EXPIRES_IN_SECONDS }),
    expiresAt: Date.now() + MEDIA_URL_EXPIRES_IN_SECONDS * 1000,
    r2Key: key,
    ...(args.mimeType ? { mimeType: args.mimeType } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(typeof args.size === "number" ? { size: args.size } : {}),
  };
};

export const materializeInboundAttachments = internalAction({
  args: {
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    scopeId: v.string(),
    attachments: v.array(channelAttachmentValidator),
  },
  returns: connectorMediaRefArrayValidator,
  handler: async (ctx, args): Promise<ConnectorMediaRef[]> => {
    const deliveryMeta = asRecord(args.deliveryMeta);
    const refs: ConnectorMediaRef[] = [];
    for (const attachment of args.attachments.slice(0, MAX_CONNECTOR_MEDIA_ITEMS)) {
      try {
        const download = await resolveProviderDownload({
          ctx,
          provider: args.provider,
          deliveryMeta,
          attachment,
        });
        if (!download) continue;
        const fetched = await fetchBytes(download.url, download.headers);
        const mimeType = attachment.mimeType ?? fetched.mimeType;
        const kind = inferKind({
          mimeType,
          kind: attachment.kind,
          name: attachment.name,
        });
        refs.push(
          await relayBytes({
            ctx,
            scopeId: args.scopeId,
            bytes: fetched.bytes,
            kind,
            mimeType,
            name: attachment.name,
            size: attachment.size ?? fetched.size,
          }),
        );
      } catch (error) {
        console.error("[connector_media] failed to relay inbound attachment:", {
          provider: args.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return refs;
  },
});

export const materializeRemoteMedia = internalAction({
  args: {
    scopeId: v.string(),
    media: v.array(connectorDeliveryMediaInputValidator),
  },
  returns: connectorMediaRefArrayValidator,
  handler: async (ctx, args): Promise<ConnectorMediaRef[]> => {
    const refs: ConnectorMediaRef[] = [];
    for (const item of args.media.slice(0, MAX_CONNECTOR_MEDIA_ITEMS)) {
      try {
        const fetched = await fetchBytes(item.url);
        const mimeType = item.mimeType ?? fetched.mimeType;
        refs.push(
          await relayBytes({
            ctx,
            scopeId: args.scopeId,
            bytes: fetched.bytes,
            kind: item.kind,
            mimeType,
            name: item.name,
            size: item.size ?? fetched.size,
          }),
        );
      } catch (error) {
        console.error("[connector_media] failed to relay outbound media:", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return refs;
  },
});

export const deleteRelayedMedia = internalAction({
  args: {
    media: connectorMediaRefArrayValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const ref of args.media) {
      if (!ref.r2Key) continue;
      // Failure here means we leaked a relayed-media object in R2 — log
      // loudly so storage-cost leaks are visible rather than silent.
      await r2.deleteObject(ctx, ref.r2Key).catch((error) => {
        console.warn(
          "[connector_media] failed to delete relayed media object:",
          {
            r2Key: ref.r2Key,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    }
    return null;
  },
});

export const refreshRelayedMediaUrls = internalAction({
  args: {
    media: connectorMediaRefArrayValidator,
  },
  returns: connectorMediaRefArrayValidator,
  handler: async (_ctx, args): Promise<ConnectorMediaRef[]> => {
    const refreshed: ConnectorMediaRef[] = [];
    for (const ref of args.media) {
      if (!ref.r2Key) {
        refreshed.push(ref);
        continue;
      }
      refreshed.push({
        ...ref,
        url: await r2.getUrl(ref.r2Key, {
          expiresIn: MEDIA_URL_EXPIRES_IN_SECONDS,
        }),
        expiresAt: Date.now() + MEDIA_URL_EXPIRES_IN_SECONDS * 1000,
      });
    }
    return refreshed;
  },
});
