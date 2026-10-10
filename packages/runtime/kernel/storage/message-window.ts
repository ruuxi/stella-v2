/**
 * Message windows over the chat log: the timeline pages the chat UI renders
 * (visible messages with their turn's tool events attached), the tool-event
 * pages behind one message, and a message or agent's reply lineage.
 *
 * Reads only; every row comes from `entry` through ChatLog's cursor and row
 * helpers.
 */

import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";
import type { ConversationFocusRoot } from "@stella/contracts/reply-refs";
import {
  CHAT_MESSAGE_TYPES,
  CUTOFF_SCAN_CEILING,
  ENTRY_SELECT,
  LIFECYCLE_EVENT_TYPES,
  NON_EVENT_TYPES,
  TIMELINE_EVENT_TYPES,
  TOOL_EVENT_TYPES,
  cursorKeyset,
  placeholders,
  type ChatLog,
  type EntryRow,
} from "./chat-log.js";
import {
  cachedStatements,
  requireConversationId,
  type CachedStatements,
  type LocalChatEventRecord,
  type SqliteDatabase,
} from "./shared.js";
import {
  EAGER_TOOL_EVENT_LIMIT,
  EAGER_TOOL_EVENT_SIDE_LIMIT,
  compareTimelineCursor,
  projectLocalChatUpdateEventWithMetadata,
  type Cursor,
} from "./view.js";

const MAX_VISIBLE_MESSAGE_WINDOW = 500;

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

