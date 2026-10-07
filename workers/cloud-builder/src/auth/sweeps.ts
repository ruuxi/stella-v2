/**
 * The Cron Trigger's identity sweep (src/cron.ts): expired rows. Better
 * Auth's verification values and sessions, its rate limit counters, the
 * handoff tables and integrity nonces.
 */

const DAY_MS = 24 * 60 * 60_000;

type SweepEnv = Pick<Cloudflare.Env, "DB">;

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
