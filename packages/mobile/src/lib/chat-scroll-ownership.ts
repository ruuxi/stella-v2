export type ChatDataChangeScrollOwner =
  | "history-anchor"
  | "custom-follow"
  | "legend-tail";

/**
 * Pick exactly one owner for position changes caused by appended chat data.
 *
 * History always wins while follow is released: Legend keeps the visible row
 * anchored and neither the stream loop nor Legend's end pin may move it. At
 * the live tail, the custom loop owns streaming and post-send placement;
 * Legend only owns ordinary, settled appends.
 */
export function resolveChatDataChangeScrollOwner({
  isFollowingLatest,
  isStreaming,
  postSendPlacementPending,
  hasResponseSpacer = false,
}: {
  isFollowingLatest: boolean;
  isStreaming: boolean;
  postSendPlacementPending: boolean;
  hasResponseSpacer?: boolean;
}): ChatDataChangeScrollOwner {
  if (!isFollowingLatest) return "history-anchor";
  if (isStreaming || postSendPlacementPending || hasResponseSpacer) return "custom-follow";
  return "legend-tail";
}
