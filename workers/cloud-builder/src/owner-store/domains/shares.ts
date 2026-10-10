/**
 * Canvas shares: a self-contained HTML document published to the
 * `CANVAS_SHARES` bucket at `shares/<slug>.html`, which `workers/canvas-share`
 * serves at `<CANVAS_SHARE_BASE_URL>/c/<slug>`.
 *
 * A canvas the `html` tool writes is saved to one link per canvas slug
 * (`canvas`), private until its owner makes it public. A private object
 * carries its owner's tag and `visibility: private` in its metadata, and the
 * serving worker opens it only for a browser holding that owner's view cookie,
 * which it trades for a grant from `shares.viewLink`
 * (`workers/shared/canvas-view-grant.ts`). R2 metadata cannot change in place,
 * so a visibility change rewrites the object.
 *
 * The row is the owner's locator for the object. It is written before the
 * object, so every object that may exist has a row, and each row has a
 * `shares.expire` job at its expiry. Revoke, expiry and purge delete the
 * object first and the row after, so a failed delete keeps its locator for
 * the retry. The object also carries its expiry, so the serving worker 404s
 * it on time even if the job is late.
 */

import {
  SHARE_CANVAS_PATTERN,
  SHARE_MAX_HTML_BYTES,
  SHARE_MAX_TITLE_CHARS,
  type PublishedShare,
  type SavedCanvasShare,
  type ShareLink,
  type ShareVisibility,
} from "@stella/contracts/backend/shares";
import { buildCanvasShareUrl, readCanvasShareBaseUrl } from "@stella/contracts/canvas-share";
import {
  CANVAS_VIEW_GRANT_PARAM,
  CANVAS_VIEW_GRANT_TTL_MS,
  canvasOwnerTag,
  signCanvasViewToken,
} from "../../../../shared/canvas-view-grant.js";
import { empty, literal, object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";

const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LIST_LIMIT = 100;
const PURGE_BATCH = 1_000;
const EXPIRE_JOB = "shares.expire";
const RATE_LIMIT = { count: 20, windowMs: 60_000 };
/** Every canvas the agent writes saves here, so this one is roomier. */
const SAVE_RATE_LIMIT = { count: 60, windowMs: 60_000 };

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

/** One link per canvas, and whether anyone but the owner may open it. */
export const SHARES_CANVAS_MIGRATION = {
  id: "shares.2-canvas-visibility",
  statements: [
    "ALTER TABLE shares ADD COLUMN canvas TEXT",
    "ALTER TABLE shares ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'",
    "CREATE UNIQUE INDEX shares_by_canvas ON shares (canvas) WHERE canvas IS NOT NULL",
  ],
};

type ShareRow = {
  slug: string;
  title: string | null;
  r2_key: string;
  created_at: number;
  expires_at: number;
  canvas: string | null;
  visibility: string;
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

const viewSecretOf = (env: Cloudflare.Env): string | null => {
  const value = (env as unknown as Record<string, unknown>).CANVAS_SHARE_VIEW_SECRET;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
};

const keyForSlug = (slug: string): string => `shares/${slug}.html`;

const visibilityOf = (row: Pick<ShareRow, "visibility">): ShareVisibility =>
  row.visibility === "private" ? "private" : "public";

const validateDocument = (html: string, rawTitle: string | undefined) => {
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength === 0) throw new RpcError("BAD_REQUEST", "Canvas HTML is required.");
  if (bytes.byteLength > SHARE_MAX_HTML_BYTES) {
    throw new RpcError(
      "BAD_REQUEST",
      `Canvas HTML exceeds the ${SHARE_MAX_HTML_BYTES / (1024 * 1024)}MB limit.`,
    );
  }
  const title = rawTitle?.trim() || null;
  if (title && title.length > SHARE_MAX_TITLE_CHARS) {
    throw new RpcError("BAD_REQUEST", `Titles are limited to ${SHARE_MAX_TITLE_CHARS} characters.`);
  }
  return { bytes, title };
};

/** Write a share's bytes with the metadata the serving worker enforces. */
const putObject = async (
  ctx: OwnerContext,
  key: string,
  body: Uint8Array | ArrayBuffer,
  options: { expiresAt: number; visibility: ShareVisibility },
): Promise<void> => {
  await bucketOf(ctx.env).put(key, body, {
    httpMetadata: {
      contentType: "text/html; charset=utf-8",
      cacheControl: options.visibility === "public" ? "public, max-age=300" : "private, no-store",
    },
    customMetadata: {
      "expires-at": String(options.expiresAt),
      visibility: options.visibility,
      owner: await canvasOwnerTag(ctx.ownerId),
    },
  });
};

const toLink = (base: string, row: ShareRow): ShareLink => ({
  slug: row.slug,
  url: buildCanvasShareUrl(base, row.slug),
  title: row.title,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  visibility: visibilityOf(row),
  canvas: row.canvas,
});

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
      // Public links only: private ones are every canvas the agent wrote,
      // reached one at a time through `shares.canvas`.
      "SELECT * FROM shares WHERE expires_at > ? AND visibility = 'public' ORDER BY created_at DESC LIMIT ?",
      now,
      LIST_LIMIT,
    )
    .map((row) => toLink(base, row));
};

