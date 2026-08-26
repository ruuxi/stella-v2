import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendBatch,
  ensureSchema,
  FencingConflict,
  lastSeq,
  listSegments,
  readHot,
  type Sql,
} from "../src/journal-core";

// Back journal-core with real SQLite (bun:sqlite) so these unit tests exercise
// the same SQL the Durable Object runs in production against DO SQLite.
function makeSql(): Sql {
  const db = new Database(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...(bindings as never[])) as Record<string, unknown>[];
      return { toArray: () => rows as never[], one: () => rows[0] as never };
    },
  };
}

describe("journal-core canonical invariants", () => {
  test("gapless seq allocation and ordering", () => {
    const sql = makeSql();
    ensureSchema(sql, 1);
    const r = appendBatch(sql, "w1", [
      { type: "a", payload: {} },
      { type: "b", payload: {} },
    ], 1);
    expect([r.firstSeq, r.lastSeq]).toEqual([1, 2]);
    const r2 = appendBatch(sql, "w2", [{ type: "c", payload: {} }], 2);
    expect(r2.firstSeq).toBe(3);
    expect(readHot(sql).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(lastSeq(sql)).toBe(3);
  });

  test("idempotent replay of a writer_key does not duplicate", () => {
    const sql = makeSql();
    ensureSchema(sql, 1);
    appendBatch(sql, "w1", [{ type: "a", payload: {} }], 1);
    const replay = appendBatch(sql, "w1", [{ type: "a", payload: {} }], 1);
    expect(replay.replayed).toBe(true);
    expect(readHot(sql).length).toBe(1);
  });

  test("fencing rejects a stale writer and preserves rows", () => {
    const sql = makeSql();
    ensureSchema(sql, 1);
    appendBatch(sql, "w1", [{ type: "a", payload: {} }], 1); // seq 1
    appendBatch(sql, "w2", [{ type: "b", payload: {} }], 1); // seq 2
    expect(() => appendBatch(sql, "w3", [{ type: "c", payload: {} }], 1, 1)).toThrow(FencingConflict);
    expect(readHot(sql).length).toBe(2);
    // Correct fence advances.
    const ok = appendBatch(sql, "w3", [{ type: "c", payload: {} }], 1, 2);
    expect(ok.firstSeq).toBe(3);
  });

  test("empty batch records a stable receipt", () => {
    const sql = makeSql();
    ensureSchema(sql, 1);
    appendBatch(sql, "w1", [{ type: "a", payload: {} }], 1);
    const empty = appendBatch(sql, "wEmpty", [], 1);
    expect(empty.count).toBe(0);
    expect(empty.lastSeq).toBe(1);
    expect(listSegments(sql)).toEqual([]);
  });
});
