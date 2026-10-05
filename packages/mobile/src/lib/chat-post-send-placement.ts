/** Do not pull a submit out of scrollback when the user is reading history. */
export const LATEST_TURN_PLACEMENT_THRESHOLD_PX = 300;

/** Apply latest-turn placement only while following the live tail. */
export function shouldPlaceLatestTurn({
  distanceFromBottomPx,
  isFollowingLatest,
}: {
  distanceFromBottomPx: number;
  isFollowingLatest: boolean;
}) {
  return (
    isFollowingLatest &&
    distanceFromBottomPx <= LATEST_TURN_PLACEMENT_THRESHOLD_PX
  );
}

/**
 * Frame the latest user row at the list tail. A row that fits above the
 * trailing slack lands with the list scrolled to its end; a user message
 * taller than the remaining reading area is aligned by its top instead, so
 * its opening lines stay in view. `leadingInsetPx` is the chrome floating
 * over the list's top edge, which a top-aligned row lands below.
 */
export function resolvePostSendTarget({
  rowTop,
  rowBottom,
  viewportHeight,
  trailingSlackPx,
  leadingInsetPx = 0,
}: {
  rowTop: number;
  rowBottom: number;
  viewportHeight: number;
  trailingSlackPx: number;
  leadingInsetPx?: number;
}) {
  const rowHeight = Math.max(0, rowBottom - rowTop);
  const availableForRow = Math.max(
    0,
    viewportHeight - trailingSlackPx - leadingInsetPx,
  );
  return rowHeight <= availableForRow
    ? rowBottom - viewportHeight + trailingSlackPx
    : rowTop - leadingInsetPx;
}

/**
 * Post-send anchor for the latest user row, derived from live list geometry.
 * `trailingSlackPx` is everything below the row (the chat tail plus the
 * reserved bottom inset), so `contentHeightPx - trailingSlackPx` is the row's
 * bottom.
 *
 * Recomputed whenever the row's measured height settles (e.g. the four-line
 * user-message clamp collapsing a tall row after its first unclamped-ish
 * paint), so the committed scroll target always matches the final geometry.
 */
export function resolvePostSendPlacement({
  contentHeightPx,
  viewportHeightPx,
  trailingSlackPx,
  rowHeightPx,
  leadingInsetPx = 0,
}: {
  contentHeightPx: number;
  viewportHeightPx: number;
  trailingSlackPx: number;
  rowHeightPx: number;
  leadingInsetPx?: number;
}) {
  const rowBottom = Math.max(0, contentHeightPx - trailingSlackPx);
  const rowTop = Math.max(0, rowBottom - rowHeightPx);
  return resolvePostSendTarget({
    rowTop,
    rowBottom,
    viewportHeight: viewportHeightPx,
    trailingSlackPx,
    leadingInsetPx,
  });
}

/** A send anchor needs both the submitted row and the resting keyboard inset. */
export function canStartPostSendPlacement(
  userMessageId: string,
  renderedMessageIds: readonly string[],
  keyboardExtra: number,
): boolean {
  return keyboardExtra <= 0 && renderedMessageIds.includes(userMessageId);
}
