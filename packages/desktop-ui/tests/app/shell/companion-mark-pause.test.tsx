// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const pausedProps: boolean[] = [];
vi.mock("@/ui/stella-character/StellaCharacter", () => ({
  StellaCharacter: ({ paused }: { paused?: boolean }) => {
    pausedProps.push(Boolean(paused));
    return null;
  },
}));

import { CompanionMarkRoot } from "@/shell/companion/CompanionMarkRoot";
import { UiStateProvider } from "@/context/ui-state";
import { withI18n } from "../../helpers/i18n";

describe("companion mark animation gate", () => {
  let container: HTMLDivElement;
  let root: Root;
  let emitVisible: ((payload: { visible: boolean }) => void) | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    pausedProps.length = 0;
    const unsubscribe = () => {};
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        ui: {
          getState: async () => ({
            mode: "chat",
            conversationId: null,
            isVoiceRtcActive: false,
          }),
          onState: () => unsubscribe,
          setState: async () => {},
        },
        companion: {
          onLayout: () => unsubscribe,
          onActivity: () => unsubscribe,
          hello: () => {},
          getState: async () => null,
          onState: () => unsubscribe,
          getVisible: async () => ({ visible: true }),
          onVisibleChanged: (listener: (payload: { visible: boolean }) => void) => {
            emitVisible = listener;
            return unsubscribe;
          },
          setHovered: () => {},
        },
      },
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it("pauses the mark while main reports the companion hidden", async () => {
    await act(async () => {
      root.render(
        withI18n(
          <UiStateProvider>
            <CompanionMarkRoot />
          </UiStateProvider>,
        ),
      );
    });
    // Companion windows disable background throttling, so the document stays
    // "visible" while hidden; main's broadcast is the only signal.
    expect(document.visibilityState).toBe("visible");
    expect(pausedProps.at(-1)).toBe(false);

    await act(async () => emitVisible?.({ visible: false }));
    expect(pausedProps.at(-1)).toBe(true);

    await act(async () => emitVisible?.({ visible: true }));
    expect(pausedProps.at(-1)).toBe(false);
  });
});
