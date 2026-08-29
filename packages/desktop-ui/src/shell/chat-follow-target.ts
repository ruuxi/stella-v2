export const CHAT_VIEWPORT_BOTTOM_FADE_PX = 56;

export const FOLLOW_BREATHING_PX = 72;

export const FOLLOW_TOP_PEEK_PX = 56;

export const CHAT_VIEWPORT_TOP_FADE_PX = 24;

export const POST_SEND_TOP_MARGIN_PX = CHAT_VIEWPORT_TOP_FADE_PX + 32;

export const POST_SEND_USER_MESSAGE_BREATHING_PX = 48;

export const RESPONSE_SPACER_VIEWPORT_RATIO = 1 / 2;

export const RESPONSE_SPACER_CONTENT_FLOOR_PX = 240;

export const LATEST_TURN_PLACEMENT_THRESHOLD_PX = 300;

export const AT_BOTTOM_TOLERANCE_PX = 200;

export const followBottomInsetPx = (): number =>
  CHAT_VIEWPORT_BOTTOM_FADE_PX + FOLLOW_BREATHING_PX;

export const resolveResponseSpacerHeight = ({
  viewportHeight,
  bottomInsetPx = CHAT_VIEWPORT_BOTTOM_FADE_PX,
  minimumHeightPx = 0,
}: {
  viewportHeight: number;
  bottomInsetPx?: number;
  minimumHeightPx?: number;
}): number => {
  const readableHeight = Math.max(0, viewportHeight - bottomInsetPx);
  const blankResponseArea = Math.max(
    0,
    Math.min(
      readableHeight * RESPONSE_SPACER_VIEWPORT_RATIO,
      readableHeight - RESPONSE_SPACER_CONTENT_FLOOR_PX,
    ),
  );
  return Math.max(minimumHeightPx, bottomInsetPx + blankResponseArea);
};

export const consumeResponseSpacerHeight = ({
  currentHeightPx,
  minimumHeightPx,
  distanceDeltaPx,
}: {
  currentHeightPx: number;
  minimumHeightPx: number;
  distanceDeltaPx: number;
}): number =>
  Math.max(minimumHeightPx, currentHeightPx - Math.max(0, distanceDeltaPx));

export const shouldPlaceLatestTurn = ({
  distanceFromBottomPx,
  responseSpacerHeightPx,
  isFollowingLatest,
}: {
  distanceFromBottomPx: number;
  responseSpacerHeightPx: number;
  isFollowingLatest: boolean;
}): boolean =>
  isFollowingLatest &&
  distanceFromBottomPx - responseSpacerHeightPx <=
    LATEST_TURN_PLACEMENT_THRESHOLD_PX;

export const resolvePostSendTarget = ({
  rowTop,
  rowBottom,
  viewportHeight,
  responseSpacerHeightPx,
}: {
  rowTop: number;
  rowBottom: number;
  viewportHeight: number;
  responseSpacerHeightPx: number;
}): number => {
  const rowHeight = Math.max(0, rowBottom - rowTop);
  const availableForRow = Math.max(0, viewportHeight - responseSpacerHeightPx);
  const framed =
    rowHeight <= availableForRow
      ? rowBottom - viewportHeight + responseSpacerHeightPx
      : rowTop;

  return Math.min(framed, rowTop - POST_SEND_TOP_MARGIN_PX);
};

export const resolveIdleTailTarget = (args: {
  contentBottom: number;
  clientHeight: number;
}): number =>
  Math.max(0, args.contentBottom - args.clientHeight + followBottomInsetPx());
