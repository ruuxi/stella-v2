/**
 * The platform-neutral core of projecting the conversation journal into a
 * transcript. Desktop renders `MessageRecord`s and mobile renders
 * `ChatMessage`s, so each keeps its own projection; what a journal row *means*
 * — which wake prompt names which task, where a citation points, whether the
 * window's first turn is whole, which notice ends a failed turn — is decided
 * here once, so the same journal reads the same on every device.
 */

import {
  messageText,
  type JournalMessageRecord,
  type JournalRecord,
  type JournalTurnRecord,
} from "./conversation-protocol.js";
import {
  splitReplyRefs,
  toReplyPreview,
  type RawReplyRef,
  type ReplyRef,
} from "./reply-refs.js";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The payload's own clock when it carries one, else the commit time. */
export const journalMessageTimestamp = (
  record: JournalMessageRecord,
): number =>
  typeof record.payload.timestamp === "number" &&
  Number.isFinite(record.payload.timestamp)
    ? record.payload.timestamp
    : record.createdAtMs;

const WAKE_THREAD_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?(?:^thread_id:\s*(\S+)|\(thread ([^)]+)\))/mu;
const WAKE_DESCRIPTION_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?^description:\s*(.+)$/mu;

/**
 * The task named by a hidden lifecycle wake prompt (`[Agent completed]` and
 * friends): its thread id — from a `thread_id:` line or a `(thread …)`
 * mention — and, when the prompt carries one, its description. A locally
 * executed turn mirrored into the journal has no lifecycle card, so this
 * prompt is where the task's title comes from.
 */
export const lifecycleWakeTask = (
  text: string,
): { threadId: string; description?: string } | null => {
  const match = WAKE_THREAD_RE.exec(text);
  const threadId = (match?.[1] ?? match?.[2])?.trim();
  if (!threadId) return null;
  const description = WAKE_DESCRIPTION_RE.exec(text)?.[1]?.trim();
  return description ? { threadId, description } : { threadId };
};

const WAKE_KIND_RE =
  /^\[(Agent completed|Task failed|Task canceled|Subagent paused)\]/m;
const WAKE_TRAILER_RE = /^(?:agent_state|presentation|routing|error):/;

/**
 * The `result:` body of an `[Agent completed]` wake prompt (the lines after
 * `result:` up to the runtime's trailing instructions), or the `error:`
 * line of a failed / canceled one.
 */
export const lifecycleWakeOutcome = (
  text: string,
): { kind: "completed" | "failed" | "canceled"; body: string } | null => {
  const kind = WAKE_KIND_RE.exec(text)?.[1];
  if (!kind) return null;
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) =>
    kind === "Agent completed"
      ? line.startsWith("result:")
      : line.startsWith("error:"),
  );
  let body = "";
  if (startIndex !== -1) {
    const first = lines[startIndex]!.replace(/^(?:result|error):\s?/, "");
    const rest: string[] = [];
    for (const line of lines.slice(startIndex + 1)) {
      if (WAKE_TRAILER_RE.test(line)) break;
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

/**
 * Raw socket windows are record-count bounded and can therefore begin in the
 * middle of a turn. A leading turn whose prompt is still below the window has
 * no stable user owner for its replies, so it is not projected until its
 * prompt has been backfilled. A fragment holding only cards (a task's files or
 * lifecycle rows) has no reply to own and is kept, unless `dropCardOnly` asks
 * for the fragment to go too — mobile anchors a turn's file cards on that
 * turn's replies, so it has nowhere to put them.
 */
export const hasIncompleteLeadingJournalTurn = (
  records: readonly JournalRecord[],
  hasOlder: boolean,
  options: { dropCardOnly?: boolean } = {},
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
  if (options.dropCardOnly) return true;
  return leadingTurn.some(
    (record) =>
      (record.kind === "message" && record.role !== "user") ||
      record.kind === "turn",
  );
};

export const completeJournalWindowRecords = (
  records: readonly JournalRecord[],
  hasOlder: boolean,
  options: { dropCardOnly?: boolean } = {},
): JournalRecord[] => {
  if (!hasIncompleteLeadingJournalTurn(records, hasOlder, options)) {
    return [...records];
  }
  const incompleteTurnId = records[0]!.turnId;
  return records.filter((record) => record.turnId !== incompleteTurnId);
};

/**
 * A turn that ended any way but `completed` carries its user-facing notice on
 * the terminal `turn` record. That record, when its notice should render as
 * the turn's closing reply: not when the turn already wrote the same text as
 * a reply. Without it a failed turn shows only the user's bubble.
 */
export const journalTerminalNotice = (
  turnRecords: readonly JournalRecord[],
): (JournalTurnRecord & { notice: string }) | null => {
  let terminal: JournalTurnRecord | undefined;
  for (const record of turnRecords) {
    if (record.kind === "turn" && record.phase !== "started") terminal = record;
  }
  if (!terminal || terminal.phase === "completed" || !terminal.notice) {
    return null;
  }
  const notice = terminal.notice;
  const alreadyReplied = turnRecords.some(
    (record) =>
      record.kind === "message" &&
      record.role === "assistant" &&
      messageText(record.payload) === notice,
  );
  return alreadyReplied ? null : { ...terminal, notice };
};

/**
 * Resolve the citations an assistant journal record carried against the
 * loaded journal window. The cloud journal has no `entry_ref` index, so this
 * is the client-side twin of the runtime's `resolveReplyRefs`: message
 * citations map to the record with that journal `seq` (under the id the
 * platform renders it with), agent citations keep their thread id (the live
 * title comes from thread activity), and a lifecycle turn that cited nothing
 * attaches to the agent named in its hidden prompt. The message directly
 * above the reply is never a reference.
 */
export const resolveJournalReplyRefs = (args: {
  raw: readonly RawReplyRef[];
  recordsBySeq: ReadonlyMap<number, JournalRecord>;
  turnUserRecord: JournalMessageRecord | undefined;
  agentTitles?: ReadonlyMap<string, string>;
  /** The id the platform's projection renders a message record under. */
  messageId: (record: JournalMessageRecord) => string;
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
    if (!record || record.kind !== "message" || record.hidden) continue;
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (args.turnUserRecord && record.seq === args.turnUserRecord.seq) continue;
    const text = messageText(record.payload);
    push({
      kind: "message",
      sequence: ref.sequence,
      id: args.messageId(record),
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

/**
 * The refs a desktop-executed turn persisted on its assistant payload
 * (`metadata.runtime.replyRefs`). Such a turn carries resolved refs instead of
 * a model fence.
 */
export const storedJournalReplyRefs = (
  payload: Record<string, unknown>,
): ReplyRef[] => {
  const runtime = asRecord(asRecord(payload.metadata)?.runtime);
  if (!runtime || !Array.isArray(runtime.replyRefs)) return [];
  return runtime.replyRefs.flatMap((entry: unknown): ReplyRef[] => {
    const ref = asRecord(entry);
    if (!ref) return [];
    if (ref.kind === "agent" && typeof ref.threadId === "string") {
      return [
        {
          kind: "agent",
          threadId: ref.threadId,
          title: typeof ref.title === "string" ? ref.title : "",
        },
      ];
    }
    if (
      ref.kind === "message" &&
      typeof ref.id === "string" &&
      typeof ref.sequence === "number" &&
      (ref.role === "user" || ref.role === "assistant")
    ) {
      return [
        {
          kind: "message",
          id: ref.id,
          sequence: ref.sequence,
          role: ref.role,
          preview: typeof ref.preview === "string" ? ref.preview : "",
        },
      ];
    }
    return [];
  });
};
