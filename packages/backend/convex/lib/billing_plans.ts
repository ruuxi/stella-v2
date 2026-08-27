export const SUBSCRIPTION_PLANS = ["free", "go", "pro"] as const;

export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export type PlanConfig = {
  label: string;
  monthlyPriceCents: number;

  introFirstMonthPriceCents?: number;
  rollingLimitUsd: number;
  rollingWindowHours: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;

  lifetimeLimitUsd?: number;
};

export type PlanCatalog = Record<SubscriptionPlan, PlanConfig>;

const PLAN_LABELS: Record<SubscriptionPlan, string> = {
  free: "Free",
  go: "Go",
  pro: "Pro",
};

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

export const getStripeGoFirstMonthCouponId = (): string | undefined => {
  const id = process.env.STRIPE_COUPON_GO_FIRST_MONTH?.trim();
  return id || undefined;
};
