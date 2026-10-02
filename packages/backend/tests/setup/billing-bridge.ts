import { vi } from "vitest";

/**
 * Billing and devices live in each owner's object on cloud-builder, which
 * Convex suites cannot reach. Every suite sees an allowed, free-plan owner with room to
 * spend; a test that needs another verdict overrides `fetchBillingAccess`.
 */
vi.mock("../../convex/billing_bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../convex/billing_bridge")>();
  return {
    ...actual,
    fetchBillingAccess: vi.fn(async () => ({
      plan: "free",
      isAnonymous: false,
      identityLevel: 1,
      unlimited: false,
      allowed: true,
      downgraded: false,
      audience: "free",
      retryAfterMs: 0,
      message: "",
      remainingMicroCents: 1_000_000_000_000,
    })),
    recordBillingUsage: vi.fn(async () => ({ recorded: 1, duplicate: 0 })),
    setBillingPlan: vi.fn(async () => ({ ok: true })),
    closeBilling: vi.fn(async () => ({ ok: true })),
    closeDevices: vi.fn(async () => ({ ok: true })),
  };
});
