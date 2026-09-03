/**
 * The conversation's transcript, in the conversation's own Durable Object.
 *
 * One ordered journal — messages, turn lifecycle records and UI cards share a
 * single gapless `seq` — is what makes the client's gap detection total: a
 * hole in the counter is the only signal a reader needs, and everything below
 * the resident window is named explicitly by the segment manifest. Two
 * separately numbered streams would need two cursors and could not express
 * "these interleaved this way".
 *
 * Three invariants carry the whole design, and each is asserted at its site
 * below:
 *
 *  1. `seq` comes only from `meta.next_seq`, allocated and inserted inside one
 *     `transactionSync`. Never `MAX(seq)+1` — rollover deletes old rows, so
 *     `MAX` goes backwards and would hand out a seq that already shipped.
 *  2. `writer_key` is UNIQUE and every append is INSERT OR IGNORE + read-back.
 *     Retry is therefore free and unbounded, which is what lets the callers
 *     drop their hand-rolled two-attempt hedges.
 *  3. The async KV keys (`turn`, `terminal`, `terminalDelivered`, `queued:*`,
 *     `alarmAttempts`) stay authoritative for the turn lifecycle. The `turns`
 *     table here is a queryable projection and is never read to decide whether
 *     to emit a terminal event.
 */

import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { formatMessageRefTag } from "@stella/contracts/reply-refs";
import { estimateTokens } from "@stella/executor-cloud/prune-history";
import {
  CONTEXT_SCAN_ROW_CAP,
  INITIAL_WINDOW_RECORDS,
  JOURNAL_SCHEMA_VERSION,
  REPAIR_SCAN_ROW_CAP,
  isSpillStub,
  utf8Length,
  type SpillStub,
  type ConversationCard,
  type ConversationLogger,
  type ConversationOwnerRecord,
  type JournalHead,
  type JournalRecord,
  type MessageRole,
  type TurnPhase,
} from "./conversation-types.js";
import {
  TranscriptSearchIndex,
  collapseWhitespace,
  extractMessageText,
  transcriptSearchDdl,
  type TranscriptSearchHit,
} from "./transcript-search.js";

export { collapseWhitespace, extractMessageText } from "./transcript-search.js";

