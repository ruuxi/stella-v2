import { describe, expect, test } from "bun:test";

import { stellaPromptTools } from "@stella/contracts/stella-prompts";

import { buildCloudSystemPrompt, CANONICAL_PROMPTS } from "../src/cloud-prompt.js";

describe("cloud prompt", () => {
  test("memory-off system prompt exposes no Remember tool contract", () => {
    const prompt = buildCloudSystemPrompt({
      canonicalBody: CANONICAL_PROMPTS.orchestratorBody,
      tools: stellaPromptTools(["code", "spawn_agent", "Read", "drive"], {
        history: false,
      }),
      personalityBody: null,
      localeDirective: undefined,
      residentSection: "",
      skillSection: "",
      threadId: "conversation-1",
    });
    expect(prompt).toContain("the owner has disabled cloud memory");
    expect(prompt).not.toContain("with `Remember`");
    expect(prompt).not.toContain("`history.sql(query, params)`");
    expect(prompt).not.toContain("<!--");
  });
});