const readCanvasShare = (
  db: OwnerDbReader,
  env: Cloudflare.Env,
  now: number,
  canvas: string,
): ShareLink | null => {
  const row = db.one<ShareRow>(
    "SELECT * FROM shares WHERE canvas = ? AND expires_at > ?",
    canvas,
    now,
  );
  return row ? toLink(baseUrlOf(env), row) : null;
};

const publish = async (
  ctx: OwnerContext,
  args: { html: string; title?: string },
): Promise<PublishedShare> => {
  bucketOf(ctx.env);
  const base = baseUrlOf(ctx.env);
  const { bytes, title } = validateDocument(args.html, args.title);
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
    "INSERT INTO shares (slug, title, r2_key, created_at, expires_at, visibility) VALUES (?, ?, ?, ?, ?, 'public')",
    slug,
    title,
    key,
    ctx.now,
    expiresAt,
  );
  ctx.jobs.schedule(EXPIRE_JOB, expiresAt, { slug }, { id: expireJobId(slug) });
  try {
    await putObject(ctx, key, bytes, { expiresAt, visibility: "public" });
  } catch (error) {
    await forgetFailedPut(ctx, slug, key, error);
    throw unavailable();
  }
  return { url: buildCanvasShareUrl(base, slug), slug, expiresAt };
};

/**
 * After a failed first put of a new link. The put may still have landed:
 * without a confirmed delete the row stays as the locator and its expiry job
 * removes the object.
 */
const forgetFailedPut = async (
  ctx: OwnerContext,
  slug: string,
  key: string,
  error: unknown,
): Promise<void> => {
  console.error(JSON.stringify({
    event: "share_publish_failed",
    message: error instanceof Error ? error.message : String(error),
  }));
  try {
    await bucketOf(ctx.env).delete(key);
    dropRow(ctx, slug);
  } catch {
    // Kept for the expiry job.
  }
};

/**
 * Save a canvas to its link: the first save creates it (private unless told
 * otherwise), later saves rewrite the same object, so the URL a user already
 * has shows the latest canvas. Each save pushes expiry out again.
 */
