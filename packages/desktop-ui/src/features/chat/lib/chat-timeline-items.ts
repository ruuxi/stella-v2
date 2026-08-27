import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import type { QueuedUserMessage } from "@/features/chat/hooks/queued-user-messages";
import { eventRowRendersContent } from "@/features/chat/lib/assistant-row-content";

export type ChatTimelineItem =
  | {
      id: string;
      type: "message";
      row: EventRowViewModel;
    }
  | {
      id: "chat-timeline:working-indicator";
      type: "working-indicator";
    }
  | {

      id: string;
      type: "queued-users";
      messages: QueuedUserMessage[];
    };

export const buildChatTimelineItems = (args: {
  rows: EventRowViewModel[];
  queuedUserMessages: readonly QueuedUserMessage[];
  includeWorkingIndicator: boolean;
}): ChatTimelineItem[] => {
  const items: ChatTimelineItem[] = [];
  const messageIds = new Set<string>();

  for (const row of args.rows) {
    if (!eventRowRendersContent(row)) continue;
    messageIds.add(row.id);
    items.push({ id: row.id, type: "message", row });
  }

  if (args.includeWorkingIndicator) {
    items.push({
      id: "chat-timeline:working-indicator",
      type: "working-indicator",
    });
  }

  const queued = args.queuedUserMessages
    .map((message, insertionIndex) => ({ message, insertionIndex }))
    .sort(
      (left, right) =>
        left.message.queueOrder - right.message.queueOrder ||
        left.insertionIndex - right.insertionIndex,
    );
  const visibleQueued: QueuedUserMessage[] = [];
  for (const { message } of queued) {

    if (!messageIds.has(message.id)) visibleQueued.push(message);
  }
  if (visibleQueued.length > 0) {
    items.push({
      id: visibleQueued[0]!.id,
      type: "queued-users",
      messages: visibleQueued,
    });
  }

  return items;
};
