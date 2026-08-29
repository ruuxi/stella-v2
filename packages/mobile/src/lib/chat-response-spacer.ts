export const RESPONSE_SPACER_VIEWPORT_RATIO = 1 / 2;

export const RESPONSE_SPACER_CONTENT_FLOOR_PX = 240;

export const LATEST_TURN_PLACEMENT_THRESHOLD_PX = 300;

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
