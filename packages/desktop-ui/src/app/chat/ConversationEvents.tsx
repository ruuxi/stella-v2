/**
 * Home full-chat surface.
 *
 * Projects local `EventRecord[]` into row view models via `useEventRows`
 * and mounts the shared `<ChatTimeline>`.
 */
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

/**
 * Tracks message ids whose enter animation has already played. Module
 * scope so a home→chat transition (ConversationEvents remount) or a
 * dev remount doesn't replay the fade/grow on the same bubble.
 */
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
  /** Reveals a hover "X" on each queued bubble to cancel + restore its text. */
  onCancelQueued?: (message: QueuedUserMessage) => void;
  /** Working/agent indicator rendered below the last assistant message. */
  indicator?: InlineWorkingIndicatorMountProps;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  /** Threaded through to `<ChatTimeline>` → `<LegendList>`. */
  listRef?: RefObject<LegendListRef | null>;
  className?: string;
  contentContainerStyle?: CSSProperties;
  estimatedItemSize?: number;
  extraTail?: React.ReactNode;
  alignItemsAtEnd?: boolean;
  reserveTailSpace?: boolean;
};

/**
 * Returns the set of row ids whose one-shot enter animation is still
 * playing this frame. Registration runs synchronously during render so the
 * CSS enter animation starts on the row's first paint — the previous
 * `useEffect` path painted the row at full opacity, then added the
 * class a frame later, which read as a double appear/re-render on
 * the first send after a cold load (especially when ConversationEvents
 * mounts for the first time on home→chat).
 *
 * The played/expiry maps are parameters rather than module constants so the
 * sent-bubble and arriving-reply animations keep separate ledgers.
 */
function useOneShotIds(
  ids: readonly string[],
  durationMs: number,
  playedIds: Set<string> = justSentPlayedIds,
  activeUntil: Map<string, number> = justSentActiveUntil,
): Set<string> {
  const key = useMemo(() => [...new Set(ids)].sort().join("\n"), [ids]);
  const [tick, setTick] = useState(0);

  const active = useMemo(() => {
    // `tick` is an explicit clock revision: the timeout below advances it to
    // expire IDs even when the input list itself has not changed.
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

/**
 * Marks the tail assistant row as newly arrived, for one play.
 *
 * A reply arrives whole, so the only cue that it is new is that it wasn't
 * there a frame ago. Loading an existing conversation would otherwise animate
 * its last reply as if it had just been written, so the first row seen for a
 * conversation is seeded as already-played.
 */
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
  extraTail,
  alignItemsAtEnd,
  reserveTailSpace,
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
      extraTail={extraTail}
      alignItemsAtEnd={alignItemsAtEnd}
      reserveTailSpace={reserveTailSpace}
    />
  );
});
