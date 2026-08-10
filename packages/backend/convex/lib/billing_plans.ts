/**
 * Plan catalog + Stripe-price wiring.
 *
 * Pricing and limits are loaded from Convex env at startup. Stella is
 * open source — no real values live in this file. Prices are public
 * (the marketing site shows them) but the included-usage utilization
 * rate is not, so it stays env-only.
 *
 * Required env:
 *   STELLA_INCLUDED_USAGE_UTILIZATION_RATE   — number in (0, 1]
 *   STELLA_<PLAN>_PRICE_CENTS                — paid plans only
 *
 * Optional Go intro (first recurring invoice only — pair with Stripe):
 *   STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS — e.g. 100 ($1); shown on
 *     marketing/billing UX; recurring price stays STELLA_GO_PRICE_CENTS
 *   STRIPE_COUPON_GO_FIRST_MONTH — Stripe Coupon id (`coupon_…`) created
 *     as duration=once so the discount applies only on the subscription’s
 *     first invoice (e.g. $4 off when the list price is $5 → pay $1,
 *     then full price on renewal). Set intro price env and coupon env
 *     together, or omit both — mismatched halves fail at startup.
 *
 * Optional per-plan overrides (derive from price + utilization when
 * unset; useful if a single plan needs limits that depart from the
 * shared formula):
 *   STELLA_<PLAN>_ROLLING_LIMIT_USD
 *   STELLA_<PLAN>_WEEKLY_LIMIT_USD
 *   STELLA_<PLAN>_MONTHLY_LIMIT_USD
 *   STELLA_<PLAN>_ROLLING_WINDOW_HOURS
 *
 * Free plan has no PRICE_CENTS (always 0). Its four limit/window envs
 * are required (no formula derives from a $0 price).
 *
 * Optional lifetime allowance (Free only in practice — it is enforced
 * only for plans that set it, so Go/Pro stay windowed):
 *   STELLA_FREE_LIFETIME_LIMIT_USD — total measured managed-model cost a
 *     Free account may ever spend. Unlike the rolling/weekly/monthly
 *     windows this never refreshes: once cumulative spend reaches it the
 *     account is done until it upgrades (or buys usage credits). Leave
 *     unset to keep Free purely windowed. Recommended: 0.5.
 *
 * Anonymous (signed-out) access is capped by request count, not dollars —
 * see `lib/anonymous_usage.ts` for STELLA_ANON_MAX_REQUESTS and
 * STELLA_ANON_MAX_REQUESTS_PER_IP.
 *
 * `<PLAN>` ∈ { FREE, GO, PRO }.
 */
export const SUBSCRIPTION_PLANS = ["free", "go", "pro"] as const;

export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export type PlanConfig = {
  label: string;
  monthlyPriceCents: number;
  /** Stripe first invoice amount when using STRIPE_COUPON_GO_FIRST_MONTH (display only). */
  introFirstMonthPriceCents?: number;
  rollingLimitUsd: number;
  rollingWindowHours: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
  /**
   * Cumulative managed-model spend allowed for the lifetime of the
   * account. Absent on every plan that should stay purely windowed —
   * enforcement is skipped entirely when this is undefined.
   */
  lifetimeLimitUsd?: number;
};

export type PlanCatalog = Record<SubscriptionPlan, PlanConfig>;

const PLAN_LABELS: Record<SubscriptionPlan, string> = {
  free: "Free",
  go: "Go",
  pro: "Pro",
};

// Share of the derived monthly limit allotted to the smaller windows.
// These shape the rolling/weekly buckets relative to monthly; on their
// own they reveal nothing about real dollar amounts (those depend on
// the env-only utilization rate × env-only price).
const ROLLING_LIMIT_SHARE = 0.2;
const WEEKLY_LIMIT_SHARE = 0.5;
const DEFAULT_ROLLING_WINDOW_HOURS = 5;

const requireNumberEnv = (envName: string): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    throw new Error(
      `[billing] Missing required env ${envName}. Set it in Convex env before starting.`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `[billing] Invalid env ${envName}=${raw}; expected a non-negative number.`,
    );
  }
  return parsed;
};

const requirePositiveIntEnv = (envName: string): number => {
  const value = requireNumberEnv(envName);
  if (!Number.isInteger(value)) {
    throw new Error(
      `[billing] Invalid env ${envName}=${value}; expected a non-negative integer.`,
    );
  }
  return value;
};

const requireUtilizationRateEnv = (envName: string): number => {
  const value = requireNumberEnv(envName);
  if (value <= 0 || value > 1) {
    throw new Error(
      `[billing] Invalid env ${envName}=${value}; expected a number in (0, 1].`,
    );
  }
  return value;
};

const optionalNumberEnv = (envName: string): number | undefined => {
  const raw = process.env[envName]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `[billing] Invalid env ${envName}=${raw}; expected a non-negative number.`,
    );
  }
  return parsed;
};

const roundUsd = (value: number): number =>
  Math.max(0, Math.round(value * 100) / 100);

const toMonthlyPriceUsd = (monthlyPriceCents: number): number =>
  Math.max(0, monthlyPriceCents) / 100;

