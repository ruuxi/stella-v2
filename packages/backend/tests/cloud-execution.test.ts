import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
  DEFAULT_CLOUD_CODEX_EXECUTION,
  DEFAULT_CLOUD_EXECUTION,
  defaultCloudExecutionForEngine,
  normalizeCloudExecutionSelection,
} from "../convex/lib/cloud_execution";

describe("cloud execution defaults", () => {
  test("keeps the managed default opaque for server-side resolution", () => {
    expect(DEFAULT_CLOUD_EXECUTION).toEqual({
      engine: "stella",
      provider: "stella",
      model: "stella/default",
      reasoningEffort: "default",
    });
    expect(defaultCloudExecutionForEngine("stella")).toBe(
      DEFAULT_CLOUD_EXECUTION,
    );
    expect(normalizeCloudExecutionSelection(DEFAULT_CLOUD_EXECUTION)).toEqual(
      DEFAULT_CLOUD_EXECUTION,
    );
  });

  test("preserves the connected Anthropic and Codex defaults", () => {
    expect(defaultCloudExecutionForEngine("anthropic")).toBe(
      DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
    );
    expect(DEFAULT_CLOUD_ANTHROPIC_EXECUTION.model).toBe("claude-sonnet-4-6");

    expect(defaultCloudExecutionForEngine("openai-codex")).toBe(
      DEFAULT_CLOUD_CODEX_EXECUTION,
    );
    expect(DEFAULT_CLOUD_CODEX_EXECUTION.model).toBe("gpt-5.6-sol");
  });

  test("forces managed executions to the backend-owned effort", () => {
    expect(
      normalizeCloudExecutionSelection({
        engine: "stella",
        provider: "stella",
        model: "stella/meta/muse-spark-1.3-contributor",
        reasoningEffort: "low",
      }),
    ).toEqual({
      engine: "stella",
      provider: "stella",
      model: "stella/meta/muse-spark-1.3-contributor",
      reasoningEffort: "default",
    });

    expect(
      normalizeCloudExecutionSelection({
        ...DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
        reasoningEffort: "high",
      }).reasoningEffort,
    ).toBe("high");
  });
});
