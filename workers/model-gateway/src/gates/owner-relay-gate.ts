import { isGatewayError } from "../errors.js";
import { DurableObject } from "cloudflare:workers";
import { handleRequest } from "../router.js";
import { defaultDeps } from "../request-util.js";
import {
  getGatewayConfig,
  type GatewayConfigStorage,
} from "../config-cache.js";
import { createConvexClient } from "../convex-client.js";
import {
  DEFAULT_ENFORCEMENT_TTL_SECONDS,
  enforcementAdmissionForRecord,
  normalizeStoredOwnerEnforcement,
  type OwnerEnforcementAdmission,
  type StoredOwnerEnforcement,
} from "../owner-enforcement.js";
import {
  SHARED_GATEWAY_CONFIG_KEY,
  sharedGatewayConfigStore,
} from "../shared-config.js";
import {
  GATEWAY_OWNER_RELAY_LIMITS,
  GATEWAY_THROTTLED_LIMIT_SHARE,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
  limitsAudienceFor,
} from "@stella/contracts/gateway/api";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";

import { OwnerLedgerStore } from "../owner-ledger-store.js";
import type {
  LedgerReserveArgs,
  LedgerReserveResult,
  LedgerSettleArgs,
} from "../ledger.js";
import {
  managedCancellationKey,
  type ManagedCancellationIdentity,
} from "../managed-cancellation.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const OWNER_ENFORCEMENT_INITIALIZATION_VERSION = 2;
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

const parseAuthoritativeOwnerEnforcement = (
  value: unknown,
): StoredOwnerEnforcement | null | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const updatedAt = Reflect.get(value, "updatedAt");
  const enforcement = Reflect.get(value, "enforcement");
  if (
    (updatedAt !== null &&
      (typeof updatedAt !== "number" || !Number.isFinite(updatedAt))) ||
    !enforcement ||
    typeof enforcement !== "object" ||
    Array.isArray(enforcement)
  )
    return undefined;
  const status = Reflect.get(enforcement, "status");
  const until = Reflect.get(enforcement, "until");
  const reason = Reflect.get(enforcement, "reason");
  if (
    (until !== undefined &&
      (typeof until !== "number" || !Number.isFinite(until))) ||
    (reason !== undefined && typeof reason !== "string")
  )
    return undefined;
  if (updatedAt === null) {
    return status === "ok" ? null : undefined;
  }
  return (
    normalizeStoredOwnerEnforcement({
      status,
      ...(typeof until === "number" ? { until } : {}),
      updatedAt,
      expiresAt:
        typeof until === "number"
          ? until
          : updatedAt + DEFAULT_ENFORCEMENT_TTL_SECONDS * 1_000,
    }) ?? undefined
  );
};

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
  `CREATE TABLE IF NOT EXISTS managed_cancellations (
    identity TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS managed_cancellations_expiry
    ON managed_cancellations(expires_at)`,
  `CREATE TABLE IF NOT EXISTS owner_enforcement_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    status TEXT NOT NULL,
    until_at INTEGER,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS owner_enforcement_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    initialized INTEGER NOT NULL
  )`,
];

const scaledLimit = (limit: number, throttled: boolean): number =>
  throttled
    ? Math.max(1, Math.floor(limit * GATEWAY_THROTTLED_LIMIT_SHARE))
    : limit;

