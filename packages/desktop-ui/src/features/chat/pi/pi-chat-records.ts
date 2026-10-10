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
  /** The pi user entry that opened it; none for what came before the first one. */
  entryId?: number;
  assistantMessages: number;
  /**
   * A turn the host started with a prompt the user never sees (a schedule
   * fire, a watch escalation): the reply stays out of the timeline too,
   * since the scheduler delivers what it decides to.
   */
  hidden?: true;
};

/** One of the transcript's turns, by the user entry that opened it. */
export type PiTurnIndex = {
  entryId: number;
  userMessageId: string;
  timestamp: number;
  /** Pi's own turn on this computer, not one written in from the journal or the chat log. */
  own: boolean;
};

export type PiChatProjection = {
  records: JournalRecord[];
  messages: MessageRecord[];
  /** The turn the next streamed assistant message belongs to. */
  turn: Turn;
  turns: PiTurnIndex[];
};

/** An entry written in from elsewhere: the journal (`journalSeq`) or the chat log (`localLog`). */
const writtenIn = (entry: PiEntry): boolean => {
  const data = entry.data as { journalSeq?: unknown; localLog?: unknown } | undefined;
  return typeof data?.journalSeq === "number" || typeof data?.localLog === "string";
};

export const projectPiChat = (state: Pick<PiChatState, "entries" | "requestIds">): PiChatProjection => {
  const records: JournalRecord[] = [];
  let turnId = "pi:0";
  let turn: Turn = { assistantMessages: 0 };
  const turns: PiTurnIndex[] = [];
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
        entryId: entry.id,
        assistantMessages: 0,
        ...(automation ? { hidden: true as const } : {}),
      };
      turns.push({
        entryId: entry.id,
        userMessageId: turn.userMessageId!,
        timestamp: message.timestamp,
        own: !writtenIn(entry),
      });
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
  return { records, messages: journalRecordsToMessageRecords(records), turn, turns };
};

/** This computer's pi turn as the journal holds it. */
export type JournaledPiTurn = {
  userMessageId: string;
  /** Its turn has ended in the journal: every row it wrote is there. */
  settled: boolean;
};

/**
 * This computer's pi turns in the journal, by the pi user entry that opened
 * each. The journal names a desktop turn `<source>:<deviceId>:pi:<syncId>:<entryId>`,
 * with one `syncId` per transcript. This transcript's turns are the ones whose
 * prompt carries the id pi gave a turn of its own at that entry; failing
 * that (no such prompt loaded), the ones this device journaled.
 */
export const journaledPiTurns = (
  records: readonly JournalRecord[],
  turns: readonly PiTurnIndex[],
  deviceId: string | null,
): Map<number, JournaledPiTurn> => {
  type Found = JournaledPiTurn & { writer: string; entryId: number };
  const found = new Map<string, Found>();
  for (const record of records) {
    let turn = found.get(record.turnId);
    if (!turn) {
      const match = /^(?:desktop|voice):([^:]+):pi:([^:]+):(\d+)$/.exec(record.turnId);
      if (!match) continue;
      turn = { writer: `${match[1]}:${match[2]}`, entryId: Number(match[3]), userMessageId: "", settled: false };
      found.set(record.turnId, turn);
    }
    if (record.kind === "message" && record.role === "user") {
      turn.userMessageId = record.clientMsgId ?? `cloud:${record.turnId}:message:${record.seq}`;
    } else if (record.kind === "turn" && record.phase !== "started") {
      turn.settled = true;
    }
  }
  const own = new Map(turns.filter((turn) => turn.own).map((turn) => [turn.entryId, turn.userMessageId]));
  let writer = [...found.values()].find((turn) => own.get(turn.entryId) === turn.userMessageId)?.writer;
  if (!writer && deviceId) writer = [...found.values()].find((turn) => turn.writer.startsWith(`${deviceId}:`))?.writer;
  const journaled = new Map<number, JournaledPiTurn>();
  if (!writer) return journaled;
  for (const turn of found.values()) {
    if (turn.writer === writer) journaled.set(turn.entryId, { userMessageId: turn.userMessageId, settled: turn.settled });
  }
  return journaled;
};

/** Pi's rows the journal does not hold yet, and the ids its turns go by in the journal. */
export type PiPendingRows = {
  messages: MessageRecord[];
  /** A turn's user message id on pi, to the id its journal row carries where they differ. */
  journalUserIds: ReadonlyMap<string, string>;
};

const NO_PENDING_ROWS: PiPendingRows = { messages: [], journalUserIds: new Map() };

/**
 * The desktop shows a conversation stored in the cloud from its journal, for
 * every engine. Pi journals a turn as it starts (its prompt) and as it ends
 * (its replies and tools), so what pi has said in a turn still running, or in
 * one the journal could not take, is shown from pi until the journal holds
 * it: a turn the journal lacks shows whole, an open one shows the replies the
 * journal has not caught up to, and a settled one shows only from the journal.
 * Turns older than the journal's loaded window stay out (`sinceMs`).
 */
export const piPendingRows = (args: {
  projection: PiChatProjection;
  journaled: ReadonlyMap<number, JournaledPiTurn>;
  canonical: readonly MessageRecord[];
  sinceMs: number | null;
}): PiPendingRows => {
  const { projection, journaled, canonical, sinceMs } = args;
  const pending = projection.turns.filter((turn) => {
    if (!turn.own || (sinceMs !== null && turn.timestamp < sinceMs)) return false;
    return journaled.get(turn.entryId)?.settled !== true;
  });
  // What pi wrote before the first message (the onboarding greeting) stays
  // on this computer, so it shows from pi once the journal is loaded from the start.
  const opening = sinceMs === null;
  if (pending.length === 0 && !opening) return NO_PENDING_ROWS;
  const canonicalReplies = new Map<string, number>();
  for (const message of canonical) {
    const owner = message.type === "assistant_message" ? message.payload?.userMessageId : undefined;
    if (typeof owner === "string") canonicalReplies.set(owner, (canonicalReplies.get(owner) ?? 0) + 1);
  }
  const byUser = new Map(pending.map((turn) => [turn.userMessageId, turn]));
  const journalUserIds = new Map<string, string>();
  const replies = new Map<string, number>();
  const messages: MessageRecord[] = [];
  for (const message of projection.messages) {
    const owner =
      message.type === "user_message"
        ? message._id
        : typeof message.payload?.userMessageId === "string"
          ? message.payload.userMessageId
          : undefined;
    if (!owner) {
      if (opening && message.type === "assistant_message") messages.push(message);
      continue;
    }
    const turn = byUser.get(owner);
    if (!turn) continue;
    const journal = journaled.get(turn.entryId);
    if (!journal) {
      messages.push(message);
      continue;
    }
    if (message.type === "user_message") continue;
    if (journal.userMessageId && journal.userMessageId !== turn.userMessageId) {
      journalUserIds.set(turn.userMessageId, journal.userMessageId);
    }
    const target = journal.userMessageId || turn.userMessageId;
    const ordinal = (replies.get(target) ?? 0) + 1;
    replies.set(target, ordinal);
    if (ordinal <= (canonicalReplies.get(target) ?? 0)) continue;
    messages.push(
      target === turn.userMessageId
        ? message
        : { ...message, payload: { ...message.payload, userMessageId: target } },
    );
  }
  return messages.length === 0 && journalUserIds.size === 0 ? NO_PENDING_ROWS : { messages, journalUserIds };
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
