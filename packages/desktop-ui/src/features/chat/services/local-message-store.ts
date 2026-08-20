/**
 * Renderer-side client for the messages-window IPC (`listMessages` /
 * `listMessagesBefore`). Mirrors `local-chat-store.ts` (the raw event
 * window store) but consumes the message-shape that already has each
 * assistant turn's tool/agent-completed events pre-grouped on
 * `MessageRecord.toolEvents`.
 *
 * Subscription model: one entry per `(conversationId, maxVisibleMessages)`
 * key. On a `localChat:updated` notification each active entry refreshes
 * in one of two modes (see `RefreshMode`): a tail-only `listMessagesAfter`
 * read from the window's newest row when the update is attributable to a
 * strictly-newer event, or a full `listMessages` re-read otherwise. The
 * per-turn grouping stays server-side either way — the renderer merge
 * only replaces/appends whole `MessageRecord` rows and never re-derives
 * tool-event grouping in TS.
 */
import type {
  LocalChatUpdatedPayload,
  MessageRecord,
} from "@stella/contracts/local-chat";
import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";

// Absent outside Electron (plain-browser `bun run dev`): chat history lives
// in main-process SQLite, so browser tabs degrade to an empty, update-free
// timeline instead of erroring.
const getLocalChatApi = () => window.electronAPI?.localChat ?? null;

export type LocalMessageWindow = {
  messages: MessageRecord[];
  visibleMessageCount: number;
};

const EMPTY_MESSAGES: MessageRecord[] = [];
const EMPTY_WINDOW: LocalMessageWindow = {
  messages: EMPTY_MESSAGES,
  visibleMessageCount: 0,
};

export const listLocalMessages = async (
  conversationId: string,
  maxVisibleMessages: number,
): Promise<LocalMessageWindow> => {
  const api = getLocalChatApi();
  if (!api) return EMPTY_WINDOW;
  const window = await api.listMessages({
    conversationId,
    maxVisibleMessages,
  });
  return {
    messages: window.messages,
    visibleMessageCount: window.visibleMessageCount,
  };
};

export const listLocalMessagesBefore = async (
  conversationId: string,
  args: {
    beforeTimestampMs: number;
    beforeId: string;
    maxVisibleMessages: number;
  },
): Promise<LocalMessageWindow> => {
  const api = getLocalChatApi();
  if (!api) return EMPTY_WINDOW;
  const window = await api.listMessagesBefore({
    conversationId,
    beforeTimestampMs: args.beforeTimestampMs,
    beforeId: args.beforeId,
    maxVisibleMessages: args.maxVisibleMessages,
  });
  return {
    messages: window.messages,
    visibleMessageCount: window.visibleMessageCount,
  };
};

const listLocalMessagesAfter = async (
  conversationId: string,
  args: {
    afterTimestampMs: number;
    afterId: string;
    maxVisibleMessages: number;
  },
): Promise<LocalMessageWindow> => {
  const api = getLocalChatApi();
  if (!api) return EMPTY_WINDOW;
  const window = await api.listMessagesAfter({
    conversationId,
    afterTimestampMs: args.afterTimestampMs,
    afterId: args.afterId,
    maxVisibleMessages: args.maxVisibleMessages,
  });
  return {
    messages: window.messages,
    visibleMessageCount: window.visibleMessageCount,
  };
};

const subscribeToLocalChatUpdates = (
  listener: (payload: LocalChatUpdatedPayload | null) => void,
): (() => void) => getLocalChatApi()?.onUpdated(listener) ?? (() => {});

export type LocalMessageWindowSnapshot = {
  window: LocalMessageWindow;
  hasLoaded: boolean;
  error: Error | null;
  /**
   * Last observed "the requested page was full". Used by load-older so the
   * hook does not have to grow `maxVisibleMessages` and re-key the
   * subscription. Optional so older snapshot literals in tests stay valid.
   */
  hasOlder?: boolean;
  loadingOlder?: boolean;
};

type LocalMessageWindowOptions = {
  conversationId: string;
  maxVisibleMessages: number;
};

