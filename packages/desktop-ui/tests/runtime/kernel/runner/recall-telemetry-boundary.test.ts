import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolHostOptions } from "@stella/runtime/kernel/tools/types";

const boundaryMocks = vi.hoisted(() => ({
  toolHostOptions: undefined as ToolHostOptions | undefined,
  routeRecallIntent: vi.fn(),
  runRecall: vi.fn(),
  resolveRunnerRecallLlmRoute: vi.fn(),
}));

vi.mock("@stella/runtime/kernel/tools/host", () => ({
  createToolHost: vi.fn((options: ToolHostOptions) => {
    boundaryMocks.toolHostOptions = options;
    return {} as never;
  }),
}));

vi.mock("@stella/runtime/kernel/runner/fashion-api", () => ({
  createFashionApi: vi.fn(() => ({})),
}));

vi.mock("@stella/runtime/kernel/shared/runtime-paths", () => ({
  resolveRuntimeSourceAsset: vi.fn((name: string) => `/runtime/${name}`),
}));

vi.mock("@stella/runtime/kernel/agent-runtime/context-lookup", () => {
  class RecallRetrievalError extends Error {}
  return {
    isRecallNoMatchBrief: (brief: string) =>
      brief.toLowerCase().includes("nothing relevant found"),
    RecallRetrievalError,
    routeRecallIntent: boundaryMocks.routeRecallIntent,
    runRecall: boundaryMocks.runRecall,
  };
});

vi.mock("@stella/runtime/kernel/runner/model-selection", () => ({
  resolveRunnerLlmRoute: vi.fn(),
  resolveRunnerLlmRouteWithMetadata: vi.fn(),
  resolveRunnerRecallLlmRoute: boundaryMocks.resolveRunnerRecallLlmRoute,
}));

import { createRunnerContext } from "@stella/runtime/kernel/runner/context";

const createContextProvider = (args?: {
  getAppBrowserContext?: () => Promise<Record<string, unknown>>;
  listLocalChatEvents?: () => Array<{
    _id: string;
    timestamp: number;
    type: string;
  }>;
}) => {
  createRunnerContext({
    deviceId: "test-device",
    stellaAppDir: "/tmp/stella-app",
    stellaDataDir: "/tmp/stella-data",
    runtimeStore: {} as never,
    ...(args?.getAppBrowserContext
      ? { getAppBrowserContext: args.getAppBrowserContext as never }
      : {}),
    ...(args?.listLocalChatEvents
      ? { listLocalChatEvents: args.listLocalChatEvents }
      : {}),
  });
  const provider = boundaryMocks.toolHostOptions?.contextProvider;
  if (!provider) throw new Error("Recall context provider was not registered");
  return provider;
};

const mockRunnerClock = (): ReturnType<typeof vi.spyOn> => {
  const times = [100, 110, 115, 120, 121, 124, 125, 132, 135];
  let index = 0;
  return vi
    .spyOn(performance, "now")
    .mockImplementation(() => times[index++] ?? 135);
};

beforeEach(() => {
  boundaryMocks.toolHostOptions = undefined;
  boundaryMocks.routeRecallIntent.mockReset();
  boundaryMocks.runRecall.mockReset().mockResolvedValue("Found it.");
  boundaryMocks.resolveRunnerRecallLlmRoute.mockReset().mockResolvedValue({
    activeEngine: "default",
    executionEngine: "native",
    modelId: "test/light",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runner Recall telemetry boundary", () => {
  it("hands route and live host-context timings into Recall", async () => {
    boundaryMocks.routeRecallIntent.mockReturnValue("live_context");
    const browserContext = { activeApp: "Brave", tabs: ["Stella"] };
    const listLocalChatEvents = vi.fn(() => [
      { _id: "event-1", timestamp: 1, type: "user_message" },
      { _id: "event-2", timestamp: 2, type: "private_runtime_event" },
    ]);
    const getAppBrowserContext = vi.fn(async () => browserContext);
    const provider = createContextProvider({
      getAppBrowserContext,
      listLocalChatEvents,
    });
    const clock = mockRunnerClock();

    await expect(
      provider({
        conversationId: "conversation-1",
        requestId: "request-1",
        runId: "run-1",
        prompt: "What is happening in my browser right now?",
        memorySearchTerms: ["browser", "current"],
      }),
    ).resolves.toMatchObject({ status: "found", brief: "Found it." });

    // Route resolution is deferred to the synthesis fallback inside runRecall,
    // so the boundary no longer measures route time (two fewer clock reads) and
    // never resolves the route eagerly — fast lookups take no model route.
    expect(clock).toHaveBeenCalledTimes(7);
    expect(boundaryMocks.resolveRunnerRecallLlmRoute).not.toHaveBeenCalled();
    expect(
      typeof boundaryMocks.runRecall.mock.calls[0]?.[0].resolveRecallRoute,
    ).toBe("function");
    expect(listLocalChatEvents).toHaveBeenCalledWith("conversation-1", 5);
    expect(getAppBrowserContext).toHaveBeenCalledTimes(1);
    const recallArgs = boundaryMocks.runRecall.mock.calls[0]?.[0];
    expect(recallArgs).toMatchObject({
      localEvents: [{ _id: "event-1", type: "user_message" }],
      appBrowserContext: browserContext,
      telemetry: {
        startedAtMs: 100,
        routeMs: 0,
        hostContextMs: 15,
        sourceTimings: {
          "host.localEvents": { kind: "sql", calls: 1, ms: 5, chars: 0 },
          "host.appBrowserContext": {
            kind: "host",
            calls: 1,
            ms: 3,
            chars: JSON.stringify(browserContext).length,
          },
        },
      },
    });
  });

  it("records zero host calls without invoking gated providers for durable memory", async () => {
    boundaryMocks.routeRecallIntent.mockReturnValue("durable_memory");
    const listLocalChatEvents = vi.fn(() => []);
    const getAppBrowserContext = vi.fn(async () => ({ activeApp: "Brave" }));
    const provider = createContextProvider({
      getAppBrowserContext,
      listLocalChatEvents,
    });
    mockRunnerClock();

    await provider({
      conversationId: "conversation-1",
      requestId: "request-2",
      runId: "run-2",
      prompt: "What did we decide about the memory index?",
      memorySearchTerms: ["memory", "index"],
    });

    expect(listLocalChatEvents).not.toHaveBeenCalled();
    expect(getAppBrowserContext).not.toHaveBeenCalled();
    expect(boundaryMocks.runRecall.mock.calls[0]?.[0]).toMatchObject({
      localEvents: [],
      telemetry: {
        startedAtMs: 100,
        routeMs: 0,
        hostContextMs: 15,
        sourceTimings: {
          "host.localEvents": { kind: "sql", calls: 0, ms: 5, chars: 0 },
          "host.appBrowserContext": {
            kind: "host",
            calls: 0,
            ms: 3,
            chars: 0,
          },
        },
      },
    });
    expect(boundaryMocks.runRecall.mock.calls[0]?.[0]).not.toHaveProperty(
      "appBrowserContext",
    );
  });
});
