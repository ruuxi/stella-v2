import {
  forkDelayed,
  forkInterval,
  type HostTimerHandle,
} from "./effect-runtime.js";

/** Lease renewal cadence for an accepted local run. */
const HEARTBEAT_INTERVAL_MS = 25_000;
const PRESENCE_SOCKET_RECONNECT_MAX_MS = 30_000;
const EXECUTION_LEASE_RENEWAL_FAILSAFE_MS = 2 * 60_000;
const CLAIM_ACK_RETRY_BASE_MS = 1_000;
const CLAIM_ACK_RETRY_MAX_MS = 15_000;

/**
 * The execution placement bridge's timing and retry state: the heartbeat that
 * renews leases, presence-socket reconnect backoff, claim-ACK retry backoff,
 * how long each lease renewal has been failing, and the single-flight local
 * cancellation per dispatch. The bridge decides what each step does; this
 * only keeps when, how often, and what is already in flight.
 */
export class ExecutionPlacementLeases {
  private heartbeatTimer: HostTimerHandle | null = null;
  private heartbeatTask: Promise<void> | null = null;
  private reconnectTimer: HostTimerHandle | null = null;
  private reconnectAttempt = 0;
  private readonly renewalFailureSince = new Map<string, number>();
  private readonly claimAckRetry = new Map<
    string,
    { attempts: number; nextAt: number }
  >();
  private readonly cancellationInFlight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly options: {
      now: () => number;
      /** Test seam; production uses the accepted execution lease duration. */
      leaseRenewalGraceMs?: number;
      /** Test seam for deterministic claim-ACK retry/backoff coverage. */
      claimAckRetryBaseMs?: number;
    },
  ) {}

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  startHeartbeat(tick: () => void) {
    this.heartbeatTimer = forkInterval(HEARTBEAT_INTERVAL_MS, tick);
  }

  stopHeartbeat() {
    this.heartbeatTimer?.cancel();
    this.heartbeatTimer = null;
  }

  /**
   * Single-flight heartbeat: joins the one already running, otherwise starts
   * `run` (which returns null when the bridge may not beat now).
   */
  heartbeat(run: () => Promise<void> | null): Promise<void> {
    if (this.heartbeatTask) return this.heartbeatTask;
    const task = run();
    if (!task) return Promise.resolve();
    this.heartbeatTask = task;
    const clear = () => {
      if (this.heartbeatTask === task) this.heartbeatTask = null;
    };
    void task.then(clear, clear);
    return task;
  }

  /** The heartbeat in flight, if any, settled without its error. */
  joinHeartbeat(): Promise<void> | undefined {
    return this.heartbeatTask?.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Presence socket reconnect
  // -------------------------------------------------------------------------

  /** Exponential backoff; at most one reconnect is ever scheduled. */
  scheduleReconnect(open: () => void) {
    if (this.reconnectTimer) return;
    const attempt = this.reconnectAttempt++;
    const delay = Math.min(
      PRESENCE_SOCKET_RECONNECT_MAX_MS,
      500 * 2 ** Math.min(attempt, 6),
    );
    this.reconnectTimer = forkDelayed(delay, () => {
      this.reconnectTimer = null;
      open();
    });
  }

  cancelReconnect() {
    this.reconnectTimer?.cancel();
    this.reconnectTimer = null;
  }

  resetReconnectBackoff() {
    this.reconnectAttempt = 0;
  }

  // -------------------------------------------------------------------------
  // Lease renewal and claim-ACK retry
  // -------------------------------------------------------------------------

  clearRenewalFailure(dispatchId: string) {
    this.renewalFailureSince.delete(dispatchId);
  }

  /**
   * Record a failed renewal. True once renewals have failed for the whole
   * grace period, when the lease must be treated as lost.
   */
  noteRenewalFailure(dispatchId: string, now: number): boolean {
    const failedSince = this.renewalFailureSince.get(dispatchId) ?? now;
    this.renewalFailureSince.set(dispatchId, failedSince);
    return (
      now - failedSince >=
      (this.options.leaseRenewalGraceMs ?? EXECUTION_LEASE_RENEWAL_FAILSAFE_MS)
    );
  }

  noteClaimAckFailure(dispatchId: string) {
    const previous = this.claimAckRetry.get(dispatchId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const baseMs = Math.max(
      1,
      this.options.claimAckRetryBaseMs ?? CLAIM_ACK_RETRY_BASE_MS,
    );
    const delayMs = Math.min(
      CLAIM_ACK_RETRY_MAX_MS,
      baseMs * 2 ** Math.min(attempts - 1, 8),
    );
    this.claimAckRetry.set(dispatchId, {
      attempts,
      nextAt: this.options.now() + delayMs,
    });
  }

  claimAckRetryIsDue(dispatchId: string) {
    const retry = this.claimAckRetry.get(dispatchId);
    return !retry || this.options.now() >= retry.nextAt;
  }

  clearClaimAckRetry(dispatchId: string) {
    this.claimAckRetry.delete(dispatchId);
  }

  /** Forget every lease's renewal and claim-ACK history (stop, rotation). */
  clearLeaseHistory() {
    this.renewalFailureSince.clear();
    this.claimAckRetry.clear();
  }

  // -------------------------------------------------------------------------
  // Local cancellation retry
  // -------------------------------------------------------------------------

  /** Single-flight per dispatch: joins a cancellation already in flight. */
  retryCancellation(
    dispatchId: string,
    run: () => Promise<boolean>,
  ): Promise<boolean> {
    const existing = this.cancellationInFlight.get(dispatchId);
    if (existing) return existing;
    const pending = run();
    this.cancellationInFlight.set(dispatchId, pending);
    const clear = () => {
      if (this.cancellationInFlight.get(dispatchId) === pending) {
        this.cancellationInFlight.delete(dispatchId);
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  cancellationsInFlight(): Promise<boolean>[] {
    return [...this.cancellationInFlight.values()];
  }
}
