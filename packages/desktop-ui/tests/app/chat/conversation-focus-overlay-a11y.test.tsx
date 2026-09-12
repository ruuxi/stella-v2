// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withI18n } from "../../helpers/i18n";

/**
 * The lineage overlay is a dialog that deliberately is NOT `aria-modal`:
 * the shared composer underneath stays usable, which is the whole point of
 * the surface. So these pin the half it does owe a keyboard user — a named
 * dialog, focus landing on the close button, Escape closing it, and the
 * opener getting focus back — plus the fact that the page behind is left
 * alone.
 */

vi.mock("@/app/chat/ConversationEvents", () => ({
  ConversationEvents: () => <div data-testid="events" />,
}));

vi.mock("@/shell/use-chat-scroll-management", () => ({
  useChatScrollManagement: () => ({ listRef: { current: null } }),
}));

vi.mock("@/features/chat/services/lineage-messages-store", () => ({
  useLineageMessages: () => ({
    messages: [],
    hasOlder: false,
    isLoadingOlder: false,
    hasLoaded: true,
    error: null,
    loadOlder: () => {},
  }),
}));

vi.mock("@/features/chat/hooks/use-thread-activity-records", () => ({
  useThreadActivityRecords: () => new Map(),
}));

import { ConversationFocusOverlay } from "@/app/chat/ConversationFocusOverlay";
import {
  closeConversationFocus,
  openConversationFocus,
} from "@/features/chat/services/conversation-focus-store";

describe("ConversationFocusOverlay", () => {
  let container: HTMLDivElement;
  let root: Root;
  let opener: HTMLButtonElement;

  const open = () =>
    act(() =>
      openConversationFocus({
        conversationId: "c1",
        root: { kind: "message", id: "m1" },
        title: "A focused chain",
      }),
    );

  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');

  const press = (key: string) =>
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    act(() =>
      root.render(withI18n(<ConversationFocusOverlay conversationId="c1" />)),
    );
  });

  afterEach(() => {
    closeConversationFocus();
    act(() => root.unmount());
    container.remove();
    opener.remove();
    document.body.innerHTML = "";
  });

  it("renders nothing until a root is focused", () => {
    expect(dialog()).toBeNull();
  });

  it("is a named dialog that keeps the surrounding page live", () => {
    open();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute("aria-label")).toContain("A focused chain");
    // Not modal on purpose — the composer below must stay reachable.
    expect(dialog()!.getAttribute("aria-modal")).toBeNull();
    expect(opener.hasAttribute("inert")).toBe(false);
  });

  it("keeps the backdrop hooks the chat column styles against", () => {
    open();
    const backdrop = container.querySelector<HTMLElement>(
      '[data-testid="conversation-focus"]',
    );
    expect(backdrop).not.toBeNull();
    expect(backdrop!.className).toBe("conversation-focus");
    expect(backdrop!.getAttribute("data-focus-kind")).toBe("message");
    expect(dialog()!.className).toBe("conversation-focus__panel");
  });

  it("moves focus to the close button on open", () => {
    open();
    const close = dialog()!.querySelector<HTMLElement>(
      ".conversation-focus__close",
    );
    expect(document.activeElement).toBe(close);
  });

  it("closes on Escape and restores focus to the opener", () => {
    open();
    press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes when the close button is pressed", () => {
    open();
    const close = dialog()!.querySelector<HTMLButtonElement>(
      ".conversation-focus__close",
    )!;
    act(() => close.click());
    expect(dialog()).toBeNull();
  });
});
