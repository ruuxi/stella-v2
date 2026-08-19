// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationModelSelections } from "@/features/chat/services/conversation-model-selection";
import { useConversationModelSelection } from "@/shell/use-conversation-model-selection";

const conversationId = (suffix: string): string => `${"0".repeat(25)}${suffix}`;

const stellaSelection = {
  agentRuntimeEngine: "default" as const,
  modelOverrides: { orchestrator: "stella/composer", general: "stella/composer" },
};

const claudeSelection = {
  agentRuntimeEngine: "claude_code_local" as const,
  claudeCodeModel: "opus",
  claudeCodeReasoningEffort: "high" as const,
};

function Harness({
  conversationId: activeConversationId,
}: {
  conversationId: string | null;
}) {
  useConversationModelSelection({
    activeConversationId,
    enabled: true,
  });
  return null;
}

describe("useConversationModelSelection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let preferences: Record<string, unknown>;
  const setLocalModelPreferences = vi.fn(async (patch: Record<string, unknown>) => {
    preferences = { ...preferences, ...patch };
    return preferences;
  });

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    conversationModelSelections.reset();
    preferences = { ...stellaSelection };
    setLocalModelPreferences.mockClear();
    window.electronAPI = {
      system: {
        getLocalModelPreferences: async () => preferences,
        setLocalModelPreferences,
      },
    } as never;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    conversationModelSelections.reset();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  const render = async (id: string | null) => {
    await act(async () => {
      root.render(<Harness conversationId={id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("restores a conversation's engine/model when switching or replacing tabs", async () => {
    const first = conversationId("A");
    const second = conversationId("B");
    conversationModelSelections.set(second, claudeSelection);

    await render(first);
    expect(conversationModelSelections.get(first)).toEqual(stellaSelection);
    expect(setLocalModelPreferences).not.toHaveBeenCalled();

    preferences = { ...stellaSelection };
    await render(second);
    expect(setLocalModelPreferences).toHaveBeenCalledWith(claudeSelection);
    expect(conversationModelSelections.get(first)).toEqual(stellaSelection);
    expect(preferences.agentRuntimeEngine).toBe("claude_code_local");

    await render(first);
    expect(setLocalModelPreferences).toHaveBeenLastCalledWith(stellaSelection);
  });

  it("does not stamp a picker change onto a tab that just became active", async () => {
    const first = conversationId("A");
    const second = conversationId("B");
    conversationModelSelections.set(second, claudeSelection);
    await render(first);

    preferences = { ...stellaSelection };
    await act(async () => {
      root.render(<Harness conversationId={second} />);
      window.dispatchEvent(
        new CustomEvent("stella:local-model-preferences-changed"),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(conversationModelSelections.get(second)).toEqual(claudeSelection);
    expect(conversationModelSelections.get(first)).toEqual(stellaSelection);
  });
});
