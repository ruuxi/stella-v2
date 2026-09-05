import { beforeEach, describe, expect, test } from "bun:test";

const rebuildKey = "stella-mobile-chat-index-rebuild-required-v1";
const memoryStore = new Map<string, string>();
let failSet = false;
let failRemove = false;

(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return memoryStore.size;
    },
    key: (index: number) => [...memoryStore.keys()][index] ?? null,
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failSet && key === rebuildKey) throw new Error("intent write failed");
      memoryStore.set(key, value);
    },
    removeItem: (key: string) => {
      if (failRemove && key === rebuildKey) {
        throw new Error("marker removal failed");
      }
      memoryStore.delete(key);
    },
    clear: () => memoryStore.clear(),
  },
};

import {
  __getMessageIndexStateForTests,
  __setMessageIndexDatabaseForTests,
  beginMessageIndexRebuild,
  clearMessageIndex,
  ensureMessageIndexRebuildIntent,
  initMessageIndex,
  indexMessages,
  rebuildMessageIndex,
} from "../chat-message-index";
import {
  CHAT_ACCOUNT_CLEANUP_REQUIRED_KEY,
  beginAccountChatCleanupIntent,
  loadAccountChatCleanupIntent,
  markAccountCanonicalChatCleared,
} from "../chat-account-cleanup-state";
import {
  loadRecentChatMessages,
  saveChatMessages,
} from "../offline-chat-storage";

class MessageIndexDatabase {
  backfillDone = false;
  deleteCalls = 0;
  failDelete = false;
  failBackfillMarker = false;
  pauseDelete: Promise<void> | null = null;
  pauseBackfillMarker: Promise<void> | null = null;
  signalBackfillMarker: (() => void) | null = null;
  deletedMessageIds: string[] = [];

  async execAsync(sql: string): Promise<void> {
    if (!sql.includes("DELETE FROM messages")) return;
    this.deleteCalls += 1;
    if (this.pauseDelete) await this.pauseDelete;
    if (this.failDelete) throw new Error("index delete failed");
    this.backfillDone = false;
  }

  async runAsync(
    sql: string,
    ...params: unknown[]
  ): Promise<{
    changes: number;
    lastInsertRowId: number;
  }> {
    if (sql === "DELETE FROM messages WHERE id = ?") {
      this.deletedMessageIds.push(String(params[0]));
    }
    if (sql.includes("INSERT INTO index_meta")) {
      this.signalBackfillMarker?.();
      if (this.pauseBackfillMarker) await this.pauseBackfillMarker;
      if (this.failBackfillMarker) throw new Error("backfill marker failed");
      this.backfillDone = true;
    }
    return { changes: 1, lastInsertRowId: 1 };
  }

  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (sql.includes("FROM index_meta") && this.backfillDone) {
      return { value: "done" } as T;
    }
    return null;
  }

  async getAllAsync<T>(): Promise<T[]> {
    return [];
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    await task();
  }
}

let database: MessageIndexDatabase;

beforeEach(async () => {
  memoryStore.clear();
  failSet = false;
  failRemove = false;
  database = new MessageIndexDatabase();
  await __setMessageIndexDatabaseForTests(database);
});

