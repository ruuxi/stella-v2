import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Journal } from "../src/journal.js";

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
      else
        for (const [entryKey, entryValue] of Object.entries(key)) {
          kv.set(entryKey, entryValue);
        }
    },
    transactionSync: <T>(operation: () => T): T =>
      database.transaction(operation)(),
  };
  const journal = new Journal(
    { storage } as unknown as DurableObjectState,
    () => undefined,
  );
  await journal.bootstrap();
  return journal;
};

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("journal append receipt", () => {
  test("commits rows and receipt atomically and keeps the receipt after rollover", async () => {
    const journal = await openJournal();
    const appended = journal.transactionSync(() => {
      const row = journal.appendMessage({
        turnId: "voice:device:event",
        writer: "voice:device",
        writerKey: "voice:device:event:0",
        role: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      });
      journal.putAppendReceipt({
        writerKey: "voice:device:event",
        fingerprint: "fingerprint",
        firstSeq: row.seq,
        lastSeq: row.seq,
        epoch: journal.meta().epoch,
        createdAt: 1,
      });
      return row;
    });

    journal.insertSegment({
      first_seq: appended.seq,
      last_seq: appended.seq,
      rows: 1,
      bytes: 1,
      r2_key: "segment",
      state: "uploading",
      created_at: 1,
    });
    journal.commitSegment(appended.seq, appended.seq);

    expect(journal.hotStats().rows).toBe(0);
    expect(journal.appendReceipt("voice:device:event")).toMatchObject({
      fingerprint: "fingerprint",
      first_seq: appended.seq,
      last_seq: appended.seq,
    });
  });

  test("rolls back the receipt when any row in the append batch fails", async () => {
    const journal = await openJournal();

    expect(() =>
      journal.transactionSync(() => {
        const row = journal.appendMessage({
          turnId: "voice:device:event",
          writer: "voice:device",
          writerKey: "voice:device:event:0",
          role: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1,
          },
        });
        journal.putAppendReceipt({
          writerKey: "voice:device:event",
          fingerprint: "fingerprint",
          firstSeq: row.seq,
          lastSeq: row.seq,
          epoch: journal.meta().epoch,
          createdAt: 1,
        });
        throw new Error("fail batch");
      }),
    ).toThrow("fail batch");

    expect(journal.hotStats().rows).toBe(0);
    expect(journal.appendReceipt("voice:device:event")).toBeNull();
  });
});
