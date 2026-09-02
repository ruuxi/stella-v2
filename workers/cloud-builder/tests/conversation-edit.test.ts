import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ConversationArchive } from "../src/archive.js";
import {
  CONVERSATION_EDIT_LOCK_KEY,
  conversationRewindHeadMatches,
  parseConversationEditRequest,
  rewindRuntimeAdmission,
  sameConversationEditLock,
  type ConversationEditLock,
} from "../src/conversation-edit-protocol.js";
import { ConversationIndex } from "../src/index-flush.js";
import { Journal, StaleJournalWriterError } from "../src/journal.js";

const databases: Database[] = [];
const originalFetch = globalThis.fetch;

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
  const state = { storage } as unknown as DurableObjectState;
  const journal = new Journal(state, () => undefined);
  await journal.bootstrap();
  return { database, kv, state, journal };
};

const message = (text: string, timestamp: number) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp,
});

const bind = (journal: Journal, conversationId: string) =>
  journal.bindOwner({
    ownerId: "owner-1",
    ownerGeneration: "generation-1",
    conversationId,
    createdAt: 1,
    title: "Conversation",
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (databases.length) databases.pop()?.close();
});

describe("conversation edit service protocol", () => {
  test("accepts the empty-prefix boundary and rejects malformed OCC heads", () => {
    const parsed = parseConversationEditRequest({
      v: 1,
      kind: "fork",
      operationId: "operation-1",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      sourceConversationId: "source-conversation",
      targetConversationId: "target-conversation",
      throughSeq: -1,
      expectedEpoch: 1,
      expectedLastSeq: 4,
      title: "Conversation",
      sourceCreatedAt: 1,
      targetCreatedAt: 2,
    });
    expect(parsed).toMatchObject({ kind: "fork", throughSeq: -1 });
    expect(
      parseConversationEditRequest({
        ...(parsed as object),
        throughSeq: 5,
        expectedLastSeq: 4,
      }),
    ).toBeNull();
  });

  test("matches exact leases and conflicts active turns unless cancel is explicit", () => {
    const lock: ConversationEditLock = {
      kind: "rewind",
      operationId: "operation-1",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      expectedEpoch: 2,
      expectedLastSeq: 8,
      throughSeq: 3,
      expiresAt: Date.now() + 1_000,
    };
    const request = parseConversationEditRequest({
      v: 1,
      kind: "rewind",
      operationId: "operation-1",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      conversationId: "conversation-1",
      expectedEpoch: 2,
      expectedLastSeq: 8,
      throughSeq: 3,
      activeTurnPolicy: "conflict",
    })!;
    expect(CONVERSATION_EDIT_LOCK_KEY).toBe("conversationEditLock");
    expect(sameConversationEditLock(lock, request)).toBe(true);
    expect(
      sameConversationEditLock(lock, {
        ...request,
        ownerGeneration: "generation-2",
      }),
    ).toBe(false);
    expect(
      conversationRewindHeadMatches(request, { epoch: 2, lastSeq: 9 }, lock),
    ).toBe(false);
    expect(
      conversationRewindHeadMatches(
        { ...request, activeTurnPolicy: "cancel" },
        { epoch: 2, lastSeq: 9 },
        lock,
      ),
    ).toBe(true);
    expect(
      rewindRuntimeAdmission(request, {
        runtimeWork: true,
        queuedTurn: false,
        continuingOperation: false,
      }),
    ).toBe("turn-conflict");
    expect(
      rewindRuntimeAdmission(
        { ...request, activeTurnPolicy: "cancel" },
        {
          runtimeWork: true,
          queuedTurn: true,
          continuingOperation: false,
        },
      ),
    ).toBe("queued-conflict");
    expect(
      rewindRuntimeAdmission(
        { ...request, activeTurnPolicy: "cancel" },
        {
          runtimeWork: true,
          queuedTurn: false,
          continuingOperation: false,
        },
      ),
    ).toBe("cancel");

    const fork = parseConversationEditRequest({
      v: 1,
      kind: "fork",
      operationId: "operation-2",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      sourceConversationId: "source-conversation",
      targetConversationId: "target-conversation",
      throughSeq: 3,
      expectedEpoch: 2,
      expectedLastSeq: 8,
      title: "Conversation",
      sourceCreatedAt: 1,
      targetCreatedAt: 2,
    })!;
    expect(
      sameConversationEditLock(
        {
          ...lock,
          kind: "fork-target",
          operationId: fork.operationId,
        },
        fork,
      ),
    ).toBe(true);
  });
});

