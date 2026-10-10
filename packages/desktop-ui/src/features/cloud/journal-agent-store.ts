import { useCallback, useSyncExternalStore } from "react";
import type { JournalAgent } from "@stella/contracts/agent-titles";

type Entry = {
  agents: ReadonlyMap<string, JournalAgent>;
  listeners: Map<string, Set<() => void>>;
};

const RETAINED_CONVERSATIONS = 10;
const entries = new Map<string, Entry>();

const entryFor = (conversationId: string): Entry => {
  let entry = entries.get(conversationId);
  if (!entry) {
    entry = { agents: new Map(), listeners: new Map() };
    entries.set(conversationId, entry);
    for (const [id, candidate] of entries) {
      if (entries.size <= RETAINED_CONVERSATIONS) break;
      if (candidate.listeners.size === 0) entries.delete(id);
    }
  }
  return entry;
};

const sameAgent = (a: JournalAgent | undefined, b: JournalAgent | undefined) =>
  a?.title === b?.title && a?.status === b?.status;

export const publishJournalAgents = (
  conversationId: string,
  agents: ReadonlyMap<string, JournalAgent>,
): void => {
  const entry = entryFor(conversationId);
  const previous = entry.agents;
  entry.agents = agents;
  for (const [threadId, listeners] of entry.listeners) {
    if (sameAgent(previous.get(threadId), agents.get(threadId))) continue;
    for (const listener of listeners) listener();
  }
};

const subscribe = (
  conversationId: string,
  threadId: string,
  listener: () => void,
): (() => void) => {
  const entry = entryFor(conversationId);
  let listeners = entry.listeners.get(threadId);
  if (!listeners) {
    listeners = new Set();
    entry.listeners.set(threadId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) entry.listeners.delete(threadId);
  };
};

export const useJournalAgent = (
  conversationId: string,
  threadId: string,
): JournalAgent | undefined => {
  const onChange = useCallback(
    (listener: () => void) => subscribe(conversationId, threadId, listener),
    [conversationId, threadId],
  );
  const read = useCallback(
    () => entries.get(conversationId)?.agents.get(threadId),
    [conversationId, threadId],
  );
  return useSyncExternalStore(onChange, read, read);
};
