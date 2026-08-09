import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/api";
// Imported from the module rather than the `@/shared/i18n` barrel on
// purpose: the barrel re-exports `RemoteI18nProvider`, which pulls in
// `convex/react` and the auth provider. This component only needs the
// active locale string, and the deep import keeps that dependency out.
import { useLocale } from "@/shared/i18n/I18nProvider";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { openExternalUrl } from "@/platform/electron/open-external";
import "./BillingScreen.css";

/**
 * Native Plan & Billing surface.
 *
 * This used to be an embedded stella.sh `<webview>` (a holdover from the
 * self-modifying-app era, when billing had to live out of the agent's
 * reach). It now talks to the same Convex `billing` module the website
 * uses; the only surfaces that leave the app are Stripe-hosted Checkout
 * and the Stripe Customer Portal, which open in the system browser. Plan
 * changes land back here reactively via Stripe webhooks → Convex.
 */

type BillingPlan = "free" | "go" | "pro";
type PaidBillingPlan = Exclude<BillingPlan, "free">;

type BillingPlanConfig = {
  label: string;
  monthlyPriceCents: number;
  introFirstMonthPriceCents?: number;
  rollingLimitUsd: number;
  rollingWindowHours: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
};

type BillingUsage = {
  rollingUsedUsd: number;
  rollingLimitUsd: number;
  weeklyUsedUsd: number;
  weeklyLimitUsd: number;
  monthlyUsedUsd: number;
  monthlyLimitUsd: number;
};

type BillingStatus = {
  authenticated: boolean;
  isAnonymous: boolean;
  plan: BillingPlan;
  subscriptionStatus: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  usage: BillingUsage | null;
  usagePolicy:
    | {
        kind: "anonymous_requests";
        requestLimit: number;
        perIpRequestLimit: number;
        resetAfterInactivityDays: number;
      }
    | { kind: "managed_cost" };
  plans: Record<BillingPlan, BillingPlanConfig>;
};

type UsageCreditOptions = {
  currency: string;
  minAmountCents: number;
  maxAmountCents: number;
  presetAmountCents: number[];
};

type UsageCreditStatus = {
  authenticated: boolean;
  currency: string;
  balanceUsd: number;
  totalPurchasedUsd: number;
  totalConsumedUsd: number;
};

const PLAN_ORDER: BillingPlan[] = ["free", "go", "pro"];
const RECOMMENDED_PLAN: BillingPlan = "pro";

const STATIC_PLAN_DISPLAY: Record<
  BillingPlan,
  { label: string; monthlyPriceCents: number }
> = {
  free: { label: "Free", monthlyPriceCents: 0 },
  go: { label: "Go", monthlyPriceCents: 1_000 },
  pro: { label: "Pro", monthlyPriceCents: 6_000 },
};

const PLAN_USAGE_TAGLINE: Record<BillingPlan, string> = {
  free: "Light usage to try Stella",
  go: "Baseline monthly usage",
  pro: "3x the usage of Go",
};

const BASE_PLAN_FEATURES: readonly string[] = [
  "Voice features",
  "Image, video, audio and 3D generation",
];

const PRIORITY_PLAN_FEATURE = "Higher priority, increased speeds";
const VERIFIED_BADGE_FEATURE = "Verified creator badge on the Store";

const PRIORITY_PLANS = new Set<BillingPlan>(["pro"]);
const PAID_PLANS = new Set<BillingPlan>(["go", "pro"]);

const getPlanFeatures = (plan: BillingPlan): readonly string[] => {
  const features: string[] = [];
  if (PRIORITY_PLANS.has(plan)) features.push(PRIORITY_PLAN_FEATURE);
  features.push(...BASE_PLAN_FEATURES);
  if (PAID_PLANS.has(plan)) features.push(VERIFIED_BADGE_FEATURE);
  return features;
};

/**
 * Amounts are denominated in USD regardless of where the user is —
 * that's a billing fact, not a display choice — but the *presentation*
 * (digit grouping, decimal separator, symbol placement, calendar order)
 * belongs to the reader's locale. So the currency stays "USD" while the
 * formatter's locale tracks the active UI language: a German user sees
 * `1.234,56 $` and `5. Januar 2026`, not `$1,234.56` and `January 5, 2026`.
 */
