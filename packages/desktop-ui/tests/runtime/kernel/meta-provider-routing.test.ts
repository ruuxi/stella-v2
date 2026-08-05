import { describe, expect, it, vi } from "vitest";

vi.mock("@stella/runtime/kernel/storage/llm-credentials", () => ({
  getLocalLlmCredential: (_stellaAppDir: string, provider: string) =>
    provider === "meta" ? "meta-test-key" : null,
}));

vi.mock("@stella/runtime/kernel/storage/llm-oauth-credentials", () => ({
  hasLocalLlmOAuthCredential: () => false,
  getLocalLlmOAuthApiKey: async () => null,
}));

describe("Meta provider routing", () => {
  it("honors an explicit Muse model as a direct Meta Responses route", async () => {
    const { resolveLlmRoute } = await import(
      "@stella/runtime/kernel/model-routing"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella-meta-provider-test",
      modelName: "meta/muse-spark-1.2",
      agentType: "orchestrator",
      site: {
        baseUrl: "https://stella.example.test",
        getAuthToken: () => "stella-token",
      },
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model).toMatchObject({
      id: "muse-spark-1.2",
      provider: "meta",
      api: "openai-responses",
      baseUrl: "https://api.meta.ai/v1",
    });
    await expect(resolved.getApiKey()).resolves.toBe("meta-test-key");
  });
});
