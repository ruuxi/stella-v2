import { describe, expect, it, vi, beforeEach } from "vitest";

const toasts = vi.hoisted(() => ({ shown: [] as unknown[] }));
vi.mock("@/ui/toast", () => ({
  showToast: (options: unknown) => {
    toasts.shown.push(options);
    return "toast-id";
  },
}));

import {
  CAPABILITY_MATRIX,
  buildCapabilityDenial,
} from "@stella/contracts/capabilities";
import {
  buildCapabilityRestrictionToast,
  canUseCapability,
  hasCapability,
  minimumPlanForCapability,
  notifyCapabilityRestriction,
  publishBillingAudience,
  readBillingAudience,
  resolveCapabilityRestriction,
  resolveDeniedCapability,
} from "@/global/billing/capabilities";
import {
  resolveFreeAllowance,
  toCapabilityAudience,
} from "@/global/billing/audience";
import { classifyStellaProviderError } from "@/features/chat/streaming/stella-provider-error-classifier";

describe("capability denial round-trip", () => {
  it("recovers every capability from the contract's own denial prose", () => {
    for (const capability of Object.keys(
      CAPABILITY_MATRIX,
    ) as (keyof typeof CAPABILITY_MATRIX)[]) {
      const denial = buildCapabilityDenial(capability, "free");
      const classification = classifyStellaProviderError(denial.message);
      expect(classification.kind).toBe("capability-required");
      expect(classification.capability).toBe(capability);
    }
  });
});

describe("capability audience mapping", () => {
  it("collapses the over-cap fallback audiences onto their plan", () => {

    expect(toCapabilityAudience("pro_fallback")).toBe("pro");
    expect(toCapabilityAudience("go_fallback")).toBe("go");
    expect(toCapabilityAudience("anonymous")).toBe("anonymous");
    expect(toCapabilityAudience("free")).toBe("free");
    expect(toCapabilityAudience(null)).toBeNull();
    expect(toCapabilityAudience(undefined)).toBeNull();
  });
});

describe("client capability gate", () => {
  beforeEach(() => {
    toasts.shown.length = 0;
    publishBillingAudience(null);
  });

  it("reads its verdict from the shared matrix", () => {
    for (const [capability, byAudience] of Object.entries(CAPABILITY_MATRIX)) {
      for (const [audience, allowed] of Object.entries(byAudience)) {
        expect(
          canUseCapability(
            audience as Parameters<typeof canUseCapability>[0],
            capability as Parameters<typeof canUseCapability>[1],
          ),
        ).toBe(allowed);
      }
    }
  });

  it("stays optimistic while the audience is unknown", () => {

    expect(canUseCapability(null, "image_generation")).toBe(true);
    expect(resolveCapabilityRestriction(null, "image_generation")).toBeNull();
  });

  it("names the cheapest plan that unlocks the capability", () => {
    const restriction = resolveCapabilityRestriction(
      "free",
      "three_d_generation",
    );
    expect(restriction).toMatchObject({
      capability: "three_d_generation",
      audience: "free",
      minimumPlan: minimumPlanForCapability("three_d_generation"),
      actionKind: "upgrade",
    });
  });

  it("asks signed-out users to sign in rather than to upgrade", () => {
    expect(
      resolveCapabilityRestriction("anonymous", "image_generation"),
    ).toMatchObject({ actionKind: "sign-in" });
  });

  it("returns no restriction for an audience the matrix allows", () => {
    expect(hasCapability("pro", "image_generation")).toBe(true);
    expect(resolveCapabilityRestriction("pro", "image_generation")).toBeNull();
  });
});

describe("reactive capability denial", () => {
  it("does not swallow a backend denial when the audience is unknown", () => {

    expect(resolveDeniedCapability(null, "video_generation")).toMatchObject({
      capability: "video_generation",
      actionKind: "upgrade",
    });
  });

  it("defers to generic error copy when the plan does have the capability", () => {
    expect(resolveDeniedCapability("pro", "video_generation")).toBeNull();
  });
});

describe("capability restriction toast", () => {
  beforeEach(() => {
    toasts.shown.length = 0;
    publishBillingAudience(null);
  });

  it("offers Sign in to anonymous users and Upgrade to everyone else", () => {
    const anonymous = buildCapabilityRestrictionToast(
      resolveCapabilityRestriction("anonymous", "image_generation")!,
    );
    expect(anonymous.action?.label).toBe("Sign in");
    expect(anonymous.description).toContain("Sign in to upgrade");

    const free = buildCapabilityRestrictionToast(
      resolveCapabilityRestriction("free", "image_generation")!,
    );
    expect(free.action?.label).toBe("Upgrade");

    expect(free.description).toContain("Pro");
    expect(free.title).toContain("Image generation");
  });

  it("fires from the published audience snapshot for non-React callers", () => {
    publishBillingAudience("go");
    expect(readBillingAudience()).toBe("go");
    expect(notifyCapabilityRestriction("three_d_generation")).toBe(true);
    expect(toasts.shown).toHaveLength(1);

    publishBillingAudience("pro");
    expect(notifyCapabilityRestriction("three_d_generation")).toBe(false);
    expect(toasts.shown).toHaveLength(1);
  });
});

describe("free lifetime allowance", () => {
  const usage = (overrides: Record<string, number> = {}) => ({
    rollingUsedUsd: 0,
    rollingLimitUsd: 5,
    weeklyUsedUsd: 0,
    weeklyLimitUsd: 20,
    monthlyUsedUsd: 0,
    monthlyLimitUsd: 40,
    ...overrides,
  });

  it("is absent on plans with no lifetime ceiling", () => {
    expect(resolveFreeAllowance({ plan: "free", usage: usage() })).toBeNull();
    expect(
      resolveFreeAllowance({
        plan: "go",
        usage: usage({ lifetimeUsedUsd: 0.1, lifetimeLimitUsd: 0.5 }),
      }),
    ).toBeNull();
  });

  it("reports remaining budget and the terminal state", () => {
    const partial = resolveFreeAllowance({
      plan: "free",
      usage: usage({ lifetimeUsedUsd: 0.2, lifetimeLimitUsd: 0.5 }),
    });
    expect(partial).toMatchObject({
      usedUsd: 0.2,
      limitUsd: 0.5,
      exhausted: false,
    });
    expect(partial?.remainingUsd).toBeCloseTo(0.3, 6);

    expect(
      resolveFreeAllowance({
        plan: "free",
        usage: usage({ lifetimeUsedUsd: 0.5, lifetimeLimitUsd: 0.5 }),
      }),
    ).toMatchObject({ remainingUsd: 0, exhausted: true });
  });
});
