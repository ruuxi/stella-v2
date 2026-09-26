/**
 * Distance bands that decide how the chat treats the user's scroll position.
 *
 * `useChatScrollManagement` owns the motion (the spring loop, the manual-scroll
 * release), and every follow settles at the literal end of content — the last
 * row sits just above the composer with only the list's own bottom padding
 * below it. This module owns the pure thresholds over the measured distance
 * from that end, so the rules can be pinned by tests without a layout engine.
 */

/** Do not pull a submit out of scrollback when the user is reading history. */
export const SEND_FOLLOW_THRESHOLD_PX = 300;

/**
 * Distance from the end within which the freshest turn is still on screen, so
 * the user is treated as "at the bottom" for the UI decisions that must not
 * fire on a barely-there nudge: the streaming reply peek and the post-send
 * follow. A single wheel tick off the end drops the motion follow latch (that
 * yields to the user immediately, by design), but should NOT read as
 * "scrolled up" for these two decisions. Generous on purpose — if the latest
 * messages are visible, sending follows to the bottom and no peek appears.
 * Kept below SEND_FOLLOW_THRESHOLD_PX so the two bands stay ordered: within
 * this = at-bottom, up to the send threshold = meaningfully scrolled up,
 * beyond = reading history.
 */
export const AT_BOTTOM_TOLERANCE_PX = 200;

export const shouldFollowSend = ({
  distanceFromBottomPx,
  isFollowingLatest,
}: {
  distanceFromBottomPx: number;
  isFollowingLatest: boolean;
}): boolean =>
  isFollowingLatest && distanceFromBottomPx <= SEND_FOLLOW_THRESHOLD_PX;
