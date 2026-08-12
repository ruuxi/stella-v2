/**
 * Direct-mode assistant segments are transient status messages. Once the next
 * segment exists, keep the current one visible until its buffered text has
 * painted, dwell briefly, fade only that old text, then reveal the replacement.
 */
export const DIRECT_ASSISTANT_MESSAGE_DWELL_MS = 2_000;
export const DIRECT_ASSISTANT_MESSAGE_FADE_MS = 180;

export type DirectAssistantHandoffScheduler = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
};

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
  private readonly onSwap: (previousSlotId: string, nextSlotId: string) => void;
  private readonly paintedAtMsBySlotId = new Map<string, number>();
  private readonly pendingByPreviousSlotId = new Map<string, PendingHandoff>();

  constructor(options: {
    scheduler?: DirectAssistantHandoffScheduler;
    onFadeStart: (previousSlotId: string) => void;
    onSwap: (previousSlotId: string, nextSlotId: string) => void;
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
        this.onSwap(previousSlotId, pending.nextSlotId);
      }, DIRECT_ASSISTANT_MESSAGE_FADE_MS);
    }, remainingDwellMs);
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
