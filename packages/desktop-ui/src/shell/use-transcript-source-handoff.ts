import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Longest a source change keeps the previous transcript on screen while the
 * new source loads. A source that cannot load (an unreachable cloud) shows
 * what it has after this rather than holding the old view forever.
 */
const HANDOFF_TIMEOUT_MS = 3000;

/**
 * A conversation kept on this computer renders from pi-durable's transcript
 * on pi and from the chat log under Claude Code, so a model pick can change
 * its source mid-conversation (one stored in the cloud always renders from
 * its journal). The incoming store starts empty or stale, which would blank
 * the chat or drop its latest rows until it caught up. Across a source change
 * in the same conversation this keeps showing the transcript that was on
 * screen until the incoming source is current, then swaps in one commit. A
 * conversation change never holds.
 */
export function useTranscriptSourceHandoff<T extends object>({
  conversationId,
  source,
  ready,
  transcript,
}: {
  conversationId: string | null;
  source: string;
  ready: boolean;
  transcript: T;
}) {
  const shownRef = useRef<{
    conversationId: string | null;
    source: string;
    transcript: T;
  } | null>(null);
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  const key = `${conversationId ?? ""}\0${source}`;
  const shown = shownRef.current;
  const holding =
    shown !== null &&
    shown.conversationId === conversationId &&
    shown.source !== source &&
    !ready &&
    expiredKey !== key;

  useLayoutEffect(() => {
    if (!holding) shownRef.current = { conversationId, source, transcript };
  });

  useEffect(() => {
    if (!holding) {
      if (expiredKey !== null) setExpiredKey(null);
      return undefined;
    }
    const timer = setTimeout(() => setExpiredKey(key), HANDOFF_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [expiredKey, holding, key]);

  return holding
    ? { ...shown.transcript, holding: true }
    : { ...transcript, holding: false };
}
