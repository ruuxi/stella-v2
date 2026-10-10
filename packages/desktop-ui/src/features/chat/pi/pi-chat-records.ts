/**
 * A pi-durable conversation as the chat timeline renders it. The transcript's
 * user, assistant and tool-result entries are pi-ai messages, the same shape
 * the cloud journal carries, so they go through the journal's projection
 * (`journalRecordsToMessageRecords`): a turn is a user entry and the entries
 * after it. Agent reports and notes arrive as user input and render hidden,
 * as wakes do; a generation that failed ends its turn with a notice. What a voice call
 * said is model history and stays out; the call's summary shows.
 */
import {
  isPiAgentInput,
  piJournalUserMessage,
  piMessageText,
  type PiChatState,
  type PiEntry,
} from "@stella/contracts/pi-chat";
import type { EventRecord, MessageRecord } from "@stella/contracts/local-chat";
import type { DesktopThreadActivityRecord } from "@/features/chat/thread-activity-types";
import type { JournalRecord } from "@stella/contracts/conversation-protocol";
import { journalRecordsToMessageRecords } from "@/features/cloud/journal-message-records";
import {
  streamingAssistantOverlayId,
  type StreamingAssistantOverlay,
} from "@/features/chat/streaming/streaming-types";

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
      const journaled = piJournalUserMessage(message);
      // A message sent here binds by its request; one placed or imported, by the id its row carries.
      const clientMsgId = state.requestIds[entry.id] ?? journaled.clientMsgId;
      const { hidden } = journaled;
      const origin = (message as { originUserMessageId?: unknown }).originUserMessageId;
      const payload =
        typeof origin === "string" && origin
          ? { ...journaled.message, originUserMessageId: origin }
          : journaled.message;
      // A reply to an agent's report or note shows; a turn the app started stays out whole.
      const automation = hidden && !isPiAgentInput(message);
      turn = {
        userMessageId: clientMsgId ?? `cloud:${turnId}:message:${entry.id}`,
        assistantMessages: 0,
        ...(automation ? { hidden: true as const } : {}),
      };
      records.push({
        ...base,
        turnId,
        role: "user",
        hidden,
        ...(clientMsgId ? { clientMsgId } : {}),
        payload,
      });
    } else if (entry.kind === "pi.assistant" && message.role === "assistant" && message.voiceSession) {
      // A voice call's summary shows wherever the call ended.
      records.push({ ...base, role: "assistant", hidden: false, payload: message as unknown as Record<string, unknown> });
    } else if (turn.hidden || (message.role === "assistant" && message.stella?.hidden)) {
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

/**
 * Activity's agent rows for a conversation on pi: each of Stella's agents'
 * start and how it ended, in the lifecycle events the panel reads, from the
 * agents the task rows list (`piChatAgents`).
 */
export const piAgentActivityEvents = (records: readonly DesktopThreadActivityRecord[]): EventRecord[] => {
  const events: EventRecord[] = [];
  for (const record of records) {
    if (record.source !== "stella") continue;
    const identity = { agentId: record.threadId, attemptGeneration: record.attemptGeneration ?? 1 };
    events.push({
      _id: `pi:${record.threadId}:started`,
      timestamp: record.startedAt,
      type: "agent-started",
      payload: { ...identity, description: record.description, agentType: record.agentType },
    });
    const endedAt = record.completedAt ?? record.startedAt;
    if (record.status === "completed") {
      events.push({
        _id: `pi:${record.threadId}:completed`,
        timestamp: endedAt,
        type: "agent-completed",
        payload: { ...identity, result: record.result ?? "" },
      });
    } else if (record.status === "error" || record.status === "canceled") {
      events.push({
        _id: `pi:${record.threadId}:${record.status}`,
        timestamp: endedAt,
        type: record.status === "error" ? "agent-failed" : "agent-canceled",
        payload: { ...identity, ...(record.error ? { error: record.error } : {}) },
      });
    }
  }
  return events.sort((a, b) => a.timestamp - b.timestamp || (a._id < b._id ? -1 : 1));
};

/**
 * Stella's replies that link files, in the event shape the Files panel reads
 * (the panel takes the links from the text). Agents' results come with
 * their lifecycle (`piAgentActivityEvents`).
 */
export const piReplyFileEvents = (entries: readonly PiEntry[]): EventRecord[] => {
  const events: EventRecord[] = [];
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind !== "pi.assistant" || message?.role !== "assistant" || message.stella?.hidden) continue;
    const text = piMessageText(message);
    if (!text.includes("](")) continue;
    events.push({ _id: `pi:${entry.id}`, timestamp: message.timestamp, type: "assistant_message", payload: { text } });
  }
  return events;
};
