import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import {
  FtsSearchUnavailableError,
  SessionStore,
} from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { rebuildSearchIndexes } from "@stella/runtime/kernel/storage/schema";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-transcript-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = { rootPath, db, store: new SessionStore(db) };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

let eventCounter = 0;

const appendChat = (
  store: SessionStore,
  conversationId: string,
  type: "user_message" | "assistant_message",
  text: string,
  timestamp: number,
): void => {
  eventCounter += 1;
  store.appendEvent({
    conversationId,
    eventId: `evt-${eventCounter}`,
    type,
    timestamp,
    payload: { text },
  });
};

describe("searchTranscripts", () => {
  it("finds user and assistant text across ALL conversations, not just one", () => {
    const { store } = createTestContext();
    appendChat(
      store,
      "conv-june",
      "user_message",
      "where should I go nearby so I can drive sick",
      1_000,
    );
    appendChat(
      store,
      "conv-june",
      "assistant_message",
      "closest good one is Bush Highway, head toward Saguaro Lake",
      2_000,
    );
    appendChat(
      store,
      "conv-july",
      "user_message",
      "I totally forgot where we went when I was driving the first time",
      3_000,
    );

    const hits = store.searchTranscripts({ query: "saguaro lake drive" });
    const texts = hits.map((hit) => hit.text);
    expect(texts).toContain(
      "closest good one is Bush Highway, head toward Saguaro Lake",
    );
    expect(texts).toContain("where should I go nearby so I can drive sick");

    const assistantHit = hits.find((hit) => hit.role === "assistant");
    expect(assistantHit?.conversationId).toBe("conv-june");
    expect(assistantHit?.atMs).toBe(2_000);
  });

  it("ranks multi-token matches above single-token matches, ties newest-first", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "the emira is parked", 1_000);
    appendChat(
      store,
      "conv-1",
      "user_message",
      "took the emira out to saguaro lake",
      2_000,
    );
    appendChat(store, "conv-1", "user_message", "emira wash day", 3_000);

    const hits = store.searchTranscripts({ query: "emira saguaro" });
    expect(hits.map((hit) => hit.text)).toEqual([
      "took the emira out to saguaro lake",
      "emira wash day",
      "the emira is parked",
    ]);
  });

  it("ignores tool/system rows and non-text payload fields", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "hello there", 1_000);

    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-tool",
      type: "tool_result",
      timestamp: 2_000,
      payload: { text: "zanzibar in a tool result" },
    });

    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-meta",
      type: "user_message",
      timestamp: 3_000,
      payload: { text: "unrelated", platform: "zanzibar" },
    });

    expect(store.searchTranscripts({ query: "zanzibar" })).toEqual([]);
  });

  it("keeps an older rare multi-term match when a common term has hundreds of hits", () => {
    const { store } = createTestContext();
    store.withTransaction(() => {
      appendChat(store, "older", "assistant_message", "emira saguaro route", 1);
      for (let i = 0; i < 600; i += 1) {
        appendChat(
          store,
          "newer",
          "user_message",
          `emira parking note ${i}`,
          1000 + i,
        );
      }
    });

    const hits = store.searchTranscripts({ query: "emira saguaro", limit: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({
      conversationId: "older",
      role: "assistant",
      atMs: 1,
      text: "emira saguaro route",
    });
  });

  it("bounds content scoring even when almost the entire archive matches", () => {
    const { store, db } = createTestContext();
    store.withTransaction(() => {
      for (let i = 0; i < 600; i += 1) {
        appendChat(
          store,
          "conv-1",
          "user_message",
          `emira saguaro note ${i}`,
          i,
        );
      }
    });

    // Count actual SQLite LIKE evaluations, including rows discarded by LIMIT.
    // These fixture terms contain no wildcard/escape characters, so substring
    // matching preserves the query's literal LIKE behavior for this test.
    let contentEvaluations = 0;
    (db as unknown as DatabaseSync).function(
      "like",
      (pattern, value, _escape) => {
        contentEvaluations += 1;
        return String(value).includes(String(pattern).slice(1, -1)) ? 1 : 0;
      },
    );
    const hits = store.searchTranscripts({ query: "emira saguaro", limit: 1 });
    expect(hits).toHaveLength(1);
    // BM25 ordering needs no literal-content rescoring.
    expect(contentEvaluations).toBe(0);
  });

  it("treats LIKE wildcards as literals and returns nothing for empty queries", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "reached 100% coverage", 1_000);
    appendChat(
      store,
      "conv-1",
      "user_message",
      "processed 1000 records",
      2_000,
    );

    expect(
      store.searchTranscripts({ query: "100%" }).map((hit) => hit.text),
    ).toEqual(["reached 100% coverage"]);
    expect(store.searchTranscripts({ query: "   " })).toEqual([]);
  });

  it("lists a hit's neighboring chat messages in chronological order", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "so where should I go", 1_000);
    appendChat(store, "conv-1", "assistant_message", "try Bush Highway", 2_000);
    appendChat(store, "conv-1", "user_message", "give me the address", 3_000);
    appendChat(store, "conv-1", "user_message", "damn i love the car", 4_000);

    appendChat(store, "conv-2", "user_message", "unrelated chatter", 2_500);

    const neighbors = store.listTranscriptNeighbors({
      conversationId: "conv-1",
      atMs: 2_000,
      before: 2,
      after: 2,
    });
    expect(neighbors.map((hit) => hit.text)).toEqual([
      "so where should I go",
      "give me the address",
      "damn i love the car",
    ]);
    expect(neighbors.every((hit) => hit.conversationId === "conv-1")).toBe(
      true,
    );
  });

  it("respects the limit", () => {
    const { store } = createTestContext();
    for (let i = 0; i < 5; i += 1) {
      appendChat(store, "conv-1", "user_message", `emira note ${i}`, 1_000 + i);
    }
    expect(store.searchTranscripts({ query: "emira", limit: 2 })).toHaveLength(
      2,
    );
  });
});

