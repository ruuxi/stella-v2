import { journalLifecycleEvent } from "./journal-activity-files";
import type { EventRecord, MessageRecord } from "@stella/contracts/local-chat";
import { groupEventsIntoMessages } from "@/features/chat/lib/group-events-into-messages";
import type { JournalRecord } from "./conversation-protocol";
import { messageText } from "./conversation-protocol";
import {
  splitReplyRefs,
  toReplyPreview,
  type RawReplyRef,
  type ReplyRef,
} from "@stella/contracts/reply-refs";

type JournalMessageRecord = Extract<JournalRecord, { kind: "message" }>;

const userEventId = (record: JournalMessageRecord): string =>
  record.clientMsgId ?? `cloud:${record.turnId}:message:${record.seq}`;

const LIFECYCLE_THREAD_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?^thread_id:\s*(\S+)/m;
const LIFECYCLE_DESCRIPTION_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?^description:\s*(.+)$/m;

/**
 * The task named by a hidden lifecycle wake prompt (`[Agent completed]`
 * and friends): its thread id and, when the prompt carries one, its
 * description. A locally executed turn mirrored into the journal has no
 * lifecycle card, so this prompt is where the task's title comes from.
 */
export const lifecycleWakeTask = (
  text: string,
): { threadId: string; description?: string } | null => {
  const threadId = LIFECYCLE_THREAD_RE.exec(text)?.[1]?.trim();
  if (!threadId) return null;
  const description = LIFECYCLE_DESCRIPTION_RE.exec(text)?.[1]?.trim();
  return description ? { threadId, description } : { threadId };
};

const LIFECYCLE_KIND_RE =
  /^\[(Agent completed|Task failed|Task canceled|Subagent paused)\]/m;
const LIFECYCLE_TRAILER_RE = /^(?:agent_state|presentation|routing|error):/;

/**
 * The `result:` body of an `[Agent completed]` wake prompt (the lines after
 * `result:` up to the runtime's trailing instructions), or the `error:`
 * line of a failed / canceled one.
 */
export const lifecycleWakeOutcome = (
  text: string,
): { kind: "completed" | "failed" | "canceled"; body: string } | null => {
  const kind = LIFECYCLE_KIND_RE.exec(text)?.[1];
  if (!kind) return null;
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) =>
    kind === "Agent completed" ? line.startsWith("result:") : line.startsWith("error:"),
  );
  let body = "";
  if (startIndex !== -1) {
    const first = lines[startIndex]!.replace(/^(?:result|error):\s?/, "");
    const rest: string[] = [];
    for (const line of lines.slice(startIndex + 1)) {
      if (LIFECYCLE_TRAILER_RE.test(line)) break;
      rest.push(line);
    }
    body = [first, ...rest].join("\n").trim();
  }
  return {
    kind:
      kind === "Agent completed"
        ? "completed"
        : kind === "Task failed"
          ? "failed"
          : "canceled",
    body,
  };
};

const lifecycleAgentIdsOnTurn = (
  turnRecords: readonly JournalRecord[],
): Set<string> => {
  const ids = new Set<string>();
  for (const record of turnRecords) {
    if (record.kind === "card" && record.card.type === "agent-lifecycle") {
      ids.add(record.card.event.payload.agentId);
    }
  }
  return ids;
};

const spawnResultThreadId = (
  record: JournalMessageRecord,
): string | null => {
  if (record.role !== "toolResult" || record.payload.toolName !== "spawn_agent") {
    return null;
  }
  const details = asRecord(record.payload.details);
  if (typeof details?.thread_id === "string" && details.thread_id) {
    return details.thread_id;
  }
  // A locally executed turn mirrors the tool's JSON text without details.
  try {
    const parsed = JSON.parse(messageText(record.payload)) as unknown;
    const threadId = asRecord(parsed)?.thread_id;
    return typeof threadId === "string" && threadId ? threadId : null;
  } catch {
    return null;
  }
};

/**
 * Lifecycle events for a turn the desktop executed and mirrored into the
 * journal. Such a turn carries no `agent-lifecycle` card: the spawn is only
 * a `spawn_agent` result naming its thread, and the completion is only the
 * hidden `[Agent completed]` wake prompt. Synthesize the events the worker
 * would have written so both placements project the same rows (spawn row on
 * the spawning reply, completion with its linked files on the relaying
 * reply). A task that does have a card on the turn keeps the card.
 */
