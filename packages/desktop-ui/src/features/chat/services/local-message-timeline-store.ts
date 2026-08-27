import type {
  EventRecord,
  LocalChatUpdatedPayload,
  LocalChatTimelineCursor,
  MessageRecord,
} from "@stella/contracts/local-chat";
import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";
import {
  stabilizeMessageList,
  type StableMessageListState,
} from "../lib/stable-rows";

export const MESSAGE_TIMELINE_PAGE_SIZE = 80;
export const MAX_RETAINED_TIMELINE_MESSAGES = 320;

const MAX_RETAINED_UNUSED_CONVERSATIONS = 8;
const EAGER_TOOL_EVENT_LIMIT = 32;
export const MAX_RETAINED_TOOL_DETAIL_EVENTS = 320;

export type MessageTimelineSnapshot = {
  messages: MessageRecord[];
  hasLoaded: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  error: Error | null;
};

type Listener = (snapshot: MessageTimelineSnapshot) => void;
type ReadKind = "initial" | "older" | "newer" | "latest" | "tail";

type TimelineEntry = {
  conversationId: string;
  snapshot: MessageTimelineSnapshot;
  listeners: Set<Listener>;
  requestId: number;
  inFlight: ReadKind | null;
  failedRead: ReadKind | null;
  queuedTailRefresh: boolean;
  queuedLatestRefresh: boolean;
  tailCursor: LocalChatTimelineCursor | null;
  mutationRevision: number;
  pendingEventsDuringRead: Map<string, EventRecord>;
  liveToolEventPins: Map<string, Map<string, EventRecord>>;
  detailResetRequired: Set<string>;
  lastUsed: number;
  stability: StableMessageListState | null;
};

export type MessageTimelineDebugStats = {
  initialReads: number;
  olderReads: number;
  newerReads: number;
  latestReads: number;
  tailReads: number;
  mergedRows: number;
  maxResidentMessages: number;
  activeEntries: number;
  pendingReads: number;
  retainedEntries: number;
  residentMessages: number;
};

const EMPTY_SNAPSHOT: MessageTimelineSnapshot = {
  messages: [],
  hasLoaded: false,
  hasOlder: false,
  hasNewer: false,
  isLoadingOlder: false,
  isLoadingNewer: false,
  error: null,
};

const entries = new Map<string, TimelineEntry>();
let updateUnsubscribe: (() => void) | null = null;
let useCounter = 0;
let debugStats: MessageTimelineDebugStats = createDebugStats();

function createDebugStats(): MessageTimelineDebugStats {
  return {
    initialReads: 0,
    olderReads: 0,
    newerReads: 0,
    latestReads: 0,
    tailReads: 0,
    mergedRows: 0,
    maxResidentMessages: 0,
    activeEntries: 0,
    pendingReads: 0,
    retainedEntries: 0,
    residentMessages: 0,
  };
}

