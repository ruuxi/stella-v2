/**
 * The pure core of a client's conversation view, shared by desktop and mobile.
 *
 * Each app keeps its own store class around these: subscription, socket
 * lifetime and whatever local replica it paints from are platform concerns.
 * What a view does with the socket's ordered record stream — contiguity,
 * the retained bound, scrollback splicing, and the live-turn bracket — is the
 * same everywhere, and lives here.
 */

import {
  BACKFILL_BATCH_RECORDS,
  MAX_CLIENT_RECORDS,
  type JournalRecord,
  type LiveTurnSnapshot,
} from "./conversation-protocol.js";
import type { SocketStatus } from "./conversation-socket.js";

/**
 * The turn running right now. There is no partial reply to hold: assistant
 * text arrives whole on a committed record, so all a running turn contributes
 * to the view is its identity and the tool it is currently inside.
 */
export type LiveTurn = {
  turnId: string;
  /** The tool currently running, for the working label. */
  toolName: string | null;
  toolLabel: string | null;
};

/** The fields every platform's conversation view carries. */
export type ConversationViewState = {
  conversationId: string;
  status: SocketStatus;
  statusMessage: string | null;
  statusRetryable: boolean;
  /** Durable journal generation reported by the DO; null before `ready`. */
  epoch: number | null;
  /** DO head observed by the socket, including opaque/skipped records. */
  headSeq: number;
  /** Ascending by `seq`, contiguous. */
  records: readonly JournalRecord[];
  live: LiveTurn | null;
  title: string;
  /** Lowest seq that still exists. Nothing below it is ever fetchable. */
  floorSeq: number;
  /** True while records exist below the oldest one loaded. */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Why scrollback stopped, when it stopped for a reason worth saying. */
  olderNotice: string | null;
};

export const EMPTY_JOURNAL_RECORDS: readonly JournalRecord[] = [];

export const initialConversationViewState = (
  conversationId: string,
): ConversationViewState => ({
  conversationId,
  status: "idle",
  statusMessage: null,
  statusRetryable: true,
  epoch: null,
  headSeq: -1,
  records: EMPTY_JOURNAL_RECORDS,
  live: null,
  title: "",
  floorSeq: 0,
  hasOlder: false,
  loadingOlder: false,
  olderNotice: null,
});

/** How long a scrollback request may sit unanswered before the spinner stops. */
export const OLDER_TIMEOUT_MS = 15_000;
/** How long the socket outlives its last watcher, to survive a remount. */
export const TEARDOWN_GRACE_MS = 5_000;
/** Conversations kept warm so switching back does not blank the view. */
export const MAX_RETAINED_STORES = 8;

export const OLDER_LIMIT_NOTICE =
  "That's as far back as this view holds — reload to go further.";
export const OLDER_INCOMPLETE_NOTICE =
  "Couldn't load that part of this conversation. Try again.";
export const OLDER_EXHAUSTED_NOTICE =
  "That's the start of what Stella still has.";

/**
 * The renderer holds a bounded number of records; the server holds all of
 * them. True when one more scrollback batch would cross that bound.
 */
export const olderWouldExceedRetainedLimit = (
  records: readonly JournalRecord[],
): boolean => records.length + BACKFILL_BATCH_RECORDS > MAX_CLIENT_RECORDS;

export const liveTurnFromReady = (
  live: LiveTurnSnapshot | null,
): LiveTurn | null =>
  live
    ? {
        turnId: live.turnId,
        toolName: live.tools.at(-1)?.name ?? null,
        toolLabel: live.tools.at(-1)?.label ?? null,
      }
    : null;

/**
 * Applies an advisory `tool` frame. A tool frame can outrun the turn's
 * `started` row on a fresh connect, so it opens the live turn rather than
 * assuming one is already there.
 */
export const liveTurnWithTool = (
  live: LiveTurn | null,
  tool: {
    turnId: string;
    name: string;
    label?: string;
    phase: "start" | "end";
  },
): LiveTurn => {
  const current =
    live && live.turnId === tool.turnId
      ? live
      : { turnId: tool.turnId, toolName: null, toolLabel: null };
  return {
    ...current,
    toolName: tool.phase === "start" ? tool.name : null,
    toolLabel: tool.phase === "start" ? (tool.label ?? null) : null,
  };
};

