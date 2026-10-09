import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDesktopDatabase } from "./database-init.js";
import {
  deleteLegacyRunEventBatch,
  sweepLegacyRunEventEntries,
} from "./entry-retention.js";
import { SessionStore } from "./session-store.js";
import type { SqliteDatabase } from "./shared.js";

const CONVERSATION = "01KZM4J1001R4KZ6NMADE854WA";
const OTHER_CONVERSATION = "01KWJ93DCEH7FVYAZ849P21J68";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const createStore = () => {
  const raw = new Database(":memory:");
  databases.push(raw);
  const db = raw as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  return { db, store: new SessionStore(db) };
};

const countRunEvents = (db: SqliteDatabase, conversationId?: string) =>
  (
    db
      .prepare(
        conversationId
          ? "SELECT COUNT(*) AS n FROM entry WHERE type = 'run_event' AND conversation_id = ?"
          : "SELECT COUNT(*) AS n FROM entry WHERE type = 'run_event'",
      )
      .get(...(conversationId ? [conversationId] : [])) as { n: number }
  ).n;

/**
 * Insert a row exactly as the retired `ChatLog.recordRunEvent` did: it
 * claimed the next conversation seq, took the current turn's user seq, and
 * stored the run id and agent type alongside the payload.
 */
const insertLegacyRunEvent = (
  db: SqliteDatabase,
  conversationId: string,
  runId: string,
  timestamp: number,
  payload: Record<string, unknown>,
) => {
  const { seq } = db
    .prepare(
      `UPDATE conversation SET next_seq = next_seq + 1
       WHERE id = ? RETURNING next_seq - 1 AS seq`,
    )
    .get(conversationId) as { seq: number };
  const turn = db
    .prepare(
      `SELECT MAX(seq) AS seq FROM entry
       WHERE conversation_id = ? AND type = 'user_message' AND visible = 1`,
    )
    .get(conversationId) as { seq: number | null };
  db.prepare(
    `INSERT INTO entry (
       conversation_id, seq, id, type, role, visible, turn_seq,
       run_id, agent_type, payload, created_at, updated_at
     ) VALUES (?, ?, ?, 'run_event', 'system', 0, ?, ?, 'orchestrator', ?, ?, ?)`,
  ).run(
    conversationId,
    seq,
    `run:${runId}:${seq}`,
    turn.seq,
    runId,
    JSON.stringify({ runId, conversationId, timestamp, ...payload }),
    timestamp,
    timestamp,
  );
};

/** A few turns with tool calls, legacy run_event rows interleaved as before. */
const seedConversation = (
  db: SqliteDatabase,
  store: SessionStore,
  conversationId: string,
  base: number,
) => {
  for (let turn = 0; turn < 3; turn += 1) {
    const t = base + turn * 100;
    const runId = `run-${conversationId}-${turn}`;
    store.appendEvent({
      conversationId,
      type: "user_message",
      eventId: `${conversationId}-user-${turn}`,
      timestamp: t,
      payload: { text: `question ${turn} about zebra migrations` },
    });
    insertLegacyRunEvent(db, conversationId, runId, t + 1, { type: "run_start" });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      eventId: `${conversationId}-tool-req-${turn}`,
      requestId: `call-${turn}`,
      timestamp: t + 2,
      payload: { toolName: "Bash", args: { command: "ls" } },
    });
    insertLegacyRunEvent(db, conversationId, runId, t + 3, {
      type: "tool_start",
      toolCallId: `call-${turn}`,
      toolName: "Bash",
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      eventId: `${conversationId}-tool-res-${turn}`,
      requestId: `call-${turn}`,
      timestamp: t + 4,
      payload: { toolName: "Bash", resultPreview: "ok" },
    });
    insertLegacyRunEvent(db, conversationId, runId, t + 5, {
      type: "tool_end",
      toolCallId: `call-${turn}`,
      resultPreview: "ok",
    });
    if (turn === 1) {
      store.appendEvent({
        conversationId,
        type: "agent-started",
        eventId: `${conversationId}-agent-started`,
        timestamp: t + 6,
        payload: { agentId: "thread-a", description: "look into zebras" },
      });
    }
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      eventId: `${conversationId}-assistant-${turn}`,
      timestamp: t + 7,
      payload: { text: `answer ${turn}: zebra stripes`, userMessageId: `${conversationId}-user-${turn}` },
    });
    // The legacy writer's run_end landed after the reply, so the newest
    // entry in a conversation was usually a run_event.
    insertLegacyRunEvent(db, conversationId, runId, t + 8, {
      type: "run_end",
      finalText: `answer ${turn}`,
    });
  }
};

