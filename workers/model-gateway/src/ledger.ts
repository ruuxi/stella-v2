import { DurableObject } from "cloudflare:workers";
import {
  GATEWAY_MAX_RESULT_CACHE_BYTES,
  GATEWAY_RESULT_CACHE_TTL_MS,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
} from "@stella/contracts/gateway/api";
import { GATEWAY_BUDGET_UNLIMITED } from "@stella/contracts/gateway/capability";

/**
 * A reservation older than this with no settlement belongs to an isolate that
 * died mid-request (the managed lane's absolute ceiling is
 * GATEWAY_UPSTREAM_MAX_DURATION_MS, plus a grace period). It is released on
 * the next reserve for the same request id.
 */
export const IN_FLIGHT_ABANDON_AFTER_MS =
  GATEWAY_UPSTREAM_MAX_DURATION_MS + 60_000;

/**
 * CapabilityLedger — one SQLite-backed Durable Object per capability `jti`.
 *
 * It is the gateway's only source of truth for "may this capability spend
 * more": budget, reservation, and request-count accounting, plus the
 * replayable result cache that makes retries with the same request id
 * idempotent. No Convex call is ever on this path.
 *
 * Semantics
 *   reserve   Refuses when `requests >= max_requests` (request_limit) or when
 *             `spent + reserved + estimate > budget` (budget_exhausted); an
 *             unlimited budget (GATEWAY_BUDGET_UNLIMITED) never refuses on
 *             money. A known settled request id returns its stored result
 *             (replay) instead of reserving; a known in-flight id returns
 *             in_flight. Otherwise the estimate is reserved and the request
 *             counted — the count is never refunded, so an abort or failure
 *             still consumes an anonymous trial request.
 *   settle    Releases the request's reservation, adds the charged amount to
 *             `spent`, and stores the result for replay when it fits
 *             GATEWAY_MAX_RESULT_CACHE_BYTES; a failed or oversized result
 *             drops the row so a retry with the same id executes again.
 *   replay    Reads a settled result without touching the ledger.
 *   alarm     At `expires_at + GATEWAY_RESULT_CACHE_TTL_MS` everything is
 *             deleted: a capability that can no longer be presented needs no
 *             ledger, and its results are past their replay window.
 *
 * All reads and writes inside one method are synchronous SQL, so the object's
 * input gate makes each method atomic with respect to concurrent callers.
 */
export type LedgerReserveArgs = {
  jti: string;
  budgetMicroCents: number;
  maxRequests?: number;
  /** Capability expiry, ms since epoch. */
  expiresAt: number;
  requestId: string;
  estimatedMicroCents: number;
};

export type LedgerReserveResult =
  | { kind: "reserved"; remainingMicroCents: number | null }
  | { kind: "replay"; status: number; body: string }
  | { kind: "in_flight" }
  | { kind: "budget_exhausted"; remainingMicroCents: number }
  | { kind: "request_limit"; maxRequests: number };

export type LedgerSettleArgs = {
  requestId: string;
  chargedMicroCents: number;
  /** Present for a completed result that should be replayable. */
  result?: { status: number; body: string };
};

export type LedgerSettleResult = {
  ok: boolean;
  spentMicroCents: number;
  reservedMicroCents: number;
  cached: boolean;
};

export type LedgerReplayResult = { status: number; body: string } | null;

export type LedgerSnapshot = {
  budgetMicroCents: number;
  spentMicroCents: number;
  reservedMicroCents: number;
  requests: number;
  maxRequests: number | null;
  expiresAt: number;
} | null;

type LedgerRow = {
  jti: string;
  budget: number;
  spent: number;
  reserved: number;
  requests: number;
  max_requests: number | null;
  expires_at: number;
};