/**
 * The turn's own journal rows bracket the working indicator. Nothing else
 * can: with replies delivered whole there is no per-token traffic to infer
 * liveness from, and a committed assistant row is not the end of a turn — a
 * preamble is followed by tools and another reply, so clearing on it would
 * blink the indicator out mid-turn.
 */
export const liveTurnAfterRecords = (
  live: LiveTurn | null,
  records: readonly JournalRecord[],
): LiveTurn | null => {
  let next = live;
  for (const record of records) {
    if (record.kind !== "turn") continue;
    if (record.phase === "started") {
      if (next?.turnId !== record.turnId) {
        next = { turnId: record.turnId, toolName: null, toolLabel: null };
      }
    } else if (next?.turnId === record.turnId) {
      next = null;
    }
  }
  return next;
};

/**
 * Appends records the socket delivered in order.
 *
 * The socket keeps its own cursor, but a socket can be replaced (teardown and
 * remount, a config change) while these records stay. Contiguity is
 * re-checked here so the two can never disagree: a repeat is dropped, and a
 * jump means the rows between are gone, which restarts the window rather than
 * rendering a hole nobody named. `replaceRetained` discards the retained rows
 * outright, for a view painting unverified local bytes that the first
 * canonical frame must replace even at equal sequence numbers.
 *
 * Null when nothing in `incoming` is new.
 */
export const appendJournalRecords = (
  view: Pick<
    ConversationViewState,
    "records" | "hasOlder" | "floorSeq" | "headSeq"
  >,
  incoming: readonly JournalRecord[],
  options: { replaceRetained?: boolean } = {},
): {
  records: readonly JournalRecord[];
  /** The rows that were actually new, in order. */
  fresh: readonly JournalRecord[];
  hasOlder: boolean;
  headSeq: number;
} | null => {
  if (!incoming.length) return null;
  const retained = options.replaceRetained
    ? EMPTY_JOURNAL_RECORDS
    : view.records;
  const lastStored = retained.at(-1)?.seq ?? -1;
  const fresh = incoming.filter((record) => record.seq > lastStored);
  if (!fresh.length) return null;
  const restart = lastStored >= 0 && fresh[0]!.seq > lastStored + 1;
  let records = (restart ? EMPTY_JOURNAL_RECORDS : retained).concat(fresh);
  let hasOlder = options.replaceRetained
    ? fresh[0]!.seq > view.floorSeq
    : view.hasOlder || restart;
  if (records.length > MAX_CLIENT_RECORDS) {
    records = records.slice(records.length - MAX_CLIENT_RECORDS);
    hasOlder = true;
  }
  if (records[0] && records[0].seq > view.floorSeq) hasOlder = true;
  return {
    records,
    fresh,
    hasOlder,
    headSeq: Math.max(view.headSeq, records.at(-1)?.seq ?? -1),
  };
};

/**
 * Whether a scrollback reply holds exactly the range it claims. Never splice
 * a partial archive page beside the retained window: that would turn missing
 * canonical rows into an invisible transcript hole.
 */
export const olderRangeIsComplete = (
  incoming: readonly JournalRecord[],
  range?: { complete?: boolean; fromSeq?: number; toSeq?: number },
): boolean => {
  if (range?.complete === false) return false;
  const fromSeq = range?.fromSeq;
  const toSeq = range?.toSeq;
  if (fromSeq === undefined || toSeq === undefined) return true;
  return (
    incoming.length === toSeq - fromSeq + 1 &&
    incoming.every((record, index) => record.seq === fromSeq + index)
  );
};

/**
 * Splices a complete scrollback page below the retained window. Null when the
 * page holds nothing older: `seq` is gapless, so an empty answer means those
 * rows are gone and the view should stop offering to ask again.
 */
export const prependOlderRecords = (
  view: Pick<ConversationViewState, "records" | "floorSeq">,
  page: readonly JournalRecord[],
): { records: readonly JournalRecord[]; hasOlder: boolean } | null => {
  const oldest = view.records[0]?.seq ?? Number.POSITIVE_INFINITY;
  const older = page
    .filter((record) => record.seq < oldest)
    .sort((a, b) => a.seq - b.seq);
  if (!older.length) return null;
  const records = older.concat(view.records);
  return { records, hasOlder: (records[0]?.seq ?? 0) > view.floorSeq };
};
