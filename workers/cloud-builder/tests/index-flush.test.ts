import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ConversationIndexEvent } from "@stella/contracts/turn-plane/outbox";
import { ConversationIndex } from "../src/index-flush.js";
import { Journal } from "../src/journal.js";
import { fakeOutbox } from "./helpers/turn-plane-fakes.js";

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
      const rows = /^(SELECT|PRAGMA|WITH)\b/iu.test(query)
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
      enqueue: (events) =>
        outbox.queue.sendBatch(events.map((body) => ({ body }))),
      purged: options.purged ?? (() => false),
    },
  );

describe("conversation index over the outbox", () => {
  test("ships one excerpt-free fenced row and advances its cursor", async () => {
    const journal = await openJournal();
    const outbox = fakeOutbox();
    appendUser(journal, "turn-1", "hello there");
    const index = indexFor(journal, outbox);

    expect(index.lagging()).toBe(true);
    expect(await index.flush({ activity: "idle", updatedAt: 42 })).toEqual({
      accepted: true,
    });

    expect(outbox.events).toHaveLength(1);
    const event = outbox.events[0] as ConversationIndexEvent;
    expect(event).toMatchObject({
      v: 1,
      kind: "conversation.index",
      key: "conversation-1:1:0:42",
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
    });
    expect(event).not.toHaveProperty("excerpts");
    expect(event).not.toHaveProperty("force");
    expect(journal.meta().index_synced_seq).toBe(0);
    expect(index.lagging()).toBe(false);
  });

  test("a refused enqueue leaves the row lagging for the next flush", async () => {
    const journal = await openJournal();
    const outbox = fakeOutbox();
    appendUser(journal, "turn-1", "keep this pending");
    outbox.failNext(1);
    const index = indexFor(journal, outbox);

    expect(await index.flush({ activity: "idle", updatedAt: 1 })).toEqual({
      accepted: false,
    });
    expect(journal.meta().index_synced_seq).toBe(-1);
    expect(index.lagging()).toBe(true);
    expect(await index.flush({ activity: "idle", updatedAt: 2 })).toEqual({
      accepted: true,
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

    expect(await flushing).toEqual({ accepted: false });
    expect(journal.meta().index_synced_seq).toBe(-1);
    appendUser(journal, "turn-new", "new");
    expect(index.lagging()).toBe(true);
  });

  test("a purged session sends nothing", async () => {
    const journal = await openJournal();
    const outbox = fakeOutbox();
    appendUser(journal, "turn-1", "one");
    const index = indexFor(journal, outbox, { purged: () => true });

    expect(await index.flush({ activity: "idle", updatedAt: 1 })).toEqual({
      accepted: false,
    });
    expect(outbox.events).toHaveLength(0);
    expect(journal.meta().index_synced_seq).toBe(-1);
  });
});
