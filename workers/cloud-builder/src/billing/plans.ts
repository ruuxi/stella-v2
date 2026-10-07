import type {
  BillingPlan,
  BillingPlanConfig,
  CloudSandboxAccess,
  PaidBillingPlan,
} from "@stella/contracts/backend/billing";

/**
 * Plan catalog, from the Worker's secrets. Stella is open source, so prices
 * and limits never live in the repository.
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
 * With none of STELLA_INCLUDED_USAGE_UTILIZATION_RATE, STRIPE_SECRET_KEY,
 * STRIPE_PRICE_GO and STRIPE_PRICE_PRO set, billing is off (see `enabled`).
 *
 * Paid plans derive their monthly limit from price / utilization rate, and
 * their rolling and weekly limits as fixed shares of it, unless overridden.
 */

export type PlanCatalog = Record<BillingPlan, BillingPlanConfig>;

export type BillingConfig = {
  /**
   * False when the deployment sets none of the billing secrets (a
   * self-hosted Stella): every account is Pro with unlimited usage and
   * checkout is off.
   */
  enabled: boolean;
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

type CloudSandboxPlan = BillingPlan | "anonymous";
const CLOUD_SANDBOX_PLANS: readonly CloudSandboxPlan[] = ["anonymous", "free", "go", "pro"];
const DEFAULT_CLOUD_SANDBOX_PLANS: readonly CloudSandboxPlan[] = ["free", "go", "pro"];

const cloudSandboxPlans = (read: EnvReader): ReadonlySet<CloudSandboxPlan> => {
  const raw = read("STELLA_CLOUD_SANDBOX_PLANS");
  if (raw === undefined) return new Set(DEFAULT_CLOUD_SANDBOX_PLANS);
  const plans = new Set<CloudSandboxPlan>();
  for (const entry of raw.split(",")) {
    const name = entry.trim().toLowerCase();
    if (!name) continue;
    if (!(CLOUD_SANDBOX_PLANS as readonly string[]).includes(name)) {
      throw new BillingConfigError(
        `STELLA_CLOUD_SANDBOX_PLANS lists unknown plan "${name}"; use ${CLOUD_SANDBOX_PLANS.join(", ")}.`,
      );
    }
    plans.add(name as CloudSandboxPlan);
  }
  return plans;
};

const cloudSandboxFor = (
  plans: ReadonlySet<CloudSandboxPlan>,
  plan: CloudSandboxPlan,
): CloudSandboxAccess => ({ enabled: plans.has(plan) });

const paidPlan = (
  read: EnvReader,
  plan: PaidBillingPlan,
  utilizationRate: number,
  sandboxPlans: ReadonlySet<CloudSandboxPlan>,
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
    cloudSandbox: cloudSandboxFor(sandboxPlans, plan),
  };
};

/** Any of these set means billing is meant to be on, and must be complete. */
const BILLING_SWITCHES = [
  "STELLA_INCLUDED_USAGE_UTILIZATION_RATE",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_GO",
  "STRIPE_PRICE_PRO",
] as const;

/** Limits no one reaches, for a deployment without billing. */
const OPEN_LIMIT_USD = 1_000_000;
const openPlan = (label: string): BillingPlanConfig => ({
  label,
  monthlyPriceCents: 0,
  rollingLimitUsd: OPEN_LIMIT_USD,
  rollingWindowHours: DEFAULT_ROLLING_WINDOW_HOURS,
  weeklyLimitUsd: OPEN_LIMIT_USD,
  monthlyLimitUsd: OPEN_LIMIT_USD,
  cloudSandbox: { enabled: true },
});

const OPEN_BILLING_CONFIG: BillingConfig = {
  enabled: false,
  plans: { free: openPlan("Free"), go: openPlan("Go"), pro: openPlan("Pro") },
  anonymous: openPlan("Anonymous"),
  anonymousMaxRequests: 1_000_000_000,
  anonymousMaxRequestsPerIp: 1_000_000_000,
  freeEmailAllowanceShare: 1,
  stripePrices: { go: "", pro: "" },
};

const loadBillingConfig = (env: Cloudflare.Env): BillingConfig => {
  const read = reader(env);
  if (BILLING_SWITCHES.every((name) => read(name) === undefined)) return OPEN_BILLING_CONFIG;
  const utilizationRate = required(read, "STELLA_INCLUDED_USAGE_UTILIZATION_RATE");
  if (utilizationRate <= 0 || utilizationRate > 1) {
    throw new BillingConfigError("STELLA_INCLUDED_USAGE_UTILIZATION_RATE must be in (0, 1].");
  }
  const sandboxPlans = cloudSandboxPlans(read);
  const go = paidPlan(read, "go", utilizationRate, sandboxPlans);
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
    enabled: true,
    plans: {
      free: {
        label: "Free",
        monthlyPriceCents: 0,
        rollingLimitUsd: required(read, "STELLA_FREE_ROLLING_LIMIT_USD"),
        rollingWindowHours: required(read, "STELLA_FREE_ROLLING_WINDOW_HOURS"),
        weeklyLimitUsd: required(read, "STELLA_FREE_WEEKLY_LIMIT_USD"),
        monthlyLimitUsd: required(read, "STELLA_FREE_MONTHLY_LIMIT_USD"),
        ...(freeLifetime !== undefined ? { lifetimeLimitUsd: freeLifetime } : {}),
        cloudSandbox: cloudSandboxFor(sandboxPlans, "free"),
      },
      go,
      pro: paidPlan(read, "pro", utilizationRate, sandboxPlans),
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
      cloudSandbox: cloudSandboxFor(sandboxPlans, "anonymous"),
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
  if (!priceId || !config.enabled) return null;
  if (config.stripePrices.go === priceId) return "go";
  if (config.stripePrices.pro === priceId) return "pro";
  return null;
};
