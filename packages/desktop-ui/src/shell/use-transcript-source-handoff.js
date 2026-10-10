import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Longest a source change keeps the previous transcript on screen while the
 * new source loads. A source that cannot load (an unreachable cloud) shows
 * what it has after this rather than holding the old view forever.
 */
const HANDOFF_TIMEOUT_MS = 3000;

/**
 * The chat renders one conversation from one of two stores: pi-durable's
 * transcript, or the cloud journal with the local replica. Which one follows
 * the user's engine (Claude Code keeps the journal path), so a model pick
 * can change the source mid-conversation. The incoming store starts empty or
 * stale, which blanked the chat or dropped its latest rows until it caught
 * up. Across a source change in the same conversation this keeps showing the
 * transcript that was on screen until the incoming source is current, then
 * swaps in one commit. A conversation change never holds.
 */
export function useTranscriptSourceHandoff({
  conversationId,
  source,
  ready,
  transcript,
}) {
  const shownRef = useRef(null);
  const [expiredKey, setExpiredKey] = useState(null);
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

  return holding ? { ...shown.transcript, holding: true } : { ...transcript, holding: false };
}
