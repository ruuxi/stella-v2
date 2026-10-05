import { describe, expect, it } from "vitest";

import { subscriptionLimitOfError } from "@stella/runtime/ai/providers/auth-refresh";
import { claudeCodeSubscriptionLimitOf } from "@stella/runtime/kernel/integrations/claude-code-session-runtime";

describe("subscription limit detection", () => {
  it("recognises usage limits, not ordinary rate limits", () => {
    expect(
      subscriptionLimitOfError(
        Object.assign(new Error("You have hit your ChatGPT usage limit."), {
          code: "usage_limit_reached",
          resetsAt: 5_000,
        }),
      ),
    ).toEqual({ resetsAt: 5_000 });
    expect(
      subscriptionLimitOfError(
        Object.assign(new Error("429 rate_limit_error"), {
          status: 429,
          headers: new Headers({
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": "4102444800",
          }),
        }),
      ),
    ).toEqual({ resetsAt: 4_102_444_800_000 });
    expect(
      subscriptionLimitOfError(
        Object.assign(new Error("429 Too many requests"), { status: 429 }),
      ),
    ).toBeNull();
  });

  it("reads the Claude Code CLI's limit messages", () => {
    expect(
      claudeCodeSubscriptionLimitOf(new Error("Claude AI usage limit reached|4102444800")),
    ).toEqual({ resetsAt: 4_102_444_800_000 });
    expect(
      claudeCodeSubscriptionLimitOf(new Error("5-hour limit reached ∙ resets 3pm")),
    ).toEqual({});
    expect(claudeCodeSubscriptionLimitOf(new Error("Tool call failed"))).toBeNull();
  });
});
