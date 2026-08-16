"use node";

import { randomUUID } from "node:crypto";
import { internalAction, type ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { r2 } from "../r2_files";
import { retryFetch } from "../lib/retry_fetch";
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

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const extensionFromName = (name?: string): string | undefined =>
  name?.match(/\.([a-z0-9]{2,8})(?:[?#]|$)/i)?.[1]?.toLowerCase();

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