describe("message-index rebuild ownership", () => {
  test("removes a canonical twin when a stable local row replaces it", async () => {
    await indexMessages([
      {
        id: "local-user",
        canonicalId: "desktop-user",
        role: "user",
        text: "hello",
      },
    ]);

    expect(database.deletedMessageIds).toEqual(["desktop-user"]);
  });

  test("does not permit canonical mutation when durable intent fails", async () => {
    failSet = true;
    await expect(beginMessageIndexRebuild()).rejects.toThrow(
      "intent write failed",
    );
    expect(__getMessageIndexStateForTests()).toEqual({
      blocked: false,
      phase: "idle",
      rebuilding: false,
    });
    expect(database.deleteCalls).toBe(0);
    expect(memoryStore.has(rebuildKey)).toBe(false);
  });

  test("rejects an overlapping cleanup or rewind owner", async () => {
    await beginMessageIndexRebuild();
    await expect(beginMessageIndexRebuild()).rejects.toThrow("already active");
    expect(__getMessageIndexStateForTests().phase).toBe("intent");

    await rebuildMessageIndex();
    expect(__getMessageIndexStateForTests()).toEqual({
      blocked: false,
      phase: "idle",
      rebuilding: false,
    });
    expect(memoryStore.has(rebuildKey)).toBe(false);
  });

  test("coalesces concurrent rebuild callers onto one recovery", async () => {
    await beginMessageIndexRebuild();
    const first = rebuildMessageIndex();
    const second = rebuildMessageIndex();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(database.deleteCalls).toBe(2);
    expect(__getMessageIndexStateForTests().blocked).toBe(false);
  });

  test("recovers a durable rebuild marker during cold initialization", async () => {
    memoryStore.set(rebuildKey, "1");
    await initMessageIndex();
    expect(database.deleteCalls).toBe(1);
    expect(memoryStore.has(rebuildKey)).toBe(false);
    expect(__getMessageIndexStateForTests()).toEqual({
      blocked: false,
      phase: "idle",
      rebuilding: false,
    });
  });

  test("does not let stale initialization clear a newer rebuild intent", async () => {
    memoryStore.set(rebuildKey, "1");
    let releaseBackfillMarker!: () => void;
    const backfillMarkerStarted = new Promise<void>((resolve) => {
      database.signalBackfillMarker = resolve;
    });
    database.pauseBackfillMarker = new Promise<void>((resolve) => {
      releaseBackfillMarker = resolve;
    });

    const initialization = initMessageIndex();
    await backfillMarkerStarted;
    const newerIntent = ensureMessageIndexRebuildIntent();
    while (memoryStore.get(rebuildKey) === "1") await Promise.resolve();
    const newerToken = memoryStore.get(rebuildKey);
    releaseBackfillMarker();
    await Promise.all([initialization, newerIntent]);

    expect(newerToken === undefined).toBe(false);
    expect(memoryStore.get(rebuildKey)).toBe(newerToken);
    expect(__getMessageIndexStateForTests().phase).toBe("intent");
    database.pauseBackfillMarker = null;
    await rebuildMessageIndex();
    expect(memoryStore.has(rebuildKey)).toBe(false);
  });

  test("rolls index cleanup forward from the cross-store account owner", async () => {
    const token = await beginAccountChatCleanupIntent();
    // Simulate a kill after canonical storage committed but before the index
    // store could report completion.
    await markAccountCanonicalChatCleared(token);

    await initMessageIndex();

    expect(database.deleteCalls).toBe(1);
    expect(memoryStore.has(CHAT_ACCOUNT_CLEANUP_REQUIRED_KEY)).toBe(false);
    expect(__getMessageIndexStateForTests().blocked).toBe(false);
  });

  test("the transcript entry point finishes both stores after an owner-only crash", async () => {
    await saveChatMessages("cloud", [
      { id: "departing-account", role: "user", text: "private" },
    ]);
    await beginAccountChatCleanupIntent();

    expect((await loadAccountChatCleanupIntent()) === null).toBe(false);

    expect((await loadRecentChatMessages("cloud")).messages).toEqual([]);
    expect(await loadAccountChatCleanupIntent()).toBeNull();
    expect(database.deleteCalls >= 2).toBe(true);
    expect(memoryStore.has(CHAT_ACCOUNT_CLEANUP_REQUIRED_KEY)).toBe(false);
    expect(__getMessageIndexStateForTests().blocked).toBe(false);
  });

  test("keeps recall blocked when marker removal fails, then retries", async () => {
    await beginMessageIndexRebuild();
    failRemove = true;
    await expect(rebuildMessageIndex()).rejects.toThrow(
      "marker removal failed",
    );
    expect(__getMessageIndexStateForTests()).toEqual({
      blocked: true,
      phase: "failed",
      rebuilding: false,
    });
    expect(memoryStore.has(rebuildKey)).toBe(true);

    failRemove = false;
    await initMessageIndex();
    expect(__getMessageIndexStateForTests().blocked).toBe(false);
    expect(memoryStore.has(rebuildKey)).toBe(false);
  });

  test("keeps durable recovery intent when physical clearing fails", async () => {
    await beginMessageIndexRebuild();
    database.failDelete = true;
    await expect(clearMessageIndex()).rejects.toThrow("index delete failed");
    expect(__getMessageIndexStateForTests()).toEqual({
      blocked: true,
      phase: "failed",
      rebuilding: false,
    });
    expect(memoryStore.has(rebuildKey)).toBe(true);

    database.failDelete = false;
    await initMessageIndex();
    expect(__getMessageIndexStateForTests().blocked).toBe(false);
    expect(memoryStore.has(rebuildKey)).toBe(false);
  });

  test("waits for an active rebuild before account clearing", async () => {
    await beginMessageIndexRebuild();
    let releaseDelete = () => {};
    database.pauseDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const rebuild = rebuildMessageIndex();
    const clear = clearMessageIndex();
    await Promise.resolve();
    expect(__getMessageIndexStateForTests().rebuilding).toBe(true);
    releaseDelete();
    await Promise.all([rebuild, clear]);
    expect(__getMessageIndexStateForTests()).toEqual({
      blocked: false,
      phase: "idle",
      rebuilding: false,
    });
    expect(database.deleteCalls).toBe(3);
  });
});

