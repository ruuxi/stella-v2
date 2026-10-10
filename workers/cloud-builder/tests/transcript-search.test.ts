import { afterEach, describe, expect, test } from "bun:test";
import { Journal } from "../src/journal.js";
import {
  TranscriptSearchIndex,
  transcriptSearchDdl,
  type TranscriptSearchRow,
} from "../src/transcript-search.js";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const message = (role: "user" | "assistant", text: string) => ({
  role,
  content: [{ type: "text" as const, text }],
  timestamp: 1,
});

const searchRow = (
  seq: number,
  role: string,
  text: string,
  overrides: Partial<TranscriptSearchRow> = {},
): TranscriptSearchRow => ({
  seq,
  turnId: `turn-${seq}`,
  role,
  createdAt: seq * 1_000,
  hidden: false,
  spillKey: null,
  payload: message(role === "assistant" ? "assistant" : "user", text),
  ...overrides,
});

const openIndex = (table = "test_fts") => {
  const fake = openSqlStorageFake();
  cleanups.push(fake.close);
  fake.sql.exec(transcriptSearchDdl(table));
  return { sql: fake.sql, index: new TranscriptSearchIndex(fake.sql, table) };
};

const matches = (sql: SqlStorage, query: string, table = "test_fts") =>
  sql
    .exec<{ seq: number }>(
      `SELECT rowid AS seq FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`,
      query,
    )
    .toArray()
    .map((row) => row.seq);

const openJournal = async () => {
  const fake = openSqlStorageFake();
  cleanups.push(fake.close);
  const kv = new Map<string, unknown>();
  const storage = {
    sql: fake.sql,
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") kv.set(key, value);
      else {
        for (const [entryKey, entryValue] of Object.entries(key)) {
          kv.set(entryKey, entryValue);
        }
      }
    },
    transactionSync: <T>(operation: () => T): T => operation(),
  };
  const journal = new Journal(
    { storage } as unknown as DurableObjectState,
    () => undefined,
  );
  await journal.bootstrap();
  return { journal, sql: fake.sql };
};

describe("TranscriptSearchIndex", () => {
  test("indexes only visible, resident user and assistant text", () => {
    const { sql, index } = openIndex();
    index.index(searchRow(1, "user", "visible user"));
    index.index(searchRow(2, "assistant", "visible assistant"));
    index.index(searchRow(3, "toolResult", "tool output"));
    index.index(searchRow(4, "user", "hidden text", { hidden: true }));
    index.index(
      searchRow(5, "assistant", "spill preview", { spillKey: "spill/5" }),
    );
    index.index(searchRow(6, "assistant", "   "));
    index.index(searchRow(7, "assistant", "replaced visible text"));
    index.index(
      searchRow(7, "assistant", "replaced hidden text", { hidden: true }),
    );

    expect(index.count()).toBe(2);
    expect(matches(sql, "visible")).toEqual([1, 2]);
    expect(matches(sql, '"tool output" OR hidden OR spill')).toEqual([]);
  });

  test("removes exact rows", () => {
    const { sql, index } = openIndex();
    for (let seq = 1; seq <= 2; seq += 1) {
      index.index(searchRow(seq, "user", `removable ${seq}`));
    }

    index.remove(2);
    expect(matches(sql, "removable")).toEqual([1]);
    index.remove(1);
    expect(index.count()).toBe(0);
  });

  test("caps indexed message text at 64 KiB", () => {
    const { sql, index } = openIndex();
    index.index(
      searchRow(
        1,
        "assistant",
        `startneedle ${"padding ".repeat(10_000)} endneedle`,
      ),
    );

    expect(matches(sql, "startneedle")).toHaveLength(1);
    expect(matches(sql, "endneedle")).toEqual([]);
  });
});

describe("journal transcript search integration", () => {
  test("survives commitSegment deleting the resident journal row", async () => {
    const { journal, sql } = await openJournal();
    journal.appendMessage({
      turnId: "turn-1",
      writer: "orchestrator",
      writerKey: "message-1",
      role: "user",
      message: message("user", "rollover keeps searchable history"),
      createdAt: 1,
    });
    expect(matches(sql, '"searchable history"', "journal_fts")).toHaveLength(
      1,
    );

    journal.insertSegment({
      first_seq: 0,
      last_seq: 0,
      rows: 1,
      bytes: 64,
      r2_key: "conversation/segment-0",
      state: "uploading",
      created_at: 2,
    });
    journal.commitSegment(0, 0);

    expect(journal.hotStats().rows).toBe(0);
    expect(matches(sql, '"searchable history"', "journal_fts")).toEqual([0]);
  });

  test("schema version 8 backfills resident rows and removes the excerpt table", async () => {
    const { journal, sql } = await openJournal();
    journal.appendMessage({
      turnId: "turn-old",
      writer: "orchestrator",
      writerKey: "message-old",
      role: "assistant",
      message: message("assistant", "resident migration backfill"),
      createdAt: 1,
    });
    journal.appendMessage({
      turnId: "turn-hidden",
      writer: "orchestrator",
      writerKey: "message-hidden",
      role: "user",
      message: message("user", "hiddenonly row"),
      hidden: true,
      createdAt: 2,
    });
    journal.appendMessage({
      turnId: "turn-spilled",
      writer: "orchestrator",
      writerKey: "message-spilled",
      role: "assistant",
      message: message("assistant", "spilledonly row"),
      spillKey: "spill/old",
      createdAt: 3,
    });
    sql.exec(`DROP TABLE journal_fts`);
    sql.exec(
      `CREATE TABLE turn_excerpts (
         turn_id TEXT PRIMARY KEY,
         seq_start INTEGER NOT NULL,
         seq_end INTEGER NOT NULL,
         text TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         synced INTEGER NOT NULL DEFAULT 0
       )`,
    );
    sql.exec(
      `CREATE INDEX turn_excerpts_unsynced ON turn_excerpts(synced, seq_start)`,
    );
    sql.exec(`UPDATE meta SET schema_version = 7 WHERE id = 0`);

    await journal.bootstrap();

    expect(journal.meta().schema_version).toBe(8);
    expect(matches(sql, '"migration backfill"', "journal_fts")).toEqual([0]);
    expect(matches(sql, "hiddenonly OR spilledonly", "journal_fts")).toEqual([]);
    expect(
      sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM sqlite_master
            WHERE type = 'table' AND name = 'turn_excerpts'`,
        )
        .one().count,
    ).toBe(0);
  });
});