/**
 * How a refresh reads the window:
 *
 *   - `"full"` — re-issue `listMessages` for the whole window. Used for
 *     the initial load, updates we can't attribute to a strictly-newer
 *     event (payload patches like channel edits,
 *     no-payload social notifications), and every fallback path.
 *
 *   - `"tail"` — `listMessagesAfter` from the window's newest row. The
 *     older prefix is immutable (new tool events only ever attach to
 *     anchors in the current turn), so per-event streaming cost stays
 *     proportional to what changed instead of re-serializing the entire
 *     loaded window — the whole-window refetch is what made a deep
 *     `loadOlder` window expensive for the rest of the session.
 */
type RefreshMode = "full" | "tail";

type LocalMessageWindowEntry = LocalMessageWindowOptions & {
  key: string;
  snapshot: LocalMessageWindowSnapshot;
  listeners: Set<(snapshot: LocalMessageWindowSnapshot) => void>;
  loading: Promise<void> | null;
  /**
   * Set whenever `refreshEntry` is called while a previous refresh is
   * still in flight. The in-flight read may have started before the
   * triggering `localChat:updated` event committed to SQLite, so we run
   * one more refresh in the `.finally` block to make sure the window
   * catches up. Drains in a single tail call — concurrent triggers
   * collapse into one follow-up read, escalating to `"full"` when any
   * queued trigger required it.
   */
  pendingRefetch: RefreshMode | null;
  /**
   * Cursor currently being prepended (`timestamp:id`). Distinct from
   * `loading` so a live tail refresh can still run while older history
   * is in flight, and a second call for the same oldest message is a
   * no-op.
   */
  prependInFlight: string | null;
};

const EMPTY_SNAPSHOT: LocalMessageWindowSnapshot = {
  window: EMPTY_WINDOW,
  hasLoaded: false,
  error: null,
  hasOlder: false,
  loadingOlder: false,
};

const RETAINED_CONVERSATION_LIMIT = 10;
const RETAINED_VISIBLE_MESSAGE_LIMIT = 200;
/**
 * Soft bound on a prepended in-memory window. The virtualizer already
 * bounds mounted DOM; this only keeps `useEventRows` from walking every
 * historical tool event after the user has scrolled through many pages.
 * The newest page is never trimmed by a prepend.
 */
export const MAX_CACHED_VISIBLE_MESSAGES = 2_400;

const localMessageWindows = new Map<string, LocalMessageWindowEntry>();

/**
 * Last successfully-loaded window per conversation, bridging the entry
 * teardown→setup gap. Growing the window (`loadOlder`) bumps
 * `maxVisibleMessages`, which re-keys the subscription: React tears down
 * the smaller-window entry (deleting it from `localMessageWindows`)
 * *before* the larger one subscribes, so a live-entry seed lookup finds
 * nothing and the new window would emit an empty snapshot for a frame.
 * That empty flash makes the virtualized list treat the next non-empty
 * render as a fresh mount (re-running its initial scroll-to-end), which
 * throws away the user's scroll position when loading older history.
 * Seeding from this cache keeps the prior messages on screen until the
 * larger window resolves.
 *
 * Lifecycle: successful reads retain only the newest 200-visible-message
 * projection for the 10 most-recently used conversations. Inactive cached
 * conversations never refresh in the background.
 */
const lastLoadedWindowByConversation = new Map<string, LocalMessageWindow>();

const retainLoadedWindow = (
  conversationId: string,
  window: LocalMessageWindow,
) => {
  const retained = trimWindowToVisibleCap(
    window,
    RETAINED_VISIBLE_MESSAGE_LIMIT,
  );
  lastLoadedWindowByConversation.delete(conversationId);
  lastLoadedWindowByConversation.set(conversationId, retained);
  while (lastLoadedWindowByConversation.size > RETAINED_CONVERSATION_LIMIT) {
    const oldest = lastLoadedWindowByConversation.keys().next().value;
    if (!oldest) break;
    lastLoadedWindowByConversation.delete(oldest);
  }
};

const getRetainedWindow = (
  conversationId: string,
): LocalMessageWindow | undefined => {
  const retained = lastLoadedWindowByConversation.get(conversationId);
  if (!retained) return undefined;
  lastLoadedWindowByConversation.delete(conversationId);
  lastLoadedWindowByConversation.set(conversationId, retained);
  return retained;
};
let unsubscribeLocalChatUpdates: (() => void) | null = null;

