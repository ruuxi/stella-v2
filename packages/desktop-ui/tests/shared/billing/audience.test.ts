import { describe, expect, it } from "bun:test";

import {
  isRestrictedAudienceAllowedStellaModelId,
  isRestrictedModelOverrideAudience,
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

  it("lets restricted audiences pick only V4 Flash and Luna", () => {
    expect(isRestrictedAudienceAllowedStellaModelId("stella/light")).toBe(true);
    expect(
      isRestrictedAudienceAllowedStellaModelId(
        "stella/accounts/fireworks/models/deepseek-v4-flash-0731",
      ),
    ).toBe(true);
    expect(
      isRestrictedAudienceAllowedStellaModelId(
        "stella/openai/gpt-5.6-luna",
      ),
    ).toBe(true);
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
