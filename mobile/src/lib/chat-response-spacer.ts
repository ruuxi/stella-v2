/** Portion of the readable viewport reserved for the incoming response. */
export const RESPONSE_SPACER_VIEWPORT_RATIO = 2 / 3;

/** Keep this much readable room for the latest turn above the spacer. */
export const RESPONSE_SPACER_CONTENT_FLOOR_PX = 240;

/** Do not pull a submit out of scrollback when the user is reading history. */
export const LATEST_TURN_PLACEMENT_THRESHOLD_PX = 300;

/**
 * Codex-style empty response area beneath the latest turn.
 *
 * `bottomInsetPx` is the part of the list covered by the composer, keyboard,
 * and edge fade. It remains part of the physical spacer, while the two-thirds
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