const snapshot = (store: SessionStore, threadKey: string) => {
  const events = store.listEvents(CONVERSATION, 500);
  const pivot = events[4]!;
  const firstUser = events.find((event) => event.type === "user_message")!;
  return {
    events,
    eventsBefore: store.listEventsBefore(CONVERSATION, {
      beforeTimestampMs: pivot.timestamp,
      beforeId: pivot._id,
      limit: 3,
    }),
    eventCount: store.getEventCount(CONVERSATION),
    syncMessages: store.listSyncMessages(CONVERSATION),
    messages: store.listMessages(CONVERSATION, { maxVisibleMessages: 50 }),
    messagesAfter: store.listMessagesAfter(CONVERSATION, {
      afterTimestampMs: firstUser.timestamp,
      afterId: firstUser._id,
      afterSequence: firstUser.sequence,
      maxVisibleMessages: 50,
    }),
    messagesAfterWithoutSource: store.listMessagesAfter(CONVERSATION, {
      afterTimestampMs: firstUser.timestamp,
      afterId: firstUser._id,
      afterSequence: firstUser.sequence,
      maxVisibleMessages: 50,
      includeSourceEvents: false,
    }),
    activity: store.listActivity(CONVERSATION),
    recentActivity: store.listRecentActivitySince({ sinceMs: 0, limit: 500 }),
    summaries: store.listConversationSummaries({}),
    thread: store.loadThreadMessages(threadKey),
  };
};

describe("run_event writes", () => {
  test("every chat and thread read is identical before and after the sweep", async () => {
    const { db, store } = createStore();
    seedConversation(db, store, CONVERSATION, 10_000);
    seedConversation(db, store, OTHER_CONVERSATION, 20_000);
    const threadKey = "thread-a";
    store.ensureThreadSession(threadKey, CONVERSATION, 10_050);
    store.appendThreadMessage({
      timestamp: 10_051,
      threadKey,
      role: "user",
      content: "look into zebras",
    });
    store.appendThreadMessage({
      timestamp: 10_052,
      threadKey,
      role: "assistant",
      content: "zebras have stripes",
    });
    expect(countRunEvents(db)).toBe(24);

    const before = snapshot(store, threadKey);
    // Sanity: the snapshot actually exercises the tail and tool attachment.
    expect(before.messages.messages.length).toBeGreaterThan(0);
    expect(before.messages.nextCursor?.id).toBe(`${CONVERSATION}-assistant-2`);
    expect(before.thread.length).toBe(2);

    const result = await sweepLegacyRunEventEntries(db, {
      batchSize: 5,
      pauseMs: 0,
      transaction: (work) => store.withImmediateTransaction(work),
    });
    expect(result).toEqual({ deleted: 24, batches: 5, outcome: "complete" });
    expect(countRunEvents(db)).toBe(0);

    expect(snapshot(store, threadKey)).toEqual(before);
  });
});

