import { vi } from "vitest";
import { fetchBillingAccess } from "../../convex/billing_bridge";

/** The plan the stubbed billing bridge reports for every owner in this test. */
export const setTestBillingPlan = (plan: "free" | "go" | "pro"): void => {
  vi.mocked(fetchBillingAccess).mockImplementation(async () => ({
    plan,
    isAnonymous: false,
    identityLevel: plan === "free" ? 1 : 3,
    unlimited: false,
    allowed: true,
    downgraded: false,
    audience: plan,
    retryAfterMs: 0,
    message: "",
    remainingMicroCents: 1_000_000_000_000,
  }));
};
