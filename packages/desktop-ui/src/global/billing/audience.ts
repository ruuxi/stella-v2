/**
 * Desktop-side mirror of the backend's `ManagedModelAudience` notion.
 *
 * Source of truth for the audience values, restriction set, and plan label
 * mapping lives in `backend/convex/agent/model.ts`. Keep these constants in
 * sync when the backend changes — the desktop uses them to surface a "this
 * model isn't allowed on your plan" toast at picker time, since the backend
 * silently coerces the model on restricted tiers and we don't want users to
 * wonder why their selection wasn't honored.
 */

/**
 * Collapsing a managed audience onto the four the capability matrix is
 * keyed by is the contract's job, not ours — re-exported here so the
 * audience vocabulary stays in one place for callers.
 */
export { toCapabilityAudience } from "@stella/contracts/capabilities";

export type SubscriptionPlan = "free" | "go" | "pro";

export type ManagedModelAudience =
  | "anonymous"
  | "free"
  | "go"
  | "pro"
  | "go_fallback"
  | "pro_fallback";

const RESTRICTED_MODEL_OVERRIDE_AUDIENCES = new Set<ManagedModelAudience>([
  "anonymous",
  "free",
  "go",
  "go_fallback",
]);

export const isRestrictedModelOverrideAudience = (
  audience: ManagedModelAudience | null | undefined,
): boolean =>
  audience !== null &&
  audience !== undefined &&
  RESTRICTED_MODEL_OVERRIDE_AUDIENCES.has(audience);

/**
 * Desktop-side mirror of the backend's
 * `RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS`.
 *
 * Restricted audiences cannot freely override Stella-managed models. Raw
 * DeepSeek V4 Flash is the sole public choice; the Light alias and the older
 * Fireworks-hosted spelling remain valid for saved preferences. Keep in sync
 * with `isStellaModelAllowedForAudience` in `backend/convex/agent/model.ts`.
 */
const RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS = new Set<string>([
  "stella/light",
  "stella/deepseek/deepseek-v4-flash",
  "stella/accounts/fireworks/models/deepseek-v4-flash-0731",
]);

export const isRestrictedAudienceAllowedStellaModelId = (
  modelId: string | null | undefined,
): boolean =>
  Boolean(
    modelId && RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS.has(modelId.trim()),
  );

const PLAN_LABELS: Record<ManagedModelAudience, string> = {
  anonymous: "Free",
  free: "Free",
  go: "Go",
  pro: "Pro",
  go_fallback: "Go",
  pro_fallback: "Pro",
};

export const getPlanLabel = (audience: ManagedModelAudience): string =>
  PLAN_LABELS[audience];

/**
 * A signed-out user can't upgrade anything — they have to sign in first.
 * Everyone else is one Stripe checkout away. The same rule governs model
 * restrictions and capability restrictions, so both read it from here
 * rather than each growing its own copy.
 */
export const getRestrictionActionKind = (
  audience: ManagedModelAudience,
): "sign-in" | "upgrade" => (audience === "anonymous" ? "sign-in" : "upgrade");

export const getModelRestrictionActionLabel = (
  audience: ManagedModelAudience,
): string =>
  getRestrictionActionKind(audience) === "sign-in" ? "Sign in" : "Upgrade";

export const getModelRestrictionDescription = (args: {
  audience: ManagedModelAudience;
  modelLabel: string;
  tense: "will" | "is";
}): string => {
  const recommendedPhrase =
    args.tense === "will"
      ? "Stella will use its recommended model."
      : "Stella is using its recommended model.";

  if (args.audience === "anonymous") {
    return `${args.modelLabel} is available after signing in and upgrading. ${recommendedPhrase}`;
  }

  return `${args.modelLabel} isn't available on the ${getPlanLabel(args.audience)} plan. ${recommendedPhrase} Upgrade to switch models.`;
};

type BillingUsage = {
  rollingUsedUsd: number;
  rollingLimitUsd: number;
  weeklyUsedUsd: number;
  weeklyLimitUsd: number;
  monthlyUsedUsd: number;
  monthlyLimitUsd: number;
  /**
   * Cumulative managed-model spend, and the ceiling it is measured
   * against. Only present on plans the backend gives a lifetime
   * allowance (Free) — see `lifetimeLimitUsd` in
   * `backend/convex/lib/billing_plans.ts`. Unlike the rolling / weekly /
   * monthly windows this never refreshes.
   */
  lifetimeUsedUsd?: number;
  lifetimeLimitUsd?: number | null;
};

type ResolvableBillingStatus = {
  plan: SubscriptionPlan;
  usage: BillingUsage;
  authenticated?: boolean;
};

const isUsageExceeded = (usage: BillingUsage): boolean =>
  usage.rollingUsedUsd >= usage.rollingLimitUsd ||
  usage.weeklyUsedUsd >= usage.weeklyLimitUsd ||
  usage.monthlyUsedUsd >= usage.monthlyLimitUsd;

/**
 * Resolves the desktop-side audience the same way the backend's
 * `resolveManagedModelAudience` does:
 * - signed-out → "anonymous"
 * - free plan → "free"
 * - paid plan over usage cap → "{plan}_fallback"
 * - paid plan otherwise → plan id
 *
 * Returns `null` when we don't yet know (billing query still loading for a
 * signed-in user) so callers can avoid firing toasts during a hydration
 * gap.
 */
export const resolveBillingAudience = (args: {
  hasConnectedAccount: boolean;
  billingStatus: ResolvableBillingStatus | undefined;
}): ManagedModelAudience | null => {
  if (!args.hasConnectedAccount) {
    return "anonymous";
  }
  if (!args.billingStatus) {
    return null;
  }
  if (args.billingStatus.authenticated === false) {
    return null;
  }
  const { plan, usage } = args.billingStatus;
  if (plan === "free") {
    return "free";
  }
  return isUsageExceeded(usage)
    ? (`${plan}_fallback` as ManagedModelAudience)
    : plan;
};

/**
 * The Free plan's lifetime allowance: a fixed number of dollars that is
 * spent once and never comes back. Returns `null` for every plan and
 * every status shape that has no lifetime ceiling, so callers can treat
 * a value here as "this account has a terminal budget".
 */
export type FreeAllowance = {
  usedUsd: number;
  limitUsd: number;
  remainingUsd: number;
  exhausted: boolean;
};

export const resolveFreeAllowance = (
  billingStatus: ResolvableBillingStatus | null | undefined,
): FreeAllowance | null => {
  if (!billingStatus || billingStatus.plan !== "free") return null;
  const usage = billingStatus.usage;
  const limitUsd = usage?.lifetimeLimitUsd;
  if (typeof limitUsd !== "number" || !Number.isFinite(limitUsd)) return null;
  if (limitUsd <= 0) return null;
  const rawUsed = usage?.lifetimeUsedUsd;
  const usedUsd =
    typeof rawUsed === "number" && Number.isFinite(rawUsed) && rawUsed > 0
      ? rawUsed
      : 0;
  return {
    usedUsd,
    limitUsd,
    remainingUsd: Math.max(0, limitUsd - usedUsd),
    exhausted: usedUsd >= limitUsd,
  };
};
