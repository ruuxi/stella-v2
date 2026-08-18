/**
 * The one place the renderer answers "can this user do X".
 *
 * Every media / creative affordance in the app funnels through
 * `resolveCapabilityRestriction` and reads its verdict from the shared
 * matrix in `@stella/contracts/capabilities`. Flip a boolean there and
 * every affordance follows: the Media Studio tabs, the plan cards on the
 * billing screen, and the toasts raised when the backend rejects a
 * request after the fact. There is deliberately no second list to keep
 * in sync.
 *
 * Only what is in `CAPABILITY_MATRIX` is enforced. Billing copy for
 * all-plan features must stay separate from this capability gate.
 *
 * Copy lives behind i18n keys rather than inline English. The action
 * rule — signed-out users get "Sign in", everybody else gets "Upgrade" —
 * is `getRestrictionActionKind` from `./audience`, the same rule the
 * model-restriction toasts already use.
 */
import {
  hasCapability,
  minimumPlanForCapability,
  toCapabilityAudience,
  type Capability,
  type CapabilityAudience,
} from "@stella/contracts/capabilities";
import {
  getPlanLabel,
  getRestrictionActionKind,
  type ManagedModelAudience,
} from "./audience";
import { i18nFallback } from "@/shared/i18n/I18nProvider";
import type { ToastOptions } from "@/ui/toast";
import { showToast } from "@/ui/toast";

// Re-exported so UI code has one import for everything capability-shaped
// and never has to reach past this module into the contract.
export {
  CAPABILITIES,
  hasCapability,
  minimumPlanForCapability,
  type Capability,
  type CapabilityAudience,
} from "@stella/contracts/capabilities";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

const defaultTranslate: Translate = (key, params) =>
  i18nFallback.t(key, params);

/**
 * Last audience the app resolved, published by `useCapabilityAccess`.
 *
 * The streaming error path lives several layers below React (a stream
 * event arrives in a plain module, not a component) and still has to
 * choose between "Sign in" and "Upgrade" on a capability-denied error.
 * Rather than threading billing state through the transport, the hook
 * publishes here and non-React callers read the snapshot. `null` means
 * "not known yet" and every consumer treats that as "don't block".
 */
let publishedAudience: ManagedModelAudience | null = null;

export const publishBillingAudience = (
  audience: ManagedModelAudience | null,
): void => {
  publishedAudience = audience;
};

export const readBillingAudience = (): ManagedModelAudience | null =>
  publishedAudience;

/* ── The verdict ── */

export type CapabilityRestriction = {
  capability: Capability;
  audience: CapabilityAudience;
  /** Cheapest plan that unlocks it, or `null` if no plan does. */
  minimumPlan: CapabilityAudience | null;
  actionKind: "sign-in" | "upgrade";
};

/**
 * `true` when the user may use `capability`.
 *
 * An unknown audience (billing query still in flight, or a signed-in
 * user whose status hasn't landed) resolves optimistically: a hydration
 * gap must never present a paying customer with a locked button. The
 * backend is the enforcement boundary; this is the affordance.
 */
export const canUseCapability = (
  audience: ManagedModelAudience | null | undefined,
  capability: Capability,
): boolean => {
  const capabilityAudience = toCapabilityAudience(audience);
  if (!capabilityAudience) return true;
  return hasCapability(capabilityAudience, capability);
};

/** The reason `capability` is unavailable, or `null` when it is available. */
export const resolveCapabilityRestriction = (
  audience: ManagedModelAudience | null | undefined,
  capability: Capability,
): CapabilityRestriction | null => {
  const capabilityAudience = toCapabilityAudience(audience);
  if (!capabilityAudience) return null;
  if (hasCapability(capabilityAudience, capability)) return null;
  return {
    capability,
    audience: capabilityAudience,
    minimumPlan: minimumPlanForCapability(capability),
    actionKind: getRestrictionActionKind(capabilityAudience),
  };
};

/**
 * Reactive counterpart of `resolveCapabilityRestriction`, for the path
 * where the backend has already refused the request.
 *
 * A denial is authoritative, so an unresolved audience must not swallow
 * the message the way the optimistic pre-emptive gate does — it is
 * treated as a signed-in account that lacks the capability. Returns
 * `null` only when the audience is known *and* the matrix says the user
 * does have the capability, in which case the refusal was about
 * something else and the caller should fall back to generic error copy.
 */
