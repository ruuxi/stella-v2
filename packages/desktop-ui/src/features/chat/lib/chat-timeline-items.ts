import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import type { QueuedUserMessage } from "@/features/chat/hooks/queued-user-messages";
import { eventRowRendersContent } from "@/features/chat/lib/assistant-row-content";
import type { UserAsk } from "@stella/contracts/user-ask";
import type { UserAskRecord } from "@stella/contracts/user-ask-deck";

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
      id: "chat-timeline:ask-deck";
      type: "ask-deck";
      asks: readonly UserAsk[];
    }
  | {
      id: string;
      type: "ask-record";
      record: UserAskRecord;
    }
  | {
      /** Head id preserves the queued-to-sent handoff identity. */
      id: string;
      type: "queued-users";
      messages: QueuedUserMessage[];
    };

/**
 * Builds the actual virtualized sequence at the active edge of the chat.
 * Queued sends must be list data, not a ListFooter: Legend can retain a
 * footer's old measured position while a streaming row grows or a new
 * post-tool assistant segment is inserted, briefly painting that footer
 * above the active row. Keeping the queue in `data` gives the collapsed queue
 * a stable key and an explicit order after every segment of the active turn.
 */
const askRecordSignature = (record: UserAskRecord): string =>
  record.answers.map((answer) => answer.question).join("\u0000");

export const buildChatTimelineItems = (args: {
  rows: EventRowViewModel[];
  queuedUserMessages: readonly QueuedUserMessage[];
  includeWorkingIndicator: boolean;
  openAsks?: readonly UserAsk[];
  askRecords?: readonly UserAskRecord[];
}): ChatTimelineItem[] => {
  const items: ChatTimelineItem[] = [];
  const messageIds = new Set<string>();
  const shownRecords = new Set<string>();

  for (const row of args.rows) {
    if (!eventRowRendersContent(row)) continue;
    messageIds.add(row.id);
    items.push({ id: row.id, type: "message", row });
    if (row.kind === "assistant") {
      for (const record of row.askRecords ?? []) {
        shownRecords.add(record.toolCallId ?? record.id);
        shownRecords.add(askRecordSignature(record));
      }
    }
  }

  for (const record of args.askRecords ?? []) {
    if (
      shownRecords.has(record.toolCallId ?? record.id) ||
      shownRecords.has(askRecordSignature(record))
    ) {
      continue;
    }
    const before = items.findIndex(
      (item) =>
        item.type === "message" &&
        (item.row.timestampMs ?? Number.POSITIVE_INFINITY) > record.createdAt,
    );
    const recordItem: ChatTimelineItem = {
      id: `chat-timeline:ask-record:${record.id}`,
      type: "ask-record",
      record,
    };
    if (before < 0) items.push(recordItem);
    else items.splice(before, 0, recordItem);
  }

  if (args.openAsks && args.openAsks.length > 0) {
    items.push({
      id: "chat-timeline:ask-deck",
      type: "ask-deck",
      asks: args.openAsks,
    });
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
    // Persistence and queue cleanup can land in separate React updates. The
    // canonical/optimistic row wins that overlap frame, preserving one item
    // with the same id instead of rendering queued + sent twins.
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
