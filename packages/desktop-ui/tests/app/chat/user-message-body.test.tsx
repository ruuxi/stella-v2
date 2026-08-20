// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withI18n } from "../../helpers/i18n";
import { UserMessageBody } from "@/app/chat/UserMessageBody";

type ResizeObserverCallback = () => void;

class ResizeObserverStub {
  static last?: ResizeObserverStub;
  observe = vi.fn();
  disconnect = vi.fn();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.last = this;
  }

  trigger() {
    this.callback();
  }
}

const LONG_TEXT = Array.from(
  { length: 12 },
  (_, index) => `Line ${index + 1} of a long user prompt.`,
).join("\n");

const SHORT_TEXT = "Short prompt.";

function mockCollapsedOverflow(el: HTMLElement, overflowing: boolean) {
  const clientHeight = 90;
  const scrollHeight = overflowing ? 270 : 90;
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
}

describe("UserMessageBody", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    ResizeObserverStub.last = undefined;
  });

  it("does not show a toggle for short content", async () => {
    await act(async () => {
      root.render(withI18n(<UserMessageBody text={SHORT_TEXT} />));
    });
    const body = container.querySelector<HTMLElement>(".event-body");
    expect(body).not.toBeNull();
    mockCollapsedOverflow(body!, false);
    await act(async () => {
      ResizeObserverStub.last?.trigger();
    });

    expect(container.querySelector(".event-user-toggle")).toBeNull();
    expect(container.querySelector(".event-user-body")?.textContent).toContain(
      SHORT_TEXT,
    );
  });

  it("clamps overflowing content and expands / collapses through the existing control", async () => {
    await act(async () => {
      root.render(withI18n(<UserMessageBody text={LONG_TEXT} />));
    });
    const body = container.querySelector<HTMLElement>(".event-body");
    mockCollapsedOverflow(body!, true);
    await act(async () => {
      ResizeObserverStub.last?.trigger();
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      ".event-user-toggle",
    );
    const wrapper = container.querySelector(".event-user-body");
    expect(toggle?.textContent).toBe("Show more");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(wrapper?.getAttribute("data-expanded")).toBe("false");
    expect(wrapper?.textContent).toContain("Line 12 of a long user prompt.");

    await act(async () => {
      toggle!.click();
    });
    expect(toggle?.textContent).toBe("Show less");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(wrapper?.getAttribute("data-expanded")).toBe("true");

    await act(async () => {
      toggle!.click();
    });
    expect(toggle?.textContent).toBe("Show more");
    expect(wrapper?.getAttribute("data-expanded")).toBe("false");
  });

  it("remasures overflow when the bubble width changes", async () => {
    await act(async () => {
      root.render(withI18n(<UserMessageBody text={LONG_TEXT} />));
    });
    const body = container.querySelector<HTMLElement>(".event-body");
    mockCollapsedOverflow(body!, false);
    await act(async () => {
      ResizeObserverStub.last?.trigger();
    });
    expect(container.querySelector(".event-user-toggle")).toBeNull();

    mockCollapsedOverflow(body!, true);
    await act(async () => {
      ResizeObserverStub.last?.trigger();
    });
    expect(container.querySelector(".event-user-toggle")?.textContent).toBe(
      "Show more",
    );
  });
});
