// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureChatPrependAnchor,
  ChatHistoryPaginationGate,
  HISTORY_PREFETCH_MAX_VIEWPORTS,
  HISTORY_PREFETCH_MIN_VIEWPORTS,
  resolveHistoryPrefetchLeadPx,
  restoreChatPrependAnchor,
  type HistoryPaginationMetrics,
} from "@/shell/chat-history-pagination";

const nearTop: HistoryPaginationMetrics = {
  scrollTop: 900,
  viewportHeight: 600,
  contentHeight: 12_000,
};

const outsideLead: HistoryPaginationMetrics = {
  scrollTop: 2_500,
  viewportHeight: 600,
  contentHeight: 12_000,
};

const guards = { hasMore: true, isLoading: false };

describe("history prefetch lead", () => {
  it("grows with observed velocity and latency while remaining bounded", () => {
    const viewportHeight = 600;
    const slow = resolveHistoryPrefetchLeadPx({
      viewportHeight,
      upwardVelocityPxPerMs: 0,
      pageLatencyMs: 200,
    });
    const fast = resolveHistoryPrefetchLeadPx({
      viewportHeight,
      upwardVelocityPxPerMs: 12,
      pageLatencyMs: 300,
    });
    const extreme = resolveHistoryPrefetchLeadPx({
      viewportHeight,
      upwardVelocityPxPerMs: 100,
      pageLatencyMs: 2_000,
    });

    expect(slow).toBe(viewportHeight * HISTORY_PREFETCH_MIN_VIEWPORTS);
    expect(fast).toBeGreaterThan(slow);
    expect(extreme).toBe(viewportHeight * HISTORY_PREFETCH_MAX_VIEWPORTS);
  });
});

describe("ChatHistoryPaginationGate", () => {
  it("loads exactly one page for the first deliberate upward threshold action", () => {
    const gate = new ChatHistoryPaginationGate();

    expect(
      gate.consider(1, "up", outsideLead, guards),
    ).toMatchObject({
      request: false,
      reason: "outside-threshold",
      thresholdVisible: false,
    });

    expect(gate.consider(1, "up", { ...nearTop, scrollTop: 1_300 }, guards)).toMatchObject({
      request: true,
      reason: "request",
      thresholdVisible: true,
    });
    expect(gate.consider(1, "up", nearTop, guards)).toMatchObject({
      request: false,
      reason: "in-flight",
    });
  });

  it("does not re-request from layout while a page is in flight, then re-arms the same flick after settle", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(10, "up", nearTop, guards).request).toBe(true);

    gate.syncGuards({ hasMore: true, isLoading: true });
    const stillVisibleAfterPrepend = {
      ...nearTop,
      scrollTop: 1_100,
      contentHeight: 20_000,
    };
    expect(
      gate.consider(10, "up", stillVisibleAfterPrepend, {
        hasMore: true,
        isLoading: true,
      }),
    ).toMatchObject({ request: false, reason: "in-flight" });

    gate.syncGuards({ hasMore: true, isLoading: false });
    expect(
      gate.consider(10, "up", stillVisibleAfterPrepend, guards),
    ).toMatchObject({ request: true, reason: "request" });
  });

  it("ignores repeated data/render/measurement updates without user intent", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(20, "up", nearTop, guards).request).toBe(true);
    gate.syncGuards({ hasMore: true, isLoading: true });
    gate.syncGuards({ hasMore: true, isLoading: false });

    for (const contentHeight of [13_000, 13_180, 13_160, 13_220]) {
      const decision = gate.consider(
        null,
        "none",
        { ...nearTop, contentHeight },
        guards,
      );
      expect(decision).toMatchObject({
        request: false,
        reason: "not-upward",
      });
    }
  });

  it("allows a second page only for a second deliberate upward action", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(30, "up", nearTop, guards).request).toBe(true);
    gate.syncGuards({ hasMore: true, isLoading: true });
    gate.syncGuards({ hasMore: true, isLoading: false });

    expect(gate.consider(31, "up", nearTop, guards)).toMatchObject({
      request: true,
      reason: "request",
    });
  });

  it("dedupes every action that occurs while a page is in flight", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(40, "up", nearTop, guards).request).toBe(true);
    gate.syncGuards({ hasMore: true, isLoading: true });

    expect(
      gate.consider(41, "up", nearTop, {
        hasMore: true,
        isLoading: true,
      }),
    ).toMatchObject({ request: false, reason: "in-flight" });

    gate.syncGuards({ hasMore: true, isLoading: false });
    expect(gate.consider(41, "up", nearTop, guards)).toMatchObject({
      request: true,
      reason: "request",
    });
    expect(gate.consider(42, "up", nearTop, { hasMore: true, isLoading: true })).toMatchObject({
      request: false,
      reason: "in-flight",
    });
  });

  it("does not settle on the transient hasMore=false subscription re-key", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(45, "up", nearTop, guards).request).toBe(true);
    gate.syncGuards({ hasMore: true, isLoading: true });

    expect(gate.syncGuards({ hasMore: false, isLoading: true })).toMatchObject({
      requestSettled: false,
    });
    expect(gate.snapshot().requestPhase).toBe("loading");
    expect(gate.syncGuards({ hasMore: true, isLoading: false })).toMatchObject({
      requestSettled: true,
    });
  });

  it("stops at end-of-history without entering an in-flight state", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(
      gate.consider(50, "up", nearTop, {
        hasMore: false,
        isLoading: false,
      }),
    ).toMatchObject({ request: false, reason: "end-of-history" });
    expect(gate.snapshot().requestPhase).toBe("idle");
  });

  it("loads several pages across one continuous upward flick without cascading from layout", () => {
    const gate = new ChatHistoryPaginationGate();
    let requests = 0;
    for (let page = 0; page < 6; page += 1) {
      const decision = gate.consider(70, "up", nearTop, {
        hasMore: true,
        isLoading: false,
      });
      expect(decision.request).toBe(true);
      requests += 1;
      gate.syncGuards({ hasMore: true, isLoading: true });
      expect(
        gate.consider(null, "none", { ...nearTop, contentHeight: 12_000 + page * 8_000 }, {
          hasMore: true,
          isLoading: true,
        }).request,
      ).toBe(false);
      gate.syncGuards({ hasMore: true, isLoading: false });
    }
    expect(requests).toBe(6);
  });

  it("settles an errored request and permits an explicit retry action", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(60, "up", nearTop, guards).request).toBe(true);
    expect(gate.syncGuards({ hasMore: true, isLoading: true })).toMatchObject({
      requestStarted: true,
    });
    expect(gate.syncGuards({ hasMore: true, isLoading: false })).toMatchObject({
      requestSettled: true,
    });

    expect(gate.consider(61, "up", nearTop, guards)).toMatchObject({
      request: true,
      reason: "request",
    });
  });
});

