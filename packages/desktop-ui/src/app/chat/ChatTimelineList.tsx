import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  ChatTimelineLayout,
  type TimelineVisibleRange,
} from "@/features/chat/lib/chat-timeline-layout";
import type { ChatScrollListRef } from "./chat-timeline-list-types";

export type ChatTimelineListRenderItemInfo<T> = {
  item: T;
  index: number;
};

type ChatTimelineListProps<T> = {
  data: readonly T[];
  resetKey: string | null;
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: ChatTimelineListRenderItemInfo<T>) => ReactNode;
  estimateItemSize: (item: T, index: number) => number;
  listRef?: RefObject<ChatScrollListRef | null>;
  drawDistance?: number;
  maxMountedItems?: number;
  alignItemsAtEnd?: boolean;
  initialScrollAtEnd?: boolean;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  className?: string;
  contentContainerStyle?: CSSProperties;
  style?: CSSProperties;
};

const DEFAULT_VIEWPORT_PX = 940;
const DEFAULT_MAX_MOUNTED_ITEMS = 240;
const AT_END_PX = 1;

const numericStyle = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const assignRef = <T,>(ref: Ref<T> | undefined, value: T | null): void => {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T | null }).current = value;
};

const sameRange = (
  left: TimelineVisibleRange,
  right: TimelineVisibleRange,
): boolean => left.start === right.start && left.end === right.end;

/**
 * Web-only virtualizer for the full desktop transcript. Unlike Legend v3,
 * its structural state is a prependable block list rather than one position
 * array indexed from zero, so a page arrival only touches the new page.
 */
