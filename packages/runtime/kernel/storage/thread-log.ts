/**
 * Durable agent-thread transcripts and materialized compaction state.
 *
 * Entries are append-only with a per-thread `seq` claimed in code. The
 * latest compaction checkpoint is materialized in `thread_context`, so
 * assembling a thread's model context is "head + checkpoint + tail" —
 * never an overlay reconstruction. Exact oversized payloads live in the
 * `blob` table; the entry row keeps a bounded rendering.
 */

import {
  MAX_ACTIVE_RUNTIME_THREADS,
  normalizeRuntimeThreadId,
} from "../runtime-threads.js";
import { slugify } from "../shared/slug.js";
import {
  QUARANTINE_CUSTOM_TYPE,
  parseQuarantineRecord,
} from "../agent-runtime/provider-abort-containment.js";
import {
  asFiniteNumber,
  asTrimmedString,
  generateLocalId,
  parseJsonRecord,
  toJsonValueString,
  type SqliteDatabase,
} from "./shared.js";
import {
  applyResidentFold,
  buildCheckpointMessages,
  buildCheckpointOverlay,
  buildFallbackThreadPayload,
  buildRawThreadMessages,
  buildThreadContextPressure,
  customMessageContainsImage,
  enforceCustomMessageRowSizeLimit,
  enforceThreadPayloadRowSizeLimit,
  jsonByteLength,
  parseJsonValue,
  parseStoredThreadLifecycleEvent,
  parseThreadSessionEntry,
  payloadContainsImage,
  toIsoTimestamp,
  type ParsedThreadEntry,
  type StoredCustomMessage,
  type ThreadMessageInput,
  type ThreadMessageRecord,
} from "./view.js";
type EnsureConversation = (conversationId: string, updatedAt: number) => void;

type ThreadEntryDbRow = {
  seq: number;
  entryId: string;
  entryType: string;
  timestampIso: string;
  createdAt: number;
  dataJson: string | null;
  blobId: number | null;
};

const THREAD_ENTRY_SELECT = `
  thread_entry.seq AS seq,
  thread_entry.id AS entryId,
  thread_entry.type AS entryType,
  thread_entry.timestamp_iso AS timestampIso,
  thread_entry.created_at AS createdAt,
  thread_entry.payload AS dataJson,
  thread_entry.blob_id AS blobId
`;

export type ThreadContextRow = {
  threadId: string;
  compactionEntryId: string;
  coveredFromSeq: number;
  coveredThroughSeq: number;
  summary: string;
  details: unknown;
  tokensBefore: number;
  timestampIso: string;
};

export class ThreadLog {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly tx: { immediate: (work: () => void) => void },
    private readonly ensureConversation: EnsureConversation,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Thread rows                                                         */
  /* ------------------------------------------------------------------ */

  deriveImplicitThreadMetadata(threadKey: string): {
    conversationId: string;
    agentType: string;
  } {
    const subagentMarker = "::subagent::";
    const subagentIndex = threadKey.indexOf(subagentMarker);
    if (subagentIndex > 0) {
      const conversationId = threadKey.slice(0, subagentIndex).trim();
      const remainder = threadKey.slice(subagentIndex + subagentMarker.length);
      const nextDelimiter = remainder.indexOf("::");
      const agentType =
        nextDelimiter > 0 ? remainder.slice(0, nextDelimiter).trim() : "subagent";
      if (conversationId) {
        return { conversationId, agentType: agentType || "subagent" };
      }
    }
    return { conversationId: threadKey, agentType: "orchestrator" };
  }

  ensureImplicitThreadRow(threadKey: string): {
    conversationId: string;
    agentType: string;
  } {
    const derived = this.deriveImplicitThreadMetadata(threadKey);
    const now = Date.now();
    this.ensureConversation(derived.conversationId, now);
    this.db
      .prepare(
        `INSERT INTO thread (
           id, conversation_id, agent_type, name, status,
           next_seq, created_at, last_used_at, summary
         )
         VALUES (?, ?, ?, ?, 'evicted', 1, ?, ?, NULL)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(threadKey, derived.conversationId, derived.agentType, threadKey, now, now);
    return derived;
  }

  getThreadConversationId(threadKey: string): string {
    const row = this.db
      .prepare("SELECT conversation_id AS conversationId FROM thread WHERE id = ? LIMIT 1")
      .get(threadKey) as { conversationId?: unknown } | undefined;
    if (
      typeof row?.conversationId === "string" &&
      row.conversationId.trim().length > 0
    ) {
      return row.conversationId;
    }
    return this.ensureImplicitThreadRow(threadKey).conversationId;
  }

  getThreadSession(threadKey: string): {
    sessionId: string;
    createdAt: number;
    cwd: string;
    parentSession: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT session_id AS sessionId, session_created_at AS createdAt,
                cwd, parent_session AS parentSession
         FROM thread WHERE id = ? AND session_id IS NOT NULL LIMIT 1`,
      )
      .get(threadKey) as
      | {
          sessionId: string;
          createdAt: number;
          cwd: string;
          parentSession: string | null;
        }
      | undefined;
    return row ?? null;
  }

  ensureThreadSession(
    threadKey: string,
    conversationId: string,
    timestamp: number,
  ): { sessionId: string; createdAt: number; cwd: string; parentSession: string | null } {
    const existing = this.getThreadSession(threadKey);
    if (existing) {
      return existing;
    }
    const sessionId = generateLocalId();
    this.ensureConversation(conversationId, timestamp);
    this.db
      .prepare(
        `UPDATE thread SET session_id = ?, session_created_at = ?, cwd = COALESCE(cwd, '')
         WHERE id = ?`,
      )
      .run(sessionId, timestamp, threadKey);
    return { sessionId, createdAt: timestamp, cwd: "", parentSession: null };
  }

