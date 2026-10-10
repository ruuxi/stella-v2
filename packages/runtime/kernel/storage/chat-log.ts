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
  toReplyPreview,
  type RawReplyRef,
  type ReplyCounts,
  type ReplyRef,
} from "@stella/contracts/reply-refs";
import {
  DEFAULT_CONVERSATION_SETTING_KEY,
  MAX_EVENTS_PER_CONVERSATION,
  asFiniteNumber,
  asObject,
  asTrimmedString,
  cachedStatements,
  eventTextFromPayload,
  generateLocalId,
  parseJsonRecord,
  requireConversationId,
  toJsonValueString,
  type CachedStatements,
  type LocalChatEventRecord,
  type SqliteDatabase,
} from "./shared.js";
import { eventRoleForType, type Cursor } from "./view.js";
import type {
  LocalChatEventWindow,
  LocalChatEventWindowQuery,
} from "./event-window.js";

export const CUTOFF_SCAN_CEILING = 4000;

export const CHAT_MESSAGE_TYPES = [
  "user_message",
  "assistant_message",
] as const;
export const TOOL_EVENT_TYPES = [
  "tool_request",
  "tool_result",
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
] as const;
export const TIMELINE_EVENT_TYPES = [
  ...CHAT_MESSAGE_TYPES,
  ...TOOL_EVENT_TYPES,
];
export const LIFECYCLE_EVENT_TYPES = [
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
] as const;
/**
 * Legacy event types that never surface through the event APIs. Nothing
 * writes them any more; `run_event` rows left in existing stores are
 * deleted by `sweepLegacyRunEventEntries` (entry-retention.ts).
 */
export const NON_EVENT_TYPES = [
  "thread_message",
  "run_event",
  "memory",
] as const;

export const placeholders = (values: readonly unknown[]): string =>
  values.map(() => "?").join(", ");

