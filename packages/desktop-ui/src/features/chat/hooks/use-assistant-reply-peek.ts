import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageRecord } from "@stella/contracts/local-chat";
import { getLatestAssistantPreview } from "@/features/chat/lib/latest-assistant-preview";

type UseAssistantReplyPeekOptions = {
  messages: MessageRecord[];
  /** True while stream/send auto-follow is armed (i.e. user is at the tail). */
  isFollowingLatest: boolean;
  /**
   * True while the freshest turn is still on screen (within the generous
   * at-bottom tolerance). Gates the peek so it only appears when the user is
   * genuinely scrolled up, not a few px off the bottom where the follow latch
   * has released but the latest messages are still visible.
   */
  isNearBottom: boolean;
};

/**
 * Surface a one-line preview of the latest assistant message — but only
 * for messages that arrived AFTER the user left the live tail. If the
 * user scrolls up while already looking at the most recent reply, no
 * peek (they've already seen it); the peek appears the moment a newer
 * assistant message lands while they're still scrolled away.
 */
export function useAssistantReplyPeek({
  messages,
  isFollowingLatest,
  isNearBottom,
}: UseAssistantReplyPeekOptions) {
  const latest = useMemo(() => getLatestAssistantPreview(messages), [messages]);
  const latestId = latest?.id ?? null;

  // While the freshest turn is on screen — following the tail OR just within
  // the generous at-bottom band — keep the baseline pinned to the latest
  // assistant message id: anything at or before this id was already visible to
  // the user. When they genuinely scroll away, the baseline freezes and any
  // newer assistant id flips the peek visible.
  const [baselineId, setBaselineId] = useState<string | null>(latestId);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    if (isFollowingLatest || isNearBottom) setBaselineId(latestId);
  }, [isFollowingLatest, isNearBottom, latestId]);

  const dismiss = useCallback(() => {
    if (latestId) setDismissedId(latestId);
  }, [latestId]);

  // Require the user to be genuinely scrolled up (`!isNearBottom`), not merely
  // to have dropped the follow latch with a tiny nudge — if the latest messages
  // are still on screen there is nothing to peek at.
  const visible =
    latest !== null &&
    !isFollowingLatest &&
    !isNearBottom &&
    latestId !== baselineId &&
    latestId !== dismissedId;

  return {
    visible,
    previewText: latest?.text ?? "",
    dismiss,
  };
}
