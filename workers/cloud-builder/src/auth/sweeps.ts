/**
 * The Cron Trigger's identity sweeps (src/cron.ts).
 *
 * - Expired rows: Better Auth's verification values and sessions, its rate
 *   limit counters, the handoff tables and integrity nonces.
 * - Stale anonymous users: no live session and no update for 30 days. Each
 *   one's owner object is closed (which purges its data), then the user row
 *   goes, taking its sessions and accounts with it.
 */

const DAY_MS = 24 * 60 * 60_000;
const ANONYMOUS_STALE_MS = 30 * DAY_MS;
/** Upper bound on anonymous users one run closes; the next run takes the rest. */
const ANONYMOUS_PER_RUN = 50;

type SweepEnv = Pick<Cloudflare.Env, "DB" | "OWNER_GATES">;

const db = (env: SweepEnv): D1Database => {
  if (!env.DB) throw new Error("D1 is not bound.");
  return env.DB;
};

export const sweepAuthTables = async (env: SweepEnv, now = Date.now()): Promise<void> => {
  const nowIso = new Date(now).toISOString();
  await db(env).batch([
    db(env).prepare('DELETE FROM "verification" WHERE "expiresAt" < ?').bind(nowIso),
    db(env).prepare('DELETE FROM "session" WHERE "expiresAt" < ?').bind(nowIso),
    db(env).prepare('DELETE FROM "rateLimit" WHERE "lastRequest" < ?').bind(now - DAY_MS),
    db(env).prepare("DELETE FROM auth_link_requests WHERE expires_at < ?").bind(now),
    db(env).prepare("DELETE FROM auth_browser_handoffs WHERE expires_at < ?").bind(now),
    db(env).prepare("DELETE FROM integrity_nonces WHERE expires_at < ?").bind(now),
  ]);
};

export const sweepAnonymousUsers = async (env: SweepEnv, now = Date.now()): Promise<void> => {
  const nowIso = new Date(now).toISOString();
  const { results } = await db(env)
    .prepare(
      `SELECT u."id" AS id FROM "user" u
        WHERE u."isAnonymous" = 1 AND u."updatedAt" < ?
          AND NOT EXISTS (SELECT 1 FROM "session" s WHERE s."userId" = u."id" AND s."expiresAt" > ?)
        LIMIT ?`,
    )
    .bind(new Date(now - ANONYMOUS_STALE_MS).toISOString(), nowIso, ANONYMOUS_PER_RUN)
    .all<{ id: string }>();
  let closed = 0;
  for (const { id } of results) {
    try {
      await env.OWNER_GATES.getByName(id).closeOwner();
      await db(env).prepare('DELETE FROM "user" WHERE "id" = ?').bind(id).run();
      closed += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "anonymous_user_close_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  if (results.length > 0) console.log(JSON.stringify({ event: "anonymous_users_closed", closed }));
};
