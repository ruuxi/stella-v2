import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessageRecord } from "@stella/contracts/local-chat";
import { useEventRows } from "@/features/chat/hooks/use-event-rows";
import { ChatTimeline } from "./ChatTimeline";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import { hasQueuedMessageEntryPlayed } from "@/features/chat/lib/message-entry-animation-state";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";

const USER_MESSAGE_ENTER_MS = 360;
const ASSISTANT_MESSAGE_ENTER_MS = 300;

const justSentPlayedIds = new Set<string>();
const justSentActiveUntil = new Map<string, number>();
const assistantEnterPlayedIds = new Set<string>();
const assistantEnterActiveUntil = new Map<string, number>();

type Props = {
  messages: MessageRecord[];
  conversationId?: string | null;
  agentModelConfigByThread?: AgentModelConfigsByThread;
  maxItems?: number;
  pendingUserMessageId?: string | null;
  queuedUserMessages?: QueuedUserMessage[];

  onCancelQueued?: (message: QueuedUserMessage) => void;

  indicator?: InlineWorkingIndicatorMountProps;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;

  listRef?: RefObject<LegendListRef | null>;
  className?: string;
  contentContainerStyle?: CSSProperties;
  estimatedItemSize?: number;
};

function useOneShotIds(
  ids: readonly string[],
  durationMs: number,
  playedIds: Set<string> = justSentPlayedIds,
  activeUntil: Map<string, number> = justSentActiveUntil,
): Set<string> {
  const key = useMemo(() => [...new Set(ids)].sort().join("\n"), [ids]);
  const [tick, setTick] = useState(0);

  const active = useMemo(() => {

    void tick;
    const now = performance.now();
    const set = new Set<string>();
    for (const id of key ? key.split("\n") : []) {
      if (!id) continue;
      if (!playedIds.has(id)) {
        playedIds.add(id);
        activeUntil.set(id, now + durationMs);
      }
      const until = activeUntil.get(id) ?? 0;
      if (until > now) {
        set.add(id);
      }
    }
    return set;
  }, [activeUntil, durationMs, key, playedIds, tick]);

  useEffect(() => {
    if (active.size === 0) return;
    const now = performance.now();
    let delayMs = durationMs;
    for (const id of active) {
      const until = activeUntil.get(id) ?? 0;
      delayMs = Math.min(delayMs, Math.max(0, until - now));
    }
    const timeoutId = window.setTimeout(() => {
      setTick((current) => current + 1);
    }, delayMs + 1);
    return () => window.clearTimeout(timeoutId);
  }, [active, activeUntil, durationMs]);

  return active;
}

function useAssistantArrivalIds(
  rows: readonly EventRowViewModel[],
  conversationId: string | null | undefined,
): Set<string> {
  const seededConversationRef = useRef<string | null | undefined>(undefined);
  const tailAssistantId = useMemo(() => {
    const last = rows[rows.length - 1];
    return last && last.kind === "assistant" ? last.id : null;
  }, [rows]);

  if (seededConversationRef.current !== conversationId) {
    seededConversationRef.current = conversationId;
    if (tailAssistantId) assistantEnterPlayedIds.add(tailAssistantId);
  }

  const candidates = useMemo(
    () => (tailAssistantId ? [tailAssistantId] : []),
    [tailAssistantId],
  );
  return useOneShotIds(
    candidates,
    ASSISTANT_MESSAGE_ENTER_MS,
    assistantEnterPlayedIds,
    assistantEnterActiveUntil,
  );
}

export const ConversationEvents = memo(function ConversationEvents({
  messages,
  conversationId,
  agentModelConfigByThread,
  maxItems,
  pendingUserMessageId,
  queuedUserMessages,
  onCancelQueued,
  indicator,
  hasOlderMessages,
  isLoadingOlder,
  isLoadingHistory,
  listRef,
  className,
  contentContainerStyle,
  estimatedItemSize,
}: Props) {
  const { rows: projectedRows } = useEventRows({
    messages,
    maxItems,
  });

  const justSentCandidates = useMemo(
    () =>
      pendingUserMessageId && !hasQueuedMessageEntryPlayed(pendingUserMessageId)
        ? [pendingUserMessageId]
        : [],
    [pendingUserMessageId],
  );
  const animatingJustSentIds = useOneShotIds(
    justSentCandidates,
    USER_MESSAGE_ENTER_MS,
  );
  const animatingArrivalIds = useAssistantArrivalIds(
    projectedRows,
    conversationId,
  );

  const rows =
    animatingJustSentIds.size > 0 || animatingArrivalIds.size > 0
      ? projectedRows.map((row) => {
          if (row.kind === "user") {
            return animatingJustSentIds.has(row.id)
              ? { ...row, justSent: true }
              : row;
          }
          return animatingArrivalIds.has(row.id)
            ? { ...row, justArrived: true }
            : row;
        })
      : projectedRows;

  return (
    <ChatTimeline
      rows={rows}
      conversationId={conversationId}
      agentModelConfigByThread={agentModelConfigByThread}
      hasOlderEvents={hasOlderMessages}
      isLoadingOlder={isLoadingOlder}
      isLoadingHistory={isLoadingHistory}
      queuedUserMessages={queuedUserMessages}
      onCancelQueued={onCancelQueued}
      indicator={indicator}
      listRef={listRef}
      className={className}
      contentContainerStyle={contentContainerStyle}
      estimatedItemSize={estimatedItemSize}
    />
  );
});