export const resolveDeniedCapability = (
  audience: ManagedModelAudience | null | undefined,
  capability: Capability,
): CapabilityRestriction | null => {
  const capabilityAudience = toCapabilityAudience(audience);
  if (capabilityAudience) {
    return resolveCapabilityRestriction(audience, capability);
  }
  return {
    capability,
    audience: "free",
    minimumPlan: minimumPlanForCapability(capability),
    actionKind: getRestrictionActionKind("free"),
  };
};

/* ── Copy ── */

export const getCapabilityLabel = (
  capability: Capability,
  t: Translate = defaultTranslate,
): string => t(`billing.capability.${capability}`);

export const getCapabilityRestrictionActionLabel = (
  restriction: Pick<CapabilityRestriction, "actionKind">,
  t: Translate = defaultTranslate,
): string =>
  restriction.actionKind === "sign-in"
    ? t("common.signIn")
    : t("sidebar.upgrade");

export const getCapabilityRestrictionTitle = (
  restriction: CapabilityRestriction,
  t: Translate = defaultTranslate,
): string =>
  t("billing.capabilityRestriction.title", {
    capability: getCapabilityLabel(restriction.capability, t),
  });

/**
 * Names the plan that unlocks the capability, because "upgrade" without
 * a destination is a dead end of its own. When the matrix grants the
 * capability to nobody we fall back to a plain "not available" line
 * rather than inventing a plan to sell.
 */
export const getCapabilityRestrictionDescription = (
  restriction: CapabilityRestriction,
  t: Translate = defaultTranslate,
): string => {
  const capability = getCapabilityLabel(restriction.capability, t);
  if (!restriction.minimumPlan) {
    return t("billing.capabilityRestriction.unavailable", { capability });
  }
  const plan = getPlanLabel(restriction.minimumPlan);
  return restriction.actionKind === "sign-in"
    ? t("billing.capabilityRestriction.signIn", { capability, plan })
    : t("billing.capabilityRestriction.upgrade", { capability, plan });
};

/** Short lock annotation for a pre-emptively disabled affordance. */
export const getCapabilityLockLabel = (
  restriction: CapabilityRestriction,
  t: Translate = defaultTranslate,
): string =>
  restriction.minimumPlan
    ? t("billing.capabilityRestriction.lockedBadge", {
        plan: getPlanLabel(restriction.minimumPlan),
      })
    : t("billing.capabilityRestriction.lockedBadgeGeneric");

/* ── Toast ── */

const openBilling = () => {
  void import("@/router").then(({ router }) => {
    void router.navigate({ to: "/billing" });
  });
};

const openSignInDialog = () => {
  void import("@/router").then(({ router }) => {
    void router.navigate({
      to: ".",
      search: (prev: { dialog?: "auth" | "connect" }) => ({
        ...prev,
        dialog: "auth" as const,
      }),
    });
  });
};

export const buildCapabilityRestrictionToast = (
  restriction: CapabilityRestriction,
  t: Translate = defaultTranslate,
): ToastOptions => ({
  title: getCapabilityRestrictionTitle(restriction, t),
  description: getCapabilityRestrictionDescription(restriction, t),
  variant: "error",
  duration: 8000,
  action: {
    label: getCapabilityRestrictionActionLabel(restriction, t),
    onClick:
      restriction.actionKind === "sign-in" ? openSignInDialog : openBilling,
  },
});

/**
 * Fire the restriction toast for `capability` and report whether the
 * user is blocked. Callers use the boolean to bail out of the action
 * they were about to take.
 */
export const notifyCapabilityRestriction = (
  capability: Capability,
  options: {
    audience?: ManagedModelAudience | null;
    t?: Translate;
  } = {},
): boolean => {
  const audience =
    options.audience === undefined ? readBillingAudience() : options.audience;
  const restriction = resolveCapabilityRestriction(audience, capability);
  if (!restriction) return false;
  showToast(buildCapabilityRestrictionToast(restriction, options.t));
  return true;
};
