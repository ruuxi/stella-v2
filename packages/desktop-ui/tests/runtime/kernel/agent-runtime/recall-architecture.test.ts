import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyRecallIntent,
  isRecallNoMatchBrief,
  RECALL_EMPTY_BRIEF_TEXT,
  RecallRetrievalError,
  routeRecallIntent,
  runRecall,
} from "@stella/runtime/kernel/agent-runtime/context-lookup";
import { completeSimple } from "@stella/runtime/ai/stream";
import { MEMORY_MAP_MAX_CHARS } from "@stella/runtime/kernel/memory/dream-storage";
import { readMemoryMapDoc } from "@stella/runtime/kernel/runner/shared";
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

vi.mock("@stella/runtime/ai/stream", () => ({
  completeSimple: vi.fn(),
  readAssistantText: vi.fn(() => ""),
}));

import { redactBenchmarkBrief } from "@stella/runtime/scripts/recall-benchmark-redaction";

const roots = new Set<string>();
const createRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-recall-arch-"));
  roots.add(root);
  await mkdir(path.join(root, "memories"), { recursive: true });
  return root;
};

const mkdtemp = async (prefix: string) => {
  const root = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(prefix),
  );
  return root;
};

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
  vi.mocked(completeSimple).mockReset();
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

const lightRoute = {
  activeEngine: "default",
  executionEngine: "native",
  modelId: "test/light",
  resolvedLlm: {
    route: "direct-provider",
    model: { id: "light", provider: "test" },
    getApiKey: async () => "test-key",
  },
} as never;

const healthyFts = {
  getFtsHealth: () => ({
    healthy: true,
    transcriptReady: true,
    threadsReady: true,
  }),
  listTranscriptNeighborsBatch: () => [],
};

