import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECALL_NO_MATCH_TEXT,
  RecallRetrievalError,
  runRecall,
} from "@stella/runtime/kernel/agent-runtime/context-lookup";
import { completeSimple, readAssistantText } from "@stella/runtime/ai/stream";

vi.mock("@stella/runtime/ai/stream", () => ({
  completeSimple: vi.fn(),
  readAssistantText: vi.fn(() => ""),
}));

const roots: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-recall-unified-"));
  roots.push(root);
  await mkdir(path.join(root, "memories"), { recursive: true });
  return root;
};

type ThreadFixture = {
  conversationId?: string;
  threadId: string;
  name?: string;
  result?: string;
  atMs?: number;
  agentStatus?: string;
};

type TranscriptFixture = {
  conversationId?: string;
  role?: "user" | "assistant";
  text: string;
  atMs?: number;
};

const makeStore = (options?: {
  threads?: ThreadFixture[];
  transcripts?: TranscriptFixture[];
  threadFailure?: Error;
  summaryFailure?: Error;
  summaryMetadataFailure?: Error;
  transcriptFailure?: Error;
  summaries?: Array<Record<string, unknown>>;
  summaryMatches?: Array<Record<string, unknown>>;
}) => {
  const threads = options?.threads ?? [];
  const transcripts = options?.transcripts ?? [];
  return {
    searchThreads: vi.fn(() => {
      if (options?.threadFailure) throw options.threadFailure;
      return threads.map((thread) => ({
        conversationId: thread.conversationId ?? "conv-old",
        threadId: thread.threadId,
        name: thread.name ?? "Historical delegated work",
        agentType: "General",
        status: "active",
        createdAt: thread.atMs ?? Date.parse("2026-02-10T10:00:00Z"),
        lastUsedAt: thread.atMs ?? Date.parse("2026-02-10T10:00:00Z"),
        ...(thread.agentStatus
          ? { agentStatus: thread.agentStatus as never }
          : {}),
      }));
    }),
    listAgentAssistantMessages: vi.fn(() => []),
    listThreadResultExcerpts: vi.fn(
      () =>
        new Map(
          threads.flatMap((thread) =>
            thread.result
              ? [[thread.threadId, { resultExcerpt: thread.result }] as const]
              : [],
          ),
        ),
    ),
    searchTranscripts: vi.fn(() => {
      if (options?.transcriptFailure) throw options.transcriptFailure;
      return transcripts.map((hit, index) => ({
        id: `message-${index}`,
        conversationId: hit.conversationId ?? "conv-old",
        role: hit.role ?? "user",
        text: hit.text,
        atMs: hit.atMs ?? Date.parse("2026-02-10T10:00:00Z"),
      }));
    }),
    listTranscriptNeighbors: vi.fn(() => []),
    threadSummaryStore: {
      searchThreadSummaries: vi.fn(() => {
        if (options?.summaryFailure) throw options.summaryFailure;
        return options?.summaryMatches ?? [];
      }),
      findThreadSummariesByThreadIds: vi.fn(() => {
        if (options?.summaryMetadataFailure) {
          throw options.summaryMetadataFailure;
        }
        return options?.summaries ?? [];
      }),
    },
  };
};

const healthyFts = {
  getFtsHealth: vi.fn(() => ({
    healthy: true,
    transcriptReady: true,
    threadsReady: true,
  })),
  listTranscriptNeighborsBatch: vi.fn(() => []),
};

const recallRoute = {
  activeEngine: "default" as const,
  executionEngine: "native" as const,
  modelId: "openai/gpt-5.2-mini",
  resolvedLlm: {
    provider: "openai" as const,
    model: { id: "openai/gpt-5.2-mini" },
    getApiKey: async () => "test-key",
  },
};

