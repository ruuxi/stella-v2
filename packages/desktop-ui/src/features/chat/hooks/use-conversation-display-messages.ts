import { useMemo, useRef } from "react";
import { useScheduledEvents } from "@/features/chat/hooks/use-scheduled-events";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import { groupEventsIntoMessages } from "@/features/chat/lib/group-events-into-messages";
import type { StreamingAssistantOverlay } from "@/features/chat/streaming/streaming-types";
import {
  createLifecycleRoutingState,
  routeLifecycleEvents,
  type LifecycleRoutingState,
} from "@/features/chat/lib/route-lifecycle-events";
import type { MessageRecord } from "@stella/contracts/local-chat";

const SCHEDULED_EVENTS_OVERLAY_MAX = 200;

type UseConversationDisplayMessagesOptions = {
  conversationId: string | null;
  persistedMessages: MessageRecord[];
  optimisticEvents: EventRecord[];
  streamingAssistants: StreamingAssistantOverlay[];
};

export type SortTimestampResolver = (message: MessageRecord) => number;

export const getMessageChronologicalTimestamp: SortTimestampResolver = (
  message,
) => {
  if (message.type === "assistant_message") {
    const payload = message.payload as
      | { metadata?: { runtime?: { streamStartedAtMs?: unknown } } }
      | undefined;
    const streamStartedAtMs = payload?.metadata?.runtime?.streamStartedAtMs;
    if (
      typeof streamStartedAtMs === "number" &&
      Number.isFinite(streamStartedAtMs)
    ) {
      return streamStartedAtMs;
    }
  }
  return message.timestamp;
};

const defaultSortTimestamp: SortTimestampResolver =
  getMessageChronologicalTimestamp;

export const createOwningUserClampedSortTimestampResolver = (
  messages: readonly MessageRecord[],
  baseResolver: SortTimestampResolver = defaultSortTimestamp,
): SortTimestampResolver => {
  const userTimestampById = new Map<string, number>();
  for (const message of messages) {
    if (message.type === "user_message") {
      userTimestampById.set(message._id, baseResolver(message));
    }
  }

  let needsClamp = false;
  for (const message of messages) {
    const ownerId = getAssistantUserMessageId(message);
    if (!ownerId) continue;
    const ownerTimestamp = userTimestampById.get(ownerId);
    if (
      ownerTimestamp !== undefined &&
      baseResolver(message) <= ownerTimestamp
    ) {
      needsClamp = true;
      break;
    }
  }
  if (!needsClamp) return baseResolver;

  return (message) => {
    const timestamp = baseResolver(message);
    const ownerId = getAssistantUserMessageId(message);
    if (!ownerId) return timestamp;
    const ownerTimestamp = userTimestampById.get(ownerId);
    return ownerTimestamp === undefined
      ? timestamp
      : Math.max(timestamp, ownerTimestamp + 1);
  };
};

export const createDisplayOrderComparator = (
  messages: readonly MessageRecord[],
  getSortTimestamp: SortTimestampResolver = defaultSortTimestamp,
) => {
  const inputOrderById = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const id = messages[index]!._id;
    if (!inputOrderById.has(id)) inputOrderById.set(id, index);
  }

  return (a: MessageRecord, b: MessageRecord): number => {
    const ta = getSortTimestamp(a);
    const tb = getSortTimestamp(b);
    if (ta !== tb) return ta - tb;
    const inputOrder =
      (inputOrderById.get(a._id) ?? Number.MAX_SAFE_INTEGER) -
      (inputOrderById.get(b._id) ?? Number.MAX_SAFE_INTEGER);
    return inputOrder !== 0 ? inputOrder : a._id.localeCompare(b._id);
  };
};

const getAssistantUserMessageId = (
  message: MessageRecord,
): string | undefined => {
  if (message.type !== "assistant_message") return undefined;
  const payload = message.payload as { userMessageId?: string } | undefined;
  const userMessageId = payload?.userMessageId;
  return typeof userMessageId === "string" && userMessageId.length > 0
    ? userMessageId
    : undefined;
};

const isUserTurnAssistant = (message: MessageRecord): boolean => {
  const payload = message.payload as
    | {
        metadata?: {
          runtime?: { responseTarget?: { type?: unknown } };
        };
      }
    | undefined;
  const targetType = payload?.metadata?.runtime?.responseTarget?.type;
  return targetType === undefined || targetType === "user_turn";
};

