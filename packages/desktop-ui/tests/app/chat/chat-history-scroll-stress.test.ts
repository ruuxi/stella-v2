// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  captureChatPrependAnchor,
  ChatHistoryPaginationGate,
  restoreChatPrependAnchor,
} from "@/shell/chat-history-pagination";

const pageSize = 200;
const totalMessages = 1_200;

describe("synthetic long-chat pagination stress", () => {
  it("keeps mounted rows bounded while paging through many variable-height prepends", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    Object.defineProperty(viewport, "clientHeight", { value: 800 });
    let scrollHeight = 40_000;
    Object.defineProperty(viewport, "scrollHeight", {
      get: () => scrollHeight,
    });
    viewport.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, height: 800 }) as DOMRect;

    const mounted = new Map<string, HTMLElement>();
    const mountWindow = (start: number, count: number) => {
      viewport.replaceChildren();
      mounted.clear();
      for (let index = 0; index < count; index += 1) {
        const id = `msg-${start + index}`;
        const row = document.createElement("div");
        row.dataset.chatRowId = id;
        const height = 80 + ((start + index) % 7) * 120;
        row.getBoundingClientRect = () =>
          ({
            top: 40 + index * 8,
            bottom: 40 + index * 8 + height,
            height,
          }) as DOMRect;
        viewport.appendChild(row);
        mounted.set(id, row);
      }
    };

    mountWindow(totalMessages - 24, 24);
    viewport.scrollTop = 1_200;
    const gate = new ChatHistoryPaginationGate();
    let loaded = pageSize;
    let requests = 0;
    const maxMounted = 24;

    while (loaded < totalMessages) {
      const decision = gate.consider(
        1,
        "up",
        {
          scrollTop: viewport.scrollTop,
          viewportHeight: 800,
          contentHeight: scrollHeight,
        },
        { hasMore: loaded < totalMessages, isLoading: false },
      );
      expect(decision.request).toBe(true);
      requests += 1;
      gate.syncGuards({ hasMore: true, isLoading: true });

      const anchor = captureChatPrependAnchor(viewport);
      expect(anchor?.rowId).toBeTruthy();
      const prependHeight = 18_000 + (requests % 3) * 2_400;
      scrollHeight += prependHeight;
      loaded = Math.min(totalMessages, loaded + pageSize);
      mountWindow(totalMessages - Math.min(loaded, maxMounted), maxMounted);
      const restored = restoreChatPrependAnchor(viewport, anchor!);
      expect(restored.found).toBe(true);
      expect(Math.abs((restored.viewportOffsetAfter ?? 0) - anchor!.viewportOffset)).toBeLessThan(0.5);
      expect(mounted.size).toBeLessThanOrEqual(maxMounted);

      expect(
        gate.consider(null, "none", {
          scrollTop: viewport.scrollTop,
          viewportHeight: 800,
          contentHeight: scrollHeight,
        }, { hasMore: loaded < totalMessages, isLoading: true }).request,
      ).toBe(false);
      gate.syncGuards({
        hasMore: loaded < totalMessages,
        isLoading: false,
      });
    }

    expect(requests).toBe(totalMessages / pageSize - 1);
    expect(mounted.size).toBe(maxMounted);
    viewport.remove();
  });
});
