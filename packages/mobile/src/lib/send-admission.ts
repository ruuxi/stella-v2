/**
 * Synchronous queue-vs-dispatch arbiter for a chat thread's sends.
 *
 * React render state can't make this decision: `sending` read from the
 * render closure is stale for a second imperative send arriving in the same
 * render/effect gap (e.g. a dictation auto-send firing right behind a
 * composer submit), which would see `sending === false` and dispatch a
 * CONCURRENT turn instead of queueing it. The decision must be made — and
 * the dispatch slot claimed — on the synchronously-written ref in one
 * atomic step.
 *
 * `admitSend` does exactly that: if the slot is free it claims it
 * (`sendingRef.current = true`, synchronously, before any interleaving
 * caller can run) and answers `"dispatch"`; otherwise it answers `"queue"`.
 * The caller still mirrors the claim into React state for rendering
 * (`markSending`), and releases the slot the same synchronous way when the
 * turn settles.
 */
export type SendAdmission = "dispatch" | "queue";

export const admitSend = (sendingRef: { current: boolean }): SendAdmission => {
  if (sendingRef.current) return "queue";
  sendingRef.current = true;
  return "dispatch";
};
