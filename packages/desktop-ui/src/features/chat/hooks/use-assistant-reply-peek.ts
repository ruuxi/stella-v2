import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageRecord } from "@stella/contracts/local-chat";
import { getLatestAssistantPreview } from "@/features/chat/lib/latest-assistant-preview";

type UseAssistantReplyPeekOptions = {
  messages: MessageRecord[];

  isFollowingLatest: boolean;

  isNearBottom: boolean;
};

export function useAssistantReplyPeek({
  messages,
  isFollowingLatest,
  isNearBottom,
}: UseAssistantReplyPeekOptions) {
  const latest = useMemo(() => getLatestAssistantPreview(messages), [messages]);
  const latestId = latest?.id ?? null;

  const [baselineId, setBaselineId] = useState<string | null>(latestId);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    if (isFollowingLatest || isNearBottom) setBaselineId(latestId);
  }, [isFollowingLatest, isNearBottom, latestId]);

  const dismiss = useCallback(() => {
    if (latestId) setDismissedId(latestId);
  }, [latestId]);

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
