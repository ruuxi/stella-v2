// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantBubble, BubbleMorphProvider } from "@/app/chat/BubbleMorph";
import { InlineWorkingIndicator } from "@/app/chat/InlineWorkingIndicator";

vi.mock("@/app/chat/WorkingIndicator", () => ({
  WorkingIndicator: () => <span className="working-indicator">dots</span>,
}));
vi.mock("@/shell/chat-scroll-follow", () => ({
  notifyChatContentGrowth: vi.fn(),
}));

describe("indicator to reply morph", () => {
  let container: HTMLDivElement;
  let root: Root;
  let reduced = false;
  let targetHeight = 100;
  const animations: {
    cancel: ReturnType<typeof vi.fn>;
    onfinish: (() => void) | null;
  }[] = [];
  const animate = vi.fn(
    (_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
      const animation: {
        cancel: ReturnType<typeof vi.fn>;
        onfinish: (() => void) | null;
      } = { cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation;
    },
  );
  const render = (reply: boolean, justArrived = true) =>
    act(() =>
      root.render(
        <BubbleMorphProvider>
          <div className="event-item assistant">
            {reply && (
              <AssistantBubble animate={justArrived}>
                A reply with several words.
              </AssistantBubble>
            )}
          </div>
          <InlineWorkingIndicator active={!reply} handoff={reply} />
        </BubbleMorphProvider>,
      ),
    );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    reduced = false;
    targetHeight = 100;
    animations.length = 0;
    animate.mockClear();
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function () {
        return new DOMRect(
          0,
          0,
          this.classList.contains("working-indicator") ? 44 : 280,
          this.classList.contains("working-indicator") ? 44 : targetHeight,
        );
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    vi.useRealTimers();
  });

  it("takes over the source and scales the background while only fading text", () => {
    render(false);
    act(() => vi.advanceTimersByTime(200));
    render(true);
    expect(container.querySelector(".working-indicator")).toBeNull();
    expect(container.querySelector("[data-morphing]")).not.toBeNull();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transform: "scale(1, 1)" }),
      ]),
    );
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { opacity: 0 },
      { opacity: 0, offset: 0.2 },
      { opacity: 1 },
    ]);
    act(() => animations[0]?.onfinish?.());
    expect(container.querySelector("[data-morphing]")).toBeNull();
    expect(container.textContent).toContain("A reply");
    expect(container.querySelector(".assistant-morphing")).not.toBeNull();
  });

  it("does not invent a source for replies faster than 200ms", () => {
    render(false);
    act(() => vi.advanceTimersByTime(100));
    render(true);
    expect(animate).not.toHaveBeenCalled();
  });

  it("does not morph hydrated history", () => {
    render(false);
    act(() => vi.advanceTimersByTime(200));
    render(true, false);
    expect(animate).not.toHaveBeenCalled();
  });

  it.each(["reduced motion", "long reply"])(
    "settles directly for %s",
    (mode) => {
      render(false);
      act(() => vi.advanceTimersByTime(200));
      reduced = mode === "reduced motion";
      targetHeight = mode === "long reply" ? 2000 : 100;
      render(true);
      expect(animate).not.toHaveBeenCalled();
      expect(container.querySelector(".working-indicator")).toBeNull();
      expect(container.textContent).toContain("A reply");
    },
  );

  it("cancels animations on unmount", () => {
    render(false);
    act(() => vi.advanceTimersByTime(200));
    render(true);
    act(() => root.render(null));
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length > 0),
    ).toBe(true);
  });
});