function getApi() {
  if (typeof window === "undefined") return undefined;
  return window.electronAPI?.localChat;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function compareMessageOrder(a: MessageRecord, b: MessageRecord): number {
  if (
    typeof a.sequence === "number" &&
    Number.isFinite(a.sequence) &&
    typeof b.sequence === "number" &&
    Number.isFinite(b.sequence) &&
    a.sequence !== b.sequence
  ) {
    return a.sequence - b.sequence;
  }
  return a.timestamp - b.timestamp || a._id.localeCompare(b._id);
}

function visibleMessages(messages: MessageRecord[]): MessageRecord[] {
  return messages.filter(
    (message) => !isUiHiddenChatMessagePayload(message.payload ?? null),
  );
}

function mergeOrderedMessages(
  current: MessageRecord[],
  incoming: MessageRecord[],
): MessageRecord[] {
  debugStats.mergedRows += current.length + incoming.length;
  const byId = new Map<string, MessageRecord>();
  for (const message of current) byId.set(message._id, message);
  for (const message of incoming) byId.set(message._id, message);
  return Array.from(byId.values()).sort(compareMessageOrder);
}

function mergeReadMessages(
  current: MessageRecord[],
  incoming: MessageRecord[],
): MessageRecord[] {
  const currentById = new Map(current.map((message) => [message._id, message]));
  const reconciled = incoming.map((message) => {
    const resident = currentById.get(message._id);
    if (!resident?.toolEventSummary?.detailLoaded) return message;
    const toolEvents = new Map(
      [...resident.toolEvents, ...message.toolEvents].map((event) => [
        event._id,
        event,
      ]),
    );
    const retainedEvents = retainBoundedToolEvents(
      [...toolEvents.values()].sort(compareEventOrder),
    );
    const incomingPayloadProjected = message.toolEvents.some(
      hasProjectedEagerPayload,
    );
    return {
      ...message,
      toolEvents: retainedEvents,
      toolEventSummary: incomingPayloadProjected
        ? {
            totalCount: Math.max(
              resident.toolEventSummary.totalCount,
              message.toolEventSummary?.totalCount ?? retainedEvents.length,
            ),
            loadedCount: retainedEvents.length,
            truncated: true,
            ...(resident.toolEventSummary.totalCountIsLowerBound === true ||
            message.toolEventSummary?.totalCountIsLowerBound === true
              ? { totalCountIsLowerBound: true }
              : {}),
          }
        : resident.toolEventSummary,
    };
  });
  return mergeOrderedMessages(current, reconciled);
}

function reconcileLatestMessages(
  current: MessageRecord[],
  incoming: MessageRecord[],
): MessageRecord[] {
  const incomingIds = new Set(incoming.map((message) => message._id));
  return mergeReadMessages(current, incoming).filter((message) =>
    incomingIds.has(message._id),
  );
}

function compareEventOrder(a: EventRecord, b: EventRecord): number {
  if (
    typeof a.sequence === "number" &&
    typeof b.sequence === "number" &&
    a.sequence !== b.sequence
  ) {
    return a.sequence - b.sequence;
  }
  return a.timestamp - b.timestamp || a._id.localeCompare(b._id);
}

function retainBoundedToolEvents(events: EventRecord[]): EventRecord[] {
  if (events.length <= MAX_RETAINED_TOOL_DETAIL_EVENTS) return events;
  const headCount = MAX_RETAINED_TOOL_DETAIL_EVENTS / 2;
  return [
    ...events.slice(0, headCount),
    ...events.slice(-(MAX_RETAINED_TOOL_DETAIL_EVENTS - headCount)),
  ];
}

function cursorForMessage(message: MessageRecord): LocalChatTimelineCursor {
  return {
    timestamp: message.timestamp,
    id: message._id,
    ...(typeof message.sequence === "number"
      ? { sequence: message.sequence }
      : {}),
  };
}

function compareCursors(
  a: LocalChatTimelineCursor,
  b: LocalChatTimelineCursor,
): number {
  if (
    typeof a.sequence === "number" &&
    typeof b.sequence === "number" &&
    a.sequence !== b.sequence
  ) {
    return a.sequence - b.sequence;
  }
  return a.timestamp - b.timestamp || a.id.localeCompare(b.id);
}

function advanceTailCursor(
  entry: TimelineEntry,
  cursor: LocalChatTimelineCursor | undefined,
) {
  if (!cursor) return;
  if (!entry.tailCursor || compareCursors(cursor, entry.tailCursor) > 0) {
    entry.tailCursor = cursor;
  }
}

function replayPendingReadEvents(entry: TimelineEntry) {
  if (entry.pendingEventsDuringRead.size === 0) return;
  const pending = [...entry.pendingEventsDuringRead.values()].sort(
    compareEventOrder,
  );
  entry.pendingEventsDuringRead.clear();
  for (const event of pending) {
    const patched = patchNotifiedEvent(entry, event);
    if (
      !patched &&
      (event.type === "user_message" ||
        event.type === "assistant_message" ||
        (entry.tailCursor !== null &&
          compareEventToCursor(event, entry.tailCursor) <= 0))
    ) {
      entry.queuedLatestRefresh = true;
    }
  }
}

function newestMessages(
  messages: MessageRecord[],
  count: number,
): MessageRecord[] {
  return messages.length <= count
    ? messages
    : messages.slice(messages.length - count);
}

function oldestMessages(
  messages: MessageRecord[],
  count: number,
): MessageRecord[] {
  return messages.length <= count ? messages : messages.slice(0, count);
}

function touch(entry: TimelineEntry) {
  entry.lastUsed = ++useCounter;
}

function publish(entry: TimelineEntry, snapshot: MessageTimelineSnapshot) {
  const stable = stabilizeMessageList(snapshot.messages, entry.stability);
  entry.stability = stable;
  entry.snapshot =
    stable.result === snapshot.messages
      ? snapshot
      : { ...snapshot, messages: stable.result };
  const retainedMessageIds = new Set(
    entry.snapshot.messages.map((message) => message._id),
  );
  for (const messageId of entry.liveToolEventPins.keys()) {
    if (!retainedMessageIds.has(messageId)) {
      entry.liveToolEventPins.delete(messageId);
    }
  }
  for (const messageId of entry.detailResetRequired) {
    if (!retainedMessageIds.has(messageId)) {
      entry.detailResetRequired.delete(messageId);
    }
  }
  touch(entry);
  debugStats.maxResidentMessages = Math.max(
    debugStats.maxResidentMessages,
    entry.snapshot.messages.length,
  );
  debugStats.activeEntries = Array.from(entries.values()).filter(
    (candidate) => candidate.listeners.size > 0,
  ).length;
  debugStats.pendingReads = Array.from(entries.values()).filter(
    (candidate) => candidate.inFlight !== null,
  ).length;
  for (const listener of entry.listeners) listener(entry.snapshot);
}

function setLoading(entry: TimelineEntry, kind: ReadKind, loading: boolean) {
  publish(entry, {
    ...entry.snapshot,
    isLoadingOlder: kind === "older" ? loading : entry.snapshot.isLoadingOlder,
    isLoadingNewer:
      kind === "newer" || kind === "latest"
        ? loading
        : entry.snapshot.isLoadingNewer,
    error: loading ? null : entry.snapshot.error,
  });
}

function getOrCreateEntry(conversationId: string): TimelineEntry {
  const existing = entries.get(conversationId);
  if (existing) {
    touch(existing);
    return existing;
  }

  const entry: TimelineEntry = {
    conversationId,
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    requestId: 0,
    inFlight: null,
    failedRead: null,
    queuedTailRefresh: false,
    queuedLatestRefresh: false,
    tailCursor: null,
    mutationRevision: 0,
    pendingEventsDuringRead: new Map(),
    liveToolEventPins: new Map(),
    detailResetRequired: new Set(),
    lastUsed: ++useCounter,
    stability: null,
  };
  entries.set(conversationId, entry);
  evictUnusedEntries();
  return entry;
}

function evictUnusedEntries() {
  const unused = Array.from(entries.values())
    .filter((entry) => entry.listeners.size === 0 && entry.inFlight === null)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (unused.length > MAX_RETAINED_UNUSED_CONVERSATIONS) {
    const entry = unused.shift();
    if (entry) entries.delete(entry.conversationId);
  }
}

function finishRead(entry: TimelineEntry, requestId: number) {
  if (entry.requestId !== requestId) return false;
  entry.inFlight = null;
  debugStats.pendingReads = Math.max(0, debugStats.pendingReads - 1);
  const shouldRefreshTail = entry.queuedTailRefresh;
  const shouldRefreshLatest = entry.queuedLatestRefresh;
  entry.queuedTailRefresh = false;
  entry.queuedLatestRefresh = false;
  if (
    (shouldRefreshLatest || (shouldRefreshTail && !entry.snapshot.hasNewer)) &&
    entry.listeners.size > 0
  ) {
    queueMicrotask(
      () =>
        void (shouldRefreshLatest
          ? readInitial(entry, "latest")
          : readTail(entry)),
    );
  }
  return true;
}

async function readInitial(entry: TimelineEntry, kind: "initial" | "latest") {
  const api = getApi();
  if (!api || entry.inFlight) return false;

  entry.inFlight = kind;
  const requestId = ++entry.requestId;
  if (kind === "initial") debugStats.initialReads += 1;
  else debugStats.latestReads += 1;
  setLoading(entry, kind, true);

  try {
    const result = await api.listMessages({
      conversationId: entry.conversationId,
      maxVisibleMessages: MESSAGE_TIMELINE_PAGE_SIZE + 1,
    });
    const incoming = visibleMessages(result.messages);
    if (entry.requestId !== requestId) return false;
    const messages =
      kind === "latest"
        ? reconcileLatestMessages(entry.snapshot.messages, incoming)
        : incoming;
    const hasOlder =
      result.visibleMessageCount > MESSAGE_TIMELINE_PAGE_SIZE ||
      messages.length > MESSAGE_TIMELINE_PAGE_SIZE;
    const newestIncoming = incoming.at(-1);
    const nextCursor =
      result.nextCursor ??
      (newestIncoming ? cursorForMessage(newestIncoming) : undefined);
    if (kind === "initial") entry.tailCursor = nextCursor ?? null;
    else advanceTailCursor(entry, nextCursor);
    publish(entry, {
      messages: newestMessages(messages, MESSAGE_TIMELINE_PAGE_SIZE),
      hasLoaded: true,
      hasOlder,
      hasNewer: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      error: null,
    });
    replayPendingReadEvents(entry);
    entry.failedRead = null;
    return true;
  } catch (error) {
    if (entry.requestId === requestId) {
      entry.pendingEventsDuringRead.clear();
      entry.failedRead = kind;
      publish(entry, {
        ...entry.snapshot,
        hasLoaded: true,
        isLoadingOlder: false,
        isLoadingNewer: false,
        error: normalizeError(error),
      });
    }
    return false;
  } finally {
    finishRead(entry, requestId);
  }
}

async function readOlder(entry: TimelineEntry) {
  const api = getApi();
  const oldest = entry.snapshot.messages[0];
  if (!api?.listMessagesBefore || !oldest || entry.inFlight) return false;

  entry.inFlight = "older";
  const requestId = ++entry.requestId;
  debugStats.olderReads += 1;
  setLoading(entry, "older", true);

  try {
    const result = await api.listMessagesBefore({
      conversationId: entry.conversationId,
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
      maxVisibleMessages: MESSAGE_TIMELINE_PAGE_SIZE + 1,
    });
    const page = visibleMessages(result.messages);
    if (entry.requestId !== requestId) return false;

    const hasOlder = result.visibleMessageCount > MESSAGE_TIMELINE_PAGE_SIZE;
    let messages = mergeReadMessages(
      entry.snapshot.messages,
      newestMessages(page, MESSAGE_TIMELINE_PAGE_SIZE),
    );
    let hasNewer = entry.snapshot.hasNewer;
    if (messages.length > MAX_RETAINED_TIMELINE_MESSAGES) {
      messages = oldestMessages(messages, MAX_RETAINED_TIMELINE_MESSAGES);
      hasNewer = true;
    }
    publish(entry, {
      messages,
      hasLoaded: true,
      hasOlder,
      hasNewer,
      isLoadingOlder: false,
      isLoadingNewer: false,
      error: null,
    });
    replayPendingReadEvents(entry);
    entry.failedRead = null;
    return true;
  } catch (error) {
    if (entry.requestId === requestId) {
      entry.pendingEventsDuringRead.clear();
      entry.failedRead = "older";
      publish(entry, {
        ...entry.snapshot,
        isLoadingOlder: false,
        error: normalizeError(error),
      });
    }
    return false;
  } finally {
    finishRead(entry, requestId);
  }
}

function strictMessagesAfter(
  messages: MessageRecord[],
  cursor: MessageRecord,
): MessageRecord[] {
  return messages.filter((message) => compareMessageOrder(message, cursor) > 0);
}

async function readNewer(entry: TimelineEntry) {
  const api = getApi();
  const currentAtStart = entry.snapshot.messages;
  const newest = currentAtStart[currentAtStart.length - 1];
  const queryCursor = currentAtStart[currentAtStart.length - 2] ?? newest;
  if (!newest && entry.snapshot.hasLoaded && !entry.inFlight) {
    return readInitial(entry, "latest");
  }
  if (!api?.listMessagesAfter || !newest || !queryCursor || entry.inFlight) {
    return false;
  }

  entry.inFlight = "newer";
  const requestId = ++entry.requestId;
  const mutationRevision = entry.mutationRevision;
  debugStats.newerReads += 1;
  setLoading(entry, "newer", true);

  try {
    const result = await api.listMessagesAfter({
      conversationId: entry.conversationId,

      afterTimestampMs: queryCursor.timestamp,
      afterId: queryCursor._id,
      afterSequence: queryCursor.sequence,
      maxVisibleMessages: MESSAGE_TIMELINE_PAGE_SIZE + 2,
    });
    const changed = visibleMessages(result.messages);
    if (entry.requestId !== requestId) return false;

    const strict = strictMessagesAfter(changed, newest);
    const hasNewer = strict.length > MESSAGE_TIMELINE_PAGE_SIZE;
    if (!hasNewer) advanceTailCursor(entry, result.nextCursor);
    const current = entry.snapshot.messages;
    const currentIds = new Set(current.map((message) => message._id));
    const pageIds = new Set(
      oldestMessages(strict, MESSAGE_TIMELINE_PAGE_SIZE).map(
        (message) => message._id,
      ),
    );
    const eligibleChanged = changed.filter(
      (message) => currentIds.has(message._id) || pageIds.has(message._id),
    );
    let messages =
      entry.mutationRevision === mutationRevision
        ? mergeOrderedMessages(current, eligibleChanged)
        : mergeReadMessages(current, eligibleChanged);
    let hasOlder = entry.snapshot.hasOlder;
    if (messages.length > MAX_RETAINED_TIMELINE_MESSAGES) {
      messages = newestMessages(messages, MAX_RETAINED_TIMELINE_MESSAGES);
      hasOlder = true;
    }
    publish(entry, {
      messages,
      hasLoaded: true,
      hasOlder,
      hasNewer,
      isLoadingOlder: false,
      isLoadingNewer: false,
      error: null,
    });
    replayPendingReadEvents(entry);
    entry.failedRead = null;
    return true;
  } catch (error) {
    if (entry.requestId === requestId) {
      entry.pendingEventsDuringRead.clear();
      entry.failedRead = "newer";
      publish(entry, {
        ...entry.snapshot,
        isLoadingNewer: false,
        error: normalizeError(error),
      });
    }
    return false;
  } finally {
    finishRead(entry, requestId);
  }
}

async function readTail(entry: TimelineEntry) {
  const api = getApi();
  const currentAtStart = entry.snapshot.messages;
  const newest = currentAtStart[currentAtStart.length - 1];
  const queryCursor = entry.tailCursor ?? newest;
  if (!newest && entry.snapshot.hasLoaded && !entry.inFlight) {
    return readInitial(entry, "latest");
  }
  if (
    !api?.listMessagesAfter ||
    !newest ||
    !queryCursor ||
    entry.inFlight ||
    entry.snapshot.hasNewer
  ) {
    if (entry.inFlight) entry.queuedTailRefresh = true;
    return false;
  }

  entry.inFlight = "tail";
  const requestId = ++entry.requestId;
  const mutationRevision = entry.mutationRevision;
  debugStats.tailReads += 1;
  debugStats.pendingReads += 1;
  try {
    const result = await api.listMessagesAfter({
      conversationId: entry.conversationId,
      afterTimestampMs: queryCursor.timestamp,
      afterId: "_id" in queryCursor ? queryCursor._id : queryCursor.id,
      afterSequence: queryCursor.sequence,
      maxVisibleMessages: MESSAGE_TIMELINE_PAGE_SIZE + 2,
    });
    const changed = visibleMessages(result.messages);
    if (entry.requestId !== requestId) return false;
    advanceTailCursor(entry, result.nextCursor);

    const strict = strictMessagesAfter(changed, newest);

    if (strict.length > MESSAGE_TIMELINE_PAGE_SIZE) {
      finishRead(entry, requestId);
      return readInitial(entry, "latest");
    }

    const current = entry.snapshot.messages;
    const currentIds = new Set(current.map((message) => message._id));
    const eligibleChanged = changed.filter(
      (message) =>
        currentIds.has(message._id) || compareMessageOrder(message, newest) > 0,
    );

    let messages =
      entry.mutationRevision === mutationRevision
        ? mergeOrderedMessages(current, eligibleChanged)
        : mergeReadMessages(current, eligibleChanged);
    let hasOlder = entry.snapshot.hasOlder;
    if (messages.length > MAX_RETAINED_TIMELINE_MESSAGES) {
      messages = newestMessages(messages, MAX_RETAINED_TIMELINE_MESSAGES);
      hasOlder = true;
    }
    publish(entry, {
      ...entry.snapshot,
      messages,
      hasLoaded: true,
      hasOlder,
      isLoadingOlder: false,
      isLoadingNewer: false,
      error: null,
    });
    replayPendingReadEvents(entry);
    entry.failedRead = null;
    return true;
  } catch (error) {
    if (entry.requestId === requestId) {
      entry.pendingEventsDuringRead.clear();
      entry.failedRead = "tail";
      publish(entry, { ...entry.snapshot, error: normalizeError(error) });
    }
    return false;
  } finally {
    finishRead(entry, requestId);
  }
}

function compareEventToCursor(
  event: NonNullable<LocalChatUpdatedPayload["event"]>,
  cursor: LocalChatTimelineCursor,
): number {
  if (
    typeof event.sequence === "number" &&
    typeof cursor.sequence === "number"
  ) {
    return event.sequence - cursor.sequence;
  }
  return (
    event.timestamp - cursor.timestamp || event._id.localeCompare(cursor.id)
  );
}

function compareToolEventToCursor(
  event: EventRecord,
  cursor: LocalChatTimelineCursor,
): number {
  if (
    typeof event.sequence === "number" &&
    typeof cursor.sequence === "number"
  ) {
    return event.sequence - cursor.sequence;
  }
  return (
    event.timestamp - cursor.timestamp || event._id.localeCompare(cursor.id)
  );
}

function hasProjectedEagerPayload(event: EventRecord): boolean {
  const payload = event.payload as
    | { __stellaEagerProjection?: { truncated?: unknown } }
    | null
    | undefined;
  return payload?.__stellaEagerProjection?.truncated === true;
}

function rememberLiveToolEvent(
  entry: TimelineEntry,
  messageId: string,
  event: EventRecord,
) {
  const message = entry.snapshot.messages.find(
    (candidate) => candidate._id === messageId,
  );
  const readKey = `${entry.conversationId}\n${messageId}`;
  if (
    message?.toolEventSummary?.detailLoaded !== true &&
    !detailReads.has(readKey)
  ) {
    return;
  }
  const pins = entry.liveToolEventPins.get(messageId) ?? new Map();
  pins.set(event._id, event);
  while (pins.size > EAGER_TOOL_EVENT_LIMIT) {
    const oldestId = pins.keys().next().value as string | undefined;
    if (!oldestId) break;
    pins.delete(oldestId);
    entry.detailResetRequired.add(messageId);
  }
  entry.liveToolEventPins.set(messageId, pins);
}

function patchNotifiedEvent(
  entry: TimelineEntry,
  event: NonNullable<LocalChatUpdatedPayload["event"]>,
): boolean {
  let changed = false;
  const eventWasKnown = entry.snapshot.messages.some(
    (message) =>
      message._id === event._id ||
      message.toolEvents.some((candidate) => candidate._id === event._id),
  );
  const messages = entry.snapshot.messages.map((message) => {
    if (message._id === event._id) {
      changed = true;
      return { ...message, ...event, toolEvents: message.toolEvents };
    }
    const eventIndex = message.toolEvents.findIndex(
      (candidate) => candidate._id === event._id,
    );
    if (eventIndex < 0) return message;
    const toolEvents = message.toolEvents.slice();
    toolEvents[eventIndex] = event;
    changed = true;
    const payloadProjected = hasProjectedEagerPayload(event);
    if (payloadProjected) entry.detailResetRequired.add(message._id);
    const detailLoaded = message.toolEventSummary?.detailLoaded === true;
    const detailCursor = message.toolEventSummary?.detailCursor;
    const requiresLivePin = !(
      detailLoaded &&
      detailCursor &&
      compareToolEventToCursor(event, detailCursor) <= 0
    );
    if (requiresLivePin) rememberLiveToolEvent(entry, message._id, event);
    return {
      ...message,
      toolEvents,
      ...(detailLoaded && requiresLivePin
        ? {
            toolEventSummary: {
              ...message.toolEventSummary,
              totalCount:
                message.toolEventSummary?.totalCount ?? toolEvents.length,
              loadedCount: message.toolEventSummary?.loadedCount ?? 0,
              truncated: true,
              totalCountIsLowerBound: true,
              livePinsPending: true,
            },
          }
        : payloadProjected
          ? {
              toolEventSummary: {
                ...message.toolEventSummary,
                totalCount:
                  message.toolEventSummary?.totalCount ?? toolEvents.length,
                loadedCount:
                  message.toolEventSummary?.loadedCount ?? toolEvents.length,
                truncated: true,
                ...(message.toolEventSummary?.totalCountIsLowerBound === true
                  ? { totalCountIsLowerBound: true }
                  : {}),
              },
            }
        : {}),
    };
  });
  if (
    !changed &&
    event.type !== "user_message" &&
    event.type !== "assistant_message"
  ) {
    let previousIndex = -1;
    let nextIndex = messages.length;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      const comparison =
        typeof event.sequence === "number" &&
        typeof message.sequence === "number"
          ? event.sequence - message.sequence
          : event.timestamp - message.timestamp ||
            event._id.localeCompare(message._id);
      if (comparison > 0) previousIndex = index;
      else {
        nextIndex = index;
        break;
      }
    }
    let targetIndex = previousIndex;
    if (
      previousIndex >= 0 &&
      messages[previousIndex]?.type === "user_message" &&
      nextIndex < messages.length &&
      messages[nextIndex]?.type === "assistant_message"
    ) {
      targetIndex = nextIndex;
    }
    const target = messages[targetIndex];
    if (target) {
      let toolEvents = [...target.toolEvents, event].sort((a, b) => {
        if (typeof a.sequence === "number" && typeof b.sequence === "number") {
          return a.sequence - b.sequence;
        }
        return a.timestamp - b.timestamp || a._id.localeCompare(b._id);
      });
      const detailLoaded = target.toolEventSummary?.detailLoaded === true;
      const exceededEagerLimit = toolEvents.length > EAGER_TOOL_EVENT_LIMIT;
      if (exceededEagerLimit && !detailLoaded) {
        const withoutPinned = toolEvents.filter(
          (candidate) => candidate._id !== event._id,
        );
        toolEvents = [
          ...withoutPinned.slice(0, EAGER_TOOL_EVENT_LIMIT / 2 - 1),
          event,
          ...withoutPinned.slice(-(EAGER_TOOL_EVENT_LIMIT / 2)),
        ].sort((a, b) => {
          if (
            typeof a.sequence === "number" &&
            typeof b.sequence === "number"
          ) {
            return a.sequence - b.sequence;
          }
          return a.timestamp - b.timestamp || a._id.localeCompare(b._id);
        });
      }
      const detailCursor = target.toolEventSummary?.detailCursor;
      rememberLiveToolEvent(entry, target._id, event);
      if (detailLoaded && detailCursor) {
        const prefix = toolEvents.filter(
          (candidate) => compareToolEventToCursor(candidate, detailCursor) <= 0,
        );
        const livePins = toolEvents
          .filter(
            (candidate) =>
              compareToolEventToCursor(candidate, detailCursor) > 0,
          )
          .slice(-EAGER_TOOL_EVENT_LIMIT);
        toolEvents = retainBoundedToolEvents([...prefix, ...livePins]);
      }
      const priorTotal = target.toolEventSummary?.totalCount ?? 0;
      const payloadProjected = hasProjectedEagerPayload(event);
      if (payloadProjected) entry.detailResetRequired.add(target._id);
      const canSafelyIncrementTotal =
        target.toolEventSummary?.totalCountIsLowerBound !== true;
      const totalIncrement = eventWasKnown || !canSafelyIncrementTotal ? 0 : 1;
      const loadedCount = detailLoaded
        ? (target.toolEventSummary?.loadedCount ?? 0)
        : toolEvents.length;
      const totalCount = detailLoaded
        ? Math.max(priorTotal + totalIncrement, loadedCount)
        : Math.max(
            priorTotal + totalIncrement,
            toolEvents.length + (exceededEagerLimit ? 1 : 0),
          );
      const truncated =
        payloadProjected ||
        detailLoaded ||
        (!detailLoaded &&
          (exceededEagerLimit || target.toolEventSummary?.truncated === true));
      messages[targetIndex] = {
        ...target,
        toolEvents,
        toolEventSummary: {
          totalCount,
          loadedCount,
          truncated,
          ...(target.toolEventSummary?.totalCountIsLowerBound === true ||
          exceededEagerLimit ||
          detailLoaded
            ? { totalCountIsLowerBound: true }
            : {}),
          ...(detailLoaded ? { detailLoaded: true } : {}),
          ...(detailCursor ? { detailCursor } : {}),
          ...(typeof target.toolEventSummary?.detailHasMore === "boolean"
            ? { detailHasMore: target.toolEventSummary.detailHasMore }
            : {}),
          ...(detailLoaded ? { livePinsPending: true } : {}),
        },
      };
      changed = true;
    }
  }
  if (changed) {
    entry.mutationRevision += 1;
    publish(entry, { ...entry.snapshot, messages });
  }
  return changed;
}

