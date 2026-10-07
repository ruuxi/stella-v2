/**
 * Abuse admission and enforcement for one owner.
 *
 * - **Admission:** `admitSession` rules on a model-gateway session mint
 *   before billing reserves its budget: enforcement, step-up (Turnstile),
 *   and sybil pressure from D1 sightings.
 * - **Enforcement:** `abuse_state` holds the owner's status (ok, challenged,
 *   throttled, suspended) with an optional expiry. Every change is pushed to
 *   the model gateway (`ModelGatewayControl.applyOwnerEnforcement`) by the
 *   `abuse.pushEnforcement` job; `abuse.expire` clears it at `until`.
 * - **Risk:** `risk_signals` counts requests, spend, mints and sybil flags in
 *   1-hour and 24-hour buckets. The score is recomputed whenever a signal
 *   lands (a mint, or settled gateway usage); a high score challenges or
 *   throttles the owner for a day. D1's `owner_risk` mirrors the score and
 *   status for the admin top list.
 *
 * Without `TURNSTILE_SECRET_KEY` (dev) no client can answer a challenge, so
 * challenges are skipped; suspension still applies.
 */

import {
  GATEWAY_NETWORK_POLICY,
  type GatewayErrorCode,
  type IdentityLevel,
  type NetworkClass,
} from "@stella/contracts/gateway/api";
import {
  OWNER_ENFORCEMENT_STATUSES,
  type BillingControlResult,
  type OwnerEnforcementState,
  type SessionAdmissionResponse,
  type SessionCapabilityRequest,
  type GatewayOwnerEnforcementRequest,
  type GatewayUsageEvent,
  type OwnerEnforcement,
  type OwnerEnforcementStatus,
} from "@stella/contracts/gateway/usage";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import { dollarsToMicroCents } from "@stella/model-catalog/pricing";
import { log } from "../../build-session/shared/keys.js";
import { RpcError } from "../errors.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain, OwnerPurgeMode } from "../registry.js";

// ── Constants ──────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const RISK_WINDOWS = { "1h": HOUR_MS, "24h": DAY_MS } as const;
type RiskWindow = keyof typeof RISK_WINDOWS;
const DISTINCT_VALUE_LIMIT = 32;
const RISK_ENFORCEMENT_MS = DAY_MS;

const SYBIL_DEVICE_WINDOW_MS = 30 * DAY_MS;
const SYBIL_DEVICE_CHALLENGE_COUNT = 2;
const SYBIL_HOSTING_CHALLENGE_COUNT = 5;
export const SYBIL_SIGHTING_RETENTION_MS = SYBIL_DEVICE_WINDOW_MS;

export const ANON_ALLOWANCE_WINDOW_MS = 30 * DAY_MS;
/** Admin top-list rows for owners back at `ok` are dropped after this. */
export const OWNER_RISK_RETENTION_MS = 2 * DAY_MS;

const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const ABUSE_PUSH_JOB = "abuse.pushEnforcement";
export const ABUSE_EXPIRE_JOB = "abuse.expire";
export const ABUSE_RISK_JOB = "abuse.recordRisk";