test("Recall broadens sparse phrases, preserves corrections and follows long-message references", async () => {
  const { Database } = await import("bun:sqlite");
  const { searchMessages } = await import("../chat-message-index");
  const { formatRecallResults } = await import("../chat-recall");
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT, text TEXT, created_at INTEGER);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
    CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO index_meta VALUES ('canonical-transcript-backfill-v1', 'done');`);
  try {
    const insert = sqlite.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)");
    insert.run(
      "A",
      "assistant",
      "red blue " + "x".repeat(9000) + " running " + "y".repeat(5000),
      1000,
    );
    insert.run("B", "user", "Correction: red gap blue stays.", 1000);
    sqlite.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    await __setMessageIndexDatabaseForTests({
      getAllAsync: async (sql: string, ...params: never[]) =>
        sqlite.prepare(sql).all(...params),
      getFirstAsync: async (sql: string, ...params: never[]) =>
        sqlite.prepare(sql).get(...params),
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...params: never[]) =>
        sqlite.prepare(sql).run(...params),
      withTransactionAsync: async (task: () => Promise<void>) => task(),
    });
    const hits = await searchMessages("red blue");
    expect(hits.map((hit) => hit.id).sort()).toEqual(["A", "B"]);
    const text = formatRecallResults(hits, "red blue");
    expect(text.match(/Correction: red gap blue stays\./g)).toHaveLength(1);
    expect(text.indexOf("red blue")).toBeLessThan(text.indexOf("Correction:"));
    const deep = formatRecallResults(await searchMessages("run"), "run");
    expect(deep).toContain("running");
    const next = deep.match(/next: (recall:\S+)/)?.[1];
    expect(next).toBeTruthy();
    expect(formatRecallResults(await searchMessages(next!), next!)).toContain(
      "y".repeat(100),
    );
    expect(await searchMessages("recall:other:A:0")).toEqual([]);
    expect(
      await searchMessages("red blue", { excludeIds: new Set(["A", "B"]) }),
    ).toEqual([]);
    sqlite.exec("DELETE FROM messages WHERE id = 'A'");
    expect(await searchMessages(next!)).toEqual([]);
  } finally {
    sqlite.close();
  }
});
