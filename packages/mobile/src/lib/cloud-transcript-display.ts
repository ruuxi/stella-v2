import type { ChatMessage } from "../types";

/**
 * Decides what the cloud chat surface paints while the journal socket is
 * between states.
 *
 * The journal is delta-synced: a reconnect resumes from the last applied
 * `seq`, so only rows the phone has not seen are replayed. What the UI must
 * never do is *react* to that resync by clearing the transcript. Every path
 * that used to blank the list is a transient "not caught up" moment:
 *
 *  - cold start: the on-disk projection paints, then the first `ready` names
 *    a head before its records have been replayed;
 *  - foreground/reconnect: `ready` moves `headSeq` above the retained rows
 *    while the delta is still on the wire;
 *  - an epoch change or unbridgeable window empties the retained rows before
 *    the newest window arrives.
 *
 * In all of them the transcript on screen stays until the journal has
 * something different to show. Rows then merge in by id; the list never
 * unmounts.
 */
export type CloudTranscriptDisplayInput = {
  /** Journal epoch known and every promised row applied. */
  caughtUp: boolean;
  /** The socket stopped on its own (blocked/offline); nothing more will land. */
  settledFailure: boolean;
  /** The on-disk projection is the authority for this paint. */
  cacheVisible: boolean;
  cached: readonly ChatMessage[] | null;
  /** Projection of the retained journal rows. */
  projected: readonly ChatMessage[];
  /** The last non-empty transcript this surface painted for the same authority. */
  lastShown: readonly ChatMessage[] | null;
  /** Whether this authority has already painted a transcript once. */
  everShown: boolean;
};

export type CloudTranscriptDisplayPlan = {
  messages: readonly ChatMessage[];
  /**
   * False only before the first paint for an authority. Once a transcript has
   * been shown it stays shown; freshness is a separate, non-clearing signal.
   */
  shown: boolean;
  /** True while the last painted transcript is standing in for an empty resync. */
  holding: boolean;
};

export const planCloudTranscriptDisplay = (
  input: CloudTranscriptDisplayInput,
): CloudTranscriptDisplayPlan => {
  const source =
    input.cacheVisible && input.cached ? input.cached : input.projected;
  const holding =
    !input.caughtUp &&
    !input.settledFailure &&
    source.length === 0 &&
    input.lastShown !== null &&
    input.lastShown.length > 0;
  const messages = holding ? input.lastShown! : source;
  const shown =
    input.everShown ||
    input.caughtUp ||
    input.settledFailure ||
    input.cacheVisible ||
    holding;
  return { messages, shown, holding };
};
