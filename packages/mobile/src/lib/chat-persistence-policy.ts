import type { ChatMessage } from "../types";

/**
 * Include one stable neighbour around each changed run so transcript storage
 * can allocate order keys without serializing the rest of the rendered window.
 */
export function selectIncrementalPersistenceRows(
  messages: ChatMessage[],
  changedIds: ReadonlySet<string>,
): ChatMessage[] {
  if (changedIds.size === 0) return [];
  const selected = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    if (!changedIds.has(messages[index]!.id)) continue;
    selected.add(index);
    if (index > 0) selected.add(index - 1);
    if (index + 1 < messages.length) selected.add(index + 1);
  }
  return messages.filter((_message, index) => selected.has(index));
}

export type SerializedChatPersistenceQueue = {
  tail: Promise<void>;
};

export function createSerializedChatPersistenceQueue(): SerializedChatPersistenceQueue {
  return { tail: Promise.resolve() };
}

export function enqueueSerializedChatPersistence<T>(
  queue: SerializedChatPersistenceQueue,
  task: () => Promise<T>,
): Promise<T> {
  const result = queue.tail.catch(() => {}).then(task);
  queue.tail = result.then(
    () => {},
    () => {},
  );
  return result;
}

/**
 * Publish one authoritative bounded merge before yielding to durability. This
 * keeps a delayed snapshot from observing the pre-merge state; callers run it
 * through `enqueueSerializedChatPersistence` so sync and send reconciliation
 * cannot calculate competing merges from the same stale base.
 */
export async function persistBoundedTranscriptMerge(args: {
  getCurrent: () => ChatMessage[];
  setCurrent: (messages: ChatMessage[]) => void;
  getPending: () => ChatMessage[] | null;
  setPending: (messages: ChatMessage[] | null) => void;
  merge: (current: ChatMessage[]) => ChatMessage[];
  maxLoaded: number;
  saveChanged: (messages: ChatMessage[]) => Promise<void>;
  isCurrent?: () => boolean;
}): Promise<{ messages: ChatMessage[]; droppedOlder: boolean }> {
  let current = args.getCurrent();
  let droppedOlder = false;
  while (true) {
    if (args.isCurrent && !args.isCurrent()) {
      return { messages: args.getCurrent(), droppedOlder: false };
    }
    const merged = args.merge(current);
    const currentById = new Map(
      current.map((message) => [message.id, message]),
    );
    const changedIds = new Set(
      merged
        .filter((message) => currentById.get(message.id) !== message)
        .map((message) => message.id),
    );
    const changed = selectIncrementalPersistenceRows(merged, changedIds);
    const bounded =
      merged.length <= args.maxLoaded ? merged : merged.slice(-args.maxLoaded);
    droppedOlder ||= merged.length > args.maxLoaded;
    const priorPending = args.getPending();
    args.setCurrent(bounded);
    args.setPending(bounded);
    try {
      if (changed.length > 0) await args.saveChanged(changed);
    } catch (error) {
      if (args.isCurrent && !args.isCurrent()) {
        return { messages: args.getCurrent(), droppedOlder: false };
      }
      if (args.getCurrent() === bounded) args.setCurrent(current);
      if (args.getPending() === bounded) args.setPending(priorPending);
      throw error;
    }
    if (args.isCurrent && !args.isCurrent()) {
      return { messages: args.getCurrent(), droppedOlder: false };
    }
    const latest = args.getCurrent();
    if (latest === bounded) {
      return { messages: bounded, droppedOlder };
    }
    // A local state update (most importantly an optimistic send admitted while
    // landing sync was awaiting durability) was accepted during the save. Run
    // the authoritative merge over that newer base before publishing so the
    // caller cannot replace it with the pre-save snapshot.
    current = latest;
  }
}

/**
 * Disarm delayed snapshots before waiting for the serialized flush. Any write
 * that already started is ahead of the flush in the repository queue; anything
 * still delayed cannot run after the destructive truncate.
 */
export async function establishTranscriptRewindBarrier(
  cancelPendingPersistence: () => void,
  flushCurrentWindow: () => Promise<void>,
): Promise<void> {
  cancelPendingPersistence();
  await flushCurrentWindow();
}