const localMessageWindowKey = (options: LocalMessageWindowOptions) =>
  [options.conversationId, options.maxVisibleMessages].join("\n");

const cloneSnapshot = (
  snapshot: LocalMessageWindowSnapshot,
): LocalMessageWindowSnapshot => ({ ...snapshot });

const setSnapshot = (
  entry: LocalMessageWindowEntry,
  snapshot: LocalMessageWindowSnapshot,
) => {
  entry.snapshot = snapshot;
  if (
    snapshot.hasLoaded &&
    !snapshot.error &&
    localMessageWindows.get(entry.key) === entry
  ) {
    retainLoadedWindow(entry.conversationId, snapshot.window);
  }
  for (const listener of entry.listeners) {
    listener(cloneSnapshot(snapshot));
  }
};

/** Mirrors the store's `compareTimelineCursor` `(timestamp, id)` ordering. */
const compareMessageOrder = (
  a: { timestamp: number; _id: string },
  b: { timestamp: number; _id: string },
): number => {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a._id.localeCompare(b._id);
};

const countVisibleMessages = (messages: MessageRecord[]): number => {
  let visible = 0;
  for (const message of messages) {
    if (!isUiHiddenChatMessagePayload(message.payload ?? null)) visible += 1;
  }
  return visible;
};

/**
 * Per-tail-refresh cap on changed/new visible rows. Updates are
 * notification-per-event, so a single tick rarely carries more than a few
 * rows; hitting this cap means `listMessagesAfter` may have truncated its
 * result (`limitChangedMessageWindow` stops at the cap) and the caller
 * must fall back to a full refetch rather than merge a partial set.
 */
const TAIL_REFRESH_MAX_VISIBLE = 200;

/**
 * A tail refresh is only sound when the triggering event is strictly
 * newer than the window's newest row. Everything else — payload patches
 * onto existing rows (channel edits/reactions, whose
 * `(timestamp, id)` stays at-or-before the cursor and is therefore
 * invisible to the after-cursor walk), no-payload notifications, unloaded
 * or empty windows — takes the full path.
 */
const resolveRefreshMode = (
  entry: LocalMessageWindowEntry,
  payload: LocalChatUpdatedPayload | null,
): RefreshMode => {
  if (!payload?.conversationId || !payload.event) return "full";
  if (payload.conversationId !== entry.conversationId) return "full";
  const { snapshot } = entry;
  if (!snapshot.hasLoaded || snapshot.error) return "full";
  const newest = snapshot.window.messages.at(-1);
  if (!newest) return "full";
  return compareMessageOrder(payload.event, newest) > 0 ? "tail" : "full";
};

/**
 * Merge a changed-rows result into the current window: rows already in
 * the window are replaced in place (the store returns turn anchors with
 * their *complete* `toolEvents`, not deltas), strictly-newer rows append
 * in order. Changed rows older than the cursor that aren't in the window
 * were trimmed out of it and are skipped.
 */
const mergeChangedMessages = (
  window: LocalMessageWindow,
  cursor: { timestamp: number; _id: string },
  changed: LocalMessageWindow,
): LocalMessageWindow => {
  const indexById = new Map(
    window.messages.map((message, index) => [message._id, index]),
  );
  const next = window.messages.slice();
  const appends: MessageRecord[] = [];
  let visibleMessageCount = window.visibleMessageCount;
  for (const message of changed.messages) {
    const index = indexById.get(message._id);
    if (index !== undefined) {
      const wasHidden = isUiHiddenChatMessagePayload(
        next[index].payload ?? null,
      );
      const isHidden = isUiHiddenChatMessagePayload(message.payload ?? null);
      if (wasHidden !== isHidden) visibleMessageCount += isHidden ? -1 : 1;
      next[index] = message;
      continue;
    }
    if (compareMessageOrder(message, cursor) <= 0) continue;
    appends.push(message);
    if (!isUiHiddenChatMessagePayload(message.payload ?? null)) {
      visibleMessageCount += 1;
    }
  }
  return {
    messages: appends.length > 0 ? [...next, ...appends] : next,
    visibleMessageCount,
  };
};

