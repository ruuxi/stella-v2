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
    const { index } = openIndex();
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
    expect(
      index
        .search(["visible"], 30)
        .map((hit) => hit.seq)
        .sort(),
    ).toEqual([1, 2]);
    expect(index.search(["tool output", "hidden", "spill"], 30)).toEqual([]);
  });

  test("prefers phrases, falls back to words, ranks with bm25, and returns snippets", () => {
    const { index } = openIndex();
    index.index(
      searchRow(1, "assistant", "red blue cobalt cobalt cobalt cobalt"),
    );
    index.index(searchRow(2, "assistant", "red gap blue cobalt"));

    const phrase = index.search(["red blue"], 10);
    expect(phrase.map((hit) => hit.seq)).toEqual([1]);

    const fallback = index.search(["red absentword"], 10);
    expect(fallback.map((hit) => hit.seq).sort()).toEqual([1, 2]);

    const ranked = index.search(["cobalt"], 10);
    expect(ranked[0]?.seq).toBe(1);
    expect(ranked[0]?.rank).toBeLessThanOrEqual(ranked[1]!.rank);
    expect(ranked[0]?.snippet).toContain("cobalt");
    expect(() => index.search(['cobalt" OR *'], 10)).not.toThrow();
  });

  test("removes exact rows and suffixes", () => {
    const { index } = openIndex();
    for (let seq = 1; seq <= 3; seq += 1) {
      index.index(searchRow(seq, "user", `removable ${seq}`));
    }

    index.removeAbove(1);
    expect(index.search(["removable"], 10).map((hit) => hit.seq)).toEqual([1]);
    index.remove(1);
    expect(index.count()).toBe(0);
  });

  test("caps result sets at thirty hits", () => {
    const { index } = openIndex();
    for (let seq = 1; seq <= 35; seq += 1) {
      index.index(searchRow(seq, "assistant", `common result ${seq}`));
    }

    expect(index.search(["common"], 1_000)).toHaveLength(30);
  });

  test("caps indexed message text at 64 KiB", () => {
    const { index } = openIndex();
    index.index(
      searchRow(
        1,
        "assistant",
        `startneedle ${"padding ".repeat(10_000)} endneedle`,
      ),
    );

    expect(index.search(["startneedle"], 10)).toHaveLength(1);
    expect(index.search(["endneedle"], 10)).toEqual([]);
  });
});

describe("journal transcript search integration", () => {
  test("survives commitSegment deleting the resident journal row", async () => {
    const { journal } = await openJournal();
    journal.appendMessage({
      turnId: "turn-1",
      writer: "orchestrator",
      writerKey: "message-1",
      role: "user",
      message: message("user", "rollover keeps searchable history"),
      createdAt: 1,
    });
    expect(journal.searchTranscript(["searchable history"], 10)).toHaveLength(
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
    expect(
      journal
        .searchTranscript(["searchable history"], 10)
        .map((hit) => hit.seq),
    ).toEqual([0]);
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
    expect(
      journal
        .searchTranscript(["migration backfill"], 10)
        .map((hit) => hit.seq),
    ).toEqual([0]);
    expect(journal.searchTranscript(["hiddenonly", "spilledonly"], 10)).toEqual(
      [],
    );
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
