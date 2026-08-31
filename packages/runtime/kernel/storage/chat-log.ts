/**
 * Chat event log: conversations and their entries.
 *
 * Ordering is always `(conversation_id, seq)`; `seq` is claimed in code
 * inside the write transaction. `visible` and `turn_seq` are written at
 * insert time, so reads are plain indexed range queries instead of
 * cursor-inference passes.
 */

import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";
import {
  DEFAULT_CONVERSATION_SETTING_KEY,
  MAX_EVENTS_PER_CONVERSATION,
  asFiniteNumber,
  asObject,
  asTrimmedString,
  eventTextFromPayload,
  generateLocalId,
  parseJsonRecord,
  toJsonValueString,
  type LocalChatEventRecord,
  type SqliteDatabase,
} from "./shared.js";
import {
  EAGER_TOOL_EVENT_LIMIT,
  EAGER_TOOL_EVENT_SIDE_LIMIT,
  compareTimelineCursor,
  eventRoleForType,
  projectLocalChatUpdateEventWithMetadata,
  type Cursor,
} from "./view.js";

const CUTOFF_SCAN_CEILING = 4000;
const MAX_VISIBLE_MESSAGE_WINDOW = 500;

const CHAT_MESSAGE_TYPES = ["user_message", "assistant_message"] as const;
const TOOL_EVENT_TYPES = [
  "tool_request",
  "tool_result",
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
] as const;
const TIMELINE_EVENT_TYPES = [...CHAT_MESSAGE_TYPES, ...TOOL_EVENT_TYPES];
const LIFECYCLE_EVENT_TYPES = [
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
] as const;
/** Legacy event types that never surface through the event APIs. */
const NON_EVENT_TYPES = ["thread_message", "run_event", "memory"] as const;

const placeholders = (values: readonly unknown[]): string =>
  values.map(() => "?").join(", ");

type EntryRow = {
  _id: string;
  timestamp: number;
  sequence: number;
  type: string;
  deviceId: string | null;
  requestId: string | null;
  targetDeviceId: string | null;
  payloadJson: string | null;
  channelEnvelopeJson: string | null;
};

const ENTRY_SELECT = `
  entry.id AS _id,
  entry.created_at AS timestamp,
  entry.seq AS sequence,
  entry.type AS type,
  entry.device_id AS deviceId,
  entry.request_id AS requestId,
  entry.target_device_id AS targetDeviceId,
  entry.payload AS payloadJson,
  entry.channel_envelope AS channelEnvelopeJson
`;

export type ChatMessageRecord = LocalChatEventRecord & {
  toolEvents: LocalChatEventRecord[];
  toolEventSummary?: {
    totalCount: number;
    loadedCount: number;
    truncated: boolean;
    totalCountIsLowerBound?: boolean;
    detailLoaded?: boolean;
  };
};

export type ChatMessageWindow = {
  messages: ChatMessageRecord[];
  visibleMessageCount: number;
  nextCursor?: Cursor;
};

export const computeChatVisibility = (
  type: string,
  payload: Record<string, unknown> | undefined,
): number => {
  if (type !== "user_message" && type !== "assistant_message") return 0;
  return isUiHiddenChatMessagePayload((payload as never) ?? null) ? 0 : 1;
};

export const computeSearchText = (
  type: string,
  payload: Record<string, unknown> | undefined,
): string | null => {
  if (type !== "user_message" && type !== "assistant_message") return null;
  const text = payload?.text;
  return typeof text === "string" ? text : null;
};

