/**
 * Renderer-side client for the authoritative thread-activity IPC
 * (`localChat:listThreadActivity`). One row per background-agent thread,
 * projected straight from the runtime's `runtime_agents` table — the single
 * writer is the LocalAgentManager's `persistTask`, so a row's `status` and
 * `description` are always the runtime's current truth, never a fold over
 * event history.
 *
 * Mirrors `local-activity-store.ts` shape: one entry per conversation,
 * re-fetched on every `localChat:threadActivityUpdated` push with a
 * `pendingRefetch` flag so writes that land mid-read don't get dropped.
 * Push refetches are debounced (persistTask fires several per lifecycle
 * transition), unchanged row sets never notify React, and a failed fetch
 * self-retries — rows are the sole task source, so a conversation with only
 * settled threads gets no further pushes to recover on.
 */
import type {
  ThreadActivityAssistantUpdate,
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "@stella/contracts/local-chat";

// Absent outside Electron (plain-browser `bun run dev`): degrade to an
// empty, update-free list instead of erroring.
const getLocalChatApi = () => window.electronAPI?.localChat ?? null;

const EMPTY_RECORDS: ThreadActivityRecord[] = [];

/** Rows change at agent-lifecycle cadence, not frame cadence — a short
 *  trailing window folds a burst of persistTask pushes into one refetch. */
const PUSH_REFRESH_DEBOUNCE_MS = 120;
const LOAD_RETRY_MS = 1_000;

export const listThreadActivity = async (
  conversationId: string,
): Promise<ThreadActivityRecord[]> => {
  const api = getLocalChatApi();
  if (!api?.listThreadActivity) return EMPTY_RECORDS;
  return await api.listThreadActivity({ conversationId });
};

const subscribeToThreadActivityUpdates = (
  listener: (payload: ThreadActivityUpdatedPayload) => void,
): (() => void) =>
  getLocalChatApi()?.onThreadActivityUpdated?.(listener) ?? (() => {});

export type ThreadActivitySnapshot = {
  records: ThreadActivityRecord[];
  hasLoaded: boolean;
  error: Error | null;
};

type ThreadActivityEntry = {
  conversationId: string;
  snapshot: ThreadActivitySnapshot;
  listeners: Set<(snapshot: ThreadActivitySnapshot) => void>;
  loading: Promise<void> | null;
  pendingRefetch: boolean;
  refreshTimer: number | null;
  retryTimer: number | null;
  requestGeneration: number;
  disposed: boolean;
  assistantUpdates: Map<string, ThreadActivityAssistantUpdate>;
};

const EMPTY_SNAPSHOT: ThreadActivitySnapshot = {
  records: EMPTY_RECORDS,
  hasLoaded: false,
  error: null,
};

const entries = new Map<string, ThreadActivityEntry>();
let unsubscribeUpdates: (() => void) | null = null;

/** Cheap identity for "did anything the UI renders actually change" —
 *  a refetch triggered by a no-op write returns byte-identical rows, and
 *  notifying React for those re-renders every task surface. */
const recordsSignature = (records: ThreadActivityRecord[]): string =>
  JSON.stringify(
    records.map((record) => [
      record.threadId,
      record.status,
      record.attemptGeneration ?? 0,
      record.updatedAt,
      record.description,
      record.rootRunId ?? "",
      record.assistantMessages ?? [],
      record.assistantMessagesEntrySequence ?? 0,
    ]),
  );

const setSnapshot = (
  entry: ThreadActivityEntry,
  snapshot: ThreadActivitySnapshot,
) => {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    listener({ ...snapshot });
  }
};

/** Overlay persisted live-message watermarks onto list results. A list request
 * started before an incremental write may return an older projection; its
 * lifecycle fields remain useful, but it cannot roll assistant text back. */
const applyAssistantUpdateWatermarks = (
  entry: ThreadActivityEntry,
  records: ThreadActivityRecord[],
): ThreadActivityRecord[] =>
  records.map((record) => {
    const update = entry.assistantUpdates.get(record.threadId);
    if (!update) return record;
    const sameAttempt =
      record.attemptGeneration === undefined ||
      record.attemptGeneration === update.attemptGeneration;
    const sameRoot =
      !record.rootRunId ||
      !update.rootRunId ||
      record.rootRunId === update.rootRunId;
    if (record.status !== "running" || !sameAttempt || !sameRoot) {
      entry.assistantUpdates.delete(record.threadId);
      return record;
    }
    const listAtMs = record.assistantMessagesUpdatedAt ?? 0;
    const listEntrySequence = record.assistantMessagesEntrySequence;
    if (
      listAtMs > update.atMs ||
      (listAtMs === update.atMs &&
        listEntrySequence !== undefined &&
        listEntrySequence >= update.entrySequence)
    ) {
      entry.assistantUpdates.delete(record.threadId);
      return record;
    }
    return {
      ...record,
      assistantMessages: update.assistantMessages,
      assistantMessagesUpdatedAt: update.atMs,
      assistantMessagesEntrySequence: update.entrySequence,
    };
  });

