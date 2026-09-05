import {
  GATEWAY_MAX_RESULT_CACHE_BYTES,
  GATEWAY_RESULT_CACHE_TTL_MS,
} from "@stella/contracts/gateway/api";
import { GATEWAY_BUDGET_UNLIMITED } from "@stella/contracts/gateway/capability";
import {
  IN_FLIGHT_ABANDON_AFTER_MS,
  type LedgerReserveArgs,
  type LedgerReserveResult,
  type LedgerSettleArgs,
  type LedgerSettleResult,
  type LedgerReplayResult,
  type LedgerSnapshot,
} from "./ledger.js";

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
  `CREATE INDEX IF NOT EXISTS ledger_expiry ON ledger(expires_at)`,
  `CREATE TABLE IF NOT EXISTS results (
    jti TEXT NOT NULL,
    request_id TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (jti, request_id)
  )`,
];

const clampMicroCents = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/** One object per owner generation; every budget and result is still keyed by jti.
 * SQL mutations complete before the first await. Existing legacy ledgers remain
 * separate, selected by the capability's signed ledgerScope rollout marker.
 */
export class OwnerLedgerStore {
  private alarmAt: number | null = null;
  constructor(private readonly storage: DurableObjectStorage) {
    this.initSchema();
  }

  private initSchema(): void {
    for (const statement of SCHEMA) this.storage.sql.exec(statement);
  }

  private ledgerRow(jti: string): LedgerRow | null {
    const rows = this.storage.sql
      .exec<LedgerRow>("SELECT * FROM ledger WHERE jti = ?", jti)
      .toArray();
    return rows[0] ?? null;
  }

  async reserve(args: LedgerReserveArgs): Promise<LedgerReserveResult> {
    const result = this.reserveSync(args);
    await this.armAlarm();
    return result;
  }

  reserveSync(args: LedgerReserveArgs): LedgerReserveResult {
    const now = Date.now();
    const estimate = clampMicroCents(args.estimatedMicroCents);
    let row = this.ledgerRow(args.jti);
    if (!row) {
      this.storage.sql.exec(
        "INSERT INTO ledger (jti, budget, spent, reserved, requests, max_requests, expires_at) VALUES (?, ?, 0, 0, 0, ?, ?)",
        args.jti,
        Math.round(args.budgetMicroCents),
        args.maxRequests === undefined ? null : Math.floor(args.maxRequests),
        Math.round(args.expiresAt),
      );
      row = this.ledgerRow(args.jti);
      if (!row) throw new Error("ledger row vanished after insert");
    }

    const existing = this.storage.sql
      .exec<ResultRow>(
        "SELECT * FROM results WHERE jti = ? AND request_id = ?",
        args.jti,
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
      this.storage.sql.exec(
        "UPDATE ledger SET reserved = MAX(0, reserved - ?) WHERE jti = ?",
        existing.reserved,
        args.jti,
      );
      this.storage.sql.exec(
        "DELETE FROM results WHERE jti = ? AND request_id = ?",
        args.jti,
        args.requestId,
      );
      row = this.ledgerRow(args.jti) ?? row;
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

    this.storage.sql.exec(
      "INSERT INTO results (jti, request_id, status, body, bytes, reserved, created_at) VALUES (?, ?, 0, NULL, 0, ?, ?)",
      args.jti,
      args.requestId,
      estimate,
      now,
    );
    this.storage.sql.exec(
      "UPDATE ledger SET reserved = reserved + ?, requests = requests + ? WHERE jti = ?",
      estimate,
      resumingAbandoned ? 0 : 1,
      args.jti,
    );
    return {
      kind: "reserved",
      remainingMicroCents:
        remaining === null ? null : Math.max(0, remaining - estimate),
    };
  }

  async settle(
    args: LedgerSettleArgs & { jti: string },
  ): Promise<LedgerSettleResult> {
    const row = this.ledgerRow(args.jti);
    const pending = this.storage.sql
      .exec<ResultRow>(
        "SELECT * FROM results WHERE jti = ? AND request_id = ?",
        args.jti,
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
    this.storage.sql.exec(
      "UPDATE ledger SET reserved = MAX(0, reserved - ?), spent = spent + ?, requests = MAX(0, requests - ?) WHERE jti = ?",
      pending.reserved,
      charged,
      args.refundRequest ? 1 : 0,
      args.jti,
    );
    let cached = false;
    const result = args.result;
    if (result && result.status > 0) {
      const bytes = new TextEncoder().encode(result.body).byteLength;
      if (bytes <= GATEWAY_MAX_RESULT_CACHE_BYTES) {
        this.storage.sql.exec(
          "UPDATE results SET status = ?, body = ?, bytes = ?, reserved = 0 WHERE jti = ? AND request_id = ?",
          result.status,
          result.body,
          bytes,
          args.jti,
          args.requestId,
        );
        cached = true;
      }
    }
    if (!cached) {
      this.storage.sql.exec(
        "DELETE FROM results WHERE jti = ? AND request_id = ?",
        args.jti,
        args.requestId,
      );
    }
    const updated = this.ledgerRow(args.jti);
    return {
      ok: true,
      spentMicroCents: updated?.spent ?? 0,
      reservedMicroCents: updated?.reserved ?? 0,
      cached,
    };
  }

  async replay(args: {
    jti: string;
    requestId: string;
  }): Promise<LedgerReplayResult> {
    const row = this.storage.sql
      .exec<ResultRow>(
        "SELECT * FROM results WHERE jti = ? AND request_id = ? AND status > 0",
        args.jti,
        args.requestId,
      )
      .toArray()[0];
    return row && row.body !== null
      ? { status: row.status, body: row.body }
      : null;
  }

  async snapshot(args: { jti: string }): Promise<LedgerSnapshot> {
    const row = this.ledgerRow(args.jti);
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

  async armAlarm(): Promise<void> {
    const next = this.storage.sql
      .exec<{
        at: number | null;
      }>("SELECT MIN(expires_at) + ? AS at FROM ledger", GATEWAY_RESULT_CACHE_TTL_MS)
      .one().at;
    if (next !== null && (this.alarmAt === null || next < this.alarmAt)) {
      const at = Math.max(Date.now() + 1_000, next);
      await this.storage.setAlarm(at);
      this.alarmAt = at;
    }
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - GATEWAY_RESULT_CACHE_TTL_MS;
    this.storage.sql.exec(
      "DELETE FROM results WHERE jti IN (SELECT jti FROM ledger WHERE expires_at <= ?)",
      cutoff,
    );
    this.storage.sql.exec(
      "DELETE FROM ledger WHERE expires_at <= ?",
      cutoff,
    );
    this.alarmAt = null;
    await this.armAlarm();
  }
}
