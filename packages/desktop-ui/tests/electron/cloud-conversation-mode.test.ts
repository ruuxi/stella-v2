import { describe, expect, it } from "vitest";
import {
  requireMatchingCloudConversationId,
  selectedCloudConversationId,
  withCloudConversationStorage,
} from "@stella/desktop/electron/cloud-conversation-mode.js";
import { toggleRealtimeVoice } from "@stella/desktop/electron/services/realtime-voice-control.js";

const makeRealtimeVoiceDeps = (conversationId: string | null) => {
  let activatedWith: string | null = null;
  return {
    deps: {
      uiStateService: {
        state: { conversationId, isVoiceRtcActive: false },
        deactivateVoiceModes: () => true,
        activateVoiceRtc: (selected: string) => {
          activatedWith = selected;
        },
      },
    } as never,
    activatedWith: () => activatedWith,
  };
};

describe("desktop cloud conversation authority", () => {
  it("accepts only a non-empty renderer-selected cloud id", () => {
    expect(selectedCloudConversationId(" cloud-conversation ")).toBe(
      "cloud-conversation",
    );
    expect(selectedCloudConversationId("  ")).toBeNull();
    expect(selectedCloudConversationId(null)).toBeNull();
    expect(selectedCloudConversationId(undefined)).toBeNull();
  });

  it("normalizes a request for the currently selected conversation", () => {
    expect(
      requireMatchingCloudConversationId(
        " cloud-conversation ",
        "cloud-conversation",
      ),
    ).toBe("cloud-conversation");
  });

  it("fails closed when selection is missing or has changed", () => {
    expect(() =>
      requireMatchingCloudConversationId("old-conversation", null),
    ).toThrow("Select a cloud conversation");
    expect(() =>
      requireMatchingCloudConversationId(
        "old-conversation",
        "new-conversation",
      ),
    ).toThrow("active cloud conversation changed");
  });

  it("overrides legacy renderer storage requests without mutating the input", () => {
    const request = {
      conversationId: "conversation-1",
      userPrompt: "Hello",
      storageMode: "local" as const,
    };

    expect(withCloudConversationStorage(request)).toEqual({
      conversationId: "conversation-1",
      userPrompt: "Hello",
      storageMode: "cloud",
    });
    expect(request.storageMode).toBe("local");
  });

  it("does not activate realtime voice before cloud selection", () => {
    const setup = makeRealtimeVoiceDeps(null);
    toggleRealtimeVoice(setup.deps);
    expect(setup.activatedWith()).toBeNull();
  });

  it("activates realtime voice with the normalized selected cloud id", () => {
    const setup = makeRealtimeVoiceDeps(" cloud-conversation ");
    toggleRealtimeVoice(setup.deps);
    expect(setup.activatedWith()).toBe("cloud-conversation");
  });
});
