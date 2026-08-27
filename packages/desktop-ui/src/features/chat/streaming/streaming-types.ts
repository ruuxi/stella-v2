/**
 * Shared types for the streaming engine.
 * Separate file to avoid circular imports between
 * use-streaming-chat.ts and use-resume-agent-run.ts.
 */
export type {
  AgentResponseTarget,
  AgentStreamEvent,
} from "@stella/contracts/agent-stream";

import type { AgentResponseTarget } from "@stella/contracts/agent-stream";

/**
 * In-memory assistant message delivered by the runtime for the active run.
 *
 * Assistant text is NOT streamed: one `assistant-message` runtime event
 * carries the whole canonical text for a message segment, and the renderer
 * materializes it as a single locked overlay row. The overlay exists only so
 * the message is on screen the instant the runtime reports it — before the
 * SQLite `localChat:updated` snapshot lands. While present it masks the
 * persisted row at the same `(userMessageId, indexInTurn)` slot and borrows
 * that row's metadata / tool events (see
 * `useConversationDisplayMessages`).
 *
 * Layout invariants:
 *   - `indexInTurn` is 1-based per `userMessageId`. The first assistant
 *     message in a turn (e.g. the preamble) gets `1`; the post-tool
 *     answer gets `2`; etc.
 *   - `timestamp` need only sort the overlay AFTER its anchoring user
 *     message and after any earlier persisted assistants in the same
 *     turn. `Date.now()` at creation time satisfies that; if the real
 *     persisted row lands while the overlay is still present, the
 *     persisted twin is hidden until the overlay is cleared.
 *   - `responseTarget` mirrors the runtime's per-message target so the
 *     row renderer can pick up agent-terminal-notice styling, etc.
 */
export type StreamingAssistantOverlay = {
  _id: string;
  userMessageId: string;
  indexInTurn: number;
  text: string;
  responseTarget?: AgentResponseTarget;
  timestamp: number;
  runId: string;
  /** Exact persisted twin learned from the assistant-message boundary. */
  canonicalMessageId?: string;
  /**
   * Always `true` for overlays created from an `assistant-message` event —
   * the text they carry is the runtime's canonical text for the message, so
   * there is never a partial state. Kept as a field because the display merge
   * and the read-aloud/pet consumers still key on "is this row settled".
   */
  locked?: boolean;
};

/** Replace an existing overlay slot's text with the provider's finalized text. */
export const reconcileStreamingAssistantCanonicalMessage = (
  overlays: StreamingAssistantOverlay[],
  args: {
    userMessageId: string;
    indexInTurn: number;
    canonicalMessageId?: string;
    canonicalText: string;
  },
): StreamingAssistantOverlay[] => {
  const index = overlays.findIndex(
    (overlay) =>
      overlay.userMessageId === args.userMessageId &&
      overlay.indexInTurn === args.indexInTurn,
  );
  if (index < 0) return overlays;
  const current = overlays[index]!;
  const canonicalMessageId =
    args.canonicalMessageId ?? current.canonicalMessageId;
  if (
    current.text === args.canonicalText &&
    current.locked &&
    current.canonicalMessageId === canonicalMessageId
  ) {
    return overlays;
  }
  const next = overlays.slice();
  next[index] = {
    ...current,
    text: args.canonicalText,
    locked: true,
    ...(canonicalMessageId ? { canonicalMessageId } : {}),
  };
  return next;
};

/** Stable synthetic id used for both the overlay row and its React key. */
export const streamingAssistantOverlayId = (
  userMessageId: string,
  indexInTurn: number,
): string => `stream-overlay:${userMessageId}:${indexInTurn}`;

/** Stable scroll-follow / React row key for an assistant slot in a turn. */
export const assistantScrollFollowKey = (
  userMessageId: string,
  indexInTurn: number,
): string => `assistant-${userMessageId}-${indexInTurn}`;
