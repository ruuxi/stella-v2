import { describe, expect, mock, test } from "bun:test";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { GatewayModelResolution } from "@stella/contracts/gateway/api";

let loadModelRegistryCalls = 0;

mock.module("@stella/contracts/model-registry", () => ({
  loadModelRegistry: () => {
    loadModelRegistryCalls += 1;
    throw new Error("registry import should stay off this path");
  },
  getLoadedModelRegistry: () => {
    throw new Error(
      "Model registry is not loaded. Call and await loadModelRegistry() during host startup before using synchronous model APIs.",
    );
  },
}));

const {
  createCloudRelayModel,
  createCloudRelaySession,
} = await import("./relay-model.js");

const GATEWAY = "https://gateway.example.test";
const CAPABILITY = "eyJ.turn-capability.sig";

const managed = (
  model = "stella/default",
): CloudExecutionSelection => ({
  engine: "stella",
  provider: "stella",
  model,
  reasoningEffort: "default",
});

const nativeAnthropic = (): CloudExecutionSelection => ({
  engine: "anthropic",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  reasoningEffort: "default",
});

const resolution = (
  overrides: Partial<GatewayModelResolution> = {},
): GatewayModelResolution => ({
  requestedModel: "stella/default",
  resolvedModel: "meta/muse-spark-1.3-contributor",
  provider: "openrouter",
  protocol: "openai-responses",
  reasoning: true,
  supportsImages: false,
  ...overrides,
});

const relayArgs = (execution: CloudExecutionSelection) => ({
  gatewayOrigin: GATEWAY,
  capability: CAPABILITY,
  agentType: "orchestrator",
  execution,
});

describe("managed relay registry loading", () => {
  test("creates the validated Stella session from local descriptor metadata without importing the generated registry", async () => {
    loadModelRegistryCalls = 0;
    const session = await createCloudRelaySession({
      ...relayArgs(managed()),
      audience: "pro",
      fetch: Object.assign(async () => {
        throw new Error("local descriptor path should not call the gateway");
      }, fetch),
    });

    expect(loadModelRegistryCalls).toBe(0);
    expect(session.model.id).toBe("stella/default");
    expect(session.model.api).toBe("openai-responses");
    expect(session.model.baseUrl).toBe(`${GATEWAY}/v1/relay`);
  });

  test("keeps Crof and Wafer V4 Flash descriptors on the registry-independent path", async () => {
    for (const [provider, requestedModel, resolvedModel] of [
      [
        "crof",
        "stella/crof/deepseek-v4-flash-0731",
        "crof/deepseek-v4-flash-0731",
      ],
      [
        "wafer",
        "stella/wafer/deepseek-v4-flash-0731-fast",
        "wafer/deepseek-v4-flash-0731-fast",
      ],
    ] as const) {
      loadModelRegistryCalls = 0;
      const model = await createCloudRelayModel({
        ...relayArgs(managed(requestedModel)),
        fetch: Object.assign(
          async () =>
            Response.json(
              resolution({
                requestedModel,
                resolvedModel,
                provider,
                protocol: "openai-completions",
              }),
            ),
          fetch,
        ),
      });

      expect(loadModelRegistryCalls).toBe(0);
      expect(model.id).toBe(requestedModel);
      expect(model.api).toBe("openai-completions");
    }
  });

  test("loads the generated registry for complete OpenAI gateway resolution metadata", async () => {
    loadModelRegistryCalls = 0;
    await expect(
      createCloudRelayModel({
        ...relayArgs(managed("stella/openai/gpt-5.6-sol")),
        fetch: Object.assign(
          async () =>
            Response.json(
              resolution({
                requestedModel: "stella/openai/gpt-5.6-sol",
                resolvedModel: "openai/gpt-5.6-sol",
                provider: "openai",
                protocol: "openai-responses",
                contextWindow: 272_000,
                maxOutputTokens: 128_000,
              }),
            ),
          fetch,
        ),
      }),
    ).rejects.toThrow("registry import should stay off this path");

    expect(loadModelRegistryCalls).toBe(1);
  });

  test("loads the generated registry for OpenRouter slugs with possible registry metadata", async () => {
    loadModelRegistryCalls = 0;
    await expect(
      createCloudRelayModel({
        ...relayArgs(managed("stella/openrouter/anthropic/claude-sonnet-4-6")),
        fetch: Object.assign(
          async () =>
            Response.json(
              resolution({
                requestedModel:
                  "stella/openrouter/anthropic/claude-sonnet-4-6",
                resolvedModel: "anthropic/claude-sonnet-4-6",
                provider: "openrouter",
                protocol: "openai-completions",
                contextWindow: 200_000,
                maxOutputTokens: 16_384,
              }),
            ),
          fetch,
        ),
      }),
    ).rejects.toThrow("registry import should stay off this path");

    expect(loadModelRegistryCalls).toBe(1);
  });

  test("keeps registry-backed metadata for native and custom managed resolutions", async () => {
    loadModelRegistryCalls = 0;
    await expect(createCloudRelayModel(relayArgs(nativeAnthropic()))).rejects.toThrow(
      "registry import should stay off this path",
    );
    expect(loadModelRegistryCalls).toBe(1);

    loadModelRegistryCalls = 0;
    await expect(createCloudRelayModel({
      ...relayArgs(managed("stella/x-ai/grok-4.5")),
      fetch: Object.assign(async () => Response.json(resolution({
        requestedModel: "stella/x-ai/grok-4.5",
        resolvedModel: "x-ai/grok-4.5",
        provider: "xai",
        protocol: "openai-responses",
        contextWindow: 500_000,
        maxOutputTokens: 500_000,
      })), fetch),
    })).rejects.toThrow("registry import should stay off this path");
    expect(loadModelRegistryCalls).toBe(1);
  });
});
