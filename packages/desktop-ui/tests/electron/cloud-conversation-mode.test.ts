import { describe, expect, it } from "vitest";
import {
  requireMatchingCloudConversationId,
  selectedCloudConversationId,
  withCloudConversationStorage,
} from "@stella/desktop/electron/cloud-conversation-mode.js";
import { togglePetVoice } from "@stella/desktop/electron/services/pet-voice-control.js";

const makePetVoiceDeps = (conversationId: string | null) => {
  let activatedWith: string | null = null;
  let petOpened = false;
  return {
    deps: {
      uiStateService: {
        state: { conversationId, isVoiceRtcActive: false },
        deactivateVoiceModes: () => true,
        activateVoiceRtc: (selected: string) => {
          activatedWith = selected;
        },
      },
      getPetController: () => ({
        isVisible: () => false,
        setOpen: (open: boolean) => {
          petOpened = open;
        },
      }),
      windowManager: { getAllWindows: () => [] },
    } as never,
    activatedWith: () => activatedWith,
    petOpened: () => petOpened,
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

  it("does not open or activate pet voice before cloud selection", () => {
    const setup = makePetVoiceDeps(null);
    togglePetVoice(setup.deps);
    expect(setup.activatedWith()).toBeNull();
    expect(setup.petOpened()).toBe(false);
  });

  it("activates pet voice with the normalized selected cloud id", () => {
    const setup = makePetVoiceDeps(" cloud-conversation ");
    togglePetVoice(setup.deps);
    expect(setup.activatedWith()).toBe("cloud-conversation");
    expect(setup.petOpened()).toBe(true);
  });
});
