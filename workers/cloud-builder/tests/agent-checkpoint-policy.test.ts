import { describe, expect, test } from "bun:test";
import { shouldCreateAgentCheckpoint } from "../src/agent-checkpoint-policy.js";

describe("agent checkpoint policy", () => {
  test("preserves the prior descriptor after a pre-agent hydration failure", () => {
    expect(
      shouldCreateAgentCheckpoint({ checkpointPolicy: "preserve_prior" }),
    ).toBe(false);
  });

  test("keeps partial agent work for ordinary terminal failures", () => {
    expect(shouldCreateAgentCheckpoint({})).toBe(true);
  });
});
