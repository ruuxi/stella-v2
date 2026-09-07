import { describe, expect, test } from "bun:test";
import { ChatHistoryPaging } from "../chat-history-paging";

const nearStart = {
  offsetY: 0,
  contentHeight: 2_000,
  layoutHeight: 800,
  hasOlder: true,
  hasNewer: false,
  loading: false,
};

describe("mobile history demand paging", () => {
  test("opening, laying out, and updating a short recent page fetch no history", () => {
    const paging = new ChatHistoryPaging();
    for (const contentHeight of [100, 150, 200, 300]) {
      expect(paging.takePage({ ...nearStart, contentHeight })).toBeNull();
    }
  });

  test("one drag cannot cascade through sparse older pages", () => {
    const paging = new ChatHistoryPaging();
    paging.beginDrag();
    expect(paging.takePage(nearStart)).toBe("older");
    expect(paging.takePage({ ...nearStart, loading: true })).toBeNull();
    // Hidden journal rows can leave the viewport at the start after a fetch.
    for (let page = 0; page < 20; page++) {
      expect(paging.takePage(nearStart)).toBeNull();
    }
    paging.endDrag(-1);
    paging.beginMomentum();
    expect(paging.takePage(nearStart)).toBeNull();
    paging.endScroll();
    paging.beginDrag();
    expect(paging.takePage(nearStart)).toBe("older");
  });

  test("a fling can request its first page when momentum reaches the boundary", () => {
    const paging = new ChatHistoryPaging();
    paging.beginDrag();
    expect(paging.takePage({ ...nearStart, offsetY: 900 })).toBeNull();
    paging.endDrag(-1);
    expect(paging.takePage(nearStart)).toBeNull();
    paging.beginMomentum();
    expect(paging.takePage({ ...nearStart, offsetY: 200 })).toBe("older");
    paging.endScroll();
    expect(paging.takePage(nearStart)).toBeNull();
  });

  test("dragging a short page can load earlier rows without crossing a threshold", () => {
    const paging = new ChatHistoryPaging();
    paging.beginDrag();
    expect(paging.takePage({ ...nearStart, contentHeight: 100 })).toBe("older");
  });

  test("programmatic momentum cannot arm pagination", () => {
    const paging = new ChatHistoryPaging();
    paging.beginMomentum();
    expect(paging.takePage(nearStart)).toBeNull();
    paging.beginDrag();
    paging.endDrag(0);
    paging.beginMomentum();
    expect(paging.takePage(nearStart)).toBeNull();
  });

  test("loading, missing geometry, and exhausted history do not consume a request", () => {
    const paging = new ChatHistoryPaging();
    paging.beginDrag();
    expect(paging.takePage({ ...nearStart, loading: true })).toBeNull();
    expect(paging.takePage({ ...nearStart, layoutHeight: 0 })).toBeNull();
    expect(paging.takePage({ ...nearStart, hasOlder: false })).toBeNull();
    expect(paging.takePage(nearStart)).toBe("older");
  });

  test("paging toward newer history has the same per-gesture bound", () => {
    const paging = new ChatHistoryPaging();
    const nearEnd = { ...nearStart, offsetY: 1_100, hasNewer: true };
    expect(paging.takePage(nearEnd)).toBeNull();
    paging.beginDrag();
    expect(paging.takePage(nearEnd)).toBe("newer");
    expect(paging.takePage(nearEnd)).toBeNull();
  });
});
