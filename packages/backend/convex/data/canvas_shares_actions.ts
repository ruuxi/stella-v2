"use node";

/**
 * Canvas share publish / revoke / cleanup actions (Node runtime).
 *
 * A user publishes a self-contained generated HTML doc to the
 * `stella-canvas-shares` R2 bucket and receives an unguessable public URL
 * (`<CANVAS_SHARE_BASE_URL>/c/<slug>`). The Cloudflare Worker in
 * `workers/canvas-share/` serves the object; deleting the object is what makes
 * a share 404 (revoke / expiry / account deletion).
 */

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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
import { assertOwnerDataAccessActive } from "../owner_lifecycle";

const DEFAULT_BUCKET = "stella-canvas-shares";
const KEY_PREFIX = "shares";
const CONTENT_TYPE = "text/html; charset=utf-8";
const CACHE_CONTROL = "public, max-age=300";
/** ~5 MB cap on a single published document. */
const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Default share lifetime: 90 days. */
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TITLE = 300;
const PURGE_BATCH = 200;
const PURGE_MAX_BATCHES = 10;
const PUBLICATION_LEASE_MS = 3 * 60_000;

type ShareR2Ref = {
  id: Id<"canvas_shares">;
  slug: string;
  r2Key: string;
  publicationState?: "uploading" | "published";
  publicationLeaseExpiresAt?: number;
  ownerUserId?: string;
  publicationGeneration?: string;
};

type StalePublicationRef = ShareR2Ref & {
  ownerUserId: string;
  publicationGeneration: string;
  publicationLeaseExpiresAt: number;
};

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

/** 128 bits of CSPRNG, base64url (~22 chars), unguessable. */
const generateSlug = (): string => randomBytes(16).toString("base64url");

/**
 * Publish a self-contained HTML document as a public canvas share.
 * Desktop calls `api.data.canvas_shares_actions.publish`.
 */
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
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerUserId,
    );
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
    const r2 = r2Credentials();
    const publicationId = await ctx.runMutation(
      internal.data.canvas_shares.reserveSharePublication,
      {
        slug,
        ownerUserId,
        ownerGeneration,
        r2Key,
        ...(title !== undefined ? { title } : {}),
        createdAt: now,
        publicationLeaseExpiresAt: now + PUBLICATION_LEASE_MS,
      },
    );

    let uploadAttempted = false;
    let uploadConfirmed = false;
    try {
      await ctx.runMutation(
        internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
        { ownerId: ownerUserId, ownerGeneration },
      );
      uploadAttempted = true;
      await uploadR2Object({
        key: r2Key,
        bytes: Buffer.from(html, "utf8"),
        contentType: CONTENT_TYPE,
        cacheControl: CACHE_CONTROL,
        metadata: {
          "expires-at": String(expiresAt),
          owner: ownerUserId,
        },
        r2,
      });
      uploadConfirmed = true;

      const published: boolean = await ctx.runMutation(
        internal.data.canvas_shares.finishSharePublication,
        {
          id: publicationId,
          ownerUserId,
          ownerGeneration,
          slug,
          r2Key,
          expiresAt,
        },
      );
      if (!published) {
        throw new Error("Canvas share publication reservation changed.");
      }
    } catch (error) {
      // An ambiguous PUT is treated as having materialized. Delete first; the
      // reservation remains as durable cleanup debt if that cannot be proven.
      try {
        await deleteR2Object({ key: r2Key, r2 });
        // A timed-out/failed PUT is ambiguous: its server-side write may
        // complete after this immediate DELETE. Retain the reservation until
        // its lease expires so the durable purge repeats the delete later.
        if (!uploadAttempted || uploadConfirmed) {
          await ctx.runMutation(
            internal.data.canvas_shares.deleteConfirmedSharePublication,
            {
              id: publicationId,
              ownerUserId,
              ownerGeneration,
              slug,
              r2Key,
            },
          );
        }
      } catch (cleanupError) {
        console.error(
          `[canvas_shares] Failed to clean publication ${slug}:`,
          cleanupError,
        );
      }
      throw error;
    }

    return { url: buildCanvasShareUrl(slug), slug, expiresAt };
  },
});

/**
 * Revoke a share the caller owns: delete the R2 object (what actually makes
 * the Worker 404) and mark the row revoked.
 * Desktop calls `api.data.canvas_shares_actions.revoke`.
 */
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
    // Do not distinguish "not found" from "not yours" to avoid leaking slugs.
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
  // Best-effort R2 cleanup; row deletion proceeds regardless so the purge
  // always terminates even if an individual object delete fails.
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

