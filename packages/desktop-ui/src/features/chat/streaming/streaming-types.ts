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
import type { ReplyRef } from "@stella/contracts/reply-refs";

/**
 * In-memory assistant message the renderer is showing ahead of SQLite.
 *
 * The persisted source of truth is SQLite, and the runtime delivers each
 * assistant message whole over IPC. The renderer turns that message into a
 * synthetic in-memory `MessageRecord` so the reply can be on screen before
 * its row commits, rather than overlaying a separate "tail row" on top of the
 * persisted list. The overlay is inserted into `displayMessages` by
 * `useConversationDisplayMessages`. While it exists, it masks the persisted
 * row at the same `(userMessageId, indexInTurn)` slot and borrows that row's
 * metadata.
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
  /** Resolved citations from the assistant-message boundary (`reply-refs`). */
  replyRefs?: ReplyRef[];
  timestamp: number;
  runId: string;
  /** Exact persisted twin learned from the assistant-message boundary. */
  canonicalMessageId?: string;
  /** This slot carries the message's full upstream text. */
  locked?: boolean;
};

/** Adopt the provider's finalized text and persisted id for a slot. */
export const reconcileStreamingAssistantCanonicalMessage = (
  overlays: StreamingAssistantOverlay[],
  args: {
    userMessageId: string;
    indexInTurn: number;
    canonicalMessageId?: string;
    canonicalText: string;
    replyRefs?: ReplyRef[];
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
  const replyRefs = args.replyRefs ?? current.replyRefs;
  if (
    current.text === args.canonicalText &&
    current.locked &&
    current.canonicalMessageId === canonicalMessageId &&
    replyRefs === current.replyRefs
  ) {
    return overlays;
  }
  const next = overlays.slice();
  next[index] = {
    ...current,
    text: args.canonicalText,
    locked: true,
    ...(canonicalMessageId ? { canonicalMessageId } : {}),
    ...(replyRefs && replyRefs.length > 0 ? { replyRefs } : {}),
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
