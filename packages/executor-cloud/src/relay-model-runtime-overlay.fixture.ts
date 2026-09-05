import { getLoadedModelRegistry, loadModelRegistry } from "@stella/contracts/model-registry";
import type { Api, Model } from "@stella/runtime/ai/types.js";

await loadModelRegistry();
const registerCustomModel = async (): Promise<void> => {
  const { modelRuntime } = await import("@stella/runtime/ai/model-runtime.js");
  modelRuntime.registerModel("openrouter", {
    id: "custom-model",
    name: "Custom live model",
    api: "openai-completions",
    provider: "custom-live",
    baseUrl: "",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 321_000,
    maxTokens: 12_345,
    headers: { "x-custom-runtime": "present" },
  } satisfies Model<Api>);
};
const runtimeFirst = process.argv.includes("--runtime-first");
if (runtimeFirst) await registerCustomModel();
const { createResolvedManagedRelayModel } = await import("./relay-model.js");
const builtIn = Object.values(getLoadedModelRegistry().openrouter).find(
  (model) => model.api === "openai-completions",
);
if (!builtIn) throw new Error("Expected a generated OpenRouter model.");
const originalInputCost = builtIn.cost.input;
const detached = createResolvedManagedRelayModel({
  execution: { engine: "stella", provider: "stella", model: `stella/openrouter/${builtIn.id}`, reasoningEffort: "default" },
  resolution: { requestedModel: `stella/openrouter/${builtIn.id}`, resolvedModel: builtIn.id, provider: "openrouter", protocol: "openai-completions", reasoning: builtIn.reasoning, supportsImages: true },
  gatewayOrigin: "https://gateway.example.test", capability: "eyJ.fixture.sig", agentType: "general",
});
detached.cost.input = originalInputCost + 1;
const generatedMetadataDetached = builtIn.cost.input === originalInputCost;



if (!runtimeFirst) await registerCustomModel();

const model = createResolvedManagedRelayModel({
  execution: {
    engine: "stella",
    provider: "stella",
    model: "stella/openrouter/custom-model",
    reasoningEffort: "high",
  },
  resolution: {
    requestedModel: "stella/openrouter/custom-model",
    resolvedModel: "custom-model",
    provider: "openrouter",
    protocol: "openai-completions",
    reasoning: true,
    supportsImages: false,
  },
  gatewayOrigin: "https://gateway.example.test",
  capability: "eyJ.turn-capability.sig",
  agentType: "general",
});
console.log(JSON.stringify({
  generatedMetadataDetached,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  provider: model.provider,
  customHeader: model.headers?.["x-custom-runtime"],
}));
