import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
  DEFAULT_CLOUD_CODEX_EXECUTION,
  DEFAULT_CLOUD_EXECUTION,
  defaultCloudExecutionForEngine,
  normalizeCloudExecutionSelection,
  type CloudExecutionSelectionInput,
} from "../convex/lib/cloud_execution";

describe("cloud execution selection", () => {
  test("normalizes canonical managed and connected routes", () => {
    assert.deepEqual(
      normalizeCloudExecutionSelection({
        engine: "stella",
        provider: "stella",
        model: "  stella/openai/gpt-5.6-sol  ",
        reasoningEffort: "high",
      }),
      {
        engine: "stella",
        provider: "stella",
        model: "stella/openai/gpt-5.6-sol",
        reasoningEffort: "high",
      },
    );
    assert.deepEqual(
      normalizeCloudExecutionSelection(DEFAULT_CLOUD_ANTHROPIC_EXECUTION),
      DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
    );
    assert.deepEqual(
      normalizeCloudExecutionSelection(DEFAULT_CLOUD_CODEX_EXECUTION),
      DEFAULT_CLOUD_CODEX_EXECUTION,
    );
    assert.deepEqual(
      normalizeCloudExecutionSelection({
        engine: "anthropic",
        provider: "anthropic",
        model: "sonnet[1m]",
        reasoningEffort: "default",
      }),
      {
        engine: "anthropic",
        provider: "anthropic",
        model: "sonnet[1m]",
        reasoningEffort: "default",
      },
    );
  });

  test("rejects mismatched engine and provider capabilities", () => {
    assert.throws(
      () =>
        normalizeCloudExecutionSelection({
          engine: "stella",
          provider: "anthropic",
          model: "stella/anthropic/claude-sonnet-4.6",
          reasoningEffort: "default",
        } satisfies CloudExecutionSelectionInput),
      /must identify the same route/,
    );
  });

  test("rejects managed/native model namespace confusion", () => {
    assert.throws(
      () =>
        normalizeCloudExecutionSelection({
          engine: "stella",
          provider: "stella",
          model: "claude-sonnet-4-6",
          reasoningEffort: "medium",
        }),
      /requires a canonical "stella\/\.\.\."/,
    );
    assert.throws(
      () =>
        normalizeCloudExecutionSelection({
          engine: "anthropic",
          provider: "anthropic",
          model: "stella/anthropic/claude-sonnet-4.6",
          reasoningEffort: "medium",
        }),
      /engine-native model id/,
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
