import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyRecallIntent,
  isRecallNoMatchBrief,
  RecallRetrievalError,
  routeRecallIntent,
  runRecall,
} from "@stella/runtime/kernel/agent-runtime/context-lookup";
import { MEMORY_INDEX_MAX_CHARS } from "@stella/runtime/kernel/memory/dream-storage";
import { readMemorySummaryDoc } from "@stella/runtime/kernel/runner/shared";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import {
  listTranscriptNeighborsBatch,
  readRecallFtsHealth,
} from "@stella/runtime/kernel/storage/recall-read-queries";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

const roots = new Set<string>();

const createRoot = async (): Promise<string> => {
  const root = path.join(
    os.tmpdir(),
    `stella-recall-architecture-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.add(root);
  await mkdir(path.join(root, "memories"), { recursive: true });
  return root;
};

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const makeStore = () =>
  ({
    searchThreads: vi.fn(() => []),
    searchTranscripts: vi.fn(() => []),
    listTranscriptNeighbors: vi.fn(() => []),
    listThreadsForRecallIndex: vi.fn(() => []),
    listAgentAssistantMessages: vi.fn(() => []),
    listThreadResultExcerpts: vi.fn(() => new Map()),
    dreamInboxStore: {
      listRecentThreadSummaries: vi.fn(() => []),
      findThreadSummariesByThreadIds: vi.fn(() => []),
      recordUsage: vi.fn(),
    },
  }) as never;

describe("architectural Recall pipeline", () => {
  it.each([
    { chars: 6_000, truncated: false },
    { chars: 6_001, truncated: true },
  ])(
    "deterministically caps a $chars-character resident routing index at injection",
    async ({ chars, truncated }) => {
      const root = await createRoot();
      const sentinel = "TAIL_SENTINEL";
      await writeFile(
        path.join(root, "memories", "memory_index.md"),
        `${"x".repeat(chars - sentinel.length)}${sentinel}`,
      );

      const resident = readMemorySummaryDoc(root) ?? "";
      expect(resident).toHaveLength(MEMORY_INDEX_MAX_CHARS);
      expect(resident.includes("resident memory truncated")).toBe(truncated);
      expect(resident.includes(sentinel)).toBe(!truncated);
    },
  );

  it("routes common facts to memory and returns matched lines with zero model calls", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_index.md"),
      [
        "# Memory routing index",
        "- Stella repo path: /Users/rahulnanda/projects/stella",
        "  hooks: stella repo, dev checkout, v1",
      ].join("\n"),
    );
    const getFtsHealth = vi.fn(() => ({
      healthy: true,
      transcriptReady: true,
      threadsReady: true,
    }));
    const records: Array<{ modelCalls: number; fastPath?: boolean }> = [];
    let metadata: { intent: string; fastPath: boolean } | undefined;

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "What repo path did we decide for Stella?",
      memorySearchTerms: ["Stella repo", "/Users/rahulnanda/projects/stella"],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore(),
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth,
        listTranscriptNeighborsBatch: vi.fn(() => []),
      },
      onTelemetry: (record) => records.push(record),
      onResultMetadata: (value) => {
        metadata = value;
      },
    });

    expect(brief).toContain("/Users/rahulnanda/projects/stella");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ modelCalls: 0, fastPath: true });
    expect(metadata).toMatchObject({
      intent: "durable_memory",
      fastPath: true,
    });
    expect(getFtsHealth).not.toHaveBeenCalled();
  });

  it("uses delimiter-safe repository anchors and preserves bare stella", async () => {
    const falseRoot = await createRoot();
    await writeFile(
      path.join(falseRoot, "memories", "memory_index.md"),
      "# Memory routing index\n- stella-v20 repo path: /tmp/stella-v20",
    );
    const makeArgs = (root: string, prompt: string, term: string) => ({
      conversationId: "conv-1",
      lookupPrompt: prompt,
      memorySearchTerms: [term],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore(),
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
    });

    await expect(
      runRecall(makeArgs(falseRoot, "stella-v2", "stella-v2")),
    ).resolves.toBe("Nothing relevant found.");
    await expect(
      runRecall(
        makeArgs(falseRoot, 'Find exact phrase "stella-v2".', "stella-v2"),
      ),
    ).resolves.toBe("Nothing relevant found.");

    for (const adjacentEvidence of [
      "𐐀stella-v2",
      "stella-v2𐐀",
      "Astella-v2",
      "stella-v2Z",
    ]) {
      const adjacentRoot = await createRoot();
      await writeFile(
        path.join(adjacentRoot, "memories", "memory_index.md"),
        `# Memory routing index\n- ${adjacentEvidence} repo path: /tmp/rejected`,
      );
      await expect(
        runRecall(makeArgs(adjacentRoot, "stella-v2", "stella-v2")),
      ).resolves.toBe("Nothing relevant found.");
    }

    const trueRoot = await createRoot();
    await writeFile(
      path.join(trueRoot, "memories", "memory_index.md"),
      "# Memory routing index\n- stella repo path: /Users/rahulnanda/projects/stella",
    );
    await expect(
      runRecall(makeArgs(trueRoot, "stella", "stella")),
    ).resolves.toContain("stella repo path");
  });

  // The redaction regression case ("redacts street addresses and user-home
  // path prefixes") arrives in Phase 7 with recall-benchmark-redaction.ts.

  it("fails loudly before thread search when FTS is degraded", async () => {
    const root = await createRoot();
    const store = makeStore() as any;

    await expect(
      runRecall({
        conversationId: "conv-1",
        lookupPrompt: "Find the prior agent thread for browser cleanup",
        memorySearchTerms: ["browser", "cleanup"],
        stellaAppDir: root,
        stellaDataDir: root,
        store,
        localEvents: [],
        recallRoute: {
          activeEngine: "claude_code_local",
          executionEngine: "claude-code",
          modelId: "claude-code/haiku",
          claudeCodeModel: "haiku",
        },
        recallReadQueries: {
          getFtsHealth: () => ({
            healthy: false,
            transcriptReady: true,
            threadsReady: false,
            reason: "thread FTS missing or not backfilled",
          }),
          listTranscriptNeighborsBatch: () => [],
        },
      }),
    ).rejects.toBeInstanceOf(RecallRetrievalError);
    expect(store.searchThreads).not.toHaveBeenCalled();
  });

  it("does not turn a generic one-token fallback hit into a false match", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_index.md"),
      "# Memory routing index\n- unrelated work",
    );
    const store = makeStore() as any;
    store.searchTranscripts.mockReturnValue([
      {
        conversationId: "other",
        role: "user",
        atMs: 100,
        text: "A different project shipped successfully.",
      },
    ]);
    const records: Array<{ modelCalls: number; outcome: string }> = [];

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt:
        "Find the decision where Project Zephyr approved aquarium telemetry from Cassandra to CockroachDB.",
      memorySearchTerms: [
        "Project Zephyr",
        "aquarium telemetry",
        "Cassandra",
        "CockroachDB",
      ],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
      onTelemetry: (record) => records.push(record),
    });

    expect(brief).toBe("Nothing relevant found.");
    expect(records[0]).toMatchObject({ outcome: "no-match", modelCalls: 0 });
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("requires anchors to co-occur inside one memory result", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_index.md"),
      [
        "# Memory routing index",
        "- alpha-anchor belongs to one unrelated entry",
        "  filler one",
        "  filler two",
        "  filler three",
        "  filler four",
        "  filler five",
        "- beta-anchor belongs to another unrelated entry",
      ].join("\n"),
    );
    const store = makeStore() as any;

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "What prior decision joined alpha-anchor and beta-anchor?",
      memorySearchTerms: ["alpha-anchor", "beta-anchor"],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
    });

    expect(brief).toBe("Nothing relevant found.");
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("rejects partial phrase anchors even when generic tokens overlap", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_index.md"),
      [
        "# Memory routing index",
        "- Stella release verification covered a repository change.",
      ].join("\n"),
    );
    const store = makeStore() as any;

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt:
        "What are the established repo-scope and verification rules for Stella release sweeps?",
      memorySearchTerms: [
        "release sweep",
        "repo scope",
        "verification",
        "Stella",
      ],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
    });

    expect(brief).toBe("Nothing relevant found.");
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("returns an exact-phrase result directly and accepts reformulated terms", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_index.md"),
      "# Memory routing index\n- banana protocol belongs to the orchard repo",
    );
    const records: Array<{ modelCalls: number; fastPath?: boolean }> = [];

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "Find exact phrase banana protocol.",
      memorySearchTerms: ["wrong-alpha", "wrong-beta"],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore(),
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
      onTelemetry: (record) => records.push(record),
    });

    expect(brief).toContain("banana protocol");
    expect(records[0]).toMatchObject({
      modelCalls: 0,
      fastPath: true,
      retrievalPasses: 2,
    });
  });

  it("classifies live, delegated, episodic, durable, and ambiguous intents deterministically", () => {
    expect(
      routeRecallIntent("What is on my active browser tab right now?"),
    ).toBe("live_context");
    expect(
      routeRecallIntent("Is the browser cleanup agent still running?"),
    ).toBe("delegated_work");
    expect(routeRecallIntent("When did I first drive the blue Lotus?")).toBe(
      "episodic",
    );
    expect(routeRecallIntent("What repo path did we decide for Stella?")).toBe(
      "durable_memory",
    );
    expect(routeRecallIntent("Tell me what we know about Zephyr")).toBe(
      "multi_source",
    );
    expect(routeRecallIntent("What file defines agent status?")).toBe(
      "multi_source",
    );
    expect(
      routeRecallIntent(
        "What prior decision set low reasoning for Recall and progress summaries?",
      ),
    ).toBe("durable_memory");
    expect(
      routeRecallIntent(
        "What are the prior orchestrator prompt rules for Recall and milestone status?",
      ),
    ).toBe("multi_source");
    expect(
      routeRecallIntent("Find this phrase right now in which old discussion"),
    ).toBe("multi_source");
    expect(routeRecallIntent("stella-v2")).toBe("durable_memory");
    expect(routeRecallIntent("Find exact phrase banana protocol")).toBe(
      "multi_source",
    );
    expect(
      classifyRecallIntent("Find exact phrase banana protocol"),
    ).toMatchObject({ deterministicFastPath: true });
    expect(
      classifyRecallIntent("When did I first drive the blue Lotus?"),
    ).toMatchObject({ deterministicFastPath: false });
    expect(
      classifyRecallIntent("What file defines agent status?"),
    ).toMatchObject({ deterministicFastPath: false });
    expect(
      isRecallNoMatchBrief("  NOTHING RELEVANT FOUND: after two passes"),
    ).toBe(true);
  });

  it("records usage feedback through the REAL store when thread evidence is surfaced", async () => {
    // Regression for the phases-1-3 gate finding: the mocked stores masked
    // that v2's DreamInboxStore lacked findThreadSummariesByThreadIds, so
    // delegated-thread Recall crashed on the real SessionStore. This test
    // runs the whole delegated-work fast path with NO mocks.
    const root = await createRoot();
    const db = new DatabaseSync(getDesktopDatabasePath(root), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    try {
      initializeDesktopDatabase(db);
      const store = new SessionStore(db);
      const thread = store.resolveOrCreateActiveThread({
        conversationId: "conv-real",
        agentType: "general",
        nameHint: "Zanzibar dashboard rebuild",
      });
      store.saveAgentRecord({
        threadId: thread.threadId,
        conversationId: "conv-real",
        agentType: "general",
        description: "Rebuild the zanzibar dashboard",
        agentDepth: 0,
        status: "completed",
        startedAt: Date.now(),
        completedAt: Date.now(),
        result: "Zanzibar dashboard rebuilt and deployed.",
        updatedAt: Date.now(),
      });
      store.dreamInboxStore.recordThreadSummary({
        threadId: thread.threadId,
        runId: "run-real",
        agentType: "general",
        rolloutSummary: "Rebuilt the zanzibar dashboard end to end.",
      });

      const brief = await runRecall({
        conversationId: "conv-real",
        lookupPrompt: "resume the zanzibar dashboard thread",
        memorySearchTerms: ["zanzibar"],
        stellaAppDir: root,
        stellaDataDir: root,
        store,
        localEvents: [],
        recallRoute: {
          activeEngine: "default",
          executionEngine: "native",
          modelId: "test/light",
        } as never,
        recallReadQueries: {
          getFtsHealth: () => readRecallFtsHealth(db),
          listTranscriptNeighborsBatch: (targets, options) =>
            listTranscriptNeighborsBatch(db, targets, options),
        },
      });

      // The delegated-work fast path answers directly from indexed evidence.
      expect(brief).toContain(thread.threadId);
      expect(brief).toContain("Zanzibar dashboard rebuild");
      // Usage feedback landed on the real dream inbox row.
      const [summary] = store.dreamInboxStore.findThreadSummariesByThreadIds([
        thread.threadId,
      ]);
      expect(summary).toMatchObject({
        threadId: thread.threadId,
        runId: "run-real",
        usageCount: 1,
      });
      expect(summary?.lastUsage).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
