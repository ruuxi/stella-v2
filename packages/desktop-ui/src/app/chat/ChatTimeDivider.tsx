/**
 * Centered time between messages — the iMessage behaviour, shared with mobile:
 * a conversation gets a time label only where a long enough gap precedes a
 * message (see `timestampHeaders`), never one under every bubble. The timeline
 * decides WHICH rows carry one; this only paints it.
 */
import { memo, useMemo } from "react";
import { useLocale } from "@/shared/i18n";
import { formatTimestampHeader } from "@/features/chat/lib/message-time-labels";

export const ChatTimeDivider = memo(function ChatTimeDivider({
  timestampMs,
}: {
  timestampMs: number;
}) {
  const locale = useLocale();
  const label = useMemo(
    () => formatTimestampHeader(timestampMs, locale),
    [locale, timestampMs],
  );
  return (
    <div className="chat-time-divider">
      <time dateTime={new Date(timestampMs).toISOString()}>{label}</time>
    </div>
  );
});
