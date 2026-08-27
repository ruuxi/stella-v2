"use node";

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { requireConnectedUserIdAction } from "../auth";
import { RATE_EXPENSIVE, enforceActionRateLimit } from "../lib/rate_limits";
import {
  deleteR2Object,
  uploadR2Object,
  type R2Credentials,
} from "../lib/r2_sigv4";
import { buildCanvasShareUrl } from "../lib/canvas_share_url";
import { requireBoundedString } from "../shared_validators";

const DEFAULT_BUCKET = "stella-canvas-shares";
const KEY_PREFIX = "shares";
const CONTENT_TYPE = "text/html; charset=utf-8";
const CACHE_CONTROL = "public, max-age=300";

const MAX_HTML_BYTES = 5 * 1024 * 1024;

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TITLE = 300;
const PURGE_BATCH = 200;
const PURGE_MAX_BATCHES = 10;

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "SERVER_MISCONFIGURED",
      message: `Missing ${name} for canvas shares.`,
    });
  }
  return value;
};

const r2Credentials = (): R2Credentials => ({
  accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  endpoint: requireEnv("R2_ENDPOINT"),
  bucket: process.env.R2_CANVAS_SHARES_BUCKET?.trim() || DEFAULT_BUCKET,
});

const shareKeyForSlug = (slug: string): string => `${KEY_PREFIX}/${slug}.html`;

const generateSlug = (): string => randomBytes(16).toString("base64url");

export const publish = action({
  args: {
    html: v.string(),
    title: v.optional(v.string()),
  },
  returns: v.object({
    url: v.string(),
    slug: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerUserId = await requireConnectedUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "canvasShares.publish",
      ownerUserId,
      RATE_EXPENSIVE,
    );

    const html = args.html;
    if (typeof html !== "string" || html.length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Canvas HTML is required.",
      });
    }
    const byteLength = Buffer.byteLength(html, "utf8");
    if (byteLength > MAX_HTML_BYTES) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Canvas HTML exceeds the ${Math.floor(
          MAX_HTML_BYTES / (1024 * 1024),
        )}MB limit.`,
      });
    }

    let title: string | undefined;
    if (args.title !== undefined) {
      const trimmed = args.title.trim();
      if (trimmed.length > 0) {
        requireBoundedString(trimmed, "title", MAX_TITLE);
        title = trimmed;
      }
    }

    const now = Date.now();
    const expiresAt = now + DEFAULT_TTL_MS;
    const slug = generateSlug();
    const r2Key = shareKeyForSlug(slug);

    await uploadR2Object({
      key: r2Key,
      bytes: Buffer.from(html, "utf8"),
      contentType: CONTENT_TYPE,
      cacheControl: CACHE_CONTROL,
      metadata: {
        "expires-at": String(expiresAt),
        owner: ownerUserId,
      },
      r2: r2Credentials(),
    });

    await ctx.runMutation(internal.data.canvas_shares.insertShare, {
      slug,
      ownerUserId,
      r2Key,
      ...(title !== undefined ? { title } : {}),
      createdAt: now,
      expiresAt,
    });

    return { url: buildCanvasShareUrl(slug), slug, expiresAt };
  },
});

export const revoke = action({
  args: { slug: v.string() },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, { slug }) => {
    const ownerUserId = await requireConnectedUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "canvasShares.revoke",
      ownerUserId,
      RATE_EXPENSIVE,
    );

    const row = await ctx.runQuery(internal.data.canvas_shares.getBySlug, {
      slug,
    });

    if (!row || row.ownerUserId !== ownerUserId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Share not found.",
      });
    }

    await deleteR2Object({ key: row.r2Key, r2: r2Credentials() });
    await ctx.runMutation(internal.data.canvas_shares.markRevoked, {
      id: row.id,
    });
    return { revoked: true };
  },
});

const deleteSharesR2 = async (
  refs: Array<{ slug: string; r2Key: string }>,
): Promise<void> => {
  const r2 = r2Credentials();

  await Promise.all(
    refs.map((ref) =>
      deleteR2Object({ key: ref.r2Key, r2 }).catch((error) => {
        console.error(
          `[canvas_shares] Failed to delete R2 object ${ref.r2Key}:`,
          error,
        );
      }),
    ),
  );
};

export const purgeExpiredShares = internalAction({
  args: { batchSize: v.optional(v.number()), maxBatches: v.optional(v.number()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx: ActionCtx, args) => {
    const batchSize = args.batchSize ?? PURGE_BATCH;
    const maxBatches = Math.min(
      Math.max(Math.floor(args.maxBatches ?? PURGE_MAX_BATCHES), 1),
      100,
    );
    let deleted = 0;
    for (let i = 0; i < maxBatches; i++) {
      const refs = await ctx.runQuery(
        internal.data.canvas_shares.listExpiredBatch,
        { batchSize },
      );
      if (refs.length === 0) break;
      await deleteSharesR2(refs);
      await ctx.runMutation(internal.data.canvas_shares.deleteShareRows, {
        ids: refs.map((ref) => ref.id),
      });
      deleted += refs.length;
      if (refs.length < batchSize) break;
    }
    return { deleted };
  },
});

export const purgeOwnerShares = internalAction({
  args: { ownerUserId: v.string() },
  returns: v.null(),
  handler: async (ctx: ActionCtx, { ownerUserId }) => {
    while (true) {
      const refs = await ctx.runQuery(
        internal.data.canvas_shares.listOwnerBatch,
        { ownerUserId, batchSize: PURGE_BATCH },
      );
      if (refs.length === 0) break;
      await deleteSharesR2(refs);
      await ctx.runMutation(internal.data.canvas_shares.deleteShareRows, {
        ids: refs.map((ref) => ref.id),
      });
      if (refs.length < PURGE_BATCH) break;
    }
    return null;
  },
});
