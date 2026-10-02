import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SCHEMA_VERSION,
  SEARCH_TEXT_INDEX_NAME,
  SEARCH_TEXT_INDEX_SQL,
  migrateDesktopDatabase,
} from "@stella/runtime/kernel/storage/schema";
import { listTranscriptNeighborsBatch } from "@stella/runtime/kernel/storage/recall-read-queries";
import { SearchIndex } from "@stella/runtime/kernel/storage/search";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

const INDEX = SEARCH_TEXT_INDEX_NAME;
const databases: DatabaseSync[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  vi.restoreAllMocks();
});

const openMigrated = (): SqliteDatabase => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const typed = db as unknown as SqliteDatabase;
  migrateDesktopDatabase(typed);
  return typed;
};

/** Records every SQL string the code under test prepares. */
const spyPrepared = (db: SqliteDatabase) => {
  const sql: string[] = [];
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (text: string) => {
          sql.push(text);
          return target.prepare(text);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { proxy, sql };
};

/** EXPLAIN QUERY PLAN with placeholder values (the plan does not depend on them). */
const planOf = (db: SqliteDatabase, sql: string) =>
  (
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from(sql.matchAll(/\?/g), () => 1)) as Array<{
      detail: string;
    }>
  )
    .map((row) => row.detail)
    .join("\n");

type Row = {
  conversationId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  visible: 0 | 1;
  text: string | null;
  createdAt: number;
};