export const ABUSE_MIGRATION = {
  id: "abuse.1-init",
  statements: [
    `CREATE TABLE abuse_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       status TEXT NOT NULL,
       until_at INTEGER,
       reason TEXT NOT NULL,
       actor TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE risk_signals (
       span TEXT PRIMARY KEY,
       bucket INTEGER NOT NULL,
       requests INTEGER NOT NULL,
       charged INTEGER NOT NULL,
       mints INTEGER NOT NULL,
       hosting_requests INTEGER NOT NULL,
       failed_requests INTEGER NOT NULL,
       sybil_flags INTEGER NOT NULL,
       ip_hashes TEXT NOT NULL,
       conversation_ids TEXT NOT NULL,
       score INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE risk_score (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       score INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ],
};

// ── Enforcement ────────────────────────────────────────────────────────────

type StateRow = {
  status: string;
  until_at: number | null;
  reason: string;
  actor: string;
  updated_at: number;
};

const readStateRow = (db: OwnerDbReader): StateRow | null =>
  db.one<StateRow>("SELECT status, until_at, reason, actor, updated_at FROM abuse_state WHERE id = 1");

const isStatus = (value: unknown): value is OwnerEnforcementStatus =>
  typeof value === "string" && (OWNER_ENFORCEMENT_STATUSES as readonly string[]).includes(value);

/** The owner's enforcement now. A status past its `until` reads as `ok`. */
export const readEnforcement = (ctx: { db: OwnerDbReader; now: number }): OwnerEnforcementState => {
  const row = readStateRow(ctx.db);
  if (!row) return { enforcement: { status: "ok" }, updatedAt: null };
  if (!isStatus(row.status) || row.status === "ok" || (row.until_at !== null && row.until_at <= ctx.now)) {
    return { enforcement: { status: "ok" }, updatedAt: row.updated_at };
  }
  return {
    enforcement: {
      status: row.status,
      ...(row.until_at !== null ? { until: row.until_at } : {}),
      ...(row.reason.trim() ? { reason: row.reason } : {}),
    },
    updatedAt: row.updated_at,
  };
};

/** The snapshot field the gate refuses suspended owners on. */
export const enforcementForSnapshot = (ctx: { db: OwnerDbReader; now: number }): OwnerEnforcement | undefined => {
  const { enforcement } = readEnforcement(ctx);
  return enforcement.status === "ok" ? undefined : enforcement;
};

export type SetEnforcementInput = {
  status: OwnerEnforcementStatus;
  until?: number;
  reason: string;
  actor: string;
};

/** Set the owner's status, push it to the gateway, and arm its expiry. */
export const setEnforcement = (ctx: OwnerContext, input: SetEnforcementInput): OwnerEnforcementState => {
  const reason = input.reason.trim();
  const actor = input.actor.trim();
  if (!isStatus(input.status) || !reason || !actor) {
    throw new RpcError("BAD_REQUEST", "status, reason and actor are required.");
  }
  if (input.until !== undefined && !Number.isFinite(input.until)) {
    throw new RpcError("BAD_REQUEST", "until must be a finite timestamp.");
  }
  const previous = readStateRow(ctx.db);
  // The gateway orders pushes by `updatedAt`, so it must always advance.
  const updatedAt = Math.max(ctx.now, (previous?.updated_at ?? 0) + 1);
  const until = input.status !== "ok" ? (input.until ?? null) : null;
  ctx.db.run(
    `INSERT INTO abuse_state (id, status, until_at, reason, actor, updated_at) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, until_at = excluded.until_at,
       reason = excluded.reason, actor = excluded.actor, updated_at = excluded.updated_at`,
    input.status,
    until,
    reason,
    actor,
    updatedAt,
  );
  log("info", "owner_enforcement_set", {
    ownerId: ctx.ownerId,
    from: previous?.status ?? "ok",
    to: input.status,
    actor,
    ...(until !== null ? { until } : {}),
  });
  ctx.jobs.schedule(ABUSE_PUSH_JOB, ctx.now, null, { id: ABUSE_PUSH_JOB });
  ctx.jobs.schedule(ABUSE_RISK_JOB, ctx.now, null, { id: ABUSE_RISK_JOB });
  if (until !== null) ctx.jobs.schedule(ABUSE_EXPIRE_JOB, until, null, { id: ABUSE_EXPIRE_JOB });
  else ctx.jobs.cancel(ABUSE_EXPIRE_JOB);
  return readEnforcement(ctx);
};

type GatewayEnforcementControl = {
  applyOwnerEnforcement(request: GatewayOwnerEnforcementRequest): Promise<void>;
};

const pushEnforcement = async (ctx: OwnerContext): Promise<void> => {
  const state = readEnforcement(ctx);
  if (state.updatedAt === null) return;
  const control = ctx.env.MODEL_GATEWAY_CONTROL as unknown as GatewayEnforcementControl | undefined;
  if (!control) throw new Error("MODEL_GATEWAY_CONTROL is not bound.");
  await control.applyOwnerEnforcement({
    ownerId: ctx.ownerId,
    enforcement: state.enforcement,
    updatedAt: state.updatedAt,
  });
  log("info", "owner_enforcement_pushed", {
    ownerId: ctx.ownerId,
    status: state.enforcement.status,
    updatedAt: state.updatedAt,
  });
};

const expireEnforcement = (ctx: OwnerContext): void => {
  const row = readStateRow(ctx.db);
  if (!row || row.status === "ok" || row.until_at === null) return;
  if (row.until_at > ctx.now) {
    ctx.jobs.schedule(ABUSE_EXPIRE_JOB, row.until_at, null, { id: ABUSE_EXPIRE_JOB });
    return;
  }
  setEnforcement(ctx, { status: "ok", reason: row.reason || "expired", actor: "system:expiry" });
};

// ── Risk ───────────────────────────────────────────────────────────────────

type RiskDelta = {
  requests?: number;
  chargedMicroCents?: number;
  mints?: number;
  hostingRequests?: number;
  failedRequests?: number;
  sybilFlags?: number;
  ipHashes?: string[];
  conversationIds?: string[];
};

type RiskRow = {
  span: string;
  bucket: number;
  requests: number;
  charged: number;
  mints: number;
  hosting_requests: number;
  failed_requests: number;
  sybil_flags: number;
  ip_hashes: string;
  conversation_ids: string;
  score: number;
  updated_at: number;
};

const parseList = (raw: string): string[] => {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const addDistinct = (values: string[], candidates: string[] | undefined): string[] => {
  const next = [...values];
  for (const candidate of candidates ?? []) {
    const value = candidate.trim();
    if (!value || next.includes(value) || next.length >= DISTINCT_VALUE_LIMIT) continue;
    next.push(value);
  }
  return next;
};

const count = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/** The risk rules: each signal over its threshold adds its weight. */
const riskScore = (
  row: {
    requests: number;
    charged: number;
    mints: number;
    hostingRequests: number;
    distinctIps: number;
    failedRequests: number;
    sybilFlags: number;
  },
  window: RiskWindow,
): number => {
  const hours = window === "1h" ? 1 : 24;
  const hostingShare = row.requests > 0 ? row.hostingRequests / row.requests : 0;
  const failedShare = row.requests > 0 ? row.failedRequests / row.requests : 0;
  let score = 0;
  if (row.requests / hours > 200) score += 30;
  if (row.charged / hours > dollarsToMicroCents(2)) score += 30;
  if (row.mints / hours > 6) score += 20;
  if (hostingShare > 0.5) score += 20;
  if (window === "24h" && row.distinctIps > 5) score += 20;
  if (failedShare > 0.5) score += 10;
  score += Math.min(40, row.sybilFlags * 20);
  return Math.round(score);
};

/**
 * Add signals to both windows, rescore, and escalate enforcement when the
 * score calls for it. Owners at identity level 3 (paying) are never
 * escalated automatically.
 */
export const recordRiskSignals = (ctx: OwnerContext, delta: RiskDelta, identityLevel: IdentityLevel): void => {
  let score = 0;
  for (const window of Object.keys(RISK_WINDOWS) as RiskWindow[]) {
    const bucket = Math.floor(ctx.now / RISK_WINDOWS[window]);
    const existing = ctx.db.one<RiskRow>("SELECT * FROM risk_signals WHERE span = ?", window);
    const current = existing && existing.bucket === bucket ? existing : null;
    const ipHashes = addDistinct(current ? parseList(current.ip_hashes) : [], delta.ipHashes);
    const conversationIds = addDistinct(current ? parseList(current.conversation_ids) : [], delta.conversationIds);
    const next = {
      requests: (current?.requests ?? 0) + count(delta.requests),
      charged: (current?.charged ?? 0) + count(delta.chargedMicroCents),
      mints: (current?.mints ?? 0) + count(delta.mints),
      hostingRequests: (current?.hosting_requests ?? 0) + count(delta.hostingRequests),
      failedRequests: (current?.failed_requests ?? 0) + count(delta.failedRequests),
      sybilFlags: (current?.sybil_flags ?? 0) + count(delta.sybilFlags),
      distinctIps: ipHashes.length,
    };
    const windowScore = riskScore(next, window);
    score = Math.max(score, windowScore);
    ctx.db.run(
      `INSERT OR REPLACE INTO risk_signals (span, bucket, requests, charged, mints, hosting_requests,
         failed_requests, sybil_flags, ip_hashes, conversation_ids, score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      window,
      bucket,
      next.requests,
      next.charged,
      next.mints,
      next.hostingRequests,
      next.failedRequests,
      next.sybilFlags,
      JSON.stringify(ipHashes),
      JSON.stringify(conversationIds),
      windowScore,
      ctx.now,
    );
  }
  const previous = ctx.db.one<{ score: number }>("SELECT score FROM risk_score WHERE id = 1")?.score;
  if (previous !== score) {
    ctx.db.run(
      `INSERT INTO risk_score (id, score, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
      score,
      ctx.now,
    );
    ctx.jobs.schedule(ABUSE_RISK_JOB, ctx.now, null, { id: ABUSE_RISK_JOB });
  }
  const status = score >= 80 ? "throttled" : score >= 60 ? "challenged" : null;
  if (!status || identityLevel >= 3) return;
  const current = readEnforcement(ctx).enforcement.status;
  if (current === "suspended" || current === "throttled" || (current === "challenged" && status === "challenged")) {
    return;
  }
  setEnforcement(ctx, {
    status,
    until: ctx.now + RISK_ENFORCEMENT_MS,
    reason: `automated risk score ${score}`,
    actor: "risk",
  });
};

/** Risk signals from settled gateway usage (the hook after billing applies a batch). */
export const recordGatewayUsageRisk = (
  ctx: OwnerContext,
  events: GatewayUsageEvent[],
  identityLevel: IdentityLevel,
): void => {
  if (events.length === 0) return;
  const delta: Required<RiskDelta> = {
    requests: 0,
    chargedMicroCents: 0,
    mints: 0,
    hostingRequests: 0,
    failedRequests: 0,
    sybilFlags: 0,
    ipHashes: [],
    conversationIds: [],
  };
  for (const event of events) {
    delta.requests += 1;
    delta.chargedMicroCents += count(event.chargedMicroCents);
    if (event.networkClass === "hosting") delta.hostingRequests += 1;
    if (event.outcome === "failed") delta.failedRequests += 1;
    if (event.conversationId) delta.conversationIds.push(event.conversationId);
  }
  recordRiskSignals(ctx, delta, identityLevel);
};

const recordOwnerRisk = async (ctx: OwnerContext): Promise<void> => {
  const database = ctx.env.DB;
  if (!database) throw new Error("The DB binding is missing.");
  const score = ctx.db.one<{ score: number }>("SELECT score FROM risk_score WHERE id = 1")?.score ?? 0;
  await database
    .prepare(
      `INSERT INTO owner_risk (owner_id, score, status, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET score = excluded.score, status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .bind(ctx.ownerId, score, readEnforcement(ctx).enforcement.status, ctx.now)
    .run();
};

/** Enforcement and risk windows, for the admin owner lookup. */
export const abuseState = (ctx: { db: OwnerDbReader; now: number }) => ({
  ...readEnforcement(ctx),
  score: ctx.db.one<{ score: number }>("SELECT score FROM risk_score WHERE id = 1")?.score ?? 0,
  riskSignals: ctx.db.all<RiskRow>("SELECT * FROM risk_signals").map((row) => ({
    window: row.span,
    requests: row.requests,
    chargedMicroCents: row.charged,
    mints: row.mints,
    hostingRequests: row.hosting_requests,
    distinctIps: parseList(row.ip_hashes).length,
    distinctConversations: parseList(row.conversation_ids).length,
    failedRequests: row.failed_requests,
    sybilFlags: row.sybil_flags,
    score: row.score,
    updatedAt: row.updated_at,
  })),
});

// ── Admission ──────────────────────────────────────────────────────────────

type SybilPressure =
  | { action: "ok" }
  | { action: "challenge"; reason: "device_key" | "hosting_network" };

type SybilKind = "device" | "hosting_ip";

/**
 * Distinct owners behind this device key or network, counting this owner.
 * Only identity level 1 is checked (and recorded).
 */
const evaluateSybilPressure = async (
  database: D1Database,
  input: {
    ownerId: string;
    deviceKeyHash: string;
    ipHash?: string;
    networkClass?: NetworkClass;
    identityLevel: IdentityLevel;
    now: number;
  },
): Promise<SybilPressure> => {
  if (input.identityLevel >= 2) return { action: "ok" };
  const query = (kind: SybilKind, key: string, windowMs: number, limit: number) =>
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM sybil_sightings
           WHERE kind = ? AND key_hash = ? AND owner_id <> ? AND last_seen_at >= ? LIMIT ?)`,
      )
      .bind(kind, key, input.ownerId, input.now - windowMs, limit);
  const checks: Array<{ check: "device" | "hosting"; statement: D1PreparedStatement }> = [];
  checks.push({
    check: "device",
    statement: query("device", input.deviceKeyHash, SYBIL_DEVICE_WINDOW_MS, SYBIL_DEVICE_CHALLENGE_COUNT),
  });
  if (input.networkClass === "hosting" && input.ipHash) {
    checks.push({
      check: "hosting",
      statement: query("hosting_ip", input.ipHash, DAY_MS, SYBIL_HOSTING_CHALLENGE_COUNT),
    });
  }
  const results = await database.batch<{ n: number }>(checks.map((entry) => entry.statement));
  const owners = new Map(
    checks.map((entry, index) => [entry.check, Number(results[index]?.results[0]?.n ?? 0) + 1]),
  );
  if ((owners.get("device") ?? 0) >= SYBIL_DEVICE_CHALLENGE_COUNT) return { action: "challenge", reason: "device_key" };
  if ((owners.get("hosting") ?? 0) >= SYBIL_HOSTING_CHALLENGE_COUNT) {
    return { action: "challenge", reason: "hosting_network" };
  }
  return { action: "ok" };
};

const recordSightings = async (
  database: D1Database,
  input: { ownerId: string; deviceKeyHash: string; ipHash?: string; networkClass?: NetworkClass; identityLevel: IdentityLevel; now: number },
): Promise<void> => {
  if (input.identityLevel >= 2) return;
  const upsert = (kind: SybilKind, key: string) =>
    database
      .prepare(
        `INSERT INTO sybil_sightings (kind, key_hash, owner_id, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, key_hash, owner_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .bind(kind, key, input.ownerId, input.now);
  const statements = [upsert("device", input.deviceKeyHash)];
  if (input.networkClass === "hosting" && input.ipHash) statements.push(upsert("hosting_ip", input.ipHash));
  await database.batch(statements);
};

let loggedTurnstileOff = false;

const turnstileSecret = (env: Cloudflare.Env): string | undefined => {
  const raw = (env as unknown as Record<string, unknown>).TURNSTILE_SECRET_KEY;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
};

const verifyTurnstile = async (secret: string, token: string | undefined): Promise<boolean> => {
  const response = token?.trim();
  if (!response) return false;
  try {
    const result = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) return false;
    const body = (await result.json()) as { success?: unknown };
    return body.success === true;
  } catch {
    return false;
  }
};

const refuse = (
  code: GatewayErrorCode | null,
  status: number,
): Extract<BillingControlResult<never>, { ok: false }> => ({
  ok: false,
  status,
  code,
  retryable: false,
});

const inClass = (classes: readonly NetworkClass[], networkClass: NetworkClass | undefined) =>
  networkClass !== undefined && classes.includes(networkClass);

export type SessionAdmissionInput = SessionCapabilityRequest & {
  paying: boolean;
  snapshot: OwnerSnapshot;
};

/**
 * May this owner, device and network have a session capability? Rules on
 * enforcement, step-up and sybil pressure, and records the mint's sightings
 * and risk signals.
 */
export const admitSession = async (
  ctx: OwnerContext,
  input: SessionAdmissionInput,
): Promise<BillingControlResult<SessionAdmissionResponse>> => {
  const { snapshot } = input;
  const enforcement = readEnforcement(ctx).enforcement;
  if (enforcement.status === "suspended") return refuse("owner_suspended", 403);
  if (!snapshot.writable) return refuse(null, 404);
  const identityLevel: IdentityLevel = input.paying
    ? 3
    : (Math.min(2, Math.max(1, snapshot.identityLevel)) as IdentityLevel);
  const database = ctx.env.DB;
  if (!database) {
    log("error", "abuse_admission_unavailable", { message: "The DB binding is missing." });
    return { ok: false, status: null, code: null, retryable: true };
  }
  const now = ctx.now;
  const sighting = {
    ownerId: ctx.ownerId,
    deviceKeyHash: input.deviceKeyHash,
    ...(input.ipHash ? { ipHash: input.ipHash } : {}),
    ...(input.networkClass ? { networkClass: input.networkClass } : {}),
    identityLevel,
    now,
  };
  const sybil = await evaluateSybilPressure(database, sighting);
  const secret = turnstileSecret(ctx.env);
  if (!secret && !loggedTurnstileOff) {
    loggedTurnstileOff = true;
    log("info", "turnstile_disabled", { message: "TURNSTILE_SECRET_KEY unset; challenges are skipped." });
  }
  const challengeRequired =
    enforcement.status === "challenged" ||
    (identityLevel < 3 && inClass(GATEWAY_NETWORK_POLICY.freeChallenged, input.networkClass)) ||
    sybil.action === "challenge";
  if (secret && challengeRequired && !(await verifyTurnstile(secret, input.turnstileToken))) {
    if (sybil.action !== "ok") recordRiskSignals(ctx, { sybilFlags: 1 }, identityLevel);
    log("info", "abuse_admission_refused", {
      ownerId: ctx.ownerId,
      code: "challenge_required",
      ...(sybil.action !== "ok" ? { reason: sybil.reason } : {}),
    });
    return refuse("challenge_required", 403);
  }
  await recordSightings(database, sighting);
  recordRiskSignals(ctx, { mints: 1, sybilFlags: sybil.action !== "ok" ? 1 : 0 }, identityLevel);
  log("info", "abuse_admission", {
    ownerId: ctx.ownerId,
    identityLevel,
    sybil: sybil.action === "ok" ? "ok" : sybil.reason,
  });
  return {
    ok: true,
    body: {
      ownerGeneration: snapshot.ownerGeneration,
      identityLevel,
    },
  };
};

// ── Sweeps and purge ───────────────────────────────────────────────────────

/** The Cron Trigger's TTL sweep of the abuse tables in D1. */
export const sweepAbuseTables = async (env: Cloudflare.Env, now = Date.now()): Promise<void> => {
  const database = env.DB;
  if (!database) throw new Error("The DB binding is missing.");
  await database.batch([
    database.prepare("DELETE FROM sybil_sightings WHERE last_seen_at < ?").bind(now - SYBIL_SIGHTING_RETENTION_MS),
    database.prepare("DELETE FROM anon_allowance WHERE window_start < ?").bind(now - ANON_ALLOWANCE_WINDOW_MS),
    database
      .prepare("DELETE FROM owner_risk WHERE status = 'ok' AND updated_at < ?")
      .bind(now - OWNER_RISK_RETENTION_MS),
  ]);
};

/**
 * Enforcement and risk survive a reset, so resetting can't lift a
 * suspension. Account deletion drops them and the admin row; D1 sightings
 * and allowances age out on their own.
 */
const purgeAbuse = async (ctx: OwnerContext, mode: OwnerPurgeMode): Promise<{ pending: boolean }> => {
  if (mode !== "delete") return { pending: false };
  ctx.jobs.cancel(ABUSE_PUSH_JOB);
  ctx.jobs.cancel(ABUSE_EXPIRE_JOB);
  ctx.jobs.cancel(ABUSE_RISK_JOB);
  ctx.db.run("DELETE FROM abuse_state");
  ctx.db.run("DELETE FROM risk_signals");
  ctx.db.run("DELETE FROM risk_score");
  await ctx.env.DB?.prepare("DELETE FROM owner_risk WHERE owner_id = ?").bind(ctx.ownerId).run();
  return { pending: false };
};

export const abuseDomain = {
  name: "abuse",
  migrations: [ABUSE_MIGRATION],
  jobs: {
    [ABUSE_PUSH_JOB]: { run: pushEnforcement, maxAttempts: 50 },
    [ABUSE_EXPIRE_JOB]: { run: expireEnforcement },
    [ABUSE_RISK_JOB]: { run: recordOwnerRisk },
  },
  purge: purgeAbuse,
} satisfies OwnerDomain;
