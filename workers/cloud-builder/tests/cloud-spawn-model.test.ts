import { describe, expect, test } from "bun:test";
import { isValidCloudSpawnModel } from "../src/cloud-spawn-model.js";

describe("isValidCloudSpawnModel", () => {
  test("accepts Claude context aliases and reasoning suffixes", () => {
    expect(isValidCloudSpawnModel("claude/claude-sonnet-4-6[1m]:high")).toBe(
      true,
    );
    expect(isValidCloudSpawnModel("claude:low")).toBe(true);
  });

  test("accepts Codex and Stella routes", () => {
    expect(isValidCloudSpawnModel("codex/gpt-5.6-sol:xhigh")).toBe(true);
    expect(
      isValidCloudSpawnModel("stella/anthropic/claude-sonnet-4.6:medium"),
    ).toBe(true);
  });

  test("rejects malformed or overlong model ids", () => {
    expect(isValidCloudSpawnModel("claude/model[2m]")).toBe(false);
    expect(isValidCloudSpawnModel(`codex/${"a".repeat(193)}`)).toBe(false);
    expect(isValidCloudSpawnModel("claude/model:default")).toBe(false);
  });
});
