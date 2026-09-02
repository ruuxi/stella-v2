import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ConversationIndexEvent } from "@stella/contracts/turn-plane/outbox";
import { EXCERPT_FLUSH_BATCH } from "../src/conversation-types.js";
import { ConversationIndex } from "../src/index-flush.js";
import { Journal } from "../src/journal.js";
import { fakeOutbox } from "./helpers/turn-plane-fakes.js";

/**
 * The index projection now travels as `conversation.index` outbox events. The
 * flush keeps its batching and its epoch fence; only the transport changed,
 * so these tests pin what a Convex ingest will see and what the local cursors
 * do on each outcome.
 */

const databases: Database[] = [];

const openJournal = async () => {
  const database = new Database(":memory:");
  databases.push(database);
  const kv = new Map<string, unknown>();
  const sql = {
    get databaseSize() {
      return 0;
    },
    exec<T>(statement: string, ...bindings: unknown[]) {
      const query = statement.trim();
      const rows = /^(SELECT|PRAGMA|WITH)\b/i.test(query)
        ? (database.query(query).all(...bindings) as T[])
        : (database.run(query, bindings), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`Expected one row, received ${rows.length}.`);
          }
          return rows[0]!;
        },
      };
    },
  };
  const storage = {
    sql,
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") kv.set(key, value);
      else {
        for (const [entryKey, entryValue] of Object.entries(key)) {
          kv.set(entryKey, entryValue);
        }
      }
    },
    delete: async (key: string) => kv.delete(key),
    transactionSync: <T>(operation: () => T): T =>
      database.transaction(operation)(),
  };
  const journal = new Journal(
    { storage } as unknown as DurableObjectState,
    () => undefined,
  );
  await journal.bootstrap();
  journal.bindOwner({
    ownerId: "owner-1",
    ownerGeneration: "generation-1",
    conversationId: "conversation-1",
    createdAt: 1,
    title: "Conversation",
  });
  return journal;
};

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

const appendUser = (journal: Journal, turnId: string, text: string) =>
  journal.appendMessage({
    turnId,
    writer: "orchestrator",
    writerKey: `writer:${turnId}`,
    role: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  });

const indexFor = (
  journal: Journal,
  outbox: ReturnType<typeof fakeOutbox>,
  options: { purged?: () => boolean } = {},
) =>
  new ConversationIndex(
    journal,
    () => undefined,
    () => ({ ownerId: "owner-1", ownerGeneration: "generation-1" }),
    {
      enqueue: (events) => outbox.queue.sendBatch(events.map((body) => ({ body }))),
      purged: options.purged ?? (() => false),
    },
  );

