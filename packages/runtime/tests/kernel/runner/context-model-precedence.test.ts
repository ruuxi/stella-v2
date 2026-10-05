import { describe, expect, it } from "vitest";
import type { Model } from "@stella/runtime/ai/types";
import {
  captureEffectiveModelConfig,
  resolveAgentEngineForRun,
  resolveSpawnReasoningEffortForModel,
} from "@stella/runtime/kernel/runner/context";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";
import { STELLA_DEFAULT_MODEL } from "@stella/contracts/stella-api";

describe("spawn_agent engine precedence", () => {
  it("lets an explicit plain-model spawn override a saved Codex engine", () => {
    expect(resolveAgentEngineForRun("codex_cli", { engine: "default" })).toBe(
      "default",
    );
  });

  it("lets an explicit plain-model spawn override a saved Claude Code engine", () => {
    expect(
      resolveAgentEngineForRun("claude_code_local", { engine: "default" }),
    ).toBe("default");
  });

  it("uses the saved engine only when the spawn has no explicit selection", () => {
    expect(resolveAgentEngineForRun("codex_cli")).toBe("codex_cli");
  });

  it("lets an explicit external engine override the saved engine", () => {
    expect(
      resolveAgentEngineForRun("codex_cli", {
        engine: "claude_code_local",
        model: "opus",
      }),
    ).toBe("claude_code_local");
  });
});

describe("spawn_agent Stella reasoning clamping", () => {
  const model = (
    reasoning: boolean,
    thinkingLevelMap?: Model<any>["thinkingLevelMap"],
  ) => ({ reasoning, thinkingLevelMap }) as Model<any>;

  it("clamps to the nearest supported model effort", () => {
    const mediumHighOnly = model(true, {
      off: null,
      minimal: null,
      low: null,
      xhigh: null,
    });
    expect(resolveSpawnReasoningEffortForModel(mediumHighOnly, "low")).toBe(
      "medium",
    );
    expect(resolveSpawnReasoningEffortForModel(mediumHighOnly, "xhigh")).toBe(
      "high",
    );

    const lowXhighOnly = model(true, {
      off: null,
      minimal: null,
      medium: null,
      high: null,
      xhigh: "xhigh",
    });
    expect(resolveSpawnReasoningEffortForModel(lowXhighOnly, "medium")).toBe(
      "low",
    );
    expect(resolveSpawnReasoningEffortForModel(lowXhighOnly, "high")).toBe(
      "xhigh",
    );

    const lowHighOnly = model(true, {
      off: null,
      minimal: null,
      medium: null,
      xhigh: null,
    });
    expect(resolveSpawnReasoningEffortForModel(lowHighOnly, "medium")).toBe(
      "high",
    );
  });

  it("drops a spawn effort when the resolved model has no dial", () => {
    expect(
      resolveSpawnReasoningEffortForModel(model(false), "high"),
    ).toBeUndefined();
  });
});