const useBillingFormatters = (locale: string) =>
  useMemo(
    () => ({
      /** Whole-dollar plan prices. */
      currency: new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }),
      /** Cent-precise balances and usage meters. */
      usd: new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      date: new Intl.DateTimeFormat(locale, {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
      percent: new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 0,
      }),
    }),
    [locale],
  );

const toUsagePercent = (usedUsd: number, limitUsd: number) => {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) return 0;
  if (!Number.isFinite(usedUsd) || usedUsd <= 0) return 0;
  return Math.min(100, Math.max(0, (usedUsd / limitUsd) * 100));
};

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Stripe redirects back to the website's /billing after Checkout/Portal —
 * the browser tab shows the confirmation while the plan flows into the app
 * reactively over the Convex socket. Base URL comes from the same embed
 * config main already exposes for the Store, so env overrides
 * (STELLA_STORE_WEB_URL) keep working in dev.
 */
const getBillingReturnUrl = async (): Promise<string> => {
  let baseUrl = "https://stella.sh";
  try {
    const config = await window.electronAPI?.storeWeb?.getEmbedConfig?.();
    if (config?.baseUrl) baseUrl = config.baseUrl;
  } catch {
    // Fall through to the production default.
  }
  return new URL("/billing", baseUrl).toString();
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

export function BillingPanel() {
  const { hasConnectedAccount } = useAuthSessionState();
  const locale = useLocale();
  const formatters = useBillingFormatters(locale);

  const formatUsagePercent = useCallback(
    (usedUsd: number, limitUsd: number) => {
      // Intl percent formatting takes a fraction, not 0-100.
      const fraction = toUsagePercent(usedUsd, limitUsd) / 100;
      // Any nonzero usage should read as "some", never as a rounded-down
      // 0%. `<` is a math symbol, so it needs no translation and the bidi
      // algorithm places it correctly under `dir="rtl"`.
      if (fraction > 0 && fraction < 0.01) {
        return `<${formatters.percent.format(0.01)}`;
      }
      return formatters.percent.format(fraction);
    },
    [formatters],
  );

  // Bucketed clock for usage-window recomputation: refreshing every 60s
  // keeps the query cache stable between ticks (see getSubscriptionStatus).
  const [billingNowMs, setBillingNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setBillingNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? { now: billingNowMs } : "skip",
  ) as BillingStatus | undefined;
  const creditOptions = useQuery(
    api.billing.getUsageCreditPurchaseOptions,
    hasConnectedAccount ? {} : "skip",
  ) as UsageCreditOptions | undefined;
  const creditStatus = useQuery(
    api.billing.getUsageCreditStatus,
    hasConnectedAccount ? {} : "skip",
  ) as UsageCreditStatus | undefined;
  const startCheckout = useAction(api.billing.createCheckoutSession);
  const openPortal = useAction(api.billing.createBillingPortalSession);
  const startCreditCheckout = useAction(
    api.billing.createUsageCreditCheckoutSession,
  );

  const [startingPlan, setStartingPlan] = useState<PaidBillingPlan | null>(
    null,
  );
  const [openingPortal, setOpeningPortal] = useState(false);
  const [startingCredit, setStartingCredit] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creditCustomAmount, setCreditCustomAmount] = useState("");
  const [creditSelectedPresetCents, setCreditSelectedPresetCents] = useState<
    number | null
  >(null);

  const planCatalog = billingStatus?.plans;
  const currentPlan = billingStatus?.plan ?? "free";
  const usage = billingStatus?.usage;
  const hasAccount = Boolean(
    hasConnectedAccount &&
      billingStatus?.authenticated &&
      !billingStatus.isAnonymous,
  );
  const isLoadingStatus = hasConnectedAccount && billingStatus === undefined;
  // Active paid subscribers change/cancel plans through the Stripe portal —
  // createCheckoutSession rejects them with CONFLICT.
  const isActivePaidSubscriber = hasAccount && currentPlan !== "free";
  const currentPlanRank = PLAN_ORDER.indexOf(currentPlan);

  const getPlanDisplay = useCallback(
    (plan: BillingPlan) => {
      const live = planCatalog?.[plan];
      const fallback = STATIC_PLAN_DISPLAY[plan];
      return {
        label: live?.label ?? fallback.label,
        monthlyPriceCents:
          live?.monthlyPriceCents ?? fallback.monthlyPriceCents,
        ...(typeof live?.introFirstMonthPriceCents === "number"
          ? { introFirstMonthPriceCents: live.introFirstMonthPriceCents }
          : {}),
      };
    },
    [planCatalog],
  );

  const handleStartCheckout = useCallback(
    async (plan: PaidBillingPlan) => {
      if (!hasAccount) {
        openSignInDialog();
        return;
      }
      setError(null);
      setNotice(null);
      setStartingPlan(plan);
      try {
        const session = await startCheckout({
          plan,
          returnUrl: await getBillingReturnUrl(),
        });
        openExternalUrl(session.url);
        setNotice(
          "Checkout opened in your browser. Your plan updates here automatically once payment completes.",
        );
      } catch (err) {
        setError(getErrorMessage(err, "Unable to start checkout right now."));
      } finally {
        setStartingPlan(null);
      }
    },
    [hasAccount, startCheckout],
  );

  const handleOpenPortal = useCallback(async () => {
    if (!hasAccount) {
      openSignInDialog();
      return;
    }
    setError(null);
    setNotice(null);
    setOpeningPortal(true);
    try {
      const session = await openPortal({
        returnUrl: await getBillingReturnUrl(),
      });
      openExternalUrl(session.url);
      setNotice(
        "Billing management opened in your browser. Changes appear here automatically.",
      );
    } catch (err) {
      setError(getErrorMessage(err, "Unable to open billing right now."));
    } finally {
      setOpeningPortal(false);
    }
  }, [hasAccount, openPortal]);

  const parseCustomAmountCents = useCallback(
    (raw: string): { amountCents: number; error: string | null } => {
      if (!creditOptions) {
        return { amountCents: 0, error: "Credit options are still loading." };
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        return { amountCents: 0, error: "Enter an amount." };
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { amountCents: 0, error: "Enter a valid amount in dollars." };
      }
      const amountCents = Math.round(parsed * 100);
      if (amountCents < creditOptions.minAmountCents) {
        return {
          amountCents,
          error: `Minimum is ${formatters.usd.format(creditOptions.minAmountCents / 100)}.`,
        };
      }
      if (amountCents > creditOptions.maxAmountCents) {
        return {
          amountCents,
          error: `Maximum is ${formatters.usd.format(creditOptions.maxAmountCents / 100)}.`,
        };
      }
      return { amountCents, error: null };
    },
    [creditOptions],
  );

  const handleSelectCreditPreset = useCallback((amountCents: number) => {
    setCreditSelectedPresetCents(amountCents);
    setCreditCustomAmount((amountCents / 100).toFixed(2).replace(/\.00$/, ""));
  }, []);

  const handleStartCreditCheckout = useCallback(async () => {
    if (!hasAccount) {
      openSignInDialog();
      return;
    }
    setError(null);
    setNotice(null);
    const { amountCents, error: amountError } =
      parseCustomAmountCents(creditCustomAmount);
    if (amountError) {
      setError(amountError);
      return;
    }
    setStartingCredit(true);
    try {
      const session = await startCreditCheckout({
        amountCents,
        returnUrl: await getBillingReturnUrl(),
      });
      openExternalUrl(session.url);
      setNotice(
        "Checkout opened in your browser. Credit is added automatically once payment completes.",
      );
    } catch (err) {
      setError(getErrorMessage(err, "Unable to start checkout right now."));
    } finally {
      setStartingCredit(false);
    }
  }, [
    creditCustomAmount,
    hasAccount,
    parseCustomAmountCents,
    startCreditCheckout,
  ]);

  if (!hasConnectedAccount) {
    return (
      <div className="billing-panel">
        <div className="billing-state" role="status">
          <strong>Sign in to manage your plan</strong>
          <span>
            Plans, usage limits and extra credit are tied to your Stella
            account.
          </span>
          <button type="button" onClick={openSignInDialog}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  const currentPlanCatalogEntry = planCatalog?.[currentPlan];
  const rollingWindowHours = currentPlanCatalogEntry?.rollingWindowHours ?? 5;

  const usageMeters =
    usage && billingStatus?.usagePolicy.kind === "managed_cost"
      ? ([
          {
            key: "rolling",
            label: `Last ${rollingWindowHours}h`,
            usedUsd: usage.rollingUsedUsd,
            limitUsd: usage.rollingLimitUsd,
          },
          {
            key: "weekly",
            label: "This week",
            usedUsd: usage.weeklyUsedUsd,
            limitUsd: usage.weeklyLimitUsd,
          },
          {
            key: "monthly",
            label: "This month",
            usedUsd: usage.monthlyUsedUsd,
            limitUsd: usage.monthlyLimitUsd,
          },
        ] as const)
      : null;

  const renewalLabel = billingStatus?.cancelAtPeriodEnd
    ? "Cancellation pending"
    : "Next renewal";
  const renewalDetail = billingStatus?.currentPeriodEnd
    ? billingStatus.cancelAtPeriodEnd
      ? `Access ends ${formatters.date.format(new Date(billingStatus.currentPeriodEnd))}`
      : `Renews ${formatters.date.format(new Date(billingStatus.currentPeriodEnd))}`
    : "Managed by Stripe";

  return (
    <div className="billing-panel">
      {error ? (
        <p className="billing-notice billing-notice--error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="billing-notice">{notice}</p> : null}

      <section className="billing-account" aria-label="Your plan">
        <div className="billing-account-head">
          <div className="billing-account-plan">
            <span className="billing-label">Current plan</span>
            <span className="billing-account-plan-name">
              {isLoadingStatus ? "…" : getPlanDisplay(currentPlan).label}
            </span>
            {isActivePaidSubscriber ? (
              <span className="billing-account-renewal">
                {renewalLabel} · {renewalDetail}
              </span>
            ) : null}
          </div>
          {isActivePaidSubscriber ? (
            <button
              type="button"
              className="billing-cta"
              onClick={() => void handleOpenPortal()}
              disabled={openingPortal}
            >
              {openingPortal ? "Opening…" : "Manage subscription"}
            </button>
          ) : null}
        </div>

        {usageMeters ? (
          <div className="billing-account-meters">
            {usageMeters.map((meter) => (
              <div
                key={meter.key}
                className="billing-meter"
                title={`${formatters.usd.format(meter.usedUsd)} of ${formatters.usd.format(meter.limitUsd)}`}
              >
                <div className="billing-meter-label">
                  <span>{meter.label}</span>
                  <span>
                    {formatUsagePercent(meter.usedUsd, meter.limitUsd)}
                  </span>
                </div>
                <div className="billing-meter-track">
                  <div
                    className="billing-meter-fill"
                    style={{
                      width: `${toUsagePercent(meter.usedUsd, meter.limitUsd)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="billing-plans" aria-label="Plans">
        {PLAN_ORDER.map((plan) => {
          const display = getPlanDisplay(plan);
          const isCurrentPlan = plan === currentPlan;
          const introCents =
            plan === "go" &&
            typeof display.introFirstMonthPriceCents === "number" &&
            display.introFirstMonthPriceCents > 0 &&
            display.monthlyPriceCents > display.introFirstMonthPriceCents &&
            !isCurrentPlan
              ? display.introFirstMonthPriceCents
              : null;
          const isPaidPlan = plan !== "free";
          const isStartingThisPlan = startingPlan === plan;
          const isRecommended =
            plan === RECOMMENDED_PLAN && currentPlan !== RECOMMENDED_PLAN;
          const targetRank = PLAN_ORDER.indexOf(plan);
          const changeVerb =
            isActivePaidSubscriber && isPaidPlan && !isCurrentPlan
              ? targetRank > currentPlanRank
                ? "Upgrade to"
                : "Downgrade to"
              : "Choose";
          const ctaLabel = isCurrentPlan
            ? "Current plan"
            : isStartingThisPlan
              ? "Opening…"
              : isActivePaidSubscriber && !isPaidPlan
                ? "Cancel to switch"
                : isActivePaidSubscriber && isPaidPlan
                  ? openingPortal
                    ? "Opening…"
                    : `${changeVerb} ${display.label}`
                  : isPaidPlan
                    ? `Choose ${display.label}`
                    : "Included";

          const handlePlanClick = () => {
            if (isCurrentPlan) return;
            if (isActivePaidSubscriber) {
              // Plan changes and cancellation both go through the portal.
              void handleOpenPortal();
              return;
            }
            if (isPaidPlan) {
              void handleStartCheckout(plan as PaidBillingPlan);
            }
          };

          const isDisabled =
            isCurrentPlan ||
            startingPlan !== null ||
            (isActivePaidSubscriber ? openingPortal : !isPaidPlan);

          return (
            <article
              key={plan}
              className="billing-plan"
              data-active={isCurrentPlan || undefined}
              data-recommended={isRecommended || undefined}
            >
              <div className="billing-plan-head">
                <span className="billing-plan-name">{display.label}</span>
                {isRecommended ? (
                  <span className="billing-plan-badge">Recommended</span>
                ) : null}
              </div>
              <div className="billing-plan-price">
                {introCents !== null ? (
                  <>
                    <strong>
                      {formatters.currency.format(introCents / 100)}
                    </strong>
                    <span> first month, then </span>
                    <strong>
                      {formatters.currency.format(
                        display.monthlyPriceCents / 100,
                      )}
                    </strong>
                    <span>/mo</span>
                  </>
                ) : display.monthlyPriceCents <= 0 ? (
                  <strong>Free</strong>
                ) : (
                  <>
                    <strong>
                      {formatters.currency.format(
                        display.monthlyPriceCents / 100,
                      )}
                    </strong>
                    <span>/mo</span>
                  </>
                )}
              </div>
              <p className="billing-plan-tagline">{PLAN_USAGE_TAGLINE[plan]}</p>
              <ul className="billing-plan-features">
                {getPlanFeatures(plan).map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <button
                type="button"
                className={
                  "billing-cta" + (isCurrentPlan ? " billing-cta--current" : "")
                }
                onClick={handlePlanClick}
                disabled={isDisabled}
              >
                {ctaLabel}
              </button>
            </article>
          );
        })}
      </section>

      <section className="billing-credit" aria-label="Extra usage credit">
        <div className="billing-credit-head">
          <div>
            <h2 className="billing-section-title">Extra usage credit</h2>
            <p className="billing-section-sub">
              One-time top-up. Stella spends it automatically once your included
              monthly usage is gone, then resumes from your plan next month.
            </p>
          </div>
          {creditStatus?.authenticated ? (
            <div className="billing-credit-balance">
              <span className="billing-label">Available</span>
              <span className="billing-credit-balance-value">
                {formatters.usd.format(creditStatus.balanceUsd)}
              </span>
            </div>
          ) : null}
        </div>

        {creditOptions ? (
          <div
            className="billing-credit-presets"
            role="radiogroup"
            aria-label="Preset amounts"
          >
            {creditOptions.presetAmountCents.map((amountCents) => {
              const isSelected = creditSelectedPresetCents === amountCents;
              return (
                <button
                  key={amountCents}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className="billing-credit-preset"
                  data-active={isSelected || undefined}
                  onClick={() => handleSelectCreditPreset(amountCents)}
                  disabled={startingCredit}
                >
                  {formatters.currency.format(amountCents / 100)}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="billing-credit-form">
          <label className="billing-credit-input-wrap">
            <span aria-hidden="true">$</span>
            <input
              type="text"
              inputMode="decimal"
              className="billing-credit-input"
              placeholder={
                creditOptions
                  ? `${creditOptions.minAmountCents / 100}–${creditOptions.maxAmountCents / 100}`
                  : "Amount"
              }
              value={creditCustomAmount}
              onChange={(event) => {
                setCreditCustomAmount(event.target.value);
                setCreditSelectedPresetCents(null);
              }}
              disabled={!creditOptions || startingCredit}
              aria-label="Custom credit amount in dollars"
            />
          </label>
          <button
            type="button"
            className="billing-cta"
            onClick={() => void handleStartCreditCheckout()}
            disabled={
              !creditOptions || startingCredit || !creditCustomAmount.trim()
            }
          >
            {startingCredit ? "Opening…" : "Add credit"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function BillingScreen() {
  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <div className="billing-screen-scroll">
          <BillingPanel />
        </div>
      </div>
    </div>
  );
}
