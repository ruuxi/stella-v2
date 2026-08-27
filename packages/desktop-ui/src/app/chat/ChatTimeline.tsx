import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react";
import {
  getFixedRowHeight,
  measureTranscriptRowMetrics,
  type TranscriptRowMetrics,
} from "@/features/chat/pretext/row-metrics";
import {
  AssistantMessageRow,
  UserMessageRow,
} from "@/app/chat/MessageRow";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";
import {
  InlineWorkingIndicator,
  type InlineWorkingIndicatorMountProps,
} from "./InlineWorkingIndicator";
import type { QueuedUserMessage } from "@/features/chat/hooks/queued-user-messages";
import {
  buildChatTimelineItems,
  type ChatTimelineItem,
} from "@/features/chat/lib/chat-timeline-items";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import { LoaderCircle } from "@/ui/icons";
import { useT } from "@/shared/i18n";

type ChatTimelineProps = {
  rows: EventRowViewModel[];
  conversationId?: string | null;
  agentModelConfigByThread?: AgentModelConfigsByThread;
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  emptyState?: React.ReactNode;

  extraTail?: React.ReactNode;
  queuedUserMessages?: QueuedUserMessage[];

  onCancelQueued?: (message: QueuedUserMessage) => void;

  indicator?: InlineWorkingIndicatorMountProps;

  listRef?: RefObject<LegendListRef | null>;

  recycleItems?: boolean;

  alignItemsAtEnd?: boolean;

  estimatedItemSize?: number;

  className?: string;

  contentContainerStyle?: CSSProperties;
};

const ROW_GAP = 30;

const ASSISTANT_RUN_GAP = 8;

const USER_RUN_GAP = 10;

const CARD_RUN_GAP = 8;

const isCardRow = (row: EventRowViewModel): boolean =>
  row.kind === "assistant" &&
  row.text.trim().length === 0 &&
  Boolean(
    row.resourcePayload ||
    row.sourceDiffPayloads?.length ||
    row.inlineImagePayloads?.length ||
    row.officePreviewRef ||
    row.backgroundWork ||
    row.customSlot,
  );

const gapAfterRow = (
  current: EventRowViewModel,
  next: EventRowViewModel | undefined,
): number => {
  if (!next) return ROW_GAP;
  if (isCardRow(current) && isCardRow(next)) return CARD_RUN_GAP;
  if (current.kind === "assistant" && next.kind === "assistant") {
    return ASSISTANT_RUN_GAP;
  }

  if (current.kind === "user" && next.kind === "user") {
    return USER_RUN_GAP;
  }
  return ROW_GAP;
};

type TimelineListItem = ChatTimelineItem & {

  gapAfter: number;
};

export const CHAT_DRAW_DISTANCE_COLD_PX = 300;
export const CHAT_DRAW_DISTANCE_WARM_PX = 1_200;
const CHAT_DRAW_DISTANCE_FALLBACK_DELAY_MS = 240;

const useChatDrawDistance = (dataKey: string | null): number => {
  const [warmedDataKey, setWarmedDataKey] = useState<string | null>(null);

  useEffect(() => {
    if (!dataKey || warmedDataKey === dataKey) return;
    const scheduleIdle =
      window.requestIdleCallback ??
      ((callback: IdleRequestCallback) =>
        window.setTimeout(
          () =>
            callback({
              didTimeout: false,
              timeRemaining: () => 0,
            }),
          CHAT_DRAW_DISTANCE_FALLBACK_DELAY_MS,
        ));
    const cancelIdle =
      window.cancelIdleCallback ??
      ((handle: number) => window.clearTimeout(handle));
    const handle = scheduleIdle(() => {
      startTransition(() => setWarmedDataKey(dataKey));
    });
    return () => cancelIdle(handle as number);
  }, [dataKey, warmedDataKey]);

  return warmedDataKey === dataKey
    ? CHAT_DRAW_DISTANCE_WARM_PX
    : CHAT_DRAW_DISTANCE_COLD_PX;
};

const ItemSeparator = ({ leadingItem }: { leadingItem: TimelineListItem }) => (
  <div style={{ height: leadingItem.gapAfter }} aria-hidden="true" />
);

const useTranscriptRowMetrics = (
  listRef: RefObject<LegendListRef | null>,
  listAttached: boolean,
): TranscriptRowMetrics | null => {
  const [metrics, setMetrics] = useState<TranscriptRowMetrics | null>(null);
  const metricsRef = useRef<TranscriptRowMetrics | null>(null);
  metricsRef.current = metrics;

  useEffect(() => {
    if (!listAttached) return;
    const scrollNode = listRef.current?.getScrollableNode?.();
    if (!scrollNode) return;

    const readColumnWidth = (): number => {

      const row =
        scrollNode.querySelector<HTMLElement>(".event-row") ??
        scrollNode.querySelector<HTMLElement>(".event-list-trailing-region");
      return row ? Math.round(row.getBoundingClientRect().width) : 0;
    };

    const remeasure = () => {
      const columnWidth = readColumnWidth();
      if (columnWidth <= 0) return;
      const next = measureTranscriptRowMetrics(scrollNode, columnWidth);
      if (!next) return;
      if (metricsRef.current?.epoch === next.epoch) return;
      metricsRef.current = next;
      setMetrics(next);
    };

    remeasure();

    let frame = 0;
    const scheduleRemeasure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        remeasure();
      });
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleRemeasure);
    resizeObserver?.observe(scrollNode);

    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleRemeasure);
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
    };
  }, [listAttached, listRef]);

  return metrics;
};

