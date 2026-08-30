import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_RUNTIME_THREADS,
  buildActiveThreadsPrompt,
  type RuntimeThreadRecord,
} from "@stella/runtime/kernel/runtime-threads";
import { slugify } from "@stella/runtime/kernel/shared/slug";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
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
  store.listActiveThreads(conversationId).map((thread) => thread.threadId);

describe("slugify", () => {
  it("slugs a basic phrase to lowercase dash-separated words", () => {
    expect(slugify("Compare Flight Prices: Tokyo!")).toBe(
      "compare-flight-prices-tokyo",
    );
  });

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

    expect(slug).toBe("compare-international-flight-prices-tokyo-osaka");
    expect(slug.length).toBeLessThanOrEqual(48);
  });

  it("honors a custom maxLength, cutting back to the previous word", () => {
    expect(slugify("alpha beta gamma", 12)).toBe("alpha-beta");
  });
});

describe("slug-based thread naming", () => {
  it("mints the thread key from the nameHint slug and stores the hint as name", () => {
    const { store } = createTestContext();
    const conversationId = "conv-naming";
    const result = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    expect(result.threadId).toBe("compare-flight-prices-tokyo");
    expect(result.reused).toBe(false);
    const record = store
      .listActiveThreads(conversationId)
      .find((thread) => thread.threadId === result.threadId);
    expect(record?.name).toBe("Compare flight prices Tokyo");
  });

  it("collapses whitespace in the stored name", () => {
    const { store } = createTestContext();
    const conversationId = "conv-naming-ws";
    const result = spawnThread(
      store,
      conversationId,
      "  Compare   flight\tprices  ",
    );
    expect(result.threadId).toBe("compare-flight-prices");
    const record = store
      .listActiveThreads(conversationId)
      .find((thread) => thread.threadId === result.threadId);
    expect(record?.name).toBe("Compare flight prices");
  });

  it("suffixes colliding thread keys with -2, -3", () => {
    const { store } = createTestContext();
    const conversationId = "conv-collide";
    const first = spawnThread(store, conversationId, "Compare flight prices");
    const second = spawnThread(store, conversationId, "Compare flight prices");
    const third = spawnThread(store, conversationId, "Compare flight prices");
    expect(first.threadId).toBe("compare-flight-prices");
    expect(second.threadId).toBe("compare-flight-prices-2");
    expect(third.threadId).toBe("compare-flight-prices-3");
  });

  it("falls back to task-N ordinals when the hint slugs to nothing", () => {
    const { store } = createTestContext();
    const conversationId = "conv-emoji";
    const first = spawnThread(store, conversationId, "🔥🚀✨");
    const second = spawnThread(store, conversationId, "💡");
    expect(first.threadId).toBe("task-1");
    expect(second.threadId).toBe("task-2");

    const record = store
      .listActiveThreads(conversationId)
      .find((thread) => thread.threadId === first.threadId);
    expect(record?.name).toBe("🔥🚀✨");
  });

  it("allows grp-prefixed hints now that thread groups do not exist", () => {
    const { store } = createTestContext();
    const conversationId = "conv-grp-hint";
    const result = spawnThread(store, conversationId, "GRP rollout plan");
    expect(result.threadId).toBe("grp-rollout-plan");
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
    expect(store.listActiveThreads(conversationId)).toHaveLength(
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

    expect(threadStatus(db, fillers[0]!)).toBe("evicted");
  });
});

describe("searchThreads", () => {
  it("finds evicted threads by a name token and reports their status", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-search-evicted";
    const target = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      spawnThread(store, conversationId, `Filler ${i}`);
    }
    expect(threadStatus(db, target.threadId)).toBe("evicted");

    const results = store.searchThreads({ conversationId, query: "flight" });
    expect(results.map((thread) => thread.threadId)).toEqual([target.threadId]);
    expect(results[0]?.status).toBe("evicted");
    expect(results[0]?.name).toBe("Compare flight prices Tokyo");
  });

  it("ranks threads matching more tokens first without dropping partial matches", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-rank";
    const both = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    const hotel = spawnThread(
      store,
      conversationId,
      "Compare hotel prices Tokyo",
    );
    const paris = spawnThread(
      store,
      conversationId,
      "Compare flight prices Paris",
    );
    spawnThread(store, conversationId, "Organize tax documents");

    const results = store.searchThreads({
      conversationId,
      query: "flight tokyo",
    });
    expect(results.map((thread) => thread.threadId)).toEqual([
      both.threadId,
      paris.threadId,
      hotel.threadId,
    ]);
  });

  it("ignores stopwords so verbose natural-language queries still match", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-stopwords";
    const match = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    spawnThread(store, conversationId, "Organize tax documents");

    const results = store.searchThreads({
      conversationId,
      query: "the flight comparison from last week",
    });
    expect(results.map((thread) => thread.threadId)).toEqual([match.threadId]);
  });

  it("still searches when every token is a stopword", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-all-stopwords";
    const match = spawnThread(store, conversationId, "What is it tracker");
    spawnThread(store, conversationId, "Organize tax documents");

    const results = store.searchThreads({
      conversationId,
      query: "what is it",
    });
    expect(results.map((thread) => thread.threadId)).toEqual([match.threadId]);
  });

  it("returns the most recent threads first when no query is given", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-recent";
    const a = spawnThread(store, conversationId, "Oldest job");
    const b = spawnThread(store, conversationId, "Middle job");
    const c = spawnThread(store, conversationId, "Newest job");

    const results = store.searchThreads({ conversationId });
    expect(results.map((thread) => thread.threadId)).toEqual([
      c.threadId,
      b.threadId,
      a.threadId,
    ]);
  });

  it("is dual-scoped: current-conversation hits sort ahead of other conversations'", () => {
    const { store } = createTestContext();

    const mine = spawnThread(store, "conv-mine", "Compare flight prices");
    const other = spawnThread(store, "conv-other", "Compare flight schedules");

    const results = store.searchThreads({
      conversationId: "conv-mine",
      query: "flight",
    });
    expect(results.map((thread) => thread.threadId)).toEqual([
      mine.threadId,
      other.threadId,
    ]);

    expect(results[0]?.conversationId).toBe("conv-mine");
    expect(results[1]?.conversationId).toBe("conv-other");
  });

  it("finds another conversation's work even with zero current-conversation matches", () => {
    const { store } = createTestContext();
    const other = spawnThread(store, "conv-a", "Fix CarPlay blank screen");
    spawnThread(store, "conv-b", "Organize tax documents");

    const results = store.searchThreads({
      conversationId: "conv-b",
      query: "carplay",
    });
    expect(results.map((thread) => thread.threadId)).toEqual([other.threadId]);
  });

  it("excludes orchestrator-typed threads and the conversation's own thread key", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-excluded";
    store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "orchestrator",
      nameHint: "Coordinate flight booking",
    });

    store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadId: conversationId,
    });
    const real = spawnThread(store, conversationId, "Book flight seats");

    expect(
      store.searchThreads({ conversationId }).map((thread) => thread.threadId),
    ).toEqual([real.threadId]);
    expect(
      store
        .searchThreads({ conversationId, query: "flight" })
        .map((thread) => thread.threadId),
    ).toEqual([real.threadId]);
  });

  it("respects the limit, keeping the most recent matches", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-limit";
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(spawnThread(store, conversationId, `Batch job ${i}`).threadId);
    }
    const results = store.searchThreads({ conversationId, limit: 3 });
    expect(results.map((thread) => thread.threadId)).toEqual([
      ids[4],
      ids[3],
      ids[2],
    ]);
  });

  it("treats LIKE wildcards in the query as literals", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-wildcards";
    const percent = spawnThread(
      store,
      conversationId,
      "Reach 100% test coverage",
    );
    spawnThread(store, conversationId, "Process 1000 records");
    const underscore = spawnThread(
      store,
      conversationId,
      "Audit snake_case columns",
    );
    spawnThread(store, conversationId, "Audit snakeycase columns");

    expect(
      store
        .searchThreads({ conversationId, query: "100%" })
        .map((thread) => thread.threadId),
    ).toEqual([percent.threadId]);
    expect(
      store
        .searchThreads({ conversationId, query: "snake_case" })
        .map((thread) => thread.threadId),
    ).toEqual([underscore.threadId]);
  });

  it("matches the runtime_agents description via the LEFT JOIN", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-description";
    const thread = spawnThread(store, conversationId, "Quiet thread");
    store.saveAgentRecord({
      threadId: thread.threadId,
      conversationId,
      agentType: "general",
      description: "Investigating quarterly revenue anomalies",
      agentDepth: 1,
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const results = store.searchThreads({
      conversationId,
      query: "anomalies",
    });
    expect(results.map((t) => t.threadId)).toEqual([thread.threadId]);
    expect(results[0]?.description).toBe(
      "Investigating quarterly revenue anomalies",
    );
  });
});

