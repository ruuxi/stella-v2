import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/api";
// Imported from the module rather than the `@/shared/i18n` barrel on
// purpose: the barrel re-exports `RemoteI18nProvider`, which pulls in
// `convex/react` and the auth provider. This component only needs the
// active locale string, and the deep import keeps that dependency out.
import { useLocale, useT } from "@/shared/i18n/I18nProvider";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { openExternalUrl } from "@/platform/electron/open-external";
import { Check } from "@/ui/icons";
import { CAPABILITIES, hasCapability } from "./capabilities";
import { resolveFreeAllowance } from "./audience";
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
  lifetimeLimitUsd?: number;
};

type BillingUsage = {
  rollingUsedUsd: number;
  rollingLimitUsd: number;
  weeklyUsedUsd: number;
  weeklyLimitUsd: number;
  monthlyUsedUsd: number;
  monthlyLimitUsd: number;
  /** Cumulative spend and the one-shot Free allowance it counts against. */
  lifetimeUsedUsd: number;
  lifetimeLimitUsd: number | null;
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
  go: { label: "Go", monthlyPriceCents: 500 },
  pro: { label: "Pro", monthlyPriceCents: 1_500 },
};

type UsageMeter = {
  key: string;
  label: string;
  usedUsd: number;
  limitUsd: number;
};

/**
 * One matrix, one order. Each card renders only the rows it includes —
 * a card never shows a feature struck through or dashed out, so every
 * line on this surface is something you get.
 *
 * The matrix is still the single source of truth rather than three hand
 * -written lists: keeping the order shared means the rows all three
 * plans have in common land in the same sequence in every column, so a
 * card that includes more simply runs longer than the one beside it.
 */
type PlanFeature = { key: string; plans: readonly BillingPlan[] };

const ALL_PLANS: readonly BillingPlan[] = ["free", "go", "pro"];
/** All-plan features that the paid media capability matrix doesn't model. */
const BASE_PLAN_FEATURES: readonly PlanFeature[] = [
  { key: "billing.features.assistant", plans: ALL_PLANS },
  { key: "billing.features.codingAgent", plans: ALL_PLANS },
  { key: "billing.features.research", plans: ALL_PLANS },
  { key: "billing.features.dictationReadAloud", plans: ALL_PLANS },
];

/**
 * Available across plans, but intentionally marketed only with Pro.
 * This is presentation, not an entitlement gate.
 */
const MARKETED_PLAN_FEATURES: readonly PlanFeature[] = [
  { key: "billing.features.multipleAgents", plans: ["pro"] },
];

/**
 * Capability rows are *derived* from the shared matrix, so the copy on
 * this screen cannot drift from what the app enforces: a capability
 * appears on exactly the cards whose plan the matrix grants it to. This
 * is why Pro reads as "more things", not "more tokens" — the rows that
 * only Pro carries are the capabilities themselves.
 */
const CAPABILITY_PLAN_FEATURES: readonly PlanFeature[] = CAPABILITIES.map(
  (capability) => ({
    key: `billing.capability.${capability}`,
    plans: PLAN_ORDER.filter((plan) => hasCapability(plan, capability)),
  }),
).filter((feature) => feature.plans.length > 0);

/**
 * Widest reach first (stable within a tier). That single rule is what
 * keeps the columns nested — every row a cheaper plan has appears above
 * every row it doesn't — no matter how the matrix is later re-cut.
 */
const PLAN_FEATURE_MATRIX: readonly PlanFeature[] = [
  ...BASE_PLAN_FEATURES,
  ...MARKETED_PLAN_FEATURES,
  ...CAPABILITY_PLAN_FEATURES,
]
  .map((feature, index) => ({ feature, index }))
  .sort(
    (a, b) =>
      b.feature.plans.length - a.feature.plans.length || a.index - b.index,
  )
  .map(({ feature }) => feature);

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
 * reactively over the Convex socket. Base URL comes from main so the
 * STELLA_WEB_URL override keeps working in dev.
 */
