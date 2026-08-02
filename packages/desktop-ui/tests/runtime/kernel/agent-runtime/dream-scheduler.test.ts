import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerApiProvider } from "@stella/runtime/ai/api-registry";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "@stella/runtime/ai/types";
import {
  awaitPreCompactionConsolidation,
  buildDreamSystemPrompt,
  DREAM_PRODUCTION_DELTA_CUTOVER_ENABLED,
  maybeSpawnDreamRun,
} from "@stella/runtime/kernel/agent-runtime/dream-scheduler";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";
import type { RuntimeStore } from "@stella/runtime/kernel/storage/runtime-store";

const activeRoots = new Set<string>();

const createRoot = (): string => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-dream-scheduler-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  activeRoots.add(rootPath);
  return rootPath;
};

afterEach(async () => {
  for (const rootPath of activeRoots) {
    // A timed-out pre-compaction wait deliberately leaves its Dream run
    // detached (join semantics), so layout/staging writes can race this
    // cleanup. `rm` retries cover the transient ENOTEMPTY window.
    await rm(rootPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
  activeRoots.clear();
});

const fakeAssistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake" as Api,
  provider: "openai",
  model: "fake-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const buildResultStream = (
  message: AssistantMessage,
): AssistantMessageEventStream =>
  ({
    result: async () => message,
  }) as AssistantMessageEventStream;

const buildFakeRoute = (args: {
  response: AssistantMessage;
  apiKey?: string;
  onRequest?: () => void;
}): ResolvedLlmRoute => {
  const apiId = `fake-${Math.random().toString(36).slice(2)}` as Api;
  registerApiProvider({
    api: apiId,
    stream: (
      _model: Model<Api>,
      _context: Context,
      _options?: StreamOptions,
    ) => {
      args.onRequest?.();
      return buildResultStream(args.response);
    },
    streamSimple: (
      _model: Model<Api>,
      _context: Context,
      _options?: SimpleStreamOptions,
    ) => {
      args.onRequest?.();
      return buildResultStream(args.response);
    },
  });
  const model = {
    id: "fake-model",
    name: "Fake Model",
    api: apiId,
    provider: "openai",
    baseUrl: "http://localhost:3210/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as unknown as Model<Api>;
  return {
    model,
    route: "direct-provider",
    getApiKey: () => args.apiKey ?? "",
  };
};

const replaceRouteApi = (
  route: ResolvedLlmRoute,
  api: Api,
): ResolvedLlmRoute => ({
  ...route,
  model: { ...route.model, api } as typeof route.model,
});

const registerResultApi = (result: () => Promise<AssistantMessage>): Api => {
  const api = `fake-result-${Math.random().toString(36).slice(2)}` as Api;
  const stream = () => ({ result }) as AssistantMessageEventStream;
  registerApiProvider({ api, stream, streamSimple: stream });
  return api;
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("buildDreamSystemPrompt", () => {
  it("requires bounded, usage-aware, ownership-safe map maintenance", () => {
    const prompt = buildDreamSystemPrompt(createRoot());

    expect(prompt).toContain("memory_map.md on every consolidation pass");
    expect(prompt).toContain(
      "memory_summary.md and memory_index.md are retired",
    );
    expect(prompt).toContain("at most 80 entries and 6000 injected characters");
    expect(prompt).toContain("prune entries older than 90 days");
    expect(prompt).toContain("higher usage_count or recent last_usage");
    expect(prompt).toContain("Never put secrets, credentials, tokens");
    expect(prompt).toContain("profile.md stays exclusively Remember-owned");
    expect(prompt).toContain("supersede, don't append");
    expect(prompt).toContain("MEMORY-superseded.md");
    expect(DREAM_PRODUCTION_DELTA_CUTOVER_ENABLED).toBe(false);
  });
});

describe("maybeSpawnDreamRun", () => {
  it("allows credentialless direct-provider routes to execute the Dream pass", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: {
        dreamInboxStore: {
          countUnprocessed: () => 1,
        },
      } as RuntimeStore,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("- Consolidated the current memory inputs."),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "manual",
    });

    expect(result).toMatchObject({
      scheduled: true,
      reason: "scheduled",
      pendingItems: 1,
    });

    await waitFor(() => providerCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(providerCalls).toBe(1);
  });

  const pendingStore = (): RuntimeStore =>
    ({
      dreamInboxStore: { countUnprocessed: () => 1 },
    }) as RuntimeStore;

  it("skips token_interval runs below the growth threshold", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: pendingStore(),
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("noop"),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "token_interval",
      orchestratorTokenEstimate: 5_000,
    });

    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(providerCalls).toBe(0);
  });

  it("runs token_interval once growth crosses the interval", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: pendingStore(),
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("- folded the interval batch"),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "token_interval",
      orchestratorTokenEstimate: 25_000,
    });

    expect(result.scheduled).toBe(true);
    await waitFor(() => providerCalls > 0);
  });

  it("flushes on pre_compaction regardless of growth", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: pendingStore(),
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("- flushed before compaction"),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "pre_compaction",
      orchestratorTokenEstimate: 1_000,
    });

    expect(result.scheduled).toBe(true);
    await waitFor(() => providerCalls > 0);
  });

  it("returns no_inputs when nothing is pending, even at the compaction boundary", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: {
        dreamInboxStore: { countUnprocessed: () => 0 },
      } as RuntimeStore,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("noop"),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "pre_compaction",
      orchestratorTokenEstimate: 100_000,
    });

    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe("no_inputs");
    expect(providerCalls).toBe(0);
  });
});