/**
 * Drop the oldest rows once tail appends push the window past its
 * visible-message cap — the sliding-window behavior a full refetch always
 * had. The trimmed window starts at a visible row, matching the store's
 * cutoff shape.
 */
const trimWindowToVisibleCap = (
  window: LocalMessageWindow,
  maxVisibleMessages: number,
): LocalMessageWindow => {
  if (window.visibleMessageCount <= maxVisibleMessages) return window;
  let visible = 0;
  let start = 0;
  for (let i = window.messages.length - 1; i >= 0; i--) {
    if (!isUiHiddenChatMessagePayload(window.messages[i].payload ?? null)) {
      visible += 1;
      if (visible === maxVisibleMessages) {
        start = i;
        break;
      }
    }
  }
  return {
    messages: window.messages.slice(start),
    visibleMessageCount: visible,
  };
};

const mergeLatestWindowPreservingOlder = (
  existing: LocalMessageWindow,
  latest: LocalMessageWindow,
): LocalMessageWindow => {
  if (existing.messages.length === 0 || latest.messages.length === 0) {
    return latest;
  }
  const latestIds = new Set(latest.messages.map((message) => message._id));
  const latestOldest = latest.messages[0];
  if (!latestOldest) return latest;
  const prefix = existing.messages.filter(
    (message) =>
      !latestIds.has(message._id) &&
      compareMessageOrder(message, latestOldest) < 0,
  );
  if (prefix.length === 0) return latest;
  const messages = [...prefix, ...latest.messages];
  return {
    messages,
    visibleMessageCount: countVisibleMessages(messages),
  };
};

const fullRefresh = async (entry: LocalMessageWindowEntry): Promise<void> => {
  const latest = await listLocalMessages(
    entry.conversationId,
    entry.maxVisibleMessages,
  );
  const window = mergeLatestWindowPreservingOlder(entry.snapshot.window, latest);
  const exhaustedOlder =
    entry.snapshot.hasLoaded && entry.snapshot.hasOlder === false;
  setSnapshot(entry, {
    window,
    hasLoaded: true,
    error: null,
    hasOlder: exhaustedOlder
      ? false
      : latest.visibleMessageCount >= entry.maxVisibleMessages,
    loadingOlder: Boolean(entry.prependInFlight),
  });
};

const tailRefresh = async (entry: LocalMessageWindowEntry): Promise<void> => {
  const { window } = entry.snapshot;
  const cursor = window.messages[window.messages.length - 1];
  if (!cursor) {
    return await fullRefresh(entry);
  }
  const changed = await listLocalMessagesAfter(entry.conversationId, {
    afterTimestampMs: cursor.timestamp,
    afterId: cursor._id,
    maxVisibleMessages: TAIL_REFRESH_MAX_VISIBLE,
  });
  if (changed.visibleMessageCount >= TAIL_REFRESH_MAX_VISIBLE) {
    // The changed set saturated the cap and may be truncated.
    return await fullRefresh(entry);
  }
  if (changed.messages.length === 0) {
    // Nothing in the timeline projection changed (e.g. an agent
    // lifecycle event) — skip the emit so listeners don't re-render.
    return;
  }
  const merged = trimWindowToVisibleCap(
    mergeChangedMessages(entry.snapshot.window, cursor, changed),
    entry.snapshot.window.visibleMessageCount > entry.maxVisibleMessages
      ? MAX_CACHED_VISIBLE_MESSAGES
      : entry.maxVisibleMessages,
  );
  setSnapshot(entry, {
    window: merged,
    hasLoaded: true,
    error: null,
    hasOlder: entry.snapshot.hasOlder,
    loadingOlder: Boolean(entry.prependInFlight),
  });
};

