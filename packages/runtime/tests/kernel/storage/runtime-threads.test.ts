import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ACTIVE_RUNTIME_THREADS } from "@stella/runtime/kernel/runtime-threads";
import { slugify } from "@stella/runtime/kernel/shared/slug";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import { THREAD_KEY_TAIL_LENGTH } from "@stella/runtime/kernel/storage/thread-log";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-thread-groups-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new SessionStore(db),
  };
  activeContexts.add(context);
  return context;
};

beforeEach(() => {
  // last_used_at is driven by Date.now(); slot eviction picks the slot
  // whose MAX(last_used_at) is smallest, so tests advance fake time
  // between spawns to make LRU ordering deterministic.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-11T12:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

/** Spawn a new general thread, advancing fake time so recency ordering is strict. */
const spawnThread = (
  store: SessionStore,
  conversationId: string,
  nameHint: string,
) => {
  vi.advanceTimersByTime(1_000);
  return store.resolveOrCreateActiveThread({
    conversationId,
    agentType: "general",
    nameHint,
  });
};

const threadStatus = (db: SqliteDatabase, threadId: string): string =>
  (
    db
      .prepare("SELECT status FROM thread WHERE id = ?")
      .get(threadId) as { status: string }
  ).status;

const activeThreadIds = (
  store: SessionStore,
  conversationId: string,
): string[] =>
  store.listActiveThreadsByAge(conversationId).map((thread) => thread.threadId);

const threadName = (db: SqliteDatabase, threadId: string): string =>
  (
    db.prepare("SELECT name FROM thread WHERE id = ?").get(threadId) as {
      name: string;
    }
  ).name;

describe("slugify", () => {
  it("strips diacritics", () => {
    expect(slugify("Café au Lait — Crème Brûlée")).toBe(
      "cafe-au-lait-creme-brulee",
    );
  });

  it("returns an empty string for emoji-only input", () => {
    expect(slugify("🔥🚀 ✨")).toBe("");
  });

  it("truncates long input at a word boundary", () => {
    const slug = slugify(
      "Compare international flight prices Tokyo Osaka Kyoto",
    );
    // Full slug is 53 chars; the 48-char cut lands on the dash after
    // "osaka", so "kyoto" is dropped whole rather than mid-word.
    expect(slug).toBe("compare-international-flight-prices-tokyo-osaka");
    expect(slug.length).toBeLessThanOrEqual(48);
  });

  it("honors a custom maxLength, cutting back to the previous word", () => {
    expect(slugify("alpha beta gamma", 12)).toBe("alpha-beta");
  });
});

/** A minted key: the hint's slug plus a random base-36 tail. */
const mintedKey = (base: string) =>
  new RegExp(`^${base}-[0-9a-z]{${THREAD_KEY_TAIL_LENGTH}}$`);

describe("slug-based thread naming", () => {
  it("mints the thread key from the nameHint slug and stores the hint as name", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-naming";
    const result = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    expect(result.threadId).toMatch(mintedKey("compare-flight-prices-tokyo"));
    expect(result.reused).toBe(false);
    expect(threadName(db, result.threadId)).toBe("Compare flight prices Tokyo");
  });

  it("collapses whitespace in the stored name", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-naming-ws";
    const result = spawnThread(
      store,
      conversationId,
      "  Compare   flight\tprices  ",
    );
    expect(result.threadId).toMatch(mintedKey("compare-flight-prices"));
    expect(threadName(db, result.threadId)).toBe("Compare flight prices");
  });

  it("gives identical descriptions distinct keys", () => {
    const { store } = createTestContext();
    const conversationId = "conv-collide";
    const ids = [1, 2, 3].map(
      () => spawnThread(store, conversationId, "Compare flight prices").threadId,
    );
    for (const id of ids) expect(id).toMatch(mintedKey("compare-flight-prices"));
    expect(new Set(ids).size).toBe(3);
  });

  it("falls back to task keys when the hint slugs to nothing", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-emoji";
    const first = spawnThread(store, conversationId, "🔥🚀✨");
    const second = spawnThread(store, conversationId, "💡");
    expect(first.threadId).toMatch(mintedKey("task"));
    expect(second.threadId).toMatch(mintedKey("task"));
    expect(second.threadId).not.toBe(first.threadId);
    // The display name still keeps the raw (trimmed) hint.
    expect(threadName(db, first.threadId)).toBe("🔥🚀✨");
  });

  // `grp-` used to be a reserved namespace for thread groups. Groups are
  // gone, so a hint that slugs into it is now just an ordinary thread id.
  it("allows grp-prefixed hints now that thread groups do not exist", () => {
    const { store } = createTestContext();
    const conversationId = "conv-grp-hint";
    const result = spawnThread(store, conversationId, "GRP rollout plan");
    expect(result.threadId).toMatch(mintedKey("grp-rollout-plan"));
  });
});

describe("per-thread active budget", () => {
  it("evicts only the LRU thread when a 17th is created", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-evict-singleton";
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      ids.push(
        spawnThread(store, conversationId, `Singleton task ${i}`).threadId,
      );
    }
    expect(activeThreadIds(store, conversationId)).toHaveLength(
      MAX_ACTIVE_RUNTIME_THREADS,
    );

    const overflow = spawnThread(store, conversationId, "Overflow task");
    const active = activeThreadIds(store, conversationId);
    expect(active).toHaveLength(MAX_ACTIVE_RUNTIME_THREADS);
    expect(active).not.toContain(ids[0]);
    expect(active).toContain(ids[1]);
    expect(active).toContain(overflow.threadId);
    expect(threadStatus(db, ids[0]!)).toBe("evicted");
    expect(threadStatus(db, ids[1]!)).toBe("active");
  });

  it("reactivates one evicted thread and evicts one active thread", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-resume";
    const oldest = spawnThread(store, conversationId, "Old work");
    const fillers: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      fillers.push(spawnThread(store, conversationId, `Filler ${i}`).threadId);
    }
    expect(threadStatus(db, oldest.threadId)).toBe("evicted");

    vi.advanceTimersByTime(1_000);
    const resumed = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadId: oldest.threadId,
    });
    expect(resumed.reused).toBe(true);
    expect(threadStatus(db, oldest.threadId)).toBe("active");
    // Reactivating at budget evicts the LRU thread.
    expect(threadStatus(db, fillers[0]!)).toBe("evicted");
  });
});

describe("review-fix regressions", () => {
  it("thread slugs never land in the legacy- feature-id namespace", () => {
    const { store } = createTestContext();
    const created = spawnThread(store, "conv-legacy", "Legacy data import");
    expect(created.threadId).toMatch(mintedKey("task"));
  });
});
