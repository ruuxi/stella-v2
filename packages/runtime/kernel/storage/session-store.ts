/**
 * SessionStore: the storage layer's public API, composed from the typed
 * modules (ChatLog, ThreadLog, AgentRegistry). Chat reads and writes go
 * straight to `store.chat` (ChatLog) and `store.messageWindows`; the
 * internals run on the v1 schema where ordering, visibility, and turn
 * structure are written at insert time.
 *
 * On this branch the store additionally carries the local/cloud hybrid
 * surface: durable cloud outboxes (transcript, journal, computer-agent),
 * cloud agent control/tool-operation receipts, the one-time legacy chat
 * cloud import, realtime-voice tool receipts, and the in-memory ephemeral
 * thread capture used while a cloud turn owns a conversation.
 */

import { ThreadSummaryStore } from "../memory/thread-summary-store.js";
import { normalizeRuntimeThreadId } from "../runtime-threads.js";
import { customMessageContentText } from "../agent-runtime/resident-context.js";
import {
  asFiniteNumber,
  asTrimmedString,
  cachedStatements,
  parseJsonRecord,
  requireConversationId,
  type CachedStatements,
  type RuntimeThreadMessage,
  type SqliteDatabase,
} from "./shared.js";
import { ChatLog } from "./chat-log.js";
import { MessageWindowReader } from "./message-window.js";
import { OutboxRepo } from "./outbox-repo.js";
import { ThreadLog } from "./thread-log.js";
import { AgentRegistry, type AgentRecordInput } from "./agent-registry.js";
import { RunTaskStore } from "./run-task.js";
import {
  AGENT_ASSISTANT_UPDATE_LIMITS,
  EAGER_TOOL_EVENT_LIMIT,
  EAGER_TOOL_EVENT_PAYLOAD_BYTES,
  buildFallbackThreadPayload,
  enforceThreadPayloadRowSizeLimit,
  projectLocalChatUpdateEvent,
  type ThreadMessageInput,
} from "./view.js";

export {
  AGENT_ASSISTANT_UPDATE_LIMITS,
  EAGER_TOOL_EVENT_LIMIT,
  EAGER_TOOL_EVENT_PAYLOAD_BYTES,
  projectLocalChatUpdateEvent,
};

export type SessionStoreOptions = {
  onThreadActivityUpdate?: (payload: unknown) => void;
  onThreadAssistantUpdate?: (payload: unknown) => void;
  onThreadTranscriptUpdate?: (payload: unknown) => void;
};

/* -------------------------------------------------------------------- */
/* Dev-only (hybrid) types                                               */
/* -------------------------------------------------------------------- */

type EphemeralThreadMessage = RuntimeThreadMessage & {
  entryId: string;
  checkpointQuarantineKeys?: string[];
  checkpointImageReceipts?: any[];
};

type EphemeralThreadCapture = {
  captureId: string;
  seedMessages: EphemeralThreadMessage[];
  appendedMessages: EphemeralThreadMessage[];
};

export type VoiceToolCallReceipt =
  | {
      status: "started";
      operationId: string;
      startedAt: number;
    }
  | {
      status: "pending";
      operationId: string;
      startedAt: number;
    }
  | {
      status: "completed";
      operationId: string;
      startedAt: number;
      completionJson: string;
    };

export type CloudTranscriptOutboxKind = "begin" | "finish";

