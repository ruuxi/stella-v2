import type {
  BillingPlan,
  BillingPlanConfig,
  PaidBillingPlan,
} from "@stella/contracts/backend/billing";

/**
 * Plan catalog, from the Worker's secrets. Stella is open source, so prices
 * and limits never live in the repository; the variable names are the ones
 * the Convex billing module used.
 *
 * Required:
 *   STELLA_INCLUDED_USAGE_UTILIZATION_RATE   number in (0, 1]
 *   STELLA_GO_PRICE_CENTS, STELLA_PRO_PRICE_CENTS
 *   STELLA_FREE_{ROLLING,WEEKLY,MONTHLY}_LIMIT_USD, STELLA_FREE_ROLLING_WINDOW_HOURS
 *   STELLA_ANON_LIFETIME_LIMIT_USD, STELLA_ANON_MAX_REQUESTS
 *   STRIPE_PRICE_GO, STRIPE_PRICE_PRO
 * Optional:
 *   STELLA_<GO|PRO>_{ROLLING,WEEKLY,MONTHLY}_LIMIT_USD, _ROLLING_WINDOW_HOURS
 *   STELLA_FREE_LIFETIME_LIMIT_USD, STELLA_FREE_EMAIL_ALLOWANCE_SHARE
 *   STELLA_ANON_{ROLLING,WEEKLY,MONTHLY}_LIMIT_USD, STELLA_ANON_ROLLING_WINDOW_HOURS
 *   STELLA_ANON_MAX_REQUESTS_PER_IP
 *   STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS with STRIPE_COUPON_GO_FIRST_MONTH
 *
 * Paid plans derive their monthly limit from price / utilization rate, and
 * their rolling and weekly limits as fixed shares of it, unless overridden.
 */

export type PlanCatalog = Record<BillingPlan, BillingPlanConfig>;

export type BillingConfig = {
  plans: PlanCatalog;
  anonymous: BillingPlanConfig;
  anonymousMaxRequests: number;
  anonymousMaxRequestsPerIp: number;
  freeEmailAllowanceShare: number;
  stripePrices: Record<PaidBillingPlan, string>;
  goFirstMonthCoupon?: string;
};

export class BillingConfigError extends Error {}

const ROLLING_LIMIT_SHARE = 0.2;
const WEEKLY_LIMIT_SHARE = 0.5;
const DEFAULT_ROLLING_WINDOW_HOURS = 5;
const DEFAULT_FREE_EMAIL_ALLOWANCE_SHARE = 0.4;
const ANON_IP_CAP_DEFAULT_MULTIPLIER = 10;

type EnvReader = (name: string) => string | undefined;