describe("transcript FTS index", () => {
  const ftsRowCount = (db: SqliteDatabase): number =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM entry WHERE search_text IS NOT NULL",
        )
        .get() as {
        count: number;
      }
    ).count;

  it("indexes eligible chat rows via triggers and matches stemmed word forms", () => {
    const { store, db } = createTestContext();
    appendChat(
      store,
      "conv-1",
      "user_message",
      "took the car for a drive",
      1_000,
    );

    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-tool",
      type: "tool_result",
      timestamp: 2_000,
      payload: { text: "drive in a tool result" },
    });

    expect(ftsRowCount(db)).toBe(1);

    const hits = store.searchTranscripts({ query: "drives" });
    expect(hits.map((hit) => hit.text)).toEqual(["took the car for a drive"]);
  });

  it("stays in sync when an event's text is rewritten", () => {
    const { store, db } = createTestContext();
    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-rewrite",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "meet me at saguaro lake" },
    });

    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-rewrite",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "meet me at canyon lake instead" },
    });

    expect(store.searchTranscripts({ query: "saguaro" })).toEqual([]);
    expect(
      store.searchTranscripts({ query: "canyon" }).map((hit) => hit.text),
    ).toEqual(["meet me at canyon lake instead"]);
    expect(ftsRowCount(db)).toBe(1);
  });

  it("drops a deleted conversation's rows via the cascade", () => {
    const { store, db } = createTestContext();
    appendChat(
      store,
      "conv-1",
      "user_message",
      "the secret is zanzibar",
      1_000,
    );
    expect(store.searchTranscripts({ query: "zanzibar" })).toHaveLength(1);

    db.prepare("DELETE FROM conversation WHERE id = ?").run("conv-1");

    expect(store.searchTranscripts({ query: "zanzibar" })).toEqual([]);
    expect(ftsRowCount(db)).toBe(0);
  });

  it("backfills pre-existing history when the index is rebuilt (upgrade path)", () => {
    const { store, db } = createTestContext();
    appendChat(
      store,
      "conv-1",
      "user_message",
      "remember the emira torque spec",
      1_000,
    );

    db.exec("INSERT INTO entry_fts(entry_fts, rank) VALUES ('delete-all', 0);");
    expect(store.searchTranscripts({ query: "torque" })).toEqual([]);

    rebuildSearchIndexes(db);

    expect(ftsRowCount(db)).toBe(1);
    expect(
      store.searchTranscripts({ query: "torque" }).map((hit) => hit.text),
    ).toEqual(["remember the emira torque spec"]);
  });

  it("fails loudly when the index is unavailable unless degraded mode is explicit", () => {
    const { store, db } = createTestContext();
    appendChat(
      store,
      "conv-1",
      "user_message",
      "the secret is zanzibar",
      1_000,
    );
    db.exec("DROP TRIGGER trg_entry_fts_insert;");
    db.exec("DROP TRIGGER trg_entry_fts_update;");
    db.exec("DROP TRIGGER trg_entry_fts_delete;");
    db.exec("DROP TABLE entry_fts;");

    const fallbackStore = new SessionStore(db);

    expect(() =>
      fallbackStore.searchTranscripts({ query: "zanzibar" }),
    ).toThrow(FtsSearchUnavailableError);
    expect(
      fallbackStore
        .searchTranscripts({ query: "zanzibar", degradedMode: "like" })
        .map((h) => h.text),
    ).toEqual(["the secret is zanzibar"]);
  });

  it("survives queries FTS cannot tokenize by falling back to the scan", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "coverage hit 100%", 1_000);

    expect(store.searchTranscripts({ query: "%%%" })).toEqual([]);
  });
});

it("retrieves deep matches and round-trips scoped message references", async () => {
  const { store } = createTestContext();
  const { recallReference } = await import("@stella/contracts/recall");
  const { formatTranscriptSearchResults } = await import(
    "@stella/runtime/kernel/agent-runtime/context-lookup"
  );
  appendChat(
    store,
    "conv-deep",
    "assistant_message",
    "x".repeat(10000) + " NEEDLE " + "y".repeat(5000),
    1000,
  );
  appendChat(
    store,
    "conv-deep",
    "user_message",
    "Correction: keep the existing behavior.",
    1000,
  );
  const hits = store.searchTranscripts({ query: "NEEDLE" });
  expect(hits[0]?.id).toBeTruthy();
  const ref = recallReference("conv-deep", hits[0]!.id!);
  expect(store.searchTranscripts({ query: ref })[0]).toMatchObject({
    id: hits[0]!.id,
    text: hits[0]!.text,
  });
  expect(
    store.searchTranscripts({
      query: recallReference("wrong-conversation", hits[0]!.id!),
    }),
  ).toEqual([]);
  const output = formatTranscriptSearchResults(store, "conv-deep", "NEEDLE");
  expect(output).toContain("NEEDLE");
  expect(output).toContain("Correction: keep the existing behavior.");
  expect(output).toContain("messageRef=" + ref);
  const next = output.match(/next: (recall:\S+)/)?.[1];
  expect(next).toBeTruthy();
  const continuation = formatTranscriptSearchResults(store, "conv-deep", next);
  expect(continuation).toContain("y".repeat(100));
  expect(continuation).not.toContain("NEEDLE");
});
