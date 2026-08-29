/**
 * The per-turn write-ahead journal for a resident general-agent turn.
 *
 * Convex remains the authoritative transcript. This is a recovery buffer for
 * one exact turn attempt: `Agent` produces a message, the subscriber appends
 * it here synchronously, and only a sealed journal is posted to Convex. A DO
 * eviction at minute four of a five-minute turn therefore loses at most the
 * message still streaming, instead of losing the assistant tool call that is
 * the only record of why the workspace changed.
 *
 * Appends are synchronous because they have to be. `Agent.subscribe` is a
 * fire-and-forget sink that drops a returned promise, so an `await` inside the
 * handler silently loses rows. SQLite in a Durable Object is synchronous,
 * which makes that constraint free.
 */

import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import type { ToolCall } from "@stella/runtime/ai/types.js";
import {
  AGENT_HISTORY_MAX_BYTES,
  AGENT_HISTORY_MAX_ROWS,
  AGENT_HISTORY_ROW_MAX_BYTES,
} from "@stella/executor-cloud/agent-history";
import { sha256Hex } from "./hash.js";

export type TranscriptRole = "user" | "assistant" | "toolResult";

export type StagedTurnRow = Readonly<{
  ordinal: number;
  role: TranscriptRole;
  payloadJson: string;
}>;

export type JournaledToolCall = Readonly<{
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
}>;

export type SealedTurnTranscript = Readonly<{
  turnId: string;
  attemptGeneration: number;
  historyCursor: string;
  rows: readonly StagedTurnRow[];
}>;

export type AgentTurnJournalIdentity = Readonly<{
  turnId: string;
  attemptGeneration: number;
}>;

/**
 * The row a physical turn gets when it mutated the workspace but no engine
 * produced a transcript row. Kept identical to what the container executor
 * writes today so a resident turn and a container turn advance the thread's
 * history cursor the same way.
 */
export type SyntheticTerminalRow = Readonly<{
  prompt: string;
  provider: string;
  model: string;
  finalText: string;
  error?: string;
  timestamp: number;
}>;

const DDL = [
  `CREATE TABLE IF NOT EXISTS agent_turn_journal (
     turn_id            TEXT    NOT NULL,
     attempt_generation INTEGER NOT NULL,
     ordinal            INTEGER NOT NULL,
     role               TEXT    NOT NULL,
     payload_json       TEXT    NOT NULL,
     bytes              INTEGER NOT NULL,
     PRIMARY KEY (turn_id, attempt_generation, ordinal)
   )`,
  `CREATE TABLE IF NOT EXISTS agent_turn_journal_meta (
     turn_id            TEXT    NOT NULL,
     attempt_generation INTEGER NOT NULL,
     opened_at          INTEGER NOT NULL,
     sealed             INTEGER NOT NULL DEFAULT 0,
     row_count          INTEGER NOT NULL DEFAULT 0,
     history_cursor     TEXT    NOT NULL DEFAULT '',
     PRIMARY KEY (turn_id, attempt_generation)
   )`,
] as const;

type JournalRow = {
  ordinal: number;
  role: string;
  payload_json: string;
  bytes: number;
};

type MetaRow = {
  sealed: number;
  row_count: number;
  history_cursor: string;
};

/**
 * What a call that never came back tells the model. Not `terminalMessage`: the
 * result explains one call, the terminal row explains the turn.
 */
export const INTERRUPTED_TOOL_RESULT_TEXT =
  "This tool call was interrupted before it reported a result. Its effect is unknown; verify before assuming it ran.";

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const roleOf = (message: AgentMessage): TranscriptRole | null => {
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult"
    ? role
    : null;
};

/**
 * One assistant row with empty content poisons every future Anthropic request
 * for this thread, so an errored placeholder never reaches the journal. This
 * is the container executor's filter, kept exact.
 */
const isEmptyAssistantMessage = (message: AgentMessage): boolean => {
  const record = message as { role?: unknown; content?: unknown };
  return (
    record.role === "assistant" &&
    Array.isArray(record.content) &&
    record.content.length === 0
  );
};

const toolCallsOf = (message: AgentMessage): readonly ToolCall[] => {
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant" || !Array.isArray(record.content)) return [];
  return record.content.filter(
    (block): block is ToolCall =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "toolCall",
  );
};

const journaledToolCall = (call: ToolCall): JournaledToolCall => {
  if (
    typeof call.id !== "string" ||
    !call.id.trim() ||
    call.id.length > 256 ||
    typeof call.name !== "string" ||
    !call.name.trim() ||
    call.name.length > 256 ||
    !call.arguments ||
    typeof call.arguments !== "object" ||
    Array.isArray(call.arguments)
  ) {
    throw new Error("Journaled tool call is malformed.");
  }
  return {
    toolCallId: call.id,
    toolName: call.name,
    params: call.arguments as Record<string, unknown>,
  };
};

