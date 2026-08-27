import type {
  EventRecord,
  MessageRecord,
} from "@stella/contracts/local-chat";
import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";

const LIFECYCLE_EVENT_TYPES = new Set([
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
]);

const isLifecycleEvent = (event: EventRecord): boolean =>
  LIFECYCLE_EVENT_TYPES.has(event.type);

const STREAMING_OVERLAY_ID_PREFIX = "stream-overlay:";

export type LifecycleRoutingState = {

  sticky: Map<string, string>;

  routedByBase: WeakMap<MessageRecord, MessageRecord>;
};
export const createLifecycleRoutingState = (): LifecycleRoutingState => ({
  sticky: new Map(),
  routedByBase: new WeakMap(),
});

const getAssistantUserMessageId = (
  message: MessageRecord,
): string | undefined => {
  const payload = message.payload as { userMessageId?: unknown } | undefined;
  return typeof payload?.userMessageId === "string" &&
    payload.userMessageId.length > 0
    ? payload.userMessageId
    : undefined;
};

const getStreamStartedAtMs = (message: MessageRecord): number | undefined => {
  if (message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX)) {

    return message.timestamp;
  }
  const metadata = (
    message.payload as
      | { metadata?: { runtime?: { streamStartedAtMs?: unknown } } }
      | undefined
  )?.metadata;
  const value = metadata?.runtime?.streamStartedAtMs;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

type Anchor = {
  key: string;

  startTs: number | undefined;
  messageIndex: number;
};

const compareEvents = (a: EventRecord, b: EventRecord): number =>
  a.timestamp !== b.timestamp
    ? a.timestamp - b.timestamp
    : a._id.localeCompare(b._id);

const sameToolEventIds = (
  a: readonly EventRecord[],
  b: readonly EventRecord[],
): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!._id !== b[i]!._id) return false;
  }
  return true;
};

