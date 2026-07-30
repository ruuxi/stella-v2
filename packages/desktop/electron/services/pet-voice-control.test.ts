import { describe, expect, test } from "bun:test";
import { togglePetVoice } from "./pet-voice-control.js";

const makeDeps = (conversationId: string | null) => {
  let activatedWith: string | null = null;
  let petOpened = false;
  const uiStateService = {
    state: {
      conversationId,
      isVoiceRtcActive: false,
    },
    deactivateVoiceModes: () => true,
    activateVoiceRtc: (selected: string) => {
      activatedWith = selected;
    },
  };
  const pet = {
    isVisible: () => false,
    setOpen: (open: boolean) => {
      petOpened = open;
    },
  };
  const windowManager = {
    getAllWindows: () => [],
  };
  return {
    deps: {
      uiStateService,
      getPetController: () => pet,
      windowManager,
    } as never,
    activatedWith: () => activatedWith,
    petOpened: () => petOpened,
  };
};

describe("pet voice cloud conversation gate", () => {
  test("does not activate or open voice without a cloud selection", () => {
    const setup = makeDeps(null);
    togglePetVoice(setup.deps);
    expect(setup.activatedWith()).toBeNull();
    expect(setup.petOpened()).toBe(false);
  });

  test("activates voice with the selected cloud conversation", () => {
    const setup = makeDeps(" cloud-conversation ");
    togglePetVoice(setup.deps);
    expect(setup.activatedWith()).toBe("cloud-conversation");
    expect(setup.petOpened()).toBe(true);
  });
});