const reader = (env: Cloudflare.Env): EnvReader => {
  const values = env as unknown as Record<string, unknown>;
  return (name) => {
    const value = values[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
};

const required = (read: EnvReader, name: string): number => {
  const raw = read(name);
  if (raw === undefined) throw new BillingConfigError(`Missing billing secret ${name}.`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new BillingConfigError(`Billing secret ${name} must be a non-negative number.`);
  }
  return value;
};

const optional = (read: EnvReader, name: string): number | undefined =>
  read(name) === undefined ? undefined : required(read, name);

const roundUsd = (value: number) => Math.max(0, Math.round(value * 100) / 100);

const paidPlan = (
  read: EnvReader,
  plan: PaidBillingPlan,
  utilizationRate: number,
): BillingPlanConfig => {
  const prefix = `STELLA_${plan.toUpperCase()}`;
  const monthlyPriceCents = required(read, `${prefix}_PRICE_CENTS`);
  const derivedMonthly = roundUsd(monthlyPriceCents / 100 / utilizationRate);
  return {
    label: plan === "go" ? "Go" : "Pro",
    monthlyPriceCents,
    rollingLimitUsd:
      optional(read, `${prefix}_ROLLING_LIMIT_USD`) ?? roundUsd(derivedMonthly * ROLLING_LIMIT_SHARE),
    rollingWindowHours:
      optional(read, `${prefix}_ROLLING_WINDOW_HOURS`) ?? DEFAULT_ROLLING_WINDOW_HOURS,
    weeklyLimitUsd:
      optional(read, `${prefix}_WEEKLY_LIMIT_USD`) ?? roundUsd(derivedMonthly * WEEKLY_LIMIT_SHARE),
    monthlyLimitUsd: optional(read, `${prefix}_MONTHLY_LIMIT_USD`) ?? derivedMonthly,
  };
};

const loadBillingConfig = (env: Cloudflare.Env): BillingConfig => {
  const read = reader(env);
  const utilizationRate = required(read, "STELLA_INCLUDED_USAGE_UTILIZATION_RATE");
  if (utilizationRate <= 0 || utilizationRate > 1) {
    throw new BillingConfigError("STELLA_INCLUDED_USAGE_UTILIZATION_RATE must be in (0, 1].");
  }
  const go = paidPlan(read, "go", utilizationRate);
  const intro = optional(read, "STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS");
  const goFirstMonthCoupon = read("STRIPE_COUPON_GO_FIRST_MONTH");
  if ((intro === undefined) !== (goFirstMonthCoupon === undefined)) {
    throw new BillingConfigError(
      "Set STELLA_GO_INTRO_FIRST_MONTH_PRICE_CENTS and STRIPE_COUPON_GO_FIRST_MONTH together.",
    );
  }
  if (intro !== undefined) go.introFirstMonthPriceCents = intro;
  const freeLifetime = optional(read, "STELLA_FREE_LIFETIME_LIMIT_USD");
  const anonLifetime = required(read, "STELLA_ANON_LIFETIME_LIMIT_USD");
  const anonymousMaxRequests = required(read, "STELLA_ANON_MAX_REQUESTS");
  const priceGo = read("STRIPE_PRICE_GO");
  const pricePro = read("STRIPE_PRICE_PRO");
  if (!priceGo || !pricePro) {
    throw new BillingConfigError("Missing billing secret STRIPE_PRICE_GO or STRIPE_PRICE_PRO.");
  }
  return {
    plans: {
      free: {
        label: "Free",
        monthlyPriceCents: 0,
        rollingLimitUsd: required(read, "STELLA_FREE_ROLLING_LIMIT_USD"),
        rollingWindowHours: required(read, "STELLA_FREE_ROLLING_WINDOW_HOURS"),
        weeklyLimitUsd: required(read, "STELLA_FREE_WEEKLY_LIMIT_USD"),
        monthlyLimitUsd: required(read, "STELLA_FREE_MONTHLY_LIMIT_USD"),
        ...(freeLifetime !== undefined ? { lifetimeLimitUsd: freeLifetime } : {}),
      },
      go,
      pro: paidPlan(read, "pro", utilizationRate),
    },
    anonymous: {
      label: "Anonymous",
      monthlyPriceCents: 0,
      rollingLimitUsd: optional(read, "STELLA_ANON_ROLLING_LIMIT_USD") ?? anonLifetime,
      rollingWindowHours:
        optional(read, "STELLA_ANON_ROLLING_WINDOW_HOURS") ?? DEFAULT_ROLLING_WINDOW_HOURS,
      weeklyLimitUsd: optional(read, "STELLA_ANON_WEEKLY_LIMIT_USD") ?? anonLifetime,
      monthlyLimitUsd: optional(read, "STELLA_ANON_MONTHLY_LIMIT_USD") ?? anonLifetime,
      lifetimeLimitUsd: anonLifetime,
    },
    anonymousMaxRequests,
    anonymousMaxRequestsPerIp:
      optional(read, "STELLA_ANON_MAX_REQUESTS_PER_IP") ??
      anonymousMaxRequests * ANON_IP_CAP_DEFAULT_MULTIPLIER,
    freeEmailAllowanceShare:
      optional(read, "STELLA_FREE_EMAIL_ALLOWANCE_SHARE") ?? DEFAULT_FREE_EMAIL_ALLOWANCE_SHARE,
    stripePrices: { go: priceGo, pro: pricePro },
    ...(goFirstMonthCoupon ? { goFirstMonthCoupon } : {}),
  };
};

let cached: { env: Cloudflare.Env; config: BillingConfig } | undefined;

/** The billing configuration, parsed once per isolate. Throws when incomplete. */
export const billingConfig = (env: Cloudflare.Env): BillingConfig => {
  if (cached?.env === env) return cached.config;
  const config = loadBillingConfig(env);
  cached = { env, config };
  return config;
};

export const planForStripePrice = (
  config: BillingConfig,
  priceId: string | null | undefined,
): PaidBillingPlan | null => {
  if (!priceId) return null;
  if (config.stripePrices.go === priceId) return "go";
  if (config.stripePrices.pro === priceId) return "pro";
  return null;
};
