import { renderXBotCard } from "./card";
import {
  buildXBotPrompt,
  isXAccountYoungerThanMinimum,
  parseXBotPromoterUsernames,
  resolveXBotPageHandle,
  type XBotExchange,
  type XBotMention,
} from "./mentions";
import { generateReplyPlan } from "./plan";
import {
  createReply,
  fetchParentPost,
  uploadImage,
  xCredentials,
} from "./x-api";

// One x_bot_runs row per admitted mention. status: pending (admitted, or a
// retryable failure before posting) -> posting (the X reply call is in
// flight; never retried, so a crash cannot double-post) -> replied | failed.
// updated_at doubles as the lease: a pending row is claimed again only after
// RETRY_AFTER_MS without progress.
const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 2 * 60_000;
const AUTHOR_DAILY_LIMIT = 10;
const GLOBAL_DAILY_LIMIT = 500;
const PAGE_RUN_LIMIT = 20;
const RETRY_BATCH = 20;

export const cardKey = (mentionId: string) => `x-bot/${mentionId}.png`;

const utcDayStart = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

export type Admission =
  | "scheduled"
  | "duplicate"
  | "young_account"
  | "author_limit"
  | "global_limit";

// The per-author and global daily allowance is a count over today's rows.
export const admitMention = async (
  env: Env,
  mention: XBotMention,
  now: number,
): Promise<Admission> => {
  const existing = await env.DB.prepare(
    "SELECT 1 FROM x_bot_runs WHERE mention_id = ?",
  )
    .bind(mention.id)
    .first();
  if (existing) return "duplicate";
  if (isXAccountYoungerThanMinimum(mention.authorCreatedAt, now)) {
    return "young_account";
  }
  const dayStart = utcDayStart(now);
  const [author, global] = await env.DB.batch<{ n: number }>([
    env.DB.prepare(
      "SELECT count(*) AS n FROM x_bot_runs WHERE author_id = ? AND created_at >= ?",
    ).bind(mention.authorId, dayStart),
    env.DB.prepare(
      "SELECT count(*) AS n FROM x_bot_runs WHERE created_at >= ?",
    ).bind(dayStart),
  ]);
  if ((author.results[0]?.n ?? 0) >= AUTHOR_DAILY_LIMIT) return "author_limit";
  if ((global.results[0]?.n ?? 0) >= GLOBAL_DAILY_LIMIT) return "global_limit";
  const inserted = await env.DB.prepare(
    `INSERT INTO x_bot_runs
       (mention_id, status, attempts, mention_json, author_id, parent_id,
        summoner_username, created_at, updated_at)
     VALUES (?, 'pending', 0, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (mention_id) DO NOTHING`,
  )
    .bind(
      mention.id,
      JSON.stringify(mention),
      mention.authorId,
      mention.parentId,
      mention.authorUsername,
      now,
      now,
    )
    .run();
  return inserted.meta.changes === 1 ? "scheduled" : "duplicate";
};

