/**
 * Frame-paced reveal of streamed assistant chat text.
 *
 * Provider deltas arrive in bursts (one token, then a 40-char clump, then a
 * stall), so appending each delta 1:1 to the rendered message makes the text
 * lurch. This smoother buffers inbound text and meters it out on a
 * requestAnimationFrame loop (with a bounded timer fallback) so reveals land
 * on display-refresh boundaries whenever the native loop is healthy. The
 * adaptive release rate keeps a steady floor of a couple code points per frame,
 * scaling up so any backlog drains within a fixed number of frames. The buffer
 * therefore can never lag meaningfully behind the model, yet a slow trickle
 * still reads as smooth typing.
 *
 * Mirrors desktop's `useStreamTextPacer`. Splits on code points so a surrogate
 * pair (emoji) is never revealed half-formed mid-frame.
 */

/** Steady floor of code points released per frame while the buffer is non-empty. */
const STREAM_MIN_CHARS_PER_FRAME = 2;
/** Any backlog drains over at most this many frames (~100ms at 60fps). */
const STREAM_CATCH_UP_FRAMES = 6;
/**
 * React Native can leave a requested frame pending while Fabric has no active
 * native frame loop. Do not let that turn the live stream into a completion
 * dump: if the frame callback has not run promptly, advance the same paced
 * reveal from a JS timer. A healthy rAF always wins and cancels this fallback.
 */
const STREAM_FRAME_FALLBACK_MS = 50;
/**
 * `drain()` waits for the rAF pacer to empty the buffer, but rAF can be
 * starved (a backgrounded tab, an idle Fabric frame loop) and leave the last
 * few code points unrevealed forever. A settled turn awaits `drain()` before
 * it clears the `sending` flag and drains the send queue, so a hung drain
 * freezes the composer in the streaming state and queued messages never send.
 * The live frame fallback below normally prevents this. This final guard still
 * force-flushes whatever is left if both scheduling paths stall while a turn
 * is settling, so queue progress never depends on UI frame delivery.
 */
const STREAM_DRAIN_SAFETY_MS = 1200;
/** Consumed code points tolerated at the head of the buffer before compaction. */
const BUFFER_COMPACT_THRESHOLD = 4096;

type StreamTextSmootherOptions = {
  appendText: (text: string) => void;
};

export type StreamTextSmoother = {
  push: (delta: string) => void;
  drain: () => Promise<void>;
  flushNow: () => void;
  cancel: () => void;
};

export function createStreamTextSmoother({
  appendText,
}: StreamTextSmootherOptions): StreamTextSmoother {
  // Buffered code points awaiting reveal. Kept as an array so we never re-scan
  // the whole pending string for surrogate pairs every frame. Consumed through
  // a moving head index rather than by re-slicing: a reveal takes a small
  // fraction of the buffer, so `pending.slice(take)` copied the entire
  // remaining backlog every frame, which is worst exactly when the stream is
  // furthest behind. The dead prefix is compacted away once it dominates.
  let pending: string[] = [];
  let head = 0;
  const remaining = () => pending.length - head;
  const compact = () => {
    if (head === 0) return;
    // Drop the consumed prefix once it's most of the array, so a long reply
    // can't grow `pending` without bound while `remaining()` stays small.
    if (head === pending.length) {
      pending = [];
      head = 0;
    } else if (head >= BUFFER_COMPACT_THRESHOLD && head * 2 >= pending.length) {
      pending = pending.slice(head);
      head = 0;
    }
  };
  let frame: ReturnType<typeof requestAnimationFrame> | null = null;
  let frameFallback: ReturnType<typeof setTimeout> | null = null;
  let scheduledFrameToken = 0;
  let cancelled = false;
  const drainWaiters = new Set<() => void>();
  // Safety timer that force-flushes the buffer if the rAF pacer stalls, so a
  // pending `drain()` promise can never hang the turn (see STREAM_DRAIN_SAFETY_MS).
  let drainGuard: ReturnType<typeof setTimeout> | null = null;

  const clearFrame = () => {
    scheduledFrameToken += 1;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (frameFallback !== null) {
      clearTimeout(frameFallback);
      frameFallback = null;
    }
  };

  const clearDrainGuard = () => {
    if (drainGuard === null) return;
    clearTimeout(drainGuard);
    drainGuard = null;
  };

  const resolveDrainWaiters = () => {
    if (remaining() > 0 || frame !== null || frameFallback !== null) return;
    clearDrainGuard();
    const waiters = Array.from(drainWaiters);
    drainWaiters.clear();
    for (const resolve of waiters) resolve();
  };

  // Reveal everything still buffered right now, bypassing the frame pacer.
  // Used by the drain safety timer when rAF is starved.
  const forceFlush = () => {
    clearFrame();
    if (!cancelled && remaining() > 0) {
      const rest = pending.slice(head).join("");
      pending = [];
      head = 0;
      appendText(rest);
    }
    resolveDrainWaiters();
  };

  const schedule = () => {
    if (
      cancelled ||
      frame !== null ||
      frameFallback !== null ||
      remaining() === 0
    ) {
      return;
    }
    const token = ++scheduledFrameToken;
    frame = requestAnimationFrame(() => tick(token));
    frameFallback = setTimeout(() => tick(token), STREAM_FRAME_FALLBACK_MS);
  };

  const tick = (token: number) => {
    // rAF and the fallback race to own this reveal step. Whichever arrives
    // first invalidates the other so a single schedule can never append twice.
    if (token !== scheduledFrameToken) return;
    clearFrame();
    if (cancelled || remaining() === 0) {
      resolveDrainWaiters();
      return;
    }

    // Steady floor, scaling up so the current backlog clears within
    // STREAM_CATCH_UP_FRAMES — bursts catch up fast, trickles stay gentle.
    const take = Math.min(
      remaining(),
      Math.max(
        STREAM_MIN_CHARS_PER_FRAME,
        Math.ceil(remaining() / STREAM_CATCH_UP_FRAMES),
      ),
    );
    const next = pending.slice(head, head + take).join("");
    head += take;
    compact();
    appendText(next);
    schedule();
    resolveDrainWaiters();
  };

  return {
    push(delta: string) {
      if (cancelled || delta.length === 0) return;
      // Spread to code points so multi-unit glyphs never split across frames.
      for (const ch of delta) pending.push(ch);
      schedule();
    },
    drain() {
      if (cancelled || remaining() === 0) {
        clearFrame();
        clearDrainGuard();
        return Promise.resolve();
      }
      schedule();
      // Arm the safety flush so a starved rAF loop can't hang this promise
      // (and, with it, the turn that awaits it before clearing `sending`).
      if (drainGuard === null) {
        drainGuard = setTimeout(forceFlush, STREAM_DRAIN_SAFETY_MS);
      }
      return new Promise<void>((resolve) => {
        drainWaiters.add(resolve);
        resolveDrainWaiters();
      });
    },
    flushNow() {
      clearFrame();
      if (cancelled || remaining() === 0) {
        resolveDrainWaiters();
        return;
      }
      const next = pending.slice(head).join("");
      pending = [];
      head = 0;
      appendText(next);
      resolveDrainWaiters();
    },
    cancel() {
      cancelled = true;
      pending = [];
      head = 0;
      clearFrame();
      resolveDrainWaiters();
    },
  };
}
