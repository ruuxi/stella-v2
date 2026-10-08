/**
 * A pi-durable conversation as the chat timeline renders it. The transcript's
 * user, assistant and tool-result entries are pi-ai messages, the same shape
 * the cloud journal carries, so they go through the journal's projection
 * (`journalRecordsToMessageRecords`): a turn is a user entry and the entries
 * after it. Agent reports arrive as user input and render hidden, as wakes
 * do; a generation that failed ends its turn with a notice.
 */
import {
  piMessageText,
  piUserView,
  type PiChatState,
  type PiContentBlock,
  type PiUserMessage,
} from "@stella/contracts/pi-chat";
import type { MessageRecord } from "@stella/contracts/local-chat";
import type { JournalRecord } from "@/features/cloud/conversation-protocol";
import { journalRecordsToMessageRecords } from "@/features/cloud/journal-message-records";
import {
  streamingAssistantOverlayId,
  type StreamingAssistantOverlay,
} from "@/features/chat/streaming/streaming-types";

const REPORT_RE = /^\[(Agent completed|Task failed|Task canceled|Subagent paused)\]/;

/**
 * A user entry as the journal projection reads a user message: the text the
 * user typed, the attachment previews (images as image blocks, files as
 * declared attachments) and the context chips. Parts the runtime added for
 * the model are marked hidden and left out.
 */
const userPayload = (message: PiUserMessage): Record<string, unknown> => {
  const { text, display } = piUserView(message);
  const images: PiContentBlock[] = [];
  const files: Array<Record<string, unknown>> = [];
  for (const attachment of display?.attachments ?? []) {
    const match = attachment.kind === "image" ? /^data:([^;,]+);base64,(.+)$/s.exec(attachment.url ?? "") : null;
    if (match) images.push({ type: "image", mimeType: match[1]!, data: match[2]! });
    else if (attachment.kind === "file") files.push({ ...attachment, kind: "file" });
  }
  return {
    role: "user",
    content: [{ type: "text", text }, ...images],
    timestamp: message.timestamp,
    ...(files.length > 0 ? { attachments: files } : {}),
    ...(display?.context ? { metadata: { context: display.context } } : {}),
  };
};

type Turn = {
  userMessageId?: string;
  assistantMessages: number;
  /**
   * A turn the host started with a prompt the user never sees (a schedule
   * fire, a watch escalation): the reply stays out of the timeline too,
   * since the scheduler delivers what it decides to.
   */
  hidden?: true;
};

export type PiChatProjection = {
  records: JournalRecord[];
  messages: MessageRecord[];
  /** The turn the next streamed assistant message belongs to. */
  turn: Turn;
};

export const projectPiChat = (state: Pick<PiChatState, "entries" | "requestIds">): PiChatProjection => {
  const records: JournalRecord[] = [];
  let turnId = "pi:0";
  let turn: Turn = { assistantMessages: 0 };
  for (const entry of state.entries) {
    const message = entry.model?.[0];
    if (!message || message.role === "system") continue;
    const base = { seq: entry.id, turnId, createdAtMs: message.timestamp, kind: "message" as const };
    if (entry.kind === "pi.user" && message.role === "user") {
      turnId = `pi:${entry.id}`;
      const clientMsgId = state.requestIds[entry.id];
      const view = piUserView(message);
      const report = REPORT_RE.test(piMessageText(message).trimStart());
      const automation = !report && !view.text.trim() && !view.display;
      turn = {
        userMessageId: clientMsgId ?? `cloud:${turnId}:message:${entry.id}`,
        assistantMessages: 0,
        ...(automation ? { hidden: true as const } : {}),
      };
      records.push({
        ...base,
        turnId,
        role: "user",
        hidden: report || automation,
        ...(clientMsgId ? { clientMsgId } : {}),
        payload: userPayload(message),
      });
    } else if (turn.hidden) {
      continue;
    } else if (entry.kind === "pi.assistant" && message.role === "assistant") {
      records.push({ ...base, role: "assistant", hidden: false, payload: message as unknown as Record<string, unknown> });
      if (piMessageText(message).trim()) turn.assistantMessages += 1;
      if (message.stopReason === "error") {
        records.push({
          seq: entry.id,
          turnId,
          createdAtMs: message.timestamp,
          kind: "turn",
          phase: "failed",
          notice: `Stella couldn't answer: ${message.errorMessage ?? "the model request failed."}`,
        });
      }
    } else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
      records.push({ ...base, role: "toolResult", hidden: false, payload: message as unknown as Record<string, unknown> });
    }
  }
  return { records, messages: journalRecordsToMessageRecords(records), turn };
};

/** The assistant message being generated, as the timeline's streaming overlay. */
export const piStreamingOverlay = (
  state: Pick<PiChatState, "streaming">,
  turn: Turn,
): StreamingAssistantOverlay[] => {
  const text = piMessageText(state.streaming);
  if (!state.streaming || !text.trim() || !turn.userMessageId || turn.hidden) return [];
  return [
    {
      _id: streamingAssistantOverlayId(turn.userMessageId, turn.assistantMessages),
      userMessageId: turn.userMessageId,
      indexInTurn: turn.assistantMessages,
      text,
      timestamp: state.streaming.timestamp,
      runId: "pi",
    },
  ];
};
