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
  tailCursor: LocalChatTimelineCursor | null;
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
    tailCursor: null,
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
  entry.queuedTailRefresh = false;
  if (
    shouldRefreshTail &&
    !entry.snapshot.hasNewer &&
    entry.listeners.size > 0
  ) {
    queueMicrotask(() => void readTail(entry));
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
    const messages = visibleMessages(result.messages);
    if (entry.requestId !== requestId) return false;
    const hasOlder = result.visibleMessageCount > MESSAGE_TIMELINE_PAGE_SIZE;
    const newest = messages.at(-1);
    entry.tailCursor =
      result.nextCursor ??
      (newest
        ? {
            timestamp: newest.timestamp,
            id: newest._id,
            ...(typeof newest.sequence === "number"
              ? { sequence: newest.sequence }
              : {}),
          }
        : null);
    publish(entry, {
      messages: newestMessages(messages, MESSAGE_TIMELINE_PAGE_SIZE),
      hasLoaded: true,
      hasOlder,
      hasNewer: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
      error: null,
    });
    entry.failedRead = null;
    return true;
  } catch (error) {
    if (entry.requestId === requestId) {
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
    let messages = mergeOrderedMessages(
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
    entry.failedRead = null;
    return true;
  } catch (error) {
    if (entry.requestId === requestId) {
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
  const current = entry.snapshot.messages;
  const newest = current[current.length - 1];
  const queryCursor = current[current.length - 2] ?? newest;
  if (!newest && entry.snapshot.hasLoaded && !entry.inFlight) {
    return readInitial(entry, "latest");
  }
  if (!api?.listMessagesAfter || !newest || !queryCursor || entry.inFlight) {
    return false;
  }

  entry.inFlight = "newer";
  const requestId = ++entry.requestId;
  debugStats.newerReads += 1;
  setLoading(entry, "newer", true);

  try {
    const result = await api.listMessagesAfter({
      conversationId: entry.conversationId,
      // Start one loaded row behind the live edge. The strictly-after storage
      // contract then returns the newest row itself if streaming or tool
      // artifacts replaced it, followed by a full page plus look-ahead.
      afterTimestampMs: queryCursor.timestamp,
      afterId: queryCursor._id,
      afterSequence: queryCursor.sequence,
      maxVisibleMessages: MESSAGE_TIMELINE_PAGE_SIZE + 2,
    });
    const changed = visibleMessages(result.messages);
    if (entry.requestId !== requestId) return false;

    const strict = strictMessagesAfter(changed, newest);
    const hasNewer = strict.length > MESSAGE_TIMELINE_PAGE_SIZE;
    if (!hasNewer && result.nextCursor) entry.tailCursor = result.nextCursor;
    const currentIds = new Set(current.map((message) => message._id));
    const pageIds = new Set(
      oldestMessages(strict, MESSAGE_TIMELINE_PAGE_SIZE).map(
        (message) => message._id,
      ),
    );
    const eligibleChanged = changed.filter(
      (message) => currentIds.has(message._id) || pageIds.has(message._id),
    );
    let messages = mergeOrderedMessages(current, eligibleChanged);
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
    entry.failedRead = null;
    return true;
  } catch (error) {
    if (entry.requestId === requestId) {
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
  const current = entry.snapshot.messages;
  const newest = current[current.length - 1];
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
    if (result.nextCursor) entry.tailCursor = result.nextCursor;

    const strict = strictMessagesAfter(changed, newest);
    // A saturated tail response is intentionally collapsed to a fresh latest
    // page. This can only happen after the renderer missed more than one page
    // of updates while it was inactive; incremental streaming stays append-only.
    if (strict.length > MESSAGE_TIMELINE_PAGE_SIZE) {
      finishRead(entry, requestId);
      return readInitial(entry, "latest");
    }

    const currentIds = new Set(current.map((message) => message._id));
    const eligibleChanged = changed.filter(
      (message) =>
        currentIds.has(message._id) || compareMessageOrder(message, newest) > 0,
    );
    let messages = mergeOrderedMessages(current, eligibleChanged);
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
    entry.failedRead = null;
    return true;
  } catch (error) {
    if (entry.requestId === requestId) {
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
  return event.timestamp - cursor.timestamp || event._id.localeCompare(cursor.id);
}

/** Apply an in-place event upsert without reopening the durable tail. */
function patchNotifiedEvent(
  entry: TimelineEntry,
  event: NonNullable<LocalChatUpdatedPayload["event"]>,
): boolean {
  let changed = false;
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
    return { ...message, toolEvents };
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
      if (
        exceededEagerLimit &&
        !detailLoaded
      ) {
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
      if (detailLoaded && detailCursor) {
        const prefix = toolEvents.filter(
          (candidate) => compareToolEventToCursor(candidate, detailCursor) <= 0,
        );
        const livePins = toolEvents
          .filter(
            (candidate) => compareToolEventToCursor(candidate, detailCursor) > 0,
          )
          .slice(-EAGER_TOOL_EVENT_LIMIT);
        toolEvents = [...prefix, ...livePins];
      }
      const isNewTailEvent =
        !entry.tailCursor || compareEventToCursor(event, entry.tailCursor) > 0;
      const priorTotal = target.toolEventSummary?.totalCount ?? 0;
      const hasIncompleteDetail = detailLoaded && isNewTailEvent;
      const totalCount = detailLoaded
        ? Math.max(priorTotal + (isNewTailEvent ? 1 : 0), toolEvents.length)
        : Math.max(
            priorTotal + (isNewTailEvent ? 1 : 0),
            toolEvents.length + (exceededEagerLimit ? 1 : 0),
          );
      const truncated =
        hasIncompleteDetail ||
        (!detailLoaded &&
          (exceededEagerLimit || target.toolEventSummary?.truncated === true));
      messages[targetIndex] = {
        ...target,
        toolEvents,
        toolEventSummary: {
          totalCount,
          loadedCount: toolEvents.length,
          truncated,
          ...(truncated ? { totalCountIsLowerBound: true } : {}),
          ...(detailLoaded ? { detailLoaded: true } : {}),
          ...(detailCursor ? { detailCursor } : {}),
        },
      };
      changed = true;
    }
  }
  if (changed) publish(entry, { ...entry.snapshot, messages });
  return changed;
}

function handleLocalUpdate(payload: LocalChatUpdatedPayload | null) {
  if (!payload?.conversationId) return;
  const entry = entries.get(payload.conversationId);
  if (!entry || entry.listeners.size === 0) return;
  if (entry.snapshot.hasNewer) return;
  // Destructive update (Rewind truncate): no appended event exists, and an
  // incremental tail read keys strictly AFTER the newest loaded row — it can
  // never observe rows that were REMOVED. Re-read the latest page instead so
  // truncated suffixes drop out of the visible timeline. Append
  // notifications always carry their event and keep using the cheap
  // incremental path below.
  if (payload.event) {
    if (
      payload.event.type !== "user_message" &&
      payload.event.type !== "assistant_message" &&
      patchNotifiedEvent(entry, payload.event)
    ) {
      if (
        !entry.tailCursor ||
        compareEventToCursor(payload.event, entry.tailCursor) > 0
      ) {
        entry.tailCursor = {
          timestamp: payload.event.timestamp,
          id: payload.event._id,
          ...(typeof payload.event.sequence === "number"
            ? { sequence: payload.event.sequence }
            : {}),
        };
      }
      return;
    }
    if (
      entry.tailCursor &&
      compareEventToCursor(payload.event, entry.tailCursor) <= 0
    ) {
      patchNotifiedEvent(entry, payload.event);
      return;
    }
    if (entry.inFlight) {
      entry.queuedTailRefresh = true;
      return;
    }
    void readTail(entry);
  } else if (entry.inFlight) {
    entry.queuedTailRefresh = true;
  } else {
    void readInitial(entry, "latest");
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

/** Load at most one bounded page of complete turn events on explicit demand. */
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
  try {
    const detailLoaded = message.toolEventSummary.detailLoaded === true;
    const last = detailLoaded
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
    const events = detailLoaded
      ? [
          ...new Map(
            [...current.toolEvents, ...page.events].map((event) => [
              event._id,
              event,
            ]),
          ).values(),
        ]
      : page.events;
    publish(entry, {
      ...entry.snapshot,
      messages: entry.snapshot.messages.map((candidate) =>
        candidate._id === messageId
          ? {
              ...candidate,
              toolEvents: events,
              toolEventSummary: {
                totalCount: page.hasMore
                  ? Math.max(
                      candidate.toolEventSummary?.totalCount ?? 0,
                      events.length + 1,
                    )
                  : events.length,
                loadedCount: events.length,
                truncated: page.hasMore,
                ...(page.hasMore ? { totalCountIsLowerBound: true } : {}),
                detailLoaded: true,
                ...(page.nextCursor
                  ? { detailCursor: page.nextCursor }
                  : candidate.toolEventSummary?.detailCursor
                    ? {
                        detailCursor: candidate.toolEventSummary.detailCursor,
                      }
                    : {}),
              },
            }
          : candidate,
      ),
    });
    return true;
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
      // Logical cancellation: IPC itself is not abortable, so invalidate the
      // completion and retain the last settled window for tab restoration.
      entry.requestId += 1;
      entry.inFlight = null;
      entry.queuedTailRefresh = false;
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