export const routeLifecycleEvents = (
  messages: MessageRecord[],
  state: LifecycleRoutingState,
): MessageRecord[] => {

  let hasLifecycle = false;
  for (const message of messages) {
    if (message.toolEvents.some(isLifecycleEvent)) {
      hasLifecycle = true;
      break;
    }
  }
  if (!hasLifecycle) return messages;

  const routedEventsByIndex = new Map<number, EventRecord[]>();

  const assistantCountByUserMessageId = new Map<string, number>();

  type TurnEntry = {
    anchor: Anchor;
    message: MessageRecord;
  };
  let turn: TurnEntry[] = [];

  const flushTurn = () => {
    if (turn.length === 0) return;
    const entries = turn;
    turn = [];

    const sourcesByEventId = new Map<
      string,
      { event: EventRecord; lastSource: TurnEntry }
    >();

    const changed = new Set<TurnEntry>();
    for (const entry of entries) {
      for (const event of entry.message.toolEvents) {
        if (!isLifecycleEvent(event)) continue;
        const existing = sourcesByEventId.get(event._id);
        if (existing) {

          changed.add(existing.lastSource);
          changed.add(entry);
          existing.lastSource = entry;
        } else {
          sourcesByEventId.set(event._id, { event, lastSource: entry });
        }
      }
    }
    if (sourcesByEventId.size === 0) return;

    const anchorsByKey = new Map<string, TurnEntry>();
    for (const entry of entries) anchorsByKey.set(entry.anchor.key, entry);

    const targets = entries.filter(
      (entry) => entry.anchor.startTs !== undefined,
    );

    const isOverlayEntry = (entry: TurnEntry): boolean =>
      entry.message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX);

    const resolveTarget = (
      source: TurnEntry,
      event: EventRecord,
    ): TurnEntry => {
      let stickyKey = state.sticky.get(event._id);
      if (stickyKey !== undefined) {
        const pinned = anchorsByKey.get(stickyKey);
        if (pinned) {

          const pinnedStart = pinned.anchor.startTs;
          const stale =
            isOverlayEntry(pinned) &&
            pinnedStart !== undefined &&
            pinnedStart > event.timestamp;
          if (!stale) return pinned;
          state.sticky.delete(event._id);
          stickyKey = undefined;
        }

      }

      if (source.anchor.startTs === undefined) {
        if (stickyKey === undefined) {
          state.sticky.set(event._id, source.anchor.key);
        }
        return source;
      }
      let resolved: TurnEntry | undefined;
      for (const candidate of targets) {
        const startTs = candidate.anchor.startTs;
        if (startTs !== undefined && startTs <= event.timestamp) {
          resolved = candidate;
        }
      }
      const target = resolved ?? source;

      if (stickyKey === undefined) {
        state.sticky.set(event._id, target.anchor.key);
      }
      return target;
    };

    const targetByEventId = new Map<string, TurnEntry>();
    for (const [eventId, { event, lastSource }] of sourcesByEventId) {
      targetByEventId.set(eventId, resolveTarget(lastSource, event));
    }

    const incomingByKey = new Map<string, EventRecord[]>();
    const placedIds = new Set<string>();
    for (const [eventId, target] of targetByEventId) {
      if (
        target.message.toolEvents.some(
          (event) => event._id === eventId && isLifecycleEvent(event),
        )
      ) {
        placedIds.add(eventId);
      }
    }
    for (const entry of entries) {
      for (const event of entry.message.toolEvents) {
        if (!isLifecycleEvent(event)) continue;
        const target = targetByEventId.get(event._id);
        if (!target || target === entry) continue;
        changed.add(entry);
        if (placedIds.has(event._id)) continue;
        placedIds.add(event._id);
        changed.add(target);
        let incoming = incomingByKey.get(target.anchor.key);
        if (!incoming) incomingByKey.set(target.anchor.key, (incoming = []));
        incoming.push(event);
      }
    }

    for (const entry of entries) {
      if (!changed.has(entry)) continue;
      const incoming = incomingByKey.get(entry.anchor.key);

      const seenHere = new Set<string>();
      const kept = entry.message.toolEvents.filter((event) => {
        if (!isLifecycleEvent(event)) return true;
        if (targetByEventId.get(event._id) !== entry) return false;
        if (seenHere.has(event._id)) return false;
        seenHere.add(event._id);
        return true;
      });
      const next = incoming ? [...kept, ...incoming].sort(compareEvents) : kept;
      if (sameToolEventIds(next, entry.message.toolEvents)) continue;
      routedEventsByIndex.set(entry.anchor.messageIndex, next);
    }
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.type === "user_message") {
      flushTurn();
      turn.push({
        anchor: {
          key: `user:${message._id}`,
          startTs: Number.NEGATIVE_INFINITY,
          messageIndex: index,
        },
        message,
      });
      continue;
    }
    if (message.type !== "assistant_message") continue;

    if (isUiHiddenChatMessagePayload(message.payload ?? null)) continue;
    const userMessageId = getAssistantUserMessageId(message);
    let key: string;
    if (userMessageId !== undefined) {
      const indexInTurn =
        (assistantCountByUserMessageId.get(userMessageId) ?? 0) + 1;
      assistantCountByUserMessageId.set(userMessageId, indexInTurn);

      key = `slot:${userMessageId}:${indexInTurn}`;
    } else {
      key = `id:${message._id}`;
    }
    turn.push({
      anchor: {
        key,
        startTs: getStreamStartedAtMs(message),
        messageIndex: index,
      },
      message,
    });
  }
  flushTurn();

  if (routedEventsByIndex.size === 0) return messages;

  const result = messages.slice();
  for (const [index, toolEvents] of routedEventsByIndex) {
    const base = messages[index]!;
    const cached = state.routedByBase.get(base);
    if (cached && sameToolEventIds(cached.toolEvents, toolEvents)) {
      result[index] = cached;
      continue;
    }
    const routed: MessageRecord = { ...base, toolEvents };
    state.routedByBase.set(base, routed);
    result[index] = routed;
  }
  return result;
};
