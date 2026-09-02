import { DurableObject } from "cloudflare:workers";

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
const ALERT_INTERVAL_MS = 5 * MINUTE_MS;

export type TierBudgetWindow = "hourly" | "daily";

export type TierBudgetReserveResult =
  | { ok: true; minute: number }
  | {
      ok: false;
      refused: TierBudgetWindow;
      resetAt: number;
    };

type SumRow = { total: number | null };
type OldestRow = { oldest: number | null };
type AlertRow = { last_at: number };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS buckets (
    minute INTEGER PRIMARY KEY,
    reserved INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    window TEXT PRIMARY KEY,
    last_at INTEGER NOT NULL
  )`,
];

const clampMicroCents = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

const optionalString = (object: object, key: string): string | null => {
  const value = Reflect.get(object, key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/** One SQLite Durable Object per limits audience. */
export class TierBudget extends DurableObject<Env> {
  private readonly audience: string;
  private readonly alertWebhookUrl: string | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.audience = ctx.id.name ?? ctx.id.toString();
    this.alertWebhookUrl = optionalString(env, "ALERT_WEBHOOK_URL");
    void ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    });
  }

  async reserve(args: {
    estimateMicroCents: number;
    hourlyCeiling: number;
    dailyCeiling: number;
    now: number;
  }): Promise<TierBudgetReserveResult> {
    const minute = Math.floor(args.now / MINUTE_MS);
    const estimate = clampMicroCents(args.estimateMicroCents);
    this.ctx.storage.sql.exec(
      "DELETE FROM buckets WHERE minute < ?",
      minute - DAY_MINUTES + 1,
    );

    const hourly = this.windowTotal(minute, HOUR_MINUTES);
    if (args.hourlyCeiling >= 0 && hourly + estimate > args.hourlyCeiling) {
      const resetAt = this.resetAt(minute, HOUR_MINUTES);
      this.reportTrip("hourly", args.now, resetAt);
      return { ok: false, refused: "hourly", resetAt };
    }

    const daily = this.windowTotal(minute, DAY_MINUTES);
    if (args.dailyCeiling >= 0 && daily + estimate > args.dailyCeiling) {
      const resetAt = this.resetAt(minute, DAY_MINUTES);
      this.reportTrip("daily", args.now, resetAt);
      return { ok: false, refused: "daily", resetAt };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO buckets (minute, reserved) VALUES (?, ?)
       ON CONFLICT(minute) DO UPDATE SET reserved = reserved + excluded.reserved`,
      minute,
      estimate,
    );
    return { ok: true, minute };
  }

  async settle(args: {
    estimateMicroCents: number;
    actualMicroCents: number;
    minute: number;
  }): Promise<void> {
    const estimate = clampMicroCents(args.estimateMicroCents);
    const actual = clampMicroCents(args.actualMicroCents);
    this.ctx.storage.sql.exec(
      "UPDATE buckets SET reserved = MAX(0, reserved - ? + ?) WHERE minute = ?",
      estimate,
      actual,
      Math.floor(args.minute),
    );
  }

  async snapshot(): Promise<Array<{ minute: number; microCents: number }>> {
    return this.ctx.storage.sql
      .exec<{ minute: number; reserved: number }>(
        "SELECT minute, reserved FROM buckets ORDER BY minute",
      )
      .toArray()
      .map((row) => ({ minute: row.minute, microCents: row.reserved }));
  }

  private windowTotal(minute: number, windowMinutes: number): number {
    return (
      this.ctx.storage.sql
        .exec<SumRow>(
          "SELECT SUM(reserved) AS total FROM buckets WHERE minute >= ? AND reserved > 0",
          minute - windowMinutes + 1,
        )
        .one().total ?? 0
    );
  }

  private resetAt(minute: number, windowMinutes: number): number {
    const oldest = this.ctx.storage.sql
      .exec<OldestRow>(
        "SELECT MIN(minute) AS oldest FROM buckets WHERE minute >= ? AND reserved > 0",
        minute - windowMinutes + 1,
      )
      .one().oldest;
    return ((oldest ?? minute) + windowMinutes) * MINUTE_MS;
  }

  private reportTrip(
    window: TierBudgetWindow,
    now: number,
    resetAt: number,
  ): void {
    console.error(
      `[model-gateway] breaker audience=${this.audience} window=${window}`,
    );
    if (!this.alertWebhookUrl) return;
    const last = this.ctx.storage.sql
      .exec<AlertRow>("SELECT last_at FROM alerts WHERE window = ?", window)
      .toArray()[0]?.last_at;
    if (last !== undefined && now - last < ALERT_INTERVAL_MS) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO alerts (window, last_at) VALUES (?, ?)
       ON CONFLICT(window) DO UPDATE SET last_at = excluded.last_at`,
      window,
      now,
    );
    this.ctx.waitUntil(
      fetch(this.alertWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: JSON.stringify({
            source: "model-gateway",
            audience: this.audience,
            window,
            resetAt,
          }),
        }),
      }).catch((error: unknown) => {
        console.warn(
          `[model-gateway] breaker alert failed audience=${this.audience} window=${window}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }),
    );
  }
}