export const processRun = async (
  env: Env,
  mentionId: string,
): Promise<void> => {
  const startedAt = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE x_bot_runs SET attempts = attempts + 1, updated_at = ?
     WHERE mention_id = ? AND status = 'pending' AND attempts < ?
       AND (attempts = 0 OR updated_at < ?)
     RETURNING mention_json`,
  )
    .bind(startedAt, mentionId, MAX_ATTEMPTS, startedAt - RETRY_AFTER_MS)
    .first<{ mention_json: string }>();
  if (!claimed) return;
  const mention = JSON.parse(claimed.mention_json) as XBotMention;
  const dryRun = env.X_BOT_DRY_RUN.trim() === "1";

  try {
    const credentials = xCredentials(env);
    const parent = await fetchParentPost(mention.parentId, credentials);
    const { handle, isPromoterSummon } = resolveXBotPageHandle(
      mention,
      parent,
      parseXBotPromoterUsernames(env.X_BOT_PROMOTER_USERNAMES),
    );
    const plan = await generateReplyPlan(
      env,
      buildXBotPrompt(mention, parent, { addressee: handle }),
    );

    let mediaId: string | null = null;
    let imageKey: string | null = null;
    try {
      const png = await renderXBotCard({
        headline: plan.headline,
        handle,
        exchanges: plan.exchanges,
      });
      const key = cardKey(mention.id);
      [mediaId] = await Promise.all([
        dryRun ? null : uploadImage(png, credentials),
        env.MEDIA.put(key, png, {
          httpMetadata: { contentType: "image/png" },
        }),
      ]);
      imageKey = key;
    } catch (error) {
      // The image carries the address, so a reply without it is worth less,
      // but a summon left unanswered is worse. Post the text and log loudly.
      console.error("x_bot_card_failed", {
        mentionId: mention.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let replyId: string | null = null;
    if (dryRun) {
      console.info("x_bot_dry_run_reply", {
        mentionId: mention.id,
        handle,
        reply: plan.reply,
        headline: plan.headline,
        withImage: imageKey !== null,
      });
    } else {
      await env.DB.prepare(
        "UPDATE x_bot_runs SET status = 'posting', updated_at = ? WHERE mention_id = ?",
      )
        .bind(Date.now(), mention.id)
        .run();
      replyId = await createReply(mention.id, plan.reply, mediaId, credentials);
    }

    await recordReplied(env, mention.id, {
      handle,
      posterUsername: parent.authorUsername,
      replyId,
      headline: plan.headline,
      reply: plan.reply,
      exchanges: plan.exchanges,
      imageKey,
    });
    console.info("x_bot_reply_created", {
      mentionId: mention.id,
      parentId: mention.parentId,
      replyId,
      handle,
      isPromoterSummon,
      dryRun,
      withImage: mediaId !== null || (dryRun && imageKey !== null),
      replyCharacters: Array.from(plan.reply).length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("x_bot_run_failed", {
      mentionId: mention.id,
      error: message,
    });
    await env.DB.prepare(
      `UPDATE x_bot_runs
       SET status = CASE WHEN status = 'posting' OR attempts >= ? THEN 'failed' ELSE 'pending' END,
           error = ?, updated_at = ?
       WHERE mention_id = ?`,
    )
      .bind(MAX_ATTEMPTS, message.slice(0, 1000), Date.now(), mention.id)
      .run();
  }
};

const recordReplied = async (
  env: Env,
  mentionId: string,
  row: {
    handle: string;
    posterUsername: string;
    replyId: string | null;
    headline: string;
    reply: string;
    exchanges: XBotExchange[];
    imageKey: string | null;
  },
): Promise<void> => {
  await env.DB.prepare(
    `UPDATE x_bot_runs
     SET status = 'replied', handle = ?, handle_display = ?, poster_username = ?,
         reply_id = ?, headline = ?, reply = ?, exchanges_json = ?, image_key = ?,
         error = NULL, updated_at = ?
     WHERE mention_id = ?`,
  )
    .bind(
      row.handle.toLowerCase(),
      row.handle,
      row.posterUsername,
      row.replyId,
      row.headline,
      row.reply,
      JSON.stringify(row.exchanges),
      row.imageKey,
      Date.now(),
      mentionId,
    )
    .run();
};

// Cron: retry pending runs whose waitUntil died or failed before posting.
export const retryPendingRuns = async (
  env: Env,
  now: number,
): Promise<void> => {
  const cutoff = now - RETRY_AFTER_MS;
  await env.DB.prepare(
    `UPDATE x_bot_runs SET status = 'failed', error = coalesce(error, 'retries exhausted'), updated_at = ?
     WHERE status = 'pending' AND attempts >= ? AND updated_at < ?`,
  )
    .bind(now, MAX_ATTEMPTS, cutoff)
    .run();
  const { results } = await env.DB.prepare(
    `SELECT mention_id FROM x_bot_runs
     WHERE status = 'pending' AND updated_at < ?
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(cutoff, RETRY_BATCH)
    .all<{ mention_id: string }>();
  if (results.length > 0) {
    console.info("x_bot_retrying_runs", { count: results.length });
  }
  for (const { mention_id } of results) {
    await processRun(env, mention_id);
  }
};

export type XBotPageRun = {
  id: string;
  mentionId: string;
  replyId: string | null;
  summonerUsername: string;
  posterUsername: string;
  headline: string;
  reply: string;
  exchanges: XBotExchange[];
  imageUrl: string | null;
  createdAt: number;
};

type PageRow = {
  mention_id: string;
  handle_display: string;
  reply_id: string | null;
  summoner_username: string;
  poster_username: string;
  headline: string;
  reply: string;
  exchanges_json: string;
  image_key: string | null;
  created_at: number;
};

export const readPage = async (
  env: Env,
  handle: string,
  origin: string,
): Promise<{ handle: string | null; runs: XBotPageRun[] }> => {
  const { results } = await env.DB.prepare(
    `SELECT mention_id, handle_display, reply_id, summoner_username, poster_username,
            headline, reply, exchanges_json, image_key, created_at
     FROM x_bot_runs WHERE handle = ? AND status = 'replied'
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(handle.toLowerCase(), PAGE_RUN_LIMIT)
    .all<PageRow>();
  return {
    handle: results[0]?.handle_display ?? null,
    runs: results.map((row) => ({
      id: row.mention_id,
      mentionId: row.mention_id,
      replyId: row.reply_id,
      summonerUsername: row.summoner_username,
      posterUsername: row.poster_username,
      headline: row.headline,
      reply: row.reply,
      exchanges: JSON.parse(row.exchanges_json) as XBotExchange[],
      imageUrl: row.image_key
        ? `${origin}/card/${encodeURIComponent(row.mention_id)}.png`
        : null,
      createdAt: row.created_at,
    })),
  };
};
