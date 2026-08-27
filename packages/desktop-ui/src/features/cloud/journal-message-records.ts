import type { EventRecord, MessageRecord } from "@stella/contracts/local-chat";
import { groupEventsIntoMessages } from "@/features/chat/lib/group-events-into-messages";
import type { JournalRecord } from "./conversation-protocol";
import { messageText } from "./conversation-protocol";

type AgentMessagePayload = Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const timestampOf = (
  payload: AgentMessagePayload,
  fallback: number,
): number => {
  const value = payload.timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const contentBlocks = (
  payload: AgentMessagePayload,
): Array<Record<string, unknown>> =>
  Array.isArray(payload.content)
    ? payload.content
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];

const textPayload = (
  record: Extract<JournalRecord, { kind: "message" }>,
  text: string,
  userMessageId?: string,
): Record<string, unknown> => {
  const voiceSession = asRecord(record.payload.voiceSession);
  const metadata = {
    ...(record.hidden ? { ui: { visibility: "hidden" as const } } : {}),
    ...(voiceSession ? { voiceSession } : {}),
  };
  return {
    text,
    ...(userMessageId ? { userMessageId } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(typeof record.payload.source === "string"
      ? { source: record.payload.source }
      : {}),
    ...(asRecord(record.payload.usage) ? { usage: record.payload.usage } : {}),
  };
};

/**
 * Raw socket windows are record-count bounded and can therefore begin in the
 * middle of a tool-heavy turn. Do not project that leading fragment until its
 * prompt has been backfilled; otherwise assistants have no stable user owner
 * and the originating desktop briefly renders both cache and cloud copies.
 */
export const hasIncompleteLeadingJournalTurn = (
  records: readonly JournalRecord[],
  hasOlder: boolean,
): boolean => {
  if (!hasOlder || records.length === 0) return false;
  const leadingTurnId = records[0]!.turnId;
  const leadingTurn = records.filter(
    (record) => record.turnId === leadingTurnId,
  );
  const hasPrompt = leadingTurn.some(
    (record) => record.kind === "message" && record.role === "user",
  );
  if (hasPrompt) return false;
  return leadingTurn.some(
    (record) =>
      (record.kind === "message" && record.role !== "user") ||
      record.kind === "turn",
  );
};

export const completeJournalWindowRecords = (
  records: readonly JournalRecord[],
  hasOlder: boolean,
): JournalRecord[] => {
  if (!hasIncompleteLeadingJournalTurn(records, hasOlder)) {
    return [...records];
  }
  const incompleteTurnId = records[0]!.turnId;
  return records.filter((record) => record.turnId !== incompleteTurnId);
};

export const activeCloudUserMessageIds = (
  records: readonly JournalRecord[],
): Set<string> => {
  const turns = new Map<
    string,
    { phase: string | null; userMessageId: string | null }
  >();
  for (const record of records) {
    const turn = turns.get(record.turnId) ?? {
      phase: null,
      userMessageId: null,
    };
    if (record.kind === "turn") turn.phase = record.phase;
    if (record.kind === "message" && record.role === "user") {
      turn.userMessageId =
        record.clientMsgId ?? `cloud:${record.turnId}:message:${record.seq}`;
    }
    turns.set(record.turnId, turn);
  }
  return new Set(
    [...turns.values()]
      .filter(
        (turn): turn is { phase: "started"; userMessageId: string } =>
          turn.phase === "started" && turn.userMessageId !== null,
      )
      .map((turn) => turn.userMessageId),
  );
};

/**
 * Projects the Durable Object's canonical AgentMessage journal into the
 * renderer's existing timeline contract.
 *
 * This is a view only. It never writes journal rows into the authoritative
 * local transcript tables: signed-in history remains owned by the conversation
 * Durable Object. Desktop may separately retain a bounded raw-journal cache for
 * explicitly stale reconnect paint; that cache is never runtime/server input.
 */
export const journalRecordsToMessageRecords = (
  records: readonly JournalRecord[],
): MessageRecord[] => {
  const byTurn = new Map<string, JournalRecord[]>();
  for (const record of records) {
    const turn = byTurn.get(record.turnId);
    if (turn) turn.push(record);
    else byTurn.set(record.turnId, [record]);
  }

  const messages: MessageRecord[] = [];
  for (const [turnId, turnRecords] of byTurn) {
    const events: EventRecord[] = [];
    let userMessageId: string | undefined;

    for (const record of turnRecords) {
      if (record.kind !== "message") continue;
      const timestamp = timestampOf(record.payload, record.createdAtMs);
      if (record.role === "user") {
        userMessageId =
          record.clientMsgId ?? `cloud:${turnId}:message:${record.seq}`;
        events.push({
          _id: userMessageId,
          timestamp,
          type: "user_message",
          payload: textPayload(record, messageText(record.payload)),
        });
        continue;
      }

      if (record.role === "assistant") {
        const text = messageText(record.payload);
        if (text) {
          events.push({
            _id: `cloud:${turnId}:message:${record.seq}`,
            timestamp,
            type: "assistant_message",
            payload: textPayload(record, text, userMessageId),
          });
        }
        for (const [index, block] of contentBlocks(record.payload).entries()) {
          if (block.type !== "toolCall") continue;
          const toolCallId =
            typeof block.id === "string" && block.id
              ? block.id
              : `cloud:${turnId}:tool:${record.seq}:${index}`;
          const toolName =
            typeof block.name === "string" && block.name ? block.name : "tool";
          events.push({
            _id: `cloud:${turnId}:tool-request:${record.seq}:${index}`,
            timestamp: timestamp + index + 1,
            type: "tool_request",
            requestId: toolCallId,
            payload: {
              toolName,
              ...(asRecord(block.arguments)
                ? { args: block.arguments as Record<string, unknown> }
                : {}),
            },
          });
        }
        continue;
      }

      const toolCallId =
        typeof record.payload.toolCallId === "string"
          ? record.payload.toolCallId
          : `cloud:${turnId}:tool-result:${record.seq}`;
      const toolName =
        typeof record.payload.toolName === "string"
          ? record.payload.toolName
          : "tool";
      const resultText = messageText(record.payload);
      const details = asRecord(record.payload.details);
      events.push({
        _id: `cloud:${turnId}:tool-result:${record.seq}`,
        timestamp,
        type: "tool_result",
        requestId: toolCallId,
        payload: {
          toolName,
          result: details ?? resultText,
          resultPreview: resultText,
          ...(details ?? {}),
          ...(record.payload.isError === true
            ? { error: resultText || "Tool failed." }
            : {}),
        },
      });
    }
    messages.push(...groupEventsIntoMessages(events));
  }
  return messages;
};

const assistantOwner = (message: MessageRecord): string | null => {
  if (message.type !== "assistant_message") return null;
  const value = message.payload?.userMessageId;
  return typeof value === "string" && value ? value : null;
};

/**
 * Keeps unacknowledged local cache rows visible, then atomically yields each
 * logical slot to its canonical journal twin. Matching is by the prompt's
 * stable client message id and assistant ordinal within that prompt — never
 * by text or timestamp.
 */
export const mergeCanonicalMessagesWithLocalCache = (
  canonical: readonly MessageRecord[],
  local: readonly MessageRecord[],
  activeUserMessageIds: ReadonlySet<string> = new Set(),
): MessageRecord[] => {
  if (local.length === 0) return [...canonical];

  const canonicalIds = new Set(canonical.map((message) => message._id));
  const canonicalAssistantCounts = new Map<string, number>();
  for (const message of canonical) {
    const owner = assistantOwner(message);
    if (!owner) continue;
    canonicalAssistantCounts.set(
      owner,
      (canonicalAssistantCounts.get(owner) ?? 0) + 1,
    );
  }

  const localAssistantOrdinals = new Map<string, number>();
  const unacknowledged = local.filter((message) => {
    if (canonicalIds.has(message._id)) return false;
    // A delivery rejection is device-specific operational state, not a
    // competing transcript row. Keep the durable local notice visible across
    // restart even after the canonical turn becomes terminal.
    if (
      message.type === "assistant_message" &&
      message.payload?.source === "cloud-sync-error"
    ) {
      return true;
    }
    const owner = assistantOwner(message);
    if (!owner) return activeUserMessageIds.has(message._id);
    if (!activeUserMessageIds.has(owner)) return false;
    const ordinal = (localAssistantOrdinals.get(owner) ?? 0) + 1;
    localAssistantOrdinals.set(owner, ordinal);
    return ordinal > (canonicalAssistantCounts.get(owner) ?? 0);
  });

  // The journal sequence, reflected by `canonical` array order, is the
  // authority. AgentMessage timestamps may come from different devices and
  // can be skewed, so sorting canonical rows by those clocks would subtly
  // reorder the same conversation across clients. Any cache-only rows are
  // necessarily newer than the fetched canonical tail and remain a temporary
  // suffix until their journal twins arrive.
  return [...canonical, ...unacknowledged];
};