type ResultRow = {
  request_id: string;
  status: number;
  body: string | null;
  bytes: number;
  reserved: number;
  created_at: number;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ledger (
    jti TEXT PRIMARY KEY,
    budget INTEGER NOT NULL,
    spent INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    max_requests INTEGER,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS results (
    request_id TEXT PRIMARY KEY,
    status INTEGER NOT NULL,
    body TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
];

const clampMicroCents = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

export class CapabilityLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Constructors cannot await; blockConcurrencyWhile holds every incoming
    // call until the schema exists, so the promise is intentionally detached.
    void ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  private initSchema(): void {
    for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
  }

  private ledgerRow(): LedgerRow | null {
    const rows = this.ctx.storage.sql
      .exec<LedgerRow>("SELECT * FROM ledger LIMIT 1")
      .toArray();
    return rows[0] ?? null;
  }

  async reserve(args: LedgerReserveArgs): Promise<LedgerReserveResult> {
    const now = Date.now();
    const estimate = clampMicroCents(args.estimatedMicroCents);
    let row = this.ledgerRow();
    if (!row) {
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger (jti, budget, spent, reserved, requests, max_requests, expires_at) VALUES (?, ?, 0, 0, 0, ?, ?)",
        args.jti,
        Math.round(args.budgetMicroCents),
        args.maxRequests === undefined ? null : Math.floor(args.maxRequests),
        Math.round(args.expiresAt),
      );
      row = this.ledgerRow();
      if (!row) throw new Error("ledger row vanished after insert");
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(
          Math.max(
            now + 1_000,
            Math.round(args.expiresAt) + GATEWAY_RESULT_CACHE_TTL_MS,
          ),
        );
      }
    }

    const existing = this.ctx.storage.sql
      .exec<ResultRow>(
        "SELECT * FROM results WHERE request_id = ?",
        args.requestId,
      )
      .toArray()[0];
    let resumingAbandoned = false;
    if (existing) {
      if (existing.status > 0 && existing.body !== null) {
        return { kind: "replay", status: existing.status, body: existing.body };
      }
      if (now - existing.created_at <= IN_FLIGHT_ABANDON_AFTER_MS) {
        return { kind: "in_flight" };
      }
      // The isolate that reserved this request died before settling it: no
      // completion can ever arrive. Release its reservation so the budget is
      // not held hostage, and let the same request id run again without
      // counting a second request against the trial.
      this.ctx.storage.sql.exec(
        "UPDATE ledger SET reserved = MAX(0, reserved - ?)",
        existing.reserved,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM results WHERE request_id = ?",
        args.requestId,
      );
      row = this.ledgerRow() ?? row;
      resumingAbandoned = true;
    }

    if (
      !resumingAbandoned &&
      row.max_requests !== null &&
      row.requests >= row.max_requests
    ) {
      return { kind: "request_limit", maxRequests: row.max_requests };
    }
    const unlimited = row.budget === GATEWAY_BUDGET_UNLIMITED || row.budget < 0;
    const remaining = unlimited ? null : row.budget - row.spent - row.reserved;
    if (
      remaining !== null &&
      row.spent + row.reserved + estimate > row.budget
    ) {
      return {
        kind: "budget_exhausted",
        remainingMicroCents: Math.max(0, remaining),
      };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO results (request_id, status, body, bytes, reserved, created_at) VALUES (?, 0, NULL, 0, ?, ?)",
      args.requestId,
      estimate,
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE ledger SET reserved = reserved + ?, requests = requests + ?",
      estimate,
      resumingAbandoned ? 0 : 1,
    );
    return {
      kind: "reserved",
      remainingMicroCents:
        remaining === null ? null : Math.max(0, remaining - estimate),
    };
  }

  async settle(args: LedgerSettleArgs): Promise<LedgerSettleResult> {
    const row = this.ledgerRow();
    const pending = this.ctx.storage.sql
      .exec<ResultRow>(
        "SELECT * FROM results WHERE request_id = ?",
        args.requestId,
      )
      .toArray()[0];
    if (!row || !pending || pending.status > 0) {
      return {
        ok: false,
        spentMicroCents: row?.spent ?? 0,
        reservedMicroCents: row?.reserved ?? 0,
        cached: false,
      };
    }
    const charged = clampMicroCents(args.chargedMicroCents);
    this.ctx.storage.sql.exec(
      "UPDATE ledger SET reserved = MAX(0, reserved - ?), spent = spent + ?",
      pending.reserved,
      charged,
    );
    let cached = false;
    const result = args.result;
    if (result && result.status > 0) {
      const bytes = new TextEncoder().encode(result.body).byteLength;
      if (bytes <= GATEWAY_MAX_RESULT_CACHE_BYTES) {
        this.ctx.storage.sql.exec(
          "UPDATE results SET status = ?, body = ?, bytes = ?, reserved = 0 WHERE request_id = ?",
          result.status,
          result.body,
          bytes,
          args.requestId,
        );
        cached = true;
      }
    }
    if (!cached) {
      this.ctx.storage.sql.exec(
        "DELETE FROM results WHERE request_id = ?",
        args.requestId,
      );
    }
    const updated = this.ledgerRow();
    return {
      ok: true,
      spentMicroCents: updated?.spent ?? 0,
      reservedMicroCents: updated?.reserved ?? 0,
      cached,
    };
  }

  async replay(args: { requestId: string }): Promise<LedgerReplayResult> {
    const row = this.ctx.storage.sql
      .exec<ResultRow>(
        "SELECT * FROM results WHERE request_id = ? AND status > 0",
        args.requestId,
      )
      .toArray()[0];
    return row && row.body !== null
      ? { status: row.status, body: row.body }
      : null;
  }

  async snapshot(): Promise<LedgerSnapshot> {
    const row = this.ledgerRow();
    return row
      ? {
          budgetMicroCents: row.budget,
          spentMicroCents: row.spent,
          reservedMicroCents: row.reserved,
          requests: row.requests,
          maxRequests: row.max_requests,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.initSchema();
  }
}
