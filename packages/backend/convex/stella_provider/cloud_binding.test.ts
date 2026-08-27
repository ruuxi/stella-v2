import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  LEGACY_CLOUD_EXECUTOR_MODEL,
  validateConnectedCloudBinding,
  validateManagedCloudBinding,
  validateManagedReasoningBinding,
} from "./cloud_binding";

describe("cloud relay turn binding", () => {
  test("accepts only the connected engine and native model stored on the turn", () => {
    const execution = {
      engine: "openai-codex",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    } as const;
    assert.deepEqual(
      validateConnectedCloudBinding({
        execution,
        credentialProvider: "openai-codex",
        requestedModel: "gpt-5.6-sol",
        requestPathname: "/api/stella/relay/responses",
        requestJson: {
          model: "gpt-5.6-sol",
          reasoning: { effort: "high" },
        },
      }),
      {
        ok: true,
        nativeModel: "gpt-5.6-sol",
        requestKind: "codex_responses",
      },
    );
    assert.equal(
      validateConnectedCloudBinding({
        execution,
        credentialProvider: "anthropic",
        requestedModel: "stella/anthropic/claude-opus-4-6",
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson: {
          output_config: { effort: "high" },
          thinking: { type: "adaptive" },
        },
      }).ok,
      false,
    );
    assert.equal(
      validateConnectedCloudBinding({
        execution,
        credentialProvider: "openai-codex",
        requestedModel: "stella/openai-codex/gpt-5.6-luna",
        requestPathname: "/api/stella/relay/responses",
        requestJson: { reasoning: { effort: "high" } },
      }).ok,
      false,
    );
  });

  test("requires execution metadata for connected credentials", () => {
    const result = validateConnectedCloudBinding({
      credentialProvider: "anthropic",
      requestedModel: "stella/anthropic/claude-sonnet-4-6",
      requestPathname: "/api/stella/relay/v1/messages",
      requestJson: {
        output_config: { effort: "medium" },
        thinking: { type: "adaptive" },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.status, 403);
  });

  test("rejects native path and explicit reasoning mismatches", () => {
    const execution = {
      engine: "anthropic",
      provider: "anthropic",
      model: "claude-opus-4-6",
      reasoningEffort: "xhigh",
    } as const;
    assert.equal(
      validateConnectedCloudBinding({
        execution,
        credentialProvider: "anthropic",
        requestedModel: execution.model,
        requestPathname: "/api/stella/relay/responses",
        requestJson: {
          output_config: { effort: "max" },
          thinking: { type: "adaptive" },
        },
      }).ok,
      false,
    );
    assert.equal(
      validateConnectedCloudBinding({
        execution,
        credentialProvider: "anthropic",
        requestedModel: execution.model,
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson: {
          output_config: { effort: "high" },
          thinking: { type: "adaptive" },
        },
      }).ok,
      false,
    );
    assert.equal(
      validateConnectedCloudBinding({
        execution,
        credentialProvider: "anthropic",
        requestedModel: execution.model,
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson: {
          output_config: { effort: "max" },
          thinking: { type: "adaptive" },
        },
      }).ok,
      true,
    );
  });

  test("accepts bounded legacy Claude budgets and rejects budget escalation", () => {
    const execution = {
      engine: "anthropic",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      reasoningEffort: "low",
    } as const;
    const base = {
      execution,
      credentialProvider: "anthropic" as const,
      requestedModel: execution.model,
      requestPathname: "/api/stella/relay/v1/messages",
    };
    assert.equal(
      validateConnectedCloudBinding({
        ...base,
        requestJson: {
          thinking: { type: "enabled", budget_tokens: 2_048 },
        },
      }).ok,
      true,
    );
    assert.equal(
      validateConnectedCloudBinding({
        ...base,
        requestJson: {
          thinking: { type: "enabled", budget_tokens: 16_384 },
        },
      }).ok,
      false,
    );
    assert.equal(
      validateConnectedCloudBinding({
        ...base,
        requestJson: {
          thinking: { type: "enabled", budget_tokens: 2_048 },
          output_config: { effort: "low" },
        },
      }).ok,
      false,
    );
  });

  test("allows mandatory-adaptive Claude models to omit disabled thinking", () => {
    const execution = {
      engine: "anthropic",
      provider: "anthropic",
      model: "claude-fable-5",
      reasoningEffort: "none",
    } as const;
    assert.equal(
      validateConnectedCloudBinding({
        execution,
        credentialProvider: "anthropic",
        requestedModel: execution.model,
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson: {},
      }).ok,
      true,
    );
    assert.equal(
      validateConnectedCloudBinding({
        execution,
        credentialProvider: "anthropic",
        requestedModel: execution.model,
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson: { thinking: { type: "adaptive" } },
      }).ok,
      false,
    );
  });

  test("binds explicit thinking-off and leaves native defaults to the CLI", () => {
    const noneExecution = {
      engine: "anthropic",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      reasoningEffort: "none",
    } as const;
    assert.equal(
      validateConnectedCloudBinding({
        execution: noneExecution,
        credentialProvider: "anthropic",
        requestedModel: noneExecution.model,
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson: { model: noneExecution.model },
      }).ok,
      true,
    );
    assert.equal(
      validateConnectedCloudBinding({
        execution: noneExecution,
        credentialProvider: "anthropic",
        requestedModel: noneExecution.model,
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson: {
          output_config: { effort: "low" },
          thinking: { type: "adaptive" },
        },
      }).ok,
      false,
    );

    const defaultExecution = {
      engine: "openai-codex",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "default",
    } as const;
    assert.equal(
      validateConnectedCloudBinding({
        execution: defaultExecution,
        credentialProvider: "openai-codex",
        requestedModel: defaultExecution.model,
        requestPathname: "/api/stella/relay/responses",
        requestJson: {
          reasoning: { effort: "high" },
        },
      }).ok,
      true,
    );
  });

  test("accepts native utility paths without widening the engine route", () => {
    const anthropicExecution = {
      engine: "anthropic",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      reasoningEffort: "default",
    } as const;
    const countTokens = validateConnectedCloudBinding({
      execution: anthropicExecution,
      credentialProvider: "anthropic",
      requestedModel: anthropicExecution.model,
      requestPathname: "/api/stella/relay/v1/messages/count_tokens",
      requestJson: { model: anthropicExecution.model },
    });
    assert.deepEqual(countTokens, {
      ok: true,
      nativeModel: anthropicExecution.model,
      requestKind: "anthropic_count_tokens",
    });

    const codexExecution = {
      engine: "openai-codex",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    } as const;
    const compact = validateConnectedCloudBinding({
      execution: codexExecution,
      credentialProvider: "openai-codex",
      requestedModel: codexExecution.model,
      requestPathname: "/api/stella/relay/responses/compact",
      requestJson: { reasoning: { effort: "high" } },
    });
    assert.equal(compact.ok, true);
  });

  test("family-binds Claude aliases while keeping full model ids exact", () => {
    const requestJson = {
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
    };
    const aliasExecution = {
      engine: "anthropic",
      provider: "anthropic",
      model: "opus",
      reasoningEffort: "high",
    } as const;
    assert.equal(
      validateConnectedCloudBinding({
        execution: aliasExecution,
        credentialProvider: "anthropic",
        requestedModel: "claude-opus-4-8",
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson,
      }).ok,
      true,
    );
    assert.equal(
      validateConnectedCloudBinding({
        execution: aliasExecution,
        credentialProvider: "anthropic",
        requestedModel: "claude-sonnet-4-8",
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson,
      }).ok,
      false,
    );

    const exactExecution = {
      ...aliasExecution,
      model: "claude-opus-4-8",
    } as const;
    assert.equal(
      validateConnectedCloudBinding({
        execution: exactExecution,
        credentialProvider: "anthropic",
        requestedModel: "claude-opus-4-9",
        requestPathname: "/api/stella/relay/v1/messages",
        requestJson,
      }).ok,
      false,
    );
  });

  test("requires the context beta when resolving a 1m Claude alias", () => {
    const execution = {
      engine: "anthropic",
      provider: "anthropic",
      model: "sonnet[1m]",
      reasoningEffort: "default",
    } as const;
    const base = {
      execution,
      credentialProvider: "anthropic" as const,
      requestedModel: "claude-sonnet-4-8",
      requestPathname: "/api/stella/relay/v1/messages",
      requestJson: {},
    };
    assert.equal(validateConnectedCloudBinding(base).ok, false);
    assert.equal(
      validateConnectedCloudBinding({
        ...base,
        anthropicBeta: "oauth-2025-04-20,context-1m-2025-08-07",
      }).ok,
      true,
    );

    const fullModelSelection = {
      ...execution,
      model: "claude-opus-4-8[1m]",
    } as const;
    assert.equal(
      validateConnectedCloudBinding({
        ...base,
        execution: fullModelSelection,
        requestedModel: "claude-opus-4-8",
        anthropicBeta: "context-1m-2025-08-07",
      }).ok,
      true,
    );
    assert.equal(
      validateConnectedCloudBinding({
        ...base,
        execution: fullModelSelection,
        requestedModel: "claude-opus-4-9",
        anthropicBeta: "context-1m-2025-08-07",
      }).ok,
      false,
    );
  });

  test("binds managed requests and narrowly preserves legacy turn tokens", () => {
    const execution = {
      engine: "stella",
      provider: "stella",
      model: "stella/openai/gpt-5.6-sol",
      reasoningEffort: "xhigh",
    } as const;
    assert.equal(
      validateManagedCloudBinding({
        execution,
        viaTurnToken: true,
        requestedModel: execution.model,
      }),
      null,
    );
    assert.equal(
      validateManagedCloudBinding({
        execution,
        viaTurnToken: true,
        requestedModel: "stella/openai/gpt-5.6-luna",
      })?.status,
      403,
    );
    assert.equal(
      validateManagedCloudBinding({
        viaTurnToken: true,
        requestedModel: LEGACY_CLOUD_EXECUTOR_MODEL,
      }),
      null,
    );
    assert.equal(
      validateManagedCloudBinding({
        viaTurnToken: true,
        requestedModel: "stella/default",
      })?.status,
      403,
    );
  });

  test("accepts runtime-clamped managed effort forms at or below the selected ceiling", () => {
    const cases = [
      {
        effort: "xhigh",
        relayProvider: "crof",
        resolvedModel: "crof/deepseek-v4-flash-0731",
        requestJson: { reasoning_effort: "high" },
      },
      {
        effort: "medium",
        relayProvider: "deepseek",
        resolvedModel: "deepseek/deepseek-v4-flash",
        requestJson: { reasoning: { effort: "high" } },
      },
      {
        effort: "minimal",
        relayProvider: "deepseek",
        resolvedModel: "deepseek/deepseek-v4-flash",
        requestJson: { reasoning: { effort: "low" } },
      },
      {
        effort: "minimal",
        relayProvider: "crof",
        resolvedModel: "crof/deepseek-v4-flash-0731",
        requestJson: { reasoning_effort: "low" },
      },
      {
        effort: "minimal",
        relayProvider: "wafer",
        resolvedModel: "wafer/deepseek-v4-flash-0731-fast",
        requestJson: { reasoning_effort: "low" },
      },
      {
        effort: "minimal",
        relayProvider: "google",
        resolvedModel: "google/gemini-3.1-pro",
        requestJson: {
          generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
        },
      },
      {
        effort: "medium",
        relayProvider: "google",
        resolvedModel: "google/gemini-3.1-pro",
        requestJson: {
          generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
        },
      },
      {
        effort: "none",
        relayProvider: "google",
        resolvedModel: "google/gemini-3.1-pro",
        requestJson: {
          generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
        },
      },
      {
        effort: "none",
        relayProvider: "google",
        resolvedModel: "google/gemini-3.1-flash",
        requestJson: {
          generationConfig: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
        },
      },
      {
        effort: "minimal",
        relayProvider: "google",
        resolvedModel: "google/gemini-2.5-flash-lite",
        requestJson: {
          generationConfig: { thinkingConfig: { thinkingBudget: 512 } },
        },
      },
      {
        effort: "none",
        relayProvider: "google",
        resolvedModel: "google/gemini-2.0-pro",
        requestJson: {
          generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
        },
      },
      {
        effort: "none",
        relayProvider: "xai",
        resolvedModel: "x-ai/grok-4.5",
        requestJson: { reasoning: { effort: "low" } },
      },
      {
        effort: "none",
        relayProvider: "openrouter",
        resolvedModel: "meta/muse-spark-1.2-contributor",
        requestJson: { reasoning: { effort: "low" } },
      },
      {
        effort: "high",
        relayProvider: "google",
        resolvedModel: "google/gemini-2.0-pro",
        requestJson: {
          generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
        },
      },
      {
        effort: "low",
        relayProvider: "anthropic",
        resolvedModel: "anthropic/claude-sonnet-4-5",
        requestJson: {
          thinking: { type: "enabled", budget_tokens: 2_048 },
        },
      },
    ] as const;
    for (const testCase of cases) {
      assert.equal(
        validateManagedReasoningBinding({
          execution: {
            engine: "stella",
            provider: "stella",
            model: "stella/default",
            reasoningEffort: testCase.effort,
          },
          relayProvider: testCase.relayProvider,
          resolvedModel: testCase.resolvedModel,
          reasoningCapable: true,
          requestJson: testCase.requestJson,
        }),
        null,
      );
    }
    assert.equal(
      validateManagedReasoningBinding({
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/non-reasoning",
          reasoningEffort: "default",
        },
        relayProvider: "openai",
        resolvedModel: "openai/non-reasoning",
        reasoningCapable: false,
        requestJson: {},
      }),
      null,
    );
  });

  test("rejects managed effort escalation and ambiguous enabled controls", () => {
    const base = {
      execution: {
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      } as const,
      relayProvider: "openai" as const,
      resolvedModel: "openai/reasoning-model",
      reasoningCapable: true,
    };
    for (const requestJson of [
      { reasoning: { effort: "xhigh" } },
      { reasoning_effort: "high" },
    ]) {
      assert.equal(
        validateManagedReasoningBinding({ ...base, requestJson })?.status,
        403,
      );
    }
    for (const requestJson of [
      { reasoning: { summary: "auto" } },
      { thinking: { type: "enabled" } },
    ]) {
      assert.equal(
        validateManagedReasoningBinding({
          ...base,
          execution: { ...base.execution, reasoningEffort: "none" },
          reasoningCapable: false,
          requestJson,
        })?.status,
        403,
      );
    }
    assert.equal(
      validateManagedReasoningBinding({
        ...base,
        execution: { ...base.execution, reasoningEffort: "none" },
        relayProvider: "google",
        resolvedModel: "google/gemini-2.5-pro",
        requestJson: {
          generationConfig: { thinkingConfig: { includeThoughts: true } },
        },
      })?.status,
      403,
    );
    assert.equal(
      validateManagedReasoningBinding({
        ...base,
        execution: { ...base.execution, reasoningEffort: "none" },
        resolvedModel: "openai/gpt-5.5",
        requestJson: { reasoning: { effort: "minimal" } },
      })?.status,
      403,
    );
    assert.equal(
      validateManagedReasoningBinding({
        ...base,
        execution: { ...base.execution, reasoningEffort: "none" },
        relayProvider: "deepseek",
        resolvedModel: "deepseek/deepseek-v4-flash",
        requestJson: {},
      })?.status,
      403,
    );
  });
});