const recallArgs = async (
  root: string,
  store: ReturnType<typeof makeStore>,
  prompt: string,
  terms: string[],
) => ({
  conversationId: "conv-current",
  lookupPrompt: prompt,
  memorySearchTerms: terms,
  stellaAppDir: root,
  stellaDataDir: root,
  store: store as never,
  localEvents: [],
  resolveRecallRoute: async () => recallRoute as never,
  recallReadQueries: healthyFts,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(completeSimple).mockResolvedValue({ stopReason: "stop" } as never);
  vi.mocked(readAssistantText).mockReturnValue("");
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("unified Recall retrieval", () => {
  it.each([
    "What repo path did we decide for Stella?",
    "When did I first drive the blue Lotus?",
    "Is the browser cleanup agent still running?",
    'Find the exact phrase "opal protocol".',
  ])("searches threads and transcripts for every query: %s", async (prompt) => {
    const root = await createRoot();
    const store = makeStore();
    const args = await recallArgs(root, store, prompt, ["opal", "protocol"]);
    const resolveRecallRoute = vi.fn(args.resolveRecallRoute);

    await expect(runRecall({ ...args, resolveRecallRoute })).resolves.toBe(
      RECALL_NO_MATCH_TEXT,
    );

    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(
      store.threadSummaryStore.searchThreadSummaries,
    ).toHaveBeenCalledTimes(1);
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
    expect(resolveRecallRoute).not.toHaveBeenCalled();
  });

  it("still searches every corpus when the optional FTS health check fails", async () => {
    const root = await createRoot();
    const store = makeStore();
    const args = await recallArgs(root, store, "Find Quartz", ["Quartz"]);

    await expect(
      runRecall({
        ...args,
        recallReadQueries: {
          ...healthyFts,
          getFtsHealth: vi.fn(() => {
            throw new Error("health probe unavailable");
          }),
        },
      }),
    ).resolves.toBe(RECALL_NO_MATCH_TEXT);

    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(
      store.threadSummaryStore.searchThreadSummaries,
    ).toHaveBeenCalledTimes(1);
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("treats unhealthy optional FTS telemetry as diagnostic only", async () => {
    const root = await createRoot();
    const store = makeStore({
      threads: [
        {
          threadId: "quartz-result",
          result: "Quartz exact error E_QUARTZ_14 was resolved.",
        },
      ],
      transcripts: [
        { text: "Transcript confirms Quartz exact error E_QUARTZ_14." },
      ],
    });
    const args = await recallArgs(root, store, "Find E_QUARTZ_14", [
      "E_QUARTZ_14",
    ]);

    const brief = await runRecall({
      ...args,
      recallReadQueries: {
        ...healthyFts,
        getFtsHealth: vi.fn(() => ({
          healthy: false,
          transcriptReady: false,
          threadsReady: false,
          reason: "telemetry snapshot is stale",
        })),
      },
    });

    expect(brief).toContain("Quartz exact error E_QUARTZ_14 was resolved");
    expect(brief).toContain(
      "Transcript confirms Quartz exact error E_QUARTZ_14",
    );
    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("ranks source type instead of using it as a query gate", async () => {
    const root = await createRoot();
    const atMs = Date.parse("2026-02-10T10:00:00Z");
    const store = makeStore({
      threads: [
        {
          threadId: "zephyr-implementation",
          result: "Project Zephyr approved telemetry.",
          atMs,
        },
      ],
      transcripts: [{ text: "Project Zephyr rejected telemetry.", atMs }],
    });

    const brief = await runRecall(
      await recallArgs(root, store, 'Find "Project Zephyr" telemetry', [
        "Project Zephyr",
        "telemetry",
      ]),
    );

    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
    expect(brief).toContain("Project Zephyr approved telemetry");
    expect(brief).toContain("Project Zephyr rejected telemetry");
    expect(brief.indexOf("zephyr-implementation")).toBeGreaterThan(
      brief.indexOf("Project Zephyr rejected telemetry"),
    );
  });

  it("deduplicates overlapping evidence across corpora", async () => {
    const root = await createRoot();
    const duplicate = "Project Opal shipped the parser fix.";
    const summary = {
      id: 17,
      sourceKey: "thread-opal:run-opal",
      threadId: "thread-opal",
      runId: "run-opal",
      agentType: "General",
      content: duplicate,
      sourceUpdatedAt: Date.parse("2026-02-10T10:00:00Z"),
    };
    const store = makeStore({
      threads: [{ threadId: "opal-parser", result: duplicate }],
      transcripts: [{ text: duplicate }],
      summaries: [summary],
      summaryMatches: [summary],
    });
    let metadata:
      | { sources: Array<Record<string, unknown>>; fastPath: boolean }
      | undefined;

    const brief = await runRecall({
      ...(await recallArgs(
        root,
        store,
        'Find "Project Opal shipped the parser fix".',
        ["Project Opal", "parser fix"],
      )),
      onResultMetadata: (value) => {
        metadata = value;
      },
    });

    expect(brief.match(/Project Opal shipped the parser fix\./g)).toHaveLength(
      1,
    );
    expect(brief).toContain("See original transcript above");
    expect(metadata?.sources).toContainEqual({ kind: "transcript" });
    expect(metadata?.sources).toContainEqual({
      kind: "thread",
      summaryId: 17,
      threadId: "thread-opal",
      runId: "run-opal",
    });
  });

  it("preserves resumable thread and run ids in result metadata", async () => {
    const root = await createRoot();
    const store = makeStore({
      threads: [
        {
          threadId: "thread-resume-42",
          result: "Resolved exact error E_ZEPHYR_42.",
          agentStatus: "completed",
        },
      ],
      summaries: [
        {
          id: 7,
          threadId: "thread-resume-42",
          runId: "run-resume-99",
        },
      ],
    });
    let metadata:
      | { sources: Array<Record<string, unknown>>; fastPath: boolean }
      | undefined;

    const brief = await runRecall({
      ...(await recallArgs(
        root,
        store,
        'Resume exact thread "thread-resume-42"',
        ["thread-resume-42"],
      )),
      onResultMetadata: (value) => {
        metadata = value;
      },
    });

    expect(brief).toContain("thread-resume-42");
    expect(brief).toContain("paused");
    expect(metadata?.sources).toContainEqual({
      kind: "thread",
      summaryId: 7,
      threadId: "thread-resume-42",
      runId: "run-resume-99",
    });
  });

  it("retrieves neutral durable thread summaries alongside results and transcripts", async () => {
    const root = await createRoot();
    const summary = {
      id: 11,
      sourceKey: "thread-cobalt:run-cobalt",
      threadId: "thread-cobalt",
      runId: "run-cobalt",
      agentType: "General",
      content: "Cobalt migration resolved exact error E_COBALT_31.",
      sourceUpdatedAt: Date.parse("2026-02-11T12:00:00Z"),
    };
    const store = makeStore({
      summaries: [summary],
      summaryMatches: [summary],
    });

    const brief = await runRecall(
      await recallArgs(root, store, "Find E_COBALT_31", ["E_COBALT_31"]),
    );

    expect(brief).toContain(
      "Cobalt migration resolved exact error E_COBALT_31",
    );
    expect(brief).toContain("thread-cobalt");
    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(store.threadSummaryStore.searchThreadSummaries).toHaveBeenCalledWith(
      ["E_COBALT_31"],
      { limit: 16 },
    );
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("returns valid transcript evidence when thread retrieval fails", async () => {
    const root = await createRoot();
    const store = makeStore({
      threadFailure: new Error("thread index offline"),
      transcripts: [{ text: "Blue Lotus error E_LOTUS_77 was resolved." }],
    });

    const brief = await runRecall(
      await recallArgs(root, store, "Find E_LOTUS_77", ["E_LOTUS_77"]),
    );

    expect(brief).toContain("Partial source failure");
    expect(brief).toContain("thread index offline");
    expect(brief).toContain("Blue Lotus error E_LOTUS_77 was resolved");
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("returns valid thread evidence when transcript retrieval fails", async () => {
    const root = await createRoot();
    const store = makeStore({
      transcriptFailure: new Error("transcript index offline"),
      threads: [
        {
          threadId: "lotus-repair",
          result: "Blue Lotus error E_LOTUS_88 was resolved.",
        },
      ],
    });

    const brief = await runRecall(
      await recallArgs(root, store, "Find E_LOTUS_88", ["E_LOTUS_88"]),
    );

    expect(brief).toContain("Partial source failure");
    expect(brief).toContain("transcript index offline");
    expect(brief).toContain("lotus-repair");
    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("returns valid transcript evidence when durable-summary retrieval fails", async () => {
    const root = await createRoot();
    const store = makeStore({
      summaryFailure: new Error("durable summary index offline"),
      summaryMetadataFailure: new Error("durable summary metadata offline"),
      threads: [
        {
          threadId: "lotus-repair-89",
          result: "Delegated work also resolved Blue Lotus error E_LOTUS_89.",
        },
      ],
      transcripts: [
        { text: "Blue Lotus error E_LOTUS_89 was resolved in conversation." },
      ],
    });

    const brief = await runRecall(
      await recallArgs(root, store, "Find E_LOTUS_89", ["E_LOTUS_89"]),
    );

    expect(brief).toContain("Partial source failure");
    expect(brief).toContain("durable summary index offline");
    expect(brief).toContain("lotus-repair-89");
    expect(brief).toContain("E_LOTUS_89 was resolved in conversation");
    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("reports retrieval failure only when failed corpora leave no valid evidence", async () => {
    const root = await createRoot();
    const store = makeStore({
      threadFailure: new Error("thread index offline"),
      transcriptFailure: new Error("transcript index offline"),
    });

    await expect(
      runRecall(await recallArgs(root, store, "Find Zephyr", ["Zephyr"])),
    ).rejects.toThrow(RecallRetrievalError);
    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("does not search background profile or memory documents already in context", async () => {
    const root = await createRoot();
    await Promise.all([
      writeFile(
        path.join(root, "memories", "profile.md"),
        "# Memory map\n- MAP_ONLY_SENTINEL should never be recalled",
      ),
      writeFile(
        path.join(root, "core-memory.md"),
        "# MEMORY\n- LEDGER_ONLY_SENTINEL should never be recalled",
      ),
    ]);
    const store = makeStore();

    const brief = await runRecall(
      await recallArgs(
        root,
        store,
        "Find MAP_ONLY_SENTINEL and LEDGER_ONLY_SENTINEL",
        ["MAP_ONLY_SENTINEL", "LEDGER_ONLY_SENTINEL"],
      ),
    );

    expect(brief).toBe(RECALL_NO_MATCH_TEXT);
    expect(brief).not.toContain("MAP_ONLY_SENTINEL should never be recalled");
    expect(brief).not.toContain(
      "LEDGER_ONLY_SENTINEL should never be recalled",
    );
    expect(store.searchThreads).toHaveBeenCalledTimes(1);
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });
});

it("reads references directly and classifies failed reads as retrieval errors", async () => {
  const root = await createRoot();
  const ref = "recall:conv-old:message-0:1500";
  const store = makeStore({
    transcripts: [{ text: "a".repeat(1500) + "continued original" }],
  });
  const brief = await runRecall(
    await recallArgs(root, store, "Read more", [ref]),
  );
  expect(brief).toContain("continued original");
  expect(brief).not.toContain("a".repeat(100));
  expect(store.searchThreads).not.toHaveBeenCalled();
  expect(store.searchTranscripts).toHaveBeenCalledWith({
    query: ref,
    terms: [ref],
    limit: 1,
  });
  const broken = makeStore({
    transcriptFailure: new Error("database offline"),
  });
  await expect(
    runRecall(await recallArgs(root, broken, "Read more", [ref])),
  ).rejects.toBeInstanceOf(RecallRetrievalError);
});
