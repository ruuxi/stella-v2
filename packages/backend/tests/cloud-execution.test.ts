import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
  normalizeCloudExecutionSelection,
} from "../convex/lib/cloud_execution";

describe("cloud execution defaults", () => {
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
