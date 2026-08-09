// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasConnectedAccount: true,
  queryResults: new Map<unknown, unknown>(),
  startCheckout: vi.fn(),
  openPortal: vi.fn(),
  startCreditCheckout: vi.fn(),
  openExternalUrl: vi.fn(),
  routerNavigate: vi.fn(),
}));

const API = vi.hoisted(() => ({
  billing: {
    getSubscriptionStatus: "billing:getSubscriptionStatus",
    getUsageCreditPurchaseOptions: "billing:getUsageCreditPurchaseOptions",
    getUsageCreditStatus: "billing:getUsageCreditStatus",
    createCheckoutSession: "billing:createCheckoutSession",
    createBillingPortalSession: "billing:createBillingPortalSession",
    createUsageCreditCheckoutSession:
      "billing:createUsageCreditCheckoutSession",
  },
}));

vi.mock("@/convex/api", () => ({ api: API }));

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) =>
    args === "skip" ? undefined : mocks.queryResults.get(ref),
  useAction: (ref: unknown) => {
    if (ref === API.billing.createCheckoutSession) return mocks.startCheckout;
    if (ref === API.billing.createBillingPortalSession) return mocks.openPortal;
    return mocks.startCreditCheckout;
  },
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => ({
    hasConnectedAccount: mocks.hasConnectedAccount,
  }),
}));

vi.mock("@/platform/electron/open-external", () => ({
  openExternalUrl: mocks.openExternalUrl,
}));

vi.mock("@/router", () => ({
  router: { navigate: mocks.routerNavigate },
}));

import { BillingPanel } from "@/global/billing/BillingScreen";

const PLAN_CONFIG = {
  rollingWindowHours: 5,
  weeklyLimitUsd: 20,
  monthlyLimitUsd: 40,
  rollingLimitUsd: 5,
};

const subscriptionStatus = (
  overrides: Partial<Record<string, unknown>> = {},
) => ({
  authenticated: true,
  isAnonymous: false,
  plan: "free",
  subscriptionStatus: "none",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  usage: {
    rollingUsedUsd: 1,
    rollingLimitUsd: 5,
    weeklyUsedUsd: 2,
    weeklyLimitUsd: 20,
    monthlyUsedUsd: 4,
    monthlyLimitUsd: 40,
  },
  usagePolicy: { kind: "managed_cost" },
  plans: {
    free: { label: "Free", monthlyPriceCents: 0, ...PLAN_CONFIG },
    go: { label: "Go", monthlyPriceCents: 500, ...PLAN_CONFIG },
    pro: { label: "Pro", monthlyPriceCents: 1_500, ...PLAN_CONFIG },
  },
  ...overrides,
});

const seedQueries = (status: unknown) => {
  mocks.queryResults.set(API.billing.getSubscriptionStatus, status);
  mocks.queryResults.set(API.billing.getUsageCreditPurchaseOptions, {
    currency: "usd",
    minAmountCents: 100,
    maxAmountCents: 50_000,
    presetAmountCents: [500, 1_000, 2_500, 5_000],
  });
  mocks.queryResults.set(API.billing.getUsageCreditStatus, {
    authenticated: true,
    currency: "usd",
    balanceUsd: 12.5,
    totalPurchasedUsd: 20,
    totalConsumedUsd: 7.5,
  });
};

