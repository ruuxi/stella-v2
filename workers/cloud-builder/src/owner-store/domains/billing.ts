/**
 * The owner's billing ledger: the plan Stripe last reported, usage against
 * the plan's windows, purchased credits, and the budget handed out in
 * session capabilities. Everything that spends on a managed model settles
 * here, one owner at a time, so two requests can never both spend the last
 * of an allowance.
 *
 * Stripe stays the record for money. Subscription events refetch the
 * subscription, so the plan follows Stripe's current state whatever order
 * events arrive in, and every event id is applied once.
 */

import type {
  BillingCalls,
  BillingPlan,
  BillingStatus,
  CloudSandboxAccess,
  PaidBillingPlan,
} from "@stella/contracts/backend/billing";
import {
  GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS,
  limitsAudienceFor,
  type IdentityLevel,
} from "@stella/contracts/gateway/api";
import {
  GATEWAY_BUDGET_UNLIMITED,
  type ManagedModelAudience,
} from "@stella/contracts/gateway/capability";
import type { GatewayUsageEvent } from "@stella/contracts/gateway/usage";
import {
  BillingConfigError,
  billingConfig,
  planForStripePrice,
  type BillingConfig,
} from "../../billing/plans.js";
import { stripeRequest, StripeError, type StripeEvent } from "../../billing/stripe.js";
import { empty, literal, number, object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDb, OwnerDbReader, OwnerDomain } from "../registry.js";

const MICRO_CENTS_PER_USD = 100_000_000;
const LIFETIME_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** A session grant's unspent budget is held this long past its expiry for late usage. */
const GRANT_SETTLEMENT_GRACE_MS = 10 * 60 * 1000;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);
const CREDIT_CURRENCY = "usd";
const CREDIT_MIN_CENTS = 100;
const CREDIT_MAX_CENTS = 50_000;
const CREDIT_PRESET_CENTS = [500, 1_000, 2_500, 5_000];
const ANON_RESET_AFTER_INACTIVITY_DAYS = 30;
const STRIPE_RATE_LIMIT = { count: 10, windowMs: 60_000 };

