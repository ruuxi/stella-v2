/** Portion of the readable viewport reserved for the incoming response. */
export const RESPONSE_SPACER_VIEWPORT_RATIO = 1 / 2;

/** Keep this much readable room for the latest turn above the spacer. */
export const RESPONSE_SPACER_CONTENT_FLOOR_PX = 240;

/** Do not pull a submit out of scrollback when the user is reading history. */
export const LATEST_TURN_PLACEMENT_THRESHOLD_PX = 300;

/** Synthetic room for a future reply must not scroll an already-visible one. */
export function resolveReplyOverflow({
  contentHeightPx,
  viewportHeightPx,
  responseSpacerHeightPx,
}: {
  contentHeightPx: number;
  viewportHeightPx: number;
  responseSpacerHeightPx: number;
}) {
  return Math.max(0, contentHeightPx - responseSpacerHeightPx - viewportHeightPx);
}

/**
 * Codex-style empty response area beneath the latest turn.
 *
 * `bottomInsetPx` is the part of the list covered by the composer, keyboard,
 * and edge fade. It remains part of the physical spacer, while the one-half
 * ratio is calculated over the viewport that is actually readable.
 */
export function resolveResponseSpacerHeight({
  viewportHeight,
  bottomInsetPx,
  minimumHeightPx = 0,
}: {
  viewportHeight: number;
  bottomInsetPx: number;
  minimumHeightPx?: number;
}) {
  const readableHeight = Math.max(0, viewportHeight - bottomInsetPx);
  const blankResponseArea = Math.max(
    0,
    Math.min(
      readableHeight * RESPONSE_SPACER_VIEWPORT_RATIO,
      readableHeight - RESPONSE_SPACER_CONTENT_FLOOR_PX,
    ),
  );
  return Math.max(minimumHeightPx, bottomInsetPx + blankResponseArea);
}

/** Consume synthetic response space one-for-one with scroll-away motion. */
export function consumeResponseSpacerHeight({
  currentHeightPx,
  minimumHeightPx,
  distanceDeltaPx,
}: {
  currentHeightPx: number;
  minimumHeightPx: number;
  distanceDeltaPx: number;
}) {
  return Math.max(
    minimumHeightPx,
    currentHeightPx - Math.max(0, distanceDeltaPx),
  );
}

/**
 * Apply latest-turn placement only while following the live tail. The literal
 * list end includes the synthetic response spacer, so exclude it before
 * applying the scrollback threshold.
 */
export function shouldPlaceLatestTurn({
  distanceFromBottomPx,
  responseSpacerHeightPx,
  isFollowingLatest,
}: {
  distanceFromBottomPx: number;
  responseSpacerHeightPx: number;
  isFollowingLatest: boolean;
}) {
  return (
    isFollowingLatest &&
    distanceFromBottomPx - responseSpacerHeightPx <=
      LATEST_TURN_PLACEMENT_THRESHOLD_PX
  );
}

/**
 * Frame a short user row above the response spacer. A user message taller than
 * the remaining reading area is aligned by its top instead.
 */
export function resolvePostSendTarget({
  rowTop,
  rowBottom,
  viewportHeight,
  responseSpacerHeightPx,
}: {
  rowTop: number;
  rowBottom: number;
  viewportHeight: number;
  responseSpacerHeightPx: number;
}) {
  const rowHeight = Math.max(0, rowBottom - rowTop);
  const availableForRow = Math.max(0, viewportHeight - responseSpacerHeightPx);
  return rowHeight <= availableForRow
    ? rowBottom - viewportHeight + responseSpacerHeightPx
    : rowTop;
}

/**
 * Post-send anchor for the latest user row, derived from live list geometry.
 * `trailingSlackPx` is everything below the row (response spacer + reserved
 * bottom inset), so `contentHeightPx - trailingSlackPx` is the row's bottom.
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
}: {
  contentHeightPx: number;
  viewportHeightPx: number;
  trailingSlackPx: number;
  rowHeightPx: number;
}) {
  const rowBottom = Math.max(0, contentHeightPx - trailingSlackPx);
  const rowTop = Math.max(0, rowBottom - rowHeightPx);
  return resolvePostSendTarget({
    rowTop,
    rowBottom,
    viewportHeight: viewportHeightPx,
    responseSpacerHeightPx: trailingSlackPx,
  });
}
