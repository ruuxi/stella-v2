export const HISTORY_START_THRESHOLD_VIEWPORTS = 4;

export type HistoryScrollDirection = "up" | "down" | "none";

export type HistoryPaginationMetrics = {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
};

export type HistoryPaginationGuards = {
  hasMore: boolean;
  isLoading: boolean;
};

export type HistoryPaginationDecision = {
  request: boolean;
  reason:
    | "request"
    | "not-upward"
    | "outside-threshold"
    | "action-consumed"
    | "in-flight"
    | "end-of-history";
  thresholdVisible: boolean;
};

type RequestPhase = "idle" | "awaiting-loading" | "loading";

/**
 * Intent gate for older-history pagination.
 *
 * Legend List intentionally re-fires `onStartReached` when data changes while
 * the start threshold remains visible. That behavior is useful for ordinary
 * feeds, but a prepend turns one chat scroll gesture into a request cascade.
 * This gate makes a user action, rather than content identity, the unit of
 * pagination. An action id can be consumed at most once while a request is
 * in flight. After that request settles, the same still-active upward
 * flick may load the next older cursor so a continuous trackpad gesture
 * is not starved by the 160ms wheel-idle split. Layout, measurement, and
 * MVCP restore never create an action, so sitting still at the lead
 * cannot cascade.
 */
export class ChatHistoryPaginationGate {
  private consumedActionIds = new Set<number>();
  private requestPhase: RequestPhase = "idle";

  syncGuards(guards: HistoryPaginationGuards): {
    requestStarted: boolean;
    requestSettled: boolean;
  } {
    const previous = this.requestPhase;

    // Subscription re-keying briefly reports `hasMore=false` while retaining
    // the prior rows. Loading wins over that transient so the accepted request
    // cannot settle until its larger window actually resolves.
    if (guards.isLoading) {
      this.requestPhase = "loading";
    } else if (this.requestPhase === "loading") {
      this.requestPhase = "idle";
    } else if (!guards.hasMore) {
      this.requestPhase = "idle";
    }

    return {
      requestStarted:
        previous === "awaiting-loading" && this.requestPhase === "loading",
      requestSettled: previous !== "idle" && this.requestPhase === "idle",
    };
  }

  consider(
    actionId: number | null,
    direction: HistoryScrollDirection,
    metrics: HistoryPaginationMetrics,
    guards: HistoryPaginationGuards,
  ): HistoryPaginationDecision {
    this.syncGuards(guards);

    const thresholdVisible =
      metrics.scrollTop <=
      metrics.viewportHeight * HISTORY_START_THRESHOLD_VIEWPORTS;

    if (direction !== "up" || actionId === null) {
      return { request: false, reason: "not-upward", thresholdVisible };
    }
    if (!thresholdVisible) {
      return {
        request: false,
        reason: "outside-threshold",
        thresholdVisible,
      };
    }
    if (this.consumedActionIds.has(actionId) && this.requestPhase !== "idle") {
      return {
        request: false,
        reason: "in-flight",
        thresholdVisible,
      };
    }
    if (!this.consumedActionIds.has(actionId)) {
      this.consumedActionIds.add(actionId);
      if (this.consumedActionIds.size > 64) {
        const oldest = this.consumedActionIds.values().next().value;
        if (oldest !== undefined) this.consumedActionIds.delete(oldest);
      }
    }

    if (guards.isLoading || this.requestPhase !== "idle") {
      return { request: false, reason: "in-flight", thresholdVisible };
    }
    if (!guards.hasMore) {
      return {
        request: false,
        reason: "end-of-history",
        thresholdVisible,
      };
    }

    // A newly-created upward action is an explicit re-arm even if the user is
    // still within the threshold after the previous prepend. Moving away and
    // approaching again also arrives under a fresh input action; content and
    // measurement updates never manufacture one.
    this.requestPhase = "awaiting-loading";
    return { request: true, reason: "request", thresholdVisible };
  }

  rejectRequest(): void {
    if (this.requestPhase === "awaiting-loading") {
      this.requestPhase = "idle";
    }
  }

  snapshot() {
    return {
      requestPhase: this.requestPhase,
      consumedActionIds: [...this.consumedActionIds],
    };
  }
}

export type ChatPrependAnchorRow = {
  rowId: string;
  viewportOffset: number;
};

export type ChatPrependAnchor = {
  rowId: string;
  viewportOffset: number;
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
  extraRows: ChatPrependAnchorRow[];
};

const chatRows = (node: HTMLElement): HTMLElement[] =>
  Array.from(node.querySelectorAll<HTMLElement>("[data-chat-row-id]"));

const MAX_CAPTURED_ANCHOR_ROWS = 8;
const MVCP_UNAPPLIED_SCROLL_PX = 1;

const paintedRowsFromTop = (node: HTMLElement) => {
  const viewport = node.getBoundingClientRect();
  return chatRows(node)
    .map((candidate) => ({
      candidate,
      rect: candidate.getBoundingClientRect(),
    }))
    .filter(({ rect }) => rect.bottom > viewport.top + 0.5)
    .sort((a, b) => a.rect.top - b.rect.top)
    .map(({ candidate, rect }) => ({
      rowId: candidate.dataset.chatRowId ?? "",
      viewportOffset: rect.top - viewport.top,
      candidate,
    }))
    .filter((row) => row.rowId.length > 0);
};

