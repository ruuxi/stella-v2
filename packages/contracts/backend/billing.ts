import type { IdentityLevel } from "../gateway/api.js";

/**
 * Billing, served from the owner's object: the plan, usage against its
 * windows, purchased credits, and the Stripe pages that change them. Stripe
 * is the record for payments; the owner object holds the plan Stripe last
 * reported and meters usage.
 */

export type BillingPlan = "free" | "go" | "pro";
export type PaidBillingPlan = Exclude<BillingPlan, "free">;

export type BillingPlanConfig = {
  label: string;
  monthlyPriceCents: number;
  /** First invoice price when a first-month coupon is configured (display only). */
  introFirstMonthPriceCents?: number;
  rollingLimitUsd: number;
  rollingWindowHours: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
  /** Spend allowed for the account's lifetime; absent on purely windowed plans. */
  lifetimeLimitUsd?: number;
};

export type BillingUsage = {
  rollingUsedUsd: number;
  rollingLimitUsd: number;
  weeklyUsedUsd: number;
  weeklyLimitUsd: number;
  monthlyUsedUsd: number;
  monthlyLimitUsd: number;
  lifetimeUsedUsd: number;
  /** Null on plans without a lifetime cap. */
  lifetimeLimitUsd: number | null;
};

export type BillingStatus = {
  authenticated: boolean;
  isAnonymous: boolean;
  identityLevel: IdentityLevel;
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
  credits: {
    currency: string;
    balanceUsd: number;
    totalPurchasedUsd: number;
    totalConsumedUsd: number;
  };
  creditPurchase: {
    currency: string;
    minAmountCents: number;
    maxAmountCents: number;
    presetAmountCents: number[];
  };
};

export type BillingCalls = {
  /** A Stripe Checkout page that starts a subscription. */
  "billing.checkout": {
    args: {
      plan: PaidBillingPlan;
      returnUrl: string;
      /** "ios" with the StoreKit storefront enforces the U.S.-only policy. */
      source?: string;
      appStoreCountry?: string;
    };
    result: { url: string; sessionId: string };
  };
  /** A Stripe Checkout page that buys usage credit. */
  "billing.creditCheckout": {
    args: { amountCents: number; returnUrl: string };
    result: { url: string; sessionId: string };
  };
  /** The Stripe billing portal for an existing customer. */
  "billing.portal": {
    args: { returnUrl: string };
    result: { url: string };
  };
};

export type BillingViews = {
  "billing.status": { args: Record<string, never>; result: BillingStatus };
};