describe("prepend anchor preservation", () => {
  it("restores the exact painted row offset and advances scrollTop by prepend height", () => {
    const viewport = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.chatRowId = "message-200";
    viewport.appendChild(row);
    document.body.appendChild(viewport);

    let rowDocumentTop = 120;
    let contentHeight = 2_000;
    viewport.scrollTop = 100;
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    Object.defineProperty(viewport, "scrollHeight", {
      get: () => contentHeight,
    });
    viewport.getBoundingClientRect = () =>
      ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({
        top: rowDocumentTop - viewport.scrollTop,
        bottom: rowDocumentTop - viewport.scrollTop + 80,
        height: 80,
      }) as DOMRect;

    const anchor = captureChatPrependAnchor(viewport);
    expect(anchor).toMatchObject({
      rowId: "message-200",
      viewportOffset: 20,
      scrollTop: 100,
      viewportHeight: 600,
      contentHeight: 2_000,
      extraRows: [],
    });

    rowDocumentTop += 500;
    contentHeight += 500;
    const restored = restoreChatPrependAnchor(viewport, anchor!);

    expect(restored).toMatchObject({
      found: true,
      adjustment: 500,
      scrollTopBefore: 100,
      scrollTopAfter: 600,
      viewportOffsetAfter: 20,
      contentHeightAfter: 2_500,
      strategy: "row",
    });
    viewport.remove();
  });

  it("does not write scrollTop when Legend MVCP already preserved the anchor", () => {
    const viewport = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.chatRowId = "message-200";
    viewport.appendChild(row);
    document.body.appendChild(viewport);

    let rowDocumentTop = 120;
    viewport.scrollTop = 100;
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    Object.defineProperty(viewport, "scrollHeight", { value: 2_500 });
    viewport.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({
        top: rowDocumentTop - viewport.scrollTop,
        bottom: rowDocumentTop - viewport.scrollTop + 80,
      }) as DOMRect;

    const anchor = captureChatPrependAnchor(viewport)!;
    rowDocumentTop += 500;
    viewport.scrollTop += 500;
    const restored = restoreChatPrependAnchor(viewport, anchor);

    expect(restored.adjustment).toBe(0);
    expect(restored.scrollTopBefore).toBe(600);
    expect(restored.scrollTopAfter).toBe(600);
    expect(restored.viewportOffsetAfter).toBe(20);
    expect(restored.strategy).toBe("row");
    viewport.remove();
  });

  it("falls back to another captured visible row when the top row is recycled", () => {
    const viewport = document.createElement("div");
    const top = document.createElement("div");
    const next = document.createElement("div");
    top.dataset.chatRowId = "message-top";
    next.dataset.chatRowId = "message-next";
    viewport.append(top, next);
    document.body.appendChild(viewport);

    viewport.scrollTop = 100;
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    let contentHeight = 2_000;
    Object.defineProperty(viewport, "scrollHeight", {
      get: () => contentHeight,
    });
    viewport.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    top.getBoundingClientRect = () => ({ top: 20, bottom: 100 }) as DOMRect;
    next.getBoundingClientRect = () => ({ top: 120, bottom: 200 }) as DOMRect;

    const anchor = captureChatPrependAnchor(viewport)!;
    expect(anchor.rowId).toBe("message-top");
    expect(anchor.extraRows).toEqual([
      { rowId: "message-next", viewportOffset: 120 },
    ]);

    top.remove();
    contentHeight = 2_500;
    next.getBoundingClientRect = () => ({ top: 620, bottom: 700 }) as DOMRect;

    const restored = restoreChatPrependAnchor(viewport, anchor);
    expect(restored.found).toBe(true);
    expect(restored.strategy).toBe("row");
    expect(restored.adjustment).toBe(500);
    expect(viewport.scrollTop).toBe(600);
    viewport.remove();
  });

  it("applies the content-height delta only when MVCP left scrollTop unmoved", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    viewport.scrollTop = 100;
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    let contentHeight = 2_000;
    Object.defineProperty(viewport, "scrollHeight", {
      get: () => contentHeight,
    });
    viewport.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

    const unmountedAnchor = {
      rowId: "gone",
      viewportOffset: -24,
      scrollTop: 100,
      viewportHeight: 600,
      contentHeight: 2_000,
      extraRows: [],
    };
    contentHeight = 52_000;
    const restored = restoreChatPrependAnchor(viewport, unmountedAnchor);
    expect(restored.strategy).toBe("content-delta");
    expect(restored.found).toBe(false);
    expect(restored.adjustment).toBe(50_000);
    expect(viewport.scrollTop).toBe(50_100);

    viewport.scrollTop = 50_100;
    const alreadyMoved = restoreChatPrependAnchor(viewport, {
      ...unmountedAnchor,
      contentHeight: 2_000,
    });
    expect(alreadyMoved.strategy).toBe("miss");
    expect(alreadyMoved.adjustment).toBe(0);
    expect(viewport.scrollTop).toBe(50_100);
    viewport.remove();
  });

  it("does not apply extra-row restore after MVCP already moved scrollTop", () => {
    const viewport = document.createElement("div");
    const next = document.createElement("div");
    next.dataset.chatRowId = "message-next";
    viewport.append(next);
    document.body.appendChild(viewport);

    viewport.scrollTop = 50_100;
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    Object.defineProperty(viewport, "scrollHeight", { value: 52_000 });
    viewport.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    next.getBoundingClientRect = () => ({ top: 3_800, bottom: 3_900 }) as DOMRect;

    const restored = restoreChatPrependAnchor(viewport, {
      rowId: "gone",
      viewportOffset: -24,
      scrollTop: 100,
      viewportHeight: 600,
      contentHeight: 2_000,
      extraRows: [{ rowId: "message-next", viewportOffset: 120 }],
    });
    expect(restored.strategy).toBe("miss");
    expect(restored.adjustment).toBe(0);
    expect(viewport.scrollTop).toBe(50_100);
    viewport.remove();
  });
});

