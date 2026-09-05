// End-to-end proof that the architectural Recall pipeline actually RETURNS a
// synthesized brief through the resolved model — and that a route which
// explicitly declares itself credentialless (local model, no API key) reaches
// the model instead of failing with "No API key for provider: …".

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

const makeStore = (transcripts: Record<string, unknown>[]) =>
  ({
    searchThreads: vi.fn(() => []),
    searchTranscripts: vi.fn(() =>
      transcripts.map((hit, index) => ({ ...hit, id: `message-${index}` })),
    ),
    listTranscriptNeighbors: vi.fn(() => []),
    listAgentAssistantMessages: vi.fn(() => []),
    listThreadResultExcerpts: vi.fn(() => new Map()),
    threadSummaryStore: {
      searchThreadSummaries: vi.fn(() => []),
      findThreadSummariesByThreadIds: vi.fn(() => []),
    },
  }) as never;

const credentiallessRoute = () =>
  ({
    activeEngine: "default" as const,
    executionEngine: "native" as const,
    modelId: "local/llama",
    resolvedLlm: {
      route: "direct-provider",
      // Only the local/ provider is constructed credentialless in production.
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

describe("Recall preserves original transcript evidence", () => {
  it("returns original exchanges without requiring a credentialless model", async () => {
    const root = await createRoot();
    streamMock.completeSimple.mockResolvedValue({ stopReason: "stop" });

    const transcripts = [
      {
        conversationId: "conv-1",
        role: "user" as const,
        atMs: Date.parse("2026-03-02T09:00:00Z"),
        text: "I first drove the blue Lotus today, 2026-03-02, around the coast road.",
      },
      {
        conversationId: "conv-1",
        role: "assistant" as const,
        atMs: Date.parse("2026-02-01T09:00:00Z"),
        text: "The blue Lotus tire-pressure note is unrelated.",
      },
    ];

    const brief = await runRecall({
      conversationId: "conv-1",
      // Episodic (deterministicFastPath: false) — genuine synthesis question.
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
    expect(brief).toContain("messageRef=recall:");
    expect(streamMock.completeSimple).not.toHaveBeenCalled();
  });

  it("does not rewrite transcript results through a keyed model", async () => {
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
        {
          conversationId: "conv-1",
          role: "assistant" as const,
          atMs: Date.parse("2026-02-01T09:00:00Z"),
          text: "The blue Lotus tire-pressure note is unrelated.",
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
    expect(brief).toContain("messageRef=recall:");
    expect(streamMock.completeSimple).not.toHaveBeenCalled();
  });
});