const historyCursor = async (row: {
  turnId: string;
  role: string;
  payloadJson: string;
}): Promise<string> =>
  `v1:${await sha256Hex(
    JSON.stringify({
      turnId: row.turnId,
      role: row.role,
      payloadJson: row.payloadJson,
    }),
  )}`;

export class AgentTurnJournal {
  private nextOrdinal: number;
  private totalBytes: number;

  private constructor(
    private readonly sql: SqlStorage,
    private readonly identity: AgentTurnJournalIdentity,
    private readonly terminal: SyntheticTerminalRow,
    seed: { nextOrdinal: number; totalBytes: number },
  ) {
    this.nextOrdinal = seed.nextOrdinal;
    this.totalBytes = seed.totalBytes;
  }

  /**
   * Idempotent by construction. A recovering alarm calls `open` with the same
   * identity and gets the existing rows back rather than a second attempt's
   * empty journal, which is what makes tail repair possible at all.
   *
   * A normal prompt is journaled from the Agent's own `message_end` event. A
   * browser resume is already in the initial history and emits no event, so
   * `open` writes that one row itself, once.
   */
  static open(args: {
    sql: SqlStorage;
    identity: AgentTurnJournalIdentity;
    terminal: SyntheticTerminalRow;
    start?: Readonly<{ kind: "browser_resume"; message: AgentMessage }>;
    now: number;
  }): AgentTurnJournal {
    for (const statement of DDL) args.sql.exec(statement);
    args.sql.exec(
      `INSERT OR IGNORE INTO agent_turn_journal_meta
         (turn_id, attempt_generation, opened_at) VALUES (?, ?, ?)`,
      args.identity.turnId,
      args.identity.attemptGeneration,
      args.now,
    );
    const summary = args.sql
      .exec<{ next_ordinal: number | null; total_bytes: number | null }>(
        `SELECT MAX(ordinal) + 1 AS next_ordinal, SUM(bytes) AS total_bytes
           FROM agent_turn_journal
          WHERE turn_id = ? AND attempt_generation = ?`,
        args.identity.turnId,
        args.identity.attemptGeneration,
      )
      .one();
    const journal = new AgentTurnJournal(
      args.sql,
      args.identity,
      args.terminal,
      {
        nextOrdinal: summary.next_ordinal ?? 0,
        totalBytes: summary.total_bytes ?? 0,
      },
    );
    if (args.start && journal.nextOrdinal === 0) {
      journal.append(args.start.message);
    }
    return journal;
  }

  get sealed(): boolean {
    return this.meta().sealed === 1;
  }

  get rowCount(): number {
    return this.nextOrdinal;
  }

  private meta(): MetaRow {
    return this.sql
      .exec<MetaRow>(
        `SELECT sealed, row_count, history_cursor FROM agent_turn_journal_meta
          WHERE turn_id = ? AND attempt_generation = ?`,
        this.identity.turnId,
        this.identity.attemptGeneration,
      )
      .one();
  }

  rows(): readonly StagedTurnRow[] {
    return this.sql
      .exec<JournalRow>(
        `SELECT ordinal, role, payload_json, bytes FROM agent_turn_journal
          WHERE turn_id = ? AND attempt_generation = ?
          ORDER BY ordinal ASC`,
        this.identity.turnId,
        this.identity.attemptGeneration,
      )
      .toArray()
      .map((row) => ({
        ordinal: row.ordinal,
        role: row.role as TranscriptRole,
        payloadJson: row.payload_json,
      }));
  }

