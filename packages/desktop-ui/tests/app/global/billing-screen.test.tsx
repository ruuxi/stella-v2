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
    go: { label: "Go", monthlyPriceCents: 1_000, ...PLAN_CONFIG },
    pro: { label: "Pro", monthlyPriceCents: 6_000, ...PLAN_CONFIG },
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
    expect(container.textContent).toContain("Extra usage credit");
    expect(container.textContent).toContain("$12.50");
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
