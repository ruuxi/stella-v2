import type {
  LocalChatUpdatedPayload,
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
      maxVisibleMessages: MESSAGE_TIMELINE_PAGE_SIZE + 2,
    });
    const changed = visibleMessages(result.messages);
    if (entry.requestId !== requestId) return false;

    const strict = strictMessagesAfter(changed, newest);
    const hasNewer = strict.length > MESSAGE_TIMELINE_PAGE_SIZE;
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
  const queryCursor = current[current.length - 2] ?? newest;
  if (!newest && entry.snapshot.hasLoaded && !entry.inFlight) {
    return readInitial(entry, "latest");
  }
  if (current.length === 1 && entry.snapshot.hasLoaded && !entry.inFlight) {
    // A strictly-after cursor cannot return its own replacement. Tiny new
    // conversations can refresh their single live row through the bounded
    // latest-page read until a preceding cursor exists.
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
      afterId: queryCursor._id,
      maxVisibleMessages: MESSAGE_TIMELINE_PAGE_SIZE + 2,
    });
    const changed = visibleMessages(result.messages);
    if (entry.requestId !== requestId) return false;

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

function handleLocalUpdate(payload: LocalChatUpdatedPayload | null) {
  if (!payload?.conversationId) return;
  const entry = entries.get(payload.conversationId);
  if (!entry || entry.listeners.size === 0) return;
  if (entry.snapshot.hasNewer) return;
  if (entry.inFlight) {
    entry.queuedTailRefresh = true;
    return;
  }
  void readTail(entry);
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
    useCounter = 0;
    debugStats = createDebugStats();
  },
};
