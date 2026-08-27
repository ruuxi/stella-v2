import type {
  EventRecord,
  LocalChatUpdatedPayload,
} from "@stella/contracts/local-chat";

const getLocalChatApi = () => window.electronAPI?.localChat ?? null;

export type LocalFilesWindow = {
  files: EventRecord[];
};

const EMPTY_FILES: EventRecord[] = [];
const EMPTY_WINDOW: LocalFilesWindow = { files: EMPTY_FILES };

export const listLocalFiles = async (
  conversationId: string,
  args: {
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  } = {},
): Promise<LocalFilesWindow> => {
  const api = getLocalChatApi();
  if (!api) return EMPTY_WINDOW;
  const window = await api.listFiles({
    conversationId,
    limit: args.limit,
    beforeTimestampMs: args.beforeTimestampMs,
    beforeId: args.beforeId,
  });
  return { files: window.files };
};

const subscribeToLocalChatUpdates = (
  listener: (payload: LocalChatUpdatedPayload | null) => void,
): (() => void) => getLocalChatApi()?.onUpdated(listener) ?? (() => {});

export type LocalFilesWindowSnapshot = {
  window: LocalFilesWindow;
  hasLoaded: boolean;
  error: Error | null;
};

type LocalFilesWindowOptions = {
  conversationId: string;
  limit: number;
};

type LocalFilesWindowEntry = LocalFilesWindowOptions & {
  key: string;
  snapshot: LocalFilesWindowSnapshot;
  listeners: Set<(snapshot: LocalFilesWindowSnapshot) => void>;
  loading: Promise<void> | null;
  pendingRefetch: boolean;
};

const EMPTY_SNAPSHOT: LocalFilesWindowSnapshot = {
  window: EMPTY_WINDOW,
  hasLoaded: false,
  error: null,
};

const localFilesWindows = new Map<string, LocalFilesWindowEntry>();
let unsubscribeLocalChatUpdates: (() => void) | null = null;

const localFilesWindowKey = (options: LocalFilesWindowOptions) =>
  [options.conversationId, options.limit].join("\n");

const cloneSnapshot = (
  snapshot: LocalFilesWindowSnapshot,
): LocalFilesWindowSnapshot => ({ ...snapshot });

const setSnapshot = (
  entry: LocalFilesWindowEntry,
  snapshot: LocalFilesWindowSnapshot,
) => {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    listener(cloneSnapshot(snapshot));
  }
};

const refreshEntry = (entry: LocalFilesWindowEntry): Promise<void> => {
  if (entry.loading) {
    entry.pendingRefetch = true;
    return entry.loading;
  }
  entry.pendingRefetch = false;
  entry.loading = listLocalFiles(entry.conversationId, { limit: entry.limit })
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

const FILE_BEARING_EVENT_TYPES = new Set<EventRecord["type"]>([
  "tool_result",
  "agent-completed",
]);

const updateMayAffectFilesWindow = (
  payload: LocalChatUpdatedPayload | null,
): boolean => {
  const event = payload?.event;
  if (!event) return true;
  return FILE_BEARING_EVENT_TYPES.has(event.type);
};

const handleLocalChatUpdated = (payload: LocalChatUpdatedPayload | null) => {

  if (!updateMayAffectFilesWindow(payload)) return;
  for (const entry of localFilesWindows.values()) {
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
  options: LocalFilesWindowOptions,
): LocalFilesWindowEntry => {
  const key = localFilesWindowKey(options);
  const existing = localFilesWindows.get(key);
  if (existing) return existing;

  const seed = [...localFilesWindows.values()]
    .filter(
      (entry) =>
        entry.conversationId === options.conversationId &&
        entry.snapshot.hasLoaded &&
        entry.limit < options.limit,
    )
    .sort((a, b) => b.limit - a.limit)[0];
  const entry: LocalFilesWindowEntry = {
    ...options,
    key,
    snapshot: seed
      ? { ...cloneSnapshot(seed.snapshot), hasLoaded: false }
      : EMPTY_SNAPSHOT,
    listeners: new Set(),
    loading: null,
    pendingRefetch: false,
  };
  localFilesWindows.set(key, entry);
  return entry;
};

export const subscribeToLocalFilesWindow = (
  options: LocalFilesWindowOptions,
  listener: (snapshot: LocalFilesWindowSnapshot) => void,
): (() => void) => {
  ensureSubscription();
  const entry = getOrCreateEntry(options);
  entry.listeners.add(listener);
  listener(cloneSnapshot(entry.snapshot));
  void refreshEntry(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      localFilesWindows.delete(entry.key);
    }
    if (localFilesWindows.size === 0 && unsubscribeLocalChatUpdates) {
      unsubscribeLocalChatUpdates();
      unsubscribeLocalChatUpdates = null;
    }
  };
};

export const __privateLocalFilesStore = {
  handleLocalChatUpdated,
  resetForTests() {
    unsubscribeLocalChatUpdates?.();
    unsubscribeLocalChatUpdates = null;
    localFilesWindows.clear();
  },
};
