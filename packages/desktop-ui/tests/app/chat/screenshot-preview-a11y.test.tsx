// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withI18n } from "../../helpers/i18n";

import { ScreenshotPreviewOverlay } from "@/app/chat/ScreenshotPreview";

/**
 * The enlarged screenshot is a real modal: nothing behind it is meant to be
 * reachable while it is up. It used to be a bare portal div with a click
 * handler, so these lock in what the shared Modal shell now gives it.
 */
describe("ScreenshotPreviewOverlay", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn>;

  const mount = () => {
    act(() =>
      root.render(
        withI18n(
          <ScreenshotPreviewOverlay
            screenshot={{ dataUrl: "data:image/png;base64,AAA" }}
            index={0}
            onClose={onClose}
          />,
        ),
      ),
    );
  };

  const panel = () =>
    document.body.querySelector<HTMLElement>('[role="dialog"]');

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("exposes a named modal dialog", () => {
    mount();
    expect(panel()).not.toBeNull();
    expect(panel()!.getAttribute("aria-modal")).toBe("true");
    expect(panel()!.getAttribute("aria-label")).toBeTruthy();
  });

  it("keeps the image and its alt text", () => {
    mount();
    const image = panel()!.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(image.getAttribute("alt")).toContain("1");
  });

  it("moves focus onto the panel and hides the page behind it", () => {
    mount();
    expect(document.activeElement).toBe(panel());
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect(container.hasAttribute("inert")).toBe(true);
  });

  it("closes on Escape", () => {
    mount();
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener and un-hides the page on unmount", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    mount();
    act(() => root.render(withI18n(<div />)));

    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(container.hasAttribute("inert")).toBe(false);
    opener.remove();
  });
});