const getBillingReturnUrl = async (): Promise<string> => {
  let baseUrl = "https://stella.sh";
  try {
    const resolved = await window.electronAPI?.website?.getBaseUrl?.();
    if (resolved) baseUrl = resolved;
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
  const t = useT();
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
  const checkoutRequestRef = useRef<{
    plan: PaidBillingPlan;
    requestId: string;
  } | null>(null);
  const portalRequestRef = useRef<string | null>(null);
  const creditRequestRef = useRef<{
    amountCents: number;
    requestId: string;
  } | null>(null);

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
        const request =
          checkoutRequestRef.current?.plan === plan
            ? checkoutRequestRef.current
            : { plan, requestId: crypto.randomUUID() };
        checkoutRequestRef.current = request;
        const session = await startCheckout({
          plan,
          returnUrl: await getBillingReturnUrl(),
          requestId: request.requestId,
        });
        openExternalUrl(session.url);
        checkoutRequestRef.current = null;
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
      const requestId = portalRequestRef.current ?? crypto.randomUUID();
      portalRequestRef.current = requestId;
      const session = await openPortal({
        returnUrl: await getBillingReturnUrl(),
        requestId,
      });
      openExternalUrl(session.url);
      portalRequestRef.current = null;
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
      const request =
        creditRequestRef.current?.amountCents === amountCents
          ? creditRequestRef.current
          : { amountCents, requestId: crypto.randomUUID() };
      creditRequestRef.current = request;
      const session = await startCreditCheckout({
        amountCents,
        returnUrl: await getBillingReturnUrl(),
        requestId: request.requestId,
      });
      openExternalUrl(session.url);
      creditRequestRef.current = null;
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
          <button
            type="button"
            className="pill-btn pill-btn--lg pill-btn--primary"
            onClick={openSignInDialog}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  const currentPlanCatalogEntry = planCatalog?.[currentPlan];
  const rollingWindowHours = currentPlanCatalogEntry?.rollingWindowHours ?? 5;

  /**
   * The Free plan's allowance is a lifetime budget, so it must not be
   * shown through the rolling / weekly / monthly windows: three bars
   * that visibly refill would promise a reset that never comes. When an
   * allowance is present it replaces the windows entirely with a single
   * meter that only ever fills.
   */
  const freeAllowance = usage
    ? resolveFreeAllowance({ plan: currentPlan, usage })
    : null;

  const usageMeters: UsageMeter[] | null =
    usage && billingStatus?.usagePolicy.kind === "managed_cost"
      ? freeAllowance
        ? [
            {
              key: "lifetime",
              label: t("billing.freeAllowance.label"),
              usedUsd: freeAllowance.usedUsd,
              limitUsd: freeAllowance.limitUsd,
            },
          ]
        : [
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
          ]
      : null;

  const periodEndLabel = billingStatus?.currentPeriodEnd
    ? formatters.date.format(new Date(billingStatus.currentPeriodEnd))
    : null;

  const renewalLabel = billingStatus?.cancelAtPeriodEnd
    ? t("billing.renewal.pendingLabel")
    : t("billing.renewal.nextLabel");
  const renewalDetail = periodEndLabel
    ? billingStatus?.cancelAtPeriodEnd
      ? t("billing.renewal.accessEnds", { date: periodEndLabel })
      : t("billing.renewal.renews", { date: periodEndLabel })
    : null;

  /**
   * Cancelling does not cut access — Stripe keeps the plan live to the
   * end of the paid period. What happens *after* is the part worth
   * saying out loud: the Free allowance is granted once, so a subscriber
   * whose cumulative spend already passed it lands on a plan with
   * nothing left in it and Stella simply stops. Better read here, while
   * the plan is still running, than discovered the morning it lapses.
   *
   * Gated on the actual numbers rather than assumed: a subscriber still
   * under the Free cap really does keep a usable remainder, and telling
   * them otherwise would be wrong.
   */
  const freeLifetimeCapUsd = billingStatus?.plans.free.lifetimeLimitUsd ?? null;
  const lapseEndsAccess =
    billingStatus?.cancelAtPeriodEnd === true &&
    periodEndLabel !== null &&
    usage != null &&
    freeLifetimeCapUsd !== null &&
    usage.lifetimeUsedUsd >= freeLifetimeCapUsd;

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
            {isActivePaidSubscriber && renewalDetail ? (
              <span className="billing-account-renewal">
                {renewalLabel} · {renewalDetail}
              </span>
            ) : null}
          </div>
          {isActivePaidSubscriber ? (
            <button
              type="button"
              className="pill-btn pill-btn--lg"
              onClick={() => void handleOpenPortal()}
              disabled={openingPortal}
            >
              {openingPortal ? "Opening…" : "Manage subscription"}
            </button>
          ) : null}
        </div>

        {usageMeters ? (
          <div className="billing-account-meters">
            {usageMeters.map((meter) => {
              const percent = toUsagePercent(meter.usedUsd, meter.limitUsd);
              return (
                <div key={meter.key} className="billing-meter">
                  {/* The bar communicates relative usage without exposing
                      the internal dollar-denominated accounting. The
                      percentage stays in the accessible name, where a bar
                      cannot communicate its scale visually. */}
                  <div className="billing-meter-head">
                    <span className="billing-meter-label">{meter.label}</span>
                  </div>
                  <div
                    className="billing-meter-track"
                    role="progressbar"
                    aria-label={`${meter.label}: ${formatUsagePercent(
                      meter.usedUsd,
                      meter.limitUsd,
                    )} used`}
                    aria-valuenow={Math.round(percent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="billing-meter-fill"
                      style={{ width: `${percent}%` }}
                      data-full={percent >= 100 || undefined}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* A spent lifetime allowance is a terminal state, not a wait.
            Say so plainly and point at the only thing that resolves it —
            "try again later" would be a lie about a quota with no
            reset. */}
        {freeAllowance ? (
          freeAllowance.exhausted ? (
            <div
              className="billing-allowance billing-allowance--spent"
              role="status"
            >
              <div className="billing-allowance-copy">
                <strong>{t("billing.freeAllowance.exhaustedTitle")}</strong>
                <span>{t("billing.freeAllowance.exhaustedDescription")}</span>
              </div>
              <button
                type="button"
                className="pill-btn pill-btn--lg pill-btn--primary"
                onClick={() => {
                  if (isActivePaidSubscriber) {
                    void handleOpenPortal();
                    return;
                  }
                  void handleStartCheckout("go");
                }}
                disabled={startingPlan !== null}
              >
                {t("billing.freeAllowance.exhaustedCta")}
              </button>
            </div>
          ) : null
        ) : null}

        {lapseEndsAccess && periodEndLabel ? (
          <div
            className="billing-allowance billing-allowance--spent"
            role="status"
          >
            <div className="billing-allowance-copy">
              <strong>{t("billing.renewal.lapseTitle")}</strong>
              <span>
                {t("billing.renewal.lapseDescription", {
                  plan: getPlanDisplay(currentPlan).label,
                  date: periodEndLabel,
                })}
              </span>
            </div>
          </div>
        ) : null}
      </section>

      <header className="billing-plan-intro">
        <h1>{t("billing.heading")}</h1>
        <p>{t("billing.subtitle")}</p>
      </header>

      <section className="billing-plans" aria-label={t("billing.heading")}>
        {PLAN_ORDER.map((plan) => {
          const display = getPlanDisplay(plan);
          const isCurrentPlan = plan === currentPlan;
          // An intro rate is a first-subscription offer. Showing it to
          // someone who already pays turns the Go card into "downgrade
          // and get a discount" — an offer Stripe would not honour
          // through the portal anyway.
          const introCents =
            plan === "go" &&
            typeof display.introFirstMonthPriceCents === "number" &&
            display.introFirstMonthPriceCents > 0 &&
            display.monthlyPriceCents > display.introFirstMonthPriceCents &&
            !isCurrentPlan &&
            !isActivePaidSubscriber
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
                {isCurrentPlan ? (
                  <span className="billing-plan-badge billing-plan-badge--current">
                    <Check size={11} strokeWidth={2.4} aria-hidden="true" />
                    Current
                  </span>
                ) : isRecommended ? (
                  <span className="billing-plan-badge">Recommended</span>
                ) : null}
              </div>

              {/* A discounted plan leads with the price you actually pay
                  and demotes the standard rate to a struck-through
                  reference beside it. Free renders as $0 rather than the
                  word "Free": the card is already named Free, and a word
                  among numbers breaks the row.

                  The term is welded to the number, never whispered under
                  it. The discount this app can issue is a Stripe coupon
                  created `duration=once` (see STRIPE_COUPON_GO_FIRST_MONTH)
                  — it comes off the first invoice and renewals bill at the
                  standard rate. So "$1" never appears without "first
                  month" on the same line, and the renewal rate gets its
                  own line directly beneath. A headline reading "$5" with
                  the term buried is a price the billing system will not
                  honour on the second invoice. */}
              <div className="billing-plan-price">
                <span className="billing-plan-price-row">
                  <span className="billing-plan-amount">
                    {formatters.currency.format(
                      (introCents ?? display.monthlyPriceCents) / 100,
                    )}
                  </span>
                  {introCents !== null ? (
                    <>
                      <span className="billing-visually-hidden">
                        , down from{" "}
                      </span>
                      <s className="billing-plan-list-price">
                        {formatters.currency.format(
                          display.monthlyPriceCents / 100,
                        )}
                      </s>
                      <span className="billing-plan-period">first month</span>
                    </>
                  ) : plan !== "free" ? (
                    <span className="billing-plan-period">/month</span>
                  ) : null}
                </span>
                {introCents !== null ? (
                  <span className="billing-plan-terms">
                    then{" "}
                    {formatters.currency.format(
                      display.monthlyPriceCents / 100,
                    )}
                    /month
                  </span>
                ) : null}
              </div>

              <p className="billing-plan-tagline">
                {t(`billing.plans.${plan}.tagline`)}
              </p>

              <ul className="billing-plan-features">
                {PLAN_FEATURE_MATRIX.filter((feature) =>
                  feature.plans.includes(plan),
                ).map((feature) => (
                  <li key={feature.key}>
                    <Check
                      className="billing-plan-feature-icon"
                      size={13}
                      strokeWidth={2.2}
                      aria-hidden="true"
                    />
                    <span>{t(feature.key)}</span>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                className={
                  "pill-btn pill-btn--lg billing-plan-cta" +
                  (isRecommended && !isDisabled ? " pill-btn--primary" : "")
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
        {/* Copy and balance on the top line, the whole instrument on the
            second: presets, amount and action read left-to-right as one
            sentence instead of three stacked controls in a box. */}
        <div className="billing-credit-head">
          <div className="billing-credit-copy">
            <h2 className="billing-section-title">Extra usage credit</h2>
            <p className="billing-section-sub">
              Spent automatically once your included monthly usage is gone, then
              your plan resumes next month.
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

        <div className="billing-credit-form">
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

          <label className="billing-credit-input-wrap">
            <span className="billing-credit-input-prefix" aria-hidden="true">
              $
            </span>
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
            className="pill-btn pill-btn--lg pill-btn--primary billing-credit-submit"
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