describe("canonical fork and rewind journal transitions", () => {
  test("exports one gapless prefix across archived R2 and resident SQLite rows", async () => {
    const { journal } = await openJournal();
    bind(journal, "source-conversation");
    for (let seq = 0; seq < 4; seq += 1) {
      journal.appendMessage({
        turnId: `turn-${seq}`,
        writer: "orchestrator",
        writerKey: `writer-${seq}`,
        role: "user",
        message: message(`message ${seq}`, seq + 1),
        createdAt: seq + 1,
      });
    }
    const coldRows = journal.rowsForArchive(0, 1, 10);
    const key = "conversations/owner/source/segment.jsonl.gz";
    const bytes = await new Response(
      new Blob([
        [
          JSON.stringify({
            v: 1,
            conversationId: "source-conversation",
            ownerId: "owner-1",
            epoch: 1,
            firstSeq: 0,
            lastSeq: 1,
            rows: 2,
            createdAt: 1,
          }),
          ...coldRows.map((row) => JSON.stringify(row)),
          "",
        ].join("\n"),
      ])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    journal.insertSegment({
      first_seq: 0,
      last_seq: 1,
      rows: 2,
      bytes: coldRows.reduce((total, row) => total + row.bytes, 0),
      r2_key: key,
      state: "uploading",
      created_at: 1,
    });
    journal.commitSegment(0, 1);

    const bucket = {
      get: async (requested: string) =>
        requested === key
          ? {
              body: new Blob([bytes]).stream(),
              arrayBuffer: async () => bytes,
              size: bytes.byteLength,
            }
          : null,
    } as unknown as R2Bucket;
    const archive = new ConversationArchive(bucket, journal, () => undefined);
    const page = await archive.exportRawPage(0, 3, 10, 1024 * 1024);
    expect(page.complete).toBe(true);
    expect(page.rows.map((row) => row.seq)).toEqual([0, 1, 2, 3]);
  });

  test("imports an exact prefix into a fresh target with independent writer keys", async () => {
    const source = await openJournal();
    bind(source.journal, "source-conversation");
    for (let seq = 0; seq < 3; seq += 1) {
      source.journal.appendMessage({
        turnId: `turn-${seq}`,
        writer: "orchestrator",
        writerKey: `writer-${seq}`,
        role: "user",
        message: message(`message ${seq}`, seq + 1),
      });
    }
    const target = await openJournal();
    bind(target.journal, "target-conversation");
    const result = target.journal.importForkRows(
      source.journal.rowsForArchive(0, 2, 10),
      "operation-1",
      "owner-1",
    );
    expect(result).toEqual({ firstSeq: 0, lastSeq: 2 });
    expect(target.journal.head()).toMatchObject({ headSeq: 2, epoch: 1 });
    expect(target.journal.rowsForArchive(0, 2, 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          seq: 0,
          writer_key: "fork:operation-1:writer-0",
        }),
      ]),
    );
  });

  test("rewind is atomic, gapless after cache rebuild, and fences delayed suffix turns", async () => {
    const opened = await openJournal();
    const { journal, state } = opened;
    bind(journal, "conversation-1");
    for (let seq = 0; seq < 4; seq += 1) {
      journal.upsertTurn({
        turnId: `turn-${seq}`,
        sessionId: "session",
        ownerId: "owner-1",
        state: "running",
        now: seq + 1,
      });
      const appended = journal.appendMessage({
        turnId: `turn-${seq}`,
        writer: "orchestrator",
        writerKey: `writer-${seq}`,
        role: "user",
        message: message(`message ${seq}`, seq + 1),
      });
      journal.setTurnSpan(`turn-${seq}`, appended.seq);
    }

    const resultJson = JSON.stringify({
      complete: true,
      nextEpoch: 2,
      lastSeq: 1,
    });
    await journal.applyTruncate({
      operationId: "operation-1",
      throughSeq: 1,
      expectedEpoch: 1,
      expectedLastSeq: 3,
      removedSegmentFirstSeqs: [],
      purgeKeys: [],
      retiredWriterKeys: [],
      retiredTurnIds: ["turn-2", "turn-3"],
      retiredAt: 10,
      resultJson,
    });
    expect(journal.head()).toMatchObject({ epoch: 2, headSeq: 1 });
    expect(journal.conversationEditReceipt("operation-1", "rewind")).toEqual(
      JSON.parse(resultJson),
    );
    expect(() =>
      journal.appendMessage({
        turnId: "turn-2",
        writer: "orchestrator",
        writerKey: "different-delayed-writer",
        role: "user",
        message: message("late", 20),
      }),
    ).toThrow(StaleJournalWriterError);

    const rebuilt = new Journal(state, () => undefined);
    await rebuilt.bootstrap();
    expect(rebuilt.head()).toMatchObject({ epoch: 2, headSeq: 1 });
    const next = rebuilt.appendMessage({
      turnId: "turn-new",
      writer: "orchestrator",
      writerKey: "writer-new",
      role: "user",
      message: message("new branch", 21),
    });
    expect(next.seq).toBe(2);
    expect(rebuilt.rowsForArchive(0, 2, 10).map((row) => row.seq)).toEqual([
      0, 1, 2,
    ]);
  });

  test("even a head-preserving rewind advances the epoch and records a stable receipt", async () => {
    const { journal } = await openJournal();
    bind(journal, "conversation-1");
    journal.appendMessage({
      turnId: "turn-1",
      writer: "orchestrator",
      writerKey: "writer-1",
      role: "user",
      message: message("keep", 1),
    });
    const resultJson = JSON.stringify({
      complete: true,
      nextEpoch: 2,
      lastSeq: 0,
    });
    await journal.applyTruncate({
      operationId: "operation-noop",
      throughSeq: 0,
      expectedEpoch: 1,
      expectedLastSeq: 0,
      removedSegmentFirstSeqs: [],
      purgeKeys: [],
      retiredWriterKeys: [],
      retiredTurnIds: [],
      retiredAt: 2,
      resultJson,
    });
    expect(journal.head()).toMatchObject({ epoch: 2, headSeq: 0 });
    expect(journal.conversationEditReceipt("operation-noop", "rewind")).toEqual(
      JSON.parse(resultJson),
    );
  });

  test("an old-epoch index send cannot mark a rewound cache head synced", async () => {
    const { journal } = await openJournal();
    bind(journal, "conversation-1");
    journal.appendMessage({
      turnId: "turn-old",
      writer: "orchestrator",
      writerKey: "writer-old",
      role: "user",
      message: message("old", 1),
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const index = new ConversationIndex(
      journal,
      () => undefined,
      () => ({ ownerId: "owner-1", ownerGeneration: "generation-1" }),
      {
        enqueue: async () => {
          sendStarted();
          await gate;
        },
        purged: () => false,
      },
    );
    const flushing = index.flush({ activity: "idle", updatedAt: 1 });
    await started;

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

    journal.appendMessage({
      turnId: "turn-new",
      writer: "orchestrator",
      writerKey: "writer-new",
      role: "user",
      message: message("new", 3),
    });
    expect(index.lagging()).toBe(true);
  });

  test("a refused outbox send never advances projection cursors", async () => {
    const { journal } = await openJournal();
    bind(journal, "conversation-invalid-verdict");
    journal.appendMessage({
      turnId: "turn-invalid-verdict",
      writer: "orchestrator",
      writerKey: "writer-invalid-verdict",
      role: "user",
      message: message("keep this pending", 1),
    });
    journal.putExcerpt({
      turn_id: "turn-invalid-verdict",
      seq_start: 0,
      seq_end: 0,
      text: "keep this pending",
      created_at: 1,
    });

    let calls = 0;
    const index = new ConversationIndex(
      journal,
      () => undefined,
      () => ({ ownerId: "owner-1", ownerGeneration: "generation-1" }),
      {
        enqueue: async () => {
          calls += 1;
          throw new Error("queue unavailable");
        },
        purged: () => false,
      },
    );

    const result = await index.flush({ activity: "idle", updatedAt: 1 });

    // One attempt per flush: the queue is durable once it accepts, so the
    // retry ladder is the next turn end or connect, not a tight loop here.
    expect(calls).toBe(1);
    expect(result).toEqual({ accepted: false, pendingExcerpts: 1 });
    expect(journal.meta().index_synced_seq).toBe(-1);
    expect(journal.unsyncedExcerptCount()).toBe(1);
  });
});
