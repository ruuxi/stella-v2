import { beforeEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  rebuildMobileCloudConversationCache,
  readMobileCloudConversationCache,
} from "../cloud-conversation-cache";

// AsyncStorage's non-native fallback talks to `window.localStorage`; give the
// bun test runtime an in-memory one before the storage module is exercised.
const memoryStore = new Map<string, string>();
let failSetKeyOnce: string | null = null;
let failGetKeyOnce: string | null = null;
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return memoryStore.size;
    },
    key: (index: number) => [...memoryStore.keys()][index] ?? null,
    getItem: (key: string) => {
      if (failGetKeyOnce && key.includes(failGetKeyOnce)) {
        failGetKeyOnce = null;
        throw new Error(`simulated localStorage read failure: ${key}`);
      }
      return memoryStore.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (failSetKeyOnce && key.includes(failSetKeyOnce)) {
        failSetKeyOnce = null;
        throw new Error(`simulated localStorage write failure: ${key}`);
      }
      memoryStore.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStore.delete(key);
    },
  },
};

import type { ChatMessage } from "../../types";
import { runAccountChatMetadataWrite } from "../chat-account-metadata-queue";
import {
  enqueueDesktopChatOutbox,
  loadDesktopChatOutbox,
} from "../desktop-chat-outbox";
import {
  CHAT_ACCOUNT_CANONICAL_CLEARED_KEY,
  CHAT_ACCOUNT_CLEANUP_REQUIRED_KEY,
  CHAT_ACCOUNT_INDEX_CLEARED_KEY,
  beginAccountChatCleanupIntent,
  finalizeAccountChatCleanup,
  loadAccountChatCleanupIntent,
  loadAccountChatCleanupProgress,
  markAccountCanonicalChatCleared,
  markAccountChatIndexCleared,
} from "../chat-account-cleanup-state";
import {
  CHAT_TRANSCRIPT_INITIAL_LIMIT,
  CHAT_TRANSCRIPT_MAX_LOADED,
  __getTranscriptCacheSizesForTests,
  __migrateLegacyTranscriptForTests,
  __setTranscriptDatabaseForTests,
  clearAllChatStorage,
  clearChatMessages,
  findChatMessageCursor,
  loadChatSyncState,
  loadChatMessages,
  loadNewerChatMessages,
  loadOldestChatMessages,
  loadOlderChatMessages,
  loadRecentChatMessages,
  saveChatMessages,
  saveChatSyncState,
  synchronizeChatMessages,
  subscribeChatStorageCleanup,
} from "../offline-chat-storage";

/** The cloud thread's transcript key — an account-scoped value cleanup wipes. */
const CLOUD_TRANSCRIPT_KEY = "stella-mobile-offline-chat-v1";