  /**
   * Bounds are the ones the history parser enforces on the way back in. A row
   * or a turn that would exceed them fails the turn here rather than being
   * silently truncated: the model's in-memory context would otherwise diverge
   * from what the next turn reads back.
   */
  append(message: AgentMessage): void {
    if (this.sealed) throw new Error("Agent turn journal is already sealed.");
    const role = roleOf(message);
    if (!role || isEmptyAssistantMessage(message)) return;
    const payloadJson = JSON.stringify(message);
    const bytes = utf8Bytes(payloadJson);
    if (bytes > AGENT_HISTORY_ROW_MAX_BYTES) {
      throw new Error("Agent turn journal row exceeds its byte bound.");
    }
    if (this.totalBytes + bytes > AGENT_HISTORY_MAX_BYTES) {
      throw new Error("Agent turn journal exceeds its byte bound.");
    }
    if (this.nextOrdinal + 1 > AGENT_HISTORY_MAX_ROWS) {
      throw new Error("Agent turn journal exceeds its row bound.");
    }
    this.sql.exec(
      `INSERT INTO agent_turn_journal
         (turn_id, attempt_generation, ordinal, role, payload_json, bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      this.identity.turnId,
      this.identity.attemptGeneration,
      this.nextOrdinal,
      role,
      payloadJson,
      bytes,
    );
    this.nextOrdinal += 1;
    this.totalBytes += bytes;
  }

  /** Tool calls in the trailing assistant row that no toolResult row answered. */
  openToolCalls(): readonly JournaledToolCall[] {
    const rows = this.rows();
    const lastAssistant = [...rows]
      .reverse()
      .find((row) => row.role === "assistant");
    if (!lastAssistant) return [];
    const calls = toolCallsOf(
      JSON.parse(lastAssistant.payloadJson) as AgentMessage,
    ).map(journaledToolCall);
    const answered = new Set(
      rows
        .filter(
          (row) => row.role === "toolResult" && row.ordinal > lastAssistant.ordinal,
        )
        .map(
          (row) =>
            (JSON.parse(row.payloadJson) as { toolCallId?: unknown })
              .toolCallId,
        )
        .filter((id): id is string => typeof id === "string"),
    );
    return calls.filter((call) => !answered.has(call.toolCallId));
  }

  /**
   * Sealing is the commit point for this attempt's bytes. It is idempotent so
   * a retried finalization posts the same batch rather than recomputing a
   * cursor against rows a partial failure may have changed.
   */
  async seal(args: {
    suspended: boolean;
  }): Promise<SealedTurnTranscript> {
    const meta = this.meta();
    if (meta.sealed === 1) {
      return {
        turnId: this.identity.turnId,
        attemptGeneration: this.identity.attemptGeneration,
        historyCursor: meta.history_cursor,
        rows: this.rows(),
      };
    }
    if (!args.suspended && this.openToolCalls().length > 0) {
      throw new Error(
        "Agent turn journal has unanswered tool calls and did not suspend.",
      );
    }
    if (this.rowCount === 0) this.appendSyntheticTerminal();
    return await this.commit();
  }

  /**
   * Recovery after isolate loss. Every call in the interrupted tail is either
   * resolved from a receipt the executing side can still prove, or answered
   * with an interrupted error so the transcript explains itself. A call whose
   * effect cannot be proven is never replayed.
   */
  async repairInterruptedTail(args: {
    resolveInterruptedCall: (
      call: JournaledToolCall,
    ) => Promise<AgentMessage | "interrupted">;
    terminalMessage: string;
  }): Promise<SealedTurnTranscript> {
    const meta = this.meta();
    if (meta.sealed === 1) {
      return {
        turnId: this.identity.turnId,
        attemptGeneration: this.identity.attemptGeneration,
        historyCursor: meta.history_cursor,
        rows: this.rows(),
      };
    }
    for (const call of this.openToolCalls()) {
      const resolved = await args.resolveInterruptedCall(call);
      this.append(
        resolved === "interrupted"
          ? {
              role: "toolResult",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
              isError: true,
              timestamp: this.terminal.timestamp,
            }
          : resolved,
      );
    }
    // A repaired tail ends on a tool result, which would leave the next turn's
    // rebuilt history putting a user message straight after one. The terminal
    // row is what closes the group and tells the user what happened.
    this.appendSyntheticTerminal(args.terminalMessage);
    return await this.commit();
  }

  clearAfterCanonicalCommit(): void {
    this.sql.exec(
      `DELETE FROM agent_turn_journal
        WHERE turn_id = ? AND attempt_generation = ?`,
      this.identity.turnId,
      this.identity.attemptGeneration,
    );
    this.sql.exec(
      `DELETE FROM agent_turn_journal_meta
        WHERE turn_id = ? AND attempt_generation = ?`,
      this.identity.turnId,
      this.identity.attemptGeneration,
    );
    this.nextOrdinal = 0;
    this.totalBytes = 0;
  }

  private appendSyntheticTerminal(text?: string): void {
    if (this.nextOrdinal === 0) {
      this.append({
        role: "user",
        content: [{ type: "text", text: this.terminal.prompt }],
        timestamp: this.terminal.timestamp,
      });
    }
    this.append({
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            text ||
            this.terminal.finalText ||
            this.terminal.error ||
            "The agent finished without a report.",
        },
      ],
      api: "stella-cloud",
      provider: this.terminal.provider,
      model: this.terminal.model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: this.terminal.error ? "error" : "stop",
      ...(this.terminal.error ? { errorMessage: this.terminal.error } : {}),
      timestamp: this.terminal.timestamp,
    } as AgentMessage);
  }

  private async commit(): Promise<SealedTurnTranscript> {
    const rows = this.rows();
    const last = rows.at(-1);
    if (!last) {
      throw new Error("Agent turn journal sealed without a canonical row.");
    }
    const cursor = await historyCursor({
      turnId: this.identity.turnId,
      role: last.role,
      payloadJson: last.payloadJson,
    });
    this.sql.exec(
      `UPDATE agent_turn_journal_meta
          SET sealed = 1, row_count = ?, history_cursor = ?
        WHERE turn_id = ? AND attempt_generation = ?`,
      rows.length,
      cursor,
      this.identity.turnId,
      this.identity.attemptGeneration,
    );
    return {
      turnId: this.identity.turnId,
      attemptGeneration: this.identity.attemptGeneration,
      historyCursor: cursor,
      rows,
    };
  }
}
