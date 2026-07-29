import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
  DEFAULT_CLOUD_CODEX_EXECUTION,
  DEFAULT_CLOUD_EXECUTION,
  defaultCloudExecutionForEngine,
  normalizeCloudExecutionSelection,
} from "./cloud_execution";

describe("cloud execution selection", () => {
  test("normalizes canonical managed and connected routes", () => {
    assert.deepEqual(
      normalizeCloudExecutionSelection({
        engine: "stella",
        provider: "stella",
        model: " stella/standard ",
        reasoningEffort: "high",
      }),
      {
        engine: "stella",
        provider: "stella",
        model: "stella/standard",
        reasoningEffort: "high",
      },
    );
    assert.deepEqual(
      normalizeCloudExecutionSelection({
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      }),
      {
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    );
    assert.deepEqual(
      normalizeCloudExecutionSelection({
        engine: "anthropic",
        provider: "anthropic",
        model: "opus[1m]",
        reasoningEffort: "high",
      }),
      {
        engine: "anthropic",
        provider: "anthropic",
        model: "opus[1m]",
        reasoningEffort: "high",
      },
    );
  });

  test("rejects mismatched engine and provider capabilities", () => {
    assert.throws(
      () =>
        normalizeCloudExecutionSelection({
          engine: "anthropic",
          provider: "openai-codex",
          model: "claude-sonnet-4-6",
          reasoningEffort: "default",
        }),
      /same route/,
    );
  });

  test("rejects managed and native model namespace confusion", () => {
    assert.throws(
      () =>
        normalizeCloudExecutionSelection({
          engine: "stella",
          provider: "stella",
          model: "claude-sonnet-4-6",
          reasoningEffort: "default",
        }),
      /requires a canonical "stella\/\.\.\."/,
    );
    assert.throws(
      () =>
        normalizeCloudExecutionSelection({
          engine: "anthropic",
          provider: "anthropic",
          model: "stella/anthropic/claude-sonnet-4.6",
          reasoningEffort: "default",
        }),
      /engine-native/,
    );
    assert.throws(
      () =>
        normalizeCloudExecutionSelection({
          engine: "openai-codex",
          provider: "openai-codex",
          model: "gpt-5.6-sol[1m]",
          reasoningEffort: "default",
        }),
      /canonical model id/,
    );
  });

  test("has deterministic legacy defaults for every engine", () => {
    assert.deepEqual(
      defaultCloudExecutionForEngine("stella"),
      DEFAULT_CLOUD_EXECUTION,
    );
    assert.deepEqual(
      defaultCloudExecutionForEngine("anthropic"),
      DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
    );
    assert.deepEqual(
      defaultCloudExecutionForEngine("openai-codex"),
      DEFAULT_CLOUD_CODEX_EXECUTION,
    );
  });
});
