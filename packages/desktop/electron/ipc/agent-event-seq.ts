import {
  isAgentRecorderSeq,
  nextAgentRecorderSeqCursor,
} from "@stella/contracts/agent-runtime";

export { nextAgentRecorderSeqCursor };

export type SeqStampedEvent = {
  seq?: number;
  sourceSeq?: number;
};

/**
 * Live `agent:event` frames are remapped into main's Date.now-scale generator.
 * Keep the worker/recorder value on `sourceSeq` so resume can query the log
 * and so the renderer can identity-dedupe remapped live vs replay.
 */
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

/**
 * Worker/host `resumeAfter` is keyed by recorder seq for one run. A Date.now
 * wire cursor (or a missing source cursor) must not be forwarded there.
 */
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
