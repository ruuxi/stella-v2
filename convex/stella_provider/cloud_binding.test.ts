import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  LEGACY_CLOUD_EXECUTOR_MODEL,
  validateConnectedCloudBinding,
  validateManagedCloudBinding,
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
});