function handleLocalUpdate(payload: LocalChatUpdatedPayload | null) {
  if (!payload?.conversationId) return;
  const entry = entries.get(payload.conversationId);
  if (!entry || entry.listeners.size === 0) return;

  if (!payload.event) {
    if (entry.inFlight) entry.queuedLatestRefresh = true;
    else void readInitial(entry, "latest");
    return;
  }
  if (entry.snapshot.hasNewer) return;
  {
    if (entry.inFlight) {
      entry.pendingEventsDuringRead.set(payload.event._id, payload.event);
      entry.queuedTailRefresh = true;
    }
    const patched = patchNotifiedEvent(entry, payload.event);
    const authored =
      payload.event.type === "user_message" ||
      payload.event.type === "assistant_message";
    const atOrBeforeDurableCursor =
      entry.tailCursor !== null &&
      compareEventToCursor(payload.event, entry.tailCursor) <= 0;
    if (entry.inFlight) return;
    if (!authored && patched) return;
    if (atOrBeforeDurableCursor) {

      if (!patched) void readInitial(entry, "latest");
      return;
    }
    void readTail(entry);
  }
}

function syncUpdateSubscription() {
  const hasActiveEntries = Array.from(entries.values()).some(
    (entry) => entry.listeners.size > 0,
  );
  if (hasActiveEntries && !updateUnsubscribe) {
    updateUnsubscribe = getApi()?.onUpdated?.(handleLocalUpdate) ?? null;
  } else if (!hasActiveEntries && updateUnsubscribe) {
    updateUnsubscribe();
    updateUnsubscribe = null;
  }
}