const sqliteAdapter = (database: Database) => ({
  execAsync: async (sql: string) => {
    database.exec(sql);
  },
  runAsync: async (sql: string, ...params: unknown[]) => {
    const result = database.prepare(sql).run(...(params as SQLQueryBindings[]));
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  },
  getFirstAsync: async <T>(sql: string, ...params: unknown[]) =>
    (database.prepare(sql).get(...(params as SQLQueryBindings[])) as
      | T
      | undefined) ?? null,
  getAllAsync: async <T>(sql: string, ...params: unknown[]) =>
    database.prepare(sql).all(...(params as SQLQueryBindings[])) as T[],
  withTransactionAsync: async (task: () => Promise<void>) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      await task();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

describe("canonical snapshot reconciliation", () => {
  test("native cache preserves authority fences and never publishes a failed snapshot", async () => {
    const database = new Database(":memory:");
    try {
      await __setTranscriptDatabaseForTests(sqliteAdapter(database));
      const metadata = {
        version: 1 as const,
        accountScope: "account-a",
        ownerGeneration: "owner-1",
        socketOrigin: "wss://test.local",
        conversationId: "conversation-a",
        epoch: 1,
        headSeq: 1,
        floorSeq: 0,
      };
      const previous: ChatMessage[] = [
        { id: "previous", role: "assistant", text: "previous account" },
      ];
      await rebuildMobileCloudConversationCache({
        metadata,
        messages: previous,
      });
      expect(await readMobileCloudConversationCache(metadata)).toEqual(
        previous,
      );
      const nextMetadata = {
        ...metadata,
        accountScope: "account-b",
        ownerGeneration: "owner-2",
        epoch: 2,
      };
      const next: ChatMessage[] = [
        { id: "next", role: "assistant", text: "next account" },
      ];
      await rebuildMobileCloudConversationCache({
        metadata: nextMetadata,
        messages: next,
      });
      expect(await readMobileCloudConversationCache(metadata)).toBeNull();
      expect(await readMobileCloudConversationCache(nextMetadata)).toEqual(
        next,
      );
      database.exec(
        "CREATE TRIGGER fail_cache BEFORE INSERT ON mobile_chat_messages BEGIN SELECT RAISE(ABORT, 'write failed'); END;",
      );
      await expect(
        rebuildMobileCloudConversationCache({
          metadata: { ...nextMetadata, headSeq: 2 },
          messages: [{ ...next[0]!, text: "changed" }],
        }),
      ).rejects.toThrow("write failed");
      expect(await readMobileCloudConversationCache(nextMetadata)).toBeNull();
      expect((await loadRecentChatMessages("cloud")).messages).toEqual(next);
      database.exec("DROP TRIGGER fail_cache");
      await rebuildMobileCloudConversationCache({
        metadata: nextMetadata,
        messages: next,
      });
      expect(await readMobileCloudConversationCache(nextMetadata)).toEqual(
        next,
      );
    } finally {
      await __setTranscriptDatabaseForTests(null);
      database.close();
    }
  });

  test("real SQLite changes only modified rows and preserves rolling-window order", async () => {
    const database = new Database(":memory:");
    const adapter = sqliteAdapter(database);
    let snapshotReads = 0;
    try {
      await __setTranscriptDatabaseForTests({
        ...adapter,
        getAllAsync: async <T>(sql: string, ...params: unknown[]) => {
          if (
            sql ===
            "SELECT message_id, order_key, payload_json FROM mobile_chat_messages WHERE thread_id = ?"
          )
            snapshotReads += 1;
          return adapter.getAllAsync<T>(sql, ...params);
        },
      });
      database.exec(`CREATE TABLE writes(operation TEXT);
        CREATE TRIGGER count_insert AFTER INSERT ON mobile_chat_messages BEGIN INSERT INTO writes VALUES('insert'); END;
        CREATE TRIGGER count_update AFTER UPDATE ON mobile_chat_messages BEGIN INSERT INTO writes VALUES('update'); END;
        CREATE TRIGGER count_delete AFTER DELETE ON mobile_chat_messages BEGIN INSERT INTO writes VALUES('delete'); END;`);
      const messages: ChatMessage[] = Array.from({ length: 1500 }, (_, i) => ({
        id: `snapshot-${i}`,
        role: "assistant",
        text: "x".repeat(4096),
      }));
      await synchronizeChatMessages("cloud", messages);
      database.exec("DELETE FROM writes");
      await synchronizeChatMessages(
        "cloud",
        messages.map((message) => ({ ...message })),
      );
      expect(database.query("SELECT * FROM writes").all()).toEqual([]);
      expect(snapshotReads).toBe(1);
      const next: ChatMessage[] = [
        ...messages.slice(1),
        { id: "snapshot-new", role: "assistant", text: "new" },
      ];
      next[10] = { ...next[10]!, text: "changed" };
      await synchronizeChatMessages("cloud", next);
      expect(
        database
          .query(
            "SELECT operation, count(*) AS n FROM writes GROUP BY operation ORDER BY operation",
          )
          .all(),
      ).toEqual([
        { operation: "delete", n: 1 },
        { operation: "insert", n: 1 },
        { operation: "update", n: 1 },
      ]);
      expect(snapshotReads).toBe(1);
      expect(
        database
          .query(
            "SELECT message_id FROM mobile_chat_messages ORDER BY order_key, message_id",
          )
          .all(),
      ).toEqual(next.map((message) => ({ message_id: message.id })));
      await saveChatMessages("cloud", [{ ...next[0]!, text: "external edit" }]);
      await synchronizeChatMessages("cloud", next);
      expect(snapshotReads).toBe(2);
      expect(
        (
          database
            .query(
              "SELECT payload_json FROM mobile_chat_messages WHERE message_id = ?",
            )
            .get(next[0]!.id) as { payload_json: string }
        ).payload_json,
      ).toBe(JSON.stringify(next[0]));
      await saveChatMessages("carplay", [
        { id: "other", role: "user", text: "preserved" },
      ]);
      await synchronizeChatMessages("cloud", []);
      expect((await loadRecentChatMessages("cloud")).messages).toEqual([]);
      expect((await loadRecentChatMessages("carplay")).messages[0]?.id).toBe(
        "other",
      );
    } finally {
      await __setTranscriptDatabaseForTests(null);
      database.close();
    }
  });

  test("real SQLite rolls back a superseded or failed snapshot", async () => {
    const database = new Database(":memory:");
    let current = true;
    let invalidateDuringWrite = false;
    const adapter = sqliteAdapter(database);
    try {
      await __setTranscriptDatabaseForTests({
        ...adapter,
        runAsync: async (sql: string, ...params: unknown[]) => {
          const result = await adapter.runAsync(sql, ...params);
          if (
            invalidateDuringWrite &&
            sql.startsWith("DELETE FROM mobile_chat_messages")
          )
            current = false;
          return result;
        },
      });
      const previous: ChatMessage[] = [
        { id: "old", role: "user", text: "old" },
      ];
      await synchronizeChatMessages("cloud", previous);
      invalidateDuringWrite = true;
      await synchronizeChatMessages(
        "cloud",
        [{ id: "new", role: "user", text: "new" }],
        () => current,
      );
      expect((await loadRecentChatMessages("cloud")).messages).toEqual(
        previous,
      );
      invalidateDuringWrite = false;
      database.exec(
        "CREATE TRIGGER fail_insert BEFORE INSERT ON mobile_chat_messages BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
      );
      await expect(
        synchronizeChatMessages("cloud", [
          { id: "new", role: "user", text: "new" },
        ]),
      ).rejects.toThrow("disk failure");
      expect((await loadRecentChatMessages("cloud")).messages).toEqual(
        previous,
      );
    } finally {
      await __setTranscriptDatabaseForTests(null);
      database.close();
    }
  });

  test("fallback preserves unchanged pages and removes rows outside the snapshot", async () => {
    await __setTranscriptDatabaseForTests(null);
    const messages: ChatMessage[] = Array.from({ length: 300 }, (_, i) => ({
      id: `fallback-${i}`,
      role: "user",
      text: `row ${i}`,
    }));
    await synchronizeChatMessages("cloud", messages);
    const pageEntries = () =>
      [...memoryStore].filter(
        ([key]) => key.includes(":page:") || key.includes(":meta"),
      );
    const before = pageEntries();
    await synchronizeChatMessages(
      "cloud",
      messages.map((message) => ({ ...message })),
    );
    expect(pageEntries()).toEqual(before);
    await synchronizeChatMessages("cloud", messages.slice(150));
    expect((await loadRecentChatMessages("cloud")).messages).toEqual(
      messages.slice(150),
    );
    await synchronizeChatMessages("cloud", []);
    expect((await loadRecentChatMessages("cloud")).messages).toEqual([]);
  });
});

class MigrationDatabase {
  rows = new Map<string, string>();
  marker: string | null = null;
  failMarkerOnce = false;

  async getFirstAsync<T>(): Promise<T | null> {
    return (this.marker ? { value: this.marker } : null) as T | null;
  }

  async runAsync(sql: string, ...params: unknown[]) {
    if (sql.includes("INSERT OR IGNORE INTO mobile_chat_messages")) {
      const id = String(params[1]);
      if (!this.rows.has(id)) this.rows.set(id, String(params[6]));
    } else if (sql.includes("INSERT INTO mobile_chat_meta")) {
      if (this.failMarkerOnce) {
        this.failMarkerOnce = false;
        throw new Error("simulated kill before migration commit");
      }
      this.marker = "done";
    }
    return { changes: 1, lastInsertRowId: 1 };
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const rows = new Map(this.rows);
    const marker = this.marker;
    try {
      await task();
    } catch (error) {
      this.rows = rows;
      this.marker = marker;
      throw error;
    }
  }

  async execAsync(): Promise<void> {}

  async getAllAsync<T>(): Promise<T[]> {
    return [];
  }
}

beforeEach(() => {
  memoryStore.clear();
  failSetKeyOnce = null;
  failGetKeyOnce = null;
});

describe("chat storage round-trip", () => {
  test("replaces one canonical transcript without clearing another thread", async () => {
    await __setTranscriptDatabaseForTests(null);
    await saveChatMessages("cloud", [
      { id: "stale-cloud", role: "user", text: "stale" },
    ]);
    await saveChatMessages("carplay", [
      { id: "kept-computer", role: "assistant", text: "keep" },
    ]);

    await clearChatMessages("cloud");

    expect(await loadChatMessages("cloud")).toEqual([]);
    expect((await loadChatMessages("carplay")).map((row) => row.id)).toEqual([
      "kept-computer",
    ]);
  });

  test("notifies mounted owners before account cleanup", async () => {
    let calls = 0;
    const unsubscribe = subscribeChatStorageCleanup(() => {
      calls += 1;
    });
    await clearAllChatStorage();
    expect(calls).toBe(1);
    unsubscribe();
    await clearAllChatStorage();
    expect(calls).toBe(1);
  });

  test("recovers an interrupted SQLite account cleanup before serving rows", async () => {
    const database = new Database(":memory:");
    const adapter = sqliteAdapter(database);
    let failDeleteOnce = true;
    await __setTranscriptDatabaseForTests({
      ...adapter,
      execAsync: async (sql: string) => {
        if (
          failDeleteOnce &&
          sql.includes("DELETE FROM mobile_chat_messages")
        ) {
          failDeleteOnce = false;
          throw new Error("simulated interrupted account cleanup");
        }
        await adapter.execAsync(sql);
      },
    });
    await saveChatMessages("cloud", [
      { id: "old-account", role: "user", text: "private" },
    ]);

    await expect(clearAllChatStorage()).rejects.toThrow(
      "Local chat account cleanup did not complete",
    );
    expect(
      memoryStore.has("stella-mobile-transcript-cleanup-required-v1"),
    ).toBe(true);
    expect((await loadRecentChatMessages("cloud")).messages).toEqual([]);
    expect(
      memoryStore.has("stella-mobile-transcript-cleanup-required-v1"),
    ).toBe(false);

    await __setTranscriptDatabaseForTests(null);
    database.close();
  });

  test("rolls canonical cleanup forward from the cross-store account owner", async () => {
    await saveChatMessages("cloud", [
      { id: "departing-account", role: "user", text: "private" },
    ]);
    const token = await beginAccountChatCleanupIntent();
    // Simulate a kill after the index store committed but before canonical
    // transcript cleanup began.
    await markAccountChatIndexCleared(token);

    expect((await loadRecentChatMessages("cloud")).messages).toEqual([]);
    expect(memoryStore.has(CHAT_ACCOUNT_CLEANUP_REQUIRED_KEY)).toBe(false);
  });

  test("rejects stale cross-store completion tokens", async () => {
    const token = await beginAccountChatCleanupIntent();
    memoryStore.set(CHAT_ACCOUNT_CANONICAL_CLEARED_KEY, "stale-token");
    memoryStore.set(CHAT_ACCOUNT_INDEX_CLEARED_KEY, "stale-token");

    expect(await loadAccountChatCleanupProgress(token)).toEqual({
      canonicalCleared: false,
      indexCleared: false,
    });
    expect(await finalizeAccountChatCleanup(token)).toBe(false);
    await markAccountCanonicalChatCleared(token);
    await markAccountChatIndexCleared(token);
    expect(await finalizeAccountChatCleanup(token)).toBe(true);
  });

  test("fails closed when the cross-store owner marker cannot be read or written", async () => {
    failSetKeyOnce = CHAT_ACCOUNT_CLEANUP_REQUIRED_KEY;
    await expect(beginAccountChatCleanupIntent()).rejects.toThrow(
      "simulated localStorage write failure",
    );
    expect(memoryStore.has(CHAT_ACCOUNT_CLEANUP_REQUIRED_KEY)).toBe(false);

    failGetKeyOnce = CHAT_ACCOUNT_CLEANUP_REQUIRED_KEY;
    await expect(loadAccountChatCleanupIntent()).rejects.toThrow(
      "simulated localStorage read failure",
    );
  });

  test("blocks sync and outbox metadata behind cross-store account ownership", async () => {
    await saveChatSyncState("carplay", {
      conversationId: "old-account",
      cursor: "old-cursor",
    });
    await enqueueDesktopChatOutbox("carplay", {
      sendId: "old-send",
      userMessageId: "old-user",
      text: "private",
      displayText: "private",
      createdAt: 1,
      attachments: [],
    });
    await beginAccountChatCleanupIntent();

    expect(await loadChatSyncState("carplay")).toEqual({
      conversationId: null,
      cursor: null,
    });
    expect(await loadDesktopChatOutbox("carplay")).toEqual([]);
    await saveChatSyncState("carplay", {
      conversationId: "must-not-write",
      cursor: "must-not-write",
    });
    await expect(
      enqueueDesktopChatOutbox("carplay", {
        sendId: "must-not-write",
        userMessageId: "must-not-write",
        text: "blocked",
        displayText: "blocked",
        createdAt: 2,
        attachments: [],
      }),
    ).rejects.toThrow("account cleanup is active");
    expect(
      (memoryStore.get("stella-mobile-carplay-sync-state-v1") ?? "").includes(
        "must-not-write",
      ),
    ).toBe(false);
    expect(
      (memoryStore.get("stella-mobile-carplay-chat-outbox-v1") ?? "").includes(
        "must-not-write",
      ),
    ).toBe(false);
  });

  test("clears the transcript cleanup marker once the wipe completes", async () => {
    await clearAllChatStorage();
    expect(
      memoryStore.has("stella-mobile-transcript-cleanup-required-v1"),
    ).toBe(false);
  });

  test("waits for an in-flight metadata write before deleting account data", async () => {
    let releaseWrite!: () => void;
    let signalStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = runAccountChatMetadataWrite(async () => {
      signalStarted?.();
      await gate;
      memoryStore.set(CLOUD_TRANSCRIPT_KEY, "stale rows");
    });
    await started;

    const cleanup = clearAllChatStorage();
    await Promise.resolve();
    releaseWrite();
    await Promise.all([write, cleanup]);

    expect(memoryStore.has(CLOUD_TRANSCRIPT_KEY)).toBe(false);
  });

  test("preserves the canonical ordering stamp alongside the local anchor", async () => {
    const rows: ChatMessage[] = [
      {
        id: "local-u",
        role: "user",
        text: "question",
        canonicalId: "desk-u",
        createdAt: 911_000,
        canonicalCreatedAt: 1_003_000,
        sourceMessageId: "source-u",
        sourceTimestamp: 1_002_000,
      },
      {
        id: "desk-a",
        role: "assistant",
        text: "answer",
        createdAt: 1_004_000,
        canonicalCreatedAt: 1_004_000,
      },
      // In-flight local row: no canonical identity, no stamp.
      { id: "local-x", role: "user", text: "in flight", createdAt: 911_500 },
    ];
    await saveChatMessages("carplay", rows);
    const loaded = await loadChatMessages("carplay");
    expect(loaded.map((m) => m.id)).toEqual(["local-u", "desk-a", "local-x"]);
    expect(loaded[0]?.canonicalCreatedAt).toBe(1_003_000);
    expect(loaded[0]?.createdAt).toBe(911_000);
    expect(loaded[0]?.sourceMessageId).toBe("source-u");
    expect(loaded[0]?.sourceTimestamp).toBe(1_002_000);
    expect(loaded[1]?.canonicalCreatedAt).toBe(1_004_000);
    expect(loaded[2]?.canonicalCreatedAt === undefined).toBe(true);
  });

  test("round-trips queued / stopped / requestId so a restart is honest and de-dupes", async () => {
    const rows: ChatMessage[] = [
      // A queued-but-unsent bubble must reload as queued, never as delivered.
      {
        id: "q1",
        role: "user",
        text: "send me later",
        createdAt: 5,
        queued: true,
      },
      // A reply linked only by requestId (killed before the canonicalId
      // reconcile) must keep it so the restart catch-up sync de-dupes it.
      {
        id: "a1",
        role: "assistant",
        text: "partial",
        createdAt: 6,
        requestId: "desk-user-1",
        stopped: true,
      },
    ];
    await saveChatMessages("cloud", rows);
    const loaded = await loadChatMessages("cloud");
    expect(loaded[0]?.queued).toBe(true);
    expect(loaded[1]?.requestId).toBe("desk-user-1");
    expect(loaded[1]?.stopped).toBe(true);
  });

  test("replaces a raw canonical twin when its stable local row is saved", async () => {
    await saveChatMessages("carplay", [
      { id: "before", role: "assistant", text: "before", createdAt: 9 },
      { id: "desk-user", role: "user", text: "hello", createdAt: 10 },
      { id: "after", role: "assistant", text: "after", createdAt: 11 },
    ]);
    await saveChatMessages("carplay", [
      {
        id: "local-user",
        canonicalId: "desk-user",
        role: "user",
        text: "hello",
        createdAt: 9,
      },
    ]);

    const loaded = await loadChatMessages("carplay");
    expect(loaded.map((message) => message.id)).toEqual([
      "before",
      "local-user",
      "after",
    ]);
    expect(loaded[1]?.canonicalId).toBe("desk-user");
  });

  test("round-trips normal-chat image metadata for history reload", async () => {
    const rows: ChatMessage[] = [
      {
        id: "image-u",
        role: "user",
        text: "What is this?",
        createdAt: 10,
        hasImage: true,
        thumbnailUris: ["file:///cached/photo.png"],
        attachmentPaths: ["Photos/photo.png"],
        attachmentPreviews: [{ path: "Photos/photo.png", name: "photo.png", imageUri: "file:///cached/photo.png" }],
      },
    ];

    await saveChatMessages("cloud", rows);
    const loaded = await loadChatMessages("cloud");
    expect(loaded).toEqual(rows);
  });

  test("pages 10k rows without hydrating an unbounded JS window", async () => {
    const rows: ChatMessage[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `scale-${index.toString().padStart(5, "0")}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `row ${index}`,
      createdAt: index,
    }));
    await saveChatMessages("cloud", rows);

    const recent = await loadRecentChatMessages("cloud");
    expect(recent.messages).toHaveLength(CHAT_TRANSCRIPT_INITIAL_LIMIT);
    expect(recent.messages[0]?.id).toBe("scale-09840");
    expect(recent.messages.at(-1)?.id).toBe("scale-09999");
    expect(recent.hasOlder).toBe(true);

    const oldest = await loadOldestChatMessages("cloud", 80);
    expect(oldest.messages).toHaveLength(80);
    expect(oldest.messages[0]?.id).toBe("scale-00000");
    expect(oldest.messages.at(-1)?.id).toBe("scale-00079");
    expect(oldest.hasOlder).toBe(false);
    expect(oldest.hasNewer).toBe(true);

    const older = await loadOlderChatMessages(
      "cloud",
      recent.oldestCursor!,
      80,
    );
    expect(older.messages).toHaveLength(80);
    expect(older.messages[0]?.id).toBe("scale-09760");
    expect(older.messages.at(-1)?.id).toBe("scale-09839");
    expect(older.hasNewer).toBe(true);

    const newer = await loadNewerChatMessages("cloud", older.newestCursor!, 80);
    expect(newer.messages.map((message) => message.id)).toEqual(
      recent.messages.slice(0, 80).map((message) => message.id),
    );
    const checkpointCursor = await findChatMessageCursor(
      "cloud",
      "scale-05000",
    );
    expect(checkpointCursor === null).toBe(false);
    expect(
      (await loadNewerChatMessages("cloud", checkpointCursor!, 1)).messages[0]
        ?.id,
    ).toBe("scale-05001");
    const cacheSizes = __getTranscriptCacheSizesForTests("cloud");
    expect(cacheSizes.orderKeys).toBeLessThanOrEqual(
      CHAT_TRANSCRIPT_MAX_LOADED * 2,
    );
    expect(cacheSizes.serialized).toBeLessThanOrEqual(
      CHAT_TRANSCRIPT_MAX_LOADED * 2,
    );
  });

  test("keeps a full historical fallback page ordered before its anchor", async () => {
    await saveChatMessages("carplay", [
      {
        id: "anchor",
        role: "assistant",
        text: "anchor",
        createdAt: 1_000,
      },
    ]);
    const historical = Array.from({ length: 100 }, (_, index) => ({
      id: `historical-${String(99 - index).padStart(3, "0")}`,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: String(index),
      createdAt: index,
    }));
    await saveChatMessages("carplay", [
      ...historical,
      {
        id: "anchor",
        role: "assistant",
        text: "anchor",
        createdAt: 1_000,
      },
    ]);

    const loaded = await loadChatMessages("carplay");
    expect(loaded.map((message) => message.text)).toEqual([
      ...historical.map((message) => message.text),
      "anchor",
    ]);
  });

  test("rebalances fallback order keys after repeated middle insertion", async () => {
    await __setTranscriptDatabaseForTests(null);
    const before: ChatMessage = {
      id: "precision-before",
      role: "assistant",
      text: "before",
    };
    const after: ChatMessage = {
      id: "precision-after",
      role: "assistant",
      text: "after",
    };
    await saveChatMessages("cloud", [before, after]);
    const staleAfterCursor = await findChatMessageCursor(
      "cloud",
      "precision-after",
    );
    let next = after;
    for (let index = 0; index < 80; index += 1) {
      const inserted: ChatMessage = {
        id: `precision-${String(index).padStart(2, "0")}`,
        role: "user",
        text: String(index),
      };
      await saveChatMessages("cloud", [before, inserted, next]);
      next = inserted;
    }

    expect(
      (await loadRecentChatMessages("cloud", 100)).messages.map(
        (row) => row.id,
      ),
    ).toEqual([
      "precision-before",
      ...Array.from(
        { length: 80 },
        (_, index) => `precision-${String(79 - index).padStart(2, "0")}`,
      ),
      "precision-after",
    ]);
    expect(
      (await loadOlderChatMessages("cloud", staleAfterCursor!, 1)).messages[0]
        ?.id,
    ).toBe("precision-00");
  });

  test("bounded incremental saves preserve unloaded durable rows", async () => {
    const rows: ChatMessage[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `incremental-${index}`,
      role: "assistant",
      text: `before ${index}`,
      createdAt: index,
    }));
    await saveChatMessages("carplay", rows);
    const recent = await loadRecentChatMessages("carplay", 20);
    const changed = recent.messages.map((message) =>
      message.id === "incremental-999"
        ? { ...message, text: "stream settled" }
        : message,
    );
    await saveChatMessages("carplay", changed);

    const reloaded = await loadRecentChatMessages("carplay", 1_000);
    expect(reloaded.messages).toHaveLength(1_000);
    expect(reloaded.messages[0]?.id).toBe("incremental-0");
    expect(reloaded.messages.at(-1)?.text).toBe("stream settled");
  });

  test("keeps the old fallback manifest readable across page and manifest failures", async () => {
    await __setTranscriptDatabaseForTests(null);
    const rows: ChatMessage[] = Array.from({ length: 300 }, (_, index) => ({
      id: `crash-${index}`,
      role: "assistant",
      text: `before ${index}`,
      createdAt: index,
    }));
    await saveChatMessages("cloud", rows);

    failSetKeyOnce = ":page:";
    await expect(
      saveChatMessages("cloud", [{ ...rows[299]!, text: "failed page write" }]),
    ).rejects.toThrow("simulated localStorage write failure");
    await __setTranscriptDatabaseForTests(null);
    expect((await loadRecentChatMessages("cloud", 1)).messages[0]?.text).toBe(
      "before 299",
    );

    failSetKeyOnce = ":meta";
    await expect(
      saveChatMessages("cloud", [
        { ...rows[299]!, text: "failed manifest write" },
      ]),
    ).rejects.toThrow("simulated localStorage write failure");
    await __setTranscriptDatabaseForTests(null);
    expect((await loadRecentChatMessages("cloud", 1)).messages[0]?.text).toBe(
      "before 299",
    );

    await saveChatMessages("cloud", [
      { ...rows[299]!, text: "committed after retry" },
    ]);
    const recovered = await loadRecentChatMessages("cloud", 300);
    expect(recovered.messages).toHaveLength(300);
    expect(new Set(recovered.messages.map((message) => message.id)).size).toBe(
      300,
    );
    expect(recovered.messages.at(-1)?.text).toBe("committed after retry");
  });

  test("repairs an active but incorrect fallback row locator", async () => {
    await __setTranscriptDatabaseForTests(null);
    const rows: ChatMessage[] = Array.from({ length: 300 }, (_, index) => ({
      id: `locator-${index}`,
      role: "assistant",
      text: `before ${index}`,
      createdAt: index,
    }));
    await saveChatMessages("cloud", rows);
    const metaKey = [...memoryStore.keys()].find((key) =>
      key.endsWith(":cloud:meta"),
    )!;
    const rowKey = [...memoryStore.keys()].find((key) =>
      key.endsWith(":cloud:row:locator-299"),
    )!;
    const meta = JSON.parse(memoryStore.get(metaKey)!) as {
      pages: { id: number }[];
    };
    const locator = JSON.parse(memoryStore.get(rowKey)!) as {
      pageId: number;
      orderKey: number;
    };
    memoryStore.set(
      rowKey,
      JSON.stringify({ ...locator, pageId: meta.pages[0]!.id }),
    );

    await saveChatMessages("cloud", [
      { ...rows[299]!, text: "updated through repaired locator" },
    ]);

    const recovered = await loadRecentChatMessages("cloud", 300);
    expect(recovered.messages).toHaveLength(300);
    expect(new Set(recovered.messages.map((message) => message.id)).size).toBe(
      300,
    );
    expect(recovered.messages.at(-1)?.text).toBe(
      "updated through repaired locator",
    );
  });

  test("serializes concurrent incremental writes", async () => {
    const rows: ChatMessage[] = Array.from({ length: 500 }, (_, index) => ({
      id: `concurrent-${index}`,
      role: "user",
      text: String(index),
      createdAt: index,
    }));
    await saveChatMessages("cloud", rows);
    await Promise.all([
      saveChatMessages("cloud", [
        ...rows.slice(-20),
        { id: "concurrent-a", role: "assistant", text: "a", createdAt: 501 },
      ]),
      saveChatMessages("cloud", [
        ...rows.slice(-20),
        { id: "concurrent-b", role: "assistant", text: "b", createdAt: 502 },
      ]),
    ]);
    const recent = await loadRecentChatMessages("cloud", 10);
    expect(recent.messages.slice(-2).map((message) => message.id)).toEqual([
      "concurrent-a",
      "concurrent-b",
    ]);
    // Neither concurrent write clobbered the other's tail.
    expect(recent.messages.map((message) => message.id)).toContain(
      "concurrent-499",
    );
  });

  test("retries interrupted and concurrent legacy migrations idempotently", async () => {
    const legacy = Array.from(
      { length: 250 },
      (_, index): ChatMessage => ({
        id: `legacy-${index}`,
        role: index % 2 ? "assistant" : "user",
        text: `legacy ${index}`,
        createdAt: index,
      }),
    );
    memoryStore.set("stella-mobile-offline-chat-v1", JSON.stringify(legacy));
    const interrupted = new MigrationDatabase();
    interrupted.failMarkerOnce = true;

    await expect(
      __migrateLegacyTranscriptForTests(interrupted, "cloud"),
    ).rejects.toThrow("simulated kill");
    expect(interrupted.rows.size).toBe(0);
    expect(memoryStore.has("stella-mobile-offline-chat-v1")).toBe(true);

    await __migrateLegacyTranscriptForTests(interrupted, "cloud");
    expect(interrupted.rows.size).toBe(250);
    expect(interrupted.marker).toBe("done");
    expect(memoryStore.has("stella-mobile-offline-chat-v1")).toBe(false);

    memoryStore.set("stella-mobile-carplay-chat-v1", JSON.stringify(legacy));
    const concurrent = new MigrationDatabase();
    await Promise.all([
      __migrateLegacyTranscriptForTests(concurrent, "carplay"),
      __migrateLegacyTranscriptForTests(concurrent, "carplay"),
    ]);
    expect(concurrent.rows.size).toBe(250);
    expect(concurrent.marker).toBe("done");
  });

  test("does not let an in-flight legacy migration survive account cleanup", async () => {
    const legacy: ChatMessage[] = [
      { id: "old-account", role: "user", text: "private", createdAt: 1 },
    ];
    memoryStore.set("stella-mobile-offline-chat-v1", JSON.stringify(legacy));
    const delayed = new MigrationDatabase();

    await Promise.all([
      __migrateLegacyTranscriptForTests(delayed, "cloud"),
      clearAllChatStorage(),
    ]);

    expect(delayed.rows.size).toBe(0);
    expect(memoryStore.has("stella-mobile-offline-chat-v1")).toBe(false);
  });

  test("uses real SQLite keysets and preserves unloaded rows", async () => {
    const database = new Database(":memory:");
    try {
      await __setTranscriptDatabaseForTests(sqliteAdapter(database));
      const rows: ChatMessage[] = Array.from(
        { length: 10_000 },
        (_, index) => ({
          id: `sqlite-${index.toString().padStart(5, "0")}`,
          role: index % 2 === 0 ? "user" : "assistant",
          text: `SQLite row ${index}`,
          createdAt: index,
        }),
      );
      await saveChatMessages("cloud", rows);

      const oldest = await loadOldestChatMessages("cloud", 80);
      const recent = await loadRecentChatMessages("cloud", 160);
      expect(oldest.messages[0]?.id).toBe("sqlite-00000");
      expect(oldest.messages.at(-1)?.id).toBe("sqlite-00079");
      expect(recent.messages[0]?.id).toBe("sqlite-09840");
      expect(recent.messages.at(-1)?.id).toBe("sqlite-09999");
      const checkpointCursor = await findChatMessageCursor(
        "cloud",
        "sqlite-05000",
      );
      expect(checkpointCursor === null).toBe(false);
      expect(
        (await loadNewerChatMessages("cloud", checkpointCursor!, 1)).messages[0]
          ?.id,
      ).toBe("sqlite-05001");

      const changed = recent.messages.map((message) =>
        message.id === "sqlite-09999"
          ? { ...message, text: "settled without full rewrite" }
          : message,
      );
      await saveChatMessages("cloud", changed);
      const first = await loadOldestChatMessages("cloud", 1);
      const last = await loadRecentChatMessages("cloud", 1);
      expect(first.messages[0]?.id).toBe("sqlite-00000");
      expect(last.messages[0]?.text).toBe("settled without full rewrite");

      // A reconnect delta can be wholly newer than a stale local transcript,
      // with no overlapping id to anchor it. It must append after the durable
      // maximum rather than collide with order key zero.
      await saveChatMessages("cloud", [
        {
          id: "sqlite-disconnected-a",
          role: "assistant",
          text: "newer A",
          createdAt: 10_001,
        },
        {
          id: "sqlite-disconnected-b",
          role: "assistant",
          text: "newer B",
          createdAt: 10_002,
        },
      ]);
      let newest = await loadRecentChatMessages("cloud", 2);
      expect(newest.messages.map((message) => message.id)).toEqual([
        "sqlite-disconnected-a",
        "sqlite-disconnected-b",
      ]);

      await saveChatMessages("cloud", [
        {
          id: "sqlite-local-b",
          canonicalId: "sqlite-disconnected-b",
          role: "assistant",
          text: "newer B",
          createdAt: 10_000,
        },
      ]);
      newest = await loadRecentChatMessages("cloud", 2);
      expect(newest.messages.map((message) => message.id)).toEqual([
        "sqlite-disconnected-a",
        "sqlite-local-b",
      ]);
      const cacheSizes = __getTranscriptCacheSizesForTests("cloud");
      expect(cacheSizes.orderKeys).toBeLessThanOrEqual(
        CHAT_TRANSCRIPT_MAX_LOADED * 2,
      );
      expect(cacheSizes.serialized).toBeLessThanOrEqual(
        CHAT_TRANSCRIPT_MAX_LOADED * 2,
      );
    } finally {
      await __setTranscriptDatabaseForTests(null);
      database.close();
    }
  });

  test("rebalances SQLite order keys after repeated middle insertion", async () => {
    const database = new Database(":memory:");
    try {
      await __setTranscriptDatabaseForTests(sqliteAdapter(database));
      const before: ChatMessage = {
        id: "sqlite-precision-before",
        role: "assistant",
        text: "before",
      };
      const after: ChatMessage = {
        id: "sqlite-precision-after",
        role: "assistant",
        text: "after",
      };
      await saveChatMessages("carplay", [before, after]);
      const staleAfterCursor = await findChatMessageCursor(
        "carplay",
        "sqlite-precision-after",
      );
      let next = after;
      for (let index = 0; index < 80; index += 1) {
        const inserted: ChatMessage = {
          id: `sqlite-precision-${String(index).padStart(2, "0")}`,
          role: "user",
          text: String(index),
        };
        await saveChatMessages("carplay", [before, inserted, next]);
        next = inserted;
      }

      expect(
        (await loadRecentChatMessages("carplay", 100)).messages.map(
          (row) => row.id,
        ),
      ).toEqual([
        "sqlite-precision-before",
        ...Array.from(
          { length: 80 },
          (_, index) =>
            `sqlite-precision-${String(79 - index).padStart(2, "0")}`,
        ),
        "sqlite-precision-after",
      ]);
      expect(
        (await loadOlderChatMessages("carplay", staleAfterCursor!, 1))
          .messages[0]?.id,
      ).toBe("sqlite-precision-00");
    } finally {
      await __setTranscriptDatabaseForTests(null);
      database.close();
    }
  });
});