describe("legacy manager-typed spawn model inheritance snapshots", () => {
  const stellaRoute = (id: string): ResolvedLlmRoute =>
    ({
      model: { id, provider: "stella" },
      route: "stella",
      getApiKey: () => "test-key",
    }) as ResolvedLlmRoute;

  it("pins an explicit Stella Orchestrator turn to its resolved model and effort", () => {
    expect(
      captureEffectiveModelConfig({
        stellaDataDir: "/tmp/stella-manager-inheritance",
        engine: "default",
        configuredModel: "stella/max",
        resolvedLlm: stellaRoute("openai/gpt-5.6-sol"),
        reasoningEffort: "xhigh",
      }),
    ).toEqual({
      engine: "default",
      routeModel: "stella/openai/gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
  });

  it("pins the concrete model selected by a saved/default Orchestrator route", () => {
    const resolvedDefault = stellaRoute("default");
    (
      resolvedDefault.model as ResolvedLlmRoute["model"] & {
        upstreamModelId?: string;
      }
    ).upstreamModelId = "muse-spark-1.1";
    resolvedDefault.toolPolicyModel = {
      id: "meta/muse-spark-1.1",
      provider: "meta",
      api: "openai-completions",
      name: "Muse Spark 1.1",
    };
    expect(
      captureEffectiveModelConfig({
        stellaDataDir: "/tmp/stella-manager-inheritance",
        engine: "default",
        resolvedLlm: resolvedDefault,
        reasoningEffort: "low",
      }),
    ).toEqual({
      engine: "default",
      routeModel: "stella/meta/muse-spark-1.1",
      reasoningEffort: "low",
    });
  });

  it("pins an explicit Codex Orchestrator engine model and effort", () => {
    expect(
      captureEffectiveModelConfig({
        stellaDataDir: "/tmp/stella-manager-inheritance",
        engine: "codex_cli",
        configuredModel: "stella/standard",
        engineModelOverride: "gpt-5.6-codex",
        resolvedLlm: stellaRoute("meta/muse-spark-1.1"),
        reasoningEffort: "high",
      }),
    ).toEqual({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
      routeModel: "chatgpt/gpt-5.6-codex",
      engineModel: "gpt-5.6-codex",
      reasoningEffort: "high",
      serviceTier: "standard",
    });
  });
});

describe("managed default spawn snapshots", () => {
  const stellaDefaultRoute = (): ResolvedLlmRoute => {
    const route = {
      model: { id: STELLA_DEFAULT_MODEL, provider: "stella" },
      route: "stella",
      getApiKey: () => "test-key",
    } as ResolvedLlmRoute;
    // Exactly what `/api/stella/models` answers for the sentinel: a gateway
    // routing id carrying the relay-provider prefix, not a selectable model.
    (
      route.model as ResolvedLlmRoute["model"] & { upstreamModelId?: string }
    ).upstreamModelId = "openrouter/deepseek/deepseek-v4.1-flash";
    route.toolPolicyModel = {
      id: "openrouter/deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
      api: "openai-completions",
      name: "deepseek/deepseek-v4.1-flash",
    };
    return route;
  };

  it("captures the managed default sentinel instead of the gateway routing id", () => {
    expect(
      captureEffectiveModelConfig({
        stellaDataDir: "/tmp/stella-managed-default",
        engine: "default",
        configuredModel: STELLA_DEFAULT_MODEL,
        resolvedLlm: stellaDefaultRoute(),
      }),
    ).toEqual({ engine: "default", routeModel: STELLA_DEFAULT_MODEL });
  });

  it("captures the same reference whether the model was omitted or given explicitly", () => {
    const omitted = captureEffectiveModelConfig({
      stellaDataDir: "/tmp/stella-managed-default",
      engine: "default",
      resolvedLlm: stellaDefaultRoute(),
    });
    const explicit = captureEffectiveModelConfig({
      stellaDataDir: "/tmp/stella-managed-default",
      engine: "default",
      configuredModel: STELLA_DEFAULT_MODEL,
      resolvedLlm: stellaDefaultRoute(),
    });
    expect(explicit).toEqual(omitted);
  });

  it("keeps a spawn reasoning effort while the model stays the default", () => {
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      expect(
        captureEffectiveModelConfig({
          stellaDataDir: "/tmp/stella-managed-default",
          engine: "default",
          configuredModel: STELLA_DEFAULT_MODEL,
          resolvedLlm: stellaDefaultRoute(),
          reasoningEffort: effort,
        }),
      ).toEqual({
        engine: "default",
        routeModel: STELLA_DEFAULT_MODEL,
        reasoningEffort: effort,
      });
    }
  });

  it("never double-prefixes a branded alias that resolves to itself offline", () => {
    const alias = {
      model: { id: "stella/light", provider: "stella" },
      route: "stella",
      getApiKey: () => "test-key",
    } as ResolvedLlmRoute;
    (
      alias.model as ResolvedLlmRoute["model"] & { upstreamModelId?: string }
    ).upstreamModelId = "stella/light";
    expect(
      captureEffectiveModelConfig({
        stellaDataDir: "/tmp/stella-managed-default",
        engine: "default",
        resolvedLlm: alias,
      }),
    ).toEqual({ engine: "default", routeModel: "stella/light" });
  });
});
