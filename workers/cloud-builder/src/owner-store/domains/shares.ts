/**
 * Canvas shares: a self-contained HTML document published to the
 * `CANVAS_SHARES` bucket at `shares/<slug>.html`, which `workers/canvas-share`
 * serves publicly at `<CANVAS_SHARE_BASE_URL>/c/<slug>`.
 *
 * The row is the owner's locator for the object. It is written before the
 * object, so every object that may exist has a row, and each row has a
 * `shares.expire` job at its expiry. Revoke, expiry and purge delete the
 * object first and the row after, so a failed delete keeps its locator for
 * the retry. The object also carries its expiry, so the serving worker 404s
 * it on time even if the job is late.
 */

import {
  SHARE_MAX_HTML_BYTES,
  SHARE_MAX_TITLE_CHARS,
  type PublishedShare,
  type ShareLink,
} from "@stella/contracts/backend/shares";
import { buildCanvasShareUrl, readCanvasShareBaseUrl } from "@stella/contracts/canvas-share";
import { empty, object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";

const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LIST_LIMIT = 100;
const PURGE_BATCH = 1_000;
const EXPIRE_JOB = "shares.expire";
const RATE_LIMIT = { count: 20, windowMs: 60_000 };

export const SHARES_MIGRATION = {
  id: "shares.1-init",
  statements: [
    `CREATE TABLE shares (
       slug TEXT PRIMARY KEY,
       title TEXT,
       r2_key TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
  ],
};

type ShareRow = {
  slug: string;
  title: string | null;
  r2_key: string;
  created_at: number;
  expires_at: number;
};

const unavailable = () =>
  new RpcError("UNAVAILABLE", "Sharing is unavailable right now. Try again shortly.", {
    retryAfterMs: 5_000,
  });

const bucketOf = (env: Cloudflare.Env): R2Bucket => {
  if (!env.CANVAS_SHARES) throw unavailable();
  return env.CANVAS_SHARES;
};

const baseUrlOf = (env: Cloudflare.Env): string => {
  const base = readCanvasShareBaseUrl(env.CANVAS_SHARE_BASE_URL);
  if (!base) throw unavailable();
  return base;
};

const keyForSlug = (slug: string): string => `shares/${slug}.html`;

/** 128 bits of CSPRNG as base64url (22 characters): public and unguessable. */
const generateSlug = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const expireJobId = (slug: string): string => `${EXPIRE_JOB}:${slug}`;

const dropRow = (ctx: OwnerContext, slug: string): void => {
  ctx.db.run("DELETE FROM shares WHERE slug = ?", slug);
  ctx.jobs.cancel(expireJobId(slug));
};

const listShares = (db: OwnerDbReader, env: Cloudflare.Env, now: number): ShareLink[] => {
  const base = baseUrlOf(env);
  return db
    .all<ShareRow>(
      "SELECT * FROM shares WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?",
      now,
      LIST_LIMIT,
    )
    .map((row) => ({
      slug: row.slug,
      url: buildCanvasShareUrl(base, row.slug),
      title: row.title,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
};

const publish = async (
  ctx: OwnerContext,
  args: { html: string; title?: string },
): Promise<PublishedShare> => {
  const bucket = bucketOf(ctx.env);
  const base = baseUrlOf(ctx.env);
  const bytes = new TextEncoder().encode(args.html);
  if (bytes.byteLength === 0) throw new RpcError("BAD_REQUEST", "Canvas HTML is required.");
  if (bytes.byteLength > SHARE_MAX_HTML_BYTES) {
    throw new RpcError(
      "BAD_REQUEST",
      `Canvas HTML exceeds the ${SHARE_MAX_HTML_BYTES / (1024 * 1024)}MB limit.`,
    );
  }
  const title = args.title?.trim() || null;
  if (title && title.length > SHARE_MAX_TITLE_CHARS) {
    throw new RpcError("BAD_REQUEST", `Titles are limited to ${SHARE_MAX_TITLE_CHARS} characters.`);
  }
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "shares.publish",
    RATE_LIMIT,
    "Too many shares. Please wait a moment.",
  );

  const slug = generateSlug();
  const key = keyForSlug(slug);
  const expiresAt = ctx.now + SHARE_TTL_MS;
  ctx.db.run(
    "INSERT INTO shares (slug, title, r2_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    slug,
    title,
    key,
    ctx.now,
    expiresAt,
  );
  ctx.jobs.schedule(EXPIRE_JOB, expiresAt, { slug }, { id: expireJobId(slug) });
  try {
    await bucket.put(key, bytes, {
      httpMetadata: {
        contentType: "text/html; charset=utf-8",
        cacheControl: "public, max-age=300",
      },
      customMetadata: { "expires-at": String(expiresAt) },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "share_publish_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    // The put may still have landed. Without a confirmed delete the row stays
    // as the locator and its expiry job removes the object.
    try {
      await bucket.delete(key);
      dropRow(ctx, slug);
    } catch {
      // Kept for the expiry job.
    }
    throw unavailable();
  }
  return { url: buildCanvasShareUrl(base, slug), slug, expiresAt };
};

const revoke = async (ctx: OwnerContext, args: { slug: string }): Promise<{ revoked: true }> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "shares.revoke",
    RATE_LIMIT,
    "Too many changes to shares. Please wait a moment.",
  );
  const row = ctx.db.one<{ r2_key: string }>("SELECT r2_key FROM shares WHERE slug = ?", args.slug);
  if (!row) throw new RpcError("NOT_FOUND", "Share not found.");
  await bucketOf(ctx.env).delete(row.r2_key);
  dropRow(ctx, args.slug);
  return { revoked: true };
};

/** At a share's expiry: delete its object, then its row. A failed delete retries. */
const expire = async (ctx: OwnerContext, payload: unknown): Promise<void> => {
  const slug = (payload as { slug?: unknown } | null)?.slug;
  if (typeof slug !== "string") return;
  const row = ctx.db.one<{ r2_key: string }>("SELECT r2_key FROM shares WHERE slug = ?", slug);
  if (!row) return;
  await bucketOf(ctx.env).delete(row.r2_key);
  ctx.db.run("DELETE FROM shares WHERE slug = ?", slug);
};

/** Reset or deletion: every object, then its row and job, a batch at a time. */
const purgeShares = async (ctx: OwnerContext): Promise<{ pending: boolean }> => {
  const rows = ctx.db.all<{ slug: string; r2_key: string }>(
    "SELECT slug, r2_key FROM shares LIMIT ?",
    PURGE_BATCH,
  );
  if (rows.length === 0) return { pending: false };
  await bucketOf(ctx.env).delete(rows.map((row) => row.r2_key));
  for (const row of rows) dropRow(ctx, row.slug);
  return { pending: rows.length === PURGE_BATCH };
};

export const sharesDomain = {
  name: "shares",
  migrations: [SHARES_MIGRATION],
  calls: {
    "shares.publish": {
      scope: "owner",
      requireAccount: true,
      // JSON-escaped HTML runs larger than its byte cap.
      maxBodyBytes: SHARE_MAX_HTML_BYTES * 2,
      parse: object({
        html: string({ max: SHARE_MAX_HTML_BYTES }),
        title: optional(string({ max: SHARE_MAX_TITLE_CHARS * 4 })),
      }),
      handler: publish,
    },
    "shares.revoke": {
      scope: "owner",
      requireAccount: true,
      parse: object({ slug: string({ min: 1, max: 128 }) }),
      handler: revoke,
    },
  },
  views: {
    "shares.list": {
      parse: empty(),
      read: (ctx) => listShares(ctx.db, ctx.env, ctx.now),
    },
  },
  jobs: {
    [EXPIRE_JOB]: { run: expire },
  },
  purge: (ctx: OwnerContext) => purgeShares(ctx),
} satisfies OwnerDomain;