const save = async (
  ctx: OwnerContext,
  args: { canvas: string; html: string; title?: string; visibility?: ShareVisibility },
): Promise<SavedCanvasShare> => {
  bucketOf(ctx.env);
  const base = baseUrlOf(ctx.env);
  const { bytes, title } = validateDocument(args.html, args.title);
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "shares.save",
    SAVE_RATE_LIMIT,
    "Too many canvases saved. Please wait a moment.",
  );
  const expiresAt = ctx.now + SHARE_TTL_MS;
  const existing = ctx.db.one<ShareRow>("SELECT * FROM shares WHERE canvas = ?", args.canvas);

  if (existing) {
    const visibility = args.visibility ?? visibilityOf(existing);
    // Row and job first: an object whose put fails keeps its older expiry
    // metadata, which the serving worker enforces on its own.
    ctx.db.run(
      "UPDATE shares SET title = ?, expires_at = ? WHERE slug = ?",
      title ?? existing.title,
      expiresAt,
      existing.slug,
    );
    ctx.jobs.schedule(EXPIRE_JOB, expiresAt, { slug: existing.slug }, { id: expireJobId(existing.slug) });
    try {
      await putObject(ctx, existing.r2_key, bytes, { expiresAt, visibility });
    } catch (error) {
      console.error(JSON.stringify({
        event: "share_save_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
      throw unavailable();
    }
    if (visibility !== visibilityOf(existing)) {
      ctx.db.run("UPDATE shares SET visibility = ? WHERE slug = ?", visibility, existing.slug);
    }
    return { url: buildCanvasShareUrl(base, existing.slug), slug: existing.slug, visibility, expiresAt };
  }

  const visibility = args.visibility ?? "private";
  const slug = generateSlug();
  const key = keyForSlug(slug);
  ctx.db.run(
    `INSERT INTO shares (slug, title, r2_key, created_at, expires_at, canvas, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    slug,
    title,
    key,
    ctx.now,
    expiresAt,
    args.canvas,
    visibility,
  );
  ctx.jobs.schedule(EXPIRE_JOB, expiresAt, { slug }, { id: expireJobId(slug) });
  try {
    await putObject(ctx, key, bytes, { expiresAt, visibility });
  } catch (error) {
    await forgetFailedPut(ctx, slug, key, error);
    throw unavailable();
  }
  return { url: buildCanvasShareUrl(base, slug), slug, visibility, expiresAt };
};

/** Make a link public or private. The object is rewritten with the new metadata. */
const setVisibility = async (
  ctx: OwnerContext,
  args: { slug: string; visibility: ShareVisibility },
): Promise<SavedCanvasShare> => {
  const base = baseUrlOf(ctx.env);
  const bucket = bucketOf(ctx.env);
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "shares.visibility",
    RATE_LIMIT,
    "Too many changes to shares. Please wait a moment.",
  );
  const row = ctx.db.one<ShareRow>(
    "SELECT * FROM shares WHERE slug = ? AND expires_at > ?",
    args.slug,
    ctx.now,
  );
  if (!row) throw new RpcError("NOT_FOUND", "Share not found.");
  const result = (visibility: ShareVisibility): SavedCanvasShare => ({
    url: buildCanvasShareUrl(base, row.slug),
    slug: row.slug,
    visibility,
    expiresAt: row.expires_at,
  });
  if (visibilityOf(row) === args.visibility) return result(args.visibility);

  const object = await bucket.get(row.r2_key);
  if (!object) {
    // The bytes are gone (expired early or deleted); so is the link.
    dropRow(ctx, row.slug);
    throw new RpcError("NOT_FOUND", "Share not found.");
  }
  const body = await object.arrayBuffer();
  try {
    await putObject(ctx, row.r2_key, body, { expiresAt: row.expires_at, visibility: args.visibility });
  } catch (error) {
    console.error(JSON.stringify({
      event: "share_visibility_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    throw unavailable();
  }
  ctx.db.run("UPDATE shares SET visibility = ? WHERE slug = ?", args.visibility, row.slug);
  return result(args.visibility);
};

/**
 * A browser URL for the owner's own link. A private link carries a short grant
 * the serving worker trades for a view cookie; a public one needs none.
 */
const viewLink = async (ctx: OwnerContext, args: { slug: string }): Promise<{ url: string }> => {
  const base = baseUrlOf(ctx.env);
  const row = ctx.db.one<ShareRow>(
    "SELECT * FROM shares WHERE slug = ? AND expires_at > ?",
    args.slug,
    ctx.now,
  );
  if (!row) throw new RpcError("NOT_FOUND", "Share not found.");
  const url = buildCanvasShareUrl(base, row.slug);
  if (visibilityOf(row) === "public") return { url };
  const secret = viewSecretOf(ctx.env);
  if (!secret) throw unavailable();
  const grant = await signCanvasViewToken(secret, {
    k: "grant",
    o: await canvasOwnerTag(ctx.ownerId),
    s: row.slug,
    e: ctx.now + CANVAS_VIEW_GRANT_TTL_MS,
  });
  return { url: `${url}?${CANVAS_VIEW_GRANT_PARAM}=${encodeURIComponent(grant)}` };
};

const saveArgs = object({
  canvas: string({ min: 1, max: 64, pattern: SHARE_CANVAS_PATTERN }),
  html: string({ max: SHARE_MAX_HTML_BYTES }),
  title: optional(string({ max: SHARE_MAX_TITLE_CHARS * 4 })),
  visibility: optional(literal("private", "public")),
});

/** `shares.save` for this Worker's own cloud `html` tool. */
const saveFromCloud = (ctx: OwnerContext, raw: unknown): Promise<SavedCanvasShare> =>
  save(ctx, saveArgs(raw));

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
  migrations: [SHARES_MIGRATION, SHARES_CANVAS_MIGRATION],
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
    "shares.save": {
      scope: "owner",
      requireAccount: true,
      maxBodyBytes: SHARE_MAX_HTML_BYTES * 2,
      parse: saveArgs,
      handler: save,
    },
    "shares.setVisibility": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        slug: string({ min: 1, max: 128 }),
        visibility: literal("private", "public"),
      }),
      handler: setVisibility,
    },
    "shares.viewLink": {
      scope: "owner",
      requireAccount: true,
      parse: object({ slug: string({ min: 1, max: 128 }) }),
      handler: viewLink,
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
    "shares.canvas": {
      parse: object({ canvas: string({ min: 1, max: 64, pattern: SHARE_CANVAS_PATTERN }) }),
      read: (ctx, args) => readCanvasShare(ctx.db, ctx.env, ctx.now, args.canvas),
    },
  },
  internal: {
    "shares.saveCanvas": saveFromCloud,
  },
  jobs: {
    [EXPIRE_JOB]: { run: expire },
  },
  purge: (ctx: OwnerContext) => purgeShares(ctx),
} satisfies OwnerDomain;
