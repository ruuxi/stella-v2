import { afterEach, describe, expect, test } from "bun:test";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  getCloudExecutionSelectionSnapshot,
  publishCloudExecutionSelection,
  reconcileCloudExecutionSelection,
  resetCloudExecutionSelectionForTests,
  subscribeCloudExecutionSelection,
} from "../src/features/cloud/cloud-execution-store";

const SELECTED: CloudExecutionSelection = {
  engine: "openai-codex",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
};

afterEach(() => {
  resetCloudExecutionSelectionForTests();
});

describe("cloud execution selection bridge", () => {
  test("keeps the successful local selection until the query catches up", () => {
    publishCloudExecutionSelection(SELECTED);

    reconcileCloudExecutionSelection({
      engine: "stella",
      provider: "stella",
      model: "stella/standard",
      reasoningEffort: "default",
    });
    expect(getCloudExecutionSelectionSnapshot()).toEqual(SELECTED);

    reconcileCloudExecutionSelection(SELECTED);
    expect(getCloudExecutionSelectionSnapshot()).toBeNull();
  });

  test("notifies turn consumers immediately", () => {
    let calls = 0;
    const unsubscribe = subscribeCloudExecutionSelection(() => {
      calls += 1;
    });

    publishCloudExecutionSelection(SELECTED);

    expect(calls).toBe(1);
    expect(getCloudExecutionSelectionSnapshot()).toEqual(SELECTED);
    unsubscribe();
  });
});
