import { describe, expect, it } from "vitest";

import { LLM_PROVIDERS } from "@/global/settings/lib/llm-providers";

describe("LLM provider settings surface", () => {
  it("does not advertise retired Google subscription providers", () => {
    const providerKeys = LLM_PROVIDERS.map((provider) => provider.key);
    expect(providerKeys).not.toContain("google-gemini-cli");
    expect(providerKeys).not.toContain("google-antigravity");
    expect(providerKeys).toContain("google");
  });
});
