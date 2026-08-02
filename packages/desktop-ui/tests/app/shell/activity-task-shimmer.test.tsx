// @vitest-environment jsdom

import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivityTaskShimmer,
  isTopLevelActivityShimmerEligible,
  useActivityTaskAnimationOwner,
} from "@/shell/ActivityTaskShimmer";
import {
  CHAT_ACTIVITY_SHIMMER_GROUP,
  TextShimmer,
} from "@/app/chat/TextShimmer";
import type { TaskItem } from "@/features/chat/lib/event-transforms";

const task = (overrides: Partial<TaskItem> = {}): TaskItem => ({
  id: "activity-agent",
  description: "Inspect the active work",
  agentType: "general",
  status: "running",
  startedAtMs: Date.now() - 60_000,
  lastUpdatedAtMs: Date.now(),
  ...overrides,
});

type IntersectionHarness = {
  disconnect: ReturnType<typeof vi.fn>;
  emit: (isIntersecting: boolean) => void;
  target?: Element;
};

function Candidate({
  item,
  text,
  isTopLevel = true,
  hidden = false,
}: {
  item: TaskItem;
  text: string;
  isTopLevel?: boolean;
  hidden?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ownsAnimation = useActivityTaskAnimationOwner(item, isTopLevel, ref);
  return (
    <div
      ref={ref}
      hidden={hidden}
      data-candidate={item.id}
      data-owner={ownsAnimation ? "true" : undefined}
    >
      <ActivityTaskShimmer text={text} ownsAnimation={ownsAnimation} />
    </div>
  );
}

describe("left-sidebar Activity shimmer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let animate: ReturnType<typeof vi.fn>;
  let animations: Array<{
    cancel: ReturnType<typeof vi.fn>;
    resolve: () => void;
  }>;
  let intersections: IntersectionHarness[];
  let visibilityState: DocumentVisibilityState;

  const render = async (node: ReactNode) => {
    await act(async () => {
      root.render(node);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const emitIntersection = async (candidate: string, visible: boolean) => {
    const element = container.querySelector(`[data-candidate="${candidate}"]`);
    const observer = intersections.find((entry) => entry.target === element);
    expect(observer).toBeDefined();
    await act(async () => observer?.emit(visible));
  };

  const emitElementIntersection = async (
    selector: string,
    visible: boolean,
  ) => {
    const element = container.querySelector(selector);
    const observer = intersections.find((entry) => entry.target === element);
    expect(observer).toBeDefined();
    await act(async () => observer?.emit(visible));
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    document.documentElement.removeAttribute("data-reduce-motion");
    animations = [];
    animate = vi.fn(() => {
      let resolve = () => {};
      const finished = new Promise<void>((done) => {
        resolve = done;
      });
      const animation = { cancel: vi.fn(), resolve };
      animations.push(animation);
      return { cancel: animation.cancel, finished };
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    intersections = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private callback: IntersectionObserverCallback;
        private harness: IntersectionHarness;

        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          this.harness = {
            disconnect: vi.fn(),
            emit: (isIntersecting) =>
              this.callback(
                [{ isIntersecting } as IntersectionObserverEntry],
                this as unknown as IntersectionObserver,
              ),
          };
          intersections.push(this.harness);
        }

        observe = (target: Element) => {
          this.harness.target = target;
        };
        unobserve = vi.fn();
        disconnect = () => this.harness.disconnect();
        takeRecords = () => [];
        root = null;
        rootMargin = "0px";
        thresholds = [0];
      },
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.documentElement.removeAttribute("data-reduce-motion");
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("animates one Activity owner without global WorkingIndicator starvation", async () => {
    await render(
      <>
        <TextShimmer
          text="Working"
          exclusiveGroup={CHAT_ACTIVITY_SHIMMER_GROUP}
          exclusivePriority={100}
        />
        <Candidate item={task({ id: "general" })} text="General work" />
        <Candidate
          item={task({ id: "manager", agentType: "manager" })}
          text="Manager work"
        />
      </>,
    );
    await emitElementIntersection(
      ".text-shimmer:not(.activity-task-shimmer)",
      true,
    );
    await emitIntersection("general", true);
    await emitIntersection("manager", true);
    const global = container.querySelector(
      ".text-shimmer:not(.activity-task-shimmer) .text-shimmer__sweep",
    );
    expect(global).not.toBeNull();
    expect(
      container.querySelectorAll(".activity-task-shimmer .text-shimmer__sweep"),
    ).toHaveLength(1);
    expect(container.querySelectorAll('[data-owner="true"]')).toHaveLength(1);
  });

  it("hands ownership to a visible row and cleans up offscreen observers", async () => {
    await render(
      <>
        <Candidate item={task({ id: "first" })} text="First" />
        <Candidate item={task({ id: "second" })} text="Second" />
      </>,
    );
    await emitIntersection("first", true);
    await emitIntersection("second", false);
    expect(
      container.querySelector('[data-candidate="first"]')?.dataset.owner,
    ).toBe("true");
    await emitIntersection("first", false);
    await emitIntersection("second", true);
    expect(
      container.querySelector('[data-candidate="second"]')?.dataset.owner,
    ).toBe("true");
    await render(<span>settled</span>);
    expect(
      intersections.every((entry) => entry.disconnect.mock.calls.length > 0),
    ).toBe(true);
  });

  it("stops on settlement, document hiding, and reduced motion", async () => {
    await render(<Candidate item={task()} text="Active" />);
    await emitIntersection("activity-agent", true);
    expect(animate).toHaveBeenCalledTimes(2);

    visibilityState = "hidden";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(container.querySelector(".text-shimmer__sweep")).toBeNull();
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length > 0),
    ).toBe(true);

    visibilityState = "visible";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await emitIntersection("activity-agent", true);
    expect(container.querySelector(".text-shimmer__sweep")).not.toBeNull();

    document.documentElement.setAttribute("data-reduce-motion", "reduce");
    await act(async () => await Promise.resolve());
    expect(container.querySelector(".text-shimmer__sweep")).toBeNull();

    document.documentElement.removeAttribute("data-reduce-motion");
    await render(
      <Candidate item={task({ status: "completed" })} text="Done" />,
    );
    expect(container.querySelector(".text-shimmer__sweep")).toBeNull();
  });

  it("keeps nested, hidden, non-General, and settled rows static", async () => {
    expect(isTopLevelActivityShimmerEligible(task(), true)).toBe(true);
    expect(
      isTopLevelActivityShimmerEligible(task({ agentType: "manager" }), true),
    ).toBe(true);
    await render(
      <>
        <Candidate
          item={task({ id: "nested" })}
          text="Nested"
          isTopLevel={false}
        />
        <Candidate item={task({ id: "hidden" })} text="Hidden" hidden />
        <Candidate
          item={task({ id: "dream", agentType: "dream" })}
          text="Dream"
        />
        <Candidate
          item={task({ id: "done", status: "completed" })}
          text="Done"
        />
      </>,
    );
    expect(container.querySelector(".text-shimmer__sweep")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it("runs bounded sweeps with a rest and cancels pending animation", async () => {
    vi.useFakeTimers();
    await render(<Candidate item={task()} text="Bounded sweep" />);
    await emitIntersection("activity-agent", true);
    expect(animate).toHaveBeenCalledTimes(2);
    await act(async () => {
      animations[0]?.resolve();
      animations[1]?.resolve();
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(animate).toHaveBeenCalledTimes(4);
    await render(
      <Candidate item={task({ status: "completed" })} text="Done" />,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