describe("sweepLegacyRunEventEntries", () => {
  const seedRunEvents = (
    db: SqliteDatabase,
    store: SessionStore,
    counts: Record<string, number>,
  ) => {
    for (const [conversationId, count] of Object.entries(counts)) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        eventId: `${conversationId}-user`,
        timestamp: 1,
        payload: { text: "hi" },
      });
      for (let index = 0; index < count; index += 1) {
        insertLegacyRunEvent(db, conversationId, `run-${conversationId}`, 2 + index, {
          type: "tool_end",
        });
      }
    }
  };

  test("deletes in bounded batches, one transaction each", async () => {
    const { db, store } = createStore();
    seedRunEvents(db, store, { [CONVERSATION]: 25, [OTHER_CONVERSATION]: 12 });
    const perTransaction: number[] = [];
    const result = await sweepLegacyRunEventEntries(db, {
      batchSize: 10,
      pauseMs: 0,
      transaction: (work) => {
        const before = countRunEvents(db);
        const value = store.withImmediateTransaction(work);
        perTransaction.push(before - countRunEvents(db));
        return value;
      },
    });
    expect(result).toEqual({ deleted: 37, batches: 4, outcome: "complete" });
    expect(Math.max(...perTransaction)).toBeLessThanOrEqual(10);
    expect(perTransaction.filter((n) => n > 0)).toEqual([10, 10, 10, 7]);
    expect(countRunEvents(db)).toBe(0);
    // Only run_event rows go.
    expect(store.getEventCount(CONVERSATION)).toBe(1);
    expect(store.getEventCount(OTHER_CONVERSATION)).toBe(1);
  });

  test("each batch seeks the (conversation_id, type, seq) index", () => {
    const { db } = createStore();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT rowid AS id FROM entry
         WHERE conversation_id = ? AND type = ? LIMIT ?`,
      )
      .all("c", "run_event", 10) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "idx_entry_conv_type_seq",
    );
  });

  test("stops when the worker is busy and resumes on the next pass", async () => {
    const { db, store } = createStore();
    seedRunEvents(db, store, { [CONVERSATION]: 30 });

    const neverIdle = await sweepLegacyRunEventEntries(db, {
      batchSize: 10,
      pauseMs: 0,
      isIdle: () => false,
    });
    expect(neverIdle).toEqual({ deleted: 0, batches: 0, outcome: "busy" });
    expect(countRunEvents(db)).toBe(30);

    let checks = 0;
    const busyAfterTwo = await sweepLegacyRunEventEntries(db, {
      batchSize: 10,
      pauseMs: 0,
      isIdle: () => (checks += 1) <= 2,
    });
    expect(busyAfterTwo).toEqual({ deleted: 20, batches: 2, outcome: "busy" });
    expect(countRunEvents(db)).toBe(10);

    const rest = await sweepLegacyRunEventEntries(db, { batchSize: 10, pauseMs: 0 });
    expect(rest).toEqual({ deleted: 10, batches: 1, outcome: "complete" });
    expect(countRunEvents(db)).toBe(0);
  });

  test("an abort stops the pass between batches", async () => {
    const { db, store } = createStore();
    seedRunEvents(db, store, { [CONVERSATION]: 30 });
    const controller = new AbortController();
    let batches = 0;
    const result = await sweepLegacyRunEventEntries(db, {
      batchSize: 10,
      pauseMs: 5,
      signal: controller.signal,
      transaction: (work) => {
        const value = store.withImmediateTransaction(work);
        batches += 1;
        if (batches === 1) controller.abort();
        return value;
      },
    });
    expect(result).toEqual({ deleted: 10, batches: 1, outcome: "aborted" });
    expect(countRunEvents(db)).toBe(20);

    const preAborted = await sweepLegacyRunEventEntries(db, {
      signal: controller.signal,
    });
    expect(preAborted).toEqual({ deleted: 0, batches: 0, outcome: "aborted" });
    expect(countRunEvents(db)).toBe(20);
  });

  test("a single batch never exceeds its bound and reports where to resume", () => {
    const { db, store } = createStore();
    seedRunEvents(db, store, { [CONVERSATION]: 3, [OTHER_CONVERSATION]: 3 });
    const first = deleteLegacyRunEventBatch(db, { batchSize: 4 });
    expect(first.deleted).toBe(4);
    expect(first.resumeFrom).not.toBeNull();
    const second = deleteLegacyRunEventBatch(db, {
      batchSize: 4,
      fromConversationId: first.resumeFrom,
    });
    expect(second).toEqual({ deleted: 2, resumeFrom: null });
    expect(countRunEvents(db)).toBe(0);
  });
});
