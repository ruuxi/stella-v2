/**
 * Renderer-side client for the authoritative thread-activity IPC
 * (`localChat:listThreadActivity`). Stella-managed rows come from
 * `runtime_agents`; Claude-native rows are passive observations projected by
 * the external-engine session. Both use the same refresh stream, while only
 * Stella rows carry lifecycle authority.
 *
 * One bounded hydration read builds a thread-id index. Durable keyed pushes
 * patch that index and wake only listeners for the changed thread. Aggregate
 * subscribers (Activity surfaces) receive a rebuilt list only when one is
 * actually mounted; chat cards never subscribe to or scan that list.
 */
import type {
  DesktopThreadActivityRecord as ThreadActivityRecord,
  DesktopThreadActivityUpdatedPayload as ThreadActivityUpdatedPayload,
  ThreadActivityAssistantUpdate,
} from "@/features/chat/thread-activity-types";

// Absent outside Electron (plain-browser `bun run dev`): degrade to an
// empty, update-free list instead of erroring.
const getLocalChatApi = () => window.electronAPI?.localChat ?? null;

const EMPTY_RECORDS: ThreadActivityRecord[] = [];

/** Legacy broad invalidations are rare, but coalesce them if an older runtime
 * sends a burst. Current runtimes push complete keyed records instead. */
const PUSH_REFRESH_DEBOUNCE_MS = 120;
const LOAD_RETRY_MS = 1_000;
const RETAINED_CONVERSATION_LIMIT = 10;

export const listThreadActivity = async (
  conversationId: string,
): Promise<ThreadActivityRecord[]> => {
  const api = getLocalChatApi();
  if (!api?.listThreadActivity) return EMPTY_RECORDS;
  return (await api.listThreadActivity({
    conversationId,
  })) as ThreadActivityRecord[];
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
  recordsByThreadId: Map<string, ThreadActivityRecord>;
  recordListeners: Map<
    string,
    Set<(record: ThreadActivityRecord | null, hasLoaded: boolean) => void>
  >;
  /** True after this live entry has completed its one authoritative read. */
  hasHydrated: boolean;
  loading: Promise<void> | null;
  pendingRefetch: boolean;
  refreshTimer: number | null;
  retryTimer: number | null;
  requestGeneration: number;
  disposed: boolean;
  assistantUpdates: Map<string, ThreadActivityAssistantUpdate>;
  recordWatermarks: Map<string, ThreadActivityRecord>;
};

const EMPTY_SNAPSHOT: ThreadActivitySnapshot = {
  records: EMPTY_RECORDS,
  hasLoaded: false,
  error: null,
};

const entries = new Map<string, ThreadActivityEntry>();
const retainedRecordsByConversation = new Map<string, ThreadActivityRecord[]>();
let unsubscribeUpdates: (() => void) | null = null;

const retainRecords = (
  conversationId: string,
  records: ThreadActivityRecord[],
) => {
  retainedRecordsByConversation.delete(conversationId);
  retainedRecordsByConversation.set(conversationId, records.slice());
  while (retainedRecordsByConversation.size > RETAINED_CONVERSATION_LIMIT) {
    const oldestConversationId = retainedRecordsByConversation
      .keys()
      .next().value;
    if (typeof oldestConversationId !== "string") break;
    retainedRecordsByConversation.delete(oldestConversationId);
  }
};

export const getRetainedThreadActivitySnapshot = (
  conversationId: string,
): ThreadActivitySnapshot | null => {
  const records = retainedRecordsByConversation.get(conversationId);
  if (!records) return null;
  return { records: records.slice(), hasLoaded: false, error: null };
};

/** Cheap identity for "did anything the UI renders actually change" —
 * a refetch triggered by a no-op write returns byte-identical rows, and
 * notifying React for those re-renders every task surface. */
const recordsSignature = (records: ThreadActivityRecord[]): string =>
  records
    .map(
      (record) =>
        `${record.threadId}\u0000${record.source}\u0000${record.readOnly ? 1 : 0}\u0000${record.parentAgentId ?? ""}\u0000${record.status}\u0000${record.attemptGeneration ?? 0}\u0000${record.updatedAt}\u0000${record.description}\u0000${record.rootRunId ?? ""}\u0000${JSON.stringify(record.modelConfigSnapshot ?? null)}\u0000${record.assistantMessagesUpdatedSequence ?? ""}\u0000${JSON.stringify(record.assistantMessages ?? [])}`,
    )
    .join("\n");

