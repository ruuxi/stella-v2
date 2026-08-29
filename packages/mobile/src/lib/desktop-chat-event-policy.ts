/**
 * Match one conversation-level mobile observer to runtime events. Before the
 * root run is known, request identity rejects stale broadcasts from a previous
 * send. Once known, the run is authoritative because consumed steers retain
 * the root run while callback/request ownership advances.
 */
export const desktopBridgeEventMatchesActiveRun = (args: {
  conversationId: string;
  requestId: string;
  runId: string;
  eventConversationId: string;
  eventRequestId: string;
  eventRunId: string;
}): boolean => {
  if (
    args.eventConversationId &&
    args.eventConversationId !== args.conversationId
  ) {
    return false;
  }
  if (args.runId && args.eventRunId) return args.eventRunId === args.runId;
  if (args.requestId && args.eventRequestId) {
    return args.eventRequestId === args.requestId;
  }
  return true;
};

/**
 * How far each of the two producers numbering this run's events has been seen.
 *
 * `wireSeq` counts the desktop main process's broadcast buffer. `sourceSeq`
 * counts the host's per-run recorder log, which is what `agent:resume` pages
 * through. The two are not interchangeable, and resuming the recorder from a
 * wire seq replays events already delivered live.
 */
export type BridgeReplayCursor = {
  wireSeq: number;
  sourceSeq: number;
  seenSourceKeys: Set<string>;
};

export const createBridgeReplayCursor = (): BridgeReplayCursor => ({
  wireSeq: 0,
  sourceSeq: 0,
  seenSourceKeys: new Set<string>(),
});

/**
 * Above this a value is an epoch timestamp rather than a seq. Adopting one
 * would park the resume cursor past every real event in the log.
 */
const MAX_PLAUSIBLE_SOURCE_SEQ = 10_000_000_000;

/**
 * Decide whether to process one runtime event, advancing `cursor` in place.
 *
 * A replayed event arrives under a fresh wire seq, so the wire cursor alone
 * lets it through a second time. The run's own `(sourceSeq, type)` identity is
 * what actually drops it. That gate carries the weight now that assistant text
 * is delivered whole: an admitted duplicate is a repeated reply bubble, not a
 * few repeated tokens.
 */
export const admitBridgeEvent = (
  cursor: BridgeReplayCursor,
  event: {
    runId: string;
    type: string;
    seq: number | null;
    sourceSeq: number | null;
  },
): boolean => {
  // Hosts predating the split number both lanes together, so the wire seq is
  // the best available source identity.
  const sourceSeq = event.sourceSeq ?? event.seq;
  if (event.runId && sourceSeq !== null && sourceSeq > 0) {
    const sourceKey = `${event.runId}:${sourceSeq}:${event.type}`;
    if (cursor.seenSourceKeys.has(sourceKey)) return false;
    cursor.seenSourceKeys.add(sourceKey);
  }
  if (event.seq !== null) {
    if (event.seq <= cursor.wireSeq) return false;
    cursor.wireSeq = event.seq;
  }
  if (
    sourceSeq !== null &&
    sourceSeq > 0 &&
    sourceSeq < MAX_PLAUSIBLE_SOURCE_SEQ &&
    sourceSeq > cursor.sourceSeq
  ) {
    cursor.sourceSeq = sourceSeq;
  }
  return true;
};
