import { describe, expect, test } from "bun:test";

import { buildCloudSystemPrompt } from "../src/cloud-prompt.js";

describe("cloud prompt", () => {
  test("memory-off system prompt exposes no Remember tool contract", () => {
    const prompt = buildCloudSystemPrompt({
      canonicalBody: "canonical",
      personalityBody: null,
      localeDirective: undefined,
      residentSection: "",
      skillSection: "",
      memoryEnabled: false,
    });
    expect(prompt).toContain("The owner has disabled cloud memory");
    expect(prompt).not.toContain("Read, Remember, spawn_agent");
    expect(prompt).toContain("Read, spawn_agent");
  });
});