const mirroredLifecycleEvents = (
  turnId: string,
  turnRecords: readonly JournalRecord[],
): { spawns: Map<number, EventRecord>; wake: EventRecord | null } => {
  const carded = lifecycleAgentIdsOnTurn(turnRecords);
  const descriptionsByCall = new Map<string, string>();
  for (const record of turnRecords) {
    if (record.kind !== "message" || record.role !== "assistant") continue;
    for (const block of contentBlocks(record.payload)) {
      if (block.type !== "toolCall" || block.name !== "spawn_agent") continue;
      const description = asRecord(block.arguments)?.description;
      if (typeof block.id === "string" && typeof description === "string") {
        descriptionsByCall.set(block.id, description.trim());
      }
    }
  }
  const spawns = new Map<number, EventRecord>();
  let wake: EventRecord | null = null;
  for (const record of turnRecords) {
    if (record.kind !== "message") continue;
    const timestamp = timestampOf(record.payload, record.createdAtMs);
    if (record.role === "user" && record.hidden) {
      const text = messageText(record.payload);
      const task = lifecycleWakeTask(text);
      const outcome = lifecycleWakeOutcome(text);
      if (!task || !outcome || carded.has(task.threadId)) continue;
      const base = { agentId: task.threadId, ...(task.description ? { description: task.description } : {}) };
      wake =
        outcome.kind === "completed"
          ? {
              _id: `cloud:${turnId}:wake:${record.seq}:agent-completed`,
              timestamp,
              type: "agent-completed",
              payload: { ...base, result: outcome.body },
            }
          : {
              _id: `cloud:${turnId}:wake:${record.seq}:agent-${outcome.kind}`,
              timestamp,
              type: outcome.kind === "failed" ? "agent-failed" : "agent-canceled",
              payload: { ...base, ...(outcome.body ? { error: outcome.body } : {}) },
            };
      continue;
    }
    const threadId = spawnResultThreadId(record);
    if (!threadId || carded.has(threadId)) continue;
    const callId =
      typeof record.payload.toolCallId === "string" ? record.payload.toolCallId : "";
    const description =
      descriptionsByCall.get(callId) ??
      (() => {
        const details = asRecord(record.payload.details);
        return typeof details?.description === "string" ? details.description : "";
      })();
    spawns.set(record.seq, {
      _id: `cloud:${turnId}:tool-result:${record.seq}:agent-started`,
      timestamp: timestamp + 1,
      type: "agent-started",
      payload: {
        agentId: threadId,
        description,
        agentType: "general",
      },
    });
  }
  return { spawns, wake };
};

/**
 * Resolve the citations an assistant journal record carried against the
 * loaded journal window. The cloud journal has no `entry_ref` index, so this
 * is the client-side twin of the runtime's `resolveReplyRefs`: message
 * citations map to the record with that journal `seq`, agent citations keep
 * their thread id (the live title comes from thread activity), and a
 * lifecycle turn that cited nothing attaches to the agent named in its hidden
 * prompt. The message directly above the reply is never a reference.
 */
