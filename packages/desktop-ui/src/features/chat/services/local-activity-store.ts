import type {
  EventRecord,
  LocalChatUpdatedPayload,
} from "@stella/contracts/local-chat";

const getLocalChatApi = () => window.electronAPI?.localChat ?? null;

export type LocalActivityWindow = {
  activities: EventRecord[];
};

const EMPTY_ACTIVITIES: EventRecord[] = [];
const EMPTY_WINDOW: LocalActivityWindow = {
  activities: EMPTY_ACTIVITIES,
};

export const listLocalActivity = async (
  conversationId: string,
  args: {
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  } = {},
): Promise<LocalActivityWindow> => {
  const api = getLocalChatApi();
  if (!api) return EMPTY_WINDOW;
  const window = await api.listActivity({
    conversationId,
    limit: args.limit,
    beforeTimestampMs: args.beforeTimestampMs,
    beforeId: args.beforeId,
  });
  return {
    activities: window.activities,
  };
};

const subscribeToLocalChatUpdates = (
  listener: (payload: LocalChatUpdatedPayload | null) => void,
): (() => void) => getLocalChatApi()?.onUpdated(listener) ?? (() => {});

export type LocalActivityWindowSnapshot = {
  window: LocalActivityWindow;
  hasLoaded: boolean;
  error: Error | null;
};

type LocalActivityWindowOptions = {
  conversationId: string;
  limit: number;
};

type LocalActivityWindowEntry = LocalActivityWindowOptions & {
  key: string;
  snapshot: LocalActivityWindowSnapshot;
  listeners: Set<(snapshot: LocalActivityWindowSnapshot) => void>;
  loading: Promise<void> | null;
  pendingRefetch: boolean;
};

const EMPTY_SNAPSHOT: LocalActivityWindowSnapshot = {
  window: EMPTY_WINDOW,
  hasLoaded: false,
  error: null,
};

const localActivityWindows = new Map<string, LocalActivityWindowEntry>();
let unsubscribeLocalChatUpdates: (() => void) | null = null;

const localActivityWindowKey = (options: LocalActivityWindowOptions) =>
  [options.conversationId, options.limit].join("\n");

const cloneSnapshot = (
  snapshot: LocalActivityWindowSnapshot,
): LocalActivityWindowSnapshot => ({ ...snapshot });

const setSnapshot = (
  entry: LocalActivityWindowEntry,
  snapshot: LocalActivityWindowSnapshot,
) => {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    listener(cloneSnapshot(snapshot));
  }
};

const refreshEntry = (entry: LocalActivityWindowEntry): Promise<void> => {
  if (entry.loading) {
    entry.pendingRefetch = true;
    return entry.loading;
  }
  entry.pendingRefetch = false;
  entry.loading = listLocalActivity(entry.conversationId, { limit: entry.limit })
    .then((window) => {
      setSnapshot(entry, {
        window,
        hasLoaded: true,
        error: null,
      });
    })
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
        entry.pendingRefetch = false;
        void refreshEntry(entry);
      }
    });
  return entry.loading;
};

const handleLocalChatUpdated = (payload: LocalChatUpdatedPayload | null) => {
  for (const entry of localActivityWindows.values()) {
    if (
      payload?.conversationId &&
      payload.conversationId !== entry.conversationId
    ) {
      continue;
    }
    void refreshEntry(entry);
  }
};

const ensureSubscription = () => {
  if (unsubscribeLocalChatUpdates) return;
  unsubscribeLocalChatUpdates = subscribeToLocalChatUpdates(
    handleLocalChatUpdated,
  );
};

const getOrCreateEntry = (
  options: LocalActivityWindowOptions,
): LocalActivityWindowEntry => {
  const key = localActivityWindowKey(options);
  const existing = localActivityWindows.get(key);
  if (existing) return existing;

  const seed = [...localActivityWindows.values()]
    .filter(
      (entry) =>
        entry.conversationId === options.conversationId &&
        entry.snapshot.hasLoaded &&
        entry.limit < options.limit,
    )
    .sort((a, b) => b.limit - a.limit)[0];
  const entry: LocalActivityWindowEntry = {
    ...options,
    key,
    snapshot: seed
      ? { ...cloneSnapshot(seed.snapshot), hasLoaded: false }
      : EMPTY_SNAPSHOT,
    listeners: new Set(),
    loading: null,
    pendingRefetch: false,
  };
  localActivityWindows.set(key, entry);
  return entry;
};

export const subscribeToLocalActivityWindow = (
  options: LocalActivityWindowOptions,
  listener: (snapshot: LocalActivityWindowSnapshot) => void,
): (() => void) => {
  ensureSubscription();
  const entry = getOrCreateEntry(options);
  entry.listeners.add(listener);
  listener(cloneSnapshot(entry.snapshot));
  void refreshEntry(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      localActivityWindows.delete(entry.key);
    }
    if (localActivityWindows.size === 0 && unsubscribeLocalChatUpdates) {
      unsubscribeLocalChatUpdates();
      unsubscribeLocalChatUpdates = null;
    }
  };
};

export const __privateLocalActivityStore = {
  handleLocalChatUpdated,
  resetForTests() {
    unsubscribeLocalChatUpdates?.();
    unsubscribeLocalChatUpdates = null;
    localActivityWindows.clear();
  },
};
