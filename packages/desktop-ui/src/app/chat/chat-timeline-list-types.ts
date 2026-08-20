import type { TimelineLayoutDebug } from "@/features/chat/lib/chat-timeline-layout";

export type ChatScrollListState = {
  scroll: number;
  scrollLength: number;
  contentLength: number;
  isAtEnd: boolean;
};

export type ChatTimelineDebugState = TimelineLayoutDebug & {
  mountedCount: number;
  lastPrependRequested: number;
  lastPrependApplied: number;
};

/** Shared subset implemented by Legend List and the full-chat virtualizer. */
export type ChatScrollListRef = {
  /** The list preserves the visible row itself when data is prepended. */
  preservesPrependAnchor?: boolean;
  getScrollableNode(): HTMLElement;
  getState(): ChatScrollListState;
  scrollToEnd(options?: { animated?: boolean }): Promise<void> | void;
  getDebugState?(): ChatTimelineDebugState;
};