const renderRow = (
  row: EventRowViewModel,
  conversationId?: string | null,
  agentModelConfigByThread?: AgentModelConfigsByThread,
) => {
  if (row.kind === "user") {
    return <UserMessageRow key={row.id} row={row} />;
  }
  return (
    <AssistantMessageRow
      key={row.id}
      row={row}
      conversationId={conversationId}
      agentModelConfigByThread={agentModelConfigByThread}
    />
  );
};

const TimelineUserItem = ({
  item,
  onCancelQueued,
}: {
  item: Extract<ChatTimelineItem, { type: "message" | "queued-users" }>;
  onCancelQueued?: (message: QueuedUserMessage) => void;
}) => {
  if (item.type === "queued-users") {
    return (
      <ComposerQueuedMessages
        messages={item.messages}
        onCancel={onCancelQueued}
      />
    );
  }
  return item.row.kind === "user" ? <UserMessageRow row={item.row} /> : null;
};

export const ChatTimeline = memo(function ChatTimeline({
  rows,
  conversationId,
  agentModelConfigByThread,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  emptyState,
  extraTail,
  queuedUserMessages,
  onCancelQueued,
  indicator,
  listRef,
  recycleItems = true,
  alignItemsAtEnd = false,
  estimatedItemSize = 120,
  className,
  contentContainerStyle,
}: ChatTimelineProps) {
  const t = useT();

  const innerListRef = useRef<LegendListRef | null>(null);
  const [listAttached, setListAttached] = useState(false);
  const attachListRef = useCallback(
    (instance: LegendListRef | null) => {
      innerListRef.current = instance;
      if (listRef) listRef.current = instance;
      setListAttached(Boolean(instance));
    },
    [listRef],
  );
  const listItems = useMemo<TimelineListItem[]>(() => {
    const items = buildChatTimelineItems({
      rows,
      queuedUserMessages: queuedUserMessages ?? [],
      includeWorkingIndicator: Boolean(indicator),
    });
    return items.map((item, index) => {
      const next = items[index + 1];
      if (item.type === "message") {
        const nextRow = next?.type === "message" ? next.row : undefined;
        return { ...item, gapAfter: gapAfterRow(item.row, nextRow) };
      }
      if (item.type === "working-indicator") {
        return { ...item, gapAfter: next?.type === "queued-users" ? 20 : 0 };
      }
      return {
        ...item,
        gapAfter: next?.type === "queued-users" ? 6 : ROW_GAP,
      };
    });
  }, [indicator, queuedUserMessages, rows]);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<TimelineListItem>) => {
      if (item.type === "working-indicator") {
        return indicator ? (
          <div className="event-list-working-indicator">
            <InlineWorkingIndicator {...indicator} />
          </div>
        ) : null;
      }
      if (item.type === "queued-users" || item.row.kind === "user") {
        return <TimelineUserItem item={item} onCancelQueued={onCancelQueued} />;
      }
      return renderRow(item.row, conversationId, agentModelConfigByThread);
    },
    [agentModelConfigByThread, conversationId, indicator, onCancelQueued],
  );

  const keyExtractor = useCallback((item: TimelineListItem) => item.id, []);

  const rowMetrics = useTranscriptRowMetrics(innerListRef, listAttached);
  const itemCount = listItems.length;
  const getFixedItemSize = useCallback(
    (item: TimelineListItem, index: number): number | undefined => {
      if (!rowMetrics || item.type !== "message") return undefined;
      const rowHeight = getFixedRowHeight(item.row, rowMetrics);
      if (rowHeight === undefined) return undefined;
      const separator = index === itemCount - 1 ? 0 : item.gapAfter;
      return rowHeight + separator;
    },
    [itemCount, rowMetrics],
  );
  const hasQueuedTimelineItem = listItems.some(
    (item) => item.type === "queued-users",
  );
  const drawDistance = useChatDrawDistance(
    rows.length > 0 ? (conversationId ?? listItems[0]?.id ?? null) : null,
  );

  const ListHeader = useMemo(() => {
    if (!isLoadingOlder || !hasOlderEvents) return null;
    return (
      <div className="event-history-status" role="status" aria-live="polite">
        Loading earlier messages...
      </div>
    );
  }, [hasOlderEvents, isLoadingOlder]);

  const ListFooter = useMemo(
    () => (
      <div
        className={
          "event-list-trailing-region" +
          (hasQueuedTimelineItem
            ? " event-list-trailing-region--after-queue"
            : "")
        }
      >
        {extraTail && <div className="event-list-extra-tail">{extraTail}</div>}
      </div>
    ),
    [extraTail, hasQueuedTimelineItem],
  );

  if (isLoadingHistory && rows.length === 0) {
    return (
      <div
        className="event-list-fallback"
        data-loading-history="true"
        role="status"
        aria-live="polite"
        aria-label={t("app.chat.timeline.loadingConversation")}
      >
        <LoaderCircle
          className="stella-loader-circle"
          size={18}
          strokeWidth={2}
          aria-hidden="true"
        />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="event-list-fallback" data-empty="true">
        {emptyState ?? (
          <div className="event-empty">{t("app.chat.timeline.empty")}</div>
        )}
      </div>
    );
  }

  return (
    <LegendList<TimelineListItem>
      ref={attachListRef}
      data={listItems}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      estimatedItemSize={estimatedItemSize}
      getFixedItemSize={getFixedItemSize}
      drawDistance={drawDistance}
      recycleItems={recycleItems}
      alignItemsAtEnd={alignItemsAtEnd}
      maintainVisibleContentPosition
      initialScrollAtEnd

      ListHeaderComponent={ListHeader ?? undefined}
      ListFooterComponent={ListFooter}
      ItemSeparatorComponent={ItemSeparator}
      className={className}
      contentContainerStyle={contentContainerStyle}
      style={{ height: "100%", width: "100%" }}
    />
  );
});
