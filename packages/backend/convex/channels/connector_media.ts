"use node";

import { randomUUID } from "node:crypto";
import { internalAction, type ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { r2 } from "../r2_files";
import { retryFetch } from "../lib/retry_fetch";
import { deleteComponentR2ObjectsRef } from "../lib/component_r2_deletion";
import { makeFunctionReference } from "convex/server";
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
const RELAYED_MEDIA_DELETE_RETRY_MAX_MS = 15 * 60_000;

const deleteRelayedMediaRef = makeFunctionReference<
  "action",
  { media: ConnectorMediaRef[]; attempt?: number },
  null
>("channels/connector_media:deleteRelayedMedia");

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

const mimeFromResponse = (
  response: Response,
  fallback?: string,
): string | undefined =>
  asString(response.headers.get("content-type"))
    ?.split(";")[0]
    ?.toLowerCase() ?? fallback;

const buildR2Key = (args: {
  scopeId: string;
  mimeType?: string;
  name?: string;
}): string => {
  const prefix =
    process.env.R2_CONNECTOR_EPHEMERAL_PREFIX?.trim().replace(
      /^\/+|\/+$/g,
      "",
    ) || DEFAULT_R2_PREFIX;
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
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const uniqueKeys = [
      ...new Set(
        args.media
          .map((ref) => ref.r2Key)
          .filter((key): key is string => Boolean(key)),
      ),
    ];
    if (uniqueKeys.length === 0) return null;

    const attempt = Number.isSafeInteger(args.attempt)
      ? Math.max(0, Math.min(args.attempt ?? 0, 30))
      : 0;
    const retryDelay = Math.min(
      RELAYED_MEDIA_DELETE_RETRY_MAX_MS,
      2 ** Math.min(attempt, 9) * 1_000,
    );
    // Keep the exact locators in a durable scheduled payload before any
    // provider I/O. If this action crashes or loses a response, the successor
    // repeats the idempotent direct DELETE and metadata removal.
    const retryId = await ctx.scheduler.runAfter(
      retryDelay,
      deleteRelayedMediaRef,
      { media: args.media, attempt: attempt + 1 },
    );
    const objects = uniqueKeys.map((r2Key) => ({
      locatorId: randomUUID(),
      r2Key,
    }));
    try {
      const deleted = await ctx.runAction(deleteComponentR2ObjectsRef, {
        objects,
      });
      if (deleted.confirmedLocatorIds.length !== objects.length) return null;
      await ctx.scheduler.cancel(retryId).catch(() => undefined);
    } catch {
      // The successor owns the last durable locator; never log raw keys,
      // credentials, signed URLs, or provider response bodies here.
    }
    return null;
  },
});
