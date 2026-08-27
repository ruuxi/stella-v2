import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@stella/runtime/ai/types";
import { createSyncTempDirTracker } from "../../helpers/temp.js";

const credentials = new Map<string, string>();
const oauthCredentials = new Set<string>();

vi.mock("@stella/runtime/kernel/storage/llm-credentials", () => ({
  getLocalLlmCredential: (_stellaAppDir: string, provider: string) =>
    credentials.get(provider) ?? null,
}));

vi.mock("@stella/runtime/kernel/storage/llm-oauth-credentials", () => ({
  hasLocalLlmOAuthCredential: (_stellaAppDir: string, provider: string) =>
    oauthCredentials.has(provider),
  getLocalLlmOAuthApiKey: async (_stellaAppDir: string, provider: string) =>
    oauthCredentials.has(provider) ? `${provider}-oauth-token` : null,
}));

const model = (
  provider: string,
  id: string,
  api = "openai-completions",
): Model<any> => ({
  id,
  name: id,
  api: api as never,
  provider: provider as never,
  baseUrl: `https://${provider}.example.test`,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

vi.mock("@stella/runtime/ai/models", () => ({
  getAllModels: () => [
    model("anthropic", "claude-opus-4-8", "anthropic"),
    model("openrouter", "openai/gpt-5.5"),
  ],
  getModels: (provider: string) => {
    switch (provider) {
      case "anthropic":
        return [model("anthropic", "claude-opus-4-8", "anthropic")];
      case "openrouter":

        return [model("openrouter", "openai/gpt-5.5")];
      default:
        return [];
    }
  },
}));

const site = {
  baseUrl: "https://stella.example.test",
  getAuthToken: () => "stella-token",
};

const tempDirs = createSyncTempDirTracker();

const ORCHESTRATOR = "orchestrator";
const SUBAGENT = "general";

beforeEach(() => {
  credentials.clear();
  oauthCredentials.clear();
  vi.resetModules();
});

const loadModules = async () => {
  const { resolveLlmRoute } = await import(
    "@stella/runtime/kernel/model-routing"
  );
  const { getModelOverride, updateLocalModelPreferences } = await import(
    "@stella/runtime/kernel/preferences/local-preferences"
  );
  return { resolveLlmRoute, getModelOverride, updateLocalModelPreferences };
};

describe("subagent provider/model selection parity", () => {
  it("orchestrator and subagent resolve the same route and follow a mid-session switch", async () => {
    const stellaDataDir = tempDirs.create("stella-subagent-switch-");
    credentials.set("anthropic", "anthropic-key");
    credentials.set("openrouter", "openrouter-key");

    const { resolveLlmRoute, getModelOverride, updateLocalModelPreferences } =
      await loadModules();

    const resolveFor = (agentType: string) =>
      resolveLlmRoute({
        stellaAppDir: stellaDataDir,
        modelName: getModelOverride(stellaDataDir, agentType),
        agentType,
        site,
      });

    updateLocalModelPreferences(stellaDataDir, {
      modelOverrides: {
        [ORCHESTRATOR]: "anthropic/claude-opus-4-8",
        [SUBAGENT]: "anthropic/claude-opus-4-8",
      },
    });

    const orchBefore = resolveFor(ORCHESTRATOR);
    const subBefore = resolveFor(SUBAGENT);
    expect(subBefore.model.id).toBe(orchBefore.model.id);
    expect(subBefore.model.provider).toBe(orchBefore.model.provider);
    expect(subBefore.route).toBe(orchBefore.route);
    expect(orchBefore.model.provider).toBe("anthropic");
    expect(orchBefore.route).toBe("direct-provider");

    updateLocalModelPreferences(stellaDataDir, {
      modelOverrides: {
        [ORCHESTRATOR]: "openrouter/openai/gpt-5.5",
        [SUBAGENT]: "openrouter/openai/gpt-5.5",
      },
    });

    const orchAfter = resolveFor(ORCHESTRATOR);
    const subAfter = resolveFor(SUBAGENT);

    expect(subAfter.model.id).toBe("openai/gpt-5.5");
    expect(subAfter.model.provider).toBe("openrouter");
    expect(subAfter.route).toBe("direct-provider");
    expect(subAfter.model.id).toBe(orchAfter.model.id);
    expect(subAfter.model.provider).toBe(orchAfter.model.provider);
    expect(subAfter.route).toBe(orchAfter.route);
    expect(subAfter.model.id).not.toBe(subBefore.model.id);
  });

  it("resolves BYOK credentials from the passed data dir (route carries a usable key)", async () => {

    const stellaDataDir = tempDirs.create("stella-subagent-cred-");
    credentials.set("openrouter", "openrouter-key");

    const { resolveLlmRoute, getModelOverride, updateLocalModelPreferences } =
      await loadModules();

    updateLocalModelPreferences(stellaDataDir, {
      modelOverrides: { [SUBAGENT]: "openrouter/openai/gpt-5.5" },
    });

    const route = resolveLlmRoute({
      stellaAppDir: stellaDataDir,
      modelName: getModelOverride(stellaDataDir, SUBAGENT),
      agentType: SUBAGENT,
      site,
    });

    expect(route.route).toBe("direct-provider");
    expect(await route.getApiKey()).toBe("openrouter-key");
  });
});
