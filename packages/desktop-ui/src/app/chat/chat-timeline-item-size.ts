import type { ChatTimelineItem } from "@/features/chat/lib/chat-timeline-items";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";

/**
 * Per-kind first-paint estimates for Legend List. Tool-card turns in the
 * representative long chat are routinely 800–2000px, so a uniform 120–140px
 * estimate made the first upward scroll uniquely expensive: content height
 * grew as items measured, the start threshold only then became visible, and
 * the virtualizer synchronously instantiated a long unmeasured runway.
 *
 * These values seed Legend's per-type `averageSizes` via `getItemType`.
 * Do not feed them through `getFixedItemSize` — that locks `sizesKnown`
 * and prevents later measurement of variable markdown / cards.
 */
export const CHAT_TIMELINE_ITEM_TYPE = {
  user: "user",
  assistantPlain: "assistant-plain",
  assistantRich: "assistant-rich",
  working: "working",
  queued: "queued",
} as const;

export type ChatTimelineItemType =
  (typeof CHAT_TIMELINE_ITEM_TYPE)[keyof typeof CHAT_TIMELINE_ITEM_TYPE];

const ESTIMATE_BY_TYPE: Record<ChatTimelineItemType, number> = {
  user: 88,
  "assistant-plain": 160,
  "assistant-rich": 720,
  working: 56,
  queued: 72,
};

const assistantLooksRich = (row: EventRowViewModel): boolean => {
  if (row.kind !== "assistant") return false;
  if ((row.toolActivity?.steps.length ?? 0) > 0) return true;
  if (row.mapArtifacts && row.mapArtifacts.length > 0) return true;
  if (row.sourceDiffPayloads && row.sourceDiffPayloads.length > 0) return true;
  if (row.scheduleReceipt) return true;
  if (row.voiceSession) return true;
  if (row.resourcePayload) return true;
  if (row.inlineImagePayloads && row.inlineImagePayloads.length > 0) return true;
  if (row.webSearchResults && row.webSearchResults.length > 0) return true;
  if (row.officePreviewRef) return true;
  if (row.backgroundWork) return true;
  if (row.agentCompletion) return true;
  if (row.customSlot) return true;
  const text = row.text ?? "";
  return text.length > 1_200 || text.includes("```");
};

export const getChatTimelineItemType = (
  item: ChatTimelineItem,
): ChatTimelineItemType => {
  if (item.type === "working-indicator") return CHAT_TIMELINE_ITEM_TYPE.working;
  if (item.type === "queued-users") return CHAT_TIMELINE_ITEM_TYPE.queued;
  const row = item.row;
  if (row.kind === "user") return CHAT_TIMELINE_ITEM_TYPE.user;
  if (assistantLooksRich(row)) return CHAT_TIMELINE_ITEM_TYPE.assistantRich;
  return CHAT_TIMELINE_ITEM_TYPE.assistantPlain;
};

export const getChatTimelineItemSize = (
  item: ChatTimelineItem,
  fallback: number,
): number => ESTIMATE_BY_TYPE[getChatTimelineItemType(item)] ?? fallback;