export const BILLING_MIGRATION = {
  id: "billing.1-ledger",
  statements: [
    `CREATE TABLE billing_account (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       plan TEXT NOT NULL,
       usage_mode TEXT NOT NULL,
       subscription_status TEXT NOT NULL,
       stripe_customer_id TEXT,
       stripe_subscription_id TEXT,
       stripe_price_id TEXT,
       current_period_end INTEGER NOT NULL,
       cancel_at_period_end INTEGER NOT NULL,
       payment_method_brand TEXT,
       payment_method_last4 TEXT,
       monthly_anchor_at INTEGER NOT NULL,
       rolling_used INTEGER NOT NULL,
       rolling_started_at INTEGER NOT NULL,
       weekly_used INTEGER NOT NULL,
       weekly_started_at INTEGER NOT NULL,
       monthly_used INTEGER NOT NULL,
       monthly_started_at INTEGER NOT NULL,
       total_used INTEGER NOT NULL,
       total_requests INTEGER NOT NULL,
       credit_balance INTEGER NOT NULL,
       credit_purchased INTEGER NOT NULL,
       credit_consumed INTEGER NOT NULL,
       is_anonymous INTEGER NOT NULL,
       identity_level INTEGER NOT NULL,
       reported_plan TEXT,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE billing_grants (
       jti TEXT PRIMARY KEY,
       budget INTEGER NOT NULL,
       settled INTEGER NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
    `CREATE TABLE billing_receipts (
       id TEXT PRIMARY KEY,
       charged INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    "CREATE INDEX billing_receipts_created ON billing_receipts (created_at)",
    `CREATE TABLE billing_stripe_events (
       id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE billing_credit_purchases (
       checkout_session_id TEXT PRIMARY KEY,
       amount INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ],
};

type AccountRow = {
  plan: string;
  usage_mode: string;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  current_period_end: number;
  cancel_at_period_end: number;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
  monthly_anchor_at: number;
  rolling_used: number;
  rolling_started_at: number;
  weekly_used: number;
  weekly_started_at: number;
  monthly_used: number;
  monthly_started_at: number;
  total_used: number;
  total_requests: number;
  credit_balance: number;
  credit_purchased: number;
  credit_consumed: number;
  is_anonymous: number;
  identity_level: number;
  reported_plan: string | null;
  updated_at: number;
};

// ── Calendar windows ───────────────────────────────────────────────────────

const weekBounds = (now: number) => {
  const date = new Date(now);
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  start.setUTCHours(0, 0, 0, 0);
  return { start: start.getTime(), end: start.getTime() + 7 * 24 * 60 * 60 * 1000 };
};

/** The monthly window containing `now`, anchored on the billing day of `anchor`. */
const monthBounds = (now: number, anchor: number) => {
  const a = new Date(anchor);
  const at = (year: number, month: number) => {
    const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(
      year,
      month,
      Math.min(a.getUTCDate(), maxDay),
      a.getUTCHours(),
      a.getUTCMinutes(),
      a.getUTCSeconds(),
      a.getUTCMilliseconds(),
    );
  };
  const shift = (year: number, month: number, delta: number) => {
    const total = year * 12 + month + delta;
    return [Math.floor(total / 12), ((total % 12) + 12) % 12] as const;
  };
  const date = new Date(now);
  let [year, month] = [date.getUTCFullYear(), date.getUTCMonth()];
  let start = at(year, month);
  if (start > now) {
    [year, month] = shift(year, month, -1);
    start = at(year, month);
  }
  const [endYear, endMonth] = shift(year, month, 1);
  return { start, end: at(endYear, endMonth) };
};

// ── The account row ────────────────────────────────────────────────────────

const defaultAccount = (now: number): AccountRow => ({
  plan: "free",
  usage_mode: "default",
  subscription_status: "none",
  stripe_customer_id: null,
  stripe_subscription_id: null,
  stripe_price_id: null,
  current_period_end: 0,
  cancel_at_period_end: 0,
  payment_method_brand: null,
  payment_method_last4: null,
  monthly_anchor_at: now,
  rolling_used: 0,
  rolling_started_at: now,
  weekly_used: 0,
  weekly_started_at: weekBounds(now).start,
  monthly_used: 0,
  monthly_started_at: monthBounds(now, now).start,
  total_used: 0,
  total_requests: 0,
  credit_balance: 0,
  credit_purchased: 0,
  credit_consumed: 0,
  is_anonymous: 0,
  identity_level: 1,
  reported_plan: null,
  updated_at: now,
});

const readAccount = (db: OwnerDbReader, now: number): AccountRow =>
  db.one<AccountRow>("SELECT * FROM billing_account WHERE id = 1") ?? defaultAccount(now);

const ensureAccount = (db: OwnerDb, now: number): AccountRow => {
  const row = db.one<AccountRow>("SELECT * FROM billing_account WHERE id = 1");
  if (row) return row;
  const created = defaultAccount(now);
  const columns = Object.keys(created);
  db.run(
    `INSERT INTO billing_account (id, ${columns.join(", ")}) VALUES (1, ${columns.map(() => "?").join(", ")})`,
    ...columns.map((column) => created[column as keyof AccountRow]),
  );
  return created;
};

const updateAccount = (db: OwnerDb, fields: Partial<AccountRow>): void => {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  db.run(
    `UPDATE billing_account SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE id = 1`,
    ...entries.map(([, value]) => value as number | string | null),
  );
};

const plan = (row: AccountRow): BillingPlan =>
  row.plan === "go" || row.plan === "pro" ? row.plan : "free";

const isPaying = (row: AccountRow): boolean =>
  (plan(row) !== "free" && ACTIVE_SUBSCRIPTION_STATUSES.has(row.subscription_status)) ||
  row.credit_balance > 0;

/** The identity rung: the auth claims know sign-in, this ledger knows payment. */
const identityLevel = (row: AccountRow): IdentityLevel =>
  row.is_anonymous ? 0 : isPaying(row) ? 3 : (Math.min(2, Math.max(1, row.identity_level)) as IdentityLevel);

// ── Usage against the plan's windows ──────────────────────────────────────

type Window = { used: number; limit: number; resetAt: number; exceeded: boolean };

type UsageSnapshot = {
  rolling: Window;
  weekly: Window;
  monthly: Window;
  lifetime: Window | null;
  /** Window starts and usage with expired windows zeroed. */
  normalized: Pick<
    AccountRow,
    "rolling_used" | "rolling_started_at" | "weekly_used" | "weekly_started_at" | "monthly_used" | "monthly_started_at"
  >;
};

const usageSnapshot = (config: BillingConfig, row: AccountRow, now: number): UsageSnapshot => {
  const anonymous = row.is_anonymous === 1;
  const current = plan(row);
  const planConfig = anonymous ? config.anonymous : config.plans[current];
  const share =
    !anonymous && current === "free" && identityLevel(row) === 1 ? config.freeEmailAllowanceShare : 1;
  const limit = (usd: number) => Math.round(usd * share * MICRO_CENTS_PER_USD);

  const rollingMs = Math.max(1, Math.floor(planConfig.rollingWindowHours * 60 * 60 * 1000));
  const rollingActive = row.rolling_started_at > 0 && row.rolling_started_at >= now - rollingMs;
  const rollingStart = rollingActive ? row.rolling_started_at : now;
  const rollingUsed = rollingActive ? row.rolling_used : 0;

  const week = weekBounds(now);
  const weeklyActive = row.weekly_started_at >= week.start;
  const weeklyUsed = weeklyActive ? row.weekly_used : 0;

  const month = monthBounds(now, row.monthly_anchor_at > 0 ? row.monthly_anchor_at : now);
  const monthlyActive = row.monthly_started_at >= month.start;
  const monthlyUsed = monthlyActive ? row.monthly_used : 0;

  const window = (used: number, max: number, resetAt: number): Window => ({
    used,
    limit: max,
    resetAt,
    exceeded: used >= max,
  });
  return {
    rolling: window(rollingUsed, limit(planConfig.rollingLimitUsd), rollingStart + rollingMs),
    weekly: window(weeklyUsed, limit(planConfig.weeklyLimitUsd), week.end),
    monthly: window(monthlyUsed, limit(planConfig.monthlyLimitUsd), month.end),
    lifetime:
      planConfig.lifetimeLimitUsd === undefined
        ? null
        : window(row.total_used, limit(planConfig.lifetimeLimitUsd), now + LIFETIME_RETRY_AFTER_MS),
    normalized: {
      rolling_used: rollingUsed,
      rolling_started_at: rollingStart,
      weekly_used: weeklyUsed,
      weekly_started_at: weeklyActive ? row.weekly_started_at : week.start,
      monthly_used: monthlyUsed,
      monthly_started_at: monthlyActive ? row.monthly_started_at : month.start,
    },
  };
};

/** Spend left inside the plan's windows, before purchased credit. */
const includedHeadroom = (snapshot: UsageSnapshot): number =>
  Math.max(
    0,
    Math.min(
      snapshot.rolling.limit - snapshot.rolling.used,
      snapshot.weekly.limit - snapshot.weekly.used,
      snapshot.monthly.limit - snapshot.monthly.used,
      snapshot.lifetime ? snapshot.lifetime.limit - snapshot.lifetime.used : Number.POSITIVE_INFINITY,
    ),
  );

export type BillingAccess = {
  plan: BillingPlan;
  isAnonymous: boolean;
  identityLevel: IdentityLevel;
  unlimited: boolean;
  allowed: boolean;
  /** Paid plans past their windows keep going on fallback models. */
  downgraded: boolean;
  audience: ManagedModelAudience;
  retryAfterMs: number;
  message: string;
  /** Spend available now (windows plus credit); null when unlimited. */
  remainingMicroCents: number | null;
};

const audienceFor = (
  current: BillingPlan,
  anonymous: boolean,
  downgraded: boolean,
): ManagedModelAudience =>
  anonymous ? "anonymous" : current === "free" ? "free" : downgraded ? `${current}_fallback` : current;

const accessFor = (config: BillingConfig, row: AccountRow, now: number): BillingAccess => {
  // Without billing every account is Pro with unlimited usage.
  const current = config.enabled ? plan(row) : "pro";
  const anonymous = row.is_anonymous === 1;
  const unlimited = row.usage_mode === "unlimited" || !config.enabled;
  const snapshot = usageSnapshot(config, row, now);
  const credit = Math.max(0, row.credit_balance);
  const remaining = includedHeadroom(snapshot) + credit;
  const base = {
    plan: current,
    isAnonymous: anonymous,
    identityLevel: identityLevel(row),
    unlimited,
    remainingMicroCents: unlimited ? null : remaining,
  };
  // A window blocks only when neither it nor purchased credit has room;
  // the lifetime allowance is checked first because it never comes back.
  const blocks = (window: Window) => Math.max(0, window.limit - window.used) + credit <= 0;
  const blocking = unlimited
    ? null
    : snapshot.lifetime && blocks(snapshot.lifetime)
      ? { window: snapshot.lifetime, lifetime: true }
      : [snapshot.rolling, snapshot.weekly, snapshot.monthly]
          .filter(blocks)
          .map((window) => ({ window, lifetime: false }))[0] ?? null;
  if (!blocking) {
    return {
      ...base,
      allowed: true,
      downgraded: false,
      audience: audienceFor(current, anonymous && config.enabled, false),
      retryAfterMs: 0,
      message: "",
    };
  }
  const retryAfterMs = Math.max(1_000, blocking.window.resetAt - now);
  if (current === "free") {
    return {
      ...base,
      allowed: false,
      downgraded: false,
      audience: audienceFor(current, anonymous, false),
      retryAfterMs,
      message: blocking.lifetime
        ? "You've used your free Stella allowance. Upgrade to keep going."
        : "Free plan usage limit reached. Upgrade to continue.",
    };
  }
  return {
    ...base,
    allowed: true,
    downgraded: true,
    audience: audienceFor(current, anonymous, true),
    retryAfterMs,
    message: `${config.plans[current].label} plan managed-model limits reached. Falling back until usage resets.`,
  };
};

/** Budget still held by live session grants: issued but not yet spent. */
const reservedGrants = (db: OwnerDbReader, now: number): number =>
  db.one<{ reserved: number | null }>(
    "SELECT SUM(MAX(0, budget - settled)) AS reserved FROM billing_grants WHERE expires_at + ? >= ?",
    GRANT_SETTLEMENT_GRACE_MS,
    now,
  )?.reserved ?? 0;

const capabilityBudget = (access: BillingAccess, reserved: number): number => {
  if (access.remainingMicroCents === null) return GATEWAY_BUDGET_UNLIMITED;
  const chunk = GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS[limitsAudienceFor(access.audience)];
  return Math.min(Math.max(0, Math.floor(access.remainingMicroCents - reserved)), chunk);
};

/** Note who the owner is, as the latest verified sign-in says. */
export const recordBillingIdentity = (
  ctx: OwnerContext,
  identity: { isAnonymous: boolean; identityLevel?: IdentityLevel },
): void => {
  const row = ensureAccount(ctx.db, ctx.now);
  const level = identity.identityLevel ?? row.identity_level;
  if (row.is_anonymous === Number(identity.isAnonymous) && row.identity_level === level) return;
  updateAccount(ctx.db, { is_anonymous: identity.isAnonymous ? 1 : 0, identity_level: level });
};

/** The owner pays: an active paid plan, or purchased credit left. */
export const billingPaying = (ctx: { db: OwnerDbReader; now: number }): boolean =>
  isPaying(readAccount(ctx.db, ctx.now));

const billingOff = (env: Cloudflare.Env): boolean => {
  try {
    return !billingConfig(env).enabled;
  } catch {
    return false;
  }
};

/** The plan and whether usage is unlimited, for plan quotas kept by other domains. */
export const billingPlan = (ctx: {
  db: OwnerDbReader;
  env: Cloudflare.Env;
  now: number;
}): { plan: BillingPlan; unlimited: boolean } => {
  if (billingOff(ctx.env)) return { plan: "pro", unlimited: true };
  const row = readAccount(ctx.db, ctx.now);
  return { plan: plan(row), unlimited: row.usage_mode === "unlimited" };
};

export const billingAccess = (ctx: { db: OwnerDbReader; env: Cloudflare.Env; now: number }): BillingAccess =>
  accessFor(billingConfig(ctx.env), readAccount(ctx.db, ctx.now), ctx.now);

const subscribedPlan = (row: AccountRow): BillingPlan =>
  plan(row) !== "free" && ACTIVE_SUBSCRIPTION_STATUSES.has(row.subscription_status) ? plan(row) : "free";

export const cloudSandboxAccess = (ctx: {
  db: OwnerDbReader;
  env: Cloudflare.Env;
  now: number;
}): CloudSandboxAccess => {
  let config: BillingConfig;
  try {
    config = billingConfig(ctx.env);
  } catch (error) {
    if (error instanceof BillingConfigError) return { enabled: false };
    throw error;
  }
  if (!config.enabled) return config.plans.pro.cloudSandbox;
  const row = readAccount(ctx.db, ctx.now);
  if (row.is_anonymous === 1) return config.anonymous.cloudSandbox;
  return config.plans[subscribedPlan(row)].cloudSandbox;
};

/** Budget for a turn capability: the gateway's owner gate meters it. */
export const turnAllowance = (ctx: { db: OwnerDbReader; env: Cloudflare.Env; now: number }) => {
  const access = billingAccess(ctx);
  return {
    plan: access.plan,
    identityLevel: access.identityLevel,
    allowance: {
      audience: access.audience,
      budgetMicroCents: capabilityBudget(access, reservedGrants(ctx.db, ctx.now)),
    },
  };
};

/**
 * Reserve a session capability's budget: the smaller of what is left after
 * other live grants and one chunk for the audience. The grant is settled by
 * the usage the gateway reports against `jti`.
 */
export const reserveSessionGrant = (
  ctx: OwnerContext,
  input: { jti: string; expiresAt: number },
): BillingAccess & { budgetMicroCents: number } => {
  ctx.db.run(
    "DELETE FROM billing_grants WHERE expires_at + ? < ?",
    GRANT_SETTLEMENT_GRACE_MS,
    ctx.now,
  );
  const access = billingAccess(ctx);
  const budgetMicroCents = capabilityBudget(access, reservedGrants(ctx.db, ctx.now));
  if (budgetMicroCents !== GATEWAY_BUDGET_UNLIMITED) {
    ctx.db.run(
      "INSERT INTO billing_grants (jti, budget, settled, expires_at) VALUES (?, ?, 0, ?)",
      input.jti,
      budgetMicroCents,
      input.expiresAt,
    );
  }
  return { ...access, budgetMicroCents };
};

export const reserveUsage = (
  ctx: OwnerContext,
  input: { id: string; budgetMicroCents: number; expiresAt: number },
): BillingAccess & { reserved: boolean } => {
  ctx.db.run("DELETE FROM billing_grants WHERE expires_at + ? < ?", GRANT_SETTLEMENT_GRACE_MS, ctx.now);
  const access = billingAccess(ctx);
  if (!access.allowed) return { ...access, reserved: false };
  const budget = Math.max(0, Math.ceil(input.budgetMicroCents));
  if (access.remainingMicroCents === null) return { ...access, reserved: true };
  if (access.remainingMicroCents - reservedGrants(ctx.db, ctx.now) < budget) return { ...access, reserved: false };
  ctx.db.run(
    "INSERT OR REPLACE INTO billing_grants (jti, budget, settled, expires_at) VALUES (?, ?, 0, ?)",
    input.id,
    budget,
    input.expiresAt,
  );
  return { ...access, reserved: true };
};

export const settleReservation = (ctx: OwnerContext, id: string, costMicroCents: number): void => {
  ctx.db.run("UPDATE billing_grants SET settled = settled + ? WHERE jti = ?", Math.max(0, Math.floor(costMicroCents)), id);
};

export const releaseReservation = (ctx: OwnerContext, id: string): void => {
  ctx.db.run("DELETE FROM billing_grants WHERE jti = ?", id);
};

// ── Settling usage ─────────────────────────────────────────────────────────

/**
 * Charge spend against the windows, drawing purchased credit for whatever
 * the windows no longer cover. Unlimited owners are metered but never draw
 * credit.
 */
const charge = (ctx: OwnerContext, costMicroCents: number): void => {
  const cost = Math.max(0, Math.floor(costMicroCents));
  const row = ensureAccount(ctx.db, ctx.now);
  const snapshot = usageSnapshot(billingConfig(ctx.env), row, ctx.now);
  const fromCredit =
    row.usage_mode === "unlimited"
      ? 0
      : Math.min(Math.max(0, row.credit_balance), Math.max(0, cost - includedHeadroom(snapshot)));
  updateAccount(ctx.db, {
    ...snapshot.normalized,
    rolling_used: snapshot.normalized.rolling_used + cost,
    weekly_used: snapshot.normalized.weekly_used + cost,
    monthly_used: snapshot.normalized.monthly_used + cost,
    total_used: row.total_used + cost,
    total_requests: row.total_requests + 1,
    credit_balance: row.credit_balance - fromCredit,
    credit_consumed: row.credit_consumed + fromCredit,
    updated_at: ctx.now,
  });
};

const claimReceipt = (ctx: OwnerContext, id: string, charged: number): boolean => {
  if (ctx.db.one("SELECT 1 AS seen FROM billing_receipts WHERE id = ?", id)) return false;
  ctx.db.run(
    "INSERT INTO billing_receipts (id, charged, created_at) VALUES (?, ?, ?)",
    id,
    Math.max(0, Math.floor(charged)),
    ctx.now,
  );
  return true;
};

const pruneReceipts = (ctx: OwnerContext): void => {
  ctx.db.run("DELETE FROM billing_receipts WHERE created_at < ?", ctx.now - RECEIPT_RETENTION_MS);
};

export type UsageBatchResult = {
  accepted: string[];
  duplicate: string[];
  rejected: Array<{ requestId: string; reason: string }>;
};

/** Settle the gateway's usage events for this owner. Idempotent on `requestId`. */
export const applyGatewayUsage = (ctx: OwnerContext, events: GatewayUsageEvent[]): UsageBatchResult => {
  const result: UsageBatchResult = { accepted: [], duplicate: [], rejected: [] };
  pruneReceipts(ctx);
  for (const event of events) {
    if (event.ownerId !== ctx.ownerId) {
      result.rejected.push({ requestId: event.requestId, reason: "owner_mismatch" });
      continue;
    }
    const charged = Math.max(0, Math.floor(event.chargedMicroCents));
    if (!claimReceipt(ctx, `gw:${event.requestId}`, charged)) {
      result.duplicate.push(event.requestId);
      continue;
    }
    ctx.db.run("UPDATE billing_grants SET settled = settled + ? WHERE jti = ?", charged, event.capabilityId);
    if (event.billable && event.outcome !== "failed") charge(ctx, charged);
    result.accepted.push(event.requestId);
  }
  return result;
};

/** Spend metered outside the gateway (media, voice, search). Idempotent on `id`. */
export const recordUsage = (
  ctx: OwnerContext,
  records: Array<{ id: string; costMicroCents: number }>,
): { recorded: number; duplicate: number } => {
  let recorded = 0;
  pruneReceipts(ctx);
  for (const record of records) {
    if (!claimReceipt(ctx, `use:${record.id}`, record.costMicroCents)) continue;
    charge(ctx, record.costMicroCents);
    recorded += 1;
  }
  return { recorded, duplicate: records.length - recorded };
};

// ── Admin ──────────────────────────────────────────────────────────────────

/** Set a plan outside Stripe (test accounts, support). Resets usage on a change. */
export const setAdminPlan = (
  ctx: OwnerContext,
  input: { plan?: BillingPlan; usageMode?: "default" | "unlimited"; resetUsage?: boolean },
): void => {
  const row = ensureAccount(ctx.db, ctx.now);
  const nextPlan = input.plan ?? plan(row);
  const planChanged = nextPlan !== plan(row);
  const usageMode = input.usageMode ?? (planChanged ? "default" : row.usage_mode);
  const anchor = nextPlan === "free" ? row.monthly_anchor_at : ctx.now;
  updateAccount(ctx.db, {
    plan: nextPlan,
    usage_mode: usageMode,
    subscription_status: nextPlan === "free" ? "none" : "active",
    current_period_end: 0,
    cancel_at_period_end: 0,
    monthly_anchor_at: anchor,
    ...(input.resetUsage ?? (planChanged || usageMode !== row.usage_mode)
      ? resetWindows(ctx.now, anchor)
      : {}),
    updated_at: ctx.now,
  });
};

const resetWindows = (now: number, anchor: number): Partial<AccountRow> => ({
  rolling_used: 0,
  rolling_started_at: now,
  weekly_used: 0,
  weekly_started_at: weekBounds(now).start,
  monthly_used: 0,
  monthly_started_at: monthBounds(now, anchor).start,
});

// ── Stripe ─────────────────────────────────────────────────────────────────

type StripeSubscription = {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end?: boolean;
  current_period_start?: number;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items?: {
    data?: Array<{
      price?: { id?: string };
      current_period_start?: number;
      current_period_end?: number;
    }>;
  };
  default_payment_method?: { card?: { brand?: string; last4?: string } } | string | null;
};

const normalizeReturnUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RpcError("BAD_REQUEST", "Invalid return URL.");
  }
  const host = parsed.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!local && parsed.protocol !== "https:") {
    throw new RpcError("BAD_REQUEST", "Return URL must use HTTPS outside local development.");
  }
  return parsed.toString();
};

const withCheckoutStatus = (returnUrl: string, status: "success" | "cancel"): string => {
  const parsed = new URL(returnUrl);
  parsed.searchParams.set("checkout", status);
  return parsed.toString();
};

const stripeUnavailable = (error: unknown): RpcError =>
  new RpcError(
    "UNAVAILABLE",
    error instanceof StripeError && error.status < 500
      ? error.message
      : "Billing is temporarily unavailable. Try again.",
    { retryable: !(error instanceof StripeError && error.status < 500) },
  );

/** Purchases need billing; a deployment without it says so instead of "try again". */
const requireBilling = (env: Cloudflare.Env): void => {
  if (!billingConfig(env).enabled) {
    throw new RpcError("UNAVAILABLE", "Billing isn't set up on this Stella.", { retryable: false });
  }
};

/** The owner's Stripe customer, created on first use with the owner id attached. */
const ensureCustomer = async (ctx: OwnerContext): Promise<string> => {
  const row = ensureAccount(ctx.db, ctx.now);
  if (row.stripe_customer_id) return row.stripe_customer_id;
  const customer = await stripeRequest<{ id: string }>(
    ctx.env,
    "POST",
    "/customers",
    { metadata: { ownerId: ctx.ownerId } },
    { idempotencyKey: `stella-customer-${ctx.ownerId}` },
  );
  updateAccount(ctx.db, { stripe_customer_id: customer.id, updated_at: ctx.now });
  return customer.id;
};

const checkout = async (
  ctx: OwnerContext,
  args: BillingCalls["billing.checkout"]["args"],
): Promise<{ url: string; sessionId: string }> => {
  requireBilling(ctx.env);
  const source = args.source?.trim().toLowerCase() || "web";
  if (source === "ios" && args.appStoreCountry?.trim().toUpperCase() !== "USA") {
    throw new RpcError("FORBIDDEN", "In-app subscriptions aren't available in your App Store region.");
  }
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "billing.stripe",
    STRIPE_RATE_LIMIT,
    "Too many checkout requests. Please wait a moment and try again.",
  );
  const config = billingConfig(ctx.env);
  const returnUrl = normalizeReturnUrl(args.returnUrl);
  try {
    const customer = await ensureCustomer(ctx);
    const metadata = { ownerId: ctx.ownerId, plan: args.plan, source };
    const coupon = args.plan === "go" ? config.goFirstMonthCoupon : undefined;
    const session = await stripeRequest<{ id: string; url: string | null }>(ctx.env, "POST", "/checkout/sessions", {
      mode: "subscription",
      ui_mode: "hosted_page",
      customer,
      client_reference_id: ctx.ownerId,
      line_items: [{ price: config.stripePrices[args.plan], quantity: 1 }],
      ...(coupon ? { discounts: [{ coupon }] } : { allow_promotion_codes: true }),
      success_url: withCheckoutStatus(returnUrl, "success"),
      cancel_url: withCheckoutStatus(returnUrl, "cancel"),
      managed_payments: { enabled: true },
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
      metadata,
      subscription_data: { metadata },
    });
    if (!session.url) throw new StripeError(502, "Stripe returned no checkout URL.");
    return { url: session.url, sessionId: session.id };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw stripeUnavailable(error);
  }
};

const creditCheckout = async (
  ctx: OwnerContext,
  args: BillingCalls["billing.creditCheckout"]["args"],
): Promise<{ url: string; sessionId: string }> => {
  requireBilling(ctx.env);
  const amountCents = Math.floor(args.amountCents);
  if (amountCents < CREDIT_MIN_CENTS || amountCents > CREDIT_MAX_CENTS) {
    throw new RpcError(
      "BAD_REQUEST",
      `Credit amount must be between $${CREDIT_MIN_CENTS / 100} and $${CREDIT_MAX_CENTS / 100}.`,
    );
  }
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "billing.stripe",
    STRIPE_RATE_LIMIT,
    "Too many checkout requests. Please wait a moment and try again.",
  );
  const returnUrl = normalizeReturnUrl(args.returnUrl);
  try {
    const customer = await ensureCustomer(ctx);
    const metadata = { ownerId: ctx.ownerId, purpose: "usage_credit", amountCents: String(amountCents) };
    const session = await stripeRequest<{ id: string; url: string | null }>(ctx.env, "POST", "/checkout/sessions", {
      mode: "payment",
      ui_mode: "hosted_page",
      customer,
      client_reference_id: ctx.ownerId,
      line_items: [
        {
          price_data: {
            currency: CREDIT_CURRENCY,
            unit_amount: amountCents,
            product_data: { name: "Stella extra usage credit" },
          },
          quantity: 1,
        },
      ],
      success_url: withCheckoutStatus(returnUrl, "success"),
      cancel_url: withCheckoutStatus(returnUrl, "cancel"),
      managed_payments: { enabled: true },
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
      metadata,
      payment_intent_data: { metadata },
    });
    if (!session.url) throw new StripeError(502, "Stripe returned no checkout URL.");
    return { url: session.url, sessionId: session.id };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw stripeUnavailable(error);
  }
};

const portal = async (
  ctx: OwnerContext,
  args: BillingCalls["billing.portal"]["args"],
): Promise<{ url: string }> => {
  const customer = readAccount(ctx.db, ctx.now).stripe_customer_id;
  if (!customer) throw new RpcError("NOT_FOUND", "There is no billing account to manage yet.");
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "billing.stripe",
    STRIPE_RATE_LIMIT,
    "Too many billing requests. Please wait a moment and try again.",
  );
  try {
    const session = await stripeRequest<{ url: string }>(ctx.env, "POST", "/billing_portal/sessions", {
      customer,
      return_url: normalizeReturnUrl(args.returnUrl),
    });
    return { url: session.url };
  } catch (error) {
    throw stripeUnavailable(error);
  }
};

/** Apply a subscription as Stripe reports it now. */
const syncSubscription = (ctx: OwnerContext, subscription: StripeSubscription): void => {
  const row = ensureAccount(ctx.db, ctx.now);
  if (row.stripe_customer_id && subscription.customer !== row.stripe_customer_id) return;
  const item = subscription.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  const paid = planForStripePrice(billingConfig(ctx.env), priceId);
  const nextPlan: BillingPlan = ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) && paid ? paid : "free";
  // A newer subscription replaces an ended one; an ended one never replaces a live one.
  if (
    row.stripe_subscription_id &&
    row.stripe_subscription_id !== subscription.id &&
    nextPlan === "free" &&
    plan(row) !== "free"
  ) {
    return;
  }
  const periodStart = (item?.current_period_start ?? subscription.current_period_start ?? 0) * 1000;
  const periodEnd = (item?.current_period_end ?? subscription.current_period_end ?? 0) * 1000;
  const anchor = nextPlan === "free" ? row.monthly_anchor_at : periodStart || ctx.now;
  const card =
    typeof subscription.default_payment_method === "object" && subscription.default_payment_method
      ? subscription.default_payment_method.card
      : undefined;
  updateAccount(ctx.db, {
    plan: nextPlan,
    usage_mode: nextPlan === plan(row) ? row.usage_mode : "default",
    subscription_status: subscription.status,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    stripe_price_id: nextPlan === "free" ? null : priceId,
    current_period_end: periodEnd,
    cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
    ...(card ? { payment_method_brand: card.brand ?? null, payment_method_last4: card.last4 ?? null } : {}),
    monthly_anchor_at: anchor,
    ...(nextPlan !== plan(row) ? resetWindows(ctx.now, anchor) : {}),
    updated_at: ctx.now,
  });
};

const fetchSubscription = (ctx: OwnerContext, id: string) =>
  stripeRequest<StripeSubscription>(ctx.env, "GET", `/subscriptions/${encodeURIComponent(id)}`, {
    expand: ["default_payment_method"],
  });

const subscriptionIdOf = (object: Record<string, unknown>): string | null => {
  const direct = object.subscription;
  if (typeof direct === "string") return direct;
  const parent = object.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  const nested = parent?.subscription_details?.subscription;
  return typeof nested === "string" ? nested : null;
};

/**
 * Apply one verified Stripe event addressed to this owner. Throws only when
 * Stripe should redeliver it.
 */
export const applyStripeEvent = async (ctx: OwnerContext, event: StripeEvent): Promise<void> => {
  if (ctx.db.one("SELECT 1 AS seen FROM billing_stripe_events WHERE id = ?", event.id)) return;
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const metadata = (object.metadata ?? {}) as Record<string, string>;
      if (object.mode === "payment" && metadata.purpose === "usage_credit") {
        if (object.payment_status !== "paid") break;
        const sessionId = String(object.id);
        // The amount the owner chose; tax collected on top is not credit.
        const chosen = Number(metadata.amountCents);
        const cents = Number.isSafeInteger(chosen) && chosen > 0
          ? chosen
          : Math.max(0, Math.floor(Number(object.amount_subtotal ?? 0)));
        if (ctx.db.one("SELECT 1 AS seen FROM billing_credit_purchases WHERE checkout_session_id = ?", sessionId)) break;
        const amount = cents * 1_000_000;
        ctx.db.run(
          "INSERT INTO billing_credit_purchases (checkout_session_id, amount, created_at) VALUES (?, ?, ?)",
          sessionId,
          amount,
          ctx.now,
        );
        const row = ensureAccount(ctx.db, ctx.now);
        updateAccount(ctx.db, {
          credit_balance: row.credit_balance + amount,
          credit_purchased: row.credit_purchased + amount,
          updated_at: ctx.now,
        });
        break;
      }
      const subscriptionId = subscriptionIdOf(object);
      if (subscriptionId) syncSubscription(ctx, await fetchSubscription(ctx, subscriptionId));
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      syncSubscription(ctx, await fetchSubscription(ctx, String(object.id)));
      break;
    case "invoice.paid":
    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const subscriptionId = subscriptionIdOf(object);
      if (subscriptionId) syncSubscription(ctx, await fetchSubscription(ctx, subscriptionId));
      break;
    }
    case "customer.deleted": {
      const row = ensureAccount(ctx.db, ctx.now);
      if (row.stripe_customer_id !== object.id) break;
      updateAccount(ctx.db, {
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_price_id: null,
        subscription_status: "none",
        cancel_at_period_end: 0,
        current_period_end: 0,
        payment_method_brand: null,
        payment_method_last4: null,
        ...(plan(row) !== "free" ? { plan: "free", ...resetWindows(ctx.now, row.monthly_anchor_at) } : {}),
        updated_at: ctx.now,
      });
      break;
    }
    default:
      break;
  }
  ctx.db.run("INSERT INTO billing_stripe_events (id, created_at) VALUES (?, ?)", event.id, ctx.now);
  ctx.db.run("DELETE FROM billing_stripe_events WHERE created_at < ?", ctx.now - RECEIPT_RETENTION_MS);
};

/** Cancel the subscription and delete the Stripe customer (account deletion). */
export const closeStripeCustomer = async (ctx: OwnerContext): Promise<void> => {
  const row = readAccount(ctx.db, ctx.now);
  if (!row.stripe_customer_id) return;
  try {
    await stripeRequest(ctx.env, "DELETE", `/customers/${encodeURIComponent(row.stripe_customer_id)}`);
  } catch (error) {
    if (!(error instanceof StripeError && error.status === 404)) throw error;
  }
};

// ── Status ─────────────────────────────────────────────────────────────────

const usd = (microCents: number) => Number((microCents / MICRO_CENTS_PER_USD).toFixed(4));

const status = (ctx: {
  db: OwnerDbReader;
  env: Cloudflare.Env;
  now: number;
  caller: { isAnonymous: boolean } | null;
}): BillingStatus => {
  const config = billingConfig(ctx.env);
  const stored = readAccount(ctx.db, ctx.now);
  const row = ctx.caller ? { ...stored, is_anonymous: ctx.caller.isAnonymous ? 1 : 0 } : stored;
  const anonymous = row.is_anonymous === 1;
  const snapshot = usageSnapshot(config, row, ctx.now);
  return {
    authenticated: true,
    isAnonymous: anonymous,
    identityLevel: identityLevel(row),
    plan: config.enabled ? plan(row) : "pro",
    subscriptionStatus: row.subscription_status,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    currentPeriodEnd: row.current_period_end > 0 ? row.current_period_end : null,
    usage: {
      rollingUsedUsd: usd(snapshot.rolling.used),
      rollingLimitUsd: usd(snapshot.rolling.limit),
      weeklyUsedUsd: usd(snapshot.weekly.used),
      weeklyLimitUsd: usd(snapshot.weekly.limit),
      monthlyUsedUsd: usd(snapshot.monthly.used),
      monthlyLimitUsd: usd(snapshot.monthly.limit),
      lifetimeUsedUsd: usd(row.total_used),
      lifetimeLimitUsd: snapshot.lifetime ? usd(snapshot.lifetime.limit) : null,
    },
    usagePolicy: anonymous
      ? {
          kind: "anonymous_requests",
          requestLimit: config.anonymousMaxRequests,
          perIpRequestLimit: config.anonymousMaxRequestsPerIp,
          resetAfterInactivityDays: ANON_RESET_AFTER_INACTIVITY_DAYS,
        }
      : { kind: "managed_cost" },
    plans: config.plans,
    credits: {
      currency: CREDIT_CURRENCY,
      balanceUsd: usd(Math.max(0, row.credit_balance)),
      totalPurchasedUsd: usd(row.credit_purchased),
      totalConsumedUsd: usd(row.credit_consumed),
    },
    creditPurchase: {
      currency: CREDIT_CURRENCY,
      minAmountCents: CREDIT_MIN_CENTS,
      maxAmountCents: CREDIT_MAX_CENTS,
      presetAmountCents: [...CREDIT_PRESET_CENTS],
    },
  };
};

const returnUrlArg = string({ min: 1, max: 2_048 });

export const billingDomain = {
  name: "billing",
  migrations: [BILLING_MIGRATION],
  calls: {
    "billing.checkout": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        plan: literal("go", "pro"),
        returnUrl: returnUrlArg,
        source: optional(string({ max: 32 })),
        appStoreCountry: optional(string({ max: 8 })),
      }),
      handler: (ctx: OwnerContext, args: BillingCalls["billing.checkout"]["args"]) => checkout(ctx, args),
    },
    "billing.creditCheckout": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        amountCents: number({ int: true, min: CREDIT_MIN_CENTS, max: CREDIT_MAX_CENTS }),
        returnUrl: returnUrlArg,
      }),
      handler: (ctx: OwnerContext, args: BillingCalls["billing.creditCheckout"]["args"]) =>
        creditCheckout(ctx, args),
    },
    "billing.portal": {
      scope: "owner",
      requireAccount: true,
      parse: object({ returnUrl: returnUrlArg }),
      handler: (ctx: OwnerContext, args: BillingCalls["billing.portal"]["args"]) => portal(ctx, args),
    },
  },
  views: {
    "billing.status": {
      parse: empty(),
      read: (ctx) => status(ctx),
    },
  },
} satisfies OwnerDomain;

export type { PaidBillingPlan };