function cursorFromRow(row: {
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

/**
 * Group a turn-ordered run of chat rows into message records: tool rows
 * attach to the visible assistant reply they follow, or to the turn's user
 * message when no reply has started yet.
 */
export function assembleMessageWindow(rows: LocalChatEventRecord[]): {
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

function trimMessageWindow(
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

function limitChangedMessageWindow(
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

export class MessageWindowReader {
  private readonly cached: CachedStatements;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly log: ChatLog,
  ) {
    this.cached = cachedStatements(db);
  }

  /* ------------------------------------------------------------------ */
  /* Timeline windows                                                    */
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
      const k = cursorKeyset(
        op,
        this.log.resolveCursorSequence(args.conversationId, cursor),
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
    return rows.map((row) => this.log.deserializeEventRow(row));
  }

  private findVisibleMessageCutoffPaged(
    conversationId: string,
    maxVisibleMessages: number,
    initialBefore: Cursor | null,
  ): Cursor | null {
    const before = this.log.resolveCursorSequence(
      conversationId,
      initialBefore,
    );
    const beforeKeyset = before ? cursorKeyset("<", before) : null;
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
    return row ? cursorFromRow(row) : null;
  }

  findVisibleMessagePageEndAfter(
    conversationId: string,
    maxVisibleMessages: number,
    initialAfter: Cursor,
  ): Cursor | null {
    conversationId = requireConversationId(conversationId);
    const after = this.log.resolveCursorSequence(conversationId, initialAfter);
    const keyset = cursorKeyset(">", after);
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
    return row ? cursorFromRow(row) : null;
  }

  findVisibleMessageCursorAfter(
    conversationId: string,
    initialAfter: Cursor,
  ): Cursor | null {
    conversationId = requireConversationId(conversationId);
    const after = this.log.resolveCursorSequence(conversationId, initialAfter);
    const keyset = cursorKeyset(">", after);
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
    return row ? cursorFromRow(row) : null;
  }

  private findTurnFetchCutoff(
    conversationId: string,
    cutoff: Cursor | null,
  ): Cursor | null {
    if (!cutoff) return null;
    const resolved = this.log.resolveCursorSequence(conversationId, cutoff);
    const keyset = cursorKeyset("<=", resolved);
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
    const cursor = row ? cursorFromRow(row) : null;
    return cursor ?? resolved;
  }

  private findNextUserMessageAfter(
    conversationId: string,
    cursor: Cursor | null,
  ): Cursor | null {
    if (!cursor) return null;
    const resolved = this.log.resolveCursorSequence(conversationId, cursor);
    const keyset = cursorKeyset(">", resolved);
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
    return row ? cursorFromRow(row) : null;
  }

  private findPreviousVisibleAssistantAfter(
    conversationId: string,
    start: Cursor | null,
    before: Cursor | null,
  ): Cursor | null {
    if (!start || !before) return null;
    const startKeyset = cursorKeyset(
      ">",
      this.log.resolveCursorSequence(conversationId, start),
    );
    const beforeKeyset = cursorKeyset(
      "<",
      this.log.resolveCursorSequence(conversationId, before),
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
    return row ? cursorFromRow(row) : null;
  }

  private findLatestTimelineCursor(
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
      const k = cursorKeyset(
        "<",
        this.log.resolveCursorSequence(conversationId, until),
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
    return row ? cursorFromRow(row) : null;
  }

  private fetchBoundedToolEvents(
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
      const k = cursorKeyset(
        ">",
        this.log.resolveCursorSequence(conversationId, start),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    if (end) {
      const k = cursorKeyset(
        "<",
        this.log.resolveCursorSequence(conversationId, end),
      );
      clauses.push(k.clause);
      params.push(...k.params);
    }
    const select = `SELECT ${ENTRY_SELECT} FROM entry WHERE ${clauses.join(" AND ")}`;
    const headProbeRows = this.cached
      .prepare(
        `${select} ORDER BY entry.seq ASC LIMIT ${EAGER_TOOL_EVENT_LIMIT + 1}`,
      )
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
          this.log.deserializeEventRow(row),
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

  private attachBoundedToolEvents(
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

  listMessages(
    conversationId: string,
    args: { maxVisibleMessages?: number } = {},
  ): ChatMessageWindow {
    conversationId = requireConversationId(conversationId);
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
      assembleMessageWindow(rows),
      null,
    );
    const nextCursor = this.findLatestTimelineCursor(conversationId);
    return {
      ...trimMessageWindow(projected, cutoff),
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
    conversationId = requireConversationId(conversationId);
    const maxVisibleMessages = Math.max(
      1,
      Math.min(
        MAX_VISIBLE_MESSAGE_WINDOW,
        Math.floor(args.maxVisibleMessages ?? 200),
      ),
    );
    const before = this.log.resolveCursorSequence(conversationId, {
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
      assembleMessageWindow(rows),
      before,
    );
    return trimMessageWindow(projected, cutoff);
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
    conversationId = requireConversationId(conversationId);
    const maxVisibleMessages = Math.max(
      1,
      Math.min(
        MAX_VISIBLE_MESSAGE_WINDOW,
        Math.floor(args.maxVisibleMessages ?? 200),
      ),
    );
    const after = this.log.resolveCursorSequence(conversationId, {
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
            [...messageRows, ...sourceEvents].map((event) => [
              event._id,
              event,
            ]),
          ).values(),
        ).sort((a, b) =>
          compareTimelineCursor(
            { timestamp: a.timestamp, id: a._id, sequence: a.sequence },
            { timestamp: b.timestamp, id: b._id, sequence: b.sequence },
          ),
        )
      : messageRows;
    const assembled = assembleMessageWindow(projectionRows);
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
      ...limitChangedMessageWindow(projected, after, maxVisibleMessages),
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
    conversationId = requireConversationId(conversationId);
    const anchor = this.log.resolveCursorSequence(conversationId, {
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
      ? this.log.resolveCursorSequence(conversationId, {
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
  /* Lineage                                                             */
  /* ------------------------------------------------------------------ */

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
    conversationId = requireConversationId(conversationId);
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
      if (!row)
        return { messages: [], visibleMessageCount: 0, hasOlder: false };
      rootSeqs.push(row.seq);
      const turnRows = this.cached
        .prepare(
          `SELECT seq FROM entry
           WHERE conversation_id = ? AND turn_seq = ? AND visible = 1
             AND type IN (${placeholders(CHAT_MESSAGE_TYPES)})`,
        )
        .all(conversationId, row.seq, ...CHAT_MESSAGE_TYPES) as Array<{
        seq: number;
      }>;
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
      const record = this.log.deserializeEventRow(row);
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
        .all(
          conversationId,
          ...LIFECYCLE_EVENT_TYPES,
          args.root.threadId,
        ) as EntryRow[];
      for (const row of lifecycle) {
        const event = projectLocalChatUpdateEventWithMetadata(
          this.log.deserializeEventRow(row),
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
    const keyset = cursorKeyset(
      "<",
      this.log.resolveCursorSequence(conversationId, before),
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
    return row ? cursorFromRow(row) : null;
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
