import type { ChatMessage } from "../types";

export type TranscriptWindowMerge = {
  messages: ChatMessage[];
  droppedOlder: boolean;
  droppedNewer: boolean;
};

const adjacentRows = (
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {
  const identities = new Set<string>();
  for (const message of current) {
    identities.add(message.id);
    if (message.canonicalId) identities.add(message.canonicalId);
  }
  return incoming.filter((message) => {
    if (
      identities.has(message.id) ||
      (message.canonicalId && identities.has(message.canonicalId))
    ) {
      return false;
    }
    identities.add(message.id);
    if (message.canonicalId) identities.add(message.canonicalId);
    return true;
  });
};

/** Prepend an adjacent durable page and evict only from the opposite edge. */
export function mergeOlderTranscriptPage(
  current: ChatMessage[],
  olderPage: ChatMessage[],
  maxLoaded: number,
): TranscriptWindowMerge {
  const combined = [...adjacentRows(current, olderPage), ...current];
  const droppedNewer = combined.length > maxLoaded;
  return {
    messages: droppedNewer ? combined.slice(0, maxLoaded) : combined,
    droppedOlder: false,
    droppedNewer,
  };
}

/** Append an adjacent durable page and evict only from the opposite edge. */
export function mergeNewerTranscriptPage(
  current: ChatMessage[],
  newerPage: ChatMessage[],
  maxLoaded: number,
): TranscriptWindowMerge {
  const combined = [...current, ...adjacentRows(current, newerPage)];
  const droppedOlder = combined.length > maxLoaded;
  return {
    messages: droppedOlder ? combined.slice(-maxLoaded) : combined,
    droppedOlder,
    droppedNewer: false,
  };
}
