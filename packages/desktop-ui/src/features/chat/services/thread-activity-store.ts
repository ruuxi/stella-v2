import type {
  DesktopThreadActivityRecord as ThreadActivityRecord,
  DesktopThreadActivityUpdatedPayload as ThreadActivityUpdatedPayload,
  ThreadActivityAssistantUpdate,
} from "@/features/chat/thread-activity-types";

const getLocalChatApi = () => window.electronAPI?.localChat ?? null;

const EMPTY_RECORDS: ThreadActivityRecord[] = [];

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

  hasHydrated: boolean;
  loading: Promise<void> | null;
  pendingRefetch: boolean;
  refreshTimer: number | null;
  retryTimer: number | null;
  requestGeneration: number;
  disposed: boolean;
  assistantUpdates: Map<string, ThreadActivityAssistantUpdate>;
  recordWatermarks: Map<string, ThreadActivityRecord>;
  equalVersionConflicts: Map<string, string>;
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

const recordsSignature = (records: ThreadActivityRecord[]): string =>
  records
    .map(
      (record) =>
        `${record.threadId}\u0000${record.source}\u0000${record.readOnly ? 1 : 0}\u0000${record.parentAgentId ?? ""}\u0000${record.status}\u0000${record.attemptGeneration ?? 0}\u0000${record.recordRevision ?? 0}\u0000${record.updatedAt}\u0000${record.description}\u0000${record.rootRunId ?? ""}\u0000${JSON.stringify(record.modelConfigSnapshot ?? null)}\u0000${record.assistantMessagesUpdatedSequence ?? ""}\u0000${JSON.stringify(record.assistantMessages ?? [])}`,
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
  (left.recordRevision ?? 0) - (right.recordRevision ?? 0) ||
  (left.attemptGeneration ?? 0) - (right.attemptGeneration ?? 0) ||
  left.updatedAt - right.updatedAt ||
  (left.status === "running" ? 0 : 1) -
    (right.status === "running" ? 0 : 1);

const recordVersionPayloadSignature = (record: ThreadActivityRecord): string =>
  JSON.stringify({
    source: record.source,
    threadId: record.threadId,
    conversationId: record.conversationId,
    agentType: record.agentType,
    description: record.description,
    status: record.status,
    attemptGeneration: record.attemptGeneration ?? 0,
    recordRevision: record.recordRevision ?? 0,
    rootRunId: record.rootRunId ?? null,
    modelConfigSnapshot: record.modelConfigSnapshot ?? null,
    parentAgentId: record.parentAgentId ?? null,
    groupKey: record.groupKey ?? null,
    groupLabel: record.groupLabel ?? null,
    readOnly: record.readOnly ?? false,
    startedAt: record.startedAt,
    completedAt: record.completedAt ?? null,
    result: record.result ?? null,
    error: record.error ?? null,
    updatedAt: record.updatedAt,
  });

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
    if (fetched) {
      const comparison = compareRecordVersions(fetched, watermark);
      if (comparison > 0) {
        entry.recordWatermarks.delete(threadId);
        entry.equalVersionConflicts.delete(threadId);
        continue;
      }
      if (comparison === 0) {
        const fetchedSignature = recordVersionPayloadSignature(fetched);
        const watermarkSignature = recordVersionPayloadSignature(watermark);
        if (fetchedSignature === watermarkSignature) {
          entry.recordWatermarks.delete(threadId);
          entry.equalVersionConflicts.delete(threadId);
          continue;
        }

        const conflictSignature = `${fetchedSignature}\n${watermarkSignature}`;
        if (entry.equalVersionConflicts.get(threadId) !== conflictSignature) {
          entry.equalVersionConflicts.set(threadId, conflictSignature);
          entry.pendingRefetch = true;
        }
      }
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
      equalVersionConflicts: new Map(),
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
      equalVersionConflicts: new Map(),
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
