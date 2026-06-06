"use node";

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { MANAGED_GATEWAY } from "../agent/model";
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
const MAX_TRANSCRIBE_AUDIO_BASE64_CHARS = 10_000_000;
const MAX_EXTRACTED_TEXT_CHARS = 40_000;
const TRANSCRIBE_MODEL = "mistralai/voxtral-mini-transcribe";
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

const nameFromUrl = (url?: string): string | undefined => {
  if (!url) return undefined;
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
};

const extensionFromName = (name?: string): string | undefined =>
  name?.match(/\.([a-z0-9]{2,8})(?:[?#]|$)/i)?.[1]?.toLowerCase();

const mimeFromName = (name?: string): string | undefined => {
  switch (extensionFromName(name)) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "csv":
      return "text/csv";
    case "rtf":
      return "application/rtf";
    case "vcf":
      return "text/vcard";
    case "ics":
      return "text/calendar";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "m4v":
      return "video/x-m4v";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "wav":
      return "audio/wav";
    case "aiff":
    case "aif":
      return "audio/aiff";
    case "caf":
      return "audio/x-caf";
    case "amr":
      return "audio/amr";
    default:
      return undefined;
  }
};

const inferKind = (args: {
  mimeType?: string;
  kind?: string;
  name?: string;
}): ConnectorMediaKind => {
  const mime = args.mimeType?.toLowerCase() ?? "";
  const kind = args.kind?.toLowerCase() ?? "";
  const ext = extensionFromName(args.name);
  if (
    mime.startsWith("image/") ||
    kind.includes("image") ||
    kind.includes("photo") ||
    ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg"].includes(ext ?? "")
  ) {
    return "image";
  }
  if (mime.startsWith("video/") || kind.includes("video") || ["mp4", "mov", "m4v"].includes(ext ?? "")) {
    return "video";
  }
  if (
    mime.startsWith("audio/") ||
    kind.includes("audio") ||
    kind.includes("voice") ||
    ["m4a", "aac", "mp3", "wav", "aiff", "aif", "caf", "amr"].includes(ext ?? "")
  ) {
    return "audio";
  }
  return "file";
};

const extensionForMime = (mimeType?: string, fallbackName?: string): string => {
  const fromName = extensionFromName(fallbackName);
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

const audioFormatForMime = (mimeType?: string, fallbackName?: string): string | null => {
  const fromName = extensionFromName(fallbackName);
  if (fromName && ["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac", "mp4"].includes(fromName)) {
    return fromName;
  }
  switch ((mimeType ?? "").split(";")[0]?.trim().toLowerCase()) {
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/aac":
      return "aac";
    case "video/mp4":
      return "mp4";
    default:
      return null;
  }
};

const transcribeAudioBytes = async (args: {
  bytes: Uint8Array;
  mimeType?: string;
  name?: string;
}): Promise<string | undefined> => {
  const format = audioFormatForMime(args.mimeType, args.name);
  if (!format) return undefined;
  const audio = Buffer.from(args.bytes).toString("base64");
  if (audio.length > MAX_TRANSCRIBE_AUDIO_BASE64_CHARS) {
    console.warn("[connector_media] audio attachment too large to transcribe:", {
      size: args.bytes.byteLength,
    });
    return undefined;
  }
  const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
  if (!apiKey) {
    console.error(`[connector_media] Missing ${MANAGED_GATEWAY.apiKeyEnvVar} for audio transcription`);
    return undefined;
  }
  const response = await fetch(`${MANAGED_GATEWAY.baseURL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://stella.sh",
      "X-OpenRouter-Title": "Stella",
    },
    body: JSON.stringify({
      input_audio: { data: audio, format },
      model: TRANSCRIBE_MODEL,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn("[connector_media] audio transcription failed:", {
      status: response.status,
      body: body.slice(0, 500),
    });
    return undefined;
  }
  const parsed = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const transcript = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  return transcript || undefined;
};

const truncateExtractedText = (text: string): string | undefined => {
  const normalized = text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return undefined;
  return normalized.length > MAX_EXTRACTED_TEXT_CHARS
    ? `${normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n\n[Truncated by Stella]`
    : normalized;
};

const stripRtf = (text: string): string => {
  return text
    .replace(/\\'[0-9a-fA-F]{2}/g, " ")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ");
};

const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: false }).decode(bytes);

const isTextLikeMime = (mimeType?: string, name?: string): boolean => {
  const mime = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  const ext = extensionFromName(name);
  return (
    Boolean(mime?.startsWith("text/")) ||
    [
      "application/json",
      "application/xml",
      "application/rtf",
      "application/x-rtf",
      "text/rtf",
      "text/vcard",
      "text/calendar",
    ].includes(mime ?? "") ||
    ["txt", "csv", "md", "json", "xml", "rtf", "vcf", "ics", "log"].includes(ext ?? "")
  );
};

const extractPdfText = async (bytes: Uint8Array): Promise<string | undefined> => {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: Buffer.from(bytes) });
  try {
    const result = await parser.getText();
    return truncateExtractedText(result.text);
  } finally {
    await parser.destroy();
  }
};

const extractAttachmentText = async (args: {
  bytes: Uint8Array;
  mimeType?: string;
  name?: string;
}): Promise<string | undefined> => {
  const mime = (args.mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  const ext = extensionFromName(args.name);
  try {
    if (mime === "application/pdf" || ext === "pdf") {
      return await extractPdfText(args.bytes);
    }
    if (isTextLikeMime(args.mimeType, args.name)) {
      const decoded = decodeUtf8(args.bytes);
      return truncateExtractedText(
        mime === "application/rtf" ||
          mime === "application/x-rtf" ||
          mime === "text/rtf" ||
          ext === "rtf"
          ? stripRtf(decoded)
          : decoded,
      );
    }
  } catch (error) {
    console.warn("[connector_media] text extraction failed:", {
      mimeType: args.mimeType,
      name: args.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
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
  transcript?: string;
  extractedText?: string;
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
    ...(args.transcript ? { transcript: args.transcript } : {}),
    ...(args.extractedText ? { extractedText: args.extractedText } : {}),
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
        const name =
          attachment.name ?? nameFromUrl(download.url) ?? nameFromUrl(attachment.url);
        const attachmentMime =
          attachment.mimeType && attachment.mimeType !== "application/octet-stream"
            ? attachment.mimeType
            : undefined;
        const fetchedMime =
          fetched.mimeType && fetched.mimeType !== "application/octet-stream"
            ? fetched.mimeType
            : undefined;
        const mimeType =
          attachmentMime ?? mimeFromName(name) ?? fetchedMime;
        const kind = inferKind({
          mimeType,
          kind: attachment.kind,
          name,
        });
        const transcript =
          kind === "audio"
            ? await transcribeAudioBytes({
                bytes: fetched.bytes,
                mimeType,
                name,
              })
            : undefined;
        const extractedText =
          kind === "file"
            ? await extractAttachmentText({
                bytes: fetched.bytes,
                mimeType,
                name,
              })
            : undefined;
        refs.push(
          await relayBytes({
            ctx,
            scopeId: args.scopeId,
            bytes: fetched.bytes,
            kind,
            mimeType,
            name,
            size: attachment.size ?? fetched.size,
            transcript,
            extractedText,
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
