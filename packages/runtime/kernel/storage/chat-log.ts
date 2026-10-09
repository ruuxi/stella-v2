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
  type ConversationFocusRoot,
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
  toJsonValueString,
  type CachedStatements,
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
import type {
  LocalChatEventWindow,
  LocalChatEventWindowQuery,
} from "./event-window.js";

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
/**
 * Legacy event types that never surface through the event APIs. Nothing
 * writes them any more; `run_event` rows left in existing stores are
 * deleted by `sweepLegacyRunEventEntries` (entry-retention.ts).
 */
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
        if (!existing.startsWith("local_")) this.ensureConversation(existing, Date.now());
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
    const now = Date.now();
    this.tx.immediate(() => {
      // Selecting a private draft reserves its id without adding a history row.
      // appendMessage/appendEvent materializes it with the first message.
      if (!conversationId.startsWith("local_")) this.ensureConversation(conversationId, now);
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
      | { conversationId: string; updatedAt: number; payloadJson: string | null }
      | undefined;
    if (!row) return null;
    return {
      conversationId: row.conversationId,
      title: conversationTitle(row.payloadJson),
      updatedAt: row.updatedAt,
    };
  }

  deleteConversation(conversationId: string): boolean {
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
    const eventId = asTrimmedString(args.eventId);
    if (!eventId) return null;
    let updatedRecord: LocalChatEventRecord | null = null;
    this.tx.immediate(() => {
      const existingRow = this.cached
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
          args.conversationId,
        );
      updatedRecord = {
        ...this.deserializeEventRow(existingRow),
        payload: mergedPayload,
      };
    });
    return updatedRecord;
  }

  hasEvent(conversationId: string, eventIdInput: string, typeInput?: string): boolean {
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
      const countRow = this.cached
        .prepare(
          "SELECT COUNT(*) AS n FROM entry WHERE conversation_id = ? AND seq >= ?",
        )
        .get(conversationId, cursor.sequence) as { n?: number } | undefined;
      this.cached
        .prepare("DELETE FROM entry WHERE conversation_id = ? AND seq >= ?")
        .run(conversationId, cursor.sequence);
      removed = typeof countRow?.n === "number" ? countRow.n : 0;
      const orphanThreadRows = this.cached
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
        this.cached
          .prepare(
            `DELETE FROM blob WHERE id IN (
               SELECT blob_id FROM thread_entry
               WHERE thread_id = ? AND blob_id IS NOT NULL
             )`,
          )
          .run(threadId);
        this.cached.prepare("DELETE FROM thread WHERE id = ?").run(threadId);
        this.cached.prepare("DELETE FROM agent WHERE thread_id = ?").run(threadId);
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
    const rows = this.cached
      .prepare(
        `SELECT ${ENTRY_SELECT} FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type IN (${placeholders(CHAT_MESSAGE_TYPES)})
           AND entry.seq < ?
         ORDER BY entry.seq ASC`,
      )
      .all(conversationId, ...CHAT_MESSAGE_TYPES, cursor.sequence) as EntryRow[];
    const newConversationId = conversationId.startsWith("local_")
      ? `local_${generateLocalId()}`
      : generateLocalId();
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
    const normalizedLimit = Math.max(1, Math.floor(opts.limit ?? 50));
    const before = this.resolveCursorSequence(conversationId, {
      timestamp: Math.floor(opts.beforeTimestampMs),
      id: opts.beforeId ?? "",
    });
    const keyset = this.keyset("<", before);
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
    const row = this.cached
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
    const rows = this.cached
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
    const row = this.cached
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
    const rows = this.cached
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
    const row = this.cached
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
    const row = this.cached
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
    const row = this.cached
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
    const row = this.cached
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
    // Legacy non-event rows never anchor a cursor, so the result does not
    // depend on whether they are still present.
    const clauses = [
      "entry.conversation_id = ?",
      `entry.type NOT IN (${placeholders(NON_EVENT_TYPES)})`,
    ];
    const params: unknown[] = [conversationId, ...NON_EVENT_TYPES];
    if (until) {
      const k = this.keyset(
        "<",
        this.resolveCursorSequence(conversationId, until),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    const row = this.cached
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
    const headProbeRows = this.cached
      .prepare(`${select} ORDER BY entry.seq ASC LIMIT ${EAGER_TOOL_EVENT_LIMIT + 1}`)
      .all(...params) as EntryRow[];
    const eventCountTruncated = headProbeRows.length > EAGER_TOOL_EVENT_LIMIT;
    const headRows = eventCountTruncated
      ? headProbeRows.slice(0, EAGER_TOOL_EVENT_SIDE_LIMIT)
      : headProbeRows;
    const tailRows = eventCountTruncated
      ? (this.cached
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
    const anchorRow = this.cached
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

  /**
   * The lineage of one message or one agent thread: the root itself, the
   * turn that spawned the agent, and every reply that cited either. A
   * message root also carries its own turn's replies and every update on
   * the tasks that turn spawned — from the user's side the task is the ask,
   * and completions cite the task rather than the message. Newest first,
   * keyset-paged on `beforeSequence`, so a long-lived thread the user keeps
   * steering pages exactly like the main timeline.
   */
  listLineageMessages(
    conversationId: string,
    args: {
      root: ConversationFocusRoot;
      beforeSequence?: number;
      limit?: number;
    },
  ): {
    messages: ChatMessageRecord[];
    visibleMessageCount: number;
    hasOlder: boolean;
  } {
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 80)));
    const lineageSeqs = new Set<number>();
    const rootSeqs: number[] = [];
    if (args.root.kind === "message") {
      const row = this.cached
        .prepare(
          `SELECT seq FROM entry
           WHERE conversation_id = ? AND id = ?
             AND type IN (${placeholders(CHAT_MESSAGE_TYPES)})
           LIMIT 1`,
        )
        .get(conversationId, args.root.id, ...CHAT_MESSAGE_TYPES) as
        | { seq: number }
        | undefined;
      if (!row) return { messages: [], visibleMessageCount: 0, hasOlder: false };
      rootSeqs.push(row.seq);
      const turnRows = this.cached
        .prepare(
          `SELECT seq FROM entry
           WHERE conversation_id = ? AND turn_seq = ? AND visible = 1
             AND type IN (${placeholders(CHAT_MESSAGE_TYPES)})`,
        )
        .all(conversationId, row.seq, ...CHAT_MESSAGE_TYPES) as Array<{ seq: number }>;
      for (const turnRow of turnRows) lineageSeqs.add(turnRow.seq);
      const spawned = this.cached
        .prepare(
          `SELECT DISTINCT json_extract(payload, '$.agentId') AS agentId FROM entry
           WHERE conversation_id = ? AND type = 'agent-started' AND turn_seq = ?`,
        )
        .all(conversationId, row.seq) as Array<{ agentId: string | null }>;
      for (const { agentId } of spawned) {
        if (!agentId) continue;
        const agentRefs = this.cached
          .prepare(
            `SELECT entry_seq AS seq FROM entry_ref
             WHERE conversation_id = ? AND target_kind = 'agent' AND target_key = ?`,
          )
          .all(conversationId, agentId) as Array<{ seq: number }>;
        for (const ref of agentRefs) lineageSeqs.add(ref.seq);
      }
    } else {
      const threadId = args.root.threadId;
      const starts = this.cached
        .prepare(
          `SELECT seq, turn_seq AS turnSeq FROM entry
           WHERE conversation_id = ? AND type = 'agent-started'
             AND json_extract(payload, '$.agentId') = ?
           ORDER BY seq ASC`,
        )
        .all(conversationId, threadId) as Array<{
        seq: number;
        turnSeq: number | null;
      }>;
      for (const start of starts) {
        if (typeof start.turnSeq === "number") rootSeqs.push(start.turnSeq);
        // The visible row the spawn card is anchored on: the turn's last
        // visible chat message before the start event, if any.
        const anchor = this.cached
          .prepare(
            `SELECT seq FROM entry
             WHERE conversation_id = ? AND visible = 1
               AND type IN (${placeholders(CHAT_MESSAGE_TYPES)})
               AND seq < ? AND seq >= ?
             ORDER BY seq DESC LIMIT 1`,
          )
          .get(
            conversationId,
            ...CHAT_MESSAGE_TYPES,
            start.seq,
            start.turnSeq ?? 0,
          ) as { seq: number } | undefined;
        if (anchor) lineageSeqs.add(anchor.seq);
      }
      const agentRefs = this.cached
        .prepare(
          `SELECT entry_seq AS seq FROM entry_ref
           WHERE conversation_id = ? AND target_kind = 'agent' AND target_key = ?`,
        )
        .all(conversationId, threadId) as Array<{ seq: number }>;
      for (const row of agentRefs) lineageSeqs.add(row.seq);
    }
    for (const seq of rootSeqs) {
      lineageSeqs.add(seq);
      const refs = this.cached
        .prepare(
          `SELECT entry_seq AS seq FROM entry_ref
           WHERE conversation_id = ? AND target_kind = 'message' AND target_key = ?`,
        )
        .all(conversationId, String(seq)) as Array<{ seq: number }>;
      for (const row of refs) lineageSeqs.add(row.seq);
    }
    if (lineageSeqs.size === 0) {
      return { messages: [], visibleMessageCount: 0, hasOlder: false };
    }
    const candidateSeqs = [...lineageSeqs]
      .filter(
        (seq) =>
          typeof args.beforeSequence !== "number" || seq < args.beforeSequence,
      )
      .sort((a, b) => b - a)
      .slice(0, limit + 1);
    const hasOlder = candidateSeqs.length > limit;
    const pageSeqs = candidateSeqs.slice(0, limit);
    if (pageSeqs.length === 0) {
      return { messages: [], visibleMessageCount: 0, hasOlder: false };
    }
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_SELECT} FROM entry
         WHERE entry.conversation_id = ?
           AND entry.type IN (${placeholders(CHAT_MESSAGE_TYPES)})
           AND entry.visible = 1
           AND entry.seq IN (${placeholders(pageSeqs)})
         ORDER BY entry.seq ASC`,
      )
      .all(conversationId, ...CHAT_MESSAGE_TYPES, ...pageSeqs) as EntryRow[];
    const messages: ChatMessageRecord[] = rows.map((row) => {
      const record = this.deserializeEventRow(row);
      const cursor: Cursor = {
        timestamp: record.timestamp,
        id: record._id,
        ...(typeof record.sequence === "number"
          ? { sequence: record.sequence }
          : {}),
      };
      // Same range the main timeline attaches to an anchor: from the turn's
      // user message when this is the turn's first assistant reply,
      // otherwise from the row itself, up to the next visible chat message.
      const previous = this.findPreviousVisibleMessageCursor(
        conversationId,
        cursor,
      );
      const previousIsTurnUser =
        previous !== null &&
        record.type === "assistant_message" &&
        this.isUserMessageCursor(conversationId, previous);
      const start = previousIsTurnUser ? previous : cursor;
      const end = this.findVisibleMessageCursorAfter(conversationId, cursor);
      const { events, totalCount, eventCountTruncated, detailTruncated } =
        this.fetchBoundedToolEvents(conversationId, start, end);
      return {
        ...record,
        toolEvents: events,
        toolEventSummary: {
          totalCount,
          loadedCount: events.length,
          truncated: detailTruncated,
          ...(eventCountTruncated ? { totalCountIsLowerBound: true } : {}),
        },
      };
    });
    if (args.root.kind === "agent" && messages.length > 0) {
      // A completion event lands between an unrelated row and the reply that
      // cites the agent; pull the thread's lifecycle events onto the nearest
      // preceding lineage row so the spawn and completion cards still render.
      const lifecycle = this.cached
        .prepare(
          `SELECT ${ENTRY_SELECT} FROM entry
           WHERE entry.conversation_id = ?
             AND entry.type IN (${placeholders(LIFECYCLE_EVENT_TYPES)})
             AND json_extract(entry.payload, '$.agentId') = ?
           ORDER BY entry.seq ASC`,
        )
        .all(conversationId, ...LIFECYCLE_EVENT_TYPES, args.root.threadId) as EntryRow[];
      for (const row of lifecycle) {
        const event = projectLocalChatUpdateEventWithMetadata(
          this.deserializeEventRow(row),
        ).event;
        let host = messages[0]!;
        for (const message of messages) {
          if ((message.sequence ?? 0) <= row.sequence) host = message;
          else break;
        }
        if (host.toolEvents.some((existing) => existing._id === event._id)) {
          continue;
        }
        host.toolEvents = [...host.toolEvents, event].sort((a, b) =>
          compareTimelineCursor(
            { timestamp: a.timestamp, id: a._id, sequence: a.sequence },
            { timestamp: b.timestamp, id: b._id, sequence: b.sequence },
          ),
        );
      }
    }
    return { messages, visibleMessageCount: messages.length, hasOlder };
  }

  private findPreviousVisibleMessageCursor(
    conversationId: string,
    before: Cursor,
  ): Cursor | null {
    const keyset = this.keyset(
      "<",
      this.resolveCursorSequence(conversationId, before),
    );
    const row = this.cached
      .prepare(
        `SELECT entry.created_at AS timestamp, entry.id AS id, entry.seq AS sequence
         FROM entry
         WHERE entry.conversation_id = ?
           AND entry.visible = 1
           AND entry.type IN (${placeholders(CHAT_MESSAGE_TYPES)})
           AND ${keyset.clause}
         ORDER BY entry.seq DESC
         LIMIT 1`,
      )
      .get(conversationId, ...CHAT_MESSAGE_TYPES, ...keyset.params) as
      | { timestamp?: number; id?: string; sequence?: number }
      | undefined;
    return row ? this.cursorFromRow(row) : null;
  }

  private isUserMessageCursor(conversationId: string, cursor: Cursor): boolean {
    const row = this.cached
      .prepare(
        "SELECT type FROM entry WHERE conversation_id = ? AND id = ? LIMIT 1",
      )
      .get(conversationId, cursor.id) as { type?: string } | undefined;
    return row?.type === "user_message";
  }
}
