/**
 * Reply counts per cited message and agent thread, for the iMessage-style
 * "N replies" affordance under an original.
 *
 * One authoritative read per conversation (`localChat:listReplyCounts`),
 * then incremental: a pushed assistant row that carries `replyRefs` bumps
 * its targets immediately and schedules a debounced re-read so a rewritten
 * row (same id, different refs) settles to the stored truth.
 */
import { useEffect, useState } from "react";
import type {
  EventRecord,
  LocalChatUpdatedPayload,
} from "@stella/contracts/local-chat";
import type { ReplyCounts } from "@stella/contracts/reply-refs";
import { replyRefsFromPayload } from "../lib/reply-refs";

const EMPTY_COUNTS: ReplyCounts = Object.freeze({
  messages: {},
  agents: {},
}) as ReplyCounts;

const REFRESH_DEBOUNCE_MS = 400;

type Entry = {
  conversationId: string;
  counts: ReplyCounts;
  hasLoaded: boolean;
  listeners: Set<(counts: ReplyCounts) => void>;
  loading: Promise<void> | null;
  refreshTimer: number | null;
  countedEventIds: Set<string>;
};

const entries = new Map<string, Entry>();
let updateUnsubscribe: (() => void) | null = null;
/** Conversations whose counts a client-side source owns (cloud journal). */
const providedCounts = new Map<string, ReplyCounts>();

const getApi = () =>
  typeof window === "undefined" ? undefined : window.electronAPI?.localChat;

const getOrCreate = (conversationId: string): Entry => {
  let entry = entries.get(conversationId);
  if (!entry) {
    entry = {
      conversationId,
      counts: EMPTY_COUNTS,
      hasLoaded: false,
      listeners: new Set(),
      loading: null,
      refreshTimer: null,
      countedEventIds: new Set(),
    };
    entries.set(conversationId, entry);
  }
  return entry;
};

const emit = (entry: Entry) => {
  for (const listener of entry.listeners) listener(entry.counts);
};

const read = (entry: Entry): Promise<void> => {
  if (entry.loading) return entry.loading;
  if (providedCounts.has(entry.conversationId)) {
    entry.hasLoaded = true;
    return Promise.resolve();
  }
  const api = getApi();
  if (!api?.listReplyCounts) {
    entry.hasLoaded = true;
    return Promise.resolve();
  }
  entry.loading = api
    .listReplyCounts({ conversationId: entry.conversationId })
    .then((counts) => {
      entry.counts = {
        messages: { ...counts.messages },
        agents: { ...counts.agents },
      };
      entry.hasLoaded = true;
      entry.countedEventIds.clear();
      emit(entry);
    })
    .catch(() => {
      entry.hasLoaded = true;
    })
    .finally(() => {
      entry.loading = null;
    });
  return entry.loading;
};

const scheduleRefresh = (entry: Entry) => {
  if (entry.refreshTimer !== null) window.clearTimeout(entry.refreshTimer);
  entry.refreshTimer = window.setTimeout(() => {
    entry.refreshTimer = null;
    void read(entry);
  }, REFRESH_DEBOUNCE_MS);
};

const applyPushedEvent = (entry: Entry, event: EventRecord) => {
  if (event.type !== "assistant_message") return;
  const refs = replyRefsFromPayload(event.payload);
  if (refs.length === 0) return;
  // Count a pushed row once; the debounced re-read is the reconciliation.
  if (!entry.countedEventIds.has(event._id)) {
    entry.countedEventIds.add(event._id);
    const next: ReplyCounts = {
      messages: { ...entry.counts.messages },
      agents: { ...entry.counts.agents },
    };
    for (const ref of refs) {
      if (ref.kind === "message") {
        next.messages[ref.id] = (next.messages[ref.id] ?? 0) + 1;
      } else {
        next.agents[ref.threadId] = (next.agents[ref.threadId] ?? 0) + 1;
      }
    }
    entry.counts = next;
    emit(entry);
  }
  scheduleRefresh(entry);
};

const handleLocalUpdate = (payload: LocalChatUpdatedPayload | null) => {
  if (!payload?.conversationId) return;
  if (providedCounts.has(payload.conversationId)) return;
  const entry = entries.get(payload.conversationId);
  if (!entry || entry.listeners.size === 0) return;
  if (payload.event) applyPushedEvent(entry, payload.event);
  else scheduleRefresh(entry);
};

const syncUpdateSubscription = () => {
  const active = Array.from(entries.values()).some(
    (entry) => entry.listeners.size > 0,
  );
  if (active && !updateUnsubscribe) {
    updateUnsubscribe = getApi()?.onUpdated?.(handleLocalUpdate) ?? null;
  } else if (!active && updateUnsubscribe) {
    updateUnsubscribe();
    updateUnsubscribe = null;
  }
};

export const subscribeToReplyCounts = (
  conversationId: string,
  listener: (counts: ReplyCounts) => void,
): (() => void) => {
  const entry = getOrCreate(conversationId);
  entry.listeners.add(listener);
  syncUpdateSubscription();
  listener(entry.counts);
  if (!entry.hasLoaded) void read(entry);
  return () => {
    entry.listeners.delete(listener);
    syncUpdateSubscription();
  };
};

export const getReplyCountsSnapshot = (conversationId: string): ReplyCounts =>
  entries.get(conversationId)?.counts ?? EMPTY_COUNTS;

/** Count replies from an in-memory message list (cloud journal windows). */
export const countReplyRefs = (
  messages: readonly EventRecord[],
): ReplyCounts => {
  const counts: ReplyCounts = { messages: {}, agents: {} };
  for (const message of messages) {
    if (message.type !== "assistant_message") continue;
    for (const ref of replyRefsFromPayload(message.payload)) {
      if (ref.kind === "message") {
        counts.messages[ref.id] = (counts.messages[ref.id] ?? 0) + 1;
      } else {
        counts.agents[ref.threadId] = (counts.agents[ref.threadId] ?? 0) + 1;
      }
    }
  }
  return counts;
};

/**
 * Hand a conversation's counts to the store from a client-side source. A
 * cloud-mode conversation has no local `entry_ref` index, so the cloud bridge
 * derives counts from the loaded journal window and publishes them here;
 * pass `null` to release the conversation back to the local read path.
 */
export const provideReplyCounts = (
  conversationId: string,
  counts: ReplyCounts | null,
): void => {
  if (!counts) {
    providedCounts.delete(conversationId);
    return;
  }
  providedCounts.set(conversationId, counts);
  const entry = getOrCreate(conversationId);
  entry.counts = counts;
  entry.hasLoaded = true;
  emit(entry);
};

/** Live reply counts for one conversation. */
export const useReplyCounts = (
  conversationId: string | null | undefined,
): ReplyCounts => {
  const [counts, setCounts] = useState<ReplyCounts>(() =>
    conversationId ? getReplyCountsSnapshot(conversationId) : EMPTY_COUNTS,
  );
  useEffect(() => {
    if (!conversationId) {
      setCounts(EMPTY_COUNTS);
      return;
    }
    return subscribeToReplyCounts(conversationId, setCounts);
  }, [conversationId]);
  return counts;
};

export const __testing = {
  reset(): void {
    for (const entry of entries.values()) {
      if (entry.refreshTimer !== null) window.clearTimeout(entry.refreshTimer);
    }
    entries.clear();
    providedCounts.clear();
    updateUnsubscribe?.();
    updateUnsubscribe = null;
  },
};
