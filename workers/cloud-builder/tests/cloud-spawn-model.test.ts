import { describe, expect, test } from "bun:test";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { STELLA_DEFAULT_MODEL } from "@stella/contracts/stella-api";
import { isListedStellaModel } from "@stella/model-catalog/aliases";
import {
  isValidCloudSpawnModel,
  resolveCloudSpawnExecution,
} from "../src/cloud-spawn-model.js";

describe("isValidCloudSpawnModel", () => {
  test("accepts Claude context aliases and reasoning suffixes", () => {
    expect(isValidCloudSpawnModel("claude/claude-sonnet-4-6[1m]:high")).toBe(
      true,
    );
    expect(isValidCloudSpawnModel("claude:low")).toBe(true);
  });

  test("accepts Codex and Stella routes", () => {
    expect(isValidCloudSpawnModel("codex/gpt-5.6-sol:xhigh")).toBe(true);
    expect(isValidCloudSpawnModel("stella/default:medium")).toBe(true);
  });

  test("rejects malformed or overlong model ids", () => {
    expect(isValidCloudSpawnModel("claude/model[2m]")).toBe(false);
    expect(isValidCloudSpawnModel(`codex/${"a".repeat(193)}`)).toBe(false);
    expect(isValidCloudSpawnModel("claude/model:default")).toBe(false);
  });
});

describe("resolveCloudSpawnExecution managed default", () => {
  const inherited: CloudExecutionSelection = {
    engine: "anthropic",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    reasoningEffort: "default",
  };

  test("routes the sentinel to the managed lane on a model the gateway lists", () => {
    const execution = resolveCloudSpawnExecution(
      STELLA_DEFAULT_MODEL,
      inherited,
    );
    expect(execution).toEqual({
      engine: "stella",
      provider: "stella",
      model: STELLA_DEFAULT_MODEL,
      reasoningEffort: "default",
    });
    expect(isListedStellaModel(execution.model)).toBe(true);
  });

  test("honors a reasoning suffix while the model stays the default", () => {
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const execution = resolveCloudSpawnExecution(
        `${STELLA_DEFAULT_MODEL}:${effort}`,
        inherited,
      );
      expect(execution).toEqual({
        engine: "stella",
        provider: "stella",
        model: STELLA_DEFAULT_MODEL,
        reasoningEffort: effort,
      });
      expect(isListedStellaModel(execution.model)).toBe(true);
    }
  });

  test("keeps the bare sentinel inheriting the parent execution", () => {
    expect(resolveCloudSpawnExecution("default", inherited)).toEqual(inherited);
    expect(resolveCloudSpawnExecution(undefined, inherited)).toEqual(inherited);
  });
});
