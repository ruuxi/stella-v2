import {
  isAgentRecorderSeq,
  nextAgentRecorderSeqCursor,
} from "@stella/contracts/agent-runtime";

export { nextAgentRecorderSeqCursor };

export type SeqStampedEvent = {
  seq?: number;
  sourceSeq?: number;
};

export const stampAgentEventMainSeq = <T extends SeqStampedEvent>(
  event: T,
  mainSeq: number,
): T & { seq: number } => {
  const original = Number.isFinite(event.seq) ? event.seq : undefined;
  const sourceSeq = Number.isFinite(event.sourceSeq)
    ? event.sourceSeq
    : original;
  return {
    ...event,
    ...(sourceSeq !== undefined ? { sourceSeq } : {}),
    seq: mainSeq,
  };
};

export const workerResumeLastSeq = (payload: {
  lastSeq?: unknown;
  lastSourceSeq?: unknown;
}): number => {
  if (isAgentRecorderSeq(payload.lastSourceSeq)) {
    return payload.lastSourceSeq;
  }
  if (isAgentRecorderSeq(payload.lastSeq)) {
    return payload.lastSeq;
  }
  return 0;
};