const buildFreePlanConfig = (): PlanConfig => {
  // The lifetime allowance is a one-shot grant: it is deliberately not
  // derived from the windows, since it never refreshes alongside them.
  const lifetimeLimitUsd = optionalNumberEnv("STELLA_FREE_LIFETIME_LIMIT_USD");
  return {
    label: PLAN_LABELS.free,
    monthlyPriceCents: 0,
    rollingLimitUsd: requireNumberEnv("STELLA_FREE_ROLLING_LIMIT_USD"),
    rollingWindowHours: requireNumberEnv("STELLA_FREE_ROLLING_WINDOW_HOURS"),
    weeklyLimitUsd: requireNumberEnv("STELLA_FREE_WEEKLY_LIMIT_USD"),
    monthlyLimitUsd: requireNumberEnv("STELLA_FREE_MONTHLY_LIMIT_USD"),
    ...(lifetimeLimitUsd !== undefined ? { lifetimeLimitUsd } : {}),
  };
};

const buildPaidPlanConfig = (
  plan: Exclude<SubscriptionPlan, "free">,
  utilizationRate: number,
): PlanConfig => {
  const envPrefix = `STELLA_${plan.toUpperCase()}`;
  const monthlyPriceCents = requirePositiveIntEnv(`${envPrefix}_PRICE_CENTS`);
  const derivedMonthlyLimitUsd = roundUsd(
    toMonthlyPriceUsd(monthlyPriceCents) / utilizationRate,
  );
  const monthlyLimitUsd =
    optionalNumberEnv(`${envPrefix}_MONTHLY_LIMIT_USD`) ?? derivedMonthlyLimitUsd;
  return {
    label: PLAN_LABELS[plan],
    monthlyPriceCents,
    rollingLimitUsd:
      optionalNumberEnv(`${envPrefix}_ROLLING_LIMIT_USD`) ??
      roundUsd(derivedMonthlyLimitUsd * ROLLING_LIMIT_SHARE),
    rollingWindowHours:
      optionalNumberEnv(`${envPrefix}_ROLLING_WINDOW_HOURS`) ??
      DEFAULT_ROLLING_WINDOW_HOURS,
    weeklyLimitUsd:
      optionalNumberEnv(`${envPrefix}_WEEKLY_LIMIT_USD`) ??
      roundUsd(derivedMonthlyLimitUsd * WEEKLY_LIMIT_SHARE),
    monthlyLimitUsd,
  };
};

const enrichGoIntroPricing = (base: PlanConfig): PlanConfig => {
  const introRaw = process.env.STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS?.trim();
  if (!introRaw) return base;

  const introCents = Number(introRaw);
  if (
    !Number.isFinite(introCents)
    || !Number.isInteger(introCents)
    || introCents < 0
  ) {
    throw new Error(
      `[billing] Invalid env STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS=${introRaw}; expected a non-negative integer (cents).`,
    );
  }

  const list = base.monthlyPriceCents;
  if (introCents >= list) {
    throw new Error(
      `[billing] STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS (${introCents}) must be less than STELLA_GO_PRICE_CENTS (${list}) so the recurring price stays higher.`,
    );
  }

  return { ...base, introFirstMonthPriceCents: introCents };
};

let cachedCatalog: PlanCatalog | null = null;

const loadPlanCatalog = (): PlanCatalog => {
  if (cachedCatalog) return cachedCatalog;
  const utilizationRate = requireUtilizationRateEnv(
    "STELLA_INCLUDED_USAGE_UTILIZATION_RATE",
  );
  const goBase = buildPaidPlanConfig("go", utilizationRate);
  const goPlan = enrichGoIntroPricing(goBase);
  const hasIntroPricing = typeof goPlan.introFirstMonthPriceCents === "number";
  const goCouponConfigured = Boolean(
    process.env.STRIPE_COUPON_GO_FIRST_MONTH?.trim(),
  );
  if (hasIntroPricing !== goCouponConfigured) {
    throw new Error(
      "[billing] Go first-month promo: set both STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS and STRIPE_COUPON_GO_FIRST_MONTH together, or omit both.",
    );
  }
  cachedCatalog = {
    free: buildFreePlanConfig(),
    go: goPlan,
    pro: buildPaidPlanConfig("pro", utilizationRate),
  };
  return cachedCatalog;
};

const STRIPE_PRICE_ID_ENV: Record<Exclude<SubscriptionPlan, "free">, string> = {
  go: "STRIPE_PRICE_GO",
  pro: "STRIPE_PRICE_PRO",
};

export const getPlanCatalog = (): PlanCatalog => loadPlanCatalog();

export const getPlanConfig = (plan: SubscriptionPlan): PlanConfig =>
  loadPlanCatalog()[plan];

export const getStripePriceIdForPlan = (plan: Exclude<SubscriptionPlan, "free">) => {
  const key = STRIPE_PRICE_ID_ENV[plan];
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key} environment variable for ${plan} checkout.`);
  }
  return value;
};

export const findPlanForStripePriceId = (
  stripePriceId: string | null | undefined,
): Exclude<SubscriptionPlan, "free"> | null => {
  const normalized = stripePriceId?.trim();
  if (!normalized) {
    return null;
  }

  for (const plan of ["go", "pro"] as const) {
    const configured = process.env[STRIPE_PRICE_ID_ENV[plan]]?.trim();
    if (configured && configured === normalized) {
      return plan;
    }
  }

  return null;
};

/** Stripe Checkout applies this Coupon when starting a Go subscription (first invoice only if duration=once). */
export const getStripeGoFirstMonthCouponId = (): string | undefined => {
  const id = process.env.STRIPE_COUPON_GO_FIRST_MONTH?.trim();
  return id || undefined;
};