const refreshEntry = (entry: ThreadActivityEntry): Promise<void> => {
  if (entry.loading) {
    entry.pendingRefetch = true;
    return entry.loading;
  }
  const requestGeneration = ++entry.requestGeneration;
  entry.pendingRefetch = false;
  if (entry.retryTimer !== null) {
    window.clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
  entry.loading = listThreadActivity(entry.conversationId)
    .then((records) => {
      if (entry.disposed || requestGeneration !== entry.requestGeneration) {
        return;
      }
      const protectedRecords = applyAssistantUpdateWatermarks(entry, records);
      if (
        entry.snapshot.hasLoaded &&
        !entry.snapshot.error &&
        recordsSignature(protectedRecords) ===
          recordsSignature(entry.snapshot.records)
      ) {
        return;
      }
      setSnapshot(entry, {
        records: protectedRecords,
        hasLoaded: true,
        error: null,
      });
    })
    .catch((error) => {
      if (entry.disposed || requestGeneration !== entry.requestGeneration) {
        return;
      }
      setSnapshot(entry, {
        ...entry.snapshot,
        hasLoaded: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      // A fetch can fail during a store reset / worker restart window;
      // self-retry while anyone is subscribed, since no push may follow.
      if (entry.listeners.size > 0 && entry.retryTimer === null) {
        entry.retryTimer = window.setTimeout(() => {
          entry.retryTimer = null;
          if (entry.listeners.size > 0) void refreshEntry(entry);
        }, LOAD_RETRY_MS);
      }
    })
    .finally(() => {
      if (entry.disposed || requestGeneration !== entry.requestGeneration) {
        return;
      }
      entry.loading = null;
      if (entry.pendingRefetch) {
        entry.pendingRefetch = false;
        void refreshEntry(entry);
      }
    });
  return entry.loading;
};

const handleThreadActivityUpdated = (payload: ThreadActivityUpdatedPayload) => {
  const entry = entries.get(payload.conversationId);
  if (!entry) return;
  const update = payload.assistantUpdate;
  if (update) {
    const previous = entry.assistantUpdates.get(update.threadId);
    if (
      !previous ||
      update.attemptGeneration > previous.attemptGeneration ||
      (update.attemptGeneration === previous.attemptGeneration &&
        (update.atMs > previous.atMs ||
          (update.atMs === previous.atMs &&
            update.entrySequence >= previous.entrySequence)))
    ) {
      entry.assistantUpdates.set(update.threadId, update);
      if (entry.snapshot.hasLoaded) {
        const records = applyAssistantUpdateWatermarks(
          entry,
          entry.snapshot.records,
        );
        if (
          recordsSignature(records) !== recordsSignature(entry.snapshot.records)
        ) {
          setSnapshot(entry, { ...entry.snapshot, records });
        }
      }
    }
  }
  if (entry.refreshTimer !== null) return;
  entry.refreshTimer = window.setTimeout(() => {
    entry.refreshTimer = null;
    if (entry.listeners.size > 0) void refreshEntry(entry);
  }, PUSH_REFRESH_DEBOUNCE_MS);
};

const ensureSubscription = () => {
  if (unsubscribeUpdates) return;
  unsubscribeUpdates = subscribeToThreadActivityUpdates(
    handleThreadActivityUpdated,
  );
};

export const subscribeToThreadActivity = (
  conversationId: string,
  listener: (snapshot: ThreadActivitySnapshot) => void,
): (() => void) => {
  ensureSubscription();
  let entry = entries.get(conversationId);
  if (!entry) {
    entry = {
      conversationId,
      snapshot: EMPTY_SNAPSHOT,
      listeners: new Set(),
      loading: null,
      pendingRefetch: false,
      refreshTimer: null,
      retryTimer: null,
      requestGeneration: 0,
      disposed: false,
      assistantUpdates: new Map(),
    };
    entries.set(conversationId, entry);
  }
  entry.listeners.add(listener);
  listener({ ...entry.snapshot });
  void refreshEntry(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entry.disposed = true;
      entry.requestGeneration += 1;
      if (entry.refreshTimer !== null) window.clearTimeout(entry.refreshTimer);
      if (entry.retryTimer !== null) window.clearTimeout(entry.retryTimer);
      entries.delete(conversationId);
    }
    if (entries.size === 0 && unsubscribeUpdates) {
      unsubscribeUpdates();
      unsubscribeUpdates = null;
    }
  };
};

export const __privateThreadActivityStore = {
  recordsSignature,
  handleThreadActivityUpdated,
  resetForTests() {
    for (const entry of entries.values()) {
      entry.disposed = true;
      entry.requestGeneration += 1;
      if (entry.refreshTimer !== null) window.clearTimeout(entry.refreshTimer);
      if (entry.retryTimer !== null) window.clearTimeout(entry.retryTimer);
    }
    unsubscribeUpdates?.();
    unsubscribeUpdates = null;
    entries.clear();
  },
};
