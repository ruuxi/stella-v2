import { DurableObject } from "cloudflare:workers";
import {
  GATEWAY_OWNER_RELAY_LIMITS,
  GATEWAY_THROTTLED_LIMIT_SHARE,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
  limitsAudienceFor,
} from "@stella/contracts/gateway/api";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const OWNER_IN_FLIGHT_ABANDON_AFTER_MS =
  GATEWAY_UPSTREAM_MAX_DURATION_MS + MINUTE_MS;

export type GateAdmission =
  | {
      ok: true;
      /**
       * The request id was already in flight for this owner: a client retry
       * of an ambiguous request. It is admitted without counting so the
       * capability ledger, which owns idempotency, can answer replay or
       * in-flight. Callers must not release a duplicate admission.
       */
      duplicate?: boolean;
    }
  | {
      ok: false;
      refused: "concurrency_limit" | "rate_limited";
      resetAt: number;
    };

type CountRow = { count: number };
type OldestRow = { oldest: number | null };
type InFlightRow = { started_at: number };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS in_flight (
    request_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS relay_admissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admitted_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS relay_admissions_at
    ON relay_admissions(admitted_at)`,
  `CREATE TABLE IF NOT EXISTS mint_admissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admitted_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS mint_admissions_at
    ON mint_admissions(admitted_at)`,
];

const scaledLimit = (limit: number, throttled: boolean): number =>
  throttled
    ? Math.max(1, Math.floor(limit * GATEWAY_THROTTLED_LIMIT_SHARE))
    : limit;

/** One SQLite Durable Object per capability owner (`sub`). */
export class OwnerRelayGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    });
  }

  async admitRelay(args: {
    audience: ManagedModelAudience;
    requestId: string;
    throttled: boolean;
  }): Promise<GateAdmission> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM in_flight WHERE started_at <= ?",
      now - OWNER_IN_FLIGHT_ABANDON_AFTER_MS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM relay_admissions WHERE admitted_at <= ?",
      now - MINUTE_MS,
    );

    const existing = this.ctx.storage.sql
      .exec<InFlightRow>(
        "SELECT started_at FROM in_flight WHERE request_id = ?",
        args.requestId,
      )
      .toArray()[0];
    if (existing) return { ok: true, duplicate: true };

    const policy = GATEWAY_OWNER_RELAY_LIMITS[limitsAudienceFor(args.audience)];
    const inFlightLimit = scaledLimit(policy.inFlight, args.throttled);
    const inFlight = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM in_flight")
      .one().count;
    if (inFlight >= inFlightLimit) {
      const oldest = this.ctx.storage.sql
        .exec<OldestRow>("SELECT MIN(started_at) AS oldest FROM in_flight")
        .one().oldest;
      return {
        ok: false,
        refused: "concurrency_limit",
        resetAt: (oldest ?? now) + OWNER_IN_FLIGHT_ABANDON_AFTER_MS,
      };
    }

    const minuteLimit = scaledLimit(policy.perMinute, args.throttled);
    const minuteAdmissions = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM relay_admissions")
      .one().count;
    if (minuteAdmissions >= minuteLimit) {
      const oldest = this.ctx.storage.sql
        .exec<OldestRow>(
          "SELECT MIN(admitted_at) AS oldest FROM relay_admissions",
        )
        .one().oldest;
      return {
        ok: false,
        refused: "rate_limited",
        resetAt: (oldest ?? now) + MINUTE_MS,
      };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO in_flight (request_id, started_at) VALUES (?, ?)",
      args.requestId,
      now,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO relay_admissions (admitted_at) VALUES (?)",
      now,
    );
    return { ok: true };
  }

  async releaseRelay(requestId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM in_flight WHERE request_id = ?",
      requestId,
    );
  }

  async admitMint(args: {
    audience: ManagedModelAudience;
    throttled: boolean;
  }): Promise<GateAdmission> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM mint_admissions WHERE admitted_at <= ?",
      now - HOUR_MS,
    );
    const policy = GATEWAY_OWNER_RELAY_LIMITS[limitsAudienceFor(args.audience)];
    const limit = scaledLimit(policy.mintsPerHour, args.throttled);
    const admissions = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM mint_admissions")
      .one().count;
    if (admissions >= limit) {
      const oldest = this.ctx.storage.sql
        .exec<OldestRow>(
          "SELECT MIN(admitted_at) AS oldest FROM mint_admissions",
        )
        .one().oldest;
      return {
        ok: false,
        refused: "rate_limited",
        resetAt: (oldest ?? now) + HOUR_MS,
      };
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO mint_admissions (admitted_at) VALUES (?)",
      now,
    );
    return { ok: true };
  }
}
