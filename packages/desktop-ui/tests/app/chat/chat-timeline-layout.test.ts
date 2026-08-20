import { describe, expect, it } from "vitest";
import {
  CHAT_TIMELINE_LAYOUT_BLOCK_SIZE,
  ChatTimelineLayout,
} from "@/features/chat/lib/chat-timeline-layout";

type FixtureRow = { id: string; estimate: number };

const rows = (start: number, count: number): FixtureRow[] =>
  Array.from({ length: count }, (_, offset) => ({
    id: `row-${start + offset}`,
    estimate: 48 + ((start + offset) % 13) * 17,
  }));

const reconcile = (layout: ChatTimelineLayout, data: FixtureRow[]) =>
  layout.reconcile({
    itemCount: data.length,
    keyAt: (index) => data[index]!.id,
    estimateAt: (index) => data[index]!.estimate,
  });

describe("ChatTimelineLayout", () => {
  it("prepends only new blocks without visiting or re-estimating loaded history", () => {
    const layout = new ChatTimelineLayout();
    let data = rows(1_000, 4_000);
    expect(reconcile(layout, data)).toMatchObject({
      operation: "rebuild",
      estimateCalls: 4_000,
    });

    layout.measure("row-2200", 911);
    const measuredBefore = layout.debug().measuredCount;
    const oldOffset = layout.offsetForKey("row-2200")!;
    const older = rows(800, 200);
    data = [...older, ...data];
    const result = reconcile(layout, data);

    expect(result).toMatchObject({
      operation: "prepend",
      prependCount: 200,
      appendCount: 0,
      estimateCalls: 200,
      existingRowsVisited: 0,
    });
    expect(layout.offsetForKey("row-2200")! - oldOffset).toBe(
      result.prependedSize,
    );
    expect(layout.debug()).toMatchObject({
      itemCount: 4_200,
      measuredCount: measuredBefore,
      retainedKeyCount: 4_200,
      maxBlockSize: CHAT_TIMELINE_LAYOUT_BLOCK_SIZE,
    });
  });

  it("preserves the exact row and intra-row anchor over rapid multi-page prepends", () => {
    const layout = new ChatTimelineLayout();
    let data = rows(1_200, 200);
    reconcile(layout, data);
    const anchorKey = "row-1267";
    const intraRowOffset = 31.25;
    let scrollTop = layout.offsetForKey(anchorKey)! + intraRowOffset;

    for (let page = 0; page < 6; page += 1) {
      const older = rows(1_000 - page * 200, 200);
      data = [...older, ...data];
      const result = reconcile(layout, data);
      scrollTop += result.prependedSize;
      const settledOffset = scrollTop - layout.offsetForKey(anchorKey)!;
      expect(settledOffset).toBe(intraRowOffset);
      expect(result.estimateCalls).toBe(200);
      expect(result.existingRowsVisited).toBe(0);
    }

    expect(layout.debug().itemCount).toBe(1_400);
    expect(layout.debug().retainedKeyCount).toBe(1_400);
  });

  it("compensates remeasurement above an anchor but not the anchor row or rows below", () => {
    const layout = new ChatTimelineLayout();
    const data = rows(0, 600);
    reconcile(layout, data);
    const anchorKey = "row-310";
    const anchorIndex = 310;
    const intraRowOffset = 19;
    let scrollTop = layout.offsetForKey(anchorKey)! + intraRowOffset;

    const above = layout.measure("row-250", 900);
    expect(above.index).toBeLessThan(anchorIndex);
    scrollTop += above.delta;
    expect(scrollTop - layout.offsetForKey(anchorKey)!).toBe(intraRowOffset);

    const anchorTopBefore = layout.offsetForKey(anchorKey)!;
    const anchor = layout.measure(anchorKey, 1_200);
    expect(anchor.index).toBe(anchorIndex);
    expect(layout.offsetForKey(anchorKey)).toBe(anchorTopBefore);
    expect(scrollTop - layout.offsetForKey(anchorKey)!).toBe(intraRowOffset);

    const below = layout.measure("row-500", 1_500);
    expect(below.index).toBeGreaterThan(anchorIndex);
    expect(scrollTop - layout.offsetForKey(anchorKey)!).toBe(intraRowOffset);
    expect(Math.max(above.rowsVisited, anchor.rowsVisited, below.rowsVisited)).toBeLessThanOrEqual(
      CHAT_TIMELINE_LAYOUT_BLOCK_SIZE,
    );
  });

  it("keeps the mounted range bounded in both directions with variable heights", () => {
    const layout = new ChatTimelineLayout();
    const data = rows(0, 4_000);
    reconcile(layout, data);
    for (let index = 0; index < data.length; index += 37) {
      layout.measure(data[index]!.id, 20 + (index % 11) * 230);
    }

    for (const offset of [0, 40_000, 180_000, layout.contentSize - 900]) {
      const range = layout.visibleRange({
        scrollOffset: offset,
        viewportSize: 940,
        overscan: 1_800,
        maxItems: 240,
      });
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(data.length);
      expect(range.end - range.start).toBeLessThanOrEqual(240);
      expect(range.end).toBeGreaterThan(range.start);
    }
  });

  it("keeps the hard row ceiling even when estimates are pathologically small", () => {
    const layout = new ChatTimelineLayout();
    const data = Array.from({ length: 2_000 }, (_, index) => ({
      id: `tiny-${index}`,
      estimate: 1,
    }));
    reconcile(layout, data);
    const range = layout.visibleRange({
      scrollOffset: 500,
      viewportSize: 940,
      overscan: 1_800,
      maxItems: 240,
    });
    expect(range.end - range.start).toBe(240);
  });

  it("handles simultaneous prepend/stream append and releases trimmed keys", () => {
    const layout = new ChatTimelineLayout();
    let data = rows(500, 400);
    reconcile(layout, data);
    const older = rows(300, 200);
    const streamed = rows(900, 3);
    data = [...older, ...data, ...streamed];
    expect(reconcile(layout, data)).toMatchObject({
      operation: "prepend-append",
      prependCount: 200,
      appendCount: 3,
      estimateCalls: 203,
      existingRowsVisited: 0,
    });

    data = data.slice(data.length - 200);
    expect(reconcile(layout, data).operation).toBe("trim-start");
    expect(layout.debug()).toMatchObject({
      itemCount: 200,
      retainedKeyCount: 200,
    });
  });

  it("clears all retained layout state when a conversation switches", () => {
    const layout = new ChatTimelineLayout();
    reconcile(layout, rows(0, 1_000));
    layout.measure("row-500", 2_000);
    layout.clear();
    expect(layout.debug()).toMatchObject({
      itemCount: 0,
      blockCount: 0,
      measuredCount: 0,
      retainedKeyCount: 0,
      contentSize: 0,
    });
    expect(reconcile(layout, rows(20_000, 200))).toMatchObject({
      operation: "rebuild",
      estimateCalls: 200,
    });
  });
});
