/**
 * A conversation's latest compaction checkpoint, kept beside its journal so
 * any host (the cloud, another computer) seeds its transcript from it: the
 * summary stands in for everything up to `throughSeq`, and the journal's
 * messages after it follow word for word.
 */
export type JournalCheckpoint = {
  /** The summary message a host's compaction wrote, as its model read it. */
  summary: string;
  /** The newest journal seq the summary covers. */
  throughSeq: number;
};

/**
 * Where the context a checkpoint keeps starts, as the publishing host knows
 * it: the journal seq of a message it imported, or the turn of one of its
 * own (a journal turn id, or a computer's local turn id under its device).
 */
export type JournalCheckpointFirstKept = { seq: number } | { turnId: string } | { localTurnId: string };

/** `POST /conversations/:id/checkpoint`. */
export type JournalCheckpointPublish = {
  expectedOwnerGeneration: string;
  /** The publishing computer, which a `localTurnId` belongs to. */
  deviceId?: string;
  summary: string;
  firstKept: JournalCheckpointFirstKept;
};

export const JOURNAL_CHECKPOINT_PATH = "/checkpoint";
export const JOURNAL_CHECKPOINT_SUMMARY_MAX_BYTES = 256 * 1024;

export const parseJournalCheckpoint = (value: unknown): JournalCheckpoint | undefined => {
  const candidate = value as Partial<JournalCheckpoint> | null | undefined;
  return candidate &&
    typeof candidate.summary === "string" &&
    candidate.summary.length > 0 &&
    typeof candidate.throughSeq === "number" &&
    Number.isInteger(candidate.throughSeq) &&
    candidate.throughSeq >= 0
    ? { summary: candidate.summary, throughSeq: candidate.throughSeq }
    : undefined;
};

export const parseJournalCheckpointFirstKept = (value: unknown): JournalCheckpointFirstKept | undefined => {
  const candidate = value as { seq?: unknown; turnId?: unknown; localTurnId?: unknown } | null | undefined;
  if (typeof candidate?.seq === "number" && Number.isInteger(candidate.seq) && candidate.seq >= 0) {
    return { seq: candidate.seq };
  }
  if (typeof candidate?.turnId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(candidate.turnId)) {
    return { turnId: candidate.turnId };
  }
  if (typeof candidate?.localTurnId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate.localTurnId)) {
    return { localTurnId: candidate.localTurnId };
  }
  return undefined;
};