describe("awaitPreCompactionConsolidation", () => {
  const buildStore = (args: {
    pending?: number;
    frontier?: number;
    watermark?: { frontier: number; completedAt: number } | null;
    onWatermark?: (frontier: number) => void;
    onGc?: () => void;
  }): RuntimeStore =>
    ({
      dreamInboxStore: {
        countUnprocessed: () => args.pending ?? 1,
        pendingFrontier: () => args.frontier ?? 100,
        readConsolidationWatermark: () => args.watermark ?? null,
        writeConsolidationWatermark: ({ frontier }: { frontier: number }) =>
          args.onWatermark?.(frontier),
        gcProcessedRows: () => {
          args.onGc?.();
          return { deleted: 0 };
        },
      },
    }) as RuntimeStore;

  it("skips when the persisted completed-pass frontier is fresh", async () => {
    let providerCalls = 0;
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: createRoot(),
      store: buildStore({
        pending: 2,
        frontier: 200,
        watermark: { frontier: 200, completedAt: 1 },
      }),
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("unused"),
        apiKey: "key",
        onRequest: () => {
          providerCalls += 1;
        },
      }),
    });
    expect(result.outcome).toBe("skipped_fresh");
    expect(providerCalls).toBe(0);
  });

  it("times out a hung provider within the supplied bound without advancing state", async () => {
    const route = replaceRouteApi(
      buildFakeRoute({ response: fakeAssistant("unused"), apiKey: "key" }),
      registerResultApi(() => new Promise<AssistantMessage>(() => {})),
    );
    const writes: number[] = [];
    const startedAt = Date.now();
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: createRoot(),
      store: buildStore({ onWatermark: (frontier) => writes.push(frontier) }),
      resolvedLlm: route,
      timeoutMs: 40,
    });
    expect(result.outcome).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(writes).toEqual([]);
  });

  it("isolates provider failure and leaves the durable frontier pending", async () => {
    const route = replaceRouteApi(
      buildFakeRoute({ response: fakeAssistant("unused"), apiKey: "key" }),
      registerResultApi(async () => {
        throw new Error("provider failed");
      }),
    );
    const writes: number[] = [];
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: createRoot(),
      store: buildStore({ onWatermark: (frontier) => writes.push(frontier) }),
      resolvedLlm: route,
      timeoutMs: 100,
    });
    expect(result.outcome).toBe("incomplete");
    expect(writes).toEqual([]);
  });

  it("fails closed on an unknown provider terminal without watermarking", async () => {
    const unknownTerminal = {
      ...fakeAssistant("provider returned an unfamiliar terminal"),
      stopReason: "future_stop_reason" as never,
    };
    const writes: number[] = [];
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: createRoot(),
      store: buildStore({ onWatermark: (frontier) => writes.push(frontier) }),
      resolvedLlm: buildFakeRoute({
        response: unknownTerminal,
        apiKey: "key",
      }),
      timeoutMs: 100,
    });
    expect(result.outcome).toBe("incomplete");
    expect(writes).toEqual([]);
  });

  it("joins one concurrent Dream run and advances the watermark only after completion", async () => {
    let deliver!: (message: AssistantMessage) => void;
    const response = new Promise<AssistantMessage>((resolve) => {
      deliver = resolve;
    });
    let providerCalls = 0;
    const api = registerResultApi(() => {
      providerCalls += 1;
      return response;
    });
    const route = replaceRouteApi(
      buildFakeRoute({ response: fakeAssistant("unused"), apiKey: "key" }),
      api,
    );
    const writes: number[] = [];
    let gcCalls = 0;
    const rootPath = createRoot();
    const store = buildStore({
      frontier: 4242,
      onWatermark: (frontier) => writes.push(frontier),
      onGc: () => {
        gcCalls += 1;
      },
    });
    const spawned = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "token_interval",
      orchestratorTokenEstimate: 25_000,
    });
    expect(spawned.scheduled).toBe(true);
    await waitFor(() => providerCalls === 1);

    const waiting = awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      timeoutMs: 500,
    });
    deliver(fakeAssistant("Consolidated."));
    await expect(waiting).resolves.toMatchObject({ outcome: "consolidated" });
    expect(providerCalls).toBe(1);
    expect(writes).toEqual([4242]);
    expect(gcCalls).toBe(1);
  });
});