  threadKeyExists(key: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS hit FROM thread WHERE id = ? LIMIT 1").get(key),
    );
  }

  mintUniqueKey(base: string): string {
    if (!this.threadKeyExists(base)) return base;
    for (let ordinal = 2; ; ordinal++) {
      const candidate = `${base}-${ordinal}`;
      if (!this.threadKeyExists(candidate)) return candidate;
    }
  }

  mintThreadKey(args: { agentType: string; nameHint?: string }): string {
    const slug = slugify(args.nameHint ?? "");
    if (slug && !slug.startsWith("legacy-")) {
      return this.mintUniqueKey(slug);
    }
    const prefix = "task-";
    const row = this.db
      .prepare(
        `SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS maxOrdinal
         FROM thread
         WHERE agent_type = ? AND id GLOB 'task-[0-9]*'`,
      )
      .get(prefix.length + 1, args.agentType) as
      | { maxOrdinal?: number | null }
      | undefined;
    const nextOrdinal =
      typeof row?.maxOrdinal === "number" && Number.isFinite(row.maxOrdinal)
        ? row.maxOrdinal + 1
        : 1;
    return this.mintUniqueKey(`${prefix}${nextOrdinal}`);
  }

  listActiveThreadsByAge(
    conversationId: string,
  ): Array<{ threadId: string; lastUsedAt: number }> {
    return this.db
      .prepare(
        `SELECT id AS threadId, last_used_at AS lastUsedAt
         FROM thread
         WHERE conversation_id = ? AND status = 'active'
         ORDER BY last_used_at ASC, id ASC`,
      )
      .all(conversationId) as Array<{ threadId: string; lastUsedAt: number }>;
  }

  evictOldestThread(conversationId: string): void {
    const oldest = this.listActiveThreadsByAge(conversationId)[0];
    if (!oldest) return;
    this.db
      .prepare(
        `UPDATE thread SET status = 'evicted'
         WHERE conversation_id = ? AND status = 'active' AND id = ?`,
      )
      .run(conversationId, oldest.threadId);
  }

  reactivateThread(conversationId: string, threadId: string): void {
    if (
      this.listActiveThreadsByAge(conversationId).length >=
      MAX_ACTIVE_RUNTIME_THREADS
    ) {
      this.evictOldestThread(conversationId);
    }
    this.db
      .prepare("UPDATE thread SET status = 'active' WHERE conversation_id = ? AND id = ?")
      .run(conversationId, threadId);
  }

  resolveOrCreateActiveThread(args: {
    conversationId: string;
    agentType: string;
    threadId?: string;
    nameHint?: string;
  }): { threadId: string; reused: boolean } {
    const requestedThreadId = normalizeRuntimeThreadId(args.threadId ?? "");
    const existing = requestedThreadId
      ? (this.db
          .prepare(
            `SELECT id AS threadId, conversation_id AS conversationId,
                    agent_type AS agentType, status
             FROM thread WHERE id = ? LIMIT 1`,
          )
          .get(requestedThreadId) as
          | {
              threadId: string;
              conversationId: string;
              agentType: string;
              status: string;
            }
          | undefined)
      : undefined;
    if (existing) {
      if (
        existing.conversationId !== args.conversationId ||
        existing.agentType !== args.agentType
      ) {
        throw new Error(
          `Thread ${existing.threadId} belongs to a different conversation or agent type.`,
        );
      }
      if (existing.status !== "active") {
        this.reactivateThread(args.conversationId, existing.threadId);
      }
      this.touchThread(existing.threadId);
      return { threadId: existing.threadId, reused: true };
    }
    if (
      this.listActiveThreadsByAge(args.conversationId).length >=
      MAX_ACTIVE_RUNTIME_THREADS
    ) {
      this.evictOldestThread(args.conversationId);
    }
    const threadId =
      requestedThreadId ??
      this.mintThreadKey({
        agentType: args.agentType,
        ...(args.nameHint ? { nameHint: args.nameHint } : {}),
      });
    const name =
      args.nameHint?.trim().replace(/\s+/g, " ").slice(0, 200) || threadId;
    const now = Date.now();
    this.ensureConversation(args.conversationId, now);
    this.db
      .prepare(
        `INSERT INTO thread (
           id, conversation_id, agent_type, name, status,
           next_seq, created_at, last_used_at, summary
         )
         VALUES (?, ?, ?, ?, 'active', 1, ?, ?, NULL)`,
      )
      .run(threadId, args.conversationId, args.agentType, name, now, now);
    this.refreshThreadSearchText(threadId);
    return { threadId, reused: false };
  }

  touchThread(threadKey: string): void {
    this.db
      .prepare("UPDATE thread SET last_used_at = ? WHERE id = ?")
      .run(Date.now(), threadKey);
  }

  getThreadExternalSessionId(threadKey: string): string | undefined {
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db
      .prepare(
        "SELECT external_session_id AS externalSessionId FROM thread WHERE id = ? LIMIT 1",
      )
      .get(threadKey) as { externalSessionId?: unknown } | undefined;
    return typeof row?.externalSessionId === "string" &&
      row.externalSessionId.trim().length > 0
      ? row.externalSessionId.trim()
      : undefined;
  }

  setThreadExternalSessionId(
    threadKey: string,
    // `null` is the dev cloud lane's explicit "clear" (force a fresh external
    // CLI session); it normalizes to the same NULL write as undefined.
    externalSessionId: string | null | undefined,
  ): void {
    this.ensureImplicitThreadRow(threadKey);
    const normalized =
      typeof externalSessionId === "string" && externalSessionId.trim().length > 0
        ? externalSessionId.trim()
        : null;
    this.db
      .prepare(
        "UPDATE thread SET external_session_id = ?, last_used_at = ? WHERE id = ?",
      )
      .run(normalized, Date.now(), threadKey);
  }

  updateThreadSummary(threadKey: string, summary: string): void {
    const trimmed = summary.trim();
    if (!trimmed) return;
    this.ensureImplicitThreadRow(threadKey);
    this.db
      .prepare("UPDATE thread SET summary = ?, last_used_at = ? WHERE id = ?")
      .run(trimmed, Date.now(), threadKey);
    this.refreshThreadSearchText(threadKey);
  }

  getThreadName(threadKey: string): string | undefined {
    const row = this.db
      .prepare("SELECT name FROM thread WHERE id = ? LIMIT 1")
      .get(threadKey) as { name?: unknown } | undefined;
    return typeof row?.name === "string" && row.name.length > 0
      ? row.name
      : undefined;
  }

  getThreadActivityMetadata(
    threadId: string,
  ): { groupKey?: string; groupLabel?: string } | null {
    const row = this.db
      .prepare("SELECT group_key, group_label FROM thread WHERE id = ? LIMIT 1")
      .get(threadId) as
      | { group_key?: string | null; group_label?: string | null }
      | undefined;
    if (!row) return null;
    return {
      ...(row.group_key ? { groupKey: row.group_key } : {}),
      ...(row.group_label ? { groupLabel: row.group_label } : {}),
    };
  }

  /**
   * Recompute the writer-maintained search text mirrored into thread_fts.
   * The single place search eligibility and content are defined.
   */
  refreshThreadSearchText(threadId: string): void {
    // The `search_text IS NOT ...` guard keeps no-op saves from rewriting the
    // row (and churning the FTS index through the update trigger).
    this.db
      .prepare(
        `UPDATE thread SET search_text = (
           SELECT next_text FROM (
             SELECT CASE
               WHEN thread.agent_type = 'orchestrator' OR thread.id LIKE '%::subagent::%' THEN NULL
               ELSE TRIM(
                 thread.id || char(10) || thread.name
                 || char(10) || COALESCE(thread.summary, '')
                 || char(10) || COALESCE((SELECT description FROM agent WHERE agent.thread_id = thread.id), '')
                 || char(10) || COALESCE((SELECT result FROM agent WHERE agent.thread_id = thread.id), '')
                 || char(10) || COALESCE((SELECT error FROM agent WHERE agent.thread_id = thread.id), '')
               )
             END AS next_text
           )
         )
         WHERE id = ?
           AND search_text IS NOT (
             SELECT CASE
               WHEN thread.agent_type = 'orchestrator' OR thread.id LIKE '%::subagent::%' THEN NULL
               ELSE TRIM(
                 thread.id || char(10) || thread.name
                 || char(10) || COALESCE(thread.summary, '')
                 || char(10) || COALESCE((SELECT description FROM agent WHERE agent.thread_id = thread.id), '')
                 || char(10) || COALESCE((SELECT result FROM agent WHERE agent.thread_id = thread.id), '')
                 || char(10) || COALESCE((SELECT error FROM agent WHERE agent.thread_id = thread.id), '')
               )
             END
           )`,
      )
      .run(threadId);
  }

  /* ------------------------------------------------------------------ */
  /* Entry writes                                                        */
  /* ------------------------------------------------------------------ */

  private claimThreadSeq(threadId: string): number {
    const row = this.db
      .prepare(
        "UPDATE thread SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq",
      )
      .get(threadId) as { seq?: number } | undefined;
    if (typeof row?.seq !== "number") {
      throw new Error(`Thread ${threadId} does not exist.`);
    }
    return row.seq;
  }

  getThreadLeafEntryId(threadKey: string): string | null {
    const row = this.db
      .prepare(
        "SELECT id AS entryId FROM thread_entry WHERE thread_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(threadKey) as { entryId?: unknown } | undefined;
    return typeof row?.entryId === "string" && row.entryId.trim().length > 0
      ? row.entryId
      : null;
  }

  /** Append one entry. Must run inside a transaction. */
  appendThreadSessionEntry(args: {
    threadKey: string;
    entryType: string;
    timestamp: number;
    data: unknown;
    exactData?: unknown;
    estTokens?: number;
    imageCount?: number;
    imageBytes?: number;
  }): string {
    const entryId = generateLocalId();
    const seq = this.claimThreadSeq(args.threadKey);
    const dataJson = toJsonValueString(args.data);
    const record = args.data as Record<string, unknown> | null;
    const role =
      args.entryType === "message"
        ? asTrimmedString((record as any)?.message?.role) || null
        : null;
    const customType =
      args.entryType === "custom_message"
        ? asTrimmedString((record as any)?.customType) || null
        : null;
    let blobId: number | null = null;
    if (args.exactData !== undefined) {
      const exactJson = toJsonValueString(args.exactData);
      if (exactJson !== null && exactJson !== dataJson) {
        const blobRow = this.db
          .prepare(
            "INSERT INTO blob (byte_length, content) VALUES (?, ?) RETURNING id",
          )
          .get(jsonByteLength(exactJson), exactJson) as
          | { id?: number }
          | undefined;
        blobId = typeof blobRow?.id === "number" ? blobRow.id : null;
      }
    }
    this.db
      .prepare(
        `INSERT INTO thread_entry (
           thread_id, seq, id, type, role, custom_type, payload, blob_id,
           est_tokens, image_count, image_bytes, timestamp_iso, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.threadKey,
        seq,
        entryId,
        args.entryType,
        role,
        customType,
        dataJson,
        blobId,
        Math.max(0, Math.floor(args.estTokens ?? 0)),
        Math.max(0, Math.floor(args.imageCount ?? 0)),
        Math.max(0, Math.floor(args.imageBytes ?? 0)),
        toIsoTimestamp(args.timestamp),
        args.timestamp,
      );
    return entryId;
  }

  appendThreadMessages(
    messages: ThreadMessageInput[],
  ): Array<{
    entryId: string;
    message: ThreadMessageInput;
    payload: ReturnType<typeof buildFallbackThreadPayload>;
    conversationId: string;
  }> {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const threadKey = normalizeRuntimeThreadId(messages[0]!.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const prepared = messages.map((message) => {
      if (normalizeRuntimeThreadId(message.threadKey) !== threadKey) {
        throw new Error(
          "All thread messages in a batch must use the same threadKey.",
        );
      }
      const fallbackPayload = buildFallbackThreadPayload(message);
      const boundedPayload = enforceThreadPayloadRowSizeLimit(fallbackPayload);
      const contextPressure = buildThreadContextPressure(fallbackPayload);
      const preserveExactly =
        message.preservePayloadExactly === true ||
        payloadContainsImage(fallbackPayload);
      return {
        message,
        payload: fallbackPayload,
        boundedPayload,
        contextPressure,
        preserveExactly,
      };
    });
    const conversationId = this.getThreadConversationId(threadKey);
    const appended: Array<{
      entryId: string;
      message: ThreadMessageInput;
      payload: ReturnType<typeof buildFallbackThreadPayload>;
      conversationId: string;
    }> = [];
    this.tx.immediate(() => {
      for (const item of prepared) {
        this.ensureConversation(conversationId, item.message.timestamp);
        this.ensureThreadSession(threadKey, conversationId, item.message.timestamp);
        const entryId = this.appendThreadSessionEntry({
          threadKey,
          entryType: "message",
          timestamp: item.message.timestamp,
          data: { message: item.boundedPayload },
          ...(item.preserveExactly ? { exactData: { message: item.payload } } : {}),
          estTokens: item.contextPressure.estimatedTokens,
          imageCount: item.contextPressure.imageCount,
          imageBytes: item.contextPressure.imageDecodedBytes,
        });
        appended.push({
          entryId,
          message: item.message,
          payload: item.payload,
          conversationId,
        });
      }
      this.touchThread(threadKey);
    });
    return appended;
  }

  appendThreadCustomMessage(message: {
    threadKey: string;
    customType: string;
    content: StoredCustomMessage["content"];
    display: boolean;
    timestamp: number;
    eventId?: string;
    preservePayloadExactly?: boolean;
  }): void {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const customType = message.customType.trim();
    if (!customType) {
      throw new Error("customType is required.");
    }
    const exactMessage: StoredCustomMessage = {
      customType,
      content: message.content,
      display: message.display,
      ...(message.eventId?.trim() ? { eventId: message.eventId.trim() } : {}),
    };
    const boundedMessage = enforceCustomMessageRowSizeLimit(exactMessage);
    const contextPressure = buildThreadContextPressure(exactMessage);
    const preserveExactly =
      message.preservePayloadExactly === true ||
      customMessageContainsImage(exactMessage);
    const conversationId = this.getThreadConversationId(threadKey);
    this.tx.immediate(() => {
      this.ensureConversation(conversationId, message.timestamp);
      this.ensureThreadSession(threadKey, conversationId, message.timestamp);
      this.appendThreadSessionEntry({
        threadKey,
        entryType: "custom_message",
        timestamp: message.timestamp,
        data: boundedMessage,
        ...(preserveExactly ? { exactData: exactMessage } : {}),
        estTokens: contextPressure.estimatedTokens,
        imageCount: contextPressure.imageCount,
        imageBytes: contextPressure.imageDecodedBytes,
      });
      this.touchThread(threadKey);
    });
  }

  appendThreadLifecycleEvent(message: {
    threadKey: string;
    event: unknown;
  }): void {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const event = parseStoredThreadLifecycleEvent(message.event);
    if (!event) {
      throw new Error("A valid lifecycle event is required.");
    }
    const conversationId = this.getThreadConversationId(threadKey);
    this.tx.immediate(() => {
      this.ensureConversation(conversationId, event.timestamp);
      this.ensureThreadSession(threadKey, conversationId, event.timestamp);
      this.appendThreadSessionEntry({
        threadKey,
        entryType: "lifecycle_event",
        timestamp: event.timestamp,
        data: { event },
      });
      this.touchThread(threadKey);
    });
  }

  hasThreadLifecycleEvent(threadKeyInput: string, eventIdInput: string): boolean {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    const eventId = asTrimmedString(eventIdInput);
    if (!threadKey || !eventId) {
      return false;
    }
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM thread_entry
         WHERE thread_id = ? AND type = 'lifecycle_event'
           AND json_extract(payload, '$.event._id') = ?
         LIMIT 1`,
      )
      .get(threadKey, eventId);
    return Boolean(row);
  }

  listThreadLifecycleEntries(
    threadKeyInput: string,
    limit = 300,
  ): Array<{ entryId: string; event: NonNullable<ReturnType<typeof parseStoredThreadLifecycleEvent>> }> {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const normalizedLimit = Math.min(
      500,
      Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 300)),
    );
    const rows = this.db
      .prepare(
        `SELECT id AS entryId, payload AS dataJson FROM (
           SELECT id, payload, seq FROM thread_entry
           WHERE thread_id = ? AND type = 'lifecycle_event'
           ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(threadKey, normalizedLimit) as Array<{
      entryId: string;
      dataJson: string | null;
    }>;
    return rows.flatMap((row) => {
      const data = parseJsonValue(row.dataJson);
      const event = parseStoredThreadLifecycleEvent(data?.event);
      return event ? [{ entryId: row.entryId, event }] : [];
    });
  }

  listRecentThreadUserMessages(
    threadKeyInput: string,
    limit = 8,
  ): Array<{ content: string; timestamp: number }> {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      return [];
    }
    const normalizedLimit = Math.min(50, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT created_at AS createdAt, payload AS dataJson
         FROM thread_entry
         WHERE thread_id = ? AND type = 'message' AND role = 'user'
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(threadKey, normalizedLimit) as Array<{
      createdAt: number;
      dataJson: string | null;
    }>;
    const results: Array<{ content: string; timestamp: number }> = [];
    for (const row of rows) {
      const timestamp = Number(row.createdAt);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      let content = "";
      try {
        const parsed = JSON.parse(row.dataJson ?? "null");
        const rawContent = parsed?.message?.content;
        if (typeof rawContent === "string") {
          content = rawContent;
        }
      } catch {
        /* unreadable rows keep an empty preview */
      }
      results.push({ content, timestamp });
    }
    return results;
  }

  removeThreadMessageEntry(threadKeyInput: string, entryIdInput: string): boolean {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    const entryId = typeof entryIdInput === "string" ? entryIdInput.trim() : "";
    if (!threadKey || !entryId) {
      return false;
    }
    let removed = 0;
    this.tx.immediate(() => {
      this.db
        .prepare(
          `DELETE FROM blob WHERE id IN (
             SELECT blob_id FROM thread_entry
             WHERE thread_id = ? AND id = ? AND type = 'message'
               AND blob_id IS NOT NULL
               AND seq = (SELECT MAX(seq) FROM thread_entry WHERE thread_id = ?)
           )`,
        )
        .run(threadKey, entryId, threadKey);
      const deleteResult = this.db
        .prepare(
          `DELETE FROM thread_entry
           WHERE thread_id = ? AND id = ? AND type = 'message'
             AND seq = (SELECT MAX(seq) FROM thread_entry WHERE thread_id = ?)`,
        )
        .run(threadKey, entryId, threadKey) as { changes?: number } | undefined;
      removed = deleteResult?.changes ?? 0;
      if (removed > 0) {
        this.touchThread(threadKey);
      }
    });
    return removed > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Entry reads                                                         */
  /* ------------------------------------------------------------------ */

  private resolveExactPayloads(
    rows: ThreadEntryDbRow[],
  ): Map<number, string> {
    const blobIds = rows
      .map((row) => row.blobId)
      .filter((id): id is number => typeof id === "number");
    if (blobIds.length === 0) return new Map();
    const result = new Map<number, string>();
    for (let index = 0; index < blobIds.length; index += 250) {
      const batch = blobIds.slice(index, index + 250);
      const blobRows = this.db
        .prepare(
          `SELECT id, content FROM blob WHERE id IN (${batch.map(() => "?").join(", ")})`,
        )
        .all(...batch) as Array<{ id: number; content: string }>;
      for (const blobRow of blobRows) {
        result.set(blobRow.id, blobRow.content);
      }
    }
    return result;
  }

  private parseEntryRows(rows: ThreadEntryDbRow[]): ParsedThreadEntry[] {
    const exactByBlobId = this.resolveExactPayloads(rows);
    return rows
      .map((row) => {
        const exact =
          typeof row.blobId === "number"
            ? exactByBlobId.get(row.blobId)
            : undefined;
        return parseThreadSessionEntry({
          entryId: row.entryId,
          parentEntryId: null,
          entryType: row.entryType,
          timestampIso: row.timestampIso,
          createdAt: row.createdAt,
          dataJson: exact ?? row.dataJson,
        });
      })
      .filter((entry): entry is ParsedThreadEntry => entry !== null);
  }

  loadThreadSessionEntries(threadKey: string, limit?: number): ParsedThreadEntry[] {
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    const sql = `
      SELECT * FROM (
        SELECT ${THREAD_ENTRY_SELECT} FROM thread_entry
        WHERE thread_id = ?
        ORDER BY seq DESC
        ${normalizedLimit ? "LIMIT ?" : ""}
      ) ORDER BY seq ASC
    `;
    const rows = (
      normalizedLimit
        ? this.db.prepare(sql).all(threadKey, normalizedLimit)
        : this.db.prepare(sql).all(threadKey)
    ) as ThreadEntryDbRow[];
    return this.parseEntryRows(rows);
  }

  getThreadContext(threadKey: string): ThreadContextRow | null {
    const row = this.db
      .prepare(
        `SELECT thread_id AS threadId, compaction_entry_id AS compactionEntryId,
                covered_from_seq AS coveredFromSeq,
                covered_through_seq AS coveredThroughSeq,
                summary, details, tokens_before AS tokensBefore,
                timestamp_iso AS timestampIso
         FROM thread_context WHERE thread_id = ? LIMIT 1`,
      )
      .get(threadKey) as
      | {
          threadId: string;
          compactionEntryId: string;
          coveredFromSeq: number;
          coveredThroughSeq: number;
          summary: string;
          details: string | null;
          tokensBefore: number;
          timestampIso: string;
        }
      | undefined;
    if (!row) return null;
    return {
      ...row,
      details: row.details === null ? undefined : parseJsonValue(row.details),
    };
  }

  findLatestRangeCompaction(threadKey: string): {
    entry: ParsedThreadEntry;
    coveredFromSequence: number;
    coveredThroughSequence: number;
  } | null {
    const context = this.getThreadContext(threadKey);
    if (!context) return null;
    const fromEntry = this.db
      .prepare("SELECT id FROM thread_entry WHERE thread_id = ? AND seq = ? LIMIT 1")
      .get(threadKey, context.coveredFromSeq) as { id?: string } | undefined;
    const toEntry = this.db
      .prepare("SELECT id FROM thread_entry WHERE thread_id = ? AND seq = ? LIMIT 1")
      .get(threadKey, context.coveredThroughSeq) as { id?: string } | undefined;
    if (!fromEntry?.id || !toEntry?.id) return null;
    return {
      entry: {
        type: "compaction",
        id: context.compactionEntryId,
        parentId: null,
        timestamp: context.timestampIso,
        summary: context.summary,
        fromEntryId: fromEntry.id,
        toEntryId: toEntry.id,
        tokensBefore: context.tokensBefore,
        ...(context.details !== undefined ? { details: context.details } : {}),
      },
      coveredFromSequence: context.coveredFromSeq,
      coveredThroughSequence: context.coveredThroughSeq,
    };
  }

  private loadEntriesInRange(
    threadKey: string,
    predicate: "<" | ">",
    seq: number,
  ): ParsedThreadEntry[] {
    const rows = this.db
      .prepare(
        `SELECT ${THREAD_ENTRY_SELECT} FROM thread_entry
         WHERE thread_id = ? AND seq ${predicate} ?
         ORDER BY seq ASC`,
      )
      .all(threadKey, seq) as ThreadEntryDbRow[];
    return this.parseEntryRows(rows);
  }

  loadThreadMessages(threadKeyInput: string, limit?: number): ThreadMessageRecord[] {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const context = limit ? null : this.getThreadContext(threadKey);
    if (!context) {
      return buildRawThreadMessages(
        this.loadThreadSessionEntries(threadKey, limit),
      );
    }
    const headEntries = this.loadEntriesInRange(
      threadKey,
      "<",
      context.coveredFromSeq,
    );
    const tailEntries = this.loadEntriesInRange(
      threadKey,
      ">",
      context.coveredThroughSeq,
    );
    const overlay = buildCheckpointOverlay({
      entryId: context.compactionEntryId,
      summary: context.summary,
      timestampIso: context.timestampIso,
      details: context.details,
    });
    const messages = [
      ...buildRawThreadMessages(headEntries),
      ...buildCheckpointMessages(overlay),
      ...buildRawThreadMessages(tailEntries),
    ];
    return overlay.residentFold || overlay.replaceDerivedContext
      ? applyResidentFold(messages, overlay)
      : messages;
  }

  loadRawThreadMessages(threadKeyInput: string): ThreadMessageRecord[] {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    return buildRawThreadMessages(this.loadThreadSessionEntries(threadKey));
  }

  /* ------------------------------------------------------------------ */
  /* Compaction                                                          */
  /* ------------------------------------------------------------------ */

  compactThread(args: {
    threadKey: string;
    summary: string;
    fromEntryId?: string;
    toEntryId?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    timestamp?: number;
    details?: unknown;
    fromHook?: boolean;
  }): { entryId: string; conversationId: string; timestamp: number } {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const summary = args.summary.trim();
    const fromEntryId = args.fromEntryId?.trim();
    const toEntryId = args.toEntryId?.trim();
    const firstKeptEntryId = args.firstKeptEntryId?.trim();
    if (!summary || (!(fromEntryId && toEntryId) && !firstKeptEntryId)) {
      throw new Error("summary and a compaction range are required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const conversationId = this.getThreadConversationId(threadKey);
    let entryId = "";
    this.tx.immediate(() => {
      const existingContext = this.getThreadContext(threadKey);
      const seqForEntry = (id: string): number | null => {
        const row = this.db
          .prepare(
            "SELECT seq FROM thread_entry WHERE thread_id = ? AND id = ? LIMIT 1",
          )
          .get(threadKey, id) as { seq?: number } | undefined;
        return typeof row?.seq === "number" ? row.seq : null;
      };
      let coveredFromSeq: number | null = null;
      let coveredThroughSeq: number | null = null;
      if (fromEntryId && toEntryId) {
        // A follow-up compaction always grows from the original range start.
        coveredFromSeq =
          existingContext?.coveredFromSeq ?? seqForEntry(fromEntryId);
        coveredThroughSeq = seqForEntry(toEntryId);
      } else if (firstKeptEntryId) {
        const firstKeptSeq = seqForEntry(firstKeptEntryId);
        const firstRow = this.db
          .prepare(
            `SELECT MIN(seq) AS seq FROM thread_entry
             WHERE thread_id = ? AND type IN ('message', 'custom_message')`,
          )
          .get(threadKey) as { seq?: number | null } | undefined;
        if (
          typeof firstKeptSeq === "number" &&
          typeof firstRow?.seq === "number" &&
          firstKeptSeq > firstRow.seq
        ) {
          coveredFromSeq = existingContext?.coveredFromSeq ?? firstRow.seq;
          coveredThroughSeq = firstKeptSeq - 1;
        }
      }
      this.ensureThreadSession(threadKey, conversationId, timestamp);
      const fromEntryIdForRecord =
        fromEntryId && toEntryId && coveredFromSeq !== null
          ? ((this.db
              .prepare(
                "SELECT id FROM thread_entry WHERE thread_id = ? AND seq = ? LIMIT 1",
              )
              .get(threadKey, coveredFromSeq) as { id?: string } | undefined)
              ?.id ?? fromEntryId)
          : fromEntryId;
      entryId = this.appendThreadSessionEntry({
        threadKey,
        entryType: "compaction",
        timestamp,
        data: {
          summary,
          ...(fromEntryId && toEntryId
            ? { fromEntryId: fromEntryIdForRecord, toEntryId }
            : { firstKeptEntryId }),
          tokensBefore: Math.max(0, Math.floor(args.tokensBefore)),
          ...(args.details !== undefined ? { details: args.details } : {}),
          ...(args.fromHook ? { fromHook: true } : {}),
        },
      });
      if (coveredFromSeq !== null && coveredThroughSeq !== null) {
        this.db
          .prepare(
            `INSERT INTO thread_context (
               thread_id, compaction_entry_id, covered_from_seq,
               covered_through_seq, summary, details, tokens_before,
               timestamp_iso, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET
               compaction_entry_id = excluded.compaction_entry_id,
               covered_from_seq = excluded.covered_from_seq,
               covered_through_seq = excluded.covered_through_seq,
               summary = excluded.summary,
               details = excluded.details,
               tokens_before = excluded.tokens_before,
               timestamp_iso = excluded.timestamp_iso,
               updated_at = excluded.updated_at`,
          )
          .run(
            threadKey,
            entryId,
            coveredFromSeq,
            coveredThroughSeq,
            summary,
            args.details !== undefined ? toJsonValueString(args.details) : null,
            Math.max(0, Math.floor(args.tokensBefore)),
            toIsoTimestamp(timestamp),
            timestamp,
            timestamp,
          );
      }
      this.touchThread(threadKey);
    });
    return { entryId, conversationId, timestamp };
  }

  /* ------------------------------------------------------------------ */
  /* Context pressure                                                    */
  /* ------------------------------------------------------------------ */

  getThreadContextPressureStats(threadKeyInput: string): {
    complete: boolean;
    rowCount: number;
    estimatedTokens: number;
    imageCount: number;
    imageDecodedBytes: number;
    quarantineCount: number;
  } {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const context = this.getThreadContext(threadKey);
    const rangePredicate = context ? "AND (seq < ? OR seq > ?)" : "";
    const rangeArgs = context
      ? [context.coveredFromSeq, context.coveredThroughSeq]
      : [];
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS rowCount,
                SUM(est_tokens) AS estimatedTokens,
                SUM(image_count) AS imageCount,
                SUM(image_bytes) AS imageDecodedBytes
         FROM thread_entry
         WHERE thread_id = ?
           AND type IN ('message', 'custom_message')
           ${rangePredicate}`,
      )
      .get(threadKey, ...rangeArgs) as
      | {
          rowCount?: number;
          estimatedTokens?: number | null;
          imageCount?: number | null;
          imageDecodedBytes?: number | null;
        }
      | undefined;
    const resolvedCoveredQuarantineKeys = new Set(
      context
        ? ((): string[] => {
            const details = context.details;
            const keys =
              details && typeof details === "object" && !Array.isArray(details)
                ? (details as any).quarantinedToolResultKeys
                : undefined;
            return Array.isArray(keys)
              ? keys.filter((key): key is string => typeof key === "string")
              : [];
          })()
        : [],
    );
    const quarantineRows = this.db
      .prepare(
        `SELECT seq, payload AS dataJson FROM thread_entry
         WHERE thread_id = ? AND custom_type = ?`,
      )
      .all(threadKey, QUARANTINE_CUSTOM_TYPE) as Array<{
      seq: number;
      dataJson: string | null;
    }>;
    let quarantineCount = 0;
    for (const quarantineRow of quarantineRows) {
      const coveredByCheckpoint =
        context !== null &&
        quarantineRow.seq >= context.coveredFromSeq &&
        quarantineRow.seq <= context.coveredThroughSeq;
      if (!coveredByCheckpoint) {
        quarantineCount += 1;
        continue;
      }
      const stored = parseJsonRecord(quarantineRow.dataJson);
      const record = parseQuarantineRecord(stored?.content);
      if (!record || !resolvedCoveredQuarantineKeys.has(record.key)) {
        quarantineCount += 1;
      }
    }
    const rowCount = Number(row?.rowCount ?? 0);
    const checkpointChars = context
      ? context.summary.length +
        JSON.stringify((context.details as any)?.imageReceipts ?? []).length
      : 0;
    return {
      complete: true,
      rowCount,
      estimatedTokens:
        Math.max(0, Number(row?.estimatedTokens ?? 0)) +
        Math.ceil(checkpointChars / 3),
      imageCount: Math.max(0, Number(row?.imageCount ?? 0)),
      imageDecodedBytes: Math.max(0, Number(row?.imageDecodedBytes ?? 0)),
      quarantineCount,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Usage analytics                                                     */
  /* ------------------------------------------------------------------ */

  listModelUsage(args: {
    fromMs?: number;
    toMs?: number;
    conversationId?: string;
    threadId?: string;
    limit?: number;
  } = {}): { records: Array<Record<string, unknown>>; truncated: boolean } {
    const fromMs = asFiniteNumber(args.fromMs);
    const toMs = asFiniteNumber(args.toMs);
    const conversationId = asTrimmedString(args.conversationId);
    const threadId =
      typeof args.threadId === "string" && args.threadId.trim()
        ? normalizeRuntimeThreadId(args.threadId)
        : undefined;
    const normalizedLimit = Math.min(
      10000,
      Math.max(1, Math.floor(asFiniteNumber(args.limit) ?? 5000)),
    );
    const clauses = [
      "te.type = 'message'",
      "te.role = 'assistant'",
      "json_type(te.payload, '$.message.usage') = 'object'",
      "COALESCE(json_extract(te.payload, '$.message.model'), '') != 'history'",
    ];
    const params: unknown[] = [];
    if (fromMs !== null) {
      clauses.push("te.created_at >= ?");
      params.push(Math.floor(fromMs));
    }
    if (toMs !== null) {
      clauses.push("te.created_at <= ?");
      params.push(Math.floor(toMs));
    }
    if (conversationId) {
      clauses.push("thread.conversation_id = ?");
      params.push(conversationId);
    }
    if (threadId) {
      clauses.push("thread.id = ?");
      params.push(threadId);
    }
    params.push(normalizedLimit + 1);
    const rows = this.db
      .prepare(
        `SELECT
           te.id AS id,
           te.created_at AS timestamp,
           thread.conversation_id AS conversationId,
           COALESCE(NULLIF(conversation.title, ''), thread.conversation_id) AS conversationTitle,
           thread.id AS threadId,
           thread.name AS threadName,
           thread.agent_type AS agentType,
           agent.description AS agentDescription,
           agent.agent_depth AS agentDepth,
           agent.parent_agent_id AS parentAgentId,
           agent.root_run_id AS rootRunId,
           json_extract(te.payload, '$.message.provider') AS provider,
           json_extract(te.payload, '$.message.api') AS api,
           json_extract(te.payload, '$.message.model') AS model,
           json_extract(te.payload, '$.message.responseModel') AS responseModel,
           json_extract(te.payload, '$.message.usage.input') AS inputTokens,
           json_extract(te.payload, '$.message.usage.cacheRead') AS cacheReadTokens,
           json_extract(te.payload, '$.message.usage.cacheWrite') AS cacheWriteTokens,
           json_extract(te.payload, '$.message.usage.output') AS outputTokens,
           json_extract(te.payload, '$.message.usage.reasoning') AS reasoningTokens,
           json_extract(te.payload, '$.message.usage.totalTokens') AS totalTokens,
           json_extract(te.payload, '$.message.usage.cost.input') AS inputCostUsd,
           json_extract(te.payload, '$.message.usage.cost.cacheRead') AS cacheReadCostUsd,
           json_extract(te.payload, '$.message.usage.cost.cacheWrite') AS cacheWriteCostUsd,
           json_extract(te.payload, '$.message.usage.cost.output') AS outputCostUsd,
           json_extract(te.payload, '$.message.usage.cost.total') AS totalCostUsd,
           json_extract(te.payload, '$.message.stopReason') AS stopReason,
           json_extract(te.payload, '$.message.errorMessage') AS errorMessage
         FROM thread_entry te
         JOIN thread ON thread.id = te.thread_id
         LEFT JOIN agent ON agent.thread_id = thread.id
         LEFT JOIN conversation ON conversation.id = thread.conversation_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY te.created_at DESC, te.id DESC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const truncated = rows.length > normalizedLimit;
    return {
      records: rows.slice(0, normalizedLimit).map((row) => {
        const rowConversationId = asTrimmedString(row.conversationId);
        const agentType = asTrimmedString(row.agentType);
        const agentDescription = asTrimmedString(row.agentDescription);
        const agentDepth = asFiniteNumber(row.agentDepth);
        const parentAgentId = asTrimmedString(row.parentAgentId);
        const rootRunId = asTrimmedString(row.rootRunId);
        const responseModel = asTrimmedString(row.responseModel);
        const errorMessage = asTrimmedString(row.errorMessage);
        return {
          id: asTrimmedString(row.id),
          timestamp: asFiniteNumber(row.timestamp) ?? 0,
          conversationId: rowConversationId,
          conversationTitle:
            asTrimmedString(row.conversationTitle) || rowConversationId,
          threadId: asTrimmedString(row.threadId),
          threadName: asTrimmedString(row.threadName) || agentType,
          agentType: agentType || "unknown",
          ...(agentDescription ? { agentDescription } : {}),
          ...(agentDepth !== null ? { agentDepth } : {}),
          ...(parentAgentId ? { parentAgentId } : {}),
          ...(rootRunId ? { rootRunId } : {}),
          provider: asTrimmedString(row.provider) || "unknown",
          api: asTrimmedString(row.api) || "unknown",
          model: asTrimmedString(row.model) || "unknown",
          ...(responseModel ? { responseModel } : {}),
          inputTokens: asFiniteNumber(row.inputTokens) ?? 0,
          cacheReadTokens: asFiniteNumber(row.cacheReadTokens) ?? 0,
          cacheWriteTokens: asFiniteNumber(row.cacheWriteTokens) ?? 0,
          outputTokens: asFiniteNumber(row.outputTokens) ?? 0,
          reasoningTokens: asFiniteNumber(row.reasoningTokens) ?? 0,
          totalTokens: asFiniteNumber(row.totalTokens) ?? 0,
          inputCostUsd: asFiniteNumber(row.inputCostUsd) ?? 0,
          cacheReadCostUsd: asFiniteNumber(row.cacheReadCostUsd) ?? 0,
          cacheWriteCostUsd: asFiniteNumber(row.cacheWriteCostUsd) ?? 0,
          outputCostUsd: asFiniteNumber(row.outputCostUsd) ?? 0,
          totalCostUsd: asFiniteNumber(row.totalCostUsd) ?? 0,
          stopReason: asTrimmedString(row.stopReason) || "unknown",
          ...(errorMessage ? { errorMessage } : {}),
        };
      }),
      truncated,
    };
  }
}