describe("billing panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(withI18n(<BillingPanel />));
    });
  };

  const findButton = (text: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === text,
    );

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.hasConnectedAccount = true;
    mocks.queryResults.clear();
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("prompts to sign in when no account is connected", async () => {
    mocks.hasConnectedAccount = false;
    await render();

    expect(container.textContent).toContain("Sign in to manage your plan");
    expect(container.querySelector(".billing-plans")).toBeNull();
  });

  it("renders plan, usage meters, plans grid and credit for a free user", async () => {
    seedQueries(subscriptionStatus());
    await render();

    expect(
      container.querySelector(".billing-account-plan-name")?.textContent,
    ).toBe("Free");
    expect(container.querySelectorAll(".billing-meter")).toHaveLength(3);
    expect(container.querySelectorAll(".billing-plan")).toHaveLength(3);
    expect(findButton("Choose Go")).not.toBeUndefined();
    expect(findButton("Choose Pro")).not.toBeUndefined();
    // Free user has no subscription to manage.
    expect(findButton("Manage subscription")).toBeUndefined();
    expect(container.textContent).toContain("Limited free use");
    expect(container.textContent).not.toContain("3x the usage");
    expect(container.textContent).not.toContain("Verified creator badge");
    expect(container.textContent).toContain("Extra usage credit");
    expect(container.textContent).toContain("$12.50");
  });

  it("lists only what each plan includes, in one shared order", async () => {
    seedQueries(subscriptionStatus());
    await render();

    const rowsFor = (nth: number) =>
      Array.from(
        container.querySelectorAll<HTMLLIElement>(
          `.billing-plan:nth-of-type(${nth}) .billing-plan-features li`,
        ),
      ).map((li) => li.textContent?.trim());

    const [free, go, pro] = [1, 2, 3].map(rowsFor);

    // No card ever renders a feature it does not include.
    expect(free).toEqual([
      "Personal assistant",
      "Coding agent",
      "Research and knowledge work",
    ]);
    expect(go).toEqual([
      ...free,
      "Voice, image and video generation",
      "No ads",
    ]);
    expect(pro).toEqual(go);

    // The rows plans share stay in the same sequence in every column, so
    // a longer card reads as an extension of the one beside it.
    expect(go.slice(0, free.length)).toEqual(free);
    expect(pro.slice(0, go.length)).toEqual(go);
  });

  // The Go discount is a Stripe coupon created `duration=once`: it comes
  // off the first invoice only. The headline may lead with the
  // discounted price, but it must never imply that price recurs.
  const discountedGo = (overrides: Record<string, unknown> = {}) => {
    const status = subscriptionStatus(overrides);
    return {
      ...status,
      plans: {
        ...status.plans,
        go: { ...status.plans.go, introFirstMonthPriceCents: 100 },
      },
    };
  };

  const goPriceBlock = () =>
    container
      .querySelectorAll(".billing-plan")[1]
      ?.querySelector(".billing-plan-price");

  it("leads with the discounted Go price and states the term with it", async () => {
    seedQueries(discountedGo());
    await render();

    const price = goPriceBlock();
    // The charged price is the headline; the standard rate is demoted.
    expect(price?.querySelector(".billing-plan-amount")?.textContent).toBe(
      "$1",
    );
    expect(price?.querySelector(".billing-plan-list-price")?.textContent).toBe(
      "$5",
    );

    // …and the term never gets separated from the number.
    expect(price?.textContent).toContain("first month");
    expect(price?.querySelector(".billing-plan-terms")?.textContent).toBe(
      "then $5/month",
    );
  });

  it("withholds the first-month offer from existing subscribers", async () => {
    seedQueries(
      discountedGo({
        plan: "pro",
        subscriptionStatus: "active",
        currentPeriodEnd: Date.UTC(2026, 8, 1),
      }),
    );
    await render();

    const price = goPriceBlock();
    expect(price?.querySelector(".billing-plan-list-price")).toBeNull();
    expect(price?.textContent).toBe("$5/month");
  });

  it("starts Stripe checkout in the external browser", async () => {
    seedQueries(subscriptionStatus());
    mocks.startCheckout.mockResolvedValue({
      url: "https://checkout.stripe.com/session",
      sessionId: "cs_123",
    });
    await render();

    await act(async () => {
      findButton("Choose Pro")?.click();
    });

    expect(mocks.startCheckout).toHaveBeenCalledWith({
      plan: "pro",
      returnUrl: "https://stella.sh/billing",
    });
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      "https://checkout.stripe.com/session",
    );
    expect(container.textContent).toContain("Checkout opened in your browser");
  });

  it("routes paid subscribers to the Stripe portal for plan changes", async () => {
    seedQueries(
      subscriptionStatus({
        plan: "go",
        subscriptionStatus: "active",
        currentPeriodEnd: Date.UTC(2026, 8, 1),
      }),
    );
    mocks.openPortal.mockResolvedValue({
      url: "https://billing.stripe.com/portal",
    });
    await render();

    expect(
      container.querySelector(".billing-account-plan-name")?.textContent,
    ).toBe("Go");
    expect(container.textContent).toContain("Next renewal");

    await act(async () => {
      findButton("Upgrade to Pro")?.click();
    });

    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.openPortal).toHaveBeenCalledWith({
      returnUrl: "https://stella.sh/billing",
    });
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      "https://billing.stripe.com/portal",
    );
  });

  it("omits payment-provider copy when renewal timing is unavailable", async () => {
    seedQueries(
      subscriptionStatus({
        plan: "go",
        subscriptionStatus: "active",
        currentPeriodEnd: null,
      }),
    );
    await render();

    expect(container.textContent).not.toContain("Managed by Stripe");
    expect(container.querySelector(".billing-account-renewal")).toBeNull();
  });

  it("validates custom credit amounts before checkout", async () => {
    seedQueries(subscriptionStatus());
    await render();

    const input = container.querySelector<HTMLInputElement>(
      ".billing-credit-input",
    );
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(input, "0.50");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      findButton("Add credit")?.click();
    });

    expect(mocks.startCreditCheckout).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Minimum is $1.00");
  });
});
