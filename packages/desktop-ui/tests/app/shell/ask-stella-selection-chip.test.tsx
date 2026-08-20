// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(async () => true),
  dispatchComposeText: vi.fn(),
}));

vi.mock("@/shared/lib/clipboard", () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));

vi.mock("@/shared/lib/stella-orb-chat", () => ({
  dispatchComposeText: mocks.dispatchComposeText,
}));

import { AskStellaSelectionChip } from "@/shell/selection/AskStellaSelectionChip";

const SELECTED = "Ask Stella about this selected sentence";

const selectionRect = {
  x: 120,
  y: 180,
  left: 120,
  top: 180,
  right: 420,
  bottom: 208,
  width: 300,
  height: 28,
  toJSON: () => ({}),
} as DOMRect;

describe("Ask Stella selection toolbar", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let source: HTMLParagraphElement | null = null;
  let originalGetBoundingClientRect: Range["getBoundingClientRect"] | undefined;

  const selectSource = () => {
    if (!source) return;
    const range = document.createRange();
    range.selectNodeContents(source);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const showChip = async () => {
    selectSource();
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, button: 0 }),
      );
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  };

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    source = document.createElement("p");
    source.textContent = SELECTED;
    document.body.appendChild(source);
    originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () => selectionRect;
    root = createRoot(container);
    await act(async () => {
      root?.render(<AskStellaSelectionChip />);
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container.remove();
    source?.remove();
    if (originalGetBoundingClientRect) {
      Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
    window.getSelection()?.removeAllRanges();
  });

  it("shows Ask Stella and Copy after a page selection", async () => {
    expect(document.querySelector(".ask-stella-selection-chip-group")).toBeNull();
    await showChip();
    const group = document.querySelector(".ask-stella-selection-chip-group");
    expect(group).not.toBeNull();
    expect(
      group?.querySelector(".ask-stella-selection-chip__label")?.textContent,
    ).toBe("Ask Stella");
    expect(group?.querySelector('button[aria-label="Copy"]')).not.toBeNull();
  });

  it("copies without collapsing the live selection", async () => {
    await showChip();
    const copy = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy"]',
    );
    expect(copy).not.toBeNull();

    await act(async () => {
      copy?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      copy?.click();
    });

    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(SELECTED);
    expect(window.getSelection()?.toString()).toBe(SELECTED);
    expect(
      document.querySelector(".ask-stella-selection-chip-group"),
    ).not.toBeNull();
  });

  it("asks Stella with the selected text while keeping existing compose behavior", async () => {
    await showChip();
    const ask = document.querySelector<HTMLButtonElement>(
      "button.ask-stella-selection-chip:not(.ask-stella-selection-chip--icon)",
    );
    expect(ask).not.toBeNull();

    await act(async () => {
      ask?.click();
    });

    expect(mocks.dispatchComposeText).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedText: SELECTED,
        chatContext: expect.objectContaining({ selectedText: SELECTED }),
      }),
    );
    expect(document.querySelector(".ask-stella-selection-chip-group")).toBeNull();
  });
});