export const resolveJournalReplyRefs = (args: {
  raw: readonly RawReplyRef[];
  recordsBySeq: ReadonlyMap<number, JournalMessageRecord>;
  turnUserRecord: JournalMessageRecord | undefined;
  agentTitles?: ReadonlyMap<string, string>;
}): ReplyRef[] => {
  const refs: ReplyRef[] = [];
  const seen = new Set<string>();
  const push = (ref: ReplyRef) => {
    const key = ref.kind === "message" ? `m:${ref.id}` : `a:${ref.threadId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const ref of args.raw) {
    if (ref.kind === "agent") {
      push({
        kind: "agent",
        threadId: ref.threadId,
        title: args.agentTitles?.get(ref.threadId) ?? "",
      });
      continue;
    }
    const record = args.recordsBySeq.get(ref.sequence);
    if (!record || record.hidden) continue;
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (args.turnUserRecord && record.seq === args.turnUserRecord.seq) continue;
    const text = messageText(record.payload);
    push({
      kind: "message",
      sequence: ref.sequence,
      id:
        record.role === "user"
          ? userEventId(record)
          : `cloud:${record.turnId}:message:${record.seq}`,
      role: record.role,
      preview: toReplyPreview(
        record.role === "assistant" ? splitReplyRefs(text).text : text,
      ),
    });
  }
  if (refs.length === 0 && args.turnUserRecord?.hidden) {
    const wake = lifecycleWakeTask(messageText(args.turnUserRecord.payload));
    if (wake)
      push({
        kind: "agent",
        threadId: wake.threadId,
        title: args.agentTitles?.get(wake.threadId) ?? wake.description ?? "",
      });
  }
  return refs;
};

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
  replyRefs?: ReplyRef[],
): Record<string, unknown> => {
  const voiceSession = asRecord(record.payload.voiceSession);
  const metadata = {
    ...(record.hidden ? { ui: { visibility: "hidden" as const } } : {}),
    ...(voiceSession ? { voiceSession } : {}),
    ...(replyRefs && replyRefs.length > 0
      ? { runtime: { replyRefs } }
      : {}),
  };
  return {
    text,
    ...(record.role === "user" && typeof record.payload.originUserMessageId === "string"
      ? { originUserMessageId: record.payload.originUserMessageId } : {}),
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
  const recordsBySeq = new Map<number, JournalMessageRecord>();
  const agentTitles = new Map<string, string>();
  for (const record of records) {
    if (
      record.kind === "card" &&
      record.card.type === "agent-lifecycle" &&
      record.card.event.type === "agent-started"
    ) {
      const { agentId, description } = record.card.event.payload;
      if (description.trim()) agentTitles.set(agentId, description.trim());
    }
    if (record.kind === "message" && record.role === "user" && record.hidden) {
      const wake = lifecycleWakeTask(messageText(record.payload));
      if (wake?.description && !agentTitles.has(wake.threadId)) {
        agentTitles.set(wake.threadId, wake.description);
      }
    }
    if (record.kind === "message" && record.role === "toolResult") {
      const details = asRecord(record.payload.details);
      if (
        typeof details?.thread_id === "string" &&
        typeof details.description === "string" &&
        details.description.trim()
      ) {
        agentTitles.set(details.thread_id, details.description.trim());
      }
    }
    const turn = byTurn.get(record.turnId);
    if (turn) turn.push(record);
    else byTurn.set(record.turnId, [record]);
    if (record.kind === "message") recordsBySeq.set(record.seq, record);
  }

  const messages: MessageRecord[] = [];
  for (const [turnId, turnRecords] of byTurn) {
    const events: EventRecord[] = [];
    let userMessageId: string | undefined;
    let turnUserRecord: JournalMessageRecord | undefined;
    const mirrored = mirroredLifecycleEvents(turnId, turnRecords);

    for (const record of turnRecords) {
      const lifecycle = journalLifecycleEvent(record);
      if (lifecycle) {
        events.push(lifecycle);
        continue;
      }
      if (record.kind !== "message") continue;
      const timestamp = timestampOf(record.payload, record.createdAtMs);
      if (record.role === "user") {
        turnUserRecord = record;
        userMessageId =
          record.clientMsgId ?? `cloud:${turnId}:message:${record.seq}`;
        events.push({
          _id: userMessageId,
          timestamp,
          type: "user_message",
          payload: textPayload(record, messageText(record.payload)),
        });
        // The wake's completion precedes the reply that relays it, so the
        // grouping hands it to that reply.
        if (mirrored.wake) events.push(mirrored.wake);
        continue;
      }

      if (record.role === "assistant") {
        // The trailing `refs` fence is model-facing (it stays in the journal
        // so the model sees its own citations); the user sees chips instead.
        const { text, refs } = splitReplyRefs(messageText(record.payload));
        if (text) {
          events.push({
            _id: `cloud:${turnId}:message:${record.seq}`,
            timestamp,
            type: "assistant_message",
            payload: textPayload(
              record,
              text,
              userMessageId,
              resolveJournalReplyRefs({
                raw: refs,
                recordsBySeq,
                turnUserRecord,
                agentTitles,
              }),
            ),
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
          // Every tool result in the conversation journal is the
          // orchestrator's own (spawned agents keep their own transcripts),
          // which the turn-resource derivations key on to render, e.g., an
          // `image_gen` result inline rather than as a subagent's file.
          agentType: "orchestrator",
          result: details ?? resultText,
          resultPreview: resultText,
          ...(details ?? {}),
          ...(record.payload.isError === true
            ? { error: resultText || "Tool failed." }
            : {}),
        },
      });
      const spawn = mirrored.spawns.get(record.seq);
      if (spawn) events.push(spawn);
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