export class ChatLog {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly tx: {
      immediate: (work: () => void) => void;
    },
  ) {}

  /* ------------------------------------------------------------------ */
  /* Conversations                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * A conversation the chat UI should list ("chat") is one with a
   * self-generated ULID id; ids minted by other subsystems (thread keys,
   * synthetic install/session ids) stay "derived" and never surface in the
   * conversation list. Computed once at creation instead of re-tested with
   * GLOB in every listing query.
   */
  static conversationKind(conversationId: string): "chat" | "derived" {
    return conversationId.length === 26 &&
      /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(conversationId)
      ? "chat"
      : "derived";
  }

  ensureConversation(conversationId: string, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO conversation (id, kind, title, status, next_seq, created_at, updated_at)
         VALUES (?, ?, '', 'active', 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = CASE
             WHEN excluded.updated_at > updated_at THEN excluded.updated_at
             ELSE updated_at
           END`,
      )
      .run(
        conversationId,
        ChatLog.conversationKind(conversationId),
        updatedAt,
        updatedAt,
      );
  }

  claimSeq(conversationId: string): number {
    const row = this.db
      .prepare(
        `UPDATE conversation SET next_seq = next_seq + 1
         WHERE id = ?
         RETURNING next_seq - 1 AS seq`,
      )
      .get(conversationId) as { seq?: number } | undefined;
    if (typeof row?.seq !== "number") {
      throw new Error(`Conversation ${conversationId} does not exist.`);
    }
    return row.seq;
  }

  conversationExists(conversationId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM conversation WHERE id = ? LIMIT 1")
        .get(conversationId),
    );
  }

  createConversation(): string {
    const created = generateLocalId();
    const createdAt = Date.now();
    this.tx.immediate(() => {
      this.ensureConversation(created, createdAt);
    });
    return created;
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value.length > 0
      ? row.value
      : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  getOrCreateDefaultConversationId(): string {
    const existing = this.getSetting(DEFAULT_CONVERSATION_SETTING_KEY);
    if (existing) {
      this.tx.immediate(() => {
        this.ensureConversation(existing, Date.now());
      });
      return existing;
    }
    const created = generateLocalId();
    const createdAt = Date.now();
    this.tx.immediate(() => {
      this.ensureConversation(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
    });
    return created;
  }

  createNewDefaultConversationId(): string {
    let resolvedConversationId = "";
    this.tx.immediate(() => {
      const activeConversationId = this.getSetting(
        DEFAULT_CONVERSATION_SETTING_KEY,
      );
      const reusable = this.db
        .prepare(
          `SELECT candidate.id
           FROM conversation AS candidate
           WHERE candidate.status = 'active'
             AND candidate.kind = 'chat'
             AND NOT EXISTS (
               SELECT 1 FROM agent WHERE agent.conversation_id = candidate.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM entry
               WHERE entry.conversation_id = candidate.id
                 AND entry.visible = 1
                 AND entry.payload IS NOT NULL
             )
           ORDER BY
             CASE WHEN candidate.id = ? THEN 0 ELSE 1 END,
             candidate.updated_at DESC,
             candidate.id DESC
           LIMIT 1`,
        )
        .get(activeConversationId ?? "") as { id?: unknown } | undefined;
      if (typeof reusable?.id === "string" && reusable.id) {
        resolvedConversationId = reusable.id;
        if (reusable.id !== activeConversationId) {
          this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, reusable.id);
        }
        return;
      }
      const created = generateLocalId();
      const createdAt = Date.now();
      this.ensureConversation(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
      resolvedConversationId = created;
    });
    return resolvedConversationId;
  }

  setActiveDefaultConversationId(conversationId: string): void {
    const now = Date.now();
    this.tx.immediate(() => {
      this.ensureConversation(conversationId, now);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, conversationId);
    });
  }

  listConversationSummaries(args: {
    limit?: number;
    cursor?: { updatedAt?: number; conversationId?: string } | null;
  }): {
    conversations: Array<{
      conversationId: string;
      title: string;
      latestMessageId?: string;
      latestMessageAt?: number;
      createdAt: number;
      updatedAt: number;
    }>;
    hasMore: boolean;
    nextCursor?: { updatedAt: number; conversationId: string };
  } {
    const requestedLimit = asFiniteNumber(args.limit);
    const limit = Math.min(100, Math.max(1, Math.floor(requestedLimit ?? 50)));
    const cursorUpdatedAt = asFiniteNumber(args.cursor?.updatedAt);
    const cursorConversationId = asTrimmedString(args.cursor?.conversationId);
    const hasCursor = cursorUpdatedAt !== null && Boolean(cursorConversationId);
    const rows = this.db
      .prepare(
        `WITH page AS (
           SELECT id, created_at, updated_at
           FROM conversation
           WHERE status = 'active' AND kind = 'chat'
             ${hasCursor ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))" : ""}
           ORDER BY updated_at DESC, id DESC
           LIMIT ?
         )
         SELECT
           page.id AS conversationId,
           page.created_at AS createdAt,
           page.updated_at AS updatedAt,
           latest.id AS latestMessageId,
           latest.created_at AS latestMessageAt,
           latest.payload AS payloadJson
         FROM page
         LEFT JOIN entry AS latest ON latest.rowid = (
           SELECT candidate.rowid
           FROM entry AS candidate
           WHERE candidate.conversation_id = page.id
             AND candidate.visible = 1
             AND candidate.search_text IS NOT NULL
             AND trim(candidate.search_text) <> ''
           ORDER BY candidate.seq DESC
           LIMIT 1
         )
         ORDER BY page.updated_at DESC, page.id DESC`,
      )
      .all(
        ...(hasCursor
          ? [cursorUpdatedAt, cursorUpdatedAt, cursorConversationId, limit + 1]
          : [limit + 1]),
      ) as Array<{
      conversationId: string;
      createdAt: number;
      updatedAt: number;
      latestMessageId: string | null;
      latestMessageAt: number | null;
      payloadJson: string | null;
    }>;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const conversations = pageRows.map((row) => {
      const payload = parseJsonRecord(row.payloadJson);
      const rawText = typeof payload?.text === "string" ? payload.text : "";
      const title = rawText.replace(/\s+/g, " ").trim().slice(0, 240);
      return {
        conversationId: row.conversationId,
        title: title || "New chat",
        ...(row.latestMessageId ? { latestMessageId: row.latestMessageId } : {}),
        ...(typeof row.latestMessageAt === "number"
          ? { latestMessageAt: row.latestMessageAt }
          : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
    const last = conversations.at(-1);
    return {
      conversations,
      hasMore,
      ...(hasMore && last
        ? {
            nextCursor: {
              updatedAt: last.updatedAt,
              conversationId: last.conversationId,
            },
          }
        : {}),
    };
  }

  deleteConversation(conversationId: string): boolean {
    const exists = this.conversationExists(conversationId);
    if (!exists) return false;
    const runningAgent = this.db
      .prepare(
        `SELECT 1 FROM agent
         WHERE conversation_id = ? AND status = 'running' LIMIT 1`,
      )
      .get(conversationId);
    if (runningAgent) {
      throw new Error("A conversation with running tasks cannot be deleted.");
    }
    this.tx.immediate(() => {
      this.db
        .prepare(
          `DELETE FROM blob WHERE id IN (
             SELECT blob_id FROM thread_entry
             JOIN thread ON thread.id = thread_entry.thread_id
             WHERE thread.conversation_id = ? AND blob_id IS NOT NULL
           )`,
        )
        .run(conversationId);
      this.db
        .prepare("DELETE FROM agent WHERE conversation_id = ?")
        .run(conversationId);
      this.db
        .prepare("DELETE FROM thread WHERE conversation_id = ?")
        .run(conversationId);
      this.db
        .prepare(
          "DELETE FROM runtime_conversation_state WHERE conversation_id = ?",
        )
        .run(conversationId);
      this.db
        .prepare("DELETE FROM settings WHERE key = ? AND value = ?")
        .run(DEFAULT_CONVERSATION_SETTING_KEY, conversationId);
      this.db
        .prepare("DELETE FROM conversation WHERE id = ?")
        .run(conversationId);
    });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Cursor helpers                                                      */
  /* ------------------------------------------------------------------ */

  resolveCursorSequence(conversationId: string, cursor: Cursor): Cursor;
  resolveCursorSequence(
    conversationId: string,
    cursor: Cursor | null,
  ): Cursor | null;
  resolveCursorSequence(
    conversationId: string,
    cursor: Cursor | null,
  ): Cursor | null {
    if (!cursor) return cursor;
    if (typeof cursor.sequence === "number") return cursor;
    if (typeof cursor.id !== "string" || cursor.id.length === 0) return cursor;
    const row = this.db
      .prepare(
        "SELECT seq AS sequence FROM entry WHERE conversation_id = ? AND id = ? LIMIT 1",
      )
      .get(conversationId, cursor.id) as { sequence?: number } | undefined;
    return typeof row?.sequence === "number"
      ? { ...cursor, sequence: row.sequence }
      : cursor;
  }

  /**
   * Keyset predicate for a cursor. Uses the sequence when the cursor
   * resolves to a stored entry, and falls back to `(created_at, id)` for
   * cursors that no longer resolve (e.g. after truncation).
   */
  private keyset(
    op: ">" | ">=" | "<" | "<=",
    cursor: Cursor,
  ): { clause: string; params: unknown[] } {
    if (typeof cursor.sequence === "number" && Number.isFinite(cursor.sequence)) {
      return { clause: `entry.seq ${op} ?`, params: [cursor.sequence] };
    }
    const outer = op === ">" || op === ">=" ? ">" : "<";
    return {
      clause: `(entry.created_at ${outer} ? OR (entry.created_at = ? AND entry.id ${op} ?))`,
      params: [cursor.timestamp, cursor.timestamp, cursor.id],
    };
  }

  getEventCursor(conversationId: string, eventIdInput: string): Cursor | null {
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return null;
    const row = this.db
      .prepare(
        `SELECT id AS _id, created_at AS timestamp, seq AS sequence
         FROM entry WHERE conversation_id = ? AND id = ? LIMIT 1`,
      )
      .get(conversationId, eventId) as
      | { _id: string; timestamp: number; sequence: number }
      | undefined;
    if (!row) return null;
    return { id: row._id, timestamp: row.timestamp, sequence: row.sequence };
  }

  /* ------------------------------------------------------------------ */
  /* Writes                                                              */
  /* ------------------------------------------------------------------ */

  private lastVisibleUserSeq(
    conversationId: string,
    atOrBeforeSeq?: number,
  ): number | null {
    const row = this.db
      .prepare(
        `SELECT seq FROM entry
         WHERE conversation_id = ? AND type = 'user_message' AND visible = 1
           ${typeof atOrBeforeSeq === "number" ? "AND seq <= ?" : ""}
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(
        ...(typeof atOrBeforeSeq === "number"
          ? [conversationId, atOrBeforeSeq]
          : [conversationId]),
      ) as { seq?: number } | undefined;
    return typeof row?.seq === "number" ? row.seq : null;
  }

  /** Recompute turn ownership for entries at/after a seq (rare repair path). */
  private reassignTurns(conversationId: string, fromSeq: number): void {
    this.db
      .prepare(
        `UPDATE entry SET turn_seq = (
           SELECT turn_source.seq FROM entry AS turn_source
           WHERE turn_source.conversation_id = entry.conversation_id
             AND turn_source.type = 'user_message'
             AND turn_source.visible = 1
             AND turn_source.seq <= entry.seq
           ORDER BY turn_source.seq DESC LIMIT 1
         )
         WHERE conversation_id = ? AND seq >= ?`,
      )
      .run(conversationId, fromSeq);
  }

  /**
   * Insert-or-update one event by id. Must run inside a transaction.
   * Returns the stored cursor.
   */
  upsertEvent(args: {
    conversationId: string;
    eventId: string;
    type: string;
    timestamp: number;
    deviceId?: string;
    requestId?: string;
    targetDeviceId?: string;
    runId?: string;
    agentType?: string;
    payload?: Record<string, unknown>;
    channelEnvelope?: Record<string, unknown>;
  }): Cursor {
    const visible = computeChatVisibility(args.type, args.payload);
    const searchText = computeSearchText(args.type, args.payload);
    const payloadJson = toJsonValueString(args.payload ?? null);
    const envelopeJson = toJsonValueString(args.channelEnvelope ?? null);
    const existing = this.db
      .prepare(
        `SELECT conversation_id AS conversationId, seq, visible
         FROM entry WHERE id = ? LIMIT 1`,
      )
      .get(args.eventId) as
      | { conversationId: string; seq: number; visible: number }
      | undefined;
    if (existing && existing.conversationId !== args.conversationId) {
      this.db.prepare("DELETE FROM entry WHERE id = ?").run(args.eventId);
    }
    if (existing && existing.conversationId === args.conversationId) {
      this.db
        .prepare(
          `UPDATE entry SET
             type = ?, role = ?, visible = ?,
             device_id = ?, request_id = ?, target_device_id = ?,
             run_id = COALESCE(?, run_id),
             agent_type = COALESCE(?, agent_type),
             payload = ?, channel_envelope = ?, search_text = ?,
             created_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          args.type,
          eventRoleForType(args.type),
          visible,
          args.deviceId ?? null,
          args.requestId ?? null,
          args.targetDeviceId ?? null,
          args.runId ?? null,
          args.agentType ?? null,
          payloadJson,
          envelopeJson,
          searchText,
          args.timestamp,
          args.timestamp,
          args.eventId,
        );
      if (args.type === "user_message" && existing.visible !== visible) {
        this.reassignTurns(args.conversationId, existing.seq);
      }
      return {
        id: args.eventId,
        timestamp: args.timestamp,
        sequence: existing.seq,
      };
    }
    const seq = this.claimSeq(args.conversationId);
    const turnSeq =
      args.type === "user_message" && visible === 1
        ? seq
        : this.lastVisibleUserSeq(args.conversationId);
    this.db
      .prepare(
        `INSERT INTO entry (
           conversation_id, seq, id, type, role, visible, turn_seq,
           device_id, request_id, target_device_id, run_id, agent_type,
           payload, channel_envelope, search_text, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.conversationId,
        seq,
        args.eventId,
        args.type,
        eventRoleForType(args.type),
        visible,
        turnSeq,
        args.deviceId ?? null,
        args.requestId ?? null,
        args.targetDeviceId ?? null,
        args.runId ?? null,
        args.agentType ?? null,
        payloadJson,
        envelopeJson,
        searchText,
        args.timestamp,
        args.timestamp,
      );
    return { id: args.eventId, timestamp: args.timestamp, sequence: seq };
  }

  appendEvent(args: {
    conversationId: string;
    type: string;
    payload?: unknown;
    deviceId?: string;
    requestId?: string;
    targetDeviceId?: string;
    channelEnvelope?: unknown;
    timestamp?: number;
    eventId?: string;
  }): LocalChatEventRecord {
    const type = asTrimmedString(args.type);
    if (!type) {
      throw new Error("type is required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const eventId = asTrimmedString(args.eventId) || `local-${generateLocalId()}`;
    const payload = asObject(args.payload) ?? undefined;
    const channelEnvelope = asObject(args.channelEnvelope) ?? undefined;
    const deviceId = asTrimmedString(args.deviceId) || undefined;
    const requestId = asTrimmedString(args.requestId) || undefined;
    const targetDeviceId = asTrimmedString(args.targetDeviceId) || undefined;
    let cursor: Cursor | null = null;
    this.tx.immediate(() => {
      this.ensureConversation(args.conversationId, timestamp);
      cursor = this.upsertEvent({
        conversationId: args.conversationId,
        eventId,
        type,
        timestamp,
        deviceId,
        requestId,
        targetDeviceId,
        payload,
        channelEnvelope,
      });
    });
    return {
      _id: eventId,
      timestamp,
      ...(cursor && typeof (cursor as Cursor).sequence === "number"
        ? { sequence: (cursor as Cursor).sequence }
        : {}),
      type,
      ...(deviceId ? { deviceId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(targetDeviceId ? { targetDeviceId } : {}),
      ...(payload ? { payload } : {}),
      ...(channelEnvelope ? { channelEnvelope } : {}),
    };
  }

  mergeEventPayload(args: {
    conversationId: string;
    eventId: string;
    patch: Record<string, unknown>;
  }): LocalChatEventRecord | null {
    const eventId = asTrimmedString(args.eventId);
    if (!eventId) return null;
    let updatedRecord: LocalChatEventRecord | null = null;
    this.tx.immediate(() => {
      const existingRow = this.db
        .prepare(
          `SELECT ${ENTRY_SELECT} FROM entry
           WHERE entry.id = ? AND entry.conversation_id = ?`,
        )
        .get(eventId, args.conversationId) as EntryRow | undefined;
      if (!existingRow) {
        return;
      }
      const existingPayload = parseJsonRecord(existingRow.payloadJson) ?? {};
      const mergedPayload = { ...existingPayload, ...args.patch };
      const visible = computeChatVisibility(existingRow.type, mergedPayload);
      const searchText = computeSearchText(existingRow.type, mergedPayload);
      this.db
        .prepare(
          `UPDATE entry SET payload = ?, visible = ?, search_text = ?, updated_at = ?
           WHERE id = ? AND conversation_id = ?`,
        )
        .run(
          toJsonValueString(mergedPayload),
          visible,
          searchText,
          Date.now(),
          eventId,
          args.conversationId,
        );
      updatedRecord = {
        ...this.deserializeEventRow(existingRow),
        payload: mergedPayload,
      };
    });
    return updatedRecord;
  }

  recordRunEvent(event: {
    runId: string;
    conversationId: string;
    agentType: string;
    seq?: number;
    timestamp: number;
    [key: string]: unknown;
  }): void {
    const messageId = `run:${event.runId}:${event.seq ?? generateLocalId()}`;
    this.tx.immediate(() => {
      this.ensureConversation(event.conversationId, event.timestamp);
      this.upsertEvent({
        conversationId: event.conversationId,
        eventId: messageId,
        type: "run_event",
        timestamp: event.timestamp,
        runId: event.runId,
        agentType: event.agentType,
        payload: event as Record<string, unknown>,
      });
    });
  }

  hasEvent(conversationId: string, eventIdInput: string, typeInput?: string): boolean {
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return false;
    const type = asTrimmedString(typeInput);
    const row = this.db
      .prepare(
        type
          ? `SELECT 1 AS present FROM entry
             WHERE conversation_id = ? AND id = ? AND type = ? LIMIT 1`
          : `SELECT 1 AS present FROM entry
             WHERE conversation_id = ? AND id = ? LIMIT 1`,
      )
      .get(
        ...(type ? [conversationId, eventId, type] : [conversationId, eventId]),
      );
    return Boolean(row);
  }

  hasEventId(eventIdInput: string, typeInput?: string): boolean {
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return false;
    const type = asTrimmedString(typeInput);
    const statement = this.db.prepare(
      type
        ? "SELECT 1 AS present FROM entry WHERE id = ? AND type = ? LIMIT 1"
        : "SELECT 1 AS present FROM entry WHERE id = ? LIMIT 1",
    );
    return Boolean(type ? statement.get(eventId, type) : statement.get(eventId));
  }

  truncateConversationAtEvent(
    conversationId: string,
    eventIdInput: string,
  ): { removed: number } {
    const cursor = this.getEventCursor(conversationId, eventIdInput);
    if (!cursor) return { removed: 0 };
    let removed = 0;
    this.tx.immediate(() => {
      // Count first: driver-reported change counts include FTS trigger
      // cascades and cannot be trusted for the removed-row total.
      const countRow = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM entry WHERE conversation_id = ? AND seq >= ?",
        )
        .get(conversationId, cursor.sequence) as { n?: number } | undefined;
      this.db
        .prepare("DELETE FROM entry WHERE conversation_id = ? AND seq >= ?")
        .run(conversationId, cursor.sequence);
      removed = typeof countRow?.n === "number" ? countRow.n : 0;
      const orphanThreadRows = this.db
        .prepare(
          `SELECT thread_id FROM agent
           WHERE conversation_id = ?
             AND status <> 'running'
             AND prompt_created_at IS NOT NULL
             AND prompt_created_at >= ?`,
        )
        .all(conversationId, cursor.timestamp) as Array<{
        thread_id?: unknown;
      }>;
      for (const row of orphanThreadRows) {
        const threadId = typeof row.thread_id === "string" ? row.thread_id : "";
        if (!threadId) continue;
        this.db
          .prepare(
            `DELETE FROM blob WHERE id IN (
               SELECT blob_id FROM thread_entry
               WHERE thread_id = ? AND blob_id IS NOT NULL
             )`,
          )
          .run(threadId);
        this.db.prepare("DELETE FROM thread WHERE id = ?").run(threadId);
        this.db.prepare("DELETE FROM agent WHERE thread_id = ?").run(threadId);
      }
    });
    return { removed };
  }

  forkConversationBeforeEvent(
    conversationId: string,
    eventIdInput: string,
  ): { conversationId: string } | null {
    const cursor = this.getEventCursor(conversationId, eventIdInput);
    if (!cursor) return null;
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_SELECT} FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type IN (${placeholders(CHAT_MESSAGE_TYPES)})
           AND entry.seq < ?
         ORDER BY entry.seq ASC`,
      )
      .all(conversationId, ...CHAT_MESSAGE_TYPES, cursor.sequence) as EntryRow[];
    const newConversationId = generateLocalId();
    const createdAt = Date.now();
    const idMap = new Map<string, string>();
    for (const row of rows) {
      idMap.set(row._id, `local-${generateLocalId()}`);
    }
    this.tx.immediate(() => {
      this.ensureConversation(newConversationId, createdAt);
      for (const row of rows) {
        const newId = idMap.get(row._id)!;
        let payload = parseJsonRecord(row.payloadJson) ?? undefined;
        if (payload && row.type === "assistant_message") {
          const remappedUserId =
            typeof payload.userMessageId === "string"
              ? idMap.get(payload.userMessageId)
              : undefined;
          if (remappedUserId) {
            payload = { ...payload, userMessageId: remappedUserId };
          }
        }
        const channelEnvelope =
          parseJsonRecord(row.channelEnvelopeJson) ?? undefined;
        this.upsertEvent({
          conversationId: newConversationId,
          eventId: newId,
          type: row.type,
          timestamp: row.timestamp,
          deviceId: asTrimmedString(row.deviceId) || undefined,
          requestId: asTrimmedString(row.requestId) || undefined,
          targetDeviceId: asTrimmedString(row.targetDeviceId) || undefined,
          payload,
          channelEnvelope,
        });
      }
    });
    return { conversationId: newConversationId };
  }

  /* ------------------------------------------------------------------ */
  /* Reads: raw events                                                   */
  /* ------------------------------------------------------------------ */

  deserializeEventRow(row: EntryRow): LocalChatEventRecord {
    const envelope = parseJsonRecord(row.channelEnvelopeJson);
    const payload = parseJsonRecord(row.payloadJson);
    return {
      _id: row._id,
      timestamp: row.timestamp,
      ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
      type: row.type,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.targetDeviceId ? { targetDeviceId: row.targetDeviceId } : {}),
      ...(payload ? { payload } : {}),
      ...(envelope ? { channelEnvelope: envelope } : {}),
    };
  }

  listEvents(conversationId: string, maxItems = 200): LocalChatEventRecord[] {
    const normalizedLimit = Math.max(1, Math.floor(maxItems));
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT ${ENTRY_SELECT} FROM entry
           WHERE entry.conversation_id = ?
             AND entry.type NOT IN (${placeholders(NON_EVENT_TYPES)})
           ORDER BY entry.seq DESC
           LIMIT ?
         ) ORDER BY sequence ASC`,
      )
      .all(conversationId, ...NON_EVENT_TYPES, normalizedLimit) as EntryRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  listEventsBefore(
    conversationId: string,
    opts: { beforeTimestampMs: number; beforeId?: string; limit?: number },
  ): LocalChatEventRecord[] {
    const normalizedLimit = Math.max(1, Math.floor(opts.limit ?? 50));
    const before = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(opts.beforeTimestampMs),
      id: opts.beforeId ?? "",
    });
    const keyset = this.keyset("<", before);
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT ${ENTRY_SELECT} FROM entry
           WHERE entry.conversation_id = ?
             AND entry.type NOT IN (${placeholders(NON_EVENT_TYPES)})
             AND ${keyset.clause}
           ORDER BY entry.seq DESC
           LIMIT ?
         ) ORDER BY sequence ASC`,
      )
      .all(
        conversationId,
        ...NON_EVENT_TYPES,
        ...keyset.params,
        normalizedLimit,
      ) as EntryRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  listLifecycleEventsByIds(eventIdsInput: string[]): LocalChatEventRecord[] {
    const eventIds = [
      ...new Set(eventIdsInput.map(asTrimmedString).filter(Boolean)),
    ].slice(0, 500);
    if (eventIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_SELECT} FROM entry
         WHERE entry.id IN (${placeholders(eventIds)})
           AND entry.type IN (${placeholders(LIFECYCLE_EVENT_TYPES)})
         ORDER BY entry.created_at ASC, entry.id ASC`,
      )
      .all(...eventIds, ...LIFECYCLE_EVENT_TYPES) as EntryRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  listRecentActivitySince(args: {
    sinceMs: number;
    limit?: number;
  }): Array<LocalChatEventRecord & { conversationId: string }> {
    const sinceMs = Number.isFinite(args.sinceMs)
      ? Math.max(0, Math.floor(args.sinceMs))
      : 0;
    const normalizedLimit = Math.max(
      1,
      Math.min(Math.floor(args.limit ?? 80), 500),
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT entry.conversation_id AS conversationId, ${ENTRY_SELECT}
           FROM entry
           WHERE entry.created_at >= ?
             AND entry.type IN (${placeholders([...CHAT_MESSAGE_TYPES, ...LIFECYCLE_EVENT_TYPES, "tool_result"])})
           ORDER BY entry.created_at DESC, entry.id DESC
           LIMIT ?
         ) ORDER BY timestamp ASC, _id ASC`,
      )
      .all(
        sinceMs,
        ...CHAT_MESSAGE_TYPES,
        ...LIFECYCLE_EVENT_TYPES,
        "tool_result",
        normalizedLimit,
      ) as Array<EntryRow & { conversationId: string }>;
    return rows.map((row) => ({
      conversationId: row.conversationId,
      ...this.deserializeEventRow(row),
    }));
  }

  listActivity(
    conversationId: string,
    args: { limit?: number; beforeTimestampMs?: number; beforeId?: string } = {},
  ): { activities: LocalChatEventRecord[] } {
    const normalizedLimit = Math.max(1, Math.floor(args.limit ?? 500));
    const clauses = [
      "entry.conversation_id = ?",
      `entry.type IN (${placeholders(LIFECYCLE_EVENT_TYPES)})`,
    ];
    const params: unknown[] = [conversationId, ...LIFECYCLE_EVENT_TYPES];
    if (typeof args.beforeTimestampMs === "number") {
      const before = this.resolveCursorSequence(conversationId, {
        timestamp: Math.floor(args.beforeTimestampMs),
        id: args.beforeId ?? "",
      });
      const keyset = this.keyset("<", before);
      clauses.push(keyset.clause);
      params.push(...keyset.params);
    }
    params.push(normalizedLimit);
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT ${ENTRY_SELECT} FROM entry
           WHERE ${clauses.join(" AND ")}
           ORDER BY entry.seq DESC
           LIMIT ?
         ) ORDER BY sequence ASC`,
      )
      .all(...params) as EntryRow[];
    return { activities: rows.map((row) => this.deserializeEventRow(row)) };
  }

  listFiles(
    conversationId: string,
    args: { limit?: number; beforeTimestampMs?: number; beforeId?: string } = {},
  ): { files: LocalChatEventRecord[] } {
    const normalizedLimit = Math.max(1, Math.floor(args.limit ?? 500));
    const clauses = [
      "entry.conversation_id = ?",
      "entry.type IN ('assistant_message', 'agent-completed')",
      "entry.payload IS NOT NULL",
      "(json_extract(entry.payload, '$.text') LIKE '%](%' OR json_extract(entry.payload, '$.result') LIKE '%](%')",
    ];
    const params: unknown[] = [conversationId];
    if (typeof args.beforeTimestampMs === "number") {
      const before = this.resolveCursorSequence(conversationId, {
        timestamp: Math.floor(args.beforeTimestampMs),
        id: args.beforeId ?? "",
      });
      const keyset = this.keyset("<", before);
      clauses.push(keyset.clause);
      params.push(...keyset.params);
    }
    params.push(normalizedLimit);
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT ${ENTRY_SELECT} FROM entry
           WHERE ${clauses.join(" AND ")}
           ORDER BY entry.seq DESC
           LIMIT ?
         ) ORDER BY sequence ASC`,
      )
      .all(...params) as EntryRow[];
    return { files: rows.map((row) => this.deserializeEventRow(row)) };
  }

  getEventCount(conversationId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM entry
         WHERE conversation_id = ?
           AND type NOT IN (${placeholders(NON_EVENT_TYPES)})`,
      )
      .get(conversationId, ...NON_EVENT_TYPES) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  listSyncMessages(
    conversationId: string,
    maxMessages = MAX_EVENTS_PER_CONVERSATION,
  ): Array<{
    localMessageId: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    deviceId?: string;
  }> {
    const normalizedLimit = Math.max(1, Math.floor(maxMessages));
    const rows = this.db
      .prepare(
        `SELECT entry.id AS _id, entry.created_at AS timestamp, entry.type AS type,
                entry.device_id AS deviceId, entry.payload AS payloadJson
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type IN (${placeholders(CHAT_MESSAGE_TYPES)})
           AND entry.visible = 1
         ORDER BY entry.seq DESC
         LIMIT ?`,
      )
      .all(
        conversationId,
        ...CHAT_MESSAGE_TYPES,
        CUTOFF_SCAN_CEILING,
      ) as Array<{
      _id: string;
      timestamp: number;
      type: string;
      deviceId: string | null;
      payloadJson: string | null;
    }>;
    const messages: Array<{
      localMessageId: string;
      role: "user" | "assistant";
      text: string;
      timestamp: number;
      deviceId?: string;
    }> = [];
    for (const row of rows) {
      const payload = parseJsonRecord(row.payloadJson);
      const text = eventTextFromPayload(payload);
      if (!text) continue;
      const role = row.type === "user_message" ? "user" : "assistant";
      messages.push({
        localMessageId: row._id,
        role,
        text,
        timestamp: row.timestamp,
        ...(role === "user" && row.deviceId ? { deviceId: row.deviceId } : {}),
      });
      if (messages.length >= normalizedLimit) break;
    }
    return messages.reverse();
  }

  /* ------------------------------------------------------------------ */
  /* Message windows                                                     */
  /* ------------------------------------------------------------------ */

  private fetchEntryRows(args: {
    conversationId: string;
    types?: readonly string[];
    visibleOnly?: boolean;
    from?: Cursor | null;
    after?: Cursor | null;
    before?: Cursor | null;
    until?: Cursor | null;
    limit?: number | null;
  }): LocalChatEventRecord[] {
    const types =
      args.types && args.types.length > 0 ? args.types : TIMELINE_EVENT_TYPES;
    const clauses = [
      "entry.conversation_id = ?",
      `entry.type IN (${placeholders(types)})`,
    ];
    const params: unknown[] = [args.conversationId, ...types];
    if (args.visibleOnly) clauses.push("entry.visible = 1");
    const bounds: Array<[Cursor | null | undefined, ">" | ">=" | "<"]> = [
      [args.from, ">="],
      [args.after, ">"],
      [args.before, "<"],
      [args.until, "<"],
    ];
    for (const [cursor, op] of bounds) {
      if (!cursor) continue;
      const k = this.keyset(
        op,
        this.resolveCursorSequence(args.conversationId, cursor),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.floor(args.limit))
        : null;
    if (limit !== null) params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_SELECT} FROM entry
         WHERE ${clauses.join(" AND ")}
         ORDER BY entry.seq ASC
         ${limit !== null ? "LIMIT ?" : ""}`,
      )
      .all(...params) as EntryRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  private cursorFromRow(row: {
    timestamp?: number;
    id?: string;
    sequence?: number;
  }): Cursor | null {
    return typeof row?.timestamp === "number" && typeof row.id === "string"
      ? {
          timestamp: row.timestamp,
          id: row.id,
          ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
        }
      : null;
  }

  private findVisibleMessageCutoffPaged(
    conversationId: string,
    maxVisibleMessages: number,
    initialBefore: Cursor | null,
  ): Cursor | null {
    const before = this.resolveCursorSequence(conversationId, initialBefore);
    const beforeKeyset = before ? this.keyset("<", before) : null;
    const params: unknown[] = [conversationId];
    if (beforeKeyset) params.push(...beforeKeyset.params);
    params.push(maxVisibleMessages - 1);
    const row = this.db
      .prepare(
        `SELECT entry.created_at AS timestamp, entry.id AS id, entry.seq AS sequence
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.visible = 1
           ${beforeKeyset ? `AND ${beforeKeyset.clause}` : ""}
         ORDER BY entry.seq DESC
         LIMIT 1 OFFSET ?`,
      )
      .get(...params) as
      | { timestamp?: number; id?: string; sequence?: number }
      | undefined;
    return row ? this.cursorFromRow(row) : null;
  }

  findVisibleMessagePageEndAfter(
    conversationId: string,
    maxVisibleMessages: number,
    initialAfter: Cursor,
  ): Cursor | null {
    const after = this.resolveCursorSequence(conversationId, initialAfter);
    const keyset = this.keyset(">", after);
    const rows = this.db
      .prepare(
        `SELECT entry.created_at AS timestamp, entry.id AS id, entry.seq AS sequence
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.visible = 1
           AND ${keyset.clause}
         ORDER BY entry.seq ASC
         LIMIT ?`,
      )
      .all(conversationId, ...keyset.params, maxVisibleMessages) as Array<{
      timestamp?: number;
      id?: string;
      sequence?: number;
    }>;
    const row = rows.at(-1);
    return row ? this.cursorFromRow(row) : null;
  }

  findVisibleMessageCursorAfter(
    conversationId: string,
    initialAfter: Cursor,
  ): Cursor | null {
    const after = this.resolveCursorSequence(conversationId, initialAfter);
    const keyset = this.keyset(">", after);
    const row = this.db
      .prepare(
        `SELECT entry.created_at AS timestamp, entry.id AS id, entry.seq AS sequence
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.visible = 1
           AND ${keyset.clause}
         ORDER BY entry.seq ASC
         LIMIT 1`,
      )
      .get(conversationId, ...keyset.params) as
      | { timestamp?: number; id?: string; sequence?: number }
      | undefined;
    return row ? this.cursorFromRow(row) : null;
  }

  findTurnFetchCutoff(
    conversationId: string,
    cutoff: Cursor | null,
  ): Cursor | null {
    if (!cutoff) return null;
    const resolved = this.resolveCursorSequence(conversationId, cutoff);
    const keyset = this.keyset("<=", resolved);
    const row = this.db
      .prepare(
        `SELECT entry.created_at AS timestamp, entry.id AS id, entry.seq AS sequence
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type = 'user_message'
           AND entry.visible = 1
           AND ${keyset.clause}
         ORDER BY entry.seq DESC
         LIMIT 1`,
      )
      .get(conversationId, ...keyset.params) as
      | { timestamp?: number; id?: string; sequence?: number }
      | undefined;
    const cursor = row ? this.cursorFromRow(row) : null;
    return cursor ?? resolved;
  }

  findNextUserMessageAfter(
    conversationId: string,
    cursor: Cursor | null,
  ): Cursor | null {
    if (!cursor) return null;
    const resolved = this.resolveCursorSequence(conversationId, cursor);
    const keyset = this.keyset(">", resolved);
    const row = this.db
      .prepare(
        `SELECT entry.created_at AS timestamp, entry.id AS id, entry.seq AS sequence
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type = 'user_message'
           AND entry.visible = 1
           AND ${keyset.clause}
         ORDER BY entry.seq ASC
         LIMIT 1`,
      )
      .get(conversationId, ...keyset.params) as
      | { timestamp?: number; id?: string; sequence?: number }
      | undefined;
    return row ? this.cursorFromRow(row) : null;
  }

  findPreviousVisibleAssistantAfter(
    conversationId: string,
    start: Cursor | null,
    before: Cursor | null,
  ): Cursor | null {
    if (!start || !before) return null;
    const startKeyset = this.keyset(
      ">",
      this.resolveCursorSequence(conversationId, start),
    );
    const beforeKeyset = this.keyset(
      "<",
      this.resolveCursorSequence(conversationId, before),
    );
    const row = this.db
      .prepare(
        `SELECT entry.created_at AS timestamp, entry.id AS id, entry.seq AS sequence
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type = 'assistant_message'
           AND entry.visible = 1
           AND ${startKeyset.clause}
           AND ${beforeKeyset.clause}
         ORDER BY entry.seq DESC
         LIMIT 1`,
      )
      .get(conversationId, ...startKeyset.params, ...beforeKeyset.params) as
      | { timestamp?: number; id?: string; sequence?: number }
      | undefined;
    return row ? this.cursorFromRow(row) : null;
  }

  findLatestTimelineCursor(
    conversationId: string,
    until: Cursor | null = null,
  ): Cursor | null {
    const clauses = ["entry.conversation_id = ?"];
    const params: unknown[] = [conversationId];
    if (until) {
      const k = this.keyset(
        "<",
        this.resolveCursorSequence(conversationId, until),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    const row = this.db
      .prepare(
        `SELECT entry.created_at AS timestamp, entry.id AS id, entry.seq AS sequence
         FROM entry
         WHERE ${clauses.join(" AND ")}
         ORDER BY entry.seq DESC
         LIMIT 1`,
      )
      .get(...params) as
      | { timestamp?: number; id?: string; sequence?: number }
      | undefined;
    return row ? this.cursorFromRow(row) : null;
  }

  assembleMessageWindow(rows: LocalChatEventRecord[]): {
    messages: ChatMessageRecord[];
    visibleMessageCount: number;
  } {
    const messages: ChatMessageRecord[] = [];
    let turnUserMessage: ChatMessageRecord | null = null;
    let currentAssistant: ChatMessageRecord | null = null;
    let pendingPreAssistantTools: LocalChatEventRecord[] = [];
    let visibleMessageCount = 0;

    const finalizePreAssistantTools = () => {
      if (pendingPreAssistantTools.length > 0 && turnUserMessage) {
        turnUserMessage.toolEvents = [
          ...turnUserMessage.toolEvents,
          ...pendingPreAssistantTools,
        ];
      }
      pendingPreAssistantTools = [];
    };
    for (const row of rows) {
      if (row.type === "user_message") {
        finalizePreAssistantTools();
        const message: ChatMessageRecord = { ...row, toolEvents: [] };
        messages.push(message);
        turnUserMessage = message;
        currentAssistant = null;
        if (!isUiHiddenChatMessagePayload((row.payload as never) ?? null)) {
          visibleMessageCount += 1;
        }
        continue;
      }
      if (row.type === "assistant_message") {
        const message: ChatMessageRecord = { ...row, toolEvents: [] };
        messages.push(message);
        const hidden = isUiHiddenChatMessagePayload(
          (row.payload as never) ?? null,
        );
        if (!hidden && pendingPreAssistantTools.length > 0) {
          message.toolEvents = [
            ...message.toolEvents,
            ...pendingPreAssistantTools,
          ];
          pendingPreAssistantTools = [];
        }
        if (!hidden) {
          currentAssistant = message;
          visibleMessageCount += 1;
        }
        continue;
      }
      if (currentAssistant) {
        currentAssistant.toolEvents = [...currentAssistant.toolEvents, row];
      } else {
        pendingPreAssistantTools.push(row);
      }
    }
    finalizePreAssistantTools();
    return { messages, visibleMessageCount };
  }

  fetchBoundedToolEvents(
    conversationId: string,
    start: Cursor | null,
    end: Cursor | null,
  ): {
    events: LocalChatEventRecord[];
    totalCount: number;
    eventCountTruncated: boolean;
    detailTruncated: boolean;
  } {
    const clauses = [
      "entry.conversation_id = ?",
      `entry.type IN (${placeholders(TOOL_EVENT_TYPES)})`,
    ];
    const params: unknown[] = [conversationId, ...TOOL_EVENT_TYPES];
    if (start) {
      const k = this.keyset(
        ">",
        this.resolveCursorSequence(conversationId, start),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    if (end) {
      const k = this.keyset(
        "<",
        this.resolveCursorSequence(conversationId, end),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    const select = `SELECT ${ENTRY_SELECT} FROM entry WHERE ${clauses.join(" AND ")}`;
    const headProbeRows = this.db
      .prepare(`${select} ORDER BY entry.seq ASC LIMIT ${EAGER_TOOL_EVENT_LIMIT + 1}`)
      .all(...params) as EntryRow[];
    const eventCountTruncated = headProbeRows.length > EAGER_TOOL_EVENT_LIMIT;
    const headRows = eventCountTruncated
      ? headProbeRows.slice(0, EAGER_TOOL_EVENT_SIDE_LIMIT)
      : headProbeRows;
    const tailRows = eventCountTruncated
      ? (this.db
          .prepare(
            `${select} ORDER BY entry.seq DESC LIMIT ${EAGER_TOOL_EVENT_SIDE_LIMIT}`,
          )
          .all(...params) as EntryRow[])
      : [];
    const rowsById = new Map<string, EntryRow>();
    for (const row of [...headRows, ...tailRows]) rowsById.set(row._id, row);
    let payloadProjected = false;
    const events = [...rowsById.values()]
      .map((row) => {
        const projected = projectLocalChatUpdateEventWithMetadata(
          this.deserializeEventRow(row),
        );
        payloadProjected ||= projected.payloadProjected;
        return projected.event;
      })
      .sort((a, b) =>
        compareTimelineCursor(
          { timestamp: a.timestamp, id: a._id, sequence: a.sequence },
          { timestamp: b.timestamp, id: b._id, sequence: b.sequence },
        ),
      );
    return {
      events,
      totalCount: eventCountTruncated ? events.length + 1 : events.length,
      eventCountTruncated,
      detailTruncated: eventCountTruncated || payloadProjected,
    };
  }

  attachBoundedToolEvents(
    conversationId: string,
    window: { messages: ChatMessageRecord[]; visibleMessageCount: number },
    upperBound: Cursor | null,
  ): { messages: ChatMessageRecord[]; visibleMessageCount: number } {
    if (window.messages.length === 0) return window;
    const attachedById = new Map<string, ChatMessageRecord>();
    let turn: ChatMessageRecord[] = [];
    const cursorFor = (message: LocalChatEventRecord): Cursor => ({
      timestamp: message.timestamp,
      id: message._id,
      ...(typeof message.sequence === "number"
        ? { sequence: message.sequence }
        : {}),
    });
    const attachTurn = (
      messages: ChatMessageRecord[],
      turnEnd: Cursor | null,
    ) => {
      if (messages.length === 0) return;
      const user = messages.find((message) => message.type === "user_message");
      const assistants = messages.filter(
        (message) =>
          message.type === "assistant_message" &&
          !isUiHiddenChatMessagePayload((message.payload as never) ?? null),
      );
      const anchors = assistants.length > 0 ? assistants : user ? [user] : [];
      anchors.forEach((anchor, index) => {
        const start = index === 0 && user ? cursorFor(user) : cursorFor(anchor);
        const end =
          index + 1 < anchors.length ? cursorFor(anchors[index + 1]!) : turnEnd;
        const { events, totalCount, eventCountTruncated, detailTruncated } =
          this.fetchBoundedToolEvents(conversationId, start, end);
        attachedById.set(anchor._id, {
          ...anchor,
          toolEvents: events,
          toolEventSummary: {
            totalCount,
            loadedCount: events.length,
            truncated: detailTruncated,
            ...(eventCountTruncated ? { totalCountIsLowerBound: true } : {}),
          },
        });
      });
    };
    for (const message of window.messages) {
      if (message.type === "user_message" && turn.length > 0) {
        attachTurn(turn, cursorFor(message));
        turn = [];
      }
      turn.push(message);
    }
    attachTurn(turn, upperBound);
    return {
      ...window,
      messages: window.messages.map(
        (message) => attachedById.get(message._id) ?? message,
      ),
    };
  }

  trimMessageWindow(
    window: { messages: ChatMessageRecord[]; visibleMessageCount: number },
    cutoff: Cursor | null,
  ): { messages: ChatMessageRecord[]; visibleMessageCount: number } {
    if (!cutoff) return window;
    let visibleMessageCount = 0;
    const messages = window.messages.filter((message) => {
      const keep =
        compareTimelineCursor(
          {
            timestamp: message.timestamp,
            id: message._id,
            ...(typeof message.sequence === "number"
              ? { sequence: message.sequence }
              : {}),
          },
          cutoff,
        ) >= 0;
      if (
        keep &&
        !isUiHiddenChatMessagePayload((message.payload as never) ?? null)
      ) {
        visibleMessageCount += 1;
      }
      return keep;
    });
    return { messages, visibleMessageCount };
  }

  limitChangedMessageWindow(
    window: { messages: ChatMessageRecord[]; visibleMessageCount: number },
    after: Cursor,
    maxVisibleMessages: number,
  ): { messages: ChatMessageRecord[]; visibleMessageCount: number } {
    const messages: ChatMessageRecord[] = [];
    let visibleMessageCount = 0;
    for (const message of window.messages) {
      const messageChanged =
        compareTimelineCursor(
          {
            timestamp: message.timestamp,
            id: message._id,
            ...(typeof message.sequence === "number"
              ? { sequence: message.sequence }
              : {}),
          },
          after,
        ) > 0;
      const toolEventsChanged = message.toolEvents.some(
        (event) =>
          compareTimelineCursor(
            {
              timestamp: event.timestamp,
              id: event._id,
              ...(typeof event.sequence === "number"
                ? { sequence: event.sequence }
                : {}),
            },
            after,
          ) > 0,
      );
      if (!messageChanged && !toolEventsChanged) continue;
      messages.push(message);
      if (!isUiHiddenChatMessagePayload((message.payload as never) ?? null)) {
        visibleMessageCount += 1;
      }
      if (visibleMessageCount >= maxVisibleMessages) {
        break;
      }
    }
    return { messages, visibleMessageCount };
  }

  listMessages(
    conversationId: string,
    args: { maxVisibleMessages?: number } = {},
  ): ChatMessageWindow {
    const maxVisibleMessages = Math.max(
      1,
      Math.min(
        MAX_VISIBLE_MESSAGE_WINDOW,
        Math.floor(args.maxVisibleMessages ?? 200),
      ),
    );
    const cutoff = this.findVisibleMessageCutoffPaged(
      conversationId,
      maxVisibleMessages,
      null,
    );
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, cutoff);
    const rows = this.fetchEntryRows({
      conversationId,
      types: CHAT_MESSAGE_TYPES,
      visibleOnly: true,
      from: fetchCutoff,
    });
    const projected = this.attachBoundedToolEvents(
      conversationId,
      this.assembleMessageWindow(rows),
      null,
    );
    const nextCursor = this.findLatestTimelineCursor(conversationId);
    return {
      ...this.trimMessageWindow(projected, cutoff),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  listMessagesBefore(
    conversationId: string,
    args: {
      beforeTimestampMs: number;
      beforeId: string;
      maxVisibleMessages?: number;
    },
  ): ChatMessageWindow {
    const maxVisibleMessages = Math.max(
      1,
      Math.min(
        MAX_VISIBLE_MESSAGE_WINDOW,
        Math.floor(args.maxVisibleMessages ?? 200),
      ),
    );
    const before = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(args.beforeTimestampMs),
      id: args.beforeId,
    });
    const cutoff = this.findVisibleMessageCutoffPaged(
      conversationId,
      maxVisibleMessages,
      before,
    );
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, cutoff);
    const rows = this.fetchEntryRows({
      conversationId,
      types: CHAT_MESSAGE_TYPES,
      visibleOnly: true,
      from: fetchCutoff,
      before,
    });
    const projected = this.attachBoundedToolEvents(
      conversationId,
      this.assembleMessageWindow(rows),
      before,
    );
    return this.trimMessageWindow(projected, cutoff);
  }

  listMessagesAfter(
    conversationId: string,
    args: {
      afterTimestampMs: number;
      afterId: string;
      afterSequence?: number;
      maxVisibleMessages?: number;
      includeSourceEvents?: boolean;
    },
  ): ChatMessageWindow & { sourceEvents: LocalChatEventRecord[] } {
    const maxVisibleMessages = Math.max(
      1,
      Math.min(
        MAX_VISIBLE_MESSAGE_WINDOW,
        Math.floor(args.maxVisibleMessages ?? 200),
      ),
    );
    const after = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(args.afterTimestampMs),
      id: args.afterId,
      ...(typeof args.afterSequence === "number"
        ? { sequence: args.afterSequence }
        : {}),
    });
    const pageEnd = this.findVisibleMessagePageEndAfter(
      conversationId,
      maxVisibleMessages,
      after,
    );
    const until = pageEnd
      ? this.findVisibleMessageCursorAfter(conversationId, pageEnd)
      : null;
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, after);

    const includeSourceEvents = args.includeSourceEvents !== false;
    const messageRows = this.fetchEntryRows({
      conversationId,
      types: CHAT_MESSAGE_TYPES,
      visibleOnly: true,
      from: fetchCutoff,
      until,
    });
    const sourceEvents = includeSourceEvents
      ? this.fetchEntryRows({
          conversationId,
          after,
          until,
          limit: CUTOFF_SCAN_CEILING,
        })
      : messageRows.filter(
          (event) =>
            compareTimelineCursor(
              {
                timestamp: event.timestamp,
                id: event._id,
                sequence: event.sequence,
              },
              after,
            ) > 0,
        );

    const projectionRows = includeSourceEvents
      ? Array.from(
          new Map(
            [...messageRows, ...sourceEvents].map((event) => [event._id, event]),
          ).values(),
        ).sort((a, b) =>
          compareTimelineCursor(
            { timestamp: a.timestamp, id: a._id, sequence: a.sequence },
            { timestamp: b.timestamp, id: b._id, sequence: b.sequence },
          ),
        )
      : messageRows;
    const assembled = this.assembleMessageWindow(projectionRows);
    const projected = includeSourceEvents
      ? assembled
      : this.attachBoundedToolEvents(conversationId, assembled, until);
    const lastSourceEvent = includeSourceEvents ? sourceEvents.at(-1) : null;
    const nextCursor = lastSourceEvent
      ? {
          timestamp: lastSourceEvent.timestamp,
          id: lastSourceEvent._id,
          ...(typeof lastSourceEvent.sequence === "number"
            ? { sequence: lastSourceEvent.sequence }
            : {}),
        }
      : includeSourceEvents
        ? null
        : this.findLatestTimelineCursor(conversationId, until);
    return {
      ...this.limitChangedMessageWindow(projected, after, maxVisibleMessages),
      sourceEvents,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  hasMobileSyncEventsAfter(
    conversationId: string,
    afterTimestampMs: number,
    afterId: string,
    afterSequence?: number,
  ): boolean {
    const cursor = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(afterTimestampMs),
      id: afterId,
      ...(typeof afterSequence === "number" ? { sequence: afterSequence } : {}),
    });
    const keyset = this.keyset(">", cursor);
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type IN (${placeholders(TIMELINE_EVENT_TYPES)})
           AND ${keyset.clause}
         LIMIT 1`,
      )
      .get(conversationId, ...TIMELINE_EVENT_TYPES, ...keyset.params) as
      | { found?: number }
      | undefined;
    return row?.found === 1;
  }

  isMobileSyncCursorValid(
    conversationId: string,
    cursorTimestampMs: number,
    cursorId: string,
    cursorSequence?: number,
  ): boolean {
    if (typeof cursorId !== "string" || cursorId.length === 0) return false;
    const row = this.db
      .prepare(
        `SELECT created_at AS timestamp, seq AS sequence FROM entry
         WHERE conversation_id = ? AND id = ? LIMIT 1`,
      )
      .get(conversationId, cursorId) as
      | { timestamp?: number; sequence?: number }
      | undefined;
    if (!row || row.timestamp !== Math.floor(cursorTimestampMs)) return false;
    return (
      typeof cursorSequence !== "number" ||
      row.sequence === Math.floor(cursorSequence)
    );
  }

  /**
   * Resolve lifecycle state only for the task ids a cursor delta touched.
   * Each matching start event loads only its own turn (via the stored
   * turn_seq), then later lifecycle events for that agent fold onto the
   * anchor message.
   */
  listMobileTaskContext(
    conversationId: string,
    agentIdsInput: string[],
  ): { messages: ChatMessageRecord[]; visibleMessageCount: number } {
    const agentIds = [
      ...new Set(agentIdsInput.map(asTrimmedString).filter(Boolean)),
    ].slice(0, 100);
    if (agentIds.length === 0) {
      return { messages: [], visibleMessageCount: 0 };
    }
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_SELECT} FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type IN (${placeholders(LIFECYCLE_EVENT_TYPES)})
           AND json_extract(entry.payload, '$.agentId') IN (${placeholders(agentIds)})
         ORDER BY entry.seq ASC`,
      )
      .all(conversationId, ...LIFECYCLE_EVENT_TYPES, ...agentIds) as EntryRow[];
    const lifecycleEvents = rows.map((row) => this.deserializeEventRow(row));
    const eventsByAgent = new Map<string, LocalChatEventRecord[]>();
    for (const event of lifecycleEvents) {
      const agentId = asTrimmedString(event.payload?.agentId);
      if (!agentId) continue;
      const bucket = eventsByAgent.get(agentId);
      if (bucket) bucket.push(event);
      else eventsByAgent.set(agentId, [event]);
    }
    const anchorsById = new Map<string, ChatMessageRecord>();
    for (const start of lifecycleEvents) {
      if (start.type !== "agent-started") continue;
      const agentId = asTrimmedString(start.payload?.agentId);
      if (!agentId) continue;
      const turnStart = this.findTurnFetchCutoff(conversationId, {
        timestamp: start.timestamp,
        id: start._id,
        ...(typeof start.sequence === "number"
          ? { sequence: start.sequence }
          : {}),
      });
      const nextTurn = this.findNextUserMessageAfter(conversationId, turnStart);
      const turn = this.assembleMessageWindow(
        this.fetchEntryRows({
          conversationId,
          from: turnStart,
          before: nextTurn,
        }),
      );
      const anchor =
        turn.messages.find((message) =>
          message.toolEvents.some((event) => event._id === start._id),
        ) ?? turn.messages.find((message) => message.type === "user_message");
      if (!anchor) continue;
      const existing = anchorsById.get(anchor._id);
      const lifecycle = eventsByAgent.get(agentId) ?? [];
      const combined = [
        ...(existing?.toolEvents ?? anchor.toolEvents),
        ...lifecycle,
      ];
      const seen = new Set<string>();
      const toolEvents = combined
        .filter((event) => {
          if (seen.has(event._id)) return false;
          seen.add(event._id);
          return true;
        })
        .sort((a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id));
      anchorsById.set(anchor._id, { ...anchor, toolEvents });
    }
    const messages = [...anchorsById.values()].sort(
      (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
    );
    return {
      messages,
      visibleMessageCount: messages.filter(
        (message) =>
          !isUiHiddenChatMessagePayload((message.payload as never) ?? null),
      ).length,
    };
  }

  listMessageToolEvents(
    conversationId: string,
    args: {
      messageTimestampMs: number;
      messageId: string;
      messageSequence?: number;
      afterTimestampMs?: number;
      afterId?: string;
      afterSequence?: number;
      limit?: number;
    },
  ): {
    events: LocalChatEventRecord[];
    hasMore: boolean;
    nextCursor?: Cursor;
  } {
    const anchor = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(args.messageTimestampMs),
      id: args.messageId,
      ...(typeof args.messageSequence === "number"
        ? { sequence: args.messageSequence }
        : {}),
    });
    const anchorRow = this.db
      .prepare(
        "SELECT type FROM entry WHERE conversation_id = ? AND id = ? LIMIT 1",
      )
      .get(conversationId, anchor.id) as { type?: string } | undefined;
    const turnStart = this.findTurnFetchCutoff(conversationId, anchor);
    const previousAssistant =
      anchorRow?.type === "assistant_message"
        ? this.findPreviousVisibleAssistantAfter(
            conversationId,
            turnStart,
            anchor,
          )
        : null;
    const rangeStart = previousAssistant ? anchor : (turnStart ?? anchor);
    const rangeEnd =
      anchorRow?.type === "user_message"
        ? this.findNextUserMessageAfter(conversationId, anchor)
        : this.findVisibleMessageCursorAfter(conversationId, anchor);
    const after = args.afterId
      ? this.resolveCursorSequence(conversationId, {
          timestamp: Math.floor(args.afterTimestampMs ?? 0),
          id: args.afterId,
          ...(typeof args.afterSequence === "number"
            ? { sequence: args.afterSequence }
            : {}),
        })
      : rangeStart;
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)));
    const rows = this.fetchEntryRows({
      conversationId,
      types: TOOL_EVENT_TYPES,
      after,
      until: rangeEnd,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      events: page,
      hasMore: rows.length > limit,
      ...(last
        ? {
            nextCursor: {
              timestamp: last.timestamp,
              id: last._id,
              ...(typeof last.sequence === "number"
                ? { sequence: last.sequence }
                : {}),
            },
          }
        : {}),
    };
  }
}