export function ChatTimelineList<T>({
  data,
  resetKey,
  keyExtractor,
  renderItem,
  estimateItemSize,
  listRef,
  drawDistance = 300,
  maxMountedItems = DEFAULT_MAX_MOUNTED_ITEMS,
  alignItemsAtEnd = false,
  initialScrollAtEnd = false,
  ListHeaderComponent,
  ListFooterComponent,
  className,
  contentContainerStyle,
  style,
}: ChatTimelineListProps<T>) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const layoutRef = useRef(new ChatTimelineLayout());
  const resetKeyRef = useRef<string | null | undefined>(undefined);
  const headerSizeRef = useRef(0);
  const footerSizeRef = useRef(0);
  const viewportSizeRef = useRef(0);
  const scrollTopRef = useRef(0);
  const measurementAnchorKeyRef = useRef<string | null>(null);
  const userScrollIntentRef = useRef(false);
  const alignExtraTopRef = useRef(0);
  const contentLengthRef = useRef(0);
  const pendingPrependPxRef = useRef(0);
  const lastPrependAppliedRef = useRef({ requested: 0, applied: 0 });
  const pendingResetRef = useRef(false);
  const pendingEndPinRef = useRef(false);
  const didInitialEndRef = useRef(false);
  const layoutRevisionRef = useRef(0);
  const rangeRef = useRef<TimelineVisibleRange>({ start: 0, end: 0 });
  const [, setRange] = useState<TimelineVisibleRange>({
    start: 0,
    end: 0,
  });

  const configRef = useRef({
    paddingTop: 0,
    paddingBottom: 0,
    overscan: 0,
    maxMountedItems: DEFAULT_MAX_MOUNTED_ITEMS,
    alignItemsAtEnd: false,
  });
  configRef.current = {
    paddingTop: numericStyle(contentContainerStyle?.paddingTop),
    paddingBottom: numericStyle(contentContainerStyle?.paddingBottom),
    overscan: Math.max(0, drawDistance),
    maxMountedItems: Math.max(1, maxMountedItems),
    alignItemsAtEnd,
  };

  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    layoutRef.current.clear();
    headerSizeRef.current = 0;
    footerSizeRef.current = 0;
    scrollTopRef.current = 0;
    measurementAnchorKeyRef.current = null;
    userScrollIntentRef.current = false;
    alignExtraTopRef.current = 0;
    contentLengthRef.current = 0;
    pendingPrependPxRef.current = 0;
    lastPrependAppliedRef.current = { requested: 0, applied: 0 };
    pendingResetRef.current = true;
    pendingEndPinRef.current = false;
    didInitialEndRef.current = false;
    layoutRevisionRef.current += 1;
    rangeRef.current = { start: 0, end: 0 };
  }

  const layout = layoutRef.current;
  const previousLength = contentLengthRef.current;
  const previousViewport = viewportSizeRef.current;
  const wasAtEnd =
    previousLength > 0 &&
    previousLength - previousViewport - scrollTopRef.current <= AT_END_PX;
  let reconcile = layout.reconcile({
    itemCount: data.length,
    keyAt: (index) => keyExtractor(data[index]!, index),
    estimateAt: (index) => estimateItemSize(data[index]!, index),
  });
  if (reconcile.operation !== "none") {
    layoutRevisionRef.current += 1;
  }
  if (reconcile.prependedSize > 0) {
    pendingPrependPxRef.current += reconcile.prependedSize;
  } else if (reconcile.appendCount > 0 && wasAtEnd) {
    pendingEndPinRef.current = true;
  }

  let renderRange = rangeRef.current;
  if (reconcile.prependCount > 0 && renderRange.end > 0) {
    renderRange = {
      start: renderRange.start + reconcile.prependCount,
      end: renderRange.end + reconcile.prependCount,
    };
    rangeRef.current = renderRange;
  }
  const estimatedViewport = viewportSizeRef.current || DEFAULT_VIEWPORT_PX;
  if (renderRange.end === 0 && data.length > 0) {
    const initialOffset = initialScrollAtEnd
      ? Math.max(0, layout.contentSize - estimatedViewport)
      : 0;
    renderRange = layout.visibleRange({
      scrollOffset: initialOffset,
      viewportSize: estimatedViewport,
      overscan: configRef.current.overscan,
      maxItems: configRef.current.maxMountedItems,
    });
    rangeRef.current = renderRange;
  }

  // Stable endpoints are sufficient for the normal chat mutations. Probe the
  // entire bounded mounted window so a rare interior replacement rebuilds
  // before a row can inherit another key's measured slot.
  if (renderRange.end > renderRange.start) {
    let mismatch = false;
    for (
      let index = renderRange.start;
      index < Math.min(data.length, renderRange.end);
      index += 1
    ) {
      if (layout.keyAt(index) !== keyExtractor(data[index]!, index)) {
        mismatch = true;
        break;
      }
    }
    if (mismatch) {
      layout.clear();
      reconcile = layout.reconcile({
        itemCount: data.length,
        keyAt: (index) => keyExtractor(data[index]!, index),
        estimateAt: (index) => estimateItemSize(data[index]!, index),
      });
      layoutRevisionRef.current += 1;
      const offset = Math.max(0, scrollTopRef.current);
      renderRange = layout.visibleRange({
        scrollOffset: offset,
        viewportSize: estimatedViewport,
        overscan: configRef.current.overscan,
        maxItems: configRef.current.maxMountedItems,
      });
      rangeRef.current = renderRange;
    }
  }

  const layoutRevision = layoutRevisionRef.current;

  const baseOffset = useCallback(
    (): number =>
      alignExtraTopRef.current +
      configRef.current.paddingTop +
      headerSizeRef.current,
    [],
  );

  const calculateContentLength = useCallback(
    (): number =>
      alignExtraTopRef.current +
      configRef.current.paddingTop +
      headerSizeRef.current +
      layout.contentSize +
      footerSizeRef.current +
      configRef.current.paddingBottom,
    [layout],
  );

  const calculateAlignment = useCallback((): number => {
    if (!configRef.current.alignItemsAtEnd) return 0;
    const viewport = viewportSizeRef.current;
    if (viewport <= 0) return 0;
    const unaligned =
      configRef.current.paddingTop +
      headerSizeRef.current +
      layout.contentSize +
      footerSizeRef.current +
      configRef.current.paddingBottom;
    return Math.max(0, viewport - unaligned);
  }, [layout]);

  const commitRange = useCallback((next: TimelineVisibleRange) => {
    if (sameRange(rangeRef.current, next)) return;
    rangeRef.current = next;
    setRange(next);
  }, []);

  const refreshRange = useCallback((syncIfParked = false) => {
    const currentLayout = layoutRef.current;
    const config = configRef.current;
    const scrollOffset = Math.max(
      0,
      scrollTopRef.current -
        alignExtraTopRef.current -
        config.paddingTop -
        headerSizeRef.current,
    );
    const next = currentLayout.visibleRange({
      scrollOffset,
      viewportSize: viewportSizeRef.current || DEFAULT_VIEWPORT_PX,
      overscan: config.overscan,
      maxItems: config.maxMountedItems,
    });
    const visibleIndex = currentLayout.indexAtOffset(scrollOffset);
    const current = rangeRef.current;
    const viewportIsParked =
      visibleIndex < current.start || visibleIndex >= current.end;
    if (syncIfParked && viewportIsParked) {
      flushSync(() => commitRange(next));
    } else {
      commitRange(next);
    }
  }, [commitRange]);

  const writeGeometry = useCallback(() => {
    const currentLayout = layoutRef.current;
    alignExtraTopRef.current = calculateAlignment();
    const base = baseOffset();
    const canvas = canvasRef.current;
    const header = headerRef.current;
    const footer = footerRef.current;
    const contentLength = calculateContentLength();
    contentLengthRef.current = contentLength;
    if (canvas) canvas.style.height = `${contentLength}px`;
    if (header) {
      header.style.top = `${alignExtraTopRef.current + configRef.current.paddingTop}px`;
    }
    if (footer) {
      footer.style.top = `${base + currentLayout.contentSize}px`;
    }
    for (const [key, element] of itemRefs.current) {
      const offset = currentLayout.offsetForKey(key);
      if (offset !== null) element.style.top = `${base + offset}px`;
    }
  }, [baseOffset, calculateAlignment, calculateContentLength]);

  const captureMeasurementAnchor = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const viewport = node.getBoundingClientRect();
    const anchor = Array.from(itemRefs.current.values())
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) =>
          rect.bottom > viewport.top + 0.5 &&
          rect.top < viewport.bottom - 0.5,
      )
      .sort((left, right) => left.rect.top - right.rect.top)[0];
    measurementAnchorKeyRef.current =
      anchor?.element.dataset.chatTimelineKey ?? null;
  }, []);

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    viewportSizeRef.current = node.clientHeight;
    if (pendingResetRef.current) {
      pendingResetRef.current = false;
      node.scrollTop = 0;
      scrollTopRef.current = 0;
    }
    writeGeometry();
    const prepend = pendingPrependPxRef.current;
    pendingPrependPxRef.current = 0;
    if (prepend > 0) {
      const before = node.scrollTop;
      node.scrollTop += prepend;
      scrollTopRef.current = node.scrollTop;
      lastPrependAppliedRef.current = {
        requested: prepend,
        applied: node.scrollTop - before,
      };
    }
    if (
      initialScrollAtEnd &&
      !didInitialEndRef.current &&
      data.length > 0
    ) {
      didInitialEndRef.current = true;
      node.scrollTop = Math.max(
        0,
        contentLengthRef.current - viewportSizeRef.current,
      );
      scrollTopRef.current = node.scrollTop;
    } else if (pendingEndPinRef.current) {
      pendingEndPinRef.current = false;
      node.scrollTop = Math.max(
        0,
        contentLengthRef.current - viewportSizeRef.current,
      );
      scrollTopRef.current = node.scrollTop;
    }
    if (!sameRange(rangeRef.current, renderRange)) {
      rangeRef.current = renderRange;
      setRange(renderRange);
    }
    refreshRange();
  }, [
    data.length,
    initialScrollAtEnd,
    layoutRevision,
    renderRange,
    refreshRange,
    writeGeometry,
  ]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const onUserScrollIntent = () => {
      userScrollIntentRef.current = true;
      measurementAnchorKeyRef.current = null;
    };
    const onScroll = () => {
      scrollTopRef.current = node.scrollTop;
      refreshRange(true);
      const currentAnchor = measurementAnchorKeyRef.current;
      const currentAnchorElement = currentAnchor
        ? itemRefs.current.get(currentAnchor)
        : null;
      const anchorRect = currentAnchorElement?.getBoundingClientRect();
      const viewportRect = node.getBoundingClientRect();
      const anchorIntersectsViewport =
        anchorRect !== undefined &&
        anchorRect.bottom > viewportRect.top + 0.5 &&
        anchorRect.top < viewportRect.bottom - 0.5;
      if (
        userScrollIntentRef.current ||
        !currentAnchor ||
        !anchorIntersectsViewport
      ) {
        captureMeasurementAnchor();
      }
      userScrollIntentRef.current = false;
    };
    node.addEventListener("wheel", onUserScrollIntent, { passive: true });
    node.addEventListener("pointerdown", onUserScrollIntent, { passive: true });
    node.addEventListener("touchstart", onUserScrollIntent, { passive: true });
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("wheel", onUserScrollIntent);
      node.removeEventListener("pointerdown", onUserScrollIntent);
      node.removeEventListener("touchstart", onUserScrollIntent);
      node.removeEventListener("scroll", onScroll);
    };
  }, [captureMeasurementAnchor, refreshRange]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const currentLayout = layoutRef.current;
      const config = configRef.current;
      const oldBase =
        alignExtraTopRef.current + config.paddingTop + headerSizeRef.current;
      const stableAnchorIndex = measurementAnchorKeyRef.current
        ? currentLayout.indexForKey(measurementAnchorKeyRef.current)
        : null;
      let anchorIndex =
        stableAnchorIndex ??
        currentLayout.indexAtOffset(
          Math.max(0, scrollTopRef.current - oldBase),
        );
      let anchorAdjustment = 0;
      let geometryChanged = false;
      const rowEntries: Array<{ entry: ResizeObserverEntry; index: number }> = [];

      for (const entry of entries) {
        if (entry.target === node) {
          const height = entry.contentRect.height;
          if (Math.abs(height - viewportSizeRef.current) >= 0.25) {
            viewportSizeRef.current = height;
            geometryChanged = true;
          }
          continue;
        }
        if (entry.target === headerRef.current) {
          const height = entry.contentRect.height;
          const delta = height - headerSizeRef.current;
          if (Math.abs(delta) >= 0.25) {
            if (scrollTopRef.current > oldBase + 0.5) {
              anchorAdjustment += delta;
            }
            headerSizeRef.current = height;
            geometryChanged = true;
          }
          continue;
        }
        if (entry.target === footerRef.current) {
          const height = entry.contentRect.height;
          if (Math.abs(height - footerSizeRef.current) >= 0.25) {
            footerSizeRef.current = height;
            geometryChanged = true;
          }
          continue;
        }
        const element = entry.target as HTMLElement;
        const index = Number(element.dataset.chatTimelineIndex);
        if (Number.isFinite(index)) rowEntries.push({ entry, index });
      }

      rowEntries.sort((left, right) => left.index - right.index);
      // Estimates can identify a different row than the one actually crossing
      // the viewport after a large jump. Anchor measurement corrections to the
      // real mounted geometry so every newly measured row visually above it is
      // compensated, including rows the estimate placed below the viewport.
      const entryHeights = new Map(
        rowEntries.map(({ entry }) => [entry.target, entry.contentRect.height]),
      );
      const hasFirstMeasurement = rowEntries.some(({ entry }) => {
        const key = (entry.target as HTMLElement).dataset.chatTimelineKey;
        return key ? !currentLayout.isMeasuredKey(key) : false;
      });
      if (stableAnchorIndex === null && hasFirstMeasurement) {
        const mountedGeometry = Array.from(itemRefs.current.values())
          .map((element) => ({
            element,
            index: Number(element.dataset.chatTimelineIndex),
          }))
          .filter(({ index }) => Number.isFinite(index))
          .sort((left, right) => left.index - right.index);
        for (const { element, index } of mountedGeometry) {
          const top = Number.parseFloat(element.style.top);
          const observedHeight = entryHeights.get(element);
          const height =
            observedHeight ?? element.getBoundingClientRect().height;
          if (
            Number.isFinite(top) &&
            height > 0 &&
            top + height > scrollTopRef.current + 0.5
          ) {
            anchorIndex = index;
            break;
          }
        }
      }
      for (const { entry } of rowEntries) {
        const element = entry.target as HTMLElement;
        const key = element.dataset.chatTimelineKey;
        if (!key) continue;
        const measurement = currentLayout.measure(
          key,
          entry.contentRect.height,
        );
        if (!measurement.changed) continue;
        if (measurement.index < anchorIndex) {
          anchorAdjustment += measurement.delta;
        }
        geometryChanged = true;
      }

      if (!geometryChanged) return;
      writeGeometry();
      if (Math.abs(anchorAdjustment) >= 0.1) {
        node.scrollTop += anchorAdjustment;
        scrollTopRef.current = node.scrollTop;
      }
      refreshRange();
    });
    observer.observe(node);
    if (headerRef.current) observer.observe(headerRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    for (const element of itemRefs.current.values()) observer.observe(element);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [refreshRange, writeGeometry]);

  const setItemNode = useCallback(
    (key: string, node: HTMLDivElement | null) => {
      const observer = observerRef.current;
      const previous = itemRefs.current.get(key);
      if (previous && observer) observer.unobserve(previous);
      if (!node) {
        itemRefs.current.delete(key);
        return;
      }
      itemRefs.current.set(key, node);
      observer?.observe(node);
    },
    [],
  );

  const setHeaderNode = useCallback((node: HTMLDivElement | null) => {
    const previous = headerRef.current;
    if (previous) observerRef.current?.unobserve(previous);
    headerRef.current = node;
    if (node) observerRef.current?.observe(node);
  }, []);

  const setFooterNode = useCallback((node: HTMLDivElement | null) => {
    const previous = footerRef.current;
    if (previous) observerRef.current?.unobserve(previous);
    footerRef.current = node;
    if (node) observerRef.current?.observe(node);
  }, []);

  useLayoutEffect(() => {
    const handle: ChatScrollListRef = {
      preservesPrependAnchor: true,
      getScrollableNode: () => {
        const node = scrollerRef.current;
        if (!node) throw new Error("Chat timeline scroller is not mounted");
        return node;
      },
      getState: () => {
        const node = scrollerRef.current;
        const scroll = node?.scrollTop ?? scrollTopRef.current;
        const scrollLength = node?.clientHeight ?? viewportSizeRef.current;
        const contentLength = contentLengthRef.current;
        return {
          scroll,
          scrollLength,
          contentLength,
          isAtEnd:
            contentLength - scrollLength - scroll <= AT_END_PX,
        };
      },
      scrollToEnd: ({ animated } = {}) => {
        const node = scrollerRef.current;
        if (!node) return;
        node.scrollTo({
          top: Math.max(0, contentLengthRef.current - node.clientHeight),
          behavior: animated ? "smooth" : "auto",
        });
      },
      getDebugState: () => ({
        ...layoutRef.current.debug(),
        mountedCount: itemRefs.current.size,
        lastPrependRequested: lastPrependAppliedRef.current.requested,
        lastPrependApplied: lastPrependAppliedRef.current.applied,
      }),
    };
    assignRef(listRef, handle);
    return () => assignRef(listRef, null);
  }, [listRef]);

  const mounted: ReactNode[] = [];
  const mountedRange = renderRange;
  const renderBase =
    alignExtraTopRef.current +
    configRef.current.paddingTop +
    headerSizeRef.current;
  for (
    let index = mountedRange.start;
    index < Math.min(data.length, mountedRange.end);
    index += 1
  ) {
    const item = data[index];
    if (item === undefined) continue;
    const key = keyExtractor(item, index);
    mounted.push(
      <div
        key={key}
        ref={(node) => setItemNode(key, node)}
        data-chat-timeline-key={key}
        data-chat-timeline-index={index}
        style={{
          position: "absolute",
          top: renderBase + layout.offsetForIndex(index),
          left: 0,
          right: 0,
          width: "100%",
        }}
      >
        {renderItem({ item, index })}
      </div>,
    );
  }

  alignExtraTopRef.current = calculateAlignment();
  contentLengthRef.current = calculateContentLength();
  const canvasStyle: CSSProperties = {
    ...contentContainerStyle,
    paddingTop: 0,
    paddingBottom: 0,
    position: "relative",
    height: contentLengthRef.current,
    boxSizing: "border-box",
  };

  return (
    <div
      ref={scrollerRef}
      className={className}
      data-chat-timeline-list="incremental"
      data-chat-timeline-mounted={mounted.length}
      style={{
        height: "100%",
        width: "100%",
        overflow: "auto",
        position: "relative",
        ...style,
      }}
    >
      <div ref={canvasRef} style={canvasStyle}>
        {ListHeaderComponent ? (
          <div
            ref={setHeaderNode}
            data-chat-timeline-header="true"
            style={{
              position: "absolute",
              top:
                alignExtraTopRef.current + configRef.current.paddingTop,
              left: 0,
              right: 0,
              width: "100%",
            }}
          >
            {ListHeaderComponent}
          </div>
        ) : null}
        {mounted}
        {ListFooterComponent ? (
          <div
            ref={setFooterNode}
            data-chat-timeline-footer="true"
            style={{
              position: "absolute",
              top: baseOffset() + layout.contentSize,
              left: 0,
              right: 0,
              width: "100%",
            }}
          >
            {ListFooterComponent}
          </div>
        ) : null}
      </div>
    </div>
  );
}
