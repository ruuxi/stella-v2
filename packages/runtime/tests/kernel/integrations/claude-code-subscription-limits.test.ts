import { describe, expect, it } from "vitest";

import { claudeCodeSubscriptionLimitOf } from "@stella/runtime/kernel/integrations/claude-code-session-runtime";

describe("subscription limit detection", () => {
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
