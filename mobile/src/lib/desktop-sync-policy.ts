/**
 * Pure decision logic for when the desktop transcript is re-pulled. Kept out
 * of the hook so the invariants are unit-testable:
 *
 * - NEVER pull mid-send (05e5bf6): the desktop persists the turn's user row
 *   the moment it starts, and a mid-turn pull would merge that canonical row
 *   before `reconcileSentDesktopTurn` links the optimistic bubble —
 *   duplicating it — while also advancing the cursor past the turn.
 * - The task poll stays armed while a task is running even when the localChat
 *   push socket is connected — the pill's task snapshots ride cursor deltas,
 *   and a push socket that is "connected" but silently not delivering (killed
 *   upstream by the tunnel/OS without a close event) would otherwise freeze
 *   the pill forever. Push relaxes the cadence to a verification poll instead
 *   of suspending it (the regression that shipped in build 94: while push was
 *   live nothing re-pulled task snapshots, so the activity pill never showed).
 * - A push notification that lands mid-send must be DEFERRED, not dropped:
 *   the turn's own agent-started/task events broadcast while `sending` is
 *   true, and if the post-turn reconcile races the desktop persisting those
 *   rows, nothing else re-delivers the running-task snapshot.
 */

/** Fast cadence while the push socket is down — polling is the only signal. */
export const DESKTOP_TASK_POLL_MS = 5_000;
/**
 * Slow verification cadence while push is live: push owns freshness, the
 * poll just guarantees the running-task snapshot can never silently freeze.
 */
export const DESKTOP_TASK_POLL_PUSH_VERIFY_MS = 30_000;

export const shouldArmDesktopTaskPoll = (args: {
  isDesktopTransport: boolean;
  storageLoaded: boolean;
  hasRunningConversationTask: boolean;
  sending: boolean;
}): boolean =>
  args.isDesktopTransport &&
  args.storageLoaded &&
  args.hasRunningConversationTask &&
  !args.sending;

/** Poll cadence for an armed task poll under the current push state. */
export const desktopTaskPollIntervalMs = (livePushConnected: boolean): number =>
  livePushConnected ? DESKTOP_TASK_POLL_PUSH_VERIFY_MS : DESKTOP_TASK_POLL_MS;

/** Whether a push-notified transcript change may trigger a sync right now. */
export const shouldSyncOnLocalChatPush = (args: {
  storageLoaded: boolean;
  sending: boolean;
}): boolean => args.storageLoaded && !args.sending;

/**
 * Whether a push notification blocked only by the mid-send gate should be
 * remembered and flushed once the send settles (rather than dropped). The
 * flush runs through the same coalesced `runDesktopSync`, which awaits the
 * turn's reconcile first, so ordering and the duplicate-row window stay safe.
 */
export const shouldDeferLocalChatPushDuringSend = (args: {
  storageLoaded: boolean;
  sending: boolean;
}): boolean => args.storageLoaded && args.sending;
