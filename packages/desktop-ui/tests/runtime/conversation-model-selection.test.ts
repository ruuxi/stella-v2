import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_MODEL_SELECTIONS_STORAGE_KEY,
  conversationModelSelections,
  modelSelectionsEqual,
  pickModelSelection,
} from "@/features/chat/services/conversation-model-selection";
import { uiState } from "@/platform/ui-state";

const conversationId = (suffix: string): string => `${"0".repeat(25)}${suffix}`;

const stellaSelection = {
  agentRuntimeEngine: "default",
  modelOverrides: { orchestrator: "stella/composer", general: "stella/composer" },
};

const codexSelection = {
  agentRuntimeEngine: "codex_cli",
  codexModel: "gpt-5.4",
  codexModelExplicit: true,
  modelOverrides: {
    orchestrator: "openai-codex/gpt-5.4",
    general: "openai-codex/gpt-5.4",
  },
};

describe("conversationModelSelections", () => {
  beforeEach(() => {
    conversationModelSelections.reset();
  });

  afterEach(() => {
    conversationModelSelections.reset();
  });

  it("picks only the routing subset, including the engine dimension", () => {
    expect(
      pickModelSelection({
        ...codexSelection,
        memoryEnabled: true,
        maxAgentConcurrency: 8,
      }),
    ).toEqual(codexSelection);
    expect(pickModelSelection(null)).toBeNull();
    expect(modelSelectionsEqual(codexSelection, { ...codexSelection })).toBe(
      true,
    );
    expect(modelSelectionsEqual(stellaSelection, codexSelection)).toBe(false);
  });

  it("persists a conversation's pick independently of the open-tab prune helper", () => {
    const first = conversationId("A");
    const second = conversationId("B");
    conversationModelSelections.set(first, stellaSelection);
    conversationModelSelections.set(second, codexSelection);

    conversationModelSelections.pruneToOpenConversations(new Set([second]));
    expect(conversationModelSelections.get(first)).toBeNull();
    expect(conversationModelSelections.get(second)).toEqual(codexSelection);

    conversationModelSelections.set(first, stellaSelection);
    expect(conversationModelSelections.get(first)).toEqual(stellaSelection);
    expect(
      JSON.parse(uiState.getItem(CONVERSATION_MODEL_SELECTIONS_STORAGE_KEY)!),
    ).toMatchObject({
      version: 1,
      selections: {
        [first]: stellaSelection,
        [second]: codexSelection,
      },
    });
  });

  it("drops a snapshot only on explicit delete", () => {
    const first = conversationId("A");
    conversationModelSelections.set(first, stellaSelection);
    conversationModelSelections.delete(first);
    expect(conversationModelSelections.get(first)).toBeNull();
  });
});
