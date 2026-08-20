// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatTimelineList } from "@/app/chat/ChatTimelineList";
import type { ChatScrollListRef } from "@/app/chat/chat-timeline-list-types";

type Row = { id: string; size: number };

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(
    readonly callback: ResizeObserverCallback,
  ) {
    TestResizeObserver.instances.push(this);
  }

  observe = (element: Element) => this.observed.add(element);
  unobserve = (element: Element) => this.observed.delete(element);
  disconnect = () => {
    this.disconnected = true;
    this.observed.clear();
  };

  resize(element: Element, height: number): void {
    this.callback(
      [
        {
          target: element,
          contentRect: { height },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }

  resizeMany(entries: Array<{ element: Element; height: number }>): void {
    this.callback(
      entries.map(
        ({ element, height }) =>
          ({
            target: element,
            contentRect: { height },
          }) as ResizeObserverEntry,
      ),
      this as unknown as ResizeObserver,
    );
  }
}

const makeRows = (start: number, count: number, size = 50): Row[] =>
  Array.from({ length: count }, (_, offset) => ({
    id: `row-${start + offset}`,
    size,
  }));

describe("ChatTimelineList", () => {
  let host: HTMLDivElement;
  let root: Root;
  let originalClientHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    TestResizeObserver.instances = [];
    globalThis.ResizeObserver =
      TestResizeObserver as unknown as typeof ResizeObserver;
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.chatTimelineList ? 600 : 0;
      },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    if (originalClientHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientHeight",
        originalClientHeight,
      );
    } else {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  const render = (
    data: Row[],
    listRef = createRef<ChatScrollListRef | null>(),
    resetKey = "conversation-a",
  ) => {
    act(() => {
      root.render(
        createElement(ChatTimelineList<Row>, {
          data,
          resetKey,
          listRef,
          keyExtractor: (row) => row.id,
          estimateItemSize: (row) => row.size,
          renderItem: ({ item }) =>
            createElement("div", { "data-row-content": item.id }, item.id),
          drawDistance: 1_800,
          maxMountedItems: 240,
          initialScrollAtEnd: true,
        }),
      );
    });
    return listRef;
  };

  it("bounds mounted DOM and preserves the exact scroll anchor over repeated prepends", () => {
    const listRef = createRef<ChatScrollListRef | null>();
    let data = makeRows(1_000, 4_000);
    render(data, listRef);
    const node = listRef.current!.getScrollableNode();
    expect(listRef.current!.getDebugState()).toMatchObject({
      itemCount: 4_000,
      mountedCount: expect.any(Number),
    });
    expect(listRef.current!.getDebugState()!.mountedCount).toBeLessThanOrEqual(
      240,
    );

    act(() => {
      node.scrollTop = 25_025;
      node.dispatchEvent(new Event("scroll"));
    });
    for (let page = 0; page < 5; page += 1) {
      data = [...makeRows(800 - page * 200, 200), ...data];
      render(data, listRef);
      expect(node.scrollTop).toBe(25_025 + (page + 1) * 10_000);
      expect(listRef.current!.getDebugState()).toMatchObject({
        lastOperation: "prepend",
        lastEstimateCalls: 200,
        lastExistingRowsVisited: 0,
      });
      expect(listRef.current!.getDebugState()!.mountedCount).toBeLessThanOrEqual(
        240,
      );
    }
  });

  it("pins a streaming append at end and compensates a late measurement above the anchor", () => {
    const listRef = createRef<ChatScrollListRef | null>();
    let data = makeRows(0, 1_000);
    render(data, listRef);
    const node = listRef.current!.getScrollableNode();
    expect(node.scrollTop).toBe(49_400);

    data = [...data, { id: "streaming", size: 50 }];
    render(data, listRef);
    expect(node.scrollTop).toBe(49_450);

    act(() => {
      node.scrollTop = 25_025;
      node.dispatchEvent(new Event("scroll"));
    });
    const mountedAbove = host.querySelector<HTMLElement>(
      '[data-chat-timeline-index="499"]',
    );
    expect(mountedAbove).not.toBeNull();
    const observer = TestResizeObserver.instances.at(-1)!;
    act(() => {
      observer.resize(mountedAbove!, 50);
      observer.resize(mountedAbove!, 150);
    });
    expect(node.scrollTop).toBe(25_125);
    expect(listRef.current!.getDebugState()!.maxBlockSize).toBeLessThanOrEqual(
      128,
    );
  });

  it("anchors measurement batches to the actual row crossing the viewport", () => {
    const listRef = createRef<ChatScrollListRef | null>();
    render(makeRows(0, 1_000), listRef);
    const node = listRef.current!.getScrollableNode();
    act(() => {
      node.scrollTop = 25_025;
      node.dispatchEvent(new Event("scroll"));
    });
    const actualAnchor = host.querySelector<HTMLElement>(
      '[data-chat-timeline-index="499"]',
    );
    expect(actualAnchor).not.toBeNull();

    act(() => {
      TestResizeObserver.instances
        .at(-1)!
        .resizeMany([{ element: actualAnchor!, height: 200 }]);
    });

    // The estimate called row 500 the anchor, but row 499's actual 200px
    // height crosses the viewport. Growing the real anchor must not move it.
    expect(node.scrollTop).toBe(25_025);
  });

  it("synchronously mounts the destination range after a parked scroll jump", () => {
    const listRef = createRef<ChatScrollListRef | null>();
    render(makeRows(0, 4_000), listRef);
    const node = listRef.current!.getScrollableNode();

    act(() => {
      node.scrollTop = 150_025;
      node.dispatchEvent(new Event("scroll"));
      expect(
        host.querySelector('[data-chat-timeline-index="3000"]'),
      ).not.toBeNull();
    });
    expect(listRef.current!.getDebugState()!.mountedCount).toBeLessThanOrEqual(
      240,
    );
  });

  it("releases observers and cached keys on conversation switch and unmount", () => {
    const listRef = createRef<ChatScrollListRef | null>();
    render(makeRows(0, 2_000), listRef, "conversation-a");
    const firstObserver = TestResizeObserver.instances.at(-1)!;
    render(makeRows(20_000, 120), listRef, "conversation-b");
    expect(listRef.current!.getDebugState()).toMatchObject({
      itemCount: 120,
      retainedKeyCount: 120,
    });

    act(() => root.unmount());
    expect(firstObserver.disconnected).toBe(true);
    expect(listRef.current).toBeNull();
    root = createRoot(host);
  });
});