describe("buildActiveThreadsPrompt", () => {
  const makeThread = (
    overrides: Partial<RuntimeThreadRecord> & { threadId: string },
  ): RuntimeThreadRecord => ({
    conversationId: "conv-prompt",
    name: overrides.threadId,
    agentType: "general",
    status: "active",
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  });

  it("labels a currently executing thread active and an idle one paused", () => {
    const now = 1_700_000_000_000;
    const prompt = buildActiveThreadsPrompt(
      [
        makeThread({
          threadId: "running-now",
          lastUsedAt: now - 10 * 60_000,

          agentUpdatedAt: now - 60_000,
          agentStatus: "running",
        }),
        makeThread({
          threadId: "idle-thread",
          lastUsedAt: now - 5 * 60_000,
          agentStatus: "completed",
        }),
        makeThread({
          threadId: "errored-thread",
          lastUsedAt: now - 2 * 60_000,
          agentStatus: "error",
        }),
      ],
      now,
    );

    expect(prompt).toContain("\n- running-now (active, last active 1m ago)");
    expect(prompt).toContain("\n- idle-thread (paused, last active 5m ago)");
    expect(prompt).toContain(
      "\n- errored-thread (paused (last run errored), last active 2m ago)",
    );

    expect(prompt.indexOf("running-now")).toBeLessThan(
      prompt.indexOf("errored-thread"),
    );
    expect(prompt).not.toContain("##");
    expect(prompt).toContain("Recall");
  });

  it("returns an empty string when there are no threads", () => {
    expect(buildActiveThreadsPrompt([], 1_700_000_000_000)).toBe("");
  });

  it("derives active vs paused end-to-end from the runtime_agents.status join", () => {

    const { store } = createTestContext();
    const conversationId = "conv-live-state";
    const running = spawnThread(store, conversationId, "Deploy the backend");
    const idle = spawnThread(store, conversationId, "Draft the budget memo");

    const persistAgent = (
      threadId: string,
      status: "running" | "completed",
    ): void => {
      const at = Date.now();
      store.saveAgentRecord({
        threadId,
        conversationId,
        agentType: "general",
        description:
          threadId === running.threadId
            ? "Deploy the backend"
            : "Draft the budget memo",
        agentDepth: 1,
        status,
        startedAt: at,
        completedAt: status === "completed" ? at : null,
        updatedAt: at,
      });
    };
    persistAgent(running.threadId, "running");
    persistAgent(idle.threadId, "completed");

    const now = Date.now();
    const prompt = buildActiveThreadsPrompt(
      store.listActiveThreads(conversationId),
      now,
    );

    expect(prompt).toContain(`- ${running.threadId} (active, last active`);
    expect(prompt).toContain(`- ${idle.threadId} (paused, last active`);
  });
});

describe("review-fix regressions", () => {
  it("searchThreads excludes implicit ::subagent:: transcript rows", () => {
    const { store } = createTestContext();
    spawnThread(store, "conv-x", "Real flight research");

    store.updateThreadSummary(
      "conv-x::subagent::general::wf-research-a1",
      "internal transcript",
    );
    const results = store.searchThreads({ conversationId: "conv-x" });
    expect(results.map((thread) => thread.threadId)).toEqual([
      "real-flight-research",
    ]);
  });

  it("thread slugs never land in the legacy- feature-id namespace", () => {
    const { store } = createTestContext();
    const created = spawnThread(store, "conv-legacy", "Legacy data import");
    expect(created.threadId).toBe("task-1");
  });
});
