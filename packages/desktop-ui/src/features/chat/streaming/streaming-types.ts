export type {
  AgentResponseTarget,
  AgentStreamEvent,
} from "@stella/contracts/agent-stream";

import type { AgentResponseTarget } from "@stella/contracts/agent-stream";

export type StreamingAssistantOverlay = {
  _id: string;
  userMessageId: string;
  indexInTurn: number;
  text: string;
  responseTarget?: AgentResponseTarget;
  timestamp: number;
  runId: string;

  canonicalMessageId?: string;

  locked?: boolean;
  heldForHandoff?: boolean;
};

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

export const streamingAssistantOverlayId = (
  userMessageId: string,
  indexInTurn: number,
): string => `stream-overlay:${userMessageId}:${indexInTurn}`;

export const assistantScrollFollowKey = (
  userMessageId: string,
  indexInTurn: number,
): string => `assistant-${userMessageId}-${indexInTurn}`;