/**
 * Purge expired shares: delete the R2 object and remove the row. Bounded per
 * invocation; driven by the `crons.ts` interval.
 */
export const purgeExpiredShares = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx: ActionCtx, args) => {
    const batchSize = args.batchSize ?? PURGE_BATCH;
    const maxBatches = Math.min(
      Math.max(Math.floor(args.maxBatches ?? PURGE_MAX_BATCHES), 1),
      100,
    );
    let deleted = 0;
    for (let i = 0; i < maxBatches; i++) {
      const refs: ShareR2Ref[] = await ctx.runQuery(
        internal.data.canvas_shares.listExpiredBatch,
        { batchSize },
      );
      if (refs.length === 0) break;
      const stalePublications: StalePublicationRef[] = refs.flatMap((ref) =>
        ref.publicationState === "uploading" &&
        typeof ref.ownerUserId === "string" &&
        typeof ref.publicationGeneration === "string" &&
        typeof ref.publicationLeaseExpiresAt === "number"
          ? [
              {
                id: ref.id,
                slug: ref.slug,
                r2Key: ref.r2Key,
                ownerUserId: ref.ownerUserId,
                publicationGeneration: ref.publicationGeneration,
                publicationLeaseExpiresAt: ref.publicationLeaseExpiresAt,
              },
            ]
          : [],
      );
      const ordinary = refs.filter(
        (ref) => ref.publicationState !== "uploading",
      );
      // Ordinary expired public shares retain their historical best-effort
      // semantics. Ambiguous publication locators are stricter: object first,
      // exact row last, and any failure stays durable for the next cron.
      await deleteSharesR2(ordinary);
      await ctx.runMutation(internal.data.canvas_shares.deleteShareRows, {
        ids: ordinary.map((ref) => ref.id),
      });
      const r2 = r2Credentials();
      const settled = await Promise.allSettled(
        stalePublications.map((ref) => deleteR2Object({ key: ref.r2Key, r2 })),
      );
      const confirmed = stalePublications.filter(
        (_, index) => settled[index]?.status === "fulfilled",
      );
      await ctx.runMutation(
        internal.data.canvas_shares.deleteConfirmedStaleSharePublications,
        { refs: confirmed, now: Date.now() },
      );
      deleted += ordinary.length + confirmed.length;
      if (
        stalePublications.length !==
        refs.filter((ref) => ref.publicationState === "uploading").length
      ) {
        // Malformed legacy debt is retained rather than silently unlinked.
        break;
      }
      if (confirmed.length !== stalePublications.length) break;
      if (refs.length < batchSize) break;
    }
    return { deleted };
  },
});

/**
 * Delete all of an owner's shares (R2 objects + rows). Invoked from the
 * account-deletion cleanup (`account_deletion.purgeOwnerCloudData`).
 */
export const purgeOwnerShares = internalAction({
  args: {
    ownerUserId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: v.union(v.literal("reset"), v.literal("delete")),
  },
  returns: v.null(),
  handler: async (
    ctx: ActionCtx,
    { ownerUserId, operationId, generation, leaseId, mode },
  ) => {
    while (true) {
      const refs: ShareR2Ref[] = await ctx.runQuery(
        internal.data.canvas_shares.listOwnerBatch,
        { ownerUserId, batchSize: PURGE_BATCH },
      );
      if (refs.length === 0) break;
      const now = Date.now();
      const activePublications = refs.filter(
        (ref) =>
          ref.publicationState === "uploading" &&
          (ref.publicationLeaseExpiresAt ?? 0) > now,
      );
      const eligible = refs.filter(
        (ref) => !activePublications.some((active) => active.id === ref.id),
      );
      await ctx.runMutation(
        internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
        {
          ownerId: ownerUserId,
          operationId,
          generation,
          stage: "core",
          leaseId,
          mode,
          now: Date.now(),
        },
      );
      const r2 = r2Credentials();
      const settled = await Promise.allSettled(
        eligible.map((ref) => deleteR2Object({ key: ref.r2Key, r2 })),
      );
      const confirmed = eligible.filter(
        (_, index) => settled[index]?.status === "fulfilled",
      );
      await ctx.runMutation(
        internal.data.canvas_shares.deleteConfirmedOwnerShareRows,
        {
          ownerId: ownerUserId,
          operationId,
          generation,
          leaseId,
          mode,
          refs: confirmed,
        },
      );
      if (
        activePublications.length > 0 ||
        confirmed.length !== eligible.length
      ) {
        throw new Error(
          "Owner data purge is waiting for canvas publication/object deletion; locator rows were retained for retry.",
        );
      }
      if (refs.length < PURGE_BATCH) break;
    }
    return null;
  },
});