const setSnapshot = (
  entry: ThreadActivityEntry,
  snapshot: ThreadActivitySnapshot,
) => {
  entry.snapshot = snapshot;
  entry.recordsByThreadId = new Map(
    snapshot.records.map((record) => [record.threadId, record]),
  );
  if (snapshot.hasLoaded && !snapshot.error) {
    retainRecords(entry.conversationId, snapshot.records);
  }
  for (const listener of entry.listeners) {
    listener({ ...snapshot });
  }
  for (const [threadId, listeners] of entry.recordListeners) {
    const record = entry.recordsByThreadId.get(threadId) ?? null;
    for (const listener of listeners) listener(record, snapshot.hasLoaded);
  }
};

const patchRecord = (
  entry: ThreadActivityEntry,
  incoming: ThreadActivityRecord,
) => {
  const previous = entry.recordsByThreadId.get(incoming.threadId);
  const sameAttempt =
    previous?.attemptGeneration === incoming.attemptGeneration &&
    (!previous?.rootRunId ||
      !incoming.rootRunId ||
      previous.rootRunId === incoming.rootRunId);
  // Group metadata belongs to the durable thread, not an individual agent
  // attempt. Lifecycle pushes are projected directly from runtime_agents and
  // therefore omit the joined runtime_threads fields; retain them across both
  // same-attempt patches and retry generations.
  const stableThreadFields = previous
    ? {
        ...(previous.groupKey ? { groupKey: previous.groupKey } : {}),
        ...(previous.groupLabel ? { groupLabel: previous.groupLabel } : {}),
      }
    : {};
  const record = sameAttempt
    ? { ...previous, ...incoming }
    : { ...stableThreadFields, ...incoming };
  entry.recordsByThreadId.set(record.threadId, record);

  const listeners = entry.recordListeners.get(record.threadId);
  if (listeners) {
    for (const listener of listeners) listener(record, true);
  }

  // Only genuine aggregate views pay for an array projection. Hundreds of
  // chat cards use recordListeners and therefore do no unrelated work.
  if (entry.listeners.size > 0) {
    const records = Array.from(entry.recordsByThreadId.values()).sort(
      (a, b) =>
        a.startedAt - b.startedAt || a.threadId.localeCompare(b.threadId),
    );
    entry.snapshot = { records, hasLoaded: true, error: null };
    retainRecords(entry.conversationId, records);
    for (const listener of entry.listeners) listener(entry.snapshot);
  } else {
    entry.snapshot = { ...entry.snapshot, hasLoaded: true, error: null };
  }
};

const materializeAggregateSnapshot = (entry: ThreadActivityEntry) => {
  const records = Array.from(entry.recordsByThreadId.values()).sort(
    (a, b) =>
      a.startedAt - b.startedAt || a.threadId.localeCompare(b.threadId),
  );
  entry.snapshot = { ...entry.snapshot, records };
  return entry.snapshot;
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
    const recordAttempt = record.attemptGeneration;
    const updateIsOlderAttempt =
      recordAttempt !== undefined && update.attemptGeneration < recordAttempt;
    const sameAttempt =
      recordAttempt === undefined || recordAttempt === update.attemptGeneration;
    const conflictingRootOnSameAttempt =
      sameAttempt &&
      Boolean(record.rootRunId) &&
      Boolean(update.rootRunId) &&
      record.rootRunId !== update.rootRunId;
    if (updateIsOlderAttempt || conflictingRootOnSameAttempt) {
      entry.assistantUpdates.delete(record.threadId);
      return record;
    }
    const recordSequence = record.assistantMessagesUpdatedSequence;
    const updateSequence = update.atSequence;
    const recordHasCaughtUp =
      recordSequence !== undefined && updateSequence !== undefined
        ? recordSequence >= updateSequence
        : (record.assistantMessagesUpdatedAt ?? 0) >= update.atMs;
    if (recordHasCaughtUp) {
      entry.assistantUpdates.delete(record.threadId);
      return record;
    }
    return {
      ...record,
      assistantMessages: update.assistantMessages,
      assistantMessagesUpdatedAt: update.atMs,
      ...(update.atSequence === undefined
        ? {}
        : { assistantMessagesUpdatedSequence: update.atSequence }),
    };
  });