export type CloudTranscriptOutboxRecord = {
  id: string;
  kind: CloudTranscriptOutboxKind;
  conversationId: string;
  deviceId: string;
  /** Null only for a pre-migration row, which delivery retires fail-closed. */
  ownerGeneration: string | null;
  localTurnId: string;
  payloadJson: string;
  recoveryJson: string | null;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type CloudJournalOutboxRecord = {
  sequence: number;
  id: string;
  conversationId: string;
  deviceId: string;
  /** Null only for a pre-migration row, which delivery retires fail-closed. */
  ownerGeneration: string | null;
  appendId: string;
  payloadJson: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type CloudAgentControlStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/** Latest server-issued control authority for one desktop-origin cloud agent. */
export type CloudAgentThreadControlRecord = {
  threadId: string;
  ownerGeneration: string;
  cloudConversationId: string;
  originConversationId: string;
  attemptGeneration: number;
  threadUpdatedAt: number;
  status: CloudAgentControlStatus;
  createdAt: number;
  updatedAt: number;
};

/** Immutable pre-network intent plus its optional exact server response. */
export type CloudAgentToolOperationRecord = {
  operationId: string;
  kind: "spawn" | "continue" | "cancel";
  fingerprint: string;
  ownerGeneration: string;
  requestJson: string;
  resultJson: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ComputerAgentCloudOutboxKind = "start" | "terminal" | "cancel";

export type ComputerAgentCloudOutboxRecord = {
  sequence: number;
  id: string;
  kind: ComputerAgentCloudOutboxKind;
  threadId: string;
  attemptGeneration: number;
  ownerScope: string | null;
  ownerGeneration: string | null;
  payloadJson: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type LegacyChatCloudImportCandidate = {
  conversationId: string;
  title: string;
  createdAt: number;
};

export type LegacyChatCloudImportRecord = {
  localConversationId: string;
  cloudConversationId: string | null;
  /** Null only for an untrusted pre-generation migration row. */
  ownerGeneration: string | null;
  nextTurnIndex: number;
  status: "pending" | "complete" | "skipped";
  detail: string | null;
  createdAt: number;
  updatedAt: number;
};

export type LegacyChatVisibleMessage = {
  id: string;
  type: "user_message" | "assistant_message";
  timestamp: number;
  payload: Record<string, unknown>;
};

type CloudTranscriptOutboxWrite = Omit<
  CloudTranscriptOutboxRecord,
  | "ownerGeneration"
  | "attempts"
  | "lastError"
  | "deadLetteredAt"
  | "createdAt"
  | "updatedAt"
> & { ownerGeneration: string };

const sameCloudTranscriptOutboxWrite = (
  existing: CloudTranscriptOutboxRecord,
  expected: CloudTranscriptOutboxWrite,
): boolean =>
  existing.id === expected.id &&
  existing.kind === expected.kind &&
  existing.conversationId === expected.conversationId &&
  existing.deviceId === expected.deviceId &&
  existing.ownerGeneration === expected.ownerGeneration &&
  existing.localTurnId === expected.localTurnId &&
  existing.payloadJson === expected.payloadJson &&
  existing.recoveryJson === expected.recoveryJson;

const CLOUD_TRANSCRIPT_OUTBOX_COLUMNS = `id,
  kind,
  conversation_id AS conversationId,
  device_id AS deviceId,
  owner_generation AS ownerGeneration,
  local_turn_id AS localTurnId,
  payload_json AS payloadJson,
  recovery_json AS recoveryJson,
  attempts,
  last_error AS lastError,
  dead_lettered_at AS deadLetteredAt,
  created_at AS createdAt,
  updated_at AS updatedAt`;

const CLOUD_JOURNAL_OUTBOX_COLUMNS = `sequence,
  id,
  conversation_id AS conversationId,
  device_id AS deviceId,
  owner_generation AS ownerGeneration,
  append_id AS appendId,
  payload_json AS payloadJson,
  attempts,
  last_error AS lastError,
  dead_lettered_at AS deadLetteredAt,
  created_at AS createdAt,
  updated_at AS updatedAt`;

const COMPUTER_AGENT_CLOUD_OUTBOX_COLUMNS = `sequence,
  id,
  kind,
  thread_id AS threadId,
  attempt_generation AS attemptGeneration,
  owner_scope AS ownerScope,
  owner_generation AS ownerGeneration,
  payload_json AS payloadJson,
  attempts,
  next_attempt_at AS nextAttemptAt,
  last_error AS lastError,
  created_at AS createdAt,
  updated_at AS updatedAt`;

export class SessionStore {
  readonly db: SqliteDatabase;
  readonly options: SessionStoreOptions;
  private readonly cached: CachedStatements;
  /** Conversations and their chat entries; callers read and write it directly. */
  readonly chat: ChatLog;
  /** Paged message windows over the chat log. */
  readonly messageWindows: MessageWindowReader;
  private readonly threads: ThreadLog;
  private readonly agents: AgentRegistry;
  private readonly transcriptOutbox: OutboxRepo<CloudTranscriptOutboxRecord>;
  private readonly journalOutbox: OutboxRepo<CloudJournalOutboxRecord>;
  private readonly computerAgentOutbox: OutboxRepo<ComputerAgentCloudOutboxRecord>;
  private threadSummaryStoreInstance: ThreadSummaryStore | null = null;
  private runTaskStoreInstance: RunTaskStore | null = null;
  private inTransaction = false;
  /**
   * Cloud turns keep their provider transcript in process memory until the
   * terminal batch is synchronously admitted to cloud_transcript_outbox.
   * Nothing in this map is restart recovery state: an orphaned durable begin
   * is intentionally recovered as an empty canceled finish.
   */
  private readonly ephemeralThreadCaptures = new Map<
    string,
    EphemeralThreadCapture
  >();

  constructor(db: SqliteDatabase, options: SessionStoreOptions = {}) {
    this.db = db;
    this.cached = cachedStatements(db);
    this.options = options;
    const tx = {
      immediate: (work: () => void) => void this.withImmediateTransaction(work),
    };
    this.chat = new ChatLog(db, tx);
    this.messageWindows = new MessageWindowReader(db, this.chat);
    this.threads = new ThreadLog(db, tx, (conversationId, updatedAt) =>
      this.chat.ensureConversation(conversationId, updatedAt),
    );
    this.agents = new AgentRegistry(db, {
      ensureConversation: (conversationId, updatedAt) =>
        this.chat.ensureConversation(conversationId, updatedAt),
      refreshThreadSearchText: (threadId) =>
        this.threads.refreshThreadSearchText(threadId),
    });
    this.transcriptOutbox = new OutboxRepo(
      this.cached,
      "cloud_transcript_outbox",
      {
        columns: CLOUD_TRANSCRIPT_OUTBOX_COLUMNS,
        orderBy: "attempts ASC, updated_at ASC, created_at ASC, id ASC",
        pendingWhere: "dead_lettered_at IS NULL",
        deadLetterClears: ["recovery_json"],
      },
    );
    this.journalOutbox = new OutboxRepo(this.cached, "cloud_journal_outbox", {
      columns: CLOUD_JOURNAL_OUTBOX_COLUMNS,
      orderBy: "sequence ASC",
      pendingWhere: "dead_lettered_at IS NULL",
    });
    this.computerAgentOutbox = new OutboxRepo(
      this.cached,
      "computer_agent_cloud_outbox",
      {
        columns: COMPUTER_AGENT_CLOUD_OUTBOX_COLUMNS,
        orderBy: "sequence ASC",
      },
    );
  }

  get threadSummaryStore(): ThreadSummaryStore {
    if (!this.threadSummaryStoreInstance) {
      this.threadSummaryStoreInstance = new ThreadSummaryStore(this.db);
    }
    return this.threadSummaryStoreInstance;
  }

  /** Durable runs + tool intents (`run_task`, `tool_intent`). */
  get runTasks(): RunTaskStore {
    if (!this.runTaskStoreInstance) {
      this.runTaskStoreInstance = new RunTaskStore(this.db, {
        transaction: (work) => this.withImmediateTransaction(work),
      });
    }
    return this.runTaskStoreInstance;
  }

  /**
   * Commit a run's durable progress atomically with whatever thread writes
   * `work` makes (pi-durable's commit callback): e.g. a turn's assistant/tool
   * group lands in `thread_entry` in the same transaction that clears the
   * run's pending checkpoint. Nested calls join the outer transaction.
   */
  commitRun<T>(work: (runTasks: RunTaskStore) => T): T {
    return this.withImmediateTransaction(() => work(this.runTasks));
  }

  /* ------------------------------------------------------------------ */
  /* Transactions                                                        */
  /* ------------------------------------------------------------------ */

  withTransaction<T>(work: () => T): T {
    return this.withImmediateTransaction(work);
  }

  withImmediateTransaction<T>(work: () => T): T {
    if (this.inTransaction) {
      return work();
    }
    this.db.exec("BEGIN IMMEDIATE;");
    this.inTransaction = true;
    try {
      const result = work();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* the transaction may already be gone */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Legacy chat cloud import (dev-only)                                 */
  /* ------------------------------------------------------------------ */

  listLegacyChatCloudImportCandidates(
    limit = 100,
  ): LegacyChatCloudImportCandidate[] {
    const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    return this.cached
      .prepare(
        `
      SELECT
        conversation.id AS conversationId,
        conversation.title AS title,
        conversation.created_at AS createdAt
      FROM conversation
      LEFT JOIN legacy_chat_cloud_import AS legacy_import
        ON legacy_import.local_conversation_id = conversation.id
      WHERE conversation.kind = 'chat'
        AND conversation.id NOT GLOB 'local_*'
        AND (
          legacy_import.status IS NULL
          OR legacy_import.status = 'pending'
        )
        AND EXISTS (
          SELECT 1
          FROM entry
          WHERE entry.conversation_id = conversation.id
            AND entry.type IN ('user_message', 'assistant_message')
        )
      ORDER BY conversation.created_at ASC, conversation.id ASC
      LIMIT ?
    `,
      )
      .all(normalizedLimit) as LegacyChatCloudImportCandidate[];
  }

  getLegacyChatCloudImport(
    localConversationIdInput: string,
  ): LegacyChatCloudImportRecord | null {
    const localConversationId = requireConversationId(localConversationIdInput);
    const row = this.cached
      .prepare(
        `
      SELECT
        local_conversation_id AS localConversationId,
        cloud_conversation_id AS cloudConversationId,
        owner_generation AS ownerGeneration,
        next_turn_index AS nextTurnIndex,
        status,
        detail,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM legacy_chat_cloud_import
      WHERE local_conversation_id = ?
      LIMIT 1
    `,
      )
      .get(localConversationId) as LegacyChatCloudImportRecord | undefined;
    return row ?? null;
  }

  saveLegacyChatCloudImport(args: {
    localConversationId: string;
    cloudConversationId?: string | null;
    ownerGeneration?: string | null;
    nextTurnIndex: number;
    status: "pending" | "complete" | "skipped";
    detail?: string | null;
  }): void {
    const localConversationId = requireConversationId(args.localConversationId);
    const cloudConversationId = asTrimmedString(args.cloudConversationId);
    const ownerGeneration = asTrimmedString(args.ownerGeneration);
    const nextTurnIndex = Math.max(0, Math.floor(args.nextTurnIndex));
    const detail = asTrimmedString(args.detail);
    const now = Date.now();
    this.withImmediateTransaction(() => {
      const existing = this.cached
        .prepare(
          `SELECT owner_generation AS ownerGeneration
             FROM legacy_chat_cloud_import
            WHERE local_conversation_id = ?
            LIMIT 1`,
        )
        .get(localConversationId) as
        | { ownerGeneration: string | null }
        | undefined;
      if (
        existing?.ownerGeneration &&
        ownerGeneration &&
        existing.ownerGeneration !== ownerGeneration
      ) {
        throw new Error(
          "Legacy chat import cannot be rebound to another owner generation.",
        );
      }
      this.cached
        .prepare(
          `
        INSERT INTO legacy_chat_cloud_import (
          local_conversation_id,
          cloud_conversation_id,
          owner_generation,
          next_turn_index,
          status,
          detail,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_conversation_id) DO UPDATE SET
          cloud_conversation_id = excluded.cloud_conversation_id,
          owner_generation = COALESCE(
            legacy_chat_cloud_import.owner_generation,
            excluded.owner_generation
          ),
          next_turn_index = excluded.next_turn_index,
          status = excluded.status,
          detail = excluded.detail,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          localConversationId,
          cloudConversationId || null,
          ownerGeneration || null,
          nextTurnIndex,
          args.status,
          detail || null,
          now,
          now,
        );
    });
  }

  listLegacyChatVisibleMessages(
    conversationIdInput: string,
  ): LegacyChatVisibleMessage[] {
    const conversationId = requireConversationId(conversationIdInput);
    const rows = this.cached
      .prepare(
        `
      SELECT
        entry.id AS id,
        entry.type AS type,
        entry.created_at AS timestamp,
        entry.payload AS payloadJson
      FROM entry
      WHERE entry.conversation_id = ?
        AND entry.type IN ('user_message', 'assistant_message')
      ORDER BY entry.seq ASC
    `,
      )
      .all(conversationId) as Array<{
      id: string;
      type: "user_message" | "assistant_message";
      timestamp: number;
      payloadJson: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      timestamp: row.timestamp,
      payload: parseJsonRecord(row.payloadJson) ?? {},
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Cloud agent thread controls and tool operations (dev-only)          */
  /* ------------------------------------------------------------------ */

  getCloudAgentThreadControl(
    threadIdInput: string,
    ownerGenerationInput: string,
  ): CloudAgentThreadControlRecord | null {
    const threadId = asTrimmedString(threadIdInput);
    const ownerGeneration = asTrimmedString(ownerGenerationInput);
    if (!threadId || !ownerGeneration) return null;
    const row = this.cached
      .prepare(
        `SELECT
           thread_id AS threadId,
           owner_generation AS ownerGeneration,
           cloud_conversation_id AS cloudConversationId,
           origin_conversation_id AS originConversationId,
           attempt_generation AS attemptGeneration,
           thread_updated_at AS threadUpdatedAt,
           status,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM cloud_agent_thread_controls
         WHERE thread_id = ? AND owner_generation = ?
         LIMIT 1`,
      )
      .get(threadId, ownerGeneration) as
      | CloudAgentThreadControlRecord
      | undefined;
    return row ?? null;
  }

  /**
   * Monotonic control receipt merge. Attempt generation is the primary ABA
   * clock. Within one attempt, terminal beats running even when wall clocks
   * are equal/regressed; a delayed running receipt can never resurrect it.
   */
  putCloudAgentThreadControl(record: {
    threadId: string;
    ownerGeneration: string;
    cloudConversationId: string;
    originConversationId: string;
    attemptGeneration: number;
    threadUpdatedAt: number;
    status: CloudAgentControlStatus;
  }): CloudAgentThreadControlRecord {
    const threadId = asTrimmedString(record.threadId);
    const ownerGeneration = asTrimmedString(record.ownerGeneration);
    const cloudConversationId = asTrimmedString(record.cloudConversationId);
    const originConversationId = asTrimmedString(record.originConversationId);
    if (
      !threadId ||
      !ownerGeneration ||
      !cloudConversationId ||
      !originConversationId ||
      !Number.isSafeInteger(record.attemptGeneration) ||
      record.attemptGeneration < 1 ||
      !Number.isSafeInteger(record.threadUpdatedAt) ||
      record.threadUpdatedAt < 0 ||
      !["running", "completed", "failed", "canceled"].includes(record.status)
    ) {
      throw new Error("Invalid cloud agent control receipt.");
    }
    return this.withImmediateTransaction(() => {
      const existing = this.getCloudAgentThreadControl(
        threadId,
        ownerGeneration,
      );
      if (
        existing &&
        (existing.cloudConversationId !== cloudConversationId ||
          existing.originConversationId !== originConversationId)
      ) {
        throw new Error(
          "Cloud agent control receipt cannot be rebound to another conversation.",
        );
      }

      let replace = !existing;
      if (existing) {
        if (record.attemptGeneration > existing.attemptGeneration) {
          replace = true;
        } else if (record.attemptGeneration < existing.attemptGeneration) {
          replace = false;
        } else if (record.status === existing.status) {
          replace = record.threadUpdatedAt >= existing.threadUpdatedAt;
        } else if (
          existing.status === "running" &&
          record.status !== "running"
        ) {
          replace = true;
        } else if (
          existing.status !== "running" &&
          record.status === "running"
        ) {
          replace = false;
        } else {
          throw new Error(
            "Cloud agent control receipt has conflicting terminal states.",
          );
        }
      }

      if (replace) {
        const now = Date.now();
        this.cached
          .prepare(
            `INSERT INTO cloud_agent_thread_controls (
               thread_id,
               owner_generation,
               cloud_conversation_id,
               origin_conversation_id,
               attempt_generation,
               thread_updated_at,
               status,
               created_at,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(thread_id, owner_generation) DO UPDATE SET
               attempt_generation = excluded.attempt_generation,
               thread_updated_at = excluded.thread_updated_at,
               status = excluded.status,
               updated_at = excluded.updated_at`,
          )
          .run(
            threadId,
            ownerGeneration,
            cloudConversationId,
            originConversationId,
            record.attemptGeneration,
            record.threadUpdatedAt,
            record.status,
            now,
            now,
          );
      }
      const stored = this.getCloudAgentThreadControl(threadId, ownerGeneration);
      if (!stored)
        throw new Error("Cloud agent control receipt was not stored.");
      return stored;
    });
  }

  getCloudAgentToolOperation(
    operationIdInput: string,
  ): CloudAgentToolOperationRecord | null {
    const operationId = asTrimmedString(operationIdInput);
    if (!operationId) return null;
    const row = this.cached
      .prepare(
        `SELECT
           operation_id AS operationId,
           kind,
           fingerprint,
           owner_generation AS ownerGeneration,
           request_json AS requestJson,
           result_json AS resultJson,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM cloud_agent_tool_operations
         WHERE operation_id = ?
         LIMIT 1`,
      )
      .get(operationId) as CloudAgentToolOperationRecord | undefined;
    return row ?? null;
  }

  putCloudAgentToolOperation(record: {
    operationId: string;
    kind: CloudAgentToolOperationRecord["kind"];
    fingerprint: string;
    ownerGeneration: string;
    requestJson: string;
  }): CloudAgentToolOperationRecord {
    const operationId = asTrimmedString(record.operationId);
    const fingerprint = asTrimmedString(record.fingerprint);
    const ownerGeneration = asTrimmedString(record.ownerGeneration);
    if (
      !operationId ||
      !fingerprint ||
      !ownerGeneration ||
      !record.requestJson ||
      !["spawn", "continue", "cancel"].includes(record.kind)
    ) {
      throw new Error("Invalid cloud agent tool operation.");
    }
    return this.withImmediateTransaction(() => {
      const now = Date.now();
      this.cached
        .prepare(
          `INSERT OR IGNORE INTO cloud_agent_tool_operations (
             operation_id,
             kind,
             fingerprint,
             owner_generation,
             request_json,
             result_json,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          operationId,
          record.kind,
          fingerprint,
          ownerGeneration,
          record.requestJson,
          now,
          now,
        );
      const stored = this.getCloudAgentToolOperation(operationId);
      if (
        !stored ||
        stored.kind !== record.kind ||
        stored.fingerprint !== fingerprint ||
        stored.ownerGeneration !== ownerGeneration
      ) {
        throw new Error(
          "Cloud agent tool-call id was reused with different authority or intent.",
        );
      }
      return stored;
    });
  }

  updatePendingCloudAgentToolOperationRequest(
    operationIdInput: string,
    expectedRequestJson: string,
    replacementRequestJson: string,
  ): CloudAgentToolOperationRecord {
    const operationId = asTrimmedString(operationIdInput);
    if (!operationId || !expectedRequestJson || !replacementRequestJson) {
      throw new Error("Invalid cloud agent operation request replacement.");
    }
    return this.withImmediateTransaction(() => {
      const existing = this.getCloudAgentToolOperation(operationId);
      if (!existing)
        throw new Error("Cloud agent tool operation was not found.");
      if (existing.resultJson !== null) return existing;
      if (existing.requestJson !== expectedRequestJson) {
        throw new Error("Cloud agent operation request changed concurrently.");
      }
      this.cached
        .prepare(
          `UPDATE cloud_agent_tool_operations
           SET request_json = ?, updated_at = ?
           WHERE operation_id = ? AND result_json IS NULL`,
        )
        .run(replacementRequestJson, Date.now(), operationId);
      const stored = this.getCloudAgentToolOperation(operationId);
      if (!stored)
        throw new Error("Cloud agent tool operation was not stored.");
      return stored;
    });
  }

  completeCloudAgentToolOperation(
    operationIdInput: string,
    resultJson: string,
  ): CloudAgentToolOperationRecord {
    const operationId = asTrimmedString(operationIdInput);
    if (!operationId || !resultJson) {
      throw new Error("Invalid cloud agent tool operation result.");
    }
    return this.withImmediateTransaction(() => {
      const existing = this.getCloudAgentToolOperation(operationId);
      if (!existing)
        throw new Error("Cloud agent tool operation was not found.");
      if (existing.resultJson && existing.resultJson !== resultJson) {
        throw new Error(
          "Cloud agent tool operation returned conflicting results.",
        );
      }
      if (existing.resultJson === null) {
        this.cached
          .prepare(
            `UPDATE cloud_agent_tool_operations
             SET result_json = ?, updated_at = ?
             WHERE operation_id = ? AND result_json IS NULL`,
          )
          .run(resultJson, Date.now(), operationId);
      }
      const stored = this.getCloudAgentToolOperation(operationId);
      if (!stored)
        throw new Error("Cloud agent tool operation was not stored.");
      return stored;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Cloud transcript outbox (dev-only)                                  */
  /* ------------------------------------------------------------------ */

  putCloudTranscriptOutbox(record: CloudTranscriptOutboxWrite): void {
    const now = Date.now();
    this.withImmediateTransaction(() => {
      const existing = this.transcriptOutbox.get(record.id);
      if (existing) {
        if (!sameCloudTranscriptOutboxWrite(existing, record)) {
          throw new Error(
            "Cloud transcript turn id was reused with different authority or payload.",
          );
        }
        return;
      }
      this.insertCloudTranscriptOutbox(record, now);
    });
  }

  private insertCloudTranscriptOutbox(
    record: CloudTranscriptOutboxWrite,
    now: number,
  ): void {
    this.cached
      .prepare(
        `
      INSERT INTO cloud_transcript_outbox (
        id,
        kind,
        conversation_id,
        device_id,
        owner_generation,
        local_turn_id,
        payload_json,
        recovery_json,
        attempts,
        last_error,
        dead_lettered_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
    `,
      )
      .run(
        record.id,
        record.kind,
        record.conversationId,
        record.deviceId,
        record.ownerGeneration,
        record.localTurnId,
        record.payloadJson,
        record.recoveryJson,
        now,
        now,
      );
  }

  listCloudTranscriptOutbox(limit = 256): CloudTranscriptOutboxRecord[] {
    return this.transcriptOutbox.list(limit);
  }

  countCloudTranscriptOutbox(): number {
    return this.transcriptOutbox.count();
  }

  markCloudTranscriptOutboxAttempt(id: string, error?: string): void {
    this.transcriptOutbox.markAttempt(id, { error });
  }

  deleteCloudTranscriptOutbox(id: string): void {
    this.transcriptOutbox.delete(id);
  }

  deadLetterCloudTranscriptOutbox(id: string, reason: string): void {
    this.transcriptOutbox.deadLetter(id, reason);
  }

  /**
   * Atomically redacts a rejected finish and persists the device-specific
   * notice that explains the missing cloud output. A crash can therefore
   * leave either the retryable finish or the notice, never a silent dead
   * letter with its notification target already erased.
   */
  deadLetterCloudTranscriptOutboxWithFailureNotice(args: {
    id: string;
    reason: string;
    conversationId: string;
    deviceId: string;
    localTurnId: string;
    userMessageId: string;
    message: string;
  }): void {
    const now = Date.now();
    const conversationId = requireConversationId(args.conversationId);
    const eventId = `cloud-sync-error:${args.deviceId}:${args.localTurnId}`;
    const payload = {
      text: args.message.slice(0, 500),
      userMessageId: args.userMessageId,
      source: "cloud-sync-error",
    };
    this.withImmediateTransaction(() => {
      this.transcriptOutbox.deadLetter(args.id, args.reason);
      this.chat.appendEvent({
        conversationId,
        eventId,
        type: "assistant_message",
        timestamp: now,
        deviceId: args.deviceId,
        requestId: args.userMessageId,
        payload,
      });
    });
  }

  replaceCloudTranscriptOutbox(
    acknowledgedId: string,
    replacement: CloudTranscriptOutboxWrite,
  ): void {
    const now = Date.now();
    this.withImmediateTransaction(() => {
      const acknowledged = this.transcriptOutbox.get(acknowledgedId);
      const existingReplacement = this.transcriptOutbox.get(replacement.id);
      if (
        acknowledged &&
        (acknowledged.kind !== "begin" ||
          acknowledged.conversationId !== replacement.conversationId ||
          acknowledged.deviceId !== replacement.deviceId ||
          acknowledged.localTurnId !== replacement.localTurnId ||
          acknowledged.ownerGeneration !== replacement.ownerGeneration)
      ) {
        throw new Error(
          "Cloud transcript finish does not match its admitted begin authority.",
        );
      }
      if (existingReplacement) {
        if (!sameCloudTranscriptOutboxWrite(existingReplacement, replacement)) {
          throw new Error(
            "Cloud transcript finish id was reused with different authority or payload.",
          );
        }
      } else {
        if (!acknowledged) {
          throw new Error(
            "Cloud transcript finish has no matching admitted begin.",
          );
        }
        this.insertCloudTranscriptOutbox(replacement, now);
      }
      this.transcriptOutbox.delete(acknowledgedId);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Cloud journal outbox and voice receipts (dev-only)                  */
  /* ------------------------------------------------------------------ */

  putCloudJournalOutbox(record: {
    id: string;
    conversationId: string;
    deviceId: string;
    ownerGeneration: string;
    appendId: string;
    payloadJson: string;
  }): { replayed: boolean } {
    const ownerGeneration = asTrimmedString(record.ownerGeneration);
    if (!ownerGeneration || ownerGeneration.length > 512) {
      throw new Error("Cloud journal owner generation is invalid.");
    }
    return this.withImmediateTransaction(() => {
      const admitted = this.cached
        .prepare(
          `SELECT payload_json AS payloadJson
             FROM cloud_journal_admission_receipts WHERE id = ?`,
        )
        .get(record.id) as { payloadJson?: unknown } | undefined;
      if (
        typeof admitted?.payloadJson === "string" &&
        admitted.payloadJson !== record.payloadJson
      ) {
        throw new Error("Cloud journal append id was reused with new payload.");
      }
      if (admitted) return { replayed: true };

      const now = Date.now();
      this.cached
        .prepare(
          `INSERT INTO cloud_journal_admission_receipts (
             id, payload_json, created_at
           ) VALUES (?, ?, ?)`,
        )
        .run(record.id, record.payloadJson, now);
      this.cached
        .prepare(
          `INSERT INTO cloud_journal_outbox (
             id, conversation_id, device_id, owner_generation, append_id, payload_json,
             attempts, last_error, dead_lettered_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
        )
        .run(
          record.id,
          record.conversationId,
          record.deviceId,
          ownerGeneration,
          record.appendId,
          record.payloadJson,
          now,
          now,
        );
      // One cheap indexed cleanup per admission keeps this operational dedupe
      // table bounded without coupling it to cloud delivery success.
      this.cached
        .prepare(
          `DELETE FROM cloud_journal_admission_receipts
            WHERE created_at < ?`,
        )
        .run(now - 30 * 24 * 60 * 60_000);
      return { replayed: false };
    });
  }

  beginVoiceToolCallReceipt(args: {
    conversationId: string;
    callId: string;
    requestFingerprint: string;
    operationId: string;
    startedAt: number;
  }): VoiceToolCallReceipt {
    const conversationId = requireConversationId(args.conversationId);
    const callId = asTrimmedString(args.callId);
    const requestFingerprint = asTrimmedString(args.requestFingerprint);
    const operationId = asTrimmedString(args.operationId);
    if (
      !callId ||
      !requestFingerprint ||
      !operationId ||
      !Number.isSafeInteger(args.startedAt) ||
      args.startedAt < 0
    ) {
      throw new Error("Voice tool receipt identity is invalid.");
    }
    return this.withImmediateTransaction(() => {
      const existing = this.cached
        .prepare(
          `SELECT request_fingerprint AS requestFingerprint,
                  operation_id AS operationId,
                  started_at AS startedAt,
                  completion_json AS completionJson
             FROM voice_tool_call_receipts
            WHERE conversation_id = ? AND call_id = ?`,
        )
        .get(conversationId, callId) as
        | {
            requestFingerprint?: unknown;
            operationId?: unknown;
            startedAt?: unknown;
            completionJson?: unknown;
          }
        | undefined;
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new Error(
            "Voice tool call id was reused with different arguments.",
          );
        }
        const existingOperationId = asTrimmedString(existing.operationId);
        const existingStartedAt = asFiniteNumber(existing.startedAt);
        if (!existingOperationId || existingStartedAt === null) {
          throw new Error("Voice tool receipt is malformed.");
        }
        return typeof existing.completionJson === "string"
          ? {
              status: "completed" as const,
              operationId: existingOperationId,
              startedAt: existingStartedAt,
              completionJson: existing.completionJson,
            }
          : {
              status: "pending" as const,
              operationId: existingOperationId,
              startedAt: existingStartedAt,
            };
      }
      this.cached
        .prepare(
          `INSERT INTO voice_tool_call_receipts (
             conversation_id, call_id, request_fingerprint, operation_id,
             started_at, completion_json, completed_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          conversationId,
          callId,
          requestFingerprint,
          operationId,
          args.startedAt,
          args.startedAt,
        );
      return {
        status: "started" as const,
        operationId,
        startedAt: args.startedAt,
      };
    });
  }

  completeVoiceToolCallReceipt(args: {
    conversationId: string;
    callId: string;
    requestFingerprint: string;
    completionJson: string;
  }): void {
    const conversationId = requireConversationId(args.conversationId);
    const callId = asTrimmedString(args.callId);
    const requestFingerprint = asTrimmedString(args.requestFingerprint);
    if (!callId || !requestFingerprint || !args.completionJson) {
      throw new Error("Voice tool completion is invalid.");
    }
    this.withImmediateTransaction(() => {
      const existing = this.cached
        .prepare(
          `SELECT request_fingerprint AS requestFingerprint,
                  completion_json AS completionJson
             FROM voice_tool_call_receipts
            WHERE conversation_id = ? AND call_id = ?`,
        )
        .get(conversationId, callId) as
        | { requestFingerprint?: unknown; completionJson?: unknown }
        | undefined;
      if (!existing || existing.requestFingerprint !== requestFingerprint) {
        throw new Error("Voice tool receipt does not own this completion.");
      }
      if (typeof existing.completionJson === "string") {
        if (existing.completionJson !== args.completionJson) {
          throw new Error(
            "Voice tool call was completed with a different result.",
          );
        }
        return;
      }
      const now = Date.now();
      this.cached
        .prepare(
          `UPDATE voice_tool_call_receipts
              SET completion_json = ?, completed_at = ?, updated_at = ?
            WHERE conversation_id = ? AND call_id = ?
              AND completion_json IS NULL`,
        )
        .run(args.completionJson, now, now, conversationId, callId);
    });
  }

  listCloudJournalOutbox(limit = 256): CloudJournalOutboxRecord[] {
    return this.journalOutbox.list(limit);
  }

  countCloudJournalOutbox(): number {
    return this.journalOutbox.count();
  }

  markCloudJournalOutboxAttempt(id: string, error?: string): void {
    this.journalOutbox.markAttempt(id, { error });
  }

  deleteCloudJournalOutbox(id: string): void {
    this.journalOutbox.delete(id);
  }

  deadLetterCloudJournalOutbox(id: string, reason: string): void {
    this.journalOutbox.deadLetter(id, reason);
  }

  /* ------------------------------------------------------------------ */
  /* Computer agent cloud records (dev-only)                             */
  /* ------------------------------------------------------------------ */

  putComputerAgentCloudOutbox(record: {
    id: string;
    kind: ComputerAgentCloudOutboxKind;
    threadId: string;
    attemptGeneration: number;
    ownerScope: string | null;
    ownerGeneration: string | null;
    payloadJson: string;
  }): void {
    const now = Date.now();
    this.cached
      .prepare(
        `INSERT INTO computer_agent_cloud_outbox (
           id, kind, thread_id, attempt_generation, owner_scope,
           owner_generation, payload_json,
           attempts, next_attempt_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           next_attempt_at = MIN(
             computer_agent_cloud_outbox.next_attempt_at,
             excluded.next_attempt_at
           ),
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.kind,
        record.threadId,
        record.attemptGeneration,
        record.ownerScope,
        record.ownerGeneration,
        record.payloadJson,
        now,
        now,
        now,
      );
  }

  listComputerAgentCloudOutbox(
    ownerScope: string,
    limit = 256,
  ): ComputerAgentCloudOutboxRecord[] {
    return this.computerAgentOutbox.list(limit, {
      where: "owner_scope = ?",
      params: [ownerScope],
    });
  }

  countComputerAgentCloudOutbox(): number {
    return this.computerAgentOutbox.count();
  }

  markComputerAgentCloudOutboxRetry(args: {
    id: string;
    error: string;
    nextAttemptAt: number;
  }): void {
    this.computerAgentOutbox.markAttempt(args.id, {
      error: args.error,
      nextAttemptAt: args.nextAttemptAt,
    });
  }

  resumeComputerAgentCloudOutbox(ownerScope: string): void {
    const now = Date.now();
    this.cached
      .prepare(
        `UPDATE computer_agent_cloud_outbox
            SET next_attempt_at = MIN(next_attempt_at, ?),
                updated_at = ?
          WHERE owner_scope = ? AND next_attempt_at > ?`,
      )
      .run(now, now, ownerScope, now);
  }

  getComputerAgentCloudThreadOwnerScope(threadId: string): string | null {
    const row = this.cached
      .prepare(
        `SELECT owner_scope AS ownerScope
           FROM computer_agent_cloud_thread_owners
          WHERE thread_id = ?
          LIMIT 1`,
      )
      .get(threadId) as { ownerScope?: unknown } | undefined;
    return typeof row?.ownerScope === "string" && row.ownerScope.trim()
      ? row.ownerScope
      : null;
  }

  getComputerAgentCloudThreadAuthority(
    threadId: string,
  ): { ownerScope: string; ownerGeneration: string } | null {
    const row = this.cached
      .prepare(
        `SELECT owner_scope AS ownerScope,
                owner_generation AS ownerGeneration
           FROM computer_agent_cloud_thread_owners
          WHERE thread_id = ?
          LIMIT 1`,
      )
      .get(threadId) as
      | { ownerScope?: unknown; ownerGeneration?: unknown }
      | undefined;
    return typeof row?.ownerScope === "string" &&
      row.ownerScope.trim() &&
      typeof row.ownerGeneration === "string" &&
      row.ownerGeneration.trim()
      ? {
          ownerScope: row.ownerScope,
          ownerGeneration: row.ownerGeneration,
        }
      : null;
  }

  hasUnscopedComputerAgentCloudOutbox(threadId: string): boolean {
    return Boolean(
      this.cached
        .prepare(
          `SELECT 1
             FROM computer_agent_cloud_outbox
            WHERE thread_id = ?
              AND (owner_scope IS NULL OR owner_generation IS NULL)
            LIMIT 1`,
        )
        .get(threadId),
    );
  }

  isComputerAgentCloudGenerationRetired(args: {
    threadId: string;
    ownerScope: string;
    ownerGeneration: string;
  }): boolean {
    return Boolean(
      this.cached
        .prepare(
          `SELECT 1
             FROM computer_agent_cloud_retired_generations
            WHERE thread_id = ?
              AND owner_scope = ?
              AND owner_generation = ?
            LIMIT 1`,
        )
        .get(args.threadId, args.ownerScope, args.ownerGeneration),
    );
  }

  bindComputerAgentCloudThreadOwnerScope(
    threadId: string,
    ownerScope: string,
  ): string {
    const now = Date.now();
    this.cached
      .prepare(
        `INSERT INTO computer_agent_cloud_thread_owners (
           thread_id, owner_scope, created_at, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      )
      .run(threadId, ownerScope, now, now);
    return this.getComputerAgentCloudThreadOwnerScope(threadId) ?? ownerScope;
  }

  bindComputerAgentCloudThreadAuthority(
    threadId: string,
    ownerScope: string,
    ownerGeneration: string,
  ): { ownerScope: string; ownerGeneration: string } | null {
    const now = Date.now();
    return this.withImmediateTransaction(() => {
      if (
        this.isComputerAgentCloudGenerationRetired({
          threadId,
          ownerScope,
          ownerGeneration,
        })
      ) {
        return null;
      }
      const existing = this.cached
        .prepare(
          `SELECT owner_scope AS ownerScope,
                  owner_generation AS ownerGeneration
             FROM computer_agent_cloud_thread_owners
            WHERE thread_id = ?`,
        )
        .get(threadId) as
        | { ownerScope?: unknown; ownerGeneration?: unknown }
        | undefined;
      if (
        existing &&
        (existing.ownerScope !== ownerScope ||
          typeof existing.ownerGeneration !== "string")
      ) {
        return null;
      }
      if (existing && existing.ownerGeneration !== ownerGeneration) {
        // A newly admitted epoch tombstones queued work from the prior epoch
        // before rebinding the mutable thread id. Persist the tombstone first
        // so a late retry cannot reverse the transition back to the old epoch.
        this.cached
          .prepare(
            `INSERT OR IGNORE INTO computer_agent_cloud_retired_generations (
               thread_id, owner_scope, owner_generation, retired_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(threadId, ownerScope, existing.ownerGeneration, now);
        this.cached
          .prepare(
            `DELETE FROM computer_agent_cloud_outbox
              WHERE thread_id = ?
                AND owner_scope = ?
                AND owner_generation = ?`,
          )
          .run(threadId, ownerScope, existing.ownerGeneration);
      }
      this.cached
        .prepare(
          `INSERT INTO computer_agent_cloud_thread_owners (
             thread_id, owner_scope, owner_generation, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             owner_generation = excluded.owner_generation,
             updated_at = excluded.updated_at
           WHERE computer_agent_cloud_thread_owners.owner_scope = excluded.owner_scope`,
        )
        .run(threadId, ownerScope, ownerGeneration, now, now);
      return this.getComputerAgentCloudThreadAuthority(threadId);
    });
  }

  retireComputerAgentCloudGeneration(args: {
    threadId: string;
    ownerScope: string;
    ownerGeneration: string;
  }): void {
    this.withImmediateTransaction(() => {
      this.cached
        .prepare(
          `INSERT OR IGNORE INTO computer_agent_cloud_retired_generations (
             thread_id, owner_scope, owner_generation, retired_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(args.threadId, args.ownerScope, args.ownerGeneration, Date.now());
      this.cached
        .prepare(
          `DELETE FROM computer_agent_cloud_outbox
            WHERE thread_id = ?
              AND owner_scope = ?
              AND owner_generation = ?`,
        )
        .run(args.threadId, args.ownerScope, args.ownerGeneration);
      this.cached
        .prepare(
          `DELETE FROM computer_agent_cloud_thread_owners
            WHERE thread_id = ?
              AND owner_scope = ?
              AND owner_generation = ?`,
        )
        .run(args.threadId, args.ownerScope, args.ownerGeneration);
    });
  }

  deleteComputerAgentCloudOutbox(id: string): void {
    this.computerAgentOutbox.delete(id);
  }

  /* ------------------------------------------------------------------ */
  /* Thread transcripts                                                  */
  /* ------------------------------------------------------------------ */

  deriveImplicitThreadMetadata(threadKey: string) {
    return this.threads.deriveImplicitThreadMetadata(threadKey);
  }

  ensureImplicitThreadRow(threadKey: string) {
    return this.threads.ensureImplicitThreadRow(threadKey);
  }

  getThreadConversationId(threadKey: string): string {
    return this.threads.getThreadConversationId(threadKey);
  }

  getThreadSession(threadKey: string) {
    return this.threads.getThreadSession(threadKey);
  }

  ensureThreadSession(
    threadKey: string,
    conversationId: string,
    timestamp: number,
  ) {
    return this.threads.ensureThreadSession(
      threadKey,
      conversationId,
      timestamp,
    );
  }

  getThreadLeafEntryId(threadKey: string): string | null {
    return this.threads.getThreadLeafEntryId(threadKey);
  }

  appendThreadMessage(message: ThreadMessageInput): void {
    this.appendThreadMessages([message]);
  }

  appendThreadMessages(messages: ThreadMessageInput[]): void {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const captureThreadKey = normalizeRuntimeThreadId(messages[0]!.threadKey);
    const capture = captureThreadKey
      ? this.ephemeralThreadCaptures.get(captureThreadKey)
      : undefined;
    if (capture && captureThreadKey) {
      // Cloud-owned turn: the provider transcript stays in process memory and
      // is admitted to the durable cloud outbox at the turn boundary. Nothing
      // is written to thread_entry.
      for (const message of messages) {
        if (normalizeRuntimeThreadId(message.threadKey) !== captureThreadKey) {
          throw new Error(
            "All thread messages in a batch must use the same threadKey.",
          );
        }
        const payload = enforceThreadPayloadRowSizeLimit(
          buildFallbackThreadPayload(message),
        );
        capture.appendedMessages.push({
          ...message,
          threadKey: captureThreadKey,
          role: payload.role,
          payload,
          entryId: `ephemeral:${capture.captureId}:${capture.appendedMessages.length}`,
        } as EphemeralThreadMessage);
      }
      return;
    }
    const appended = this.threads.appendThreadMessages(messages);
    for (const { entryId, message, payload, conversationId } of appended) {
      if (!entryId) continue;
      try {
        this.options.onThreadTranscriptUpdate?.({
          conversationId,
          transcriptUpdate: {
            source: "stella",
            threadId: message.threadKey,
            entryId,
            atMs: message.timestamp,
          },
        });
        if (payload.role === "assistant") {
          this.emitThreadAssistantUpdate(message.threadKey, message.timestamp);
        }
      } catch {
        /* notification failures never fail the write */
      }
    }
  }

  appendThreadCustomMessage(
    message: Parameters<ThreadLog["appendThreadCustomMessage"]>[0],
  ): void {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    const capture = threadKey
      ? this.ephemeralThreadCaptures.get(threadKey)
      : undefined;
    if (capture && threadKey && !message.eventId?.trim()) {
      // A cloud-owned turn keeps its hidden prompt rows with the rest of its
      // transcript in process memory. Keyed events (task lifecycle) stay
      // durable so `hasThreadCustomEvent` still dedupes them.
      capture.appendedMessages.push({
        threadKey,
        entryId: `ephemeral:${capture.captureId}:${capture.appendedMessages.length}`,
        timestamp: message.timestamp,
        role: "runtimeInternal",
        content: customMessageContentText(message.content),
        customMessage: {
          customType: message.customType.trim(),
          content: message.content,
          display: message.display,
        },
      } as EphemeralThreadMessage);
      return;
    }
    this.threads.appendThreadCustomMessage(message);
  }

  appendThreadLifecycleEvent(
    message: Parameters<ThreadLog["appendThreadLifecycleEvent"]>[0],
  ): void {
    this.threads.appendThreadLifecycleEvent(message);
  }

  hasThreadLifecycleEvent(threadKey: string, eventId: string): boolean {
    return this.threads.hasThreadLifecycleEvent(threadKey, eventId);
  }

  hasThreadCustomEvent(
    threadKey: string,
    customType: string,
    eventId: string,
  ): boolean {
    return this.threads.hasThreadCustomEvent(threadKey, customType, eventId);
  }

  listThreadLifecycleEntries(threadKey: string, limit?: number) {
    return this.threads.listThreadLifecycleEntries(threadKey, limit);
  }

  listRecentThreadUserMessages(threadKey: string, limit?: number) {
    return this.threads.listRecentThreadUserMessages(threadKey, limit);
  }

  loadThreadMessages(threadKey: string, limit?: number) {
    const captureThreadKey = normalizeRuntimeThreadId(threadKey);
    const capture = captureThreadKey
      ? this.ephemeralThreadCaptures.get(captureThreadKey)
      : undefined;
    const messages = capture
      ? [...capture.seedMessages, ...capture.appendedMessages]
      : this.threads.loadThreadMessages(threadKey, limit);
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    return (
      capture && normalizedLimit ? messages.slice(-normalizedLimit) : messages
    ).map((message) => ({
      ...(message.entryId ? { entryId: message.entryId } : {}),
      timestamp: message.timestamp,
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.payload ? { payload: message.payload } : {}),
      ...(message.customMessage
        ? { customMessage: message.customMessage }
        : {}),
      ...(message.checkpointQuarantineKeys
        ? { checkpointQuarantineKeys: message.checkpointQuarantineKeys }
        : {}),
      ...(message.checkpointImageReceipts
        ? { checkpointImageReceipts: message.checkpointImageReceipts }
        : {}),
    }));
  }

  loadRawThreadMessages(threadKey: string) {
    return this.threads.loadRawThreadMessages(threadKey).map((message) => ({
      ...(message.entryId ? { entryId: message.entryId } : {}),
      timestamp: message.timestamp,
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.payload ? { payload: message.payload } : {}),
      ...(message.customMessage
        ? { customMessage: message.customMessage }
        : {}),
    }));
  }

  /**
   * Raw durable projection for exact transcript consumers, keeping the typed
   * entry structure (and the active ephemeral capture when a cloud turn owns
   * the thread). The limit applies after projection so display-only storage
   * rows cannot crowd authored messages out of the window.
   */
  loadRawThreadMessagesWithEntryTypes(
    threadKeyInput: string,
    limit?: number,
  ): Array<RuntimeThreadMessage & { entryId: string }> {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) throw new Error("threadKey is required.");
    const capture = this.ephemeralThreadCaptures.get(threadKey);
    const raw = capture
      ? [...capture.seedMessages, ...capture.appendedMessages]
      : (this.threads.loadRawThreadMessages(threadKey) as Array<
          RuntimeThreadMessage & { entryId: string }
        >);
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    return normalizedLimit ? raw.slice(-normalizedLimit) : raw;
  }

  /* ------------------------------------------------------------------ */
  /* Ephemeral thread capture (dev-only)                                 */
  /* ------------------------------------------------------------------ */

  beginEphemeralThreadCapture(args: {
    threadKey: string;
    captureId: string;
    seedMessages?: Array<{
      timestamp?: number;
      role: string;
      content: string;
      toolCallId?: string;
      payload?: RuntimeThreadMessage["payload"];
      customMessage?: RuntimeThreadMessage["customMessage"];
    }>;
  }): void {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    const captureId = args.captureId.trim();
    if (!threadKey || !captureId) {
      throw new Error("threadKey and captureId are required.");
    }
    const existing = this.ephemeralThreadCaptures.get(threadKey);
    if (existing && existing.captureId !== captureId) {
      throw new Error("A different ephemeral thread capture is active.");
    }
    if (existing) return;
    const seedMessages = (args.seedMessages ?? []).map((message, index) => {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult" &&
        message.role !== "runtimeInternal"
      ) {
        throw new Error("Ephemeral thread capture seed has an invalid role.");
      }
      const role = message.role as RuntimeThreadMessage["role"];
      return {
        threadKey,
        entryId: `ephemeral:${captureId}:seed:${index}`,
        timestamp:
          typeof message.timestamp === "number" &&
          Number.isFinite(message.timestamp)
            ? message.timestamp
            : 0,
        role,
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.payload ? { payload: message.payload } : {}),
        ...(message.customMessage
          ? { customMessage: message.customMessage }
          : {}),
      };
    });
    this.ephemeralThreadCaptures.set(threadKey, {
      captureId,
      seedMessages,
      appendedMessages: [],
    });
  }

  readEphemeralThreadCapture(args: {
    threadKey: string;
    captureId: string;
  }): Array<RuntimeThreadMessage & { entryId: string }> {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    const capture = threadKey
      ? this.ephemeralThreadCaptures.get(threadKey)
      : undefined;
    if (!capture || capture.captureId !== args.captureId) {
      throw new Error("Ephemeral thread capture is not active.");
    }
    return capture.appendedMessages.map((message) => ({ ...message }));
  }

  endEphemeralThreadCapture(args: {
    threadKey: string;
    captureId: string;
  }): void {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    const capture = threadKey
      ? this.ephemeralThreadCaptures.get(threadKey)
      : undefined;
    if (!capture) return;
    if (capture.captureId !== args.captureId) {
      throw new Error("Ephemeral thread capture belongs to another run.");
    }
    this.ephemeralThreadCaptures.delete(threadKey!);
  }

  loadThreadSessionEntries(threadKey: string, limit?: number) {
    return this.threads.loadThreadSessionEntries(threadKey, limit);
  }

  findLatestRangeCompaction(threadKey: string) {
    return this.threads.findLatestRangeCompaction(threadKey);
  }

  getThreadContextPressureStats(threadKey: string) {
    return this.threads.getThreadContextPressureStats(threadKey);
  }

  compactThread(args: Parameters<ThreadLog["compactThread"]>[0]): void {
    // Cloud history is compacted by the Durable Object's bounded canonical
    // window. A background compaction scheduled during an ephemeral cloud turn
    // must never persist a summary of that cloud-only history into SQLite.
    const captureThreadKey = normalizeRuntimeThreadId(args.threadKey);
    if (
      captureThreadKey &&
      this.ephemeralThreadCaptures.has(captureThreadKey)
    ) {
      return;
    }
    const { entryId, conversationId, timestamp } =
      this.threads.compactThread(args);
    if (entryId) {
      this.options.onThreadTranscriptUpdate?.({
        conversationId,
        transcriptUpdate: {
          source: "stella",
          threadId: args.threadKey,
          entryId,
          atMs: timestamp,
        },
      });
    }
  }

  removeThreadMessageEntry(threadKey: string, entryId: string): boolean {
    return this.threads.removeThreadMessageEntry(threadKey, entryId);
  }

  listModelUsage(args: Parameters<ThreadLog["listModelUsage"]>[0] = {}) {
    return this.threads.listModelUsage(args);
  }

  /* ------------------------------------------------------------------ */
  /* Thread rows                                                         */
  /* ------------------------------------------------------------------ */

  listConversationAgents(conversationId: string) {
    return this.agents.listConversationAgents(conversationId);
  }

  listActiveThreadsByAge(conversationId: string) {
    return this.threads.listActiveThreadsByAge(conversationId);
  }

  evictOldestThread(conversationId: string): void {
    this.threads.evictOldestThread(conversationId);
  }

  reactivateThread(conversationId: string, threadId: string): void {
    this.threads.reactivateThread(conversationId, threadId);
  }

  threadKeyExists(key: string): boolean {
    return this.threads.threadKeyExists(key);
  }

  mintUniqueKey(base: string): string {
    return this.threads.mintUniqueKey(base);
  }

  mintThreadKey(args: { agentType: string; nameHint?: string }): string {
    return this.threads.mintThreadKey(args);
  }

  resolveOrCreateActiveThread(
    args: Parameters<ThreadLog["resolveOrCreateActiveThread"]>[0],
  ) {
    return this.threads.resolveOrCreateActiveThread(args);
  }

  touchThread(threadKey: string): void {
    this.threads.touchThread(threadKey);
  }

  getThreadExternalSessionId(threadKey: string): string | undefined {
    return this.threads.getThreadExternalSessionId(threadKey);
  }

  setThreadExternalSessionId(
    threadKey: string,
    externalSessionId: string | null | undefined,
  ): void {
    this.threads.setThreadExternalSessionId(threadKey, externalSessionId);
  }

  /**
   * Durable boundary of the external engine transcript that has been
   * delivered to this thread. Custom-message updates appended between turns
   * are injected from this durable boundary. (Dev-only.)
   */
  getThreadExternalDeliveredEntryId(threadKey: string): string | undefined {
    this.threads.ensureImplicitThreadRow(threadKey);
    const row = this.cached
      .prepare(
        `SELECT external_delivered_entry_id AS externalDeliveredEntryId
         FROM thread
         WHERE id = ?
         LIMIT 1`,
      )
      .get(threadKey) as { externalDeliveredEntryId?: unknown } | undefined;
    return typeof row?.externalDeliveredEntryId === "string" &&
      row.externalDeliveredEntryId.trim().length > 0
      ? row.externalDeliveredEntryId.trim()
      : undefined;
  }

  setThreadExternalDeliveredEntryId(
    threadKey: string,
    entryId: string | null | undefined,
  ): void {
    this.threads.ensureImplicitThreadRow(threadKey);
    const normalized =
      typeof entryId === "string" && entryId.trim().length > 0
        ? entryId.trim()
        : null;
    this.cached
      .prepare(
        `UPDATE thread
         SET external_delivered_entry_id = ?
         WHERE id = ?`,
      )
      .run(normalized, threadKey);
  }

  updateThreadSummary(threadKey: string, summary: string): void {
    this.threads.updateThreadSummary(threadKey, summary);
  }

  getThreadName(threadKey: string): string | undefined {
    return this.threads.getThreadName(threadKey);
  }

  getThreadActivityMetadata(threadId: string) {
    return this.threads.getThreadActivityMetadata(threadId);
  }

  /* ------------------------------------------------------------------ */
  /* Agents                                                              */
  /* ------------------------------------------------------------------ */

  saveAgentRecord(record: AgentRecordInput): number | null {
    return this.agents.saveAgentRecord(record);
  }

  getAgentRecord(threadId: string) {
    return this.agents.getAgentRecord(threadId);
  }

  listAgentRecordsByStatus(status: string) {
    return this.agents.listAgentRecordsByStatus(status);
  }

  listAgentAssistantMessagesByThread(
    targets: Parameters<AgentRegistry["listAgentAssistantMessagesByThread"]>[0],
    limit?: number,
  ) {
    return this.agents.listAgentAssistantMessagesByThread(targets, limit);
  }

  listAgentAssistantMessages(agentId: string, limit?: number) {
    return this.agents.listAgentAssistantMessages(agentId, limit);
  }

  selectBoundedThreadActivityIds(conversationId: string, maxItems: number) {
    return this.agents.selectBoundedThreadActivityIds(conversationId, maxItems);
  }

  listThreadActivity(
    conversationId: string,
    options: Parameters<AgentRegistry["listThreadActivity"]>[1] = {},
  ) {
    return this.agents.listThreadActivity(conversationId, options);
  }

  emitThreadAssistantUpdate(threadId: string, atMs: number): void {
    if (!this.options.onThreadAssistantUpdate) return;
    const record = this.agents.getAgentRecord(threadId);
    if (
      !record ||
      record.status !== "running" ||
      record.agentType !== "general" ||
      atMs < (record.startedAt as number)
    )
      return;
    const entries =
      this.agents
        .listAgentAssistantMessagesByThread([
          {
            threadId: record.threadId as string,
            startedAt: record.startedAt as number,
            attemptGeneration: record.attemptGeneration as number,
          },
        ])
        .get(record.threadId as string) ?? [];
    const latest = entries[entries.length - 1];
    if (!latest) return;
    const assistantMessages = entries.map((entry) => entry.text);
    this.options.onThreadAssistantUpdate({
      conversationId: record.conversationId,
      assistantUpdate: {
        threadId: record.threadId,
        assistantMessages,
        reasoningSummaries: [...assistantMessages],
        latestMessage: latest.text,
        atMs: latest.atMs,
        atSequence: latest.sequence,
        attemptGeneration: record.attemptGeneration,
        ...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
      },
    });
  }
}
