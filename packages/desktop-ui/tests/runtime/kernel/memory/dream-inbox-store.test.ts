import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DreamInboxStore } from "@stella/runtime/kernel/memory/dream-inbox-store";
import { initializeDesktopDatabase } from "@stella/runtime/kernel/storage/database-init";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { createSqliteTestContextFactory } from "../../../helpers/sqlite-test-context.js";

const testContexts = createSqliteTestContextFactory(
  "stella-dream-inbox",
  (db) => new DreamInboxStore(db),
);
const createTestContext = testContexts.create;

afterEach(() => testContexts.cleanup());

describe("DreamInboxStore", () => {
  it("upgrades a legacy inbox without usage columns and preserves its rows", () => {
    const db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
    try {
      db.exec(`
        CREATE TABLE dream_inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          source_key TEXT NOT NULL,
          thread_id TEXT,
          run_id TEXT,
          agent_type TEXT,
          title TEXT,
          content TEXT NOT NULL,
          metadata TEXT,
          source_updated_at INTEGER NOT NULL,
          processed_by_dream_at INTEGER,
          UNIQUE (kind, source_key)
        );
        INSERT INTO dream_inbox (
          kind, source_key, thread_id, run_id, agent_type, title,
          content, source_updated_at
        ) VALUES (
          'thread_summary', 'legacy-thread:legacy-run', 'legacy-thread',
          'legacy-run', 'general', 'Legacy work', 'Preserved summary', 1234
        );
      `);

      expect(() => initializeDesktopDatabase(db)).not.toThrow();
      expect(() => initializeDesktopDatabase(db)).not.toThrow();
      const columns = db
        .prepare("PRAGMA table_info(dream_inbox)")
        .all() as Array<{
        name?: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "conversation_id",
          "usage_count",
          "last_usage",
        ]),
      );
      expect(new DreamInboxStore(db).listUnprocessed()).toEqual([
        expect.objectContaining({
          threadId: "legacy-thread",
          runId: "legacy-run",
          content: "Preserved summary",
          usageCount: 0,
          lastUsage: null,
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("promotes only the matching unprocessed thread summary to its reporting conversation", () => {
    const { db, store } = createTestContext();
    store.recordThreadSummary({
      threadId: "thread-promote",
      runId: "run-promote",
      agentType: "general",
      rolloutSummary: "Completed the delegated work",
    });

    expect(
      store.promoteThreadSummaryConversation({
        threadId: "thread-promote",
        conversationId: "conversation-parent",
        rolloutSummary: "Different report",
      }),
    ).toEqual({ updated: 0 });
    expect(
      store.promoteThreadSummaryConversation({
        threadId: "thread-promote",
        conversationId: "conversation-parent",
        rolloutSummary: "Completed the delegated work",
      }),
    ).toEqual({ updated: 1 });
    expect(
      store.promoteThreadSummaryConversation({
        threadId: "thread-promote",
        conversationId: "conversation-other",
        rolloutSummary: "Completed the delegated work",
      }),
    ).toEqual({ updated: 0 });

    expect(
      db
        .prepare(
          "SELECT conversation_id AS conversationId FROM dream_inbox WHERE thread_id = ?",
        )
        .get("thread-promote"),
    ).toEqual({ conversationId: "conversation-parent" });
  });

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
      vi.setSystemTime(1_000);
      store.recordThreadSummary({
        threadId: "thread-other",
        runId: "run-other",
        agentType: "general",
        rolloutSummary: "Other work",
      });
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
    const [first] = store.listUnprocessed();
    store.markProcessed({ ids: [first!.id] });

    const recents = store.listRecentThreadSummaries();
    expect(recents).toHaveLength(1);
    expect(recents[0]?.kind).toBe("thread_summary");
    expect(recents[0]?.threadId).toBe("thread-a");
  });
});
