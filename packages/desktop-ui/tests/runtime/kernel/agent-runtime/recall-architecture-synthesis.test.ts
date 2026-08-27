import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  readAssistantText: vi.fn(
    () => "Synthesized: you first drove the blue Lotus on 2026-03-02.",
  ),
}));

vi.mock("@stella/runtime/ai/stream", () => ({
  completeSimple: streamMock.completeSimple,
  readAssistantText: streamMock.readAssistantText,
}));

import { runRecall } from "@stella/runtime/kernel/agent-runtime/context-lookup";

const roots = new Set<string>();
const createRoot = async (): Promise<string> => {
  const root = path.join(
    os.tmpdir(),
    `stella-recall-synth-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  streamMock.completeSimple.mockReset();
  streamMock.readAssistantText.mockReset();
  streamMock.readAssistantText.mockReturnValue(
    "Synthesized: you first drove the blue Lotus on 2026-03-02.",
  );
});

const makeStore = (transcripts: unknown[]) =>
  ({
    searchThreads: vi.fn(() => []),
    searchTranscripts: vi.fn(() => transcripts),
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

const credentiallessRoute = () =>
  ({
    activeEngine: "default" as const,
    executionEngine: "native" as const,
    modelId: "local/llama",
    resolvedLlm: {
      route: "direct-provider",

      credentialless: true,
      model: {
        id: "llama",
        name: "llama",
        api: "openai-completions",
        provider: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      getApiKey: async () => undefined,
    },
  }) as never;

describe("architectural Recall synthesis returns a model brief", () => {
  it("reaches the model on a credentialless local route and returns the synthesized brief", async () => {
    const root = await createRoot();
    streamMock.completeSimple.mockResolvedValue({ stopReason: "stop" });

    const transcripts = [
      {
        conversationId: "conv-1",
        role: "user" as const,
        atMs: Date.parse("2026-03-02T09:00:00Z"),
        text: "I first drove the blue Lotus today, 2026-03-02, around the coast road.",
      },
    ];

    const brief = await runRecall({
      conversationId: "conv-1",

      lookupPrompt: "When did I first drive the blue Lotus?",
      memorySearchTerms: ["blue Lotus", "first drove"],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore(transcripts),
      localEvents: [],
      resolveRecallRoute: async () => credentiallessRoute(),
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
    });

    expect(brief).toContain("blue Lotus");
    expect(streamMock.completeSimple).toHaveBeenCalledTimes(1);

    const options = streamMock.completeSimple.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(options.apiKey).toBeUndefined();
    expect(options.reasoning).toBeUndefined();
    expect(options.temperature).toBeUndefined();
    expect(options.maxTokens).toBeUndefined();

    expect(options.omitMaxTokens).toBe(true);
  });

  it("sends LOW reasoning and the key for a keyed model that supports effort", async () => {
    const root = await createRoot();
    streamMock.completeSimple.mockResolvedValue({ stopReason: "stop" });

    const keyedRoute = () =>
      ({
        activeEngine: "default" as const,
        executionEngine: "native" as const,
        modelId: "openrouter/x-ai/grok",
        resolvedLlm: {
          route: "direct-provider",
          model: {
            id: "x-ai/grok",
            name: "grok",
            api: "openai-completions",
            provider: "openrouter",
            baseUrl: "https://openrouter.example.test",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
          getApiKey: async () => "sk-or-key",
        },
      }) as never;

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "When did I first drive the blue Lotus?",
      memorySearchTerms: ["blue Lotus", "first drove"],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore([
        {
          conversationId: "conv-1",
          role: "user" as const,
          atMs: Date.parse("2026-03-02T09:00:00Z"),
          text: "I first drove the blue Lotus today, 2026-03-02, around the coast road.",
        },
      ]),
      localEvents: [],
      resolveRecallRoute: async () => keyedRoute(),
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
    });

    expect(brief).toContain("blue Lotus");
    const options = streamMock.completeSimple.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(options.apiKey).toBe("sk-or-key");
    expect(options.reasoning).toBe("low");
  });
});
