/**
 * Direct-mode assistant segments are transient status messages. Once the next
 * segment exists, keep the current one visible until its buffered text has
 * painted, dwell briefly, fade only that old text, then reveal the replacement.
 *
 * The replacement revealed is always the MOST RECENT queued segment, not the
 * immediate next one: intermediate segments are ephemeral progress updates, so
 * when a handoff finally fires we skip straight to the newest available segment
 * and discard the ones that piled up behind it. This keeps the visible message
 * caught up with the agent instead of lagging one dwell per queued segment. The
 * newest segment is never skipped past — including, at run end, the final
 * answer, which is always the terminal segment of its turn.
 */
export const DIRECT_ASSISTANT_MESSAGE_DWELL_MS = 2_000;
export const DIRECT_ASSISTANT_MESSAGE_FADE_MS = 180;

export type DirectAssistantHandoffScheduler = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
};

/**
 * The slot to reveal plus the intermediate slots skipped to reach it. Callers
 * hide every `skippedSlotIds` entry alongside `previousSlotId` so the discarded
 * segments never linger in the timeline.
 */
export type DirectAssistantSwap = (
  previousSlotId: string,
  nextSlotId: string,
  skippedSlotIds: string[],
) => void;

type PendingHandoff = {
  nextSlotId: string;
  dwellTimerId: number | null;
  swapTimerId: number | null;
  fading: boolean;
};

const browserScheduler: DirectAssistantHandoffScheduler = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timerId) => window.clearTimeout(timerId),
};

export class DirectAssistantHandoffController {
  private readonly scheduler: DirectAssistantHandoffScheduler;
  private readonly onFadeStart: (previousSlotId: string) => void;
  private readonly onSwap: DirectAssistantSwap;
  private readonly paintedAtMsBySlotId = new Map<string, number>();
  private readonly pendingByPreviousSlotId = new Map<string, PendingHandoff>();

  constructor(options: {
    scheduler?: DirectAssistantHandoffScheduler;
    onFadeStart: (previousSlotId: string) => void;
    onSwap: DirectAssistantSwap;
  }) {
    this.scheduler = options.scheduler ?? browserScheduler;
    this.onFadeStart = options.onFadeStart;
    this.onSwap = options.onSwap;
  }

  /** Called only after the animator's full text has reached a browser paint. */
  markPainted(slotId: string): void {
    if (!this.paintedAtMsBySlotId.has(slotId)) {
      this.paintedAtMsBySlotId.set(slotId, this.scheduler.now());
    }
    this.scheduleIfReady(slotId);
  }

  /** A late/resumed delta invalidates an earlier completed-paint timestamp. */
  markUnpainted(slotId: string): void {
    this.paintedAtMsBySlotId.delete(slotId);
    const pending = this.pendingByPreviousSlotId.get(slotId);
    if (!pending || pending.fading || pending.dwellTimerId === null) return;
    this.scheduler.clearTimer(pending.dwellTimerId);
    pending.dwellTimerId = null;
  }

  /** Register that `nextSlotId` should visually replace `previousSlotId`. */
  queue(previousSlotId: string, nextSlotId: string): void {
    const current = this.pendingByPreviousSlotId.get(previousSlotId);
    if (current?.nextSlotId === nextSlotId) return;
    if (current) this.clearPending(current);

    this.pendingByPreviousSlotId.set(previousSlotId, {
      nextSlotId,
      dwellTimerId: null,
      swapTimerId: null,
      fading: false,
    });
    this.scheduleIfReady(previousSlotId);
  }

  reset(): void {
    for (const pending of this.pendingByPreviousSlotId.values()) {
      this.clearPending(pending);
    }
    this.pendingByPreviousSlotId.clear();
    this.paintedAtMsBySlotId.clear();
  }

  private scheduleIfReady(previousSlotId: string): void {
    const pending = this.pendingByPreviousSlotId.get(previousSlotId);
    const paintedAtMs = this.paintedAtMsBySlotId.get(previousSlotId);
    if (
      !pending ||
      paintedAtMs === undefined ||
      pending.fading ||
      pending.dwellTimerId !== null
    ) {
      return;
    }

    const remainingDwellMs = Math.max(
      0,
      paintedAtMs + DIRECT_ASSISTANT_MESSAGE_DWELL_MS - this.scheduler.now(),
    );
    pending.dwellTimerId = this.scheduler.setTimer(() => {
      pending.dwellTimerId = null;
      if (this.pendingByPreviousSlotId.get(previousSlotId) !== pending) return;
      pending.fading = true;
      this.onFadeStart(previousSlotId);
      pending.swapTimerId = this.scheduler.setTimer(() => {
        pending.swapTimerId = null;
        if (this.pendingByPreviousSlotId.get(previousSlotId) !== pending)
          return;
        this.pendingByPreviousSlotId.delete(previousSlotId);
        const { newestSlotId, skippedSlotIds } = this.resolveNewestPendingSlot(
          pending.nextSlotId,
        );
        this.onSwap(previousSlotId, newestSlotId, skippedSlotIds);
      }, DIRECT_ASSISTANT_MESSAGE_FADE_MS);
    }, remainingDwellMs);
  }

  /**
   * Walk the queued chain from `firstNextSlotId` to its end, returning the
   * newest (terminal) slot to reveal and the intermediate slots skipped to get
   * there. A pending entry keyed by a slot means that slot has its OWN queued
   * successor, i.e. it is itself stale and should be skipped. Their timers are
   * cleared and their entries dropped as we pass them. The walk stops at the
   * first slot with no successor, so the newest available segment is always the
   * one revealed and never skipped past. Slot indices only ever increase, so
   * the chain cannot cycle.
   */
  private resolveNewestPendingSlot(firstNextSlotId: string): {
    newestSlotId: string;
    skippedSlotIds: string[];
  } {
    const skippedSlotIds: string[] = [];
    let newestSlotId = firstNextSlotId;
    let successor = this.pendingByPreviousSlotId.get(newestSlotId);
    while (successor) {
      this.clearPending(successor);
      this.pendingByPreviousSlotId.delete(newestSlotId);
      skippedSlotIds.push(newestSlotId);
      newestSlotId = successor.nextSlotId;
      successor = this.pendingByPreviousSlotId.get(newestSlotId);
    }
    return { newestSlotId, skippedSlotIds };
  }

  private clearPending(pending: PendingHandoff): void {
    if (pending.dwellTimerId !== null) {
      this.scheduler.clearTimer(pending.dwellTimerId);
    }
    if (pending.swapTimerId !== null) {
      this.scheduler.clearTimer(pending.swapTimerId);
    }
  }
}