export type EntryRow = {
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

export const ENTRY_SELECT = `
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

/** Reply references an assistant payload carries, if any. */
export const readReplyRefs = (
  payload: Record<string, unknown> | undefined,
): ReplyRef[] => {
  const metadata = asObject(payload?.metadata);
  const runtime = asObject(metadata?.runtime);
  const refs = runtime?.replyRefs;
  if (!Array.isArray(refs)) return [];
  const result: ReplyRef[] = [];
  for (const candidate of refs) {
    const ref = asObject(candidate);
    if (!ref) continue;
    if (
      ref.kind === "message" &&
      typeof ref.sequence === "number" &&
      Number.isSafeInteger(ref.sequence) &&
      typeof ref.id === "string"
    ) {
      result.push({
        kind: "message",
        sequence: ref.sequence,
        id: ref.id,
        role: ref.role === "assistant" ? "assistant" : "user",
        preview: typeof ref.preview === "string" ? ref.preview : "",
      });
    } else if (
      ref.kind === "agent" &&
      typeof ref.threadId === "string" &&
      ref.threadId.trim()
    ) {
      result.push({
        kind: "agent",
        threadId: ref.threadId.trim(),
        title: typeof ref.title === "string" ? ref.title : ref.threadId.trim(),
      });
    }
  }
  return result;
};

/**
 * Keyset predicate for a cursor. Uses the sequence when the cursor
 * resolves to a stored entry, and falls back to `(created_at, id)` for
 * cursors that no longer resolve (e.g. after truncation).
 */
export const cursorKeyset = (
  op: ">" | ">=" | "<" | "<=",
  cursor: Cursor,
): { clause: string; params: unknown[] } => {
  if (typeof cursor.sequence === "number" && Number.isFinite(cursor.sequence)) {
    return { clause: `entry.seq ${op} ?`, params: [cursor.sequence] };
  }
  const outer = op === ">" || op === ">=" ? ">" : "<";
  return {
    clause: `(entry.created_at ${outer} ? OR (entry.created_at = ? AND entry.id ${op} ?))`,
    params: [cursor.timestamp, cursor.timestamp, cursor.id],
  };
};

/** A chat's title is its newest visible message, as the history list shows it. */
const conversationTitle = (payloadJson: string | null): string => {
  const payload = parseJsonRecord(payloadJson);
  const rawText = typeof payload?.text === "string" ? payload.text : "";
  return rawText.replace(/\s+/g, " ").trim().slice(0, 240) || "New chat";
};

export class ChatLog {
  private readonly cached: CachedStatements;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly tx: {
      immediate: (work: () => void) => void;
    },
  ) {
    this.cached = cachedStatements(db);
  }

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
    return conversationId.startsWith("local_") ||
      (conversationId.length === 26 &&
        /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(conversationId))
      ? "chat"
      : "derived";
  }

  ensureConversation(conversationId: string, updatedAt: number): void {
    this.cached
      .prepare(
        `INSERT INTO conversation (id, kind, title, status, next_seq, created_at, updated_at)
         VALUES (?, ?, '', 'active', 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
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
    const row = this.cached
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

  /**
   * `ensureConversation` + `claimSeq` for the append path. The row almost
   * always exists, so apply the upsert's conflict update (kind, monotonic
   * updated_at) in the same statement that claims the seq, and fall back to
   * the upsert only when the row is missing.
   */
  private claimSeqEnsuringConversation(
    conversationId: string,
    updatedAt: number,
  ): number {
    const row = this.cached
      .prepare(
        `UPDATE conversation SET
           next_seq = next_seq + 1,
           kind = ?,
           updated_at = CASE WHEN ? > updated_at THEN ? ELSE updated_at END
         WHERE id = ?
         RETURNING next_seq - 1 AS seq`,
      )
      .get(
        ChatLog.conversationKind(conversationId),
        updatedAt,
        updatedAt,
        conversationId,
      ) as { seq?: number } | undefined;
    if (typeof row?.seq === "number") return row.seq;
    this.ensureConversation(conversationId, updatedAt);
    return this.claimSeq(conversationId);
  }

  /**
   * `ensureConversation` for an append that updates an entry already stored
   * in this conversation: the entry's foreign key proves the row exists, so
   * only the conflict update (kind, monotonic updated_at) is left to apply.
   */
  private touchConversation(conversationId: string, updatedAt: number): void {
    const row = this.cached
      .prepare(
        `UPDATE conversation SET
           kind = ?,
           updated_at = CASE WHEN ? > updated_at THEN ? ELSE updated_at END
         WHERE id = ?
         RETURNING 1 AS touched`,
      )
      .get(
        ChatLog.conversationKind(conversationId),
        updatedAt,
        updatedAt,
        conversationId,
      );
    if (!row) this.ensureConversation(conversationId, updatedAt);
  }

  conversationExists(conversationId: string): boolean {
    return Boolean(
      this.cached
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
    const row = this.cached
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value.length > 0
      ? row.value
      : null;
  }

  setSetting(key: string, value: string): void {
    this.cached
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
        if (!existing.startsWith("local_"))
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
      const reusable = this.cached
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
    conversationId = requireConversationId(conversationId);
    const now = Date.now();
    this.tx.immediate(() => {
      // Selecting a private draft reserves its id without adding a history row.
      // appendMessage/appendEvent materializes it with the first message.
      if (!conversationId.startsWith("local_"))
        this.ensureConversation(conversationId, now);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, conversationId);
    });
  }

  listConversationSummaries(
    args: {
      limit?: number;
      cursor?: { updatedAt?: number; conversationId?: string } | null;
    } = {},
  ): {
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
    const rows = this.cached
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
      return {
        conversationId: row.conversationId,
        title: conversationTitle(row.payloadJson),
        ...(row.latestMessageId
          ? { latestMessageId: row.latestMessageId }
          : {}),
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

  /** One active chat's summary row, or null when this computer has no such chat. */
  getConversationSummary(conversationId: string): {
    conversationId: string;
    title: string;
    updatedAt: number;
  } | null {
    const row = this.cached
      .prepare(
        `SELECT
           conversation.id AS conversationId,
           conversation.updated_at AS updatedAt,
           latest.payload AS payloadJson
         FROM conversation
         LEFT JOIN entry AS latest ON latest.rowid = (
           SELECT candidate.rowid
           FROM entry AS candidate
           WHERE candidate.conversation_id = conversation.id
             AND candidate.visible = 1
             AND candidate.search_text IS NOT NULL
             AND trim(candidate.search_text) <> ''
           ORDER BY candidate.seq DESC
           LIMIT 1
         )
         WHERE conversation.id = ?
           AND conversation.kind = 'chat'
           AND conversation.status = 'active'
         LIMIT 1`,
      )
      .get(conversationId) as
      | {
          conversationId: string;
          updatedAt: number;
          payloadJson: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      conversationId: row.conversationId,
      title: conversationTitle(row.payloadJson),
      updatedAt: row.updatedAt,
    };
  }

  deleteConversation(conversationId: string): boolean {
    conversationId = requireConversationId(conversationId);
    const exists = this.conversationExists(conversationId);
    if (!exists) return false;
    const runningAgent = this.cached
      .prepare(
        `SELECT 1 FROM agent
         WHERE conversation_id = ? AND status = 'running' LIMIT 1`,
      )
      .get(conversationId);
    if (runningAgent) {
      throw new Error("A conversation with running tasks cannot be deleted.");
    }
    this.tx.immediate(() => {
      this.cached
        .prepare(
          `DELETE FROM blob WHERE id IN (
             SELECT blob_id FROM thread_entry
             JOIN thread ON thread.id = thread_entry.thread_id
             WHERE thread.conversation_id = ? AND blob_id IS NOT NULL
           )`,
        )
        .run(conversationId);
      this.cached
        .prepare("DELETE FROM agent WHERE conversation_id = ?")
        .run(conversationId);
      this.cached
        .prepare("DELETE FROM thread WHERE conversation_id = ?")
        .run(conversationId);
      this.cached
        .prepare("DELETE FROM settings WHERE key = ? AND value = ?")
        .run(DEFAULT_CONVERSATION_SETTING_KEY, conversationId);
      this.cached
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
    const row = this.cached
      .prepare(
        "SELECT seq AS sequence FROM entry WHERE conversation_id = ? AND id = ? LIMIT 1",
      )
      .get(conversationId, cursor.id) as { sequence?: number } | undefined;
    return typeof row?.sequence === "number"
      ? { ...cursor, sequence: row.sequence }
      : cursor;
  }

  getEventCursor(conversationId: string, eventIdInput: string): Cursor | null {
    conversationId = requireConversationId(conversationId);
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return null;
    const row = this.cached
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
    const row = this.cached
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
    this.cached
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
   * Returns the stored cursor. With `ensureConversation`, the conversation
   * row is created or touched exactly as `ensureConversation(conversationId,
   * timestamp)` would, folded into the statements the write needs anyway.
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
    ensureConversation?: boolean;
  }): Cursor {
    const visible = computeChatVisibility(args.type, args.payload);
    const searchText = computeSearchText(args.type, args.payload);
    const payloadJson = toJsonValueString(args.payload ?? null);
    const envelopeJson = toJsonValueString(args.channelEnvelope ?? null);
    const existing = this.cached
      .prepare(
        `SELECT conversation_id AS conversationId, seq, visible
         FROM entry WHERE id = ? LIMIT 1`,
      )
      .get(args.eventId) as
      | { conversationId: string; seq: number; visible: number }
      | undefined;
    if (existing && existing.conversationId !== args.conversationId) {
      this.cached
        .prepare(
          "DELETE FROM entry_ref WHERE conversation_id = ? AND entry_seq = ?",
        )
        .run(existing.conversationId, existing.seq);
      this.cached.prepare("DELETE FROM entry WHERE id = ?").run(args.eventId);
    }
    if (existing && existing.conversationId === args.conversationId) {
      if (args.ensureConversation) {
        this.touchConversation(args.conversationId, args.timestamp);
      }
      this.cached
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
      this.syncEntryRefs(
        args.conversationId,
        existing.seq,
        args.type,
        args.payload,
      );
      return {
        id: args.eventId,
        timestamp: args.timestamp,
        sequence: existing.seq,
      };
    }
    const seq = args.ensureConversation
      ? this.claimSeqEnsuringConversation(args.conversationId, args.timestamp)
      : this.claimSeq(args.conversationId);
    const turnSeq =
      args.type === "user_message" && visible === 1
        ? seq
        : this.lastVisibleUserSeq(args.conversationId);
    this.cached
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
    this.syncEntryRefs(args.conversationId, seq, args.type, args.payload);
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
    const conversationId = requireConversationId(args.conversationId);
    const type = asTrimmedString(args.type);
    if (!type) {
      throw new Error("type is required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const eventId =
      asTrimmedString(args.eventId) || `local-${generateLocalId()}`;
    const payload = asObject(args.payload) ?? undefined;
    const channelEnvelope = asObject(args.channelEnvelope) ?? undefined;
    const deviceId = asTrimmedString(args.deviceId) || undefined;
    const requestId = asTrimmedString(args.requestId) || undefined;
    const targetDeviceId = asTrimmedString(args.targetDeviceId) || undefined;
    let cursor: Cursor | null = null;
    this.tx.immediate(() => {
      cursor = this.upsertEvent({
        conversationId,
        eventId,
        type,
        timestamp,
        deviceId,
        requestId,
        targetDeviceId,
        payload,
        channelEnvelope,
        ensureConversation: true,
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
    const conversationId = requireConversationId(args.conversationId);
    const eventId = asTrimmedString(args.eventId);
    if (!eventId) return null;
    let updatedRecord: LocalChatEventRecord | null = null;
    this.tx.immediate(() => {
      const existingRow = this.cached
        .prepare(
          `SELECT ${ENTRY_SELECT} FROM entry
           WHERE entry.id = ? AND entry.conversation_id = ?`,
        )
        .get(eventId, conversationId) as EntryRow | undefined;
      if (!existingRow) {
        return;
      }
      const existingPayload = parseJsonRecord(existingRow.payloadJson) ?? {};
      const mergedPayload = { ...existingPayload, ...args.patch };
      const visible = computeChatVisibility(existingRow.type, mergedPayload);
      const searchText = computeSearchText(existingRow.type, mergedPayload);
      this.cached
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
          conversationId,
        );
      updatedRecord = {
        ...this.deserializeEventRow(existingRow),
        payload: mergedPayload,
      };
    });
    return updatedRecord;
  }

  hasEvent(
    conversationId: string,
    eventIdInput: string,
    typeInput?: string,
  ): boolean {
    conversationId = requireConversationId(conversationId);
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return false;
    const type = asTrimmedString(typeInput);
    const row = this.cached
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
    const statement = this.cached.prepare(
      type
        ? "SELECT 1 AS present FROM entry WHERE id = ? AND type = ? LIMIT 1"
        : "SELECT 1 AS present FROM entry WHERE id = ? LIMIT 1",
    );
    return Boolean(
      type ? statement.get(eventId, type) : statement.get(eventId),
    );
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
    conversationId = requireConversationId(conversationId);
    const normalizedLimit = Math.max(1, Math.floor(maxItems));
    const rows = this.cached
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

  /**
   * The window `listEvents(conversationId, maxItems)` would return, queried
   * for only the rows a caller needs (see `event-window.ts`). Each query is
   * one statement: the window's lower bound (the seq of its oldest row) is a
   * subquery, so nothing outside the window can match.
   */
  openEventWindow(
    conversationId: string,
    maxItems: number,
  ): LocalChatEventWindow {
    conversationId = requireConversationId(conversationId);
    const windowOffset = Math.max(1, Math.floor(maxItems)) - 1;
    return {
      query: (query: LocalChatEventWindowQuery) => {
        if (query.types.length === 0) return [];
        // Fewer rows than the window: no lower bound (seq starts at 1).
        const clauses = [
          "entry.conversation_id = ?",
          `entry.type IN (${placeholders(query.types)})`,
          `entry.seq >= COALESCE((
             SELECT seq FROM entry
             WHERE conversation_id = ?
               AND type NOT IN (${placeholders(NON_EVENT_TYPES)})
             ORDER BY seq DESC
             LIMIT 1 OFFSET ?
           ), 0)`,
        ];
        const params: unknown[] = [
          conversationId,
          ...query.types,
          conversationId,
          ...NON_EVENT_TYPES,
          windowOffset,
        ];
        if (query.beforeTimestamp !== undefined) {
          clauses.push("entry.created_at < ?");
          params.push(query.beforeTimestamp);
        }
        if (query.payloadKey !== undefined) {
          clauses.push("instr(entry.payload, ?) > 0");
          params.push(JSON.stringify(query.payloadKey));
        }
        const limit =
          query.limit !== undefined && query.limit >= 0
            ? Math.floor(query.limit)
            : -1;
        const rows = this.cached
          .prepare(
            `SELECT * FROM (
               SELECT ${ENTRY_SELECT} FROM entry
               WHERE ${clauses.join(" AND ")}
               ORDER BY entry.seq DESC
               LIMIT ?
             ) ORDER BY sequence ASC`,
          )
          .all(...params, limit) as EntryRow[];
        return rows.map((row) => this.deserializeEventRow(row));
      },
    };
  }

  listEventsBefore(
    conversationId: string,
    opts: { beforeTimestampMs: number; beforeId?: string; limit?: number },
  ): LocalChatEventRecord[] {
    conversationId = requireConversationId(conversationId);
    const normalizedLimit = Math.max(1, Math.floor(opts.limit ?? 50));
    const before = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(opts.beforeTimestampMs),
      id: opts.beforeId ?? "",
    });
    const keyset = cursorKeyset("<", before);
    const rows = this.cached
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
    const rows = this.cached
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
    args: {
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    } = {},
  ): { activities: LocalChatEventRecord[] } {
    conversationId = requireConversationId(conversationId);
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
      const keyset = cursorKeyset("<", before);
      clauses.push(keyset.clause);
      params.push(...keyset.params);
    }
    params.push(normalizedLimit);
    const rows = this.cached
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
    args: {
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    } = {},
  ): { files: LocalChatEventRecord[] } {
    conversationId = requireConversationId(conversationId);
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
      const keyset = cursorKeyset("<", before);
      clauses.push(keyset.clause);
      params.push(...keyset.params);
    }
    params.push(normalizedLimit);
    const rows = this.cached
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
    conversationId = requireConversationId(conversationId);
    const row = this.cached
      .prepare(
        `SELECT COUNT(*) AS count FROM entry
         WHERE conversation_id = ?
           AND type NOT IN (${placeholders(NON_EVENT_TYPES)})`,
      )
      .get(conversationId, ...NON_EVENT_TYPES) as
      | { count?: number }
      | undefined;
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
    conversationId = requireConversationId(conversationId);
    const normalizedLimit = Math.max(1, Math.floor(maxMessages));
    const rows = this.cached
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

  /**
   * Visible user and assistant messages after `afterSeq`, ascending, from at
   * most `limit` rows: each with its text, and the last row's seq.
   */
  listMessagesAfterSeq(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): {
    messages: Array<{
      id: string;
      seq: number;
      role: "user" | "assistant";
      text: string;
      timestamp: number;
    }>;
    throughSeq: number;
    complete: boolean;
  } {
    conversationId = requireConversationId(conversationId);
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const rows = this.cached
      .prepare(
        `SELECT entry.id AS id, entry.seq AS seq, entry.created_at AS timestamp,
                entry.type AS type, entry.payload AS payloadJson
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.seq > ?
           AND entry.type IN (${placeholders(CHAT_MESSAGE_TYPES)})
           AND entry.visible = 1
         ORDER BY entry.seq ASC
         LIMIT ?`,
      )
      .all(
        conversationId,
        afterSeq,
        ...CHAT_MESSAGE_TYPES,
        normalizedLimit,
      ) as Array<{
      id: string;
      seq: number;
      timestamp: number;
      type: string;
      payloadJson: string | null;
    }>;
    const messages: Array<{
      id: string;
      seq: number;
      role: "user" | "assistant";
      text: string;
      timestamp: number;
    }> = [];
    for (const row of rows) {
      const text = eventTextFromPayload(parseJsonRecord(row.payloadJson));
      if (!text) continue;
      messages.push({
        id: row.id,
        seq: row.seq,
        role: row.type === "user_message" ? "user" : "assistant",
        text,
        timestamp: row.timestamp,
      });
    }
    return {
      messages,
      throughSeq: rows.at(-1)?.seq ?? afterSeq,
      complete: rows.length < normalizedLimit,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Reply references                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Mirror an assistant entry's `metadata.runtime.replyRefs` into the
   * `entry_ref` index. Runs inside the entry write, so the index is exactly
   * the payload and never has to be rebuilt.
   */
  private syncEntryRefs(
    conversationId: string,
    entrySeq: number,
    type: string,
    payload: Record<string, unknown> | undefined,
  ): void {
    this.cached
      .prepare(
        "DELETE FROM entry_ref WHERE conversation_id = ? AND entry_seq = ?",
      )
      .run(conversationId, entrySeq);
    if (type !== "assistant_message") return;
    const refs = readReplyRefs(payload);
    if (refs.length === 0) return;
    const insert = this.cached.prepare(
      `INSERT OR IGNORE INTO entry_ref (
         conversation_id, entry_seq, target_kind, target_key
       ) VALUES (?, ?, ?, ?)`,
    );
    for (const ref of refs) {
      insert.run(
        conversationId,
        entrySeq,
        ref.kind,
        ref.kind === "message" ? String(ref.sequence) : ref.threadId,
      );
    }
  }

  /**
   * Validate the citations a reply carried against this conversation.
   * Unknown sequence numbers and unknown thread ids drop silently; the
   * message right above the reply is dropped too (a chip pointing at the
   * adjacent bubble is noise). When nothing survives and the turn was an
   * agent lifecycle turn, the agent itself is the reference.
   */
  resolveReplyRefs(
    conversationId: string,
    raw: readonly RawReplyRef[],
    options: { excludeMessageId?: string; fallbackAgentId?: string } = {},
  ): ReplyRef[] {
    conversationId = requireConversationId(conversationId);
    const resolved: ReplyRef[] = [];
    const seen = new Set<string>();
    const push = (ref: ReplyRef) => {
      const key =
        ref.kind === "message" ? `m:${ref.sequence}` : `a:${ref.threadId}`;
      if (seen.has(key)) return;
      seen.add(key);
      resolved.push(ref);
    };
    const resolveAgent = (threadId: string): ReplyRef | null => {
      const row = this.cached
        .prepare(
          `SELECT description FROM agent
           WHERE thread_id = ? AND conversation_id = ? LIMIT 1`,
        )
        .get(threadId, conversationId) as
        | { description?: string | null }
        | undefined;
      if (!row) return null;
      return {
        kind: "agent",
        threadId,
        title: asTrimmedString(row.description) || threadId,
      };
    };
    for (const ref of raw) {
      if (ref.kind === "agent") {
        const agent = resolveAgent(ref.threadId.trim());
        if (agent) push(agent);
        continue;
      }
      const row = this.cached
        .prepare(
          `SELECT id, type, payload AS payloadJson FROM entry
           WHERE conversation_id = ? AND seq = ?
             AND type IN (${placeholders(CHAT_MESSAGE_TYPES)})
             AND visible = 1
           LIMIT 1`,
        )
        .get(conversationId, ref.sequence, ...CHAT_MESSAGE_TYPES) as
        | { id: string; type: string; payloadJson: string | null }
        | undefined;
      if (!row) continue;
      if (options.excludeMessageId && row.id === options.excludeMessageId) {
        continue;
      }
      const payload = parseJsonRecord(row.payloadJson) ?? undefined;
      push({
        kind: "message",
        sequence: ref.sequence,
        id: row.id,
        role: row.type === "user_message" ? "user" : "assistant",
        preview: toReplyPreview(eventTextFromPayload(payload)),
      });
    }
    if (resolved.length === 0 && options.fallbackAgentId) {
      const agent = resolveAgent(options.fallbackAgentId.trim());
      if (agent) push(agent);
    }
    return resolved;
  }

  /** Reply counts for every cited message and agent in a conversation. */
  listReplyCounts(conversationId: string): ReplyCounts {
    conversationId = requireConversationId(conversationId);
    const rows = this.cached
      .prepare(
        `SELECT target_kind AS kind, target_key AS key, COUNT(*) AS count
         FROM entry_ref
         WHERE conversation_id = ?
         GROUP BY target_kind, target_key`,
      )
      .all(conversationId) as Array<{
      kind: string;
      key: string;
      count: number;
    }>;
    const counts: ReplyCounts = { messages: {}, agents: {} };
    const messageSeqs: number[] = [];
    const countBySeq = new Map<number, number>();
    for (const row of rows) {
      if (row.kind === "agent") {
        counts.agents[row.key] = row.count;
        continue;
      }
      const seq = Number.parseInt(row.key, 10);
      if (!Number.isSafeInteger(seq)) continue;
      messageSeqs.push(seq);
      countBySeq.set(seq, row.count);
    }
    for (let index = 0; index < messageSeqs.length; index += 500) {
      const chunk = messageSeqs.slice(index, index + 500);
      const idRows = this.db
        .prepare(
          `SELECT id, seq FROM entry
           WHERE conversation_id = ? AND seq IN (${placeholders(chunk)})`,
        )
        .all(conversationId, ...chunk) as Array<{ id: string; seq: number }>;
      for (const row of idRows) {
        counts.messages[row.id] = countBySeq.get(row.seq) ?? 0;
      }
    }
    return counts;
  }
}
