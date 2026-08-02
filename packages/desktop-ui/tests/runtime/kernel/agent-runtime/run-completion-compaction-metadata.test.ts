import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerApiProvider } from "@stella/runtime/ai/api-registry";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
} from "@stella/runtime/ai/types";

const { compactRuntimeThreadHistoryMock } = vi.hoisted(() => ({
  compactRuntimeThreadHistoryMock: vi.fn(),
}));

vi.mock("@stella/runtime/kernel/agent-runtime/thread-memory", () => ({
  compactRuntimeThreadHistory: (...args: unknown[]) =>
    compactRuntimeThreadHistoryMock(...args),
  updateOrchestratorReminderState: vi.fn(),
}));

import { runCompactionWithHooks } from "@stella/runtime/kernel/agent-runtime/run-completion";
// Warm the module graph behind run-completion's dynamic
// `import("./dream-scheduler.js")` so the elapsed-time assertion below
// measures the bounded pre-consolidation wait, not vitest's first-import
// transform cost.
import "@stella/runtime/kernel/agent-runtime/dream-scheduler";

describe("run completion compaction metadata", () => {
  beforeEach(() => {
    compactRuntimeThreadHistoryMock.mockReset();
  });

  it("emits the persisted generated replacement when a hook summary is rejected", async () => {
    const generatedSummary = [
      "## Topic",
      "Generated replacement",
      "## Key Points",
      "The persisted checkpoint replaced malformed hook output.",
      "## Current State",
      "Compaction completed safely.",
      "## Open Items",
      "Independent review remains.",
    ].join("\n");
    compactRuntimeThreadHistoryMock.mockResolvedValue({
      compacted: true,
      summary: generatedSummary,
      fromOverride: false,
    });

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> =
      [];
    const hookEmitter = {
      emit: vi.fn(async (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload });
        if (event === "before_compact") {
          return {
            compaction: {
              summary: "## Topic\nRejected hook output",
              preserveLastN: 7,
            },
          };
        }
        return undefined;
      }),
    };

    const result = await runCompactionWithHooks({
      opts: {
        agentType: "orchestrator",
        conversationId: "conversation-1",
        resolvedLlm: {} as never,
        store: {} as never,
        hookEmitter: hookEmitter as never,
      },
      threadKey: "conversation-1",
      runId: "run-1",
      messageCount: 50,
    });
    await vi.waitFor(() =>
      expect(emitted.some(({ event }) => event === "session_compact")).toBe(
        true,
      ),
    );

    expect(result).toMatchObject({ compacted: true, fromOverride: false });
    expect(compactRuntimeThreadHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        overrideSummary: "## Topic\nRejected hook output",
        preserveLastN: 7,
      }),
    );
    expect(
      emitted.find(({ event }) => event === "session_compact")?.payload,
    ).toMatchObject({
      summary: generatedSummary,
      preserveLastN: 7,
      fromHook: false,
    });
  });

  it("continues to compaction after the bounded pre-consolidation timeout", async () => {
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "stella-precompact-timeout-"),
    );
    try {
      const api = `fake-hanging-${Math.random().toString(36).slice(2)}` as Api;
      const hanging = () =>
        ({
          result: () => new Promise<AssistantMessage>(() => {}),
        }) as AssistantMessageEventStream;
      registerApiProvider({ api, stream: hanging, streamSimple: hanging });
      const resolvedLlm = {
        model: {
          id: "fake-model",
          name: "Fake",
          api,
          provider: "openai",
          baseUrl: "http://localhost",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10_000,
          maxTokens: 1_000,
        } as unknown as Model<Api>,
        route: "direct-provider",
        getApiKey: () => "key",
      } as const;
      const store = {
        dreamInboxStore: {
          countUnprocessed: () => 1,
          pendingFrontier: () => 100,
          readConsolidationWatermark: () => null,
          writeConsolidationWatermark: vi.fn(),
          gcProcessedRows: () => ({ deleted: 0 }),
        },
      };
      compactRuntimeThreadHistoryMock.mockResolvedValue({ compacted: false });

      const startedAt = Date.now();
      await expect(
        runCompactionWithHooks({
          opts: {
            agentType: "orchestrator",
            conversationId: "conversation-timeout",
            resolvedLlm: resolvedLlm as never,
            store: store as never,
            stellaDataDir: rootPath,
          },
          threadKey: "conversation-timeout",
          runId: "run-timeout",
          messageCount: 50,
          orchestratorTokenEstimate: 8_000,
          preCompactionTimeoutMs: 30,
        }),
      ).resolves.toEqual({ compacted: false });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(compactRuntimeThreadHistoryMock).toHaveBeenCalledTimes(1);
      expect(
        store.dreamInboxStore.writeConsolidationWatermark,
      ).not.toHaveBeenCalled();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
