import { RpcError } from "./errors.js";
import type { OwnerDb } from "./registry.js";

export const RATE_LIMIT_MIGRATION = {
  id: "platform.2-rate-limits",
  statements: [
    `CREATE TABLE owner_rate_limits (
       scope TEXT PRIMARY KEY,
       window_start INTEGER NOT NULL,
       count INTEGER NOT NULL
     )`,
  ],
};

/**
 * A fixed-window limit on one owner action. Throws `RATE_LIMITED` with the
 * wait until the window resets.
 */
export const enforceOwnerRateLimit = (
  db: OwnerDb,
  now: number,
  scope: string,
  limit: { count: number; windowMs: number },
  message: string,
): void => {
  const row = db.one<{ window_start: number; count: number }>(
    "SELECT window_start, count FROM owner_rate_limits WHERE scope = ?",
    scope,
  );
  if (row && now - row.window_start < limit.windowMs) {
    if (row.count >= limit.count) {
      throw new RpcError("RATE_LIMITED", message, {
        retryAfterMs: row.window_start + limit.windowMs - now,
      });
    }
    db.run("UPDATE owner_rate_limits SET count = count + 1 WHERE scope = ?", scope);
    return;
  }
  db.run(
    `INSERT INTO owner_rate_limits (scope, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (scope) DO UPDATE SET window_start = excluded.window_start, count = 1`,
    scope,
    now,
  );
};