describe("architectural Recall pipeline", () => {
  it.each([
    { chars: 6_000, truncated: false },
    { chars: 6_001, truncated: true },
  ])(
    "deterministically caps a $chars-character resident memory map at injection",
    async ({ chars, truncated }) => {
      const root = await createRoot();
      const sentinel = "TAIL_SENTINEL";
      await writeFile(
        path.join(root, "memories", "memory_map.md"),
        `${"x".repeat(chars - sentinel.length)}${sentinel}`,
      );

      const resident = readMemoryMapDoc(root) ?? "";
      expect(resident).toHaveLength(MEMORY_MAP_MAX_CHARS);
      expect(resident.includes("resident memory truncated")).toBe(truncated);
      expect(resident.includes(sentinel)).toBe(!truncated);
    },
  );

  it("routes common facts to memory and returns matched lines with zero model calls", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      [
        "# Memory map",
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
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: {
        getFtsHealth,
        listTranscriptNeighborsBatch: vi.fn(() => []),
      },
      onTelemetry: (record) => records.push(record),
      onResultMetadata: (value) => {
        metadata = value;
      },
    });

    expect(brief).toContain("Stella repo path");
    expect(records[0]).toMatchObject({
      modelCalls: 0,
      fastPath: true,
      intent: "durable_memory",
    });
    expect(getFtsHealth).not.toHaveBeenCalled();
    expect(metadata?.fastPath).toBe(true);
  });

  it("answers a fast indexed lookup without ever resolving a model route", async () => {
    const root = await createRoot();
    const store = makeStore() as any;
    store.searchThreads.mockReturnValue([
      {
        threadId: "zanzibar-dashboard-rebuild",
        name: "Zanzibar dashboard rebuild",
        lastActiveAt: Date.parse("2026-02-10T10:00:00Z"),
        resultExcerpt: "Rebuilt the zanzibar dashboard end to end.",
      },
    ]);
    let routeResolved = false;
    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "resume the zanzibar dashboard thread",
      memorySearchTerms: ["zanzibar"],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      resolveRecallRoute: async () => {
        routeResolved = true;
        return lightRoute;
      },
      recallReadQueries: healthyFts,
    });

    expect(brief).toContain("zanzibar-dashboard-rebuild");
    expect(routeResolved).toBe(false);
  });

  it("uses delimiter-safe repository anchors and preserves bare stella", async () => {
    const falseRoot = await createRoot();
    await writeFile(
      path.join(falseRoot, "memories", "memory_map.md"),
      "# Memory map\n- stella-v20 repo path: /tmp/stella-v20",
    );
    const makeArgs = (root: string, prompt: string, term: string) => ({
      conversationId: "conv-1",
      lookupPrompt: prompt,
      memorySearchTerms: [term],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore(),
      localEvents: [],
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: healthyFts,
    });

    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: "stop",
    } as never);
    await expect(
      runRecall(makeArgs(falseRoot, "stella-v2", "stella-v2")),
    ).resolves.toBe(RECALL_EMPTY_BRIEF_TEXT);
    await expect(
      runRecall(
        makeArgs(falseRoot, 'Find exact phrase "stella-v2".', "stella-v2"),
      ),
    ).resolves.toBe(RECALL_EMPTY_BRIEF_TEXT);

    for (const adjacentEvidence of [
      "𐐀stella-v2",
      "stella-v2𐐀",
      "Astella-v2",
      "stella-v2Z",
    ]) {
      const adjacentRoot = await createRoot();
      await writeFile(
        path.join(adjacentRoot, "memories", "memory_map.md"),
        `# Memory map\n- ${adjacentEvidence} repo path: /tmp/rejected`,
      );
      await expect(
        runRecall(makeArgs(adjacentRoot, "stella-v2", "stella-v2")),
      ).resolves.toBe(RECALL_EMPTY_BRIEF_TEXT);
    }

    const trueRoot = await createRoot();
    await writeFile(
      path.join(trueRoot, "memories", "memory_map.md"),
      "# Memory map\n- stella repo path: /Users/rahulnanda/projects/stella",
    );
    await expect(
      runRecall(makeArgs(trueRoot, "stella", "stella")),
    ).resolves.toContain("stella repo path");
  });

  it("redacts street addresses and user-home path prefixes", () => {
    expect(redactBenchmarkBrief("123 Main St, Springfield 555-0100")).toContain(
      "[REDACTED POSTAL ADDRESS]",
    );
    expect(redactBenchmarkBrief("/Users/rahulnanda/secrets/token")).toBe(
      "[REDACTED HOME]/secrets/token",
    );
  });

  it("fails loudly before thread search when FTS is degraded", async () => {
    const root = await createRoot();
    const store = makeStore() as any;
    const getFtsHealth = vi.fn(() => ({
      healthy: false,
      transcriptReady: true,
      threadsReady: false,
      reason: "thread FTS missing or not backfilled",
    }));

    await expect(
      runRecall({
        conversationId: "conv-1",
        lookupPrompt: "resume the zanzibar dashboard thread",
        memorySearchTerms: ["zanzibar"],
        stellaAppDir: root,
        stellaDataDir: root,
        store,
        localEvents: [],
        resolveRecallRoute: async () => lightRoute,
        recallReadQueries: {
          getFtsHealth,
          listTranscriptNeighborsBatch: vi.fn(() => []),
        },
      }),
    ).rejects.toThrow(RecallRetrievalError);
    expect(store.searchThreads).not.toHaveBeenCalled();
  });

  it("does not turn a generic one-token fallback hit into a false match", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      "# Memory map\n- unrelated work",
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
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: "stop",
    } as never);

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
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: healthyFts,
      onTelemetry: (record) => records.push(record),
    });

    expect(brief).toBe(RECALL_EMPTY_BRIEF_TEXT);
    expect(records[0]).toMatchObject({ outcome: "empty-brief" });
  });

  it("requires anchors to co-occur inside one memory result", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      [
        "# Memory map",
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
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: "stop",
    } as never);

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "What prior decision joined alpha-anchor and beta-anchor?",
      memorySearchTerms: ["alpha-anchor", "beta-anchor"],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: healthyFts,
    });

    expect(brief).toBe(RECALL_EMPTY_BRIEF_TEXT);
  });

  it("rejects partial phrase anchors even when generic tokens overlap", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      [
        "# Memory map",
        "- Stella release verification covered a repository change.",
      ].join("\n"),
    );
    const store = makeStore() as any;
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: "stop",
    } as never);

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
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: healthyFts,
    });

    expect(brief).toBe(RECALL_EMPTY_BRIEF_TEXT);
  });

  it("returns an exact-phrase result directly and accepts reformulated terms", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      "# Memory map\n- banana protocol belongs to the orchard repo",
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
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: healthyFts,
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
        resolveRecallRoute: async () => lightRoute,
        recallReadQueries: {
          getFtsHealth: () => readRecallFtsHealth(db),
          listTranscriptNeighborsBatch: (targets, options) =>
            listTranscriptNeighborsBatch(db, targets, options),
        },
      });

      expect(brief).toContain(thread.threadId);
      expect(brief).toContain("Zanzibar dashboard rebuild");

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

  it("escalates a durable-classified miss through the full sweep and synthesis", async () => {

    const root = await createRoot();
    const store = makeStore() as any;
    store.searchThreads.mockReturnValue([
      {
        threadId: "pangram-detector-v1",
        name: "Pangram image detection model",
        lastActiveAt: Date.parse("2026-02-10T10:00:00Z"),
      },
    ]);
    const records: Array<{ modelCalls: number; outcome: string }> = [];
    let metadata: { fastPath: boolean } | undefined;
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: "stop",
    } as never);

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt:
        "What repo path did we decide for the pangram image detection model?",
      memorySearchTerms: ["pangram", "image detection model"],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: healthyFts,
      onTelemetry: (record) => records.push(record),
      onResultMetadata: (value) => {
        metadata = value;
      },
    });

    expect(brief).toContain("pangram-detector-v1");
    expect(brief).toContain("Pangram image detection model");
    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ modelCalls: 0, fastPath: true });

    expect(metadata?.fastPath).toBe(true);
  });

  it("runs the one synthesis pass even when the entire indexed sweep is empty", async () => {
    const root = await createRoot();
    const store = makeStore() as any;
    const records: Array<{ modelCalls: number; outcome: string }> = [];
    let metadata: { fastPath: boolean } | undefined;
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: "stop",
    } as never);

    await runRecall({
      conversationId: "conv-1",
      lookupPrompt:
        "Find the decision where Project Zephyr approved aquarium telemetry.",
      memorySearchTerms: ["Project Zephyr", "aquarium telemetry"],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: healthyFts,
      onTelemetry: (record) => records.push(record),
      onResultMetadata: (value) => {
        metadata = value;
      },
    });

    expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ modelCalls: 1 });
    expect(metadata?.fastPath).toBe(false);
  });

  it("answers a non-episodic cascade hit directly without any model call", async () => {
    const root = await createRoot();
    const store = makeStore() as any;
    store.searchThreads.mockReturnValue([
      {
        threadId: "zanzibar-dashboard-rebuild",
        name: "Zanzibar dashboard rebuild",
        lastActiveAt: Date.parse("2026-02-10T10:00:00Z"),
      },
    ]);
    const records: Array<{ modelCalls: number; outcome: string }> = [];
    let metadata: { fastPath: boolean } | undefined;

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt:
        "What repo path did we decide for the zanzibar dashboard rebuild?",
      memorySearchTerms: ["zanzibar", "dashboard rebuild"],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      resolveRecallRoute: async () => lightRoute,
      recallReadQueries: healthyFts,
      onTelemetry: (record) => records.push(record),
      onResultMetadata: (value) => {
        metadata = value;
      },
    });

    expect(brief).toContain("zanzibar-dashboard-rebuild");
    expect(records[0]).toMatchObject({ modelCalls: 0, fastPath: true });
    expect(metadata?.fastPath).toBe(true);
  });
});
