import { describe, expect, it } from "bun:test";

import {
  getRestrictionActionKind,
  isRestrictedAudienceAllowedStellaModelId,
  isRestrictedModelOverrideAudience,
  resolveFreeAllowance,
  toCapabilityAudience,
} from "../../../src/global/billing/audience";

describe("billing audience model restrictions", () => {
  it("marks the restricted override audiences", () => {
    expect(isRestrictedModelOverrideAudience("anonymous")).toBe(true);
    expect(isRestrictedModelOverrideAudience("free")).toBe(true);
    expect(isRestrictedModelOverrideAudience("go")).toBe(true);
    expect(isRestrictedModelOverrideAudience("go_fallback")).toBe(true);
    expect(isRestrictedModelOverrideAudience("pro")).toBe(false);
    expect(isRestrictedModelOverrideAudience("pro_fallback")).toBe(false);
  });

  it("lets restricted audiences pick the Muse default or V4 Flash", () => {
    expect(isRestrictedAudienceAllowedStellaModelId("stella/light")).toBe(true);
    expect(
      isRestrictedAudienceAllowedStellaModelId(
        "stella/meta/muse-spark-1.2-contributor",
      ),
    ).toBe(true);
    expect(
      isRestrictedAudienceAllowedStellaModelId(
        "stella/crof/deepseek-v4-flash-0731",
      ),
    ).toBe(true);
    expect(
      isRestrictedAudienceAllowedStellaModelId(
        "stella/wafer/deepseek-v4-flash-0731-fast",
      ),
    ).toBe(true);
    expect(
      isRestrictedAudienceAllowedStellaModelId(
        "stella/accounts/fireworks/models/deepseek-v4-flash-0731",
      ),
    ).toBe(true);
    expect(
      isRestrictedAudienceAllowedStellaModelId("stella/openai/gpt-5.6-luna"),
    ).toBe(false);
    expect(isRestrictedAudienceAllowedStellaModelId("stella/standard")).toBe(
      false,
    );
    expect(
      isRestrictedAudienceAllowedStellaModelId(
        "stella/accounts/fireworks/models/deepseek-v4-pro",
      ),
    ).toBe(false);
  });
});

describe("capability audience", () => {
  it("collapses over-cap fallbacks onto their plan", () => {
    // Being over a usage window is a usage problem, not an entitlement
    // one — a Pro user who spent this week's budget still has Pro.
    expect(toCapabilityAudience("go_fallback")).toBe("go");
    expect(toCapabilityAudience("pro_fallback")).toBe("pro");
    expect(toCapabilityAudience("anonymous")).toBe("anonymous");
    expect(toCapabilityAudience(null)).toBe(null);
  });

  it("shares one action rule with the model restrictions", () => {
    expect(getRestrictionActionKind("anonymous")).toBe("sign-in");
    expect(getRestrictionActionKind("free")).toBe("upgrade");
    expect(getRestrictionActionKind("go")).toBe("upgrade");
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

  it("only exists where the backend set a lifetime ceiling", () => {
    expect(resolveFreeAllowance({ plan: "free", usage: usage() })).toBe(null);
    expect(
      resolveFreeAllowance({
        plan: "go",
        usage: usage({ lifetimeUsedUsd: 0.1, lifetimeLimitUsd: 0.5 }),
      }),
    ).toBe(null);
  });

  it("marks the terminal state once the budget is spent", () => {
    expect(
      resolveFreeAllowance({
        plan: "free",
        usage: usage({ lifetimeUsedUsd: 0.5, lifetimeLimitUsd: 0.5 }),
      }),
    ).toMatchObject({ remainingUsd: 0, exhausted: true });
    expect(
      resolveFreeAllowance({
        plan: "free",
        usage: usage({ lifetimeUsedUsd: 0.1, lifetimeLimitUsd: 0.5 }),
      }),
    ).toMatchObject({ exhausted: false });
  });
});