/** Capture the first painted row intersecting the viewport's top edge. */
export const captureChatPrependAnchor = (
  node: HTMLElement,
): ChatPrependAnchor | null => {
  // Recycled Legend containers are not guaranteed to remain in visual DOM
  // order, so geometry — not querySelector order — chooses the top anchor.
  const painted = paintedRowsFromTop(node);
  const top = painted[0];
  if (!top) return null;

  return {
    rowId: top.rowId,
    viewportOffset: top.viewportOffset,
    scrollTop: node.scrollTop,
    viewportHeight: node.clientHeight,
    contentHeight: node.scrollHeight,
    extraRows: painted.slice(1, MAX_CAPTURED_ANCHOR_ROWS).map((row) => ({
      rowId: row.rowId,
      viewportOffset: row.viewportOffset,
    })),
  };
};

export type ChatPrependAnchorRestore = {
  found: boolean;
  adjustment: number;
  scrollTopBefore: number;
  scrollTopAfter: number;
  viewportOffsetAfter: number | null;
  contentHeightAfter: number;
  strategy: "row" | "content-delta" | "miss";
};

const restoreFromMountedRow = (
  node: HTMLElement,
  row: HTMLElement,
  targetOffset: number,
): ChatPrependAnchorRestore => {
  const scrollTopBefore = node.scrollTop;
  const viewport = node.getBoundingClientRect();
  const offsetBefore = row.getBoundingClientRect().top - viewport.top;
  const adjustment = offsetBefore - targetOffset;
  if (Math.abs(adjustment) > 0.1) node.scrollTop += adjustment;

  const viewportOffsetAfter =
    row.getBoundingClientRect().top - node.getBoundingClientRect().top;
  return {
    found: true,
    adjustment,
    scrollTopBefore,
    scrollTopAfter: node.scrollTop,
    viewportOffsetAfter,
    contentHeightAfter: node.scrollHeight,
    strategy: "row",
  };
};

const mvcpLooksUnapplied = (node: HTMLElement, anchor: ChatPrependAnchor) =>
  Math.abs(node.scrollTop - anchor.scrollTop) <= MVCP_UNAPPLIED_SCROLL_PX;

/**
 * Correct any residual MVCP error after a prepend. Legend remains the primary
 * anchor owner; this only writes when a captured row's painted viewport offset
 * differs, so an exact MVCP result is a zero-write no-op.
 *
 * Legend recycles containers, so the top row from capture may be unmounted by
 * the time the older page lands. Extra captured rows and the content-height
 * delta are last resorts for that miss, and only when scrollTop still matches
 * the pre-prepend value — meaning MVCP did not move the viewport. Applying
 * them after an MVCP shift (or after continued user scrolling) fights the
 * user and produces multi-thousand-pixel jumps.
 */
export const restoreChatPrependAnchor = (
  node: HTMLElement,
  anchor: ChatPrependAnchor,
): ChatPrependAnchorRestore => {
  const mounted = chatRows(node);
  const primary = mounted.find((item) => item.dataset.chatRowId === anchor.rowId);
  if (primary) {
    return restoreFromMountedRow(node, primary, anchor.viewportOffset);
  }

  const unapplied = mvcpLooksUnapplied(node, anchor);
  if (unapplied) {
    for (const candidate of anchor.extraRows ?? []) {
      const row = mounted.find(
        (item) => item.dataset.chatRowId === candidate.rowId,
      );
      if (row) {
        return restoreFromMountedRow(node, row, candidate.viewportOffset);
      }
    }
  }

  const scrollTopBefore = node.scrollTop;
  const contentHeightAfter = node.scrollHeight;
  const contentDelta = contentHeightAfter - anchor.contentHeight;
  if (unapplied && contentDelta > 0.5) {
    node.scrollTop = scrollTopBefore + contentDelta;
    return {
      found: false,
      adjustment: contentDelta,
      scrollTopBefore,
      scrollTopAfter: node.scrollTop,
      viewportOffsetAfter: null,
      contentHeightAfter,
      strategy: "content-delta",
    };
  }

  return {
    found: false,
    adjustment: 0,
    scrollTopBefore,
    scrollTopAfter: node.scrollTop,
    viewportOffsetAfter: null,
    contentHeightAfter,
    strategy: "miss",
  };
};

export type ChatHistoryPaginationDebugEvent = {
  type: string;
  surface: "full" | "compact";
  detail: Record<string, unknown>;
};

/** Opt-in live diagnostics used by the isolated dev harness. */
export const emitChatHistoryPaginationDebug = (
  event: ChatHistoryPaginationDebugEvent,
): void => {
  if (typeof window === "undefined") return;
  const debugWindow = window as Window & {
    __STELLA_CHAT_PAGINATION_DEBUG__?: boolean;
  };
  if (!debugWindow.__STELLA_CHAT_PAGINATION_DEBUG__) return;
  window.dispatchEvent(
    new CustomEvent("stella:chat-history-pagination", { detail: event }),
  );
  console.debug("[chat-history-pagination]", event);
};
