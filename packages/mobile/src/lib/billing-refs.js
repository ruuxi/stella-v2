import { makeFunctionReference } from "convex/server";

/**
 * The mobile app deliberately does not import the backend's generated `api`
 * object (it stays decoupled from the backend package and talks to Convex by
 * name). These are the billing functions the subscription UI needs, reused
 * as-is from the existing Stripe-backed billing module — no new billing
 * system is introduced.
 */
export const getSubscriptionStatusRef = makeFunctionReference(
  "billing:getSubscriptionStatus",
);

export const createCheckoutSessionRef = makeFunctionReference(
  "billing:createCheckoutSession",
);

export const createBillingPortalSessionRef = makeFunctionReference(
  "billing:createBillingPortalSession",
);