const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
     id               INTEGER PRIMARY KEY CHECK (id = 0),
     schema_version   INTEGER NOT NULL,
     epoch            INTEGER NOT NULL DEFAULT 1,
     owner_id         TEXT    NOT NULL DEFAULT '',
     conversation_id  TEXT    NOT NULL DEFAULT '',
     created_at       INTEGER NOT NULL DEFAULT 0,
     title            TEXT    NOT NULL DEFAULT '',
     next_seq         INTEGER NOT NULL DEFAULT 0,
     hot_min_seq      INTEGER NOT NULL DEFAULT 0,
     index_synced_seq INTEGER NOT NULL DEFAULT -1,
     deleted_at       INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS journal (
     seq           INTEGER PRIMARY KEY,
     kind          TEXT    NOT NULL,
     turn_id       TEXT    NOT NULL,
     writer        TEXT    NOT NULL,
     writer_key    TEXT    NOT NULL,
     created_at    INTEGER NOT NULL,
     bytes         INTEGER NOT NULL,
     role          TEXT,
     hidden        INTEGER NOT NULL DEFAULT 0,
     model_skip    INTEGER NOT NULL DEFAULT 0,
     tool_call_id  TEXT,
     open_calls    INTEGER NOT NULL DEFAULT 0,
     tokens        INTEGER NOT NULL DEFAULT 0,
     stream_id     TEXT,
     client_msg_id TEXT,
     phase         TEXT,
     lane          TEXT,
     source        TEXT,
     notice        TEXT,
     payload_json  TEXT    NOT NULL,
     spill_key     TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS journal_writer_key ON journal(writer_key)`,
  `CREATE INDEX IF NOT EXISTS journal_turn ON journal(turn_id, seq)`,
  `CREATE INDEX IF NOT EXISTS journal_context ON journal(kind, model_skip, seq)`,
  transcriptSearchDdl(),
  `CREATE TABLE IF NOT EXISTS turns (
     turn_id       TEXT PRIMARY KEY,
     session_id    TEXT NOT NULL,
     owner_id      TEXT NOT NULL,
     lane          TEXT,
     source        TEXT,
     client_msg_id TEXT,
     state         TEXT NOT NULL,
     terminal_kind TEXT,
     ctx_start_seq INTEGER,
     ctx_end_seq   INTEGER,
     first_seq     INTEGER,
     last_seq      INTEGER,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS turns_state ON turns(state, created_at)`,
  `CREATE TABLE IF NOT EXISTS inbox (
     id           INTEGER PRIMARY KEY,
     writer       TEXT NOT NULL,
     writer_key   TEXT NOT NULL UNIQUE,
     kind         TEXT NOT NULL,
     turn_id      TEXT NOT NULL DEFAULT '',
     role         TEXT,
     tool_call_id TEXT,
     open_calls   INTEGER NOT NULL DEFAULT 0,
     hidden       INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL,
     bytes        INTEGER NOT NULL,
     payload_json TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS segments (
     first_seq  INTEGER PRIMARY KEY,
     last_seq   INTEGER NOT NULL,
     rows       INTEGER NOT NULL,
     bytes      INTEGER NOT NULL,
     r2_key     TEXT    NOT NULL,
     state      TEXT    NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS purge_queue (
     r2_key    TEXT PRIMARY KEY,
     queued_at INTEGER NOT NULL,
     attempts  INTEGER NOT NULL DEFAULT 0
   )`,
  // The durable record of every spill object this conversation has ever
  // written. It cannot live on the journal row that references it: rollover
  // DELETEs archived rows, and the row's `spill_key` is then reachable only
  // from inside a compressed segment that the purge never reads. Rows here
  // outlive both the journal row and the segment, so a per-conversation delete
  // can still name every object it owns.
  //
  // `bytes` is the payload's real size, not the ~60-byte stub the journal row
  // keeps. Without it the storage ceiling measured everything EXCEPT the bytes
  // that actually leave the object, and an authenticated writer could push
  // unbounded payloads into R2 through a journal whose measured size never
  // moved.
  `CREATE TABLE IF NOT EXISTS spills (
     r2_key     TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     bytes      INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS owner_transfer_objects (
     old_key    TEXT PRIMARY KEY,
     new_key    TEXT NOT NULL,
     kind       TEXT NOT NULL CHECK (kind IN ('segment', 'spill')),
     state      TEXT NOT NULL CHECK (state IN ('copying', 'cleanup'))
   )`,
  // Fixed-window append budget. In SQLite rather than in memory because an
  // eviction between two requests must not hand out a fresh allowance.
  `CREATE TABLE IF NOT EXISTS append_window (
     id         INTEGER PRIMARY KEY CHECK (id = 0),
     started_at INTEGER NOT NULL DEFAULT 0,
     requests   INTEGER NOT NULL DEFAULT 0,
     bytes      INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS append_receipts (
     writer_key  TEXT PRIMARY KEY,
     fingerprint TEXT NOT NULL,
     first_seq   INTEGER NOT NULL,
     last_seq    INTEGER NOT NULL,
     epoch       INTEGER NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS retired_writers (
     writer_key TEXT PRIMARY KEY,
     epoch      INTEGER NOT NULL,
     retired_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS retired_turns (
     turn_id    TEXT PRIMARY KEY,
     epoch      INTEGER NOT NULL,
     retired_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS conversation_edit_receipts (
     operation_id TEXT PRIMARY KEY,
     kind         TEXT NOT NULL,
     result_json  TEXT NOT NULL,
     created_at   INTEGER NOT NULL
   )`,
  // A single fixed-shape, dev-acceptance-only context fault. The caller never
  // supplies SQL or replacement content: the original resident row and the
  // fixed malformed sentinel move together in one SQLite transaction, and a
  // bounded observation count restores the exact bytes automatically.
  `CREATE TABLE IF NOT EXISTS acceptance_context_fault (
     id                      INTEGER PRIMARY KEY CHECK (id = 0),
     run_id_sha256           TEXT    NOT NULL,
     seq                     INTEGER NOT NULL,
     original_payload_json   TEXT    NOT NULL,
     original_payload_sha256 TEXT    NOT NULL,
     corrupt_payload_sha256  TEXT    NOT NULL,
     observed_failures       INTEGER NOT NULL DEFAULT 0,
     repair_after_failures   INTEGER NOT NULL,
     created_at              INTEGER NOT NULL
   )`,
];

/**
 * What an existing database needs in order to reach the current
 * JOURNAL_SCHEMA_VERSION, keyed by the version it arrives at. `CREATE TABLE IF
 * NOT EXISTS` covers a brand-new object and does nothing for an old one, so a
 * column added to an existing table has to arrive here — and `ADD COLUMN` is an
 * error rather than a no-op the second time, which is why the stamped version,
 * not the statement, decides whether it runs.
 */
const MIGRATIONS: Array<{
  to: number;
  statements: string[];
  backfillTranscriptSearch?: boolean;
}> = [
  {
    to: 2,
    statements: [
      `ALTER TABLE spills ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    to: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS owner_transfer_objects (
         old_key TEXT PRIMARY KEY,
         new_key TEXT NOT NULL,
         kind TEXT NOT NULL CHECK (kind IN ('segment', 'spill')),
         state TEXT NOT NULL CHECK (state IN ('copying', 'cleanup'))
      )`,
    ],
  },
  {
    to: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS append_receipts (
         writer_key TEXT PRIMARY KEY,
         fingerprint TEXT NOT NULL,
         first_seq INTEGER NOT NULL,
         last_seq INTEGER NOT NULL,
         epoch INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    to: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS retired_writers (
         writer_key TEXT PRIMARY KEY,
         epoch INTEGER NOT NULL,
         retired_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    to: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS conversation_edit_receipts (
         operation_id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         result_json TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    to: 7,
    statements: [
      `CREATE TABLE IF NOT EXISTS retired_turns (
         turn_id TEXT PRIMARY KEY,
         epoch INTEGER NOT NULL,
         retired_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    to: 8,
    statements: [
      transcriptSearchDdl(),
      `DROP INDEX IF EXISTS turn_excerpts_unsynced`,
      `DROP TABLE IF EXISTS turn_excerpts`,
    ],
    backfillTranscriptSearch: true,
  },
];

/** Durable witness of the highest epoch this DO name has ever used. */
const EPOCH_WITNESS_KEY = "conversationEpoch";

export type MetaRow = {
  schema_version: number;
  epoch: number;
  owner_id: string;
  conversation_id: string;
  created_at: number;
  title: string;
  next_seq: number;
  hot_min_seq: number;
  index_synced_seq: number;
  deleted_at: number | null;
};

export type JournalRow = {
  seq: number;
  kind: string;
  turn_id: string;
  writer: string;
  writer_key: string;
  created_at: number;
  bytes: number;
  role: string | null;
  hidden: number;
  model_skip: number;
  tool_call_id: string | null;
  open_calls: number;
  tokens: number;
  stream_id: string | null;
  client_msg_id: string | null;
  phase: string | null;
  lane: string | null;
  source: string | null;
  notice: string | null;
  payload_json: string;
  spill_key: string | null;
};

export type AppendResult = {
  seq: number;
  /** False when `writer_key` already existed — the caller's retry was a no-op. */
  inserted: boolean;
  record: JournalRecord;
};

export type AppendReceipt = {
  writer_key: string;
  fingerprint: string;
  first_seq: number;
  last_seq: number;
  epoch: number;
  created_at: number;
};

export type AppendMessageInput = {
  turnId: string;
  writer: string;
  writerKey: string;
  role: MessageRole;
  message: AgentMessage;
  hidden?: boolean;
  modelSkip?: boolean;
  streamId?: string;
  clientMsgId?: string;
  createdAt?: number;
  /** Pre-serialized payload, when the caller already paid for the stringify. */
  payloadJson?: string;
  spillKey?: string;
};

export type AppendTurnInput = {
  turnId: string;
  writer: string;
  writerKey: string;
  phase: TurnPhase;
  lane?: string;
  source?: string;
  notice?: string;
  promptSeq?: number;
  wallClockMs?: number;
  createdAt?: number;
};

export type AppendCardInput = {
  turnId: string;
  writer: string;
  writerKey: string;
  card: ConversationCard;
  createdAt?: number;
};

export type InboxRow = {
  id: number;
  writer: string;
  writer_key: string;
  kind: string;
  turn_id: string;
  role: string | null;
  hidden: number;
  created_at: number;
  bytes: number;
  payload_json: string;
};

export type SegmentRow = {
  first_seq: number;
  last_seq: number;
  rows: number;
  bytes: number;
  r2_key: string;
  state: string;
  created_at: number;
};

export type OwnerTransferObjectRow = {
  old_key: string;
  new_key: string;
  kind: "segment" | "spill";
  state: "copying" | "cleanup";
};

/**
 * Stamp each visible user message with its journal sequence number so the
 * model can cite it (`reply-refs`: a reply ends with `#<seq>` lines that the
 * clients resolve against the same journal). Applied after spill hydration
 * so a hydrated payload keeps its tag; hidden rows (lifecycle prompts) carry
 * their thread id instead and are left alone. The journal itself stays raw:
 * the tag exists only in model context.
 */
export const stampUserMessageSequences = (
  messages: AgentMessage[],
  rows: WindowSelection["rows"],
): AgentMessage[] =>
  messages.map((message, index) => {
    const row = rows[index];
    if (!row || row.role !== "user" || row.hidden) return message;
    if (message.role !== "user" || !Array.isArray(message.content)) {
      return message;
    }
    const tag = formatMessageRefTag(row.seq);
    const content = message.content.slice();
    let stamped = false;
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex] as { type?: string; text?: string };
      if (block?.type === "text" && typeof block.text === "string") {
        content[blockIndex] = {
          ...block,
          text: `${block.text.replace(/\s+$/u, "")}\n\n${tag}`,
        } as (typeof content)[number];
        stamped = true;
        break;
      }
    }
    if (!stamped) {
      content.push({ type: "text", text: tag } as (typeof content)[number]);
    }
    return { ...message, content } as AgentMessage;
  });

export type WindowSelection = {
  messages: AgentMessage[];
  /** Journal row per message (same order), for sequence stamping. */
  rows: Array<{ seq: number; role: string | null; hidden: boolean }>;
  startSeq: number;
  endSeq: number;
  /** Rows whose payload lives in R2; the caller hydrates what it can afford. */
  spilled: Array<{
    seq: number;
    spillKey: string;
    index: number;
    role: string;
    /** Carried so an unhydratable tool result keeps its pairing. */
    toolCallId: string | null;
  }>;
};

export type AcceptanceContextFault = {
  run_id_sha256: string;
  seq: number;
  original_payload_json: string;
  original_payload_sha256: string;
  corrupt_payload_sha256: string;
  observed_failures: number;
  repair_after_failures: number;
  created_at: number;
};

/** Fixed invalid JSON. No caller-controlled bytes ever enter the mutation. */
export const ACCEPTANCE_CONTEXT_CORRUPT_PAYLOAD =
  '{"stellaAcceptanceContextFault":';

/**
 * A resident canonical row selected for model context could not be decoded.
 *
 * The sequence number is the repair locator. Deliberately omit the raw
 * payload (and the JSON parser's message) so logs can identify the damaged
 * row without copying conversation content out of the journal.
 */
export class JournalContextIntegrityError extends Error {
  readonly code = "CLOUD_CONTEXT_UNAVAILABLE";
  readonly component = "canonical_history";

  constructor(readonly seq: number) {
    super("Canonical conversation history is unreadable.");
    this.name = "JournalContextIntegrityError";
  }
}

const contentBlocks = (message: unknown): unknown[] => {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
};

const countOpenCalls = (message: unknown): number =>
  contentBlocks(message).filter(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "toolCall",
  ).length;

const toolCallIds = (message: unknown): string[] =>
  contentBlocks(message)
    .filter(
      (block): block is { type: "toolCall"; id: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "toolCall" &&
        typeof (block as { id?: unknown }).id === "string",
    )
    .map((block) => block.id);

/** What `meta()` reads back once the storage has been destroyed by a purge. */
const PURGED_META: MetaRow = Object.freeze({
  schema_version: JOURNAL_SCHEMA_VERSION,
  epoch: 0,
  owner_id: "",
  conversation_id: "",
  created_at: 0,
  title: "",
  next_seq: 0,
  hot_min_seq: 0,
  index_synced_seq: -1,
  deleted_at: 0,
});

export class Journal {
  private readonly sql: SqlStorage;
  private readonly transcriptSearch: TranscriptSearchIndex;
  private transactionDepth = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly log: ConversationLogger,
  ) {
    this.sql = ctx.storage.sql;
    this.transcriptSearch = new TranscriptSearchIndex(this.sql);
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  async bootstrap(): Promise<void> {
    // One `exec` per statement: the platform runs a single statement per call.
    for (const statement of DDL) this.sql.exec(statement);
    const existing = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM meta")
      .one().count;
    // A recreated DO under the same name must not reuse the old epoch, or a
    // client holding a stale cursor would silently splice two different
    // transcripts together. The witness lives in the async KV, which survives
    // everything a SQLite-only reset can destroy.
    const witness =
      (await this.ctx.storage.get<number>(EPOCH_WITNESS_KEY)) ?? 0;
    if (existing === 0) {
      const epoch = witness + 1;
      this.sql.exec(
        `INSERT INTO meta (id, schema_version, epoch) VALUES (0, ?, ?)`,
        JOURNAL_SCHEMA_VERSION,
        epoch,
      );
      await this.ctx.storage.put(EPOCH_WITNESS_KEY, epoch);
      return;
    }
    const meta = this.meta();
    if (meta.epoch > witness) {
      await this.ctx.storage.put(EPOCH_WITNESS_KEY, meta.epoch);
    }
    if (meta.schema_version !== JOURNAL_SCHEMA_VERSION) {
      for (const migration of MIGRATIONS) {
        if (meta.schema_version >= migration.to) continue;
        for (const statement of migration.statements) this.sql.exec(statement);
        if (migration.backfillTranscriptSearch) {
          this.backfillTranscriptSearch();
        }
      }
      this.sql.exec(
        `UPDATE meta SET schema_version = ? WHERE id = 0`,
        JOURNAL_SCHEMA_VERSION,
      );
    }
  }

  private backfillTranscriptSearch(): void {
    const rows = this.sql
      .exec<
        Pick<
          JournalRow,
          | "seq"
          | "turn_id"
          | "role"
          | "created_at"
          | "hidden"
          | "payload_json"
          | "spill_key"
        >
      >(
        `SELECT seq, turn_id, role, created_at, hidden, payload_json, spill_key
           FROM journal
          WHERE kind = 'message'
            AND role IN ('user', 'assistant')
            AND hidden = 0
            AND spill_key IS NULL
          ORDER BY seq ASC`,
      )
      .toArray();
    for (const row of rows) this.indexStoredMessage(row);
  }

  private indexStoredMessage(
    row: Pick<
      JournalRow,
      | "seq"
      | "turn_id"
      | "role"
      | "created_at"
      | "hidden"
      | "payload_json"
      | "spill_key"
    >,
  ): void {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      return;
    }
    this.transcriptSearch.index({
      seq: row.seq,
      turnId: row.turn_id,
      role: row.role ?? "",
      createdAt: row.created_at,
      hidden: row.hidden === 1,
      spillKey: row.spill_key,
      payload,
    });
  }

  // -------------------------------------------------------------------------
  // Meta
  // -------------------------------------------------------------------------

  /**
   * Always read from SQL: a cached mirror is one forgotten write from drift.
   *
   * A missing row means `deleteAll()` ran — the purge path destroys the schema
   * along with everything else, and the object can outlive that in memory. It
   * reads back as a tombstone rather than throwing, so a late request gets a
   * clean 410 instead of a 500.
   */
  meta(): MetaRow {
    try {
      const rows = this.sql
        .exec<MetaRow>(
          `SELECT schema_version, epoch, owner_id, conversation_id, created_at,
                  title, next_seq, hot_min_seq, index_synced_seq, deleted_at
             FROM meta WHERE id = 0`,
        )
        .toArray();
      if (rows.length > 0) return rows[0]!;
    } catch {
      // Table gone with the rest of the storage.
    }
    return PURGED_META;
  }

  ownerId(): string {
    return this.meta().owner_id;
  }

  isDeleted(): boolean {
    return this.meta().deleted_at !== null;
  }

  /**
   * Binds this DO to the conversation Convex says it is. Never called with a
   * connector's self-asserted identity: `conversationId` would otherwise be a
   * bearer token, and anyone who guessed a UUID would own the object.
   */
  bindOwner(
    record: ConversationOwnerRecord & { conversationId?: string },
  ): void {
    const meta = this.meta();
    if (meta.owner_id !== "" && meta.owner_id !== record.ownerId) {
      throw new Error("Conversation is already bound to a different owner.");
    }
    this.sql.exec(
      `UPDATE meta SET owner_id = ?, created_at = ?, title = ?,
              conversation_id = COALESCE(NULLIF(?, ''), conversation_id)
         WHERE id = 0`,
      record.ownerId,
      meta.created_at > 0 ? meta.created_at : record.createdAt,
      record.title,
      record.conversationId ?? "",
    );
  }

  setConversationId(conversationId: string): void {
    if (!conversationId) return;
    this.sql.exec(
      `UPDATE meta SET conversation_id = ? WHERE id = 0 AND conversation_id != ?`,
      conversationId,
      conversationId,
    );
  }

  setTitle(title: string): void {
    if (!title) return;
    this.sql.exec(
      `UPDATE meta SET title = ? WHERE id = 0 AND title = ''`,
      title,
    );
  }

  markDeleted(now: number): void {
    this.sql.exec(
      `UPDATE meta SET deleted_at = COALESCE(deleted_at, ?) WHERE id = 0`,
      now,
    );
  }

  setIndexSyncedSeq(seq: number): void {
    this.sql.exec(
      `UPDATE meta SET index_synced_seq = ? WHERE id = 0 AND index_synced_seq < ?`,
      seq,
      seq,
    );
  }

  head(activity: "idle" | "running" = "idle"): JournalHead {
    const meta = this.meta();
    const floor = this.sql
      .exec<{
        floor: number | null;
      }>(
        `SELECT MIN(first_seq) AS floor FROM segments WHERE state = 'committed'`,
      )
      .one().floor;
    return {
      headSeq: meta.next_seq - 1,
      windowStartSeq: meta.hot_min_seq,
      floorSeq: floor ?? meta.hot_min_seq,
      epoch: meta.epoch,
      title: meta.title,
      deleted: meta.deleted_at !== null,
      activity,
    };
  }

  // -------------------------------------------------------------------------
  // Append
  // -------------------------------------------------------------------------

  /**
   * A foreign append is a logical batch: its rows and rollover-surviving
   * receipt either commit together or not at all. Individual append methods
   * reuse this boundary and avoid nesting `transactionSync`.
   */
  transactionSync<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    return this.ctx.storage.transactionSync(() => {
      this.transactionDepth += 1;
      try {
        return operation();
      } finally {
        this.transactionDepth -= 1;
      }
    });
  }

  /**
   * The one seq allocator. Both the allocation and the insert happen inside a
   * single `transactionSync`: a consumed seq not backed by a row is a
   * permanent hole that no client can ever close and that `backfill` would
   * spin on forever.
   */
  private insert(
    columns: Record<string, string | number | null>,
    writerKey: string,
  ): { seq: number; inserted: boolean } {
    return this.transactionSync(() => {
      const existing = this.sql
        .exec<{
          seq: number;
        }>(`SELECT seq FROM journal WHERE writer_key = ?`, writerKey)
        .toArray();
      if (existing.length > 0) {
        return { seq: existing[0]!.seq, inserted: false };
      }
      const retired = this.sql
        .exec<{
          writer_key: string;
        }>(
          `SELECT writer_key FROM retired_writers WHERE writer_key = ?`,
          writerKey,
        )
        .toArray();
      if (retired.length > 0) throw new StaleJournalWriterError();
      const turnId = columns.turn_id;
      if (typeof turnId === "string") {
        const retiredTurn = this.sql
          .exec<{
            turn_id: string;
          }>(`SELECT turn_id FROM retired_turns WHERE turn_id = ?`, turnId)
          .toArray();
        if (retiredTurn.length > 0) throw new StaleJournalWriterError();
      }
      const seq = this.sql
        .exec<{ next_seq: number }>(`SELECT next_seq FROM meta WHERE id = 0`)
        .one().next_seq;
      const names = ["seq", ...Object.keys(columns)];
      const values: Array<string | number | null> = [
        seq,
        ...Object.values(columns),
      ];
      this.sql.exec(
        `INSERT INTO journal (${names.join(", ")}) VALUES (${names
          .map(() => "?")
          .join(", ")})`,
        ...values,
      );
      this.sql.exec(`UPDATE meta SET next_seq = ? WHERE id = 0`, seq + 1);
      return { seq, inserted: true };
    });
  }

  appendReceipt(writerKey: string): AppendReceipt | null {
    return (
      this.sql
        .exec<AppendReceipt>(
          `SELECT writer_key, fingerprint, first_seq, last_seq, epoch, created_at
             FROM append_receipts WHERE writer_key = ?`,
          writerKey,
        )
        .toArray()[0] ?? null
    );
  }

  conversationEditReceipt<T>(operationId: string, kind: string): T | null {
    const row = this.sql
      .exec<{ result_json: string }>(
        `SELECT result_json FROM conversation_edit_receipts
          WHERE operation_id = ? AND kind = ?`,
        operationId,
        kind,
      )
      .toArray()[0];
    if (!row) return null;
    try {
      return JSON.parse(row.result_json) as T;
    } catch {
      return null;
    }
  }

  putAppendReceipt(input: {
    writerKey: string;
    fingerprint: string;
    firstSeq: number;
    lastSeq: number;
    epoch: number;
    createdAt: number;
  }): void {
    this.sql.exec(
      `INSERT INTO append_receipts (
         writer_key, fingerprint, first_seq, last_seq, epoch, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(writer_key) DO NOTHING`,
      input.writerKey,
      input.fingerprint,
      input.firstSeq,
      input.lastSeq,
      input.epoch,
      input.createdAt,
    );
  }

  private assertWritable(): void {
    if (this.isDeleted()) {
      throw new ConversationDeletedError();
    }
  }

  appendMessage(input: AppendMessageInput): AppendResult {
    this.assertWritable();
    const createdAt = input.createdAt ?? Date.now();
    const full = input.payloadJson ?? JSON.stringify(input.message);
    const fullBytes = utf8Length(full);
    // A spilled row stores the stub, never the bytes: writing both would put
    // the oversize payload back in SQLite, which is the exact thing the spill
    // exists to avoid (and would breach the 2 MB platform row cap).
    const messageRecord = input.message as {
      timestamp?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
    const previewText = extractMessageText(input.message).slice(0, 64 * 1024);
    const stub: SpillStub = {
      $spill: true,
      role: input.role,
      bytes: fullBytes,
      ...(previewText
        ? { content: [{ type: "text" as const, text: previewText }] }
        : {}),
      ...(typeof messageRecord.timestamp === "number"
        ? { timestamp: messageRecord.timestamp }
        : {}),
      ...(typeof messageRecord.toolCallId === "string"
        ? { toolCallId: messageRecord.toolCallId }
        : {}),
      ...(typeof messageRecord.toolName === "string"
        ? { toolName: messageRecord.toolName }
        : {}),
      ...(typeof messageRecord.isError === "boolean"
        ? { isError: messageRecord.isError }
        : {}),
    };
    const payloadJson = input.spillKey ? JSON.stringify(stub) : full;
    const bytes = utf8Length(payloadJson);
    const toolCallId =
      input.role === "toolResult"
        ? (((input.message as { toolCallId?: unknown }).toolCallId as
            | string
            | undefined) ?? null)
        : null;
    const { seq, inserted } = this.transactionSync(() => {
      const result = this.insert(
        {
          kind: "message",
          turn_id: input.turnId,
          writer: input.writer,
          writer_key: input.writerKey,
          created_at: createdAt,
          bytes,
          role: input.role,
          hidden: input.hidden ? 1 : 0,
          model_skip: input.modelSkip ? 1 : 0,
          tool_call_id: toolCallId,
          open_calls:
            input.role === "assistant" ? countOpenCalls(input.message) : 0,
          tokens: estimateTokens(input.message),
          stream_id: input.streamId ?? null,
          client_msg_id: input.clientMsgId ?? null,
          phase: null,
          lane: null,
          source: null,
          notice: null,
          payload_json: payloadJson,
          spill_key: input.spillKey ?? null,
        },
        input.writerKey,
      );
      if (result.inserted) {
        this.transcriptSearch.index({
          seq: result.seq,
          turnId: input.turnId,
          role: input.role,
          createdAt,
          hidden: input.hidden === true,
          spillKey: input.spillKey ?? null,
          payload: input.message,
        });
      }
      return result;
    });
    return {
      seq,
      inserted,
      record: {
        seq,
        kind: "message",
        turnId: input.turnId,
        createdAtMs: createdAt,
        role: input.role,
        hidden: input.hidden === true,
        ...(input.streamId ? { streamId: input.streamId } : {}),
        ...(input.clientMsgId ? { clientMsgId: input.clientMsgId } : {}),
        payload: input.spillKey ? stub : input.message,
      },
    };
  }

  appendTurn(input: AppendTurnInput): AppendResult {
    this.assertWritable();
    const createdAt = input.createdAt ?? Date.now();
    const detail: Record<string, unknown> = {};
    if (input.promptSeq !== undefined) detail.promptSeq = input.promptSeq;
    if (input.wallClockMs !== undefined) detail.wallClockMs = input.wallClockMs;
    const payloadJson = JSON.stringify(detail);
    const { seq, inserted } = this.insert(
      {
        kind: "turn",
        turn_id: input.turnId,
        writer: input.writer,
        writer_key: input.writerKey,
        created_at: createdAt,
        bytes: utf8Length(payloadJson),
        role: null,
        hidden: 0,
        model_skip: 1,
        tool_call_id: null,
        open_calls: 0,
        tokens: 0,
        stream_id: null,
        client_msg_id: null,
        phase: input.phase,
        lane: input.lane ?? null,
        source: input.source ?? null,
        notice: input.notice ?? null,
        payload_json: payloadJson,
        spill_key: null,
      },
      input.writerKey,
    );
    return {
      seq,
      inserted,
      record: {
        seq,
        kind: "turn",
        turnId: input.turnId,
        createdAtMs: createdAt,
        phase: input.phase,
        ...(input.lane ? { lane: input.lane } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.notice ? { notice: input.notice } : {}),
        ...(input.promptSeq !== undefined
          ? { promptSeq: input.promptSeq }
          : {}),
        ...(input.wallClockMs !== undefined
          ? { wallClockMs: input.wallClockMs }
          : {}),
      },
    };
  }

  appendCard(input: AppendCardInput): AppendResult {
    this.assertWritable();
    const createdAt = input.createdAt ?? Date.now();
    const payloadJson = JSON.stringify(input.card);
    const { seq, inserted } = this.insert(
      {
        kind: "card",
        turn_id: input.turnId,
        writer: input.writer,
        writer_key: input.writerKey,
        created_at: createdAt,
        bytes: utf8Length(payloadJson),
        role: null,
        hidden: 0,
        model_skip: 1,
        tool_call_id: null,
        open_calls: 0,
        tokens: 0,
        stream_id: null,
        client_msg_id: null,
        phase: null,
        lane: null,
        source: null,
        notice: null,
        payload_json: payloadJson,
        spill_key: null,
      },
      input.writerKey,
    );
    return {
      seq,
      inserted,
      record: {
        seq,
        kind: "card",
        turnId: input.turnId,
        createdAtMs: createdAt,
        card: input.card,
      },
    };
  }

  /**
   * Promotes an oversize row's payload to R2 after the fact. Atomic, so a
   * concurrent read sees either the inline bytes or the stub, never a stub
   * whose object does not exist yet.
   */
  attachSpill(
    seq: number,
    spillKey: string,
    role: string,
    bytes: number,
  ): void {
    this.recordSpill(spillKey, bytes, Date.now());
    this.sql.exec(
      `UPDATE journal SET payload_json = ?, spill_key = ? WHERE seq = ? AND spill_key IS NULL`,
      JSON.stringify({ $spill: true, role, bytes }),
      spillKey,
      seq,
    );
  }

  // -------------------------------------------------------------------------
  // Repair on load
  // -------------------------------------------------------------------------

  /**
   * Closes any tool call the tail left unanswered.
   *
   * Eviction, `/cancel` or a watchdog abort can leave the newest row as an
   * assistant message carrying `toolCall` blocks with no matching results.
   * Anthropic rejects that history on the NEXT turn, which bricks the
   * conversation permanently. The old code avoided this by persisting nothing
   * on error; incremental persistence removes that rule, so the guarantee
   * moves here — to the read side, where it also covers the eviction case in
   * which no unwind code ever runs.
   *
   * Synthetic results are written durably rather than patched in transiently:
   * what the model reads and what the user sees must be the same rows.
   */
  repairTail(now: number): AppendResult[] {
    const rows = this.sql
      .exec<{
        seq: number;
        turn_id: string;
        role: string | null;
        tool_call_id: string | null;
        open_calls: number;
        payload_json: string;
        spill_key: string | null;
      }>(
        `SELECT seq, turn_id, role, tool_call_id, open_calls, payload_json, spill_key
           FROM journal
          WHERE kind = 'message' AND model_skip = 0
          ORDER BY seq DESC LIMIT ?`,
        REPAIR_SCAN_ROW_CAP,
      )
      .toArray();
    const answered = new Set<string>();
    const open: Array<{ turnId: string; toolCallId: string }> = [];
    for (const row of rows) {
      if (row.role === "user") break;
      if (row.role === "toolResult") {
        if (row.tool_call_id) answered.add(row.tool_call_id);
        continue;
      }
      if (row.role !== "assistant" || row.open_calls === 0) continue;
      // A spilled assistant message is > 1 MB of content; its tool calls are
      // still in the stub-free copy only, so skip rather than guess.
      if (row.spill_key) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      for (const id of toolCallIds(parsed)) {
        if (!answered.has(id))
          open.push({ turnId: row.turn_id, toolCallId: id });
      }
    }
    if (open.length === 0) return [];
    // Oldest first so the synthetic results land in call order.
    open.reverse();
    const appended: AppendResult[] = [];
    for (const entry of open) {
      appended.push(
        this.appendMessage({
          turnId: entry.turnId,
          writer: "repair",
          writerKey: `repair:${entry.turnId}:${entry.toolCallId}`,
          role: "toolResult",
          createdAt: now,
          message: {
            role: "toolResult",
            toolCallId: entry.toolCallId,
            toolName: "unknown",
            content: [
              {
                type: "text",
                text: "This tool call was interrupted before it finished.",
              },
            ],
            isError: true,
            timestamp: now,
          } as AgentMessage,
        }),
      );
    }
    this.log("info", "conversation_tail_repaired", {
      repaired: appended.length,
    });
    return appended;
  }

  // -------------------------------------------------------------------------
  // Bounded dev-acceptance context fault
  // -------------------------------------------------------------------------

  /**
   * Select the newest completed user row, which is guaranteed to participate
   * in the next normal context window. The acceptance route hashes the payload
   * before arming; the raw bytes never leave this DO.
   */
  acceptanceContextFaultCandidate(): {
    seq: number;
    payloadJson: string;
  } | null {
    if (this.acceptanceContextFaultRecord()) return null;
    const candidate = this.sql
      .exec<{ seq: number; payload_json: string }>(
        `SELECT seq, payload_json FROM journal
          WHERE kind = 'message' AND role = 'user' AND model_skip = 0
          ORDER BY seq DESC LIMIT 1`,
      )
      .toArray()[0];
    if (!candidate) return null;
    try {
      JSON.parse(candidate.payload_json);
    } catch {
      // A real corruption is never overwritten by a test fault.
      return null;
    }
    return { seq: candidate.seq, payloadJson: candidate.payload_json };
  }

  acceptanceContextFaultStatus(): Omit<
    AcceptanceContextFault,
    "original_payload_json"
  > | null {
    const fault = this.acceptanceContextFaultRecord();
    if (!fault) return null;
    const { original_payload_json: _original, ...safe } = fault;
    return safe;
  }

  /**
   * Replace exactly one internally selected row with a fixed invalid sentinel.
   * The original and its repair metadata commit atomically; there is no API
   * for caller-provided SQL, sequence numbers, or replacement content.
   */
  armAcceptanceContextFault(args: {
    runIdSha256: string;
    seq: number;
    expectedPayloadJson: string;
    originalPayloadSha256: string;
    corruptPayloadSha256: string;
    createdAt: number;
  }): Omit<AcceptanceContextFault, "original_payload_json"> {
    if (
      !/^[a-f0-9]{64}$/u.test(args.runIdSha256) ||
      !/^[a-f0-9]{64}$/u.test(args.originalPayloadSha256) ||
      !/^[a-f0-9]{64}$/u.test(args.corruptPayloadSha256) ||
      !Number.isSafeInteger(args.seq) ||
      args.seq < 0
    ) {
      throw new Error("Invalid acceptance context fault metadata.");
    }
    return this.transactionSync(() => {
      if (this.acceptanceContextFaultRecord()) {
        throw new Error("An acceptance context fault is already armed.");
      }
      const row = this.sql
        .exec<{
          payload_json: string;
          model_skip: number;
          role: string | null;
        }>(
          `SELECT payload_json, model_skip, role FROM journal
            WHERE seq = ? AND kind = 'message'`,
          args.seq,
        )
        .toArray()[0];
      if (
        !row ||
        row.model_skip !== 0 ||
        row.role !== "user" ||
        row.payload_json !== args.expectedPayloadJson
      ) {
        throw new Error("Acceptance context fault candidate changed.");
      }
      try {
        JSON.parse(row.payload_json);
      } catch {
        throw new Error(
          "Acceptance context fault candidate is already corrupt.",
        );
      }
      this.sql.exec(
        `INSERT INTO acceptance_context_fault (
           id, run_id_sha256, seq, original_payload_json,
           original_payload_sha256, corrupt_payload_sha256,
           observed_failures, repair_after_failures, created_at
         ) VALUES (0, ?, ?, ?, ?, ?, 0, 2, ?)`,
        args.runIdSha256,
        args.seq,
        row.payload_json,
        args.originalPayloadSha256,
        args.corruptPayloadSha256,
        args.createdAt,
      );
      this.sql.exec(
        `UPDATE journal SET payload_json = ?
          WHERE seq = ? AND payload_json = ?`,
        ACCEPTANCE_CONTEXT_CORRUPT_PAYLOAD,
        args.seq,
        row.payload_json,
      );
      const armed = this.acceptanceContextFaultRecord();
      const changed = this.sql
        .exec<{
          payload_json: string;
        }>(`SELECT payload_json FROM journal WHERE seq = ?`, args.seq)
        .toArray()[0];
      if (
        !armed ||
        changed?.payload_json !== ACCEPTANCE_CONTEXT_CORRUPT_PAYLOAD
      ) {
        throw new Error("Acceptance context fault did not commit atomically.");
      }
      const { original_payload_json: _original, ...safe } = armed;
      return safe;
    });
  }

  /**
   * One failed turn before restart and one after restart are required. The
   * second observation restores the byte-identical original automatically.
   */
  observeAcceptanceContextFault(runIdSha256: string): {
    observedFailures: number;
    repaired: boolean;
    seq: number;
    originalPayloadSha256: string;
    corruptPayloadSha256: string;
  } | null {
    return this.transactionSync(() => {
      const fault = this.acceptanceContextFaultRecord();
      if (!fault) return null;
      if (fault.run_id_sha256 !== runIdSha256) {
        throw new Error("Acceptance context fault run does not match.");
      }
      const observedFailures = fault.observed_failures + 1;
      if (observedFailures < fault.repair_after_failures) {
        this.sql.exec(
          `UPDATE acceptance_context_fault SET observed_failures = ? WHERE id = 0`,
          observedFailures,
        );
        return {
          observedFailures,
          repaired: false,
          seq: fault.seq,
          originalPayloadSha256: fault.original_payload_sha256,
          corruptPayloadSha256: fault.corrupt_payload_sha256,
        };
      }
      const row = this.sql
        .exec<{
          payload_json: string;
        }>(`SELECT payload_json FROM journal WHERE seq = ?`, fault.seq)
        .toArray()[0];
      if (row?.payload_json !== ACCEPTANCE_CONTEXT_CORRUPT_PAYLOAD) {
        // Keep the repair copy when the row is missing or unexpectedly changed;
        // an operator can inspect the DO without this code overwriting evidence.
        throw new Error(
          "Acceptance context fault evidence changed before repair.",
        );
      }
      this.sql.exec(
        `UPDATE journal SET payload_json = ?
          WHERE seq = ? AND payload_json = ?`,
        fault.original_payload_json,
        fault.seq,
        ACCEPTANCE_CONTEXT_CORRUPT_PAYLOAD,
      );
      this.sql.exec(`DELETE FROM acceptance_context_fault WHERE id = 0`);
      return {
        observedFailures,
        repaired: true,
        seq: fault.seq,
        originalPayloadSha256: fault.original_payload_sha256,
        corruptPayloadSha256: fault.corrupt_payload_sha256,
      };
    });
  }

  private acceptanceContextFaultRecord(): AcceptanceContextFault | null {
    return (
      this.sql
        .exec<AcceptanceContextFault>(
          `SELECT run_id_sha256, seq, original_payload_json,
                  original_payload_sha256, corrupt_payload_sha256,
                  observed_failures, repair_after_failures, created_at
             FROM acceptance_context_fault WHERE id = 0`,
        )
        .toArray()[0] ?? null
    );
  }

  // -------------------------------------------------------------------------
  // Context window
  // -------------------------------------------------------------------------

  /**
   * Two metadata passes, no payload reads in the first.
   *
   * Deliberately not a `SUM(...) OVER (...)` window function: window-function
   * support in DO SQLite is unverified, and pass 1 already reads three small
   * columns. A micro-optimisation is not worth an unverified dependency.
   */
  selectWindow(excludeTurnId: string, budgetTokens: number): WindowSelection {
    const meta = this.meta();
    const scan = this.sql
      .exec<{ seq: number; tokens: number; role: string | null }>(
        `SELECT seq, tokens, role FROM journal
          WHERE kind = 'message' AND model_skip = 0 AND turn_id != ?
          ORDER BY seq DESC LIMIT ?`,
        excludeTurnId,
        CONTEXT_SCAN_ROW_CAP,
      )
      .toArray();
    if (scan.length === 0) {
      return {
        messages: [],
        rows: [],
        startSeq: meta.next_seq,
        endSeq: meta.next_seq - 1,
        spilled: [],
      };
    }
    scan.reverse(); // oldest-first
    let used = 0;
    let start = scan.length;
    for (let index = scan.length - 1; index >= 0; index -= 1) {
      used += scan[index]!.tokens;
      if (used > budgetTokens) break;
      start = index;
    }
    // Never open the window on an orphaned toolResult: the provider rejects a
    // result with no preceding call. Same rule pruneAgentHistory applies.
    while (start < scan.length && scan[start]!.role !== "user") start += 1;
    if (start >= scan.length) {
      return {
        messages: [],
        rows: [],
        startSeq: meta.next_seq,
        endSeq: meta.next_seq - 1,
        spilled: [],
      };
    }
    const startSeq = scan[start]!.seq;
    const rows = this.sql
      .exec<{
        seq: number;
        role: string | null;
        hidden: number;
        tool_call_id: string | null;
        payload_json: string;
        spill_key: string | null;
      }>(
        `SELECT seq, role, hidden, tool_call_id, payload_json, spill_key FROM journal
          WHERE seq >= ? AND kind = 'message' AND model_skip = 0 AND turn_id != ?
          ORDER BY seq ASC`,
        startSeq,
        excludeTurnId,
      )
      .toArray();
    const messages: AgentMessage[] = [];
    const selectedRows: WindowSelection["rows"] = [];
    const spilled: WindowSelection["spilled"] = [];
    for (const row of rows) {
      selectedRows.push({
        seq: row.seq,
        role: row.role,
        hidden: row.hidden === 1,
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        // Never silently omit canonical history. Doing so lets the provider
        // answer from a context the user cannot inspect or repair and makes a
        // restart behave differently from the original turn. The row remains
        // untouched in SQLite; `seq` is the safe repair locator.
        throw new JournalContextIntegrityError(row.seq);
      }
      if (row.spill_key && isSpillStub(parsed)) {
        spilled.push({
          seq: row.seq,
          spillKey: row.spill_key,
          index: messages.length,
          role: row.role ?? "user",
          toolCallId: row.tool_call_id,
        });
      }
      messages.push(parsed as AgentMessage);
    }
    return {
      messages,
      rows: selectedRows,
      startSeq,
      endSeq: rows.length > 0 ? rows[rows.length - 1]!.seq : startSeq,
      spilled,
    };
  }

  /**
   * Replaces an unhydratable spilled payload with an honest placeholder. A
   * tool result keeps its original `toolCallId` — dropping it would orphan
   * the call it answers, which is the one thing the provider will not accept.
   */
  omittedPlaceholder(
    role: string,
    now: number,
    toolCallId?: string | null,
  ): AgentMessage {
    if (role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: toolCallId ?? "omitted",
        toolName: "unknown",
        content: [{ type: "text", text: "[content omitted: too large]" }],
        isError: false,
        timestamp: now,
      } as AgentMessage;
    }
    return {
      role: role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: "[content omitted: too large]" }],
      timestamp: now,
    } as AgentMessage;
  }

  markModelSkip(seq: number): void {
    this.sql.exec(`UPDATE journal SET model_skip = 1 WHERE seq = ?`, seq);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  rowToRecord(row: JournalRow): JournalRecord {
    const parse = (): unknown => {
      try {
        return JSON.parse(row.payload_json);
      } catch {
        return null;
      }
    };
    if (row.kind === "turn") {
      const detail = (parse() ?? {}) as {
        promptSeq?: number;
        wallClockMs?: number;
      };
      return {
        seq: row.seq,
        kind: "turn",
        turnId: row.turn_id,
        createdAtMs: row.created_at,
        phase: (row.phase ?? "started") as TurnPhase,
        ...(row.lane ? { lane: row.lane } : {}),
        ...(row.source ? { source: row.source } : {}),
        ...(row.notice ? { notice: row.notice } : {}),
        ...(detail.promptSeq !== undefined
          ? { promptSeq: detail.promptSeq }
          : {}),
        ...(detail.wallClockMs !== undefined
          ? { wallClockMs: detail.wallClockMs }
          : {}),
      };
    }
    if (row.kind === "card") {
      return {
        seq: row.seq,
        kind: "card",
        turnId: row.turn_id,
        createdAtMs: row.created_at,
        card: (parse() ?? {
          type: "operation",
          operation: "unknown",
        }) as ConversationCard,
      };
    }
    return {
      seq: row.seq,
      kind: "message",
      turnId: row.turn_id,
      createdAtMs: row.created_at,
      role: (row.role ?? "assistant") as MessageRole,
      hidden: row.hidden === 1,
      ...(row.stream_id ? { streamId: row.stream_id } : {}),
      ...(row.client_msg_id ? { clientMsgId: row.client_msg_id } : {}),
      payload: parse(),
    };
  }

  private selectRows(where: string, ...bindings: unknown[]): JournalRow[] {
    return this.sql
      .exec<JournalRow>(
        `SELECT seq, kind, turn_id, writer, writer_key, created_at, bytes, role,
                hidden, model_skip, tool_call_id, open_calls, tokens, stream_id,
                client_msg_id, phase, lane, source, notice, payload_json, spill_key
           FROM journal ${where}`,
        ...bindings,
      )
      .toArray();
  }

  /** Newest `limit` records, returned oldest-first. */
  newest(limit = INITIAL_WINDOW_RECORDS): JournalRecord[] {
    const rows = this.selectRows(`ORDER BY seq DESC LIMIT ?`, limit);
    rows.reverse();
    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * Resident rows in `[fromSeq, toSeq]`, bounded by both a row and a byte
   * budget. `complete` is false when the budget cut the range short — the
   * client re-asks from where it got to.
   */
  readResident(
    fromSeq: number,
    toSeq: number,
    maxRecords: number,
    maxBytes: number,
  ): { records: JournalRecord[]; complete: boolean } {
    const rows = this.selectRows(
      `WHERE seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
      fromSeq,
      toSeq,
      maxRecords + 1,
    );
    const records: JournalRecord[] = [];
    let bytes = 0;
    let complete = true;
    for (const row of rows) {
      if (records.length >= maxRecords || bytes > maxBytes) {
        complete = false;
        break;
      }
      bytes += row.bytes;
      records.push(this.rowToRecord(row));
    }
    if (complete && rows.length > maxRecords) complete = false;
    return { records, complete };
  }

  /** Raw rows for archival. Ordered, bounded, includes every column. */
  rowsForArchive(fromSeq: number, toSeq: number, limit: number): JournalRow[] {
    return this.selectRows(
      `WHERE seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
      fromSeq,
      toSeq,
      limit,
    );
  }

  /**
   * Imports one contiguous logical prefix page into a fresh fork target.
   *
   * Exact seq values are retained so a rendered source boundary maps to the
   * same logical boundary in the fork. Writer keys are namespaced by the fork
   * operation: they remain idempotent across page retries without making a
   * delayed writer from the source authoritative in the target.
   */
  importForkRows(
    rows: JournalRow[],
    operationId: string,
    ownerId: string,
  ): { firstSeq: number; lastSeq: number } | null {
    if (rows.length === 0) return null;
    return this.transactionSync(() => {
      const meta = this.meta();
      let expected = meta.next_seq;
      for (const row of rows) {
        if (row.seq !== expected) {
          throw new Error(
            "Fork page is not contiguous with the target journal.",
          );
        }
        const writerKey = `fork:${operationId}:${row.writer_key}`;
        this.sql.exec(
          `INSERT INTO journal (
             seq, kind, turn_id, writer, writer_key, created_at, bytes, role,
             hidden, model_skip, tool_call_id, open_calls, tokens, stream_id,
             client_msg_id, phase, lane, source, notice, payload_json, spill_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.seq,
          row.kind,
          row.turn_id,
          `fork:${row.writer}`,
          writerKey,
          row.created_at,
          row.bytes,
          row.role,
          row.hidden,
          row.model_skip,
          row.tool_call_id,
          row.open_calls,
          row.tokens,
          row.stream_id,
          row.client_msg_id,
          row.phase,
          row.lane,
          row.source,
          row.notice,
          row.payload_json,
          row.spill_key,
        );
        if (row.kind === "message") this.indexStoredMessage(row);
        const terminal =
          row.kind === "turn" &&
          (row.phase === "completed" ||
            row.phase === "failed" ||
            row.phase === "canceled" ||
            row.phase === "timeout");
        this.sql.exec(
          `INSERT INTO turns (
             turn_id, session_id, owner_id, lane, source, client_msg_id, state,
             terminal_kind, first_seq, last_seq, created_at, updated_at
           ) VALUES (?, 'fork', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(turn_id) DO UPDATE SET
             lane = COALESCE(turns.lane, excluded.lane),
             source = COALESCE(turns.source, excluded.source),
             client_msg_id = COALESCE(turns.client_msg_id, excluded.client_msg_id),
             state = CASE WHEN excluded.state = 'terminal' THEN 'terminal' ELSE turns.state END,
             terminal_kind = COALESCE(excluded.terminal_kind, turns.terminal_kind),
             first_seq = MIN(turns.first_seq, excluded.first_seq),
             last_seq = MAX(turns.last_seq, excluded.last_seq),
             updated_at = MAX(turns.updated_at, excluded.updated_at)`,
          row.turn_id,
          ownerId,
          row.lane,
          row.source,
          row.client_msg_id,
          terminal ? "terminal" : "running",
          terminal ? row.phase : null,
          row.seq,
          row.seq,
          row.created_at,
          row.created_at,
        );
        expected += 1;
      }
      this.sql.exec(`UPDATE meta SET next_seq = ? WHERE id = 0`, expected);
      return {
        firstSeq: rows[0]!.seq,
        lastSeq: rows[rows.length - 1]!.seq,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Turn projection (never authoritative — see invariant 3)
  // -------------------------------------------------------------------------

  upsertTurn(input: {
    turnId: string;
    sessionId: string;
    ownerId: string;
    lane?: string;
    source?: string;
    clientMsgId?: string;
    state: "queued" | "running" | "terminal";
    now: number;
  }): void {
    if (
      this.sql
        .exec<{
          turn_id: string;
        }>(`SELECT turn_id FROM retired_turns WHERE turn_id = ?`, input.turnId)
        .toArray().length > 0
    ) {
      throw new StaleJournalWriterError();
    }
    this.sql.exec(
      `INSERT INTO turns (turn_id, session_id, owner_id, lane, source, client_msg_id,
                          state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      input.turnId,
      input.sessionId,
      input.ownerId,
      input.lane ?? null,
      input.source ?? null,
      input.clientMsgId ?? null,
      input.state,
      input.now,
      input.now,
    );
  }

  setTurnContext(turnId: string, ctxStartSeq: number, ctxEndSeq: number): void {
    this.sql.exec(
      `UPDATE turns SET ctx_start_seq = ?, ctx_end_seq = ? WHERE turn_id = ?`,
      ctxStartSeq,
      ctxEndSeq,
      turnId,
    );
  }

  setTurnSpan(turnId: string, seq: number): void {
    this.sql.exec(
      `UPDATE turns SET first_seq = COALESCE(first_seq, ?), last_seq = ? WHERE turn_id = ?`,
      seq,
      seq,
      turnId,
    );
  }

  setTurnTerminal(turnId: string, kind: TurnPhase, now: number): void {
    this.sql.exec(
      `UPDATE turns SET state = 'terminal', terminal_kind = ?, updated_at = ? WHERE turn_id = ?`,
      kind,
      now,
      turnId,
    );
  }

  turnState(
    turnId: string,
  ): { state: string; terminal_kind: string | null } | null {
    const rows = this.sql
      .exec<{
        state: string;
        terminal_kind: string | null;
      }>(`SELECT state, terminal_kind FROM turns WHERE turn_id = ?`, turnId)
      .toArray();
    return rows[0] ?? null;
  }

  latestTerminalTurn(): {
    turn_id: string;
    ctx_start_seq: number | null;
    last_seq: number | null;
  } | null {
    const rows = this.sql
      .exec<{
        turn_id: string;
        ctx_start_seq: number | null;
        last_seq: number | null;
      }>(
        `SELECT turn_id, ctx_start_seq, last_seq FROM turns
          WHERE state = 'terminal' ORDER BY created_at DESC LIMIT 1`,
      )
      .toArray();
    return rows[0] ?? null;
  }

  /** Rollover boundary candidates: terminal turns, oldest first. */
  terminalTurnBoundaries(limit: number): Array<{ last_seq: number }> {
    return this.sql
      .exec<{ last_seq: number }>(
        `SELECT last_seq FROM turns
          WHERE state = 'terminal' AND last_seq IS NOT NULL
          ORDER BY last_seq ASC LIMIT ?`,
        limit,
      )
      .toArray();
  }

  /** True when `seq + 1` is a plain user message — a safe history boundary. */
  isCutBoundary(seq: number): boolean {
    const rows = this.sql
      .exec<{
        role: string | null;
        kind: string;
      }>(
        `SELECT role, kind FROM journal WHERE seq > ? ORDER BY seq ASC LIMIT 1`,
        seq,
      )
      .toArray();
    const next = rows[0];
    return (
      next !== undefined && next.kind === "message" && next.role === "user"
    );
  }

  deleteTurnsBelow(seq: number): void {
    this.sql.exec(
      `DELETE FROM turns WHERE last_seq IS NOT NULL AND last_seq < ?`,
      seq,
    );
  }

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------

  /**
   * Single-threaded execution gives total order but not CORRECT order: a
   * foreign append landing between an assistant's toolCall and its result
   * produces a history the provider rejects next turn. Foreign writers stage
   * here and drain at the turn's clean boundary.
   */
  stageInbox(input: {
    writer: string;
    writerKey: string;
    kind: JournalRecord["kind"];
    turnId: string;
    role?: string;
    hidden?: boolean;
    payloadJson: string;
    now: number;
  }): void {
    if (
      this.sql
        .exec<{
          turn_id: string;
        }>(`SELECT turn_id FROM retired_turns WHERE turn_id = ?`, input.turnId)
        .toArray().length > 0
    ) {
      throw new StaleJournalWriterError();
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO inbox (writer, writer_key, kind, turn_id, role, hidden,
                                    created_at, bytes, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.writer,
      input.writerKey,
      input.kind,
      input.turnId,
      input.role ?? null,
      input.hidden ? 1 : 0,
      input.now,
      utf8Length(input.payloadJson),
      input.payloadJson,
    );
  }

  inboxSize(): { rows: number; bytes: number } {
    const row = this.sql
      .exec<{
        rows: number;
        bytes: number | null;
      }>(`SELECT COUNT(*) AS rows, SUM(bytes) AS bytes FROM inbox`)
      .one();
    return { rows: row.rows, bytes: row.bytes ?? 0 };
  }

  takeInbox(limit: number): InboxRow[] {
    return this.sql
      .exec<InboxRow>(
        `SELECT id, writer, writer_key, kind, turn_id, role, hidden, created_at,
                bytes, payload_json
           FROM inbox ORDER BY id ASC LIMIT ?`,
        limit,
      )
      .toArray();
  }

  dropInbox(id: number): void {
    this.sql.exec(`DELETE FROM inbox WHERE id = ?`, id);
  }

  /** Last rendered text of the conversation, for the Convex index preview. */
  lastPreview(maxChars: number): { text: string; role: string } | null {
    const rows = this.sql
      .exec<{
        role: string | null;
        payload_json: string;
        spill_key: string | null;
      }>(
        `SELECT role, payload_json, spill_key FROM journal
          WHERE kind = 'message' AND hidden = 0 AND role IN ('user','assistant')
          ORDER BY seq DESC LIMIT 8`,
      )
      .toArray();
    for (const row of rows) {
      if (row.spill_key) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const text = collapseWhitespace(extractMessageText(parsed));
      if (text) return { text: text.slice(0, maxChars), role: row.role ?? "" };
    }
    return null;
  }

  searchTranscript(
    terms: readonly string[],
    limit: number,
  ): TranscriptSearchHit[] {
    return this.transcriptSearch.search(terms, limit);
  }

  // -------------------------------------------------------------------------
  // Segments / rollover bookkeeping
  // -------------------------------------------------------------------------

  hotStats(): { rows: number; bytes: number } {
    const row = this.sql
      .exec<{
        rows: number;
        bytes: number | null;
      }>(`SELECT COUNT(*) AS rows, SUM(bytes) AS bytes FROM journal`)
      .one();
    return { rows: row.rows, bytes: row.bytes ?? 0 };
  }

  databaseSize(): number {
    return this.sql.databaseSize;
  }

  /**
   * The highest seq that rollover would like to archive so the resident set
   * lands at the given targets. Returns null when the hot set is already at or
   * under both. This is a WISH, not a boundary: the caller still has to find a
   * legal cut at or below it.
   */
  desiredCutSeq(targetRows: number, targetBytes: number): number | null {
    const rows = this.sql
      .exec<{
        seq: number;
        bytes: number;
      }>(
        `SELECT seq, bytes FROM journal ORDER BY seq DESC LIMIT ?`,
        Math.max(targetRows, 1) + 1,
      )
      .toArray();
    const total = this.hotStats();
    if (total.rows <= targetRows && total.bytes <= targetBytes) return null;
    let kept = 0;
    let keptBytes = 0;
    for (const row of rows) {
      if (kept >= targetRows) return row.seq;
      if (targetBytes > 0 && keptBytes + row.bytes > targetBytes && kept > 0) {
        return row.seq;
      }
      kept += 1;
      keptBytes += row.bytes;
    }
    return null;
  }

  pendingSegment(): SegmentRow | null {
    const rows = this.sql
      .exec<SegmentRow>(
        `SELECT first_seq, last_seq, rows, bytes, r2_key, state, created_at
           FROM segments WHERE state = 'uploading' ORDER BY first_seq ASC LIMIT 1`,
      )
      .toArray();
    return rows[0] ?? null;
  }

  insertSegment(row: SegmentRow): void {
    this.sql.exec(
      `INSERT INTO segments (first_seq, last_seq, rows, bytes, r2_key, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(first_seq) DO UPDATE SET
         last_seq = excluded.last_seq, rows = excluded.rows, bytes = excluded.bytes,
         r2_key = excluded.r2_key`,
      row.first_seq,
      row.last_seq,
      row.rows,
      row.bytes,
      row.r2_key,
      row.state,
      row.created_at,
    );
  }

  /**
   * The commit half of the two-phase cut, as ONE transaction: mark committed,
   * drop the archived rows, raise the resident floor. Rows are never deleted
   * before the R2 put resolves, so the worst crash outcome is a duplicate
   * object — never a lost record.
   */
  commitSegment(firstSeq: number, lastSeq: number): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE segments SET state = 'committed' WHERE first_seq = ?`,
        firstSeq,
      );
      this.sql.exec(
        `DELETE FROM journal WHERE seq >= ? AND seq <= ?`,
        firstSeq,
        lastSeq,
      );
      this.sql.exec(
        `UPDATE meta SET hot_min_seq = ? WHERE id = 0 AND hot_min_seq < ?`,
        lastSeq + 1,
        lastSeq + 1,
      );
      this.sql.exec(
        `DELETE FROM turns WHERE last_seq IS NOT NULL AND last_seq <= ?`,
        lastSeq,
      );
    });
  }

  segmentsCovering(
    fromSeq: number,
    toSeq: number,
    limit: number,
  ): SegmentRow[] {
    return this.sql
      .exec<SegmentRow>(
        `SELECT first_seq, last_seq, rows, bytes, r2_key, state, created_at
           FROM segments
          WHERE state = 'committed' AND last_seq >= ? AND first_seq <= ?
          ORDER BY first_seq ASC LIMIT ?`,
        fromSeq,
        toSeq,
        limit,
      )
      .toArray();
  }

  segmentsAfter(seq: number): SegmentRow[] {
    return this.sql
      .exec<SegmentRow>(
        `SELECT first_seq, last_seq, rows, bytes, r2_key, state, created_at
           FROM segments
          WHERE state = 'committed' AND last_seq > ?
          ORDER BY first_seq ASC`,
        seq,
      )
      .toArray();
  }

  residentRowsAfter(seq: number): JournalRow[] {
    return this.selectRows(`WHERE seq > ? ORDER BY seq ASC`, seq);
  }

  /**
   * Atomically makes a rewind visible. R2 objects are prepared before this
   * transaction; their old keys are only queued for deletion here, after the
   * manifest stops naming them. A stale socket can therefore observe either
   * the old epoch or the complete new prefix, never a half-truncated journal.
   */
  async applyTruncate(input: {
    operationId: string;
    throughSeq: number;
    expectedEpoch: number;
    expectedLastSeq: number;
    replacementSegment?: SegmentRow;
    removedSegmentFirstSeqs: number[];
    purgeKeys: string[];
    retiredWriterKeys: string[];
    retiredTurnIds: string[];
    retiredAt: number;
    resultJson: string;
  }): Promise<{ previousEpoch: number; nextEpoch: number; lastSeq: number }> {
    const result = this.transactionSync(() => {
      const meta = this.meta();
      if (
        meta.epoch !== input.expectedEpoch ||
        meta.next_seq - 1 !== input.expectedLastSeq
      ) {
        throw new JournalHeadConflictError(meta.epoch, meta.next_seq - 1);
      }
      if (input.throughSeq < -1 || input.throughSeq > input.expectedLastSeq) {
        throw new Error("Invalid rewind boundary.");
      }
      const nextEpoch = meta.epoch + 1;
      const suffix = this.residentRowsAfter(input.throughSeq);
      for (const writerKey of [
        ...suffix.map((row) => row.writer_key),
        ...input.retiredWriterKeys,
      ]) {
        this.sql.exec(
          `INSERT OR IGNORE INTO retired_writers (writer_key, epoch, retired_at)
           VALUES (?, ?, ?)`,
          writerKey,
          meta.epoch,
          input.retiredAt,
        );
      }
      for (const turnId of [
        ...suffix.map((row) => row.turn_id),
        ...input.retiredTurnIds,
      ]) {
        this.sql.exec(
          `INSERT OR IGNORE INTO retired_turns (turn_id, epoch, retired_at)
           VALUES (?, ?, ?)`,
          turnId,
          meta.epoch,
          input.retiredAt,
        );
      }
      this.sql.exec(`DELETE FROM journal WHERE seq > ?`, input.throughSeq);
      this.sql.exec(
        `DELETE FROM turns
          WHERE first_seq > ? OR last_seq > ?`,
        input.throughSeq,
        input.throughSeq,
      );
      this.transcriptSearch.removeAbove(input.throughSeq);
      for (const firstSeq of input.removedSegmentFirstSeqs) {
        this.sql.exec(`DELETE FROM segments WHERE first_seq = ?`, firstSeq);
      }
      if (input.replacementSegment) {
        this.insertSegment(input.replacementSegment);
        this.sql.exec(
          `DELETE FROM purge_queue WHERE r2_key = ?`,
          input.replacementSegment.r2_key,
        );
      }
      this.enqueuePurge(input.purgeKeys, input.retiredAt);
      this.sql.exec(
        `UPDATE meta
            SET epoch = ?, next_seq = ?, hot_min_seq = MIN(hot_min_seq, ?),
                index_synced_seq = -1
          WHERE id = 0`,
        nextEpoch,
        input.throughSeq + 1,
        input.throughSeq + 1,
      );
      this.sql.exec(
        `INSERT INTO conversation_edit_receipts (
           operation_id, kind, result_json, created_at
         ) VALUES (?, 'rewind', ?, ?)
         ON CONFLICT(operation_id) DO NOTHING`,
        input.operationId,
        input.resultJson,
        input.retiredAt,
      );
      return {
        previousEpoch: meta.epoch,
        nextEpoch,
        lastSeq: input.throughSeq,
      };
    });
    await this.ctx.storage.put(EPOCH_WITNESS_KEY, result.nextEpoch);
    return result;
  }

  allSegmentKeys(): string[] {
    return this.sql
      .exec<{ r2_key: string }>(`SELECT r2_key FROM segments`)
      .toArray()
      .map((row) => row.r2_key);
  }

  /**
   * Records a spill object at the moment it lands in R2 — before any journal
   * row references it, and independently of whether one ever does. A row that
   * rolls over loses its `spill_key` when `commitSegment` deletes it, and an
   * append that fails after the R2 put never had one; both would otherwise
   * leave the object unreachable by the purge.
   */
  recordSpill(key: string, bytes: number, now: number): void {
    if (!key) return;
    // `bytes` is what the ceiling charges for, so a re-spilled key must not be
    // able to lower it: the same writer key always carries the same payload,
    // and taking the larger of the two is what keeps a truncated retry from
    // discounting an object that is still full size in R2.
    this.sql.exec(
      `INSERT INTO spills (r2_key, created_at, bytes) VALUES (?, ?, ?)
       ON CONFLICT(r2_key) DO UPDATE SET bytes = MAX(spills.bytes, excluded.bytes)`,
      key,
      now,
      Math.max(0, Math.trunc(bytes)),
    );
  }

  allSpillKeys(): string[] {
    return this.sql
      .exec<{ r2_key: string }>(`SELECT r2_key FROM spills`)
      .toArray()
      .map((row) => row.r2_key);
  }

  ownerTransferSourceKeys(
    sourcePrefix: string,
    limit: number,
  ): Array<{ key: string; kind: "segment" | "spill" }> {
    const prefix = `${sourcePrefix}/%`;
    return this.sql
      .exec<{ key: string; kind: "segment" | "spill" }>(
        `SELECT key, kind FROM (
           SELECT r2_key AS key, 'spill' AS kind, 0 AS priority
             FROM spills WHERE r2_key LIKE ?
           UNION ALL
           SELECT r2_key AS key, 'segment' AS kind, 1 AS priority
             FROM segments WHERE r2_key LIKE ?
         ) ORDER BY priority ASC, key ASC LIMIT ?`,
        prefix,
        prefix,
        Math.max(1, Math.trunc(limit)),
      )
      .toArray();
  }

  enqueueOwnerTransferObject(
    oldKey: string,
    newKey: string,
    kind: "segment" | "spill",
  ): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO owner_transfer_objects
         (old_key, new_key, kind, state) VALUES (?, ?, ?, 'copying')`,
      oldKey,
      newKey,
      kind,
    );
  }

  ownerTransferObjects(
    state: "copying" | "cleanup",
    limit: number,
  ): OwnerTransferObjectRow[] {
    return this.sql
      .exec<OwnerTransferObjectRow>(
        `SELECT old_key, new_key, kind, state
           FROM owner_transfer_objects
          WHERE state = ? ORDER BY old_key ASC LIMIT ?`,
        state,
        Math.max(1, Math.trunc(limit)),
      )
      .toArray();
  }

  rewriteOwnerTransferObject(row: OwnerTransferObjectRow): void {
    this.ctx.storage.transactionSync(() => {
      if (row.kind === "spill") {
        this.sql.exec(
          `UPDATE spills SET r2_key = ? WHERE r2_key = ?`,
          row.new_key,
          row.old_key,
        );
        this.sql.exec(
          `UPDATE journal SET spill_key = ? WHERE spill_key = ?`,
          row.new_key,
          row.old_key,
        );
      } else {
        this.sql.exec(
          `UPDATE segments SET r2_key = ? WHERE r2_key = ?`,
          row.new_key,
          row.old_key,
        );
      }
      this.sql.exec(
        `UPDATE owner_transfer_objects SET state = 'cleanup'
          WHERE old_key = ?`,
        row.old_key,
      );
    });
  }

  completeOwnerTransferObject(oldKey: string): void {
    this.sql.exec(
      `DELETE FROM owner_transfer_objects WHERE old_key = ?`,
      oldKey,
    );
  }

  ownerTransferPending(): number {
    return this.sql
      .exec<{
        count: number;
      }>(`SELECT COUNT(*) AS count FROM owner_transfer_objects`)
      .one().count;
  }

  transferOwner(fromOwnerId: string, toOwnerId: string): boolean {
    let transferred = false;
    this.ctx.storage.transactionSync(() => {
      const meta = this.meta();
      if (meta.owner_id === toOwnerId) {
        transferred = true;
        return;
      }
      if (meta.owner_id !== "" && meta.owner_id !== fromOwnerId) return;
      if (this.ownerTransferPending() > 0) return;
      this.sql.exec(`UPDATE meta SET owner_id = ? WHERE id = 0`, toOwnerId);
      this.sql.exec(
        `UPDATE turns SET owner_id = ? WHERE owner_id = ?`,
        toOwnerId,
        fromOwnerId,
      );
      transferred = true;
    });
    return transferred;
  }

  /**
   * Everything this conversation has stored, resident, archived and spilled.
   * Segment rows survive their journal rows precisely so this stays honest
   * across rollover — a cap on the resident set alone would bound nothing.
   *
   * Spills are the third term because they are the only bytes that leave this
   * object entirely: a spilled row keeps a ~60-byte stub here and its real
   * payload in R2, so counting only the first two terms measured everything
   * except the writes worth bounding.
   */
  storedBytes(): number {
    const archived = this.sql
      .exec<{
        bytes: number | null;
      }>(`SELECT SUM(bytes) AS bytes FROM segments WHERE state = 'committed'`)
      .one().bytes;
    const spilled = this.sql
      .exec<{ bytes: number | null }>(`SELECT SUM(bytes) AS bytes FROM spills`)
      .one().bytes;
    return this.hotStats().bytes + (archived ?? 0) + (spilled ?? 0);
  }

  /**
   * The conversation's fixed append window, evaluated and optionally charged.
   *
   * Fixed rather than sliding because the bookkeeping has to be as cheap as
   * the append it guards; the worst case is one window's allowance spent twice
   * across a boundary, which the lifetime ceiling bounds regardless.
   *
   * `commit: false` is what lets the caller test the budget before it has done
   * any work and charge it only once the rows are actually going in — a
   * request refused for an unrelated reason must not spend the allowance the
   * client needs to retry with.
   */
  appendBudget(input: {
    now: number;
    bytes: number;
    windowMs: number;
    maxRequests: number;
    maxBytes: number;
    commit: boolean;
  }): { allowed: boolean; retryAfterMs: number } {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.sql
        .exec<{
          started_at: number;
          requests: number;
          bytes: number;
        }>(`SELECT started_at, requests, bytes FROM append_window WHERE id = 0`)
        .toArray();
      const current = rows[0];
      const expired =
        current === undefined ||
        input.now - current.started_at >= input.windowMs;
      const startedAt = expired ? input.now : current!.started_at;
      const requests = (expired ? 0 : current!.requests) + 1;
      const bytes = (expired ? 0 : current!.bytes) + input.bytes;
      if (requests > input.maxRequests || bytes > input.maxBytes) {
        return {
          allowed: false,
          retryAfterMs: Math.max(1_000, startedAt + input.windowMs - input.now),
        };
      }
      if (input.commit) {
        this.sql.exec(
          `INSERT INTO append_window (id, started_at, requests, bytes)
           VALUES (0, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             started_at = excluded.started_at, requests = excluded.requests,
             bytes = excluded.bytes`,
          startedAt,
          requests,
          bytes,
        );
      }
      return { allowed: true, retryAfterMs: 0 };
    });
  }

  // -------------------------------------------------------------------------
  // Purge queue
  // -------------------------------------------------------------------------

  enqueuePurge(keys: string[], now: number): void {
    for (const key of keys) {
      this.sql.exec(
        `INSERT OR IGNORE INTO purge_queue (r2_key, queued_at) VALUES (?, ?)`,
        key,
        now,
      );
    }
  }

  /**
   * Least-attempted first. A batch R2 refuses is re-queued with a higher
   * attempt count and therefore sorts behind everything still untried, so one
   * key that keeps failing costs its own deletion and not the queue's — the
   * old `queued_at ASC` ordering handed the same failing batch back forever
   * and every key behind it was unreachable.
   */
  purgeBatch(limit: number): string[] {
    return this.sql
      .exec<{ r2_key: string }>(
        `SELECT r2_key FROM purge_queue ORDER BY attempts ASC, queued_at ASC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row) => row.r2_key);
  }

  purgeDone(keys: string[]): void {
    for (const key of keys) {
      this.sql.exec(`DELETE FROM purge_queue WHERE r2_key = ?`, key);
      // Rewind uses the same deletion debt as full purge, but keeps the
      // database. Once R2 confirmed deletion, retaining a spill locator would
      // over-count storage forever and make the removed suffix look live.
      this.sql.exec(`DELETE FROM spills WHERE r2_key = ?`, key);
    }
  }

  purgeFailed(keys: string[]): void {
    for (const key of keys) {
      this.sql.exec(
        `UPDATE purge_queue SET attempts = attempts + 1 WHERE r2_key = ?`,
        key,
      );
    }
  }

  purgePending(): number {
    return this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM purge_queue`)
      .one().count;
  }
}

/** Thrown by every write path once the conversation is tombstoned. */
export class ConversationDeletedError extends Error {
  constructor() {
    super("This conversation was deleted.");
    this.name = "ConversationDeletedError";
  }
}

/** A delayed writer from an older epoch tried to recreate removed history. */
export class StaleJournalWriterError extends Error {
  constructor() {
    super("This journal writer belongs to a retired conversation epoch.");
    this.name = "StaleJournalWriterError";
  }
}

export class JournalHeadConflictError extends Error {
  constructor(
    readonly epoch: number,
    readonly lastSeq: number,
  ) {
    super("The conversation changed before this edit could be applied.");
    this.name = "JournalHeadConflictError";
  }
}
