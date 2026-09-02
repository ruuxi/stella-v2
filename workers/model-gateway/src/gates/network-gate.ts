import { DurableObject } from "cloudflare:workers";
import {
  GATEWAY_NETWORK_LIMITS,
  limitsAudienceFor,
} from "@stella/contracts/gateway/api";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type NetworkAdmission =
  | { ok: true }
  | { ok: false; refused: "rate_limited"; resetAt: number };

type CountRow = { count: number };
type OldestRow = { oldest: number | null };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS relay_admissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audience TEXT NOT NULL,
    admitted_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS network_relay_admissions_at
    ON relay_admissions(audience, admitted_at)`,
  `CREATE TABLE IF NOT EXISTS mint_admissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admitted_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS network_mint_admissions_at
    ON mint_admissions(admitted_at)`,
];

/** One SQLite Durable Object per `sha256(ip).slice(0, 32)`. */
export class NetworkGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    });
  }

  async admitRelay(args: {
    audience: ManagedModelAudience;
  }): Promise<NetworkAdmission> {
    const audience = limitsAudienceFor(args.audience);
    if (audience === "go" || audience === "pro") return { ok: true };

    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM relay_admissions WHERE admitted_at <= ?",
      now - DAY_MS,
    );
    const dayCount = this.ctx.storage.sql
      .exec<CountRow>(
        "SELECT COUNT(*) AS count FROM relay_admissions WHERE audience = ?",
        audience,
      )
      .one().count;
    const dayLimit =
      audience === "anonymous"
        ? GATEWAY_NETWORK_LIMITS.anonymous.relayPerDay
        : GATEWAY_NETWORK_LIMITS.free.relayPerDay;
    if (dayCount >= dayLimit) {
      return this.refusal({ audience, now, windowMs: DAY_MS });
    }

    if (audience === "anonymous") {
      const hourCount = this.ctx.storage.sql
        .exec<CountRow>(
          "SELECT COUNT(*) AS count FROM relay_admissions WHERE audience = ? AND admitted_at > ?",
          audience,
          now - HOUR_MS,
        )
        .one().count;
      if (hourCount >= GATEWAY_NETWORK_LIMITS.anonymous.relayPerHour) {
        return this.refusal({ audience, now, windowMs: HOUR_MS });
      }
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO relay_admissions (audience, admitted_at) VALUES (?, ?)",
      audience,
      now,
    );
    return { ok: true };
  }

  async admitMint(): Promise<NetworkAdmission> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM mint_admissions WHERE admitted_at <= ?",
      now - DAY_MS,
    );
    const count = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM mint_admissions")
      .one().count;
    if (count >= GATEWAY_NETWORK_LIMITS.anonymous.mintsPerDay) {
      const oldest = this.ctx.storage.sql
        .exec<OldestRow>(
          "SELECT MIN(admitted_at) AS oldest FROM mint_admissions",
        )
        .one().oldest;
      return {
        ok: false,
        refused: "rate_limited",
        resetAt: (oldest ?? now) + DAY_MS,
      };
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO mint_admissions (admitted_at) VALUES (?)",
      now,
    );
    return { ok: true };
  }

  private refusal(args: {
    audience: "anonymous" | "free";
    now: number;
    windowMs: number;
  }): NetworkAdmission {
    const oldest = this.ctx.storage.sql
      .exec<OldestRow>(
        "SELECT MIN(admitted_at) AS oldest FROM relay_admissions WHERE audience = ? AND admitted_at > ?",
        args.audience,
        args.now - args.windowMs,
      )
      .one().oldest;
    return {
      ok: false,
      refused: "rate_limited",
      resetAt: (oldest ?? args.now) + args.windowMs,
    };
  }
}