const detailReads = new Set<string>();

export async function loadLocalMessageToolEventPage(
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const api = getApi();
  const entry = entries.get(conversationId);
  const message = entry?.snapshot.messages.find(
    (candidate) => candidate._id === messageId,
  );
  const readKey = `${conversationId}\n${messageId}`;
  if (
    !api?.listMessageToolEvents ||
    !entry ||
    !message ||
    detailReads.has(readKey)
  ) {
    return false;
  }
  if (!message.toolEventSummary?.truncated) return false;
  detailReads.add(readKey);
  const restartFromBeginning = entry.detailResetRequired.delete(messageId);
  const pinsAtReadStart = new Map(entry.liveToolEventPins.get(messageId) ?? []);
  try {
    const detailLoaded = message.toolEventSummary.detailLoaded === true;
    const last =
      !restartFromBeginning && detailLoaded
        ? message.toolEventSummary?.detailCursor
        : undefined;
    const page = await api.listMessageToolEvents({
      conversationId,
      messageTimestampMs: message.timestamp,
      messageId: message._id,
      messageSequence: message.sequence,
      ...(last
        ? {
            afterTimestampMs: last.timestamp,
            afterId: last.id,
            afterSequence: last.sequence,
          }
        : {}),
      limit: 100,
    });
    const current = entry.snapshot.messages.find(
      (candidate) => candidate._id === messageId,
    );
    if (!current) return false;
    const pins = entry.liveToolEventPins.get(messageId) ?? new Map();
    for (const event of page.events) {
      const currentPin = pins.get(event._id);
      if (
        currentPin !== undefined &&
        pinsAtReadStart.get(event._id) === currentPin
      ) {
        pins.delete(event._id);
      }
    }
    if (pins.size === 0) entry.liveToolEventPins.delete(messageId);
    else entry.liveToolEventPins.set(messageId, pins);

    const uncoveredInsidePage =
      page.nextCursor !== undefined &&
      [...pins.values()].some(
        (event) => compareToolEventToCursor(event, page.nextCursor!) <= 0,
      );
    const nextDetailCursor = uncoveredInsidePage
      ? last
      : (page.nextCursor ?? last);
    const historicalDetailHasMore =
      page.hasMore ||
      uncoveredInsidePage ||
      entry.detailResetRequired.has(messageId);
    const livePinsPending = pins.size > 0;
    const hasUnreadDurableEvents = historicalDetailHasMore || livePinsPending;
    const mergedEvents = [
      ...new Map(
        [...current.toolEvents, ...page.events, ...pins.values()].map(
          (event) => [event._id, event],
        ),
      ).values(),
    ].sort(compareEventOrder);
    const events = retainBoundedToolEvents(mergedEvents);
    const priorLoadedCount = current.toolEventSummary?.loadedCount ?? 0;
    const loadedCount =
      restartFromBeginning || !detailLoaded
        ? page.events.length
        : priorLoadedCount + page.events.length;
    entry.mutationRevision += 1;
    publish(entry, {
      ...entry.snapshot,
      messages: entry.snapshot.messages.map((candidate) =>
        candidate._id === messageId
          ? {
              ...candidate,
              toolEvents: events,
              toolEventSummary: {
                totalCount: hasUnreadDurableEvents
                  ? Math.max(
                      candidate.toolEventSummary?.totalCount ?? 0,
                      loadedCount + 1,
                    )
                  : loadedCount,
                loadedCount,
                truncated: hasUnreadDurableEvents,
                ...(hasUnreadDurableEvents
                  ? { totalCountIsLowerBound: true }
                  : {}),
                detailLoaded: true,
                detailHasMore: historicalDetailHasMore,
                livePinsPending,
                ...(nextDetailCursor ? { detailCursor: nextDetailCursor } : {}),
              },
            }
          : candidate,
      ),
    });
    return true;
  } catch (error) {
    if (restartFromBeginning) entry.detailResetRequired.add(messageId);
    throw error;
  } finally {
    detailReads.delete(readKey);
  }
}