const seed = (db: SqliteDatabase, rows: Row[]) => {
  const conversations = new Set(rows.map((row) => row.conversationId));
  const insertConversation = db.prepare(
    "INSERT INTO conversation (id, created_at, updated_at) VALUES (?, 0, 0)",
  );
  for (const id of conversations) insertConversation.run(id);
  const insertEntry = db.prepare(
    `INSERT INTO entry (conversation_id, seq, id, type, role, visible, payload, search_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insertEntry.run(
      row.conversationId,
      row.seq,
      `${row.conversationId}:${row.seq}`,
      row.role === "system" ? "run_event" : `${row.role}_message`,
      row.role,
      row.visible,
      JSON.stringify({ text: row.text ?? "", pad: "x".repeat(row.seq % 7 === 0 ? 20_000 : 64) }),
      row.text,
      row.createdAt,
      row.createdAt,
    );
  }
};

/** Deterministic prod-shaped rows: mostly text-less run events, some messages, some blank text. */
const randomRows = (count: number, uniqueTimes: boolean): Row[] => {
  let state = 7;
  const rnd = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const seqs = new Map<string, number>();
  const rows: Row[] = [];
  let clock = 1_000_000;
  for (let index = 0; index < count; index += 1) {
    const conversationId = `conv-${Math.floor(rnd() * 3)}`;
    const seq = (seqs.get(conversationId) ?? 0) + 1;
    seqs.set(conversationId, seq);
    clock += uniqueTimes ? 1 + Math.floor(rnd() * 90_000) : Math.floor(rnd() * 3) * 30_000;
    const kind = rnd();
    const message = kind < 0.3;
    rows.push({
      conversationId,
      seq,
      role: message ? (kind < 0.15 ? "user" : "assistant") : "system",
      visible: message && kind > 0.01 ? 1 : 0,
      text: message ? (kind < 0.02 ? "   " : `message ${conversationId} ${seq}`) : null,
      createdAt: clock,
    });
  }
  return rows;
};

/** The pre-v4 window-function query, kept verbatim as the reference. */
const referenceWindowNeighbors = (
  db: SqliteDatabase,
  targets: Array<{ conversationId: string; atMs: number }>,
  before: number,
  after: number,
  windowMs: number,
) => {
  const values = targets.map(() => "(?, ?, ?)").join(", ");
  const params = targets.flatMap((target, index) => [
    index,
    target.conversationId,
    target.atMs,
  ]);
  const rows = db
    .prepare(
      `WITH targets(target_index, conversation_id, target_ms) AS (
         VALUES ${values}
       ), ranked AS (
         SELECT
           targets.target_index AS targetIndex,
           entry.id, entry.seq AS sequence, entry.conversation_id AS conversationId,
           entry.role AS role, entry.created_at AS atMs,
           substr(entry.search_text, 1, 4000) AS text,
           CASE WHEN entry.created_at < targets.target_ms THEN 'before' ELSE 'after' END AS side,
           ROW_NUMBER() OVER (
             PARTITION BY targets.target_index,
               CASE WHEN entry.created_at < targets.target_ms THEN 'before' ELSE 'after' END
             ORDER BY ABS(entry.created_at - targets.target_ms) ASC
           ) AS distanceRank
         FROM targets
         JOIN entry ON entry.conversation_id = targets.conversation_id
         WHERE entry.search_text IS NOT NULL
           AND entry.created_at != targets.target_ms
           AND entry.created_at BETWEEN targets.target_ms - ? AND targets.target_ms + ?
       )
       SELECT targetIndex, id, sequence, conversationId, role, atMs, text
       FROM ranked
       WHERE (side = 'before' AND distanceRank <= ?)
          OR (side = 'after' AND distanceRank <= ?)
       ORDER BY targetIndex ASC, atMs ASC`,
    )
    .all(...params, windowMs, windowMs, before, after) as Array<
    Record<string, unknown> & { targetIndex: number; text: string }
  >;
  const grouped = targets.map(() => [] as Array<Record<string, unknown>>);
  for (const { targetIndex, ...row } of rows) {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) continue;
    grouped[targetIndex]!.push({
      conversationId: row.conversationId,
      id: row.id,
      sequence: row.sequence,
      role: row.role === "assistant" ? "assistant" : "user",
      atMs: row.atMs,
      text,
    });
  }
  return grouped;
};

const hasIndex = (db: SqliteDatabase) =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(INDEX),
  );

/** Runs `check` without the index, then again after building it. */
const inBothStates = (db: SqliteDatabase, check: (state: string) => void) => {
  expect(hasIndex(db)).toBe(false);
  check("without index");
  db.exec(SEARCH_TEXT_INDEX_SQL);
  expect(hasIndex(db)).toBe(true);
  check("with index");
};

describe("recall search-text index (built by idle maintenance)", () => {
  it("is not created by the schema: fresh and migrated databases are identical", () => {
    const fresh = openMigrated();
    expect(SCHEMA_VERSION).toBe(5);
    expect(hasIndex(fresh)).toBe(false);
    migrateDesktopDatabase(fresh);
    expect(hasIndex(fresh)).toBe(false);
    fresh.exec(SEARCH_TEXT_INDEX_SQL);
    expect(
      fresh
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(INDEX),
    ).toMatchObject({ sql: expect.stringContaining("WHERE search_text IS NOT NULL") });
    // Re-running the DDL is a no-op.
    fresh.exec(SEARCH_TEXT_INDEX_SQL);
  });

  it("no query forces the index", () => {
    const db = openMigrated();
    seed(db, randomRows(200, true));
    const { proxy, sql } = spyPrepared(db);
    listTranscriptNeighborsBatch(proxy, [{ conversationId: "conv-1", atMs: 5_000_000 }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    new SearchIndex(proxy).searchTranscripts({ query: "message conv", degradedMode: "like" });
    expect(sql.length).toBeGreaterThan(0);
    for (const text of sql) expect(text).not.toMatch(/INDEXED BY/i);
  });

  it("serves the time-window neighbours and the LIKE fallback from the covering index once built", () => {
    const db = openMigrated();
    seed(db, randomRows(600, true));
    const { proxy, sql } = spyPrepared(db);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    inBothStates(db, (state) => {
      listTranscriptNeighborsBatch(proxy, [{ conversationId: "conv-1", atMs: 5_000_000 }], {
        before: 2,
        after: 2,
      });
      const windowPlan = planOf(db, sql.at(-1)!);
      new SearchIndex(proxy).searchTranscripts({
        query: "message conv",
        degradedMode: "like",
      });
      const likeSql = sql.at(-1)!;
      expect(likeSql).toContain("search_text LIKE");
      const likePlan = planOf(db, likeSql);
      if (state === "with index") {
        expect(windowPlan).toContain(`USING COVERING INDEX ${INDEX}`);
        expect(windowPlan).not.toMatch(/SCAN entry(?! USING)/);
        expect(windowPlan).not.toContain("TEMP B-TREE");
        expect(likePlan).toContain(`SCAN entry USING COVERING INDEX ${INDEX}`);
      } else {
        expect(windowPlan).not.toContain(INDEX);
        expect(likePlan).not.toContain(INDEX);
      }
    });
  });

  it("leaves the visible-window and sequence-neighbour plans on idx_entry_conv_visible_seq", () => {
    const db = openMigrated();
    seed(db, randomRows(600, true));
    db.exec(SEARCH_TEXT_INDEX_SQL);
    const { proxy, sql } = spyPrepared(db);
    listTranscriptNeighborsBatch(proxy, [{ conversationId: "conv-1", atMs: 0, sequence: 50 }], {
      before: 2,
      after: 2,
    });
    expect(planOf(db, sql.at(-1)!)).toContain(
      "idx_entry_conv_visible_seq",
    );
    expect(
      planOf(
        db,
        `SELECT candidate.rowid FROM entry AS candidate
         WHERE candidate.conversation_id = ? AND candidate.visible = 1
           AND candidate.search_text IS NOT NULL AND trim(candidate.search_text) <> ''
         ORDER BY candidate.seq DESC LIMIT 1`,
      ),
    ).toContain("idx_entry_conv_visible_seq");
  });

  it("returns exactly what the pre-rewrite window query returned, with and without the index", () => {
    const db = openMigrated();
    const rows = randomRows(3_000, true);
    seed(db, rows);
    const targets = rows
      .filter((_, index) => index % 37 === 0)
      .flatMap((row) => [
        { conversationId: row.conversationId, atMs: row.createdAt },
        { conversationId: row.conversationId, atMs: row.createdAt + 17 },
      ])
      .slice(0, 30);
    const cases = [
      [2, 2, 2 * 60 * 60 * 1000],
      [0, 3, 60_000],
      [8, 10, 10 * 60_000],
      [1, 0, 24 * 60 * 60 * 1000],
    ] as const;
    const results: Record<string, unknown> = {};
    inBothStates(db, (state) => {
      results[state] = cases.map(([before, after, windowMs]) => {
        const actual = listTranscriptNeighborsBatch(db, targets, { before, after, windowMs });
        expect(actual).toEqual(
          referenceWindowNeighbors(db, targets, before, after, windowMs),
        );
        return actual;
      });
    });
    expect(results["with index"]).toEqual(results["without index"]);
    expect(JSON.stringify(results["with index"])).toContain("message");
  });

  it("returns the same LIKE-fallback hits with and without the index", () => {
    const db = openMigrated();
    seed(db, randomRows(1_500, true));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const results: Record<string, unknown> = {};
    inBothStates(db, (state) => {
      results[state] = ["message conv-1", "conv-2 7", "absent-token"].map((query) =>
        new SearchIndex(db).searchTranscripts({ query, degradedMode: "like", limit: 20 }),
      );
    });
    expect(results["with index"]).toEqual(results["without index"]);
    expect(JSON.stringify(results["with index"])).toContain("conv-1");
  });

  it("breaks equal-timestamp ties toward the target by sequence", () => {
    const db = openMigrated();
    seed(db, [
      { conversationId: "c", seq: 1, role: "user", visible: 1, text: "b1", createdAt: 100 },
      { conversationId: "c", seq: 2, role: "user", visible: 1, text: "b2", createdAt: 100 },
      { conversationId: "c", seq: 3, role: "user", visible: 1, text: "hit", createdAt: 200 },
      { conversationId: "c", seq: 4, role: "user", visible: 1, text: "a4", createdAt: 300 },
      { conversationId: "c", seq: 5, role: "user", visible: 1, text: "a5", createdAt: 300 },
    ]);
    inBothStates(db, () => {
      const [group] = listTranscriptNeighborsBatch(db, [{ conversationId: "c", atMs: 200 }], {
        before: 1,
        after: 1,
        windowMs: 60_000,
      });
      expect(group!.map((hit) => hit.text)).toEqual(["b2", "a4"]);
    });
  });
});
