import { DurableObject } from "cloudflare:workers";
import type { AppsHostUntrustedEnv } from "./config";

const WINDOW_MS = 60_000;
const MAX_FETCHES_PER_WINDOW = 60;

export class AppFetchGate extends DurableObject<AppsHostUntrustedEnv> {
  constructor(ctx: DurableObjectState, env: AppsHostUntrustedEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consumed_capabilities (
          token_id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rate_window (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          window_started_at INTEGER NOT NULL,
          count INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (1, ${Date.now()});
      `);
    });
  }

  async consume(args: {
    tokenId: string;
    expiresAt: number;
    now: number;
  }): Promise<{ ok: boolean; reason?: "replayed" | "rate_limited" }> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        args.tokenId,
      ) ||
      !Number.isSafeInteger(args.expiresAt) ||
      !Number.isSafeInteger(args.now) ||
      args.expiresAt <= args.now
    ) {
      return { ok: false, reason: "replayed" };
    }
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM consumed_capabilities WHERE expires_at <= ?",
        args.now,
      );
      const consumed = this.ctx.storage.sql
        .exec<{
          token_id: string;
        }>("SELECT token_id FROM consumed_capabilities WHERE token_id = ?", args.tokenId)
        .toArray();
      if (consumed.length > 0) return { ok: false, reason: "replayed" };

      const current = this.ctx.storage.sql
        .exec<{
          window_started_at: number;
          count: number;
        }>("SELECT window_started_at, count FROM rate_window WHERE singleton = 1")
        .toArray()[0];
      const inCurrentWindow =
        current && args.now - current.window_started_at < WINDOW_MS;
      if (inCurrentWindow && current.count >= MAX_FETCHES_PER_WINDOW) {
        return { ok: false, reason: "rate_limited" };
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO consumed_capabilities (token_id, expires_at) VALUES (?, ?)",
        args.tokenId,
        args.expiresAt,
      );
      if (inCurrentWindow) {
        this.ctx.storage.sql.exec(
          "UPDATE rate_window SET count = count + 1 WHERE singleton = 1",
        );
      } else {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO rate_window (singleton, window_started_at, count) VALUES (1, ?, 1)",
          args.now,
        );
      }
      return { ok: true };
    });
  }
}
