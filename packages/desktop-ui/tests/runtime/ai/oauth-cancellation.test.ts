import { describe, expect, it } from "vitest";

import { getOAuthProvider } from "@stella/runtime/ai/utils/oauth/index";

describe("model provider OAuth cancellation", () => {
  it.each(["anthropic", "google-gemini-cli", "google-antigravity"])(
    "cancels %s while its browser callback is pending",
    async (providerId) => {
      const provider = getOAuthProvider(providerId);
      expect(provider).toBeDefined();

      const controller = new AbortController();
      const login = provider?.login({
        signal: controller.signal,
        onAuth: () => controller.abort(),
        onPrompt: async () => "",
      });

      await expect(login).rejects.toThrow(/abort|cancel/i);
    },
  );
});