describe("conversation index over the outbox", () => {
  test("ships the row plus excerpts as one fenced event and advances both cursors", async () => {
    const journal = await openJournal();
    const outbox = fakeOutbox();
    appendUser(journal, "turn-1", "hello there");
    journal.putExcerpt({
      turn_id: "turn-1",
      seq_start: 0,
      seq_end: 0,
      text: "hello there",
      created_at: 1,
    });
    const index = indexFor(journal, outbox);
    expect(index.lagging()).toBe(true);
    const result = await index.flush({ activity: "idle", updatedAt: 42 });
    expect(result).toEqual({ accepted: true, pendingExcerpts: 0 });
    expect(outbox.events).toHaveLength(1);
    const event = outbox.events[0] as ConversationIndexEvent;
    expect(event).toMatchObject({
      v: 1,
      kind: "conversation.index",
      key: "conversation-1:1:0:42:0",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      conversationId: "conversation-1",
      epoch: 1,
      lastSeq: 0,
      updatedAt: 42,
      createdAt: 1,
      title: "Conversation",
      lastPreview: "hello there",
      lastRole: "user",
      activity: "idle",
      excerpts: [
        {
          turnId: "turn-1",
          seqStart: 0,
          seqEnd: 0,
          text: "hello there",
          createdAt: 1,
        },
      ],
    });
    expect(event.force).toBeUndefined();
    expect(journal.meta().index_synced_seq).toBe(0);
    expect(journal.unsyncedExcerptCount()).toBe(0);
    expect(index.lagging()).toBe(false);
  });

  test("drains a backlog in EXCERPT_FLUSH_BATCH-sized events that repeat the same fence", async () => {
    const journal = await openJournal();
    const outbox = fakeOutbox();
    const total = EXCERPT_FLUSH_BATCH + 3;
    for (let i = 0; i < total; i += 1) {
      appendUser(journal, `turn-${i}`, `message ${i}`);
      journal.putExcerpt({
        turn_id: `turn-${i}`,
        seq_start: i,
        seq_end: i,
        text: `message ${i}`,
        created_at: i,
      });
    }
    const index = indexFor(journal, outbox);
    const result = await index.flush({ activity: "idle", updatedAt: 7 });
    expect(result).toEqual({ accepted: true, pendingExcerpts: 0 });
    expect(outbox.events).toHaveLength(2);
    const [first, second] = outbox.events as ConversationIndexEvent[];
    expect(first?.excerpts).toHaveLength(EXCERPT_FLUSH_BATCH);
    expect(second?.excerpts).toHaveLength(3);
    expect(first?.key).toBe(`conversation-1:1:${total - 1}:7:0`);
    expect(second?.key).toBe(`conversation-1:1:${total - 1}:7:1`);
    expect(second?.lastSeq).toBe(first?.lastSeq);

    // A capped drain stops early and stays lagging for the next boundary.
    const journal2 = await openJournal();
    const outbox2 = fakeOutbox();
    for (let i = 0; i < total; i += 1) {
      appendUser(journal2, `turn-${i}`, `message ${i}`);
      journal2.putExcerpt({
        turn_id: `turn-${i}`,
        seq_start: i,
        seq_end: i,
        text: `message ${i}`,
        created_at: i,
      });
    }
    const capped = indexFor(journal2, outbox2);
    const partial = await capped.flush({
      activity: "idle",
      updatedAt: 8,
      maxBatches: 1,
    });
    expect(partial).toEqual({ accepted: true, pendingExcerpts: 3 });
    expect(capped.lagging()).toBe(true);
  });

  test("a refused enqueue never advances the cursors and is retried at the next flush", async () => {
    const journal = await openJournal();
    const outbox = fakeOutbox();
    appendUser(journal, "turn-1", "keep this pending");
    journal.putExcerpt({
      turn_id: "turn-1",
      seq_start: 0,
      seq_end: 0,
      text: "keep this pending",
      created_at: 1,
    });
    outbox.failNext(1);
    const index = indexFor(journal, outbox);
    expect(await index.flush({ activity: "idle", updatedAt: 1 })).toEqual({
      accepted: false,
      pendingExcerpts: 1,
    });
    expect(journal.meta().index_synced_seq).toBe(-1);
    expect(journal.unsyncedExcerptCount()).toBe(1);
    expect(index.lagging()).toBe(true);
    expect(await index.flush({ activity: "idle", updatedAt: 2 })).toEqual({
      accepted: true,
      pendingExcerpts: 0,
    });
    expect(outbox.events).toHaveLength(1);
  });

  test("an old-epoch send cannot mark a rewound head synced", async () => {
    const journal = await openJournal();
    appendUser(journal, "turn-old", "old");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const index = new ConversationIndex(
      journal,
      () => undefined,
      () => ({ ownerId: "owner-1", ownerGeneration: "generation-1" }),
      {
        enqueue: async () => {
          started();
          await gate;
        },
        purged: () => false,
      },
    );
    const flushing = index.flush({ activity: "idle", updatedAt: 1 });
    await sendStarted;
    await journal.applyTruncate({
      operationId: "operation-1",
      throughSeq: -1,
      expectedEpoch: 1,
      expectedLastSeq: 0,
      removedSegmentFirstSeqs: [],
      purgeKeys: [],
      retiredWriterKeys: [],
      retiredTurnIds: ["turn-old"],
      retiredAt: 2,
      resultJson: JSON.stringify({ complete: true, nextEpoch: 2, lastSeq: -1 }),
    });
    release();
    await flushing;
    expect(journal.meta().index_synced_seq).toBe(-1);
    appendUser(journal, "turn-new", "new");
    expect(index.lagging()).toBe(true);
  });

  test("a purged session sends nothing, and a forced reindex replays every excerpt", async () => {
    const journal = await openJournal();
    const outbox = fakeOutbox();
    appendUser(journal, "turn-1", "one");
    journal.putExcerpt({
      turn_id: "turn-1",
      seq_start: 0,
      seq_end: 0,
      text: "one",
      created_at: 1,
    });
    let purged = false;
    const index = indexFor(journal, outbox, { purged: () => purged });
    await index.flush({ activity: "idle", updatedAt: 1 });
    expect(outbox.events).toHaveLength(1);
    expect(journal.unsyncedExcerptCount()).toBe(0);
    const forced = await index.flush({
      activity: "idle",
      updatedAt: 2,
      force: true,
    });
    expect(forced).toEqual({ accepted: true, pendingExcerpts: 0 });
    expect(outbox.events).toHaveLength(2);
    expect((outbox.events[1] as ConversationIndexEvent).force).toBe(true);
    expect((outbox.events[1] as ConversationIndexEvent).excerpts).toHaveLength(1);
    purged = true;
    // Refused before `force` can mark anything unsynced: nothing is owed to
    // a conversation that no longer exists.
    expect(await index.flush({ activity: "idle", updatedAt: 3, force: true })).toEqual({
      accepted: false,
      pendingExcerpts: 0,
    });
    expect(outbox.events).toHaveLength(2);
  });
});