export function subscribeToLocalMessageTimeline(
  conversationId: string,
  listener: Listener,
): () => void {
  const entry = getOrCreateEntry(conversationId);
  entry.listeners.add(listener);
  listener(entry.snapshot);
  syncUpdateSubscription();

  if (!entry.snapshot.hasLoaded) void readInitial(entry, "initial");
  else if (!entry.snapshot.hasNewer) void readTail(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {

      entry.requestId += 1;
      entry.inFlight = null;
      entry.queuedTailRefresh = false;
      entry.queuedLatestRefresh = false;
      entry.pendingEventsDuringRead.clear();
      entry.snapshot = {
        ...entry.snapshot,
        isLoadingOlder: false,
        isLoadingNewer: false,
      };
    }
    syncUpdateSubscription();
    evictUnusedEntries();
  };
}

export function getLocalMessageTimelineSnapshot(
  conversationId: string,
): MessageTimelineSnapshot {
  return getOrCreateEntry(conversationId).snapshot;
}

export function loadOlderLocalMessages(
  conversationId: string,
): false | Promise<boolean> {
  const entry = getOrCreateEntry(conversationId);
  if (!entry.snapshot.hasLoaded || !entry.snapshot.hasOlder || entry.inFlight) {
    return false;
  }
  return readOlder(entry);
}

