/**
 * A pi-durable conversation as the chat timeline renders it. The transcript's
 * user, assistant and tool-result entries are pi-ai messages, the same shape
 * the cloud journal carries, so they go through the journal's projection
 * (`journalRecordsToMessageRecords`): a turn is a user entry and the entries
 * after it. Agent reports arrive as user input and render hidden, as wakes
 * do; a generation that failed ends its turn with a notice.
 */
import { piMessageText, type PiChatState } from "@stella/contracts/pi-chat";
import type { MessageRecord } from "@stella/contracts/local-chat";
import type { JournalRecord } from "@/features/cloud/conversation-protocol";
import { journalRecordsToMessageRecords } from "@/features/cloud/journal-message-records";
import {
  streamingAssistantOverlayId,
  type StreamingAssistantOverlay,
} from "@/features/chat/streaming/streaming-types";

const REPORT_RE = /^\[(Agent completed|Task failed|Task canceled|Subagent paused)\]/;

type Turn = { userMessageId?: string; assistantMessages: number };

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
      turn = { userMessageId: clientMsgId ?? `cloud:${turnId}:message:${entry.id}`, assistantMessages: 0 };
      records.push({
        ...base,
        turnId,
        role: "user",
        hidden: REPORT_RE.test(piMessageText(message).trimStart()),
        ...(clientMsgId ? { clientMsgId } : {}),
        payload: message as unknown as Record<string, unknown>,
      });
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
  if (!state.streaming || !text.trim() || !turn.userMessageId) return [];
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