describe("chat timeline pagination wiring", () => {
  it("keeps the native listener performance fix and does not use Legend data-change re-entry", () => {
    const desktopRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const timeline = fs.readFileSync(
      path.join(desktopRoot, "src/app/chat/ChatTimeline.tsx"),
      "utf8",
    );
    const hook = fs.readFileSync(
      path.join(desktopRoot, "src/shell/use-chat-scroll-management.ts"),
      "utf8",
    );

    expect(timeline).not.toMatch(/\bonStartReached=/);
    expect(timeline).not.toContain("onScroll={");
    expect(hook).toMatch(
      /addEventListener\(["']scroll["'], handlePaginationScroll, \{\s*passive: true,?\s*\}\)/,
    );
  });

  it("combines manual-scroll deferral with the deliberate upward pagination action", () => {
    const desktopRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const hook = fs.readFileSync(
      path.join(desktopRoot, "src/shell/use-chat-scroll-management.ts"),
      "utf8",
    );

    expect(hook).toMatch(
      /const handleWheel = \(event: WheelEvent\) => \{\s*noteManualScroll\(\)[\s\S]*?attemptHistoryLoad\(wheelActionId, direction, ["']wheel["']\)/,
    );
    expect(hook).toContain("cancelPendingAnchorForUserScroll()");
  });
});