export function loadNewerLocalMessages(
  conversationId: string,
): false | Promise<boolean> {
  const entry = getOrCreateEntry(conversationId);
  if (!entry.snapshot.hasLoaded || !entry.snapshot.hasNewer || entry.inFlight) {
    return false;
  }
  return readNewer(entry);
}

export function loadLatestLocalMessages(
  conversationId: string,
): false | Promise<boolean> {
  const entry = getOrCreateEntry(conversationId);
  if (!entry.snapshot.hasLoaded || !entry.snapshot.hasNewer || entry.inFlight) {
    return false;
  }
  return readInitial(entry, "latest");
}

export function retryLocalMessageTimeline(
  conversationId: string,
): false | Promise<boolean> {
  const entry = getOrCreateEntry(conversationId);
  if (!entry.snapshot.error || entry.inFlight) return false;
  switch (entry.failedRead) {
    case "older":
      return readOlder(entry);
    case "newer":
      return readNewer(entry);
    case "latest":
      return readInitial(entry, "latest");
    case "tail":
      return readTail(entry);
    case "initial":
    default:
      return readInitial(entry, "initial");
  }
}

export const __testing = {
  getLiveToolEventPinIds(conversationId: string, messageId: string): string[] {
    return [
      ...(entries
        .get(conversationId)
        ?.liveToolEventPins.get(messageId)
        ?.keys() ?? []),
    ];
  },
  getDebugStats(): MessageTimelineDebugStats {
    const retained = Array.from(entries.values());
    return {
      ...debugStats,
      activeEntries: retained.filter((entry) => entry.listeners.size > 0)
        .length,
      pendingReads: retained.filter((entry) => entry.inFlight !== null).length,
      retainedEntries: retained.length,
      residentMessages: retained.reduce(
        (total, entry) => total + entry.snapshot.messages.length,
        0,
      ),
    };
  },
  resetDebugStats() {
    debugStats = createDebugStats();
  },
  reset() {
    updateUnsubscribe?.();
    updateUnsubscribe = null;
    entries.clear();
    detailReads.clear();
    useCounter = 0;
    debugStats = createDebugStats();
  },
};
