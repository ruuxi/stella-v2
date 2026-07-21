import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DreamInboxStore } from "@stella/runtime/kernel/memory/dream-inbox-store";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { createSqliteTestContextFactory } from "../../../helpers/sqlite-test-context.js";

const testContexts = createSqliteTestContextFactory(
  "stella-dream-inbox",
  (db) => new DreamInboxStore(db),
);
const createTestContext = testContexts.create;

afterEach(() => testContexts.cleanup());

describe("DreamInboxStore", () => {
  it("queues thread summaries and marks them processed by id", () => {
    const { store } = createTestContext();

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "First summary",
    });
    store.recordThreadSummary({
      threadId: "thread-b",
      runId: "run-2",
      agentType: "general",
      rolloutSummary: "Second summary",
    });
    store.recordThreadSummary({
      threadId: "thread-c",
      runId: "run-3",
      agentType: "general",
      rolloutSummary: "Third summary",
    });

    const unprocessed = store.listUnprocessed();
    expect(unprocessed).toHaveLength(3);
    expect(store.countUnprocessed()).toBe(3);

    const [first, second] = unprocessed;
    const result = store.markProcessed({ ids: [first!.id, second!.id] });
    expect(result.updated).toBe(2);

    const remaining = store.listUnprocessed();
    expect(remaining.map((row) => row.runId)).toEqual(["run-3"]);
    expect(store.countUnprocessed()).toBe(1);
  });

  it("re-recording a thread summary resets its processed state", () => {
    const { store } = createTestContext();

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Initial output",
    });
    const [row] = store.listUnprocessed();
    store.markProcessed({ ids: [row!.id] });
    expect(store.countUnprocessed()).toBe(0);

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Updated output",
    });
    const after = store.listUnprocessed();
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toBe("Updated output");
  });

  it("requeues surfaced evidence and prioritizes it by usage", () => {
    const { store } = createTestContext();
    vi.useFakeTimers();
    try {
      // Older row that was never recalled: the competing unprocessed entry.
      vi.setSystemTime(1_000);
      store.recordThreadSummary({
        threadId: "thread-other",
        runId: "run-other",
        agentType: "general",
        rolloutSummary: "Other work",
      });
      // Newer row that Recall will surface.
      vi.setSystemTime(2_000);
      store.recordThreadSummary({
        threadId: "thread-used",
        runId: "run-used",
        agentType: "general",
        rolloutSummary: "Frequently recalled work",
      });
      const recalled = store
        .listUnprocessed()
        .find((row) => row.threadId === "thread-used");
      store.markProcessed({ ids: [recalled!.id] });

      store.recordUsage("thread-used", "run-used");

      // Both rows now compete in the unprocessed queue. Oldest-first alone
      // would claim thread-other (source_updated_at 1000, usage 0) before
      // the recalled row (2000, usage 1); the certified ordering puts the
      // recalled row first so a bounded claim can't delay or exclude it.
      const queue = store.listUnprocessed();
      expect(queue.map((row) => row.threadId)).toEqual([
        "thread-used",
        "thread-other",
      ]);
      expect(queue[0]).toMatchObject({
        threadId: "thread-used",
        runId: "run-used",
        usageCount: 1,
      });
      expect(queue[1]).toMatchObject({
        threadId: "thread-other",
        usageCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves surfaced thread ids directly even when they are older than 200 rows", () => {
    const { store } = createTestContext();
    store.recordThreadSummary({
      threadId: "thread-old-target",
      runId: "run-old-target",
      agentType: "general",
      rolloutSummary: "Old but relevant work",
    });
    for (let index = 0; index < 205; index += 1) {
      store.recordThreadSummary({
        threadId: `thread-new-${index}`,
        runId: `run-new-${index}`,
        agentType: "general",
        rolloutSummary: `Newer work ${index}`,
      });
    }

    expect(store.listRecentThreadSummaries({ limit: 200 })).not.toContainEqual(
      expect.objectContaining({ threadId: "thread-old-target" }),
    );
    expect(store.findThreadSummariesByThreadIds(["thread-old-target"])).toEqual(
      [
        expect.objectContaining({
          threadId: "thread-old-target",
          runId: "run-old-target",
        }),
      ],
    );
  });

  it("debounces usage-driven Dream requeues while retaining usage counts", () => {
    const { store } = createTestContext();
    store.recordThreadSummary({
      threadId: "thread-used",
      runId: "run-used",
      agentType: "general",
      rolloutSummary: "Frequently recalled work",
    });
    const [initial] = store.listUnprocessed();
    store.markProcessed({ ids: [initial!.id], processedAt: 9_000 });

    store.recordUsage("thread-used", "run-used", {
      nowMs: 10_000,
      requeueDebounceMs: 1_000,
    });
    expect(store.countUnprocessed()).toBe(1);
    store.markProcessed({ ids: [initial!.id], processedAt: 10_100 });

    store.recordUsage("thread-used", "run-used", {
      nowMs: 10_500,
      requeueDebounceMs: 1_000,
    });
    expect(store.countUnprocessed()).toBe(0);
    expect(
      store.findThreadSummariesByThreadIds(["thread-used"])[0],
    ).toMatchObject({ usageCount: 2, lastUsage: 10_500 });

    store.recordUsage("thread-used", "run-used", {
      nowMs: 12_000,
      requeueDebounceMs: 1_000,
    });
    expect(store.countUnprocessed()).toBe(1);
    expect(store.listUnprocessed()[0]).toMatchObject({ usageCount: 3 });
  });

  it("redacts secrets before content enters the inbox", () => {
    const { store } = createTestContext();

    store.recordThreadSummary({
      threadId: "thread-secret",
      runId: "run-secret",
      agentType: "general",
      rolloutSummary:
        "Final output included OPENAI_API_KEY=sk-testsecret12345678901234567890",
    });

    const serialized = JSON.stringify(store.listUnprocessed());
    expect(serialized).not.toContain("sk-testsecret12345678901234567890");
    expect(serialized).toContain("OPENAI_API_KEY=");
    expect(serialized).toContain("***");
  });

  it("coalesces chronicle digests per window while unprocessed", () => {
    const { store } = createTestContext();

    store.recordChronicleSummary({
      window: "10m",
      content: "- Editing the runtime kernel",
      uniqueLines: 12,
    });
    store.recordChronicleSummary({
      window: "10m",
      content: "- Now reviewing a pull request",
      uniqueLines: 9,
    });
    store.recordChronicleSummary({
      window: "6h",
      content: "- A whole afternoon of Stella work",
      uniqueLines: 80,
    });

    const unprocessed = store.listUnprocessed();
    expect(unprocessed).toHaveLength(2);
    const tenMinute = unprocessed.find((row) => row.sourceKey === "10m");
    expect(tenMinute?.kind).toBe("chronicle");
    expect(tenMinute?.content).toBe("- Now reviewing a pull request");
    expect(tenMinute?.metadata).toMatchObject({
      window: "10m",
      uniqueLines: 9,
    });
  });

  it("stores memory notes as formatted candidates and lists them newest first", () => {
    const { store } = createTestContext();

    store.recordMemoryNote({
      title: "Concise updates",
      category: "user_preference",
      memory: "User prefers concise implementation updates.",
      recallHooks: ["concise", "updates"],
      evidence: ["User asked for shorter status updates."],
      createdAt: new Date("2026-05-28T12:34:56.000Z"),
    });
    store.recordMemoryNote({
      title: "Dark mode default",
      category: "user_preference",
      memory: "The user wants dark mode as the default theme.",
      recallHooks: ["dark mode", "theme"],
      evidence: ["User said: remember I want dark mode"],
      createdAt: new Date("2026-05-29T08:00:00.000Z"),
    });

    const notes = store.listRecentMemoryNotes();
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("dark mode as the default theme");
    expect(notes[1]).toContain("concise implementation updates");
    expect(notes[0]).toContain("## Recall hooks");

    const rows = store.listUnprocessed();
    const noteRows = rows.filter((row) => row.kind === "memory_note");
    expect(noteRows).toHaveLength(2);
    expect(noteRows.map((row) => row.title)).toContain("Dark mode default");
  });

  it("keeps same-title memory notes distinct instead of overwriting", () => {
    const { store } = createTestContext();
    const createdAt = new Date("2026-05-28T12:00:00.000Z");

    store.recordMemoryNote({
      title: "Same title",
      category: "active_focus",
      memory: "First candidate.",
      recallHooks: [],
      evidence: [],
      createdAt,
    });
    store.recordMemoryNote({
      title: "Same title",
      category: "active_focus",
      memory: "Second candidate.",
      recallHooks: [],
      evidence: [],
      createdAt,
    });

    expect(store.listRecentMemoryNotes()).toHaveLength(2);
  });

  it("redacts secrets when formatting a memory note", () => {
    const { store } = createTestContext();

    store.recordMemoryNote({
      title: "Secret note",
      category: "active_focus",
      memory: "User pasted OPENAI_API_KEY=sk-testsecret12345678901234567890",
      recallHooks: ["sk-testsecret12345678901234567890"],
      evidence: ["Authorization: Bearer sk-testsecret12345678901234567890"],
      createdAt: new Date("2026-05-28T12:00:00.000Z"),
    });

    const [note] = store.listRecentMemoryNotes();
    expect(note).not.toContain("sk-testsecret12345678901234567890");
    expect(note).toContain("OPENAI_API_KEY=");
    expect(note).toContain("***");
  });

  it("lists recent thread summaries regardless of processed state", () => {
    const { store } = createTestContext();

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Older work",
    });
    store.recordChronicleSummary({ window: "10m", content: "- noise" });
    const [first] = store.listUnprocessed();
    store.markProcessed({ ids: [first!.id] });

    const recents = store.listRecentThreadSummaries();
    expect(recents).toHaveLength(1);
    expect(recents[0]?.kind).toBe("thread_summary");
    expect(recents[0]?.threadId).toBe("thread-a");
  });

  it("persists a monotonic consolidation watermark across a new SQLite connection", () => {
    const { rootPath, store } = createTestContext();
    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Pending work",
    });
    const frontier = store.pendingFrontier();
    expect(frontier).toBeGreaterThan(0);
    store.writeConsolidationWatermark({ frontier, completedAt: 111 });
    store.writeConsolidationWatermark({
      frontier: frontier - 1,
      completedAt: 222,
    });

    const reloadedDb = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    try {
      initializeDesktopDatabase(reloadedDb);
      const reloaded = new DreamInboxStore(reloadedDb);
      expect(reloaded.readConsolidationWatermark()).toEqual({
        frontier,
        completedAt: 222,
      });
      expect(reloaded.pendingFrontier()).toBe(frontier);
    } finally {
      reloadedDb.close();
    }
  });

  it("garbage-collects only old consumed unused non-Chronicle rows", () => {
    const { store } = createTestContext();
    const day = 24 * 60 * 60 * 1_000;
    const now = Date.now();
    const old = now - 40 * day;
    for (const threadId of ["old", "pending", "used", "fresh"]) {
      store.recordThreadSummary({
        threadId,
        runId: `run-${threadId}`,
        agentType: "general",
        rolloutSummary: `${threadId} durable work`,
      });
    }
    store.recordChronicleSummary({ window: "10m", content: "- digest" });
    const row = (threadId: string) =>
      store
        .listUnprocessed({ limit: 100 })
        .find((candidate) => candidate.threadId === threadId)!;
    store.markProcessed({ ids: [row("old").id], processedAt: old });
    const used = row("used");
    store.markProcessed({ ids: [used.id], processedAt: old });
    store.recordUsage("used", "run-used", { nowMs: now - 1 });
    store.markProcessed({ ids: [used.id], processedAt: old });
    store.recordUsage("used", "run-used", { nowMs: now });
    store.markProcessed({ ids: [row("fresh").id], processedAt: now - day });
    const chronicle = store
      .listUnprocessed({ limit: 100 })
      .find((candidate) => candidate.kind === "chronicle")!;
    store.markProcessed({ ids: [chronicle.id], processedAt: old });

    expect(store.gcProcessedRows({ nowMs: now }).deleted).toBe(1);
    expect(
      store
        .listRecentThreadSummaries({ limit: 100 })
        .map((candidate) => candidate.threadId)
        .sort(),
    ).toEqual(["fresh", "pending", "used"]);
  });
});
