/**
 * Pure decision logic for when the desktop transcript is re-pulled. Kept out
 * of the hook so the invariants are unit-testable:
 *
 * - NEVER pull mid-send (05e5bf6): the desktop persists the turn's user row
 *   the moment it starts, and a mid-turn pull would merge that canonical row
 *   before `reconcileSentDesktopTurn` links the optimistic bubble —
 *   duplicating it — while also advancing the cursor past the turn.
 * - The 5s task poll only exists as a fallback: while the localChat push
 *   socket is connected the desktop tells us when the transcript changed, so
 *   polling on top would be pure duplicate traffic.
 */

export const shouldArmDesktopTaskPoll = (args: {
  isDesktopTransport: boolean;
  storageLoaded: boolean;
  hasRunningConversationTask: boolean;
  sending: boolean;
  livePushConnected: boolean;
}): boolean =>
  args.isDesktopTransport &&
  args.storageLoaded &&
  args.hasRunningConversationTask &&
  !args.sending &&
  !args.livePushConnected;

/** Whether a push-notified transcript change may trigger a sync right now. */
export const shouldSyncOnLocalChatPush = (args: {
  storageLoaded: boolean;
  sending: boolean;
}): boolean => args.storageLoaded && !args.sending;
