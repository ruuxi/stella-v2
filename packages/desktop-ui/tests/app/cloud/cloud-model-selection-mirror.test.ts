import { describe, expect, it } from "vitest";
import {
  cloudExecutionFromLocal,
  localPatchForCloudExecution,
  type MirroredModelPreferences,
} from "@/features/cloud/cloud-model-selection-mirror";

const base = (
  overrides: Partial<MirroredModelPreferences> = {},
): MirroredModelPreferences => ({
  modelOverrides: {},
  stellaConversationModelOverrides: {},
  assistantPropagatedAgents: [],
  agentRuntimeEngine: "default",
  codexModel: "gpt-6-sol",
  claudeCodeModel: "default",
  reasoningEfforts: {},
  stellaConversationReasoningEfforts: {},
  codexReasoningEffort: "default",
  claudeCodeReasoningEffort: "default",
  ...overrides,
});

const apply = (
  preferences: MirroredModelPreferences,
  execution: Parameters<typeof localPatchForCloudExecution>[1],
): MirroredModelPreferences => ({
  ...preferences,
  ...localPatchForCloudExecution(preferences, execution),
});

describe("cloud model selection mirror", () => {
  it("maps each local engine to its server selection", () => {
    expect(cloudExecutionFromLocal(base())).toMatchObject({
      engine: "stella",
      model: "stella/default",
    });
    expect(
      cloudExecutionFromLocal(
        base({
          agentRuntimeEngine: "claude_code_local",
          claudeCodeModel: "opus",
          claudeCodeReasoningEffort: "high",
        }),
      ),
    ).toEqual({
      engine: "anthropic",
      provider: "anthropic",
      model: "opus",
      reasoningEffort: "high",
    });
    expect(
      cloudExecutionFromLocal(
        base({ agentRuntimeEngine: "codex_cli", codexModel: "gpt-6-luna" }),
      ),
    ).toMatchObject({ engine: "openai-codex", model: "gpt-6-luna" });
  });

  it("leaves bring-your-own-key picks local", () => {
    expect(
      cloudExecutionFromLocal(
        base({ modelOverrides: { general: "anthropic/claude-opus-5-5" } }),
      ),
    ).toBeNull();
  });

  it("round-trips server selections through local preferences", () => {
    const selections = [
      {
        engine: "anthropic",
        provider: "anthropic",
        model: "fable",
        reasoningEffort: "xhigh",
      },
      {
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-6-astra",
        reasoningEffort: "low",
      },
      {
        engine: "stella",
        provider: "stella",
        model: "stella/anthropic/claude-sonnet-4.6",
        reasoningEffort: "default",
      },
      {
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      },
    ] as const;
    let preferences = base();
    for (const selection of selections) {
      preferences = apply(preferences, selection);
      expect(cloudExecutionFromLocal(preferences)).toEqual(selection);
    }
  });

  it("routes Codex conversation agents through the ChatGPT provider", () => {
    const next = apply(base(), {
      engine: "openai-codex",
      provider: "openai-codex",
      model: "gpt-6-sol",
      reasoningEffort: "default",
    });
    expect(next.agentRuntimeEngine).toBe("codex_cli");
    expect(next.modelOverrides.orchestrator).toBe("openai-codex/gpt-6-sol");
  });
});
