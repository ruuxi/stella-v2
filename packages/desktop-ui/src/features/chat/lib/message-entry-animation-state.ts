const queuedMessageEnterPlayedIds = new Set<string>();

export const markQueuedMessageEntryPlayed = (messageId: string): void => {
  queuedMessageEnterPlayedIds.add(messageId);
};

export const hasQueuedMessageEntryPlayed = (messageId: string): boolean =>
  queuedMessageEnterPlayedIds.has(messageId);