const compareRecordVersions = (
  left: ThreadActivityRecord,
  right: ThreadActivityRecord,
): number =>
  (left.attemptGeneration ?? 0) - (right.attemptGeneration ?? 0) ||
  left.updatedAt - right.updatedAt ||
  (left.status === "running" ? 0 : 1) -
    (right.status === "running" ? 0 : 1);

/** A keyed push can race an older hydration request. Keep the pushed durable
 * row until a later list result demonstrably catches up to its version. */
const applyRecordWatermarks = (
  entry: ThreadActivityEntry,
  records: ThreadActivityRecord[],
): ThreadActivityRecord[] => {
  if (entry.recordWatermarks.size === 0) return records;
  const protectedRecords = new Map(
    records.map((record) => [record.threadId, record]),
  );
  for (const [threadId, watermark] of entry.recordWatermarks) {
    const fetched = protectedRecords.get(threadId);
    if (fetched && compareRecordVersions(fetched, watermark) >= 0) {
      entry.recordWatermarks.delete(threadId);
      continue;
    }
    protectedRecords.set(threadId, watermark);
  }
  return Array.from(protectedRecords.values()).sort(
    (a, b) => a.startedAt - b.startedAt || a.threadId.localeCompare(b.threadId),
  );
};

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
      const protectedRecords = applyAssistantUpdateWatermarks(
        entry,
        applyRecordWatermarks(entry, records),
      );
      entry.hasHydrated = true;
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
      // A keyed push may have landed before this read failed. Preserve that
      // index rather than rebuilding it from the stale aggregate snapshot.
      entry.snapshot = {
        ...entry.snapshot,
        hasLoaded: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
      for (const listener of entry.listeners) listener(entry.snapshot);
      for (const [threadId, listeners] of entry.recordListeners) {
        const record = entry.recordsByThreadId.get(threadId) ?? null;
        for (const listener of listeners) listener(record, false);
      }
      // A fetch can fail during a store reset / worker restart window;
      // self-retry while anyone is subscribed, since no push may follow.
      if (
        (entry.listeners.size > 0 || entry.recordListeners.size > 0) &&
        entry.retryTimer === null
      ) {
        entry.retryTimer = window.setTimeout(() => {
          entry.retryTimer = null;
          if (entry.listeners.size > 0 || entry.recordListeners.size > 0) {
            void refreshEntry(entry);
          }
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
  // Durable transcript invalidations keep an open exact-thread reader live.
  // They do not change the Activity projection unless accompanied by an
  // authored update, so avoid refetching every row for tool-only traffic.
  if (payload.transcriptUpdate && !payload.assistantUpdate) return;
  const entry = entries.get(payload.conversationId);
  if (!entry) return;
  if (payload.record) {
    const previousWatermark = entry.recordWatermarks.get(
      payload.record.threadId,
    );
    if (
      !previousWatermark ||
      compareRecordVersions(payload.record, previousWatermark) >= 0
    ) {
      entry.recordWatermarks.set(payload.record.threadId, payload.record);
      const current = entry.recordsByThreadId.get(payload.record.threadId);
      if (!current || compareRecordVersions(payload.record, current) >= 0) {
        patchRecord(entry, payload.record);
      }
    }
  }
  const update = payload.assistantUpdate;
  if (update) {
    const previous = entry.assistantUpdates.get(update.threadId);
    if (
      !previous ||
      update.attemptGeneration > previous.attemptGeneration ||
      (update.attemptGeneration === previous.attemptGeneration &&
        (update.atSequence !== undefined && previous.atSequence !== undefined
          ? update.atSequence >= previous.atSequence
          : update.atMs >= previous.atMs))
    ) {
      entry.assistantUpdates.set(update.threadId, update);
      const record = entry.recordsByThreadId.get(update.threadId);
      if (record) {
        patchRecord(entry, {
          ...record,
          assistantMessages: update.assistantMessages,
          assistantMessagesUpdatedAt: update.atMs,
          ...(update.atSequence === undefined
            ? {}
            : { assistantMessagesUpdatedSequence: update.atSequence }),
        });
      }
    }
  }
  // Keyed lifecycle and assistant deltas are complete; no durable snapshot
  // read is needed. The timer remains only for legacy broad invalidations.
  if (payload.record || update) return;
  if (entry.refreshTimer !== null) return;
  entry.refreshTimer = window.setTimeout(() => {
    entry.refreshTimer = null;
    if (entry.listeners.size > 0 || entry.recordListeners.size > 0) {
      void refreshEntry(entry);
    }
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
    const retainedSnapshot = getRetainedThreadActivitySnapshot(conversationId);
    entry = {
      conversationId,
      snapshot: retainedSnapshot ?? EMPTY_SNAPSHOT,
      listeners: new Set(),
      recordsByThreadId: new Map(
        (retainedSnapshot?.records ?? []).map((record) => [
          record.threadId,
          record,
        ]),
      ),
      recordListeners: new Map(),
      hasHydrated: false,
      loading: null,
      pendingRefetch: false,
      refreshTimer: null,
      retryTimer: null,
      requestGeneration: 0,
      disposed: false,
      assistantUpdates: new Map(),
      recordWatermarks: new Map(),
    };
    entries.set(conversationId, entry);
  }
  if (entry.listeners.size === 0 && entry.snapshot.hasLoaded) {
    materializeAggregateSnapshot(entry);
  }
  entry.listeners.add(listener);
  listener({ ...entry.snapshot });
  if (!entry.hasHydrated && !entry.loading) void refreshEntry(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.recordListeners.size === 0) {
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

/** Subscribe to one indexed row. The conversation is hydrated once, but
 * subsequent updates are O(1) and never wake unrelated cards. */
export const subscribeToThreadActivityRecord = (
  conversationId: string,
  threadId: string,
  listener: (record: ThreadActivityRecord | null, hasLoaded: boolean) => void,
): (() => void) => {
  ensureSubscription();
  let entry = entries.get(conversationId);
  if (!entry) {
    const retainedSnapshot = getRetainedThreadActivitySnapshot(conversationId);
    entry = {
      conversationId,
      snapshot: retainedSnapshot ?? EMPTY_SNAPSHOT,
      listeners: new Set(),
      recordsByThreadId: new Map(
        (retainedSnapshot?.records ?? []).map((record) => [
          record.threadId,
          record,
        ]),
      ),
      recordListeners: new Map(),
      hasHydrated: false,
      loading: null,
      pendingRefetch: false,
      refreshTimer: null,
      retryTimer: null,
      requestGeneration: 0,
      disposed: false,
      assistantUpdates: new Map(),
      recordWatermarks: new Map(),
    };
    entries.set(conversationId, entry);
  }
  let listeners = entry.recordListeners.get(threadId);
  if (!listeners) {
    listeners = new Set();
    entry.recordListeners.set(threadId, listeners);
  }
  listeners.add(listener);
  listener(
    entry.recordsByThreadId.get(threadId) ?? null,
    entry.snapshot.hasLoaded,
  );
  if (!entry.hasHydrated && !entry.loading) void refreshEntry(entry);

  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) entry!.recordListeners.delete(threadId);
    if (entry!.listeners.size === 0 && entry!.recordListeners.size === 0) {
      entry!.disposed = true;
      entry!.requestGeneration += 1;
      if (entry!.refreshTimer !== null)
        window.clearTimeout(entry!.refreshTimer);
      if (entry!.retryTimer !== null) window.clearTimeout(entry!.retryTimer);
      entries.delete(conversationId);
    }
    if (entries.size === 0 && unsubscribeUpdates) {
      unsubscribeUpdates();
      unsubscribeUpdates = null;
    }
  };
};

export const __privateThreadActivityStore = {
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
    retainedRecordsByConversation.clear();
  },
};
