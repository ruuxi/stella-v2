import { makeFunctionReference } from "convex/server";

export const getSubscriptionStatusRef = makeFunctionReference(
  "billing:getSubscriptionStatus",
);

export const createCheckoutSessionRef = makeFunctionReference(
  "billing:createCheckoutSession",
);

export const createBillingPortalSessionRef = makeFunctionReference(
  "billing:createBillingPortalSession",
);
