export const HISTORY_START_THRESHOLD_VIEWPORTS = 2;

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
    | "wrong-direction"
    | "outside-threshold"
    | "action-consumed"
    | "in-flight"
    | "end-of-history";
  thresholdVisible: boolean;
};

type RequestPhase = "idle" | "awaiting-loading" | "loading";

export class ChatHistoryPaginationGate {
  private readonly edge: "start" | "end";
  private consumedActionIds = new Set<number>();
  private requestPhase: RequestPhase = "idle";
  private settledSinceLastSync = false;

  constructor(edge: "start" | "end" = "start") {
    this.edge = edge;
  }

  syncGuards(guards: HistoryPaginationGuards): {
    requestStarted: boolean;
    requestSettled: boolean;
  } {
    const previous = this.requestPhase;
    const externallySettled = this.settledSinceLastSync;
    this.settledSinceLastSync = false;

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
      requestSettled:
        externallySettled ||
        (previous !== "idle" && this.requestPhase === "idle"),
    };
  }

  consider(
    actionId: number | null,
    direction: HistoryScrollDirection,
    metrics: HistoryPaginationMetrics,
    guards: HistoryPaginationGuards,
  ): HistoryPaginationDecision {
    this.syncGuards(guards);

    const edgeDistance =
      this.edge === "start"
        ? metrics.scrollTop
        : Math.max(
            0,
            metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop,
          );
    const thresholdVisible =
      edgeDistance <=
      metrics.viewportHeight * HISTORY_START_THRESHOLD_VIEWPORTS;

    const requiredDirection = this.edge === "start" ? "up" : "down";
    if (direction !== requiredDirection || actionId === null) {
      return { request: false, reason: "wrong-direction", thresholdVisible };
    }
    if (!thresholdVisible) {
      return {
        request: false,
        reason: "outside-threshold",
        thresholdVisible,
      };
    }
    if (this.consumedActionIds.has(actionId)) {
      return {
        request: false,
        reason: "action-consumed",
        thresholdVisible,
      };
    }

    this.consumedActionIds.add(actionId);
    if (this.consumedActionIds.size > 64) {
      const oldest = this.consumedActionIds.values().next().value;
      if (oldest !== undefined) this.consumedActionIds.delete(oldest);
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

    this.requestPhase = "awaiting-loading";
    return { request: true, reason: "request", thresholdVisible };
  }

  rejectRequest(): void {
    if (this.requestPhase === "awaiting-loading") {
      this.requestPhase = "idle";
    }
  }

  settleRequest(): boolean {
    if (this.requestPhase === "idle") return false;
    this.requestPhase = "idle";
    this.settledSinceLastSync = true;
    return true;
  }

  snapshot() {
    return {
      requestPhase: this.requestPhase,
      consumedActionIds: [...this.consumedActionIds],
    };
  }
}

export type ChatPrependAnchor = {
  rowId: string;
  viewportOffset: number;
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
};

const chatRows = (node: HTMLElement): HTMLElement[] =>
  Array.from(node.querySelectorAll<HTMLElement>("[data-chat-row-id]"));

export const captureChatPrependAnchor = (
  node: HTMLElement,
): ChatPrependAnchor | null => {
  const viewport = node.getBoundingClientRect();
  const rows = chatRows(node)
    .map((candidate) => ({
      candidate,
      rect: candidate.getBoundingClientRect(),
    }))
    .filter(({ rect }) => rect.bottom > viewport.top)
    .sort((a, b) => a.rect.top - b.rect.top);

  const row = rows[0]?.candidate;
  const rowId = row?.dataset.chatRowId;
  if (!row || !rowId) return null;

  return {
    rowId,
    viewportOffset: row.getBoundingClientRect().top - viewport.top,
    scrollTop: node.scrollTop,
    viewportHeight: node.clientHeight,
    contentHeight: node.scrollHeight,
  };
};

export type ChatPrependAnchorRestore = {
  found: boolean;
  adjustment: number;
  scrollTopBefore: number;
  scrollTopAfter: number;
  viewportOffsetAfter: number | null;
  contentHeightAfter: number;
};

export const restoreChatPrependAnchor = (
  node: HTMLElement,
  anchor: ChatPrependAnchor,
): ChatPrependAnchorRestore => {
  const row = chatRows(node).find(
    (candidate) => candidate.dataset.chatRowId === anchor.rowId,
  );
  const scrollTopBefore = node.scrollTop;
  if (!row) {
    return {
      found: false,
      adjustment: 0,
      scrollTopBefore,
      scrollTopAfter: node.scrollTop,
      viewportOffsetAfter: null,
      contentHeightAfter: node.scrollHeight,
    };
  }

  const viewport = node.getBoundingClientRect();
  const offsetBefore = row.getBoundingClientRect().top - viewport.top;
  const adjustment = offsetBefore - anchor.viewportOffset;
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
  };
};

export class ChatPrependAnchorStabilizer {
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private stopped = false;

  constructor(
    private readonly node: HTMLElement,
    private readonly anchor: ChatPrependAnchor,
    private readonly onRestore?: (result: ChatPrependAnchorRestore) => void,
  ) {}

  start(): void {
    if (this.stopped || typeof ResizeObserver === "undefined") return;
    const anchorRow = chatRows(this.node).find(
      (row) => row.dataset.chatRowId === this.anchor.rowId,
    );
    if (!anchorRow) return;
    const anchorTop = anchorRow.getBoundingClientRect().top;
    this.resizeObserver = new ResizeObserver(() => this.scheduleRestore());
    for (const row of chatRows(this.node)) {
      if (row.getBoundingClientRect().top <= anchorTop + 0.5) {
        this.resizeObserver.observe(row);
      }
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private scheduleRestore(): void {
    if (this.stopped || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.stopped) return;
      const result = restoreChatPrependAnchor(this.node, this.anchor);
      if (!result.found) {
        this.stop();
        return;
      }
      this.onRestore?.(result);
    });
  }
}

export type ChatHistoryPaginationDebugEvent = {
  type: string;
  surface: "full" | "compact";
  detail: Record<string, unknown>;
};

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