const refreshEntry = (
  entry: LocalMessageWindowEntry,
  mode: RefreshMode = "full",
): Promise<void> => {
  if (entry.loading) {
    // Update arrived mid-read. Mark a follow-up so the `.finally` block
    // re-issues the fetch once the current one resolves — otherwise the
    // window can latch onto a snapshot captured strictly before the
    // triggering write. `"full"` wins when triggers of both modes queue.
    entry.pendingRefetch =
      entry.pendingRefetch === "full" || mode === "full" ? "full" : "tail";
    return entry.loading;
  }
  entry.pendingRefetch = null;
  entry.loading = (mode === "tail" ? tailRefresh(entry) : fullRefresh(entry))
    .catch((error) => {
      setSnapshot(entry, {
        ...entry.snapshot,
        hasLoaded: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    })
    .finally(() => {
      entry.loading = null;
      if (entry.pendingRefetch) {
        const pendingMode = entry.pendingRefetch;
        entry.pendingRefetch = null;
        void refreshEntry(entry, pendingMode);
      }
    });
  return entry.loading;
};

const handleLocalChatUpdated = (payload: LocalChatUpdatedPayload | null) => {
  for (const entry of localMessageWindows.values()) {
    if (
      payload?.conversationId &&
      payload.conversationId !== entry.conversationId
    ) {
      continue;
    }
    void refreshEntry(entry, resolveRefreshMode(entry, payload));
  }
};

const ensureSubscription = () => {
  if (unsubscribeLocalChatUpdates) return;
  unsubscribeLocalChatUpdates = subscribeToLocalChatUpdates(
    handleLocalChatUpdated,
  );
};

const getOrCreateEntry = (
  options: LocalMessageWindowOptions,
): LocalMessageWindowEntry => {
  const key = localMessageWindowKey(options);
  const existing = localMessageWindows.get(key);
  if (existing) return existing;
  const seed = [...localMessageWindows.values()]
    .filter(
      (entry) =>
        entry.conversationId === options.conversationId &&
        entry.snapshot.hasLoaded &&
        entry.maxVisibleMessages < options.maxVisibleMessages,
    )
    .sort((a, b) => b.maxVisibleMessages - a.maxVisibleMessages)[0];
  // Fall back to the retained last-loaded window when no live smaller-
  // window entry survives (the common `loadOlder` teardown-before-setup
  // case). `hasLoaded: false` keeps `isLoadingOlder` accurate until the
  // larger window resolves, while showing the prior messages avoids the
  // empty-flash → list-remount → scroll-reset. A cached window *larger*
  // than the request (a second surface opening a conversation another
  // surface has scrolled deep) is sliced to the newest `maxVisibleMessages`
  // so the seed never renders more rows than the subscription asked for.
  const cachedWindow = getRetainedWindow(options.conversationId);
  const seedWindow = cachedWindow
    ? trimWindowToVisibleCap(cachedWindow, options.maxVisibleMessages)
    : undefined;
  const seedSnapshot: LocalMessageWindowSnapshot | null = seed
    ? { ...cloneSnapshot(seed.snapshot), hasLoaded: false }
    : seedWindow
      ? { window: seedWindow, hasLoaded: false, error: null }
      : null;
  const entry: LocalMessageWindowEntry = {
    ...options,
    key,
    snapshot: seedSnapshot ?? EMPTY_SNAPSHOT,
    listeners: new Set(),
    loading: null,
    pendingRefetch: null,
    prependInFlight: null,
  };
  localMessageWindows.set(key, entry);
  return entry;
};

export const subscribeToLocalMessageWindow = (
  options: LocalMessageWindowOptions,
  listener: (snapshot: LocalMessageWindowSnapshot) => void,
): (() => void) => {
  ensureSubscription();
  const entry = getOrCreateEntry(options);
  entry.listeners.add(listener);
  listener(cloneSnapshot(entry.snapshot));
  void refreshEntry(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      localMessageWindows.delete(entry.key);
    }
    if (localMessageWindows.size === 0 && unsubscribeLocalChatUpdates) {
      unsubscribeLocalChatUpdates();
      unsubscribeLocalChatUpdates = null;
    }
  };
};

const messageCursorKey = (message: { timestamp: number; _id: string }) =>
  `${message.timestamp}:${message._id}`;

const prependOlderMessages = (
  current: LocalMessageWindow,
  older: LocalMessageWindow,
): LocalMessageWindow => {
  if (older.messages.length === 0) return current;
  const existingIds = new Set(current.messages.map((message) => message._id));
  const prefix = older.messages.filter((message) => !existingIds.has(message._id));
  if (prefix.length === 0) return current;
  const messages = [...prefix, ...current.messages];
  return {
    messages,
    visibleMessageCount: countVisibleMessages(messages),
  };
};

export type RequestOlderLocalMessagesResult = {
  accepted: boolean;
  reason:
    | "accepted"
    | "in-flight"
    | "end-of-history"
    | "empty"
    | "no-window"
    | "error";
  prepended: number;
};

/**
 * Fetch one older page via `listMessagesBefore` and prepend it onto every
 * live window for the conversation. Dedupes by the current oldest-message
 * cursor so a flick cannot storm the same page.
 */
export const requestOlderLocalMessages = async (
  conversationId: string,
  pageSize: number,
): Promise<RequestOlderLocalMessagesResult> => {
  const entries = [...localMessageWindows.values()].filter(
    (entry) => entry.conversationId === conversationId,
  );
  const source =
    entries.find((entry) => entry.snapshot.hasLoaded) ?? entries[0];
  if (!source) {
    return { accepted: false, reason: "no-window", prepended: 0 };
  }
  if (source.prependInFlight) {
    return { accepted: false, reason: "in-flight", prepended: 0 };
  }
  const oldest = source.snapshot.window.messages[0];
  if (!oldest) {
    return { accepted: false, reason: "empty", prepended: 0 };
  }
  if (source.snapshot.hasOlder === false) {
    return { accepted: false, reason: "end-of-history", prepended: 0 };
  }
  if (
    source.snapshot.window.visibleMessageCount >= MAX_CACHED_VISIBLE_MESSAGES
  ) {
    return { accepted: false, reason: "end-of-history", prepended: 0 };
  }

  const cursor = messageCursorKey(oldest);
  for (const entry of entries) {
    entry.prependInFlight = cursor;
    setSnapshot(entry, {
      ...entry.snapshot,
      loadingOlder: true,
    });
  }

  try {
    const older = await listLocalMessagesBefore(conversationId, {
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
      maxVisibleMessages: pageSize,
    });
    const liveEntries = [...localMessageWindows.values()].filter(
      (entry) => entry.conversationId === conversationId,
    );
    let prepended = 0;
    for (const entry of liveEntries) {
      const merged = prependOlderMessages(entry.snapshot.window, older);
      const added = merged.messages.length - entry.snapshot.window.messages.length;
      prepended = Math.max(prepended, added);
      const bounded =
        merged.visibleMessageCount > MAX_CACHED_VISIBLE_MESSAGES
          ? trimWindowToVisibleCap(merged, MAX_CACHED_VISIBLE_MESSAGES)
          : merged;
      entry.prependInFlight = null;
      setSnapshot(entry, {
        window: bounded,
        hasLoaded: true,
        error: null,
        hasOlder:
          added > 0 && older.visibleMessageCount >= pageSize,
        loadingOlder: false,
      });
    }
    return { accepted: true, reason: "accepted", prepended };
  } catch (error) {
    const liveEntries = [...localMessageWindows.values()].filter(
      (entry) => entry.conversationId === conversationId,
    );
    for (const entry of liveEntries) {
      entry.prependInFlight = null;
      setSnapshot(entry, {
        ...entry.snapshot,
        hasLoaded: true,
        error: error instanceof Error ? error : new Error(String(error)),
        loadingOlder: false,
      });
    }
    return { accepted: false, reason: "error", prepended: 0 };
  }
};

/**
 * Drop prepended older pages back to the newest `pageSize` visible
 * messages. Used by the at-rest window decay so `useEventRows` cost
 * returns to one page without re-keying the live subscription.
 */
export const trimLocalMessageWindowToNewestPage = (
  conversationId: string,
  pageSize: number,
): void => {
  for (const entry of localMessageWindows.values()) {
    if (entry.conversationId !== conversationId) continue;
    if (entry.prependInFlight) continue;
    const trimmed = trimWindowToVisibleCap(entry.snapshot.window, pageSize);
    if (trimmed.messages === entry.snapshot.window.messages) continue;
    setSnapshot(entry, {
      window: trimmed,
      hasLoaded: true,
      error: null,
      hasOlder: true,
      loadingOlder: false,
    });
  }
};

export const __privateLocalMessageStore = {
  handleLocalChatUpdated,
  resetForTests() {
    unsubscribeLocalChatUpdates?.();
    unsubscribeLocalChatUpdates = null;
    localMessageWindows.clear();
    lastLoadedWindowByConversation.clear();
  },
};