/** One SQLite Durable Object per capability owner (`sub`). */
export class OwnerRelayGate extends DurableObject<Env> {
  private readonly ledger: OwnerLedgerStore;
  private readonly instanceId = crypto.randomUUID();
  private readonly managedControllers = new Map<
    string,
    { controller: AbortController; references: number }
  >();
  private enforcementInitialization?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new OwnerLedgerStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    });
  }

  override fetch(request: Request): Promise<Response> {
    return handleRequest(
      request,
      this.env,
      this.ctx,
      {
        ...defaultDeps(this.ctx),
        beforeProviderDispatch: () => this.ctx.storage.sync(),
      },
      {
        matchesOwner: (ownerId) =>
          this.env.OWNER_RELAY_GATE.idFromName(ownerId).toString() ===
          this.ctx.id.toString(),
        accounting: this,
        instanceId: this.instanceId,
        configStorage: this.configStorage,
        ownerEnforcement: (ownerId, now) =>
          this.admitOwnerEnforcement(ownerId, now),
        cancellation: {
          begin: (identity) => this.beginManagedRequest(identity),
          release: (key) => this.releaseManagedRequest(key),
        },
      },
    );
  }

  private get configStorage(): GatewayConfigStorage {
    return {
      source: this.env.STELLA_CONVEX_SITE_URL,
      read: () => this.ctx.storage.kv.get(SHARED_GATEWAY_CONFIG_KEY),
      write: (record) =>
        this.ctx.storage.kv.put(SHARED_GATEWAY_CONFIG_KEY, record),
    };
  }

  private enforcementRecord(): StoredOwnerEnforcement | null {
    const row = this.ctx.storage.sql
      .exec<{
        status: string;
        until_at: number | null;
        updated_at: number;
        expires_at: number;
      }>(
        "SELECT status, until_at, updated_at, expires_at FROM owner_enforcement_state WHERE singleton = 1",
      )
      .toArray()[0];
    if (!row) return null;
    return normalizeStoredOwnerEnforcement({
      status: row.status,
      ...(row.until_at === null ? {} : { until: row.until_at }),
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    });
  }

  private applyOwnerEnforcementSync(
    record: StoredOwnerEnforcement,
    current: StoredOwnerEnforcement | null,
  ): StoredOwnerEnforcement {
    if (!current || record.updatedAt > current.updatedAt) {
      const normalized = {
        ...record,
        expiresAt:
          record.expiresAt ??
          record.until ??
          record.updatedAt + DEFAULT_ENFORCEMENT_TTL_SECONDS * 1_000,
      };
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO owner_enforcement_state
          (singleton, status, until_at, updated_at, expires_at) VALUES (1, ?, ?, ?, ?)`,
        normalized.status,
        normalized.until ?? null,
        normalized.updatedAt,
        normalized.expiresAt,
      );
      return normalized;
    }
    return current;
  }

  async applyOwnerEnforcement(
    input: StoredOwnerEnforcement,
  ): Promise<StoredOwnerEnforcement> {
    const record = normalizeStoredOwnerEnforcement(input);
    if (!record || typeof record.expiresAt !== "number") {
      throw new Error("Owner enforcement update is invalid.");
    }
    const current = this.enforcementRecord();
    const applied = this.applyOwnerEnforcementSync(record, current);
    // A delayed authenticated push cannot attest to a newer legacy KV seed.
    // Leave its v1 marker for the authoritative bootstrap in that case.
    if (!current || record.updatedAt >= current.updatedAt) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO owner_enforcement_meta(singleton, initialized) VALUES (1, ?)",
        OWNER_ENFORCEMENT_INITIALIZATION_VERSION,
      );
    }
    return applied;
  }

  private async initializeOwnerEnforcement(
    ownerId: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    const initialized = this.ctx.storage.sql
      .exec<{
        initialized: number;
      }>("SELECT initialized FROM owner_enforcement_meta WHERE singleton = 1")
      .toArray()[0];
    if (
      initialized?.initialized !== undefined &&
      initialized.initialized >= OWNER_ENFORCEMENT_INITIALIZATION_VERSION
    )
      return;
    // KV is an eventual compatibility mirror. Bootstrap from Convex so a
    // rollout read cannot permanently seed this durable owner state stale.
    const result = await createConvexClient(
      this.env,
      fetchImpl,
    ).ownerEnforcement(ownerId);
    if (!result.ok) throw new Error("Owner enforcement bootstrap unavailable.");
    const authoritative = parseAuthoritativeOwnerEnforcement(result.body);
    if (authoritative === undefined) {
      throw new Error("Owner enforcement bootstrap response is invalid.");
    }
    if (authoritative) {
      this.applyOwnerEnforcementSync(authoritative, this.enforcementRecord());
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO owner_enforcement_meta(singleton, initialized) VALUES (1, ?)",
      OWNER_ENFORCEMENT_INITIALIZATION_VERSION,
    );
  }

  async admitOwnerEnforcement(
    ownerId: string,
    now: number,
    fetchImpl: typeof fetch = fetch,
  ): Promise<OwnerEnforcementAdmission> {
    if (
      this.env.OWNER_RELAY_GATE.idFromName(ownerId).toString() !==
      this.ctx.id.toString()
    ) {
      throw new Error("Owner enforcement identity does not match.");
    }
    this.enforcementInitialization ??= this.initializeOwnerEnforcement(
      ownerId,
      fetchImpl,
    ).catch((error) => {
      this.enforcementInitialization = undefined;
      throw error;
    });
    await this.enforcementInitialization;
    return enforcementAdmissionForRecord(this.enforcementRecord(), now);
  }

  async prepare(ownerId: string, traceId?: string): Promise<void> {
    const startedAt = performance.now();
    const invokedAt = Date.now();
    const durations: {
      pricingMs?: number;
      enforcementMs?: number;
      configAgeMs?: number;
    } = {};
    console.info(
      JSON.stringify({
        event: "gateway_owner_preparation_timing",
        traceId,
        executorInstanceId: this.instanceId,
        invokedAt,
        status: "started",
      }),
    );
    try {
      if (
        this.env.OWNER_RELAY_GATE.idFromName(ownerId).toString() !==
        this.ctx.id.toString()
      ) {
        throw new Error("Owner preparation identity does not match.");
      }
      await Promise.all([
        (async () => {
          const pricingStartedAt = performance.now();
          try {
            const config = await getGatewayConfig(
              createConvexClient(this.env),
              (work) => this.ctx.waitUntil(work),
              Date.now,
              this.configStorage,
              sharedGatewayConfigStore(this.env),
            );
            durations.configAgeMs = Math.max(0, Date.now() - config.fetchedAt);
          } finally {
            durations.pricingMs = performance.now() - pricingStartedAt;
          }
        })(),
        (async () => {
          const enforcementStartedAt = performance.now();
          try {
            await this.admitOwnerEnforcement(ownerId, Date.now());
          } finally {
            durations.enforcementMs = performance.now() - enforcementStartedAt;
          }
        })(),
      ]);
      console.info(
        JSON.stringify({
          event: "gateway_owner_preparation_timing",
          traceId,
          executorInstanceId: this.instanceId,
          invokedAt,
          status: "completed",
          totalMs: performance.now() - startedAt,
          ...durations,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "gateway_owner_preparation_timing",
          traceId,
          executorInstanceId: this.instanceId,
          invokedAt,
          status: "failed",
          totalMs: performance.now() - startedAt,
          code: isGatewayError(error) ? error.code : "internal",
          ...durations,
        }),
      );
      throw error;
    }
  }

  async admitRelay(args: {
    audience: ManagedModelAudience;
    requestId: string;
    throttled: boolean;
  }): Promise<GateAdmission> {
    return this.admitRelaySync(args);
  }

  private admitRelaySync(args: {
    audience: ManagedModelAudience;
    requestId: string;
    throttled: boolean;
  }): GateAdmission {
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

  /** Owner-wide admission and generation/JTI accounting commit together. */
  async admitAndReserve(args: {
    audience: ManagedModelAudience;
    requestId: string;
    throttled: boolean;
    generation: string;
    reservation: LedgerReserveArgs;
  }): Promise<{ admission: GateAdmission; reservation?: LedgerReserveResult }> {
    const admissionId = JSON.stringify([
      args.generation,
      args.reservation.jti,
      args.requestId,
    ]);
    const result = this.ctx.storage.transactionSync(() => {
      const admission = this.admitRelaySync({
        ...args,
        requestId: admissionId,
      });
      if (!admission.ok) return { admission };
      const reservation = this.ledger.reserveSync({
        ...args.reservation,
        requestId: args.requestId,
        jti: JSON.stringify([args.generation, args.reservation.jti]),
      });
      if (reservation.kind !== "reserved" && !admission.duplicate) {
        this.ctx.storage.sql.exec(
          "DELETE FROM in_flight WHERE request_id = ?",
          admissionId,
        );
      }
      return { admission, reservation };
    });
    await this.ledger.armAlarm();
    return result;
  }

  async settleCapability(
    args: LedgerSettleArgs & { generation: string; jti: string },
  ) {
    return await this.ledger.settle({
      ...args,
      jti: JSON.stringify([args.generation, args.jti]),
    });
  }

  private async armCancellationAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{
        at: number | null;
      }>("SELECT MIN(expires_at) AS at FROM managed_cancellations")
      .one().at;
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    const at = Math.max(Date.now() + 1_000, next);
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    await this.ledger.alarm();
    this.ctx.storage.sql.exec(
      "DELETE FROM managed_cancellations WHERE expires_at <= ?",
      Date.now(),
    );
    await this.armCancellationAlarm();
  }

  async cancelManagedRequest(
    identity: ManagedCancellationIdentity,
  ): Promise<{ canceled: boolean }> {
    if (
      this.env.OWNER_RELAY_GATE.idFromName(identity.ownerId).toString() !==
      this.ctx.id.toString()
    ) {
      return { canceled: false };
    }
    const now = Date.now();
    if (identity.expiresAt <= now) return { canceled: false };
    this.ctx.storage.sql.exec(
      "DELETE FROM managed_cancellations WHERE expires_at <= ?",
      now,
    );
    const key = managedCancellationKey(identity);
    this.ctx.storage.sql.exec(
      `INSERT INTO managed_cancellations (identity, expires_at) VALUES (?, ?)
       ON CONFLICT(identity) DO UPDATE SET expires_at = MIN(expires_at, excluded.expires_at)`,
      key,
      identity.expiresAt,
    );
    this.managedControllers
      .get(key)
      ?.controller.abort("managed_request_canceled");
    await this.armCancellationAlarm();
    return { canceled: true };
  }

  beginManagedRequest(
    identity: ManagedCancellationIdentity,
  ):
    | { canceled: true }
    | { canceled: false; key: string; signal: AbortSignal } {
    const key = managedCancellationKey(identity);
    const tombstone = this.ctx.storage.sql
      .exec<{
        expires_at: number;
      }>(
        "SELECT expires_at FROM managed_cancellations WHERE identity = ? AND expires_at > ?",
        key,
        Date.now(),
      )
      .toArray()[0];
    if (tombstone) return { canceled: true };
    const active = this.managedControllers.get(key);
    if (active) {
      active.references += 1;
      return { canceled: false, key, signal: active.controller.signal };
    }
    const controller = new AbortController();
    this.managedControllers.set(key, { controller, references: 1 });
    return { canceled: false, key, signal: controller.signal };
  }

  releaseManagedRequest(key: string): void {
    const active = this.managedControllers.get(key);
    if (!active) return;
    active.references -= 1;
    if (active.references === 0) this.managedControllers.delete(key);
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
