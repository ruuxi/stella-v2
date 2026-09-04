import type {
  CloudAgentSteerKind,
  CloudAgentSteerMessage,
} from "@stella/contracts/turn-plane/turn-start";

export type SteerMessageKind = CloudAgentSteerKind;
export type SteerMessage = Readonly<CloudAgentSteerMessage>;

type SteerRow = {
  id: string;
  kind: string;
  text: string;
  child_thread_id: string | null;
  child_attempt_generation: number | null;
  created_at: number;
};

const STEER_KINDS: readonly SteerMessageKind[] = [
  "input",
  "child_completed",
  "child_canceled",
  "child_failed",
];

const MAX_STEER_ID_CHARS = 256;
const MAX_STEER_TEXT_CHARS = 8_000;
const MAX_STEER_ROWS = 128;
const MAX_STEER_BYTES = 2 * 1024 * 1024;

const DDL = `CREATE TABLE IF NOT EXISTS agent_steer_mailbox (
  id                       TEXT    PRIMARY KEY,
  target_turn_id           TEXT    NOT NULL,
  target_attempt_generation INTEGER NOT NULL,
  kind                     TEXT    NOT NULL,
  text                     TEXT    NOT NULL,
  child_thread_id          TEXT,
  child_attempt_generation INTEGER,
  created_at               INTEGER NOT NULL,
  bytes                    INTEGER NOT NULL
)`;

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const parseSteerMessage = (value: unknown): SteerMessage | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const text = typeof row.text === "string" ? row.text.trim() : "";
  if (
    !id ||
    id.length > MAX_STEER_ID_CHARS ||
    !text ||
    text.length > MAX_STEER_TEXT_CHARS ||
    !STEER_KINDS.includes(row.kind as SteerMessageKind) ||
    !Number.isSafeInteger(row.createdAt) ||
    (row.createdAt as number) < 0
  ) {
    return null;
  }
  const threadId = typeof row.threadId === "string" ? row.threadId.trim() : "";
  if (
    row.threadId !== undefined &&
    (!threadId || threadId.length > MAX_STEER_ID_CHARS)
  ) {
    return null;
  }
  const attemptGeneration = row.attemptGeneration;
  if (
    attemptGeneration !== undefined &&
    (!Number.isSafeInteger(attemptGeneration) ||
      (attemptGeneration as number) < 1)
  ) {
    return null;
  }
  const childTerminal = row.kind !== "input";
  if (
    childTerminal !== (threadId.length > 0 && attemptGeneration !== undefined)
  ) {
    return null;
  }
  return {
    id,
    kind: row.kind as SteerMessageKind,
    text,
    ...(threadId ? { threadId } : {}),
    ...(attemptGeneration !== undefined
      ? { attemptGeneration: attemptGeneration as number }
      : {}),
    createdAt: row.createdAt as number,
  };
};

export class SteerMailbox {
  private constructor(private readonly sql: SqlStorage) {}

  static open(sql: SqlStorage): SteerMailbox {
    sql.exec(DDL);
    return new SteerMailbox(sql);
  }

  append(
    target: Readonly<{ turnId: string; attemptGeneration: number }>,
    message: SteerMessage,
  ): "appended" | "replayed" | "conflict" | "full" {
    const existing = this.sql
      .exec<
        SteerRow & {
          target_turn_id: string;
          target_attempt_generation: number;
        }
      >(
        `SELECT id, target_turn_id, target_attempt_generation, kind, text,
                child_thread_id, child_attempt_generation, created_at
           FROM agent_steer_mailbox WHERE id = ?`,
        message.id,
      )
      .toArray()[0];
    if (existing) {
      const same =
        existing.target_turn_id === target.turnId &&
        existing.target_attempt_generation === target.attemptGeneration &&
        existing.kind === message.kind &&
        existing.text === message.text &&
        (existing.child_thread_id ?? undefined) === message.threadId &&
        (existing.child_attempt_generation ?? undefined) ===
          message.attemptGeneration &&
        existing.created_at === message.createdAt;
      return same ? "replayed" : "conflict";
    }
    const size = utf8Bytes(JSON.stringify(message));
    const summary = this.sql
      .exec<{ row_count: number; total_bytes: number }>(
        `SELECT COUNT(*) AS row_count, COALESCE(SUM(bytes), 0) AS total_bytes
           FROM agent_steer_mailbox`,
      )
      .one();
    if (
      summary.row_count >= MAX_STEER_ROWS ||
      summary.total_bytes + size > MAX_STEER_BYTES
    ) {
      return "full";
    }
    this.sql.exec(
      `INSERT INTO agent_steer_mailbox
         (id, target_turn_id, target_attempt_generation, kind, text,
          child_thread_id, child_attempt_generation, created_at, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id,
      target.turnId,
      target.attemptGeneration,
      message.kind,
      message.text,
      message.threadId ?? null,
      message.attemptGeneration ?? null,
      message.createdAt,
      size,
    );
    return "appended";
  }

  drain(
    target: Readonly<{ turnId: string; attemptGeneration: number }>,
  ): SteerMessage[] {
    return this.sql
      .exec<SteerRow>(
        `SELECT id, kind, text, child_thread_id, child_attempt_generation,
                created_at
           FROM agent_steer_mailbox
          WHERE target_turn_id = ? AND target_attempt_generation = ?
          ORDER BY created_at ASC, id ASC`,
        target.turnId,
        target.attemptGeneration,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        kind: row.kind as SteerMessageKind,
        text: row.text,
        ...(row.child_thread_id ? { threadId: row.child_thread_id } : {}),
        ...(row.child_attempt_generation !== null
          ? { attemptGeneration: row.child_attempt_generation }
          : {}),
        createdAt: row.created_at,
      }));
  }

  acknowledge(
    target: Readonly<{ turnId: string; attemptGeneration: number }>,
    ids: readonly string[],
  ): void {
    for (const id of ids) {
      this.sql.exec(
        `DELETE FROM agent_steer_mailbox
          WHERE id = ? AND target_turn_id = ? AND target_attempt_generation = ?`,
        id,
        target.turnId,
        target.attemptGeneration,
      );
    }
  }
}