export const keepAssistantTurnsContiguous = (
  messages: MessageRecord[],
): MessageRecord[] => {
  const userIndexById = new Map<string, number>();
  const nextUserIndexAfter = new Array<number | undefined>(messages.length);
  let nextUserIndex: number | undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    nextUserIndexAfter[index] = nextUserIndex;
    const message = messages[index]!;
    if (message.type === "user_message") {
      userIndexById.set(message._id, index);
      nextUserIndex = index;
    }
  }

  const movedIds = new Set<string>();
  const insertBefore = new Map<number, MessageRecord[]>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const anchorId = getAssistantUserMessageId(message);
    if (!anchorId || !isUserTurnAssistant(message)) continue;
    const anchorIndex = userIndexById.get(anchorId);
    if (anchorIndex === undefined) continue;
    const boundaryIndex = nextUserIndexAfter[anchorIndex];
    if (boundaryIndex === undefined || index < boundaryIndex) continue;

    movedIds.add(message._id);
    const pending = insertBefore.get(boundaryIndex);
    if (pending) pending.push(message);
    else insertBefore.set(boundaryIndex, [message]);
  }

  if (movedIds.size === 0) return messages;

  const result: MessageRecord[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const pending = insertBefore.get(index);
    if (pending) result.push(...pending);
    const message = messages[index]!;
    if (!movedIds.has(message._id)) result.push(message);
  }
  return result;
};

const orderByResolver = (
  messages: MessageRecord[],
  getSortTimestamp: SortTimestampResolver,
): MessageRecord[] => {
  const compareDisplayOrder = createDisplayOrderComparator(
    messages,
    getSortTimestamp,
  );

  let ordered = messages;
  for (let i = 1; i < messages.length; i += 1) {
    if (compareDisplayOrder(messages[i - 1]!, messages[i]!) > 0) {
      ordered = messages.slice();
      ordered.sort(compareDisplayOrder);
      break;
    }
  }
  return keepAssistantTurnsContiguous(ordered);
};

const mergeMessageSources = (
  getSortTimestamp: SortTimestampResolver,
  ...sources: MessageRecord[][]
): MessageRecord[] => {
  const seen = new Map<string, MessageRecord>();
  for (const source of sources) {
    for (const message of source) {
      if (!seen.has(message._id)) {
        seen.set(message._id, message);
      }
    }
  }
  const merged = [...seen.values()];

  return orderByResolver(merged, getSortTimestamp);
};

export const getPersistedAssistantSlots = (
  persistedMessages: MessageRecord[],
): Map<string, MessageRecord[]> => {
  const slots = new Map<string, MessageRecord[]>();
  for (const message of persistedMessages) {
    const userMessageId = getAssistantUserMessageId(message);
    if (!userMessageId) continue;
    const current = slots.get(userMessageId);
    if (current) {
      current.push(message);
    } else {
      slots.set(userMessageId, [message]);
    }
  }
  return slots;
};

export const overlayToMessageRecord = (
  overlay: StreamingAssistantOverlay,
  persisted?: MessageRecord,
): MessageRecord => {
  return {
    ...(persisted ?? {}),
    _id: overlay._id,
    timestamp: overlay.timestamp,
    type: "assistant_message",
    payload: {
      ...(persisted?.payload ?? {}),
      text:
        typeof persisted?.payload?.text === "string"
          ? persisted.payload.text
          : overlay.text,
      userMessageId: overlay.userMessageId,
      metadata: {
        ...((
          persisted?.payload as
            | { metadata?: Record<string, unknown> }
            | undefined
        )?.metadata ?? {}),
        runtime: {
          ...((
            persisted?.payload as
              | { metadata?: { runtime?: Record<string, unknown> } }
              | undefined
          )?.metadata?.runtime ?? {}),
          ...(overlay.responseTarget
            ? { responseTarget: overlay.responseTarget }
            : {}),
          ...(overlay.heldForHandoff ? { heldForHandoff: true } : {}),
        },
      },
    },
    toolEvents: persisted?.toolEvents ?? [],
  };
};

export const mergeConversationDisplayMessageSources = (args: {
  persistedMessages: MessageRecord[];
  overlayMessages: MessageRecord[];
  streamingAssistants: StreamingAssistantOverlay[];
  persistedAssistantSlots: Map<string, MessageRecord[]>;

  getSortTimestamp?: SortTimestampResolver;
}): MessageRecord[] => {
  const {
    persistedMessages,
    overlayMessages,
    streamingAssistants,
    persistedAssistantSlots,
    getSortTimestamp = defaultSortTimestamp,
  } = args;
  const effectiveSortTimestamp =
    createOwningUserClampedSortTimestampResolver(
      overlayMessages.length > 0
        ? [...persistedMessages, ...overlayMessages]
        : persistedMessages,
      getSortTimestamp,
    );
  const resolverActive = effectiveSortTimestamp !== defaultSortTimestamp;
  const persistedById = new Map(
    persistedMessages.map((message) => [message._id, message]),
  );
  if (streamingAssistants.length === 0) {
    if (overlayMessages.length === 0) {

      return orderByResolver(persistedMessages, effectiveSortTimestamp);
    }
    return mergeMessageSources(
      effectiveSortTimestamp,
      persistedMessages,
      overlayMessages,
    );
  }

  const maskedPersistedIds = new Set<string>();
  for (const slot of streamingAssistants) {
    const persisted = slot.canonicalMessageId
      ? persistedById.get(slot.canonicalMessageId)
      : persistedAssistantSlots.get(slot.userMessageId)?.[
          slot.indexInTurn - 1
        ];
    if (persisted) {
      maskedPersistedIds.add(persisted._id);
    }
  }

  const persistedMessagesForDisplay =
    maskedPersistedIds.size === 0
      ? persistedMessages
      : persistedMessages.filter(
          (message) => !maskedPersistedIds.has(message._id),
        );

  if (overlayMessages.length === 0) {
    return resolverActive
      ? orderByResolver(persistedMessagesForDisplay, effectiveSortTimestamp)
      : persistedMessagesForDisplay;
  }
  return mergeMessageSources(
    effectiveSortTimestamp,
    persistedMessagesForDisplay,
    overlayMessages,
  );
};

export const useConversationDisplayMessages = ({
  conversationId,
  persistedMessages,
  optimisticEvents,
  streamingAssistants,
}: UseConversationDisplayMessagesOptions): MessageRecord[] => {
  const scheduledEvents = useScheduledEvents({
    conversationId: conversationId ?? undefined,
    enabled: Boolean(conversationId),
    maxItems: SCHEDULED_EVENTS_OVERLAY_MAX,
  });

  const persistedAssistantSlots = useMemo(
    () => getPersistedAssistantSlots(persistedMessages),
    [persistedMessages],
  );
  const persistedMessagesById = useMemo(
    () => new Map(persistedMessages.map((message) => [message._id, message])),
    [persistedMessages],
  );

  const frozenSlotSortTsRef = useRef<Map<string, number>>(new Map());
  const frozenConversationIdRef = useRef<string | null>(conversationId);
  if (frozenConversationIdRef.current !== conversationId) {
    frozenConversationIdRef.current = conversationId;
    frozenSlotSortTsRef.current = new Map();
  }
  for (const slot of streamingAssistants) {
    const slotKey = `${slot.userMessageId}:${slot.indexInTurn}`;
    if (!frozenSlotSortTsRef.current.has(slotKey)) {
      frozenSlotSortTsRef.current.set(slotKey, slot.timestamp);
    }
  }

  const sortTimestampByMessageId = useMemo(() => {
    const map = new Map<string, number>();
    const frozen = frozenSlotSortTsRef.current;
    if (frozen.size === 0) return map;
    for (const [userMessageId, slotMessages] of persistedAssistantSlots) {
      for (let i = 0; i < slotMessages.length; i += 1) {
        const frozenTs = frozen.get(`${userMessageId}:${i + 1}`);
        if (frozenTs !== undefined) {
          map.set(slotMessages[i]!._id, frozenTs);
        }
      }
    }
    for (const slot of streamingAssistants) {
      if (slot.canonicalMessageId) {
        map.set(slot.canonicalMessageId, slot.timestamp);
      }
    }
    return map;
  }, [persistedAssistantSlots, streamingAssistants]);

  const getSortTimestamp = useMemo<SortTimestampResolver | undefined>(() => {
    if (sortTimestampByMessageId.size === 0) return undefined;
    return (message) =>
      sortTimestampByMessageId.get(message._id) ??
      getMessageChronologicalTimestamp(message);
  }, [sortTimestampByMessageId]);

  const overlayMessages = useMemo(() => {
    const overlayEvents: EventRecord[] = [];
    for (const event of optimisticEvents) overlayEvents.push(event);
    for (const event of scheduledEvents) {
      if (event.type !== "user_message" && event.type !== "assistant_message") {
        continue;
      }
      if (overlayEvents.some((other) => other._id === event._id)) continue;
      overlayEvents.push(event);
    }
    const fromEvents =
      overlayEvents.length > 0 ? groupEventsIntoMessages(overlayEvents) : [];

    const streamingOverlay: MessageRecord[] = [];
    for (const slot of streamingAssistants) {
      const persisted = slot.canonicalMessageId
        ? persistedMessagesById.get(slot.canonicalMessageId)
        : persistedAssistantSlots.get(slot.userMessageId)?.[
            slot.indexInTurn - 1
          ];
      streamingOverlay.push(overlayToMessageRecord(slot, persisted));
    }

    if (fromEvents.length === 0 && streamingOverlay.length === 0) {
      return [] as MessageRecord[];
    }
    return [...fromEvents, ...streamingOverlay];
  }, [
    optimisticEvents,
    persistedAssistantSlots,
    persistedMessagesById,
    scheduledEvents,
    streamingAssistants,
  ]);

  const merged = useMemo(() => {
    return mergeConversationDisplayMessageSources({
      persistedMessages,
      overlayMessages,
      streamingAssistants,
      persistedAssistantSlots,
      ...(getSortTimestamp ? { getSortTimestamp } : {}),
    });
  }, [
    getSortTimestamp,
    overlayMessages,
    persistedAssistantSlots,
    persistedMessages,
    streamingAssistants,
  ]);

  const lifecycleRoutingRef = useRef<LifecycleRoutingState>(
    createLifecycleRoutingState(),
  );
  const routingConversationIdRef = useRef<string | null>(conversationId);
  if (routingConversationIdRef.current !== conversationId) {
    routingConversationIdRef.current = conversationId;
    lifecycleRoutingRef.current = createLifecycleRoutingState();
  }

  return useMemo(
    () => routeLifecycleEvents(merged, lifecycleRoutingRef.current),
    [merged],
  );
};
