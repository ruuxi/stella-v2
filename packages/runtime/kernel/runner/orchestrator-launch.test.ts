import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as agentRuntime from "../agent-runtime.js";
import type { RuntimeRunCallbacks } from "../agent-runtime.js";
import type { RunnerContext } from "./types.js";
import type {
  CloudTranscriptBeginAck,
  CloudTranscriptFinishRequest,
  CloudTranscriptHistory,
  CloudTranscriptWriter,
} from "./cloud-transcript-write.js";
import {
  launchPreparedOrchestratorRun,
  type PreparedOrchestratorRun,
} from "./orchestrator-launch.js";

const RUN_ID = "run-1";
const CONVERSATION_ID = "conversation-1";
const OWNER_GENERATION = "owner-generation-1";
const CACHED_HISTORY: CloudTranscriptHistory = {
  history: [
    JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "Earlier" }],
      timestamp: 1,
    }),
  ],
  contextStartSeq: 3,
  contextEndSeq: 7,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const beginAck = (contextEndSeq = CACHED_HISTORY.contextEndSeq) => ({
  turnId: "turn-1",
  leaseToken: "lease-1",
  expiresAt: Date.now() + 60_000,
  history: CACHED_HISTORY.history,
  contextStartSeq: CACHED_HISTORY.contextStartSeq,
  contextEndSeq,
});

type RunOptions = Parameters<typeof agentRuntime.runOrchestratorTurn>[0];

const sessions: Array<RunnerContext["state"]["orchestratorSessions"]> = [];

afterEach(() => {
  mock.restore();
  for (const sessionMap of sessions.splice(0)) {
    for (const session of sessionMap.values()) session.dispose();
  }
});

const launchHarness = (options: {
  cachedHistory: CloudTranscriptHistory | null;
  begin: () => Promise<CloudTranscriptBeginAck>;
  run: (options: RunOptions) => Promise<void>;
}) => {
  const events: string[] = [];
  const fatalErrors: unknown[] = [];
  const finishes: CloudTranscriptFinishRequest[] = [];
  let refreshes = 0;
  let settled: Promise<unknown> | null = null;
  let captureActive = false;
  const orchestratorSessions: RunnerContext["state"]["orchestratorSessions"] =
    new Map();
  sessions.push(orchestratorSessions);

  const cloudTranscript: CloudTranscriptWriter = {
    history: async () => options.cachedHistory ?? CACHED_HISTORY,
    peekHistory: () => options.cachedHistory,
    refreshHistory: async () => {
      refreshes += 1;
    },
    begin: options.begin,
    finish: async (request) => {
      events.push("finish");
      finishes.push(request);
      return { queued: true };
    },
    append: async () => ({ queued: true, replayed: false }),
    pending: () => 0,
    resume: () => undefined,
    stop: () => undefined,
  };
  const context = {
    deviceId: "device-1",
    stellaAppDir: "/tmp/stella-app",
    stellaDataDir: "/tmp/stella-data",
    cloudTranscript,
    runtimeStore: {
      beginEphemeralThreadCapture: () => {
        captureActive = true;
      },
      readEphemeralThreadCapture: () => {
        if (!captureActive) throw new Error("Capture is not active.");
        return [];
      },
      endEphemeralThreadCapture: () => {
        captureActive = false;
      },
      setThreadExternalSessionId: () => undefined,
      setThreadExternalDeliveredEntryId: () => undefined,
    },
    state: {
      orchestratorSessions,
      modelCatalogUpdatedAt: null,
      convexSiteUrl: null,
      authToken: null,
      hasConnectedAccount: false,
      compactionScheduler: undefined,
      supervisor: {
        startRun: (_runId: string, work: { settled: Promise<unknown> }) => {
          settled = work.settled;
        },
        adoptResource: () => undefined,
      },
    },
    toolHost: {
      getToolCatalog: () => [],
      executeTool: async () => {
        throw new Error("Tool execution was not expected.");
      },
      endBrowserTurn: async () => undefined,
    },
  } as unknown as RunnerContext;
  const prepared = {
    runId: RUN_ID,
    conversationId: CONVERSATION_ID,
    agentType: "general",
    storageMode: "cloud",
    ownerGeneration: OWNER_GENERATION,
    userPrompt: "Hello",
    attachments: [],
    agentContext: {},
    resolvedLlm: {
      route: "direct-provider",
      model: {
        api: "openai-completions",
        provider: "test",
        id: "test-model",
        name: "Test model",
        input: ["text"],
      },
      getApiKey: () => undefined,
    },
    abortController: new AbortController(),
  } as unknown as PreparedOrchestratorRun;
  const terminalEvents: string[] = [];
  const runtimeCallbacks: RuntimeRunCallbacks = {
    onToolStart: () => undefined,
    onToolEnd: () => undefined,
    onError: () => terminalEvents.push("error"),
    onEnd: () => {
      events.push("end");
      terminalEvents.push("end");
    },
    onInterrupted: () => terminalEvents.push("interrupted"),
  };

  spyOn(agentRuntime, "runOrchestratorTurn").mockImplementation(options.run);
  launchPreparedOrchestratorRun({
    context,
    prepared,
    userMessageId: "message-1",
    runtimeCallbacks,
    cleanupRun: () => events.push("cleanup"),
    onFatalError: (error) => {
      events.push("fatal");
      fatalErrors.push(error);
    },
  });

  return {
    captureIsActive: () => captureActive,
    events,
    fatalErrors,
    finishes,
    prepared,
    refreshCount: () => refreshes,
    terminalEvents,
    waitUntilSettled: async () => {
      await waitFor(() => settled !== null);
      await settled;
    },
  };
};

describe("cloud orchestrator launch", () => {
  test("starts the model before begin resolves and finishes after matching sequence bounds", async () => {
    const begin = deferred<CloudTranscriptBeginAck>();
    let modelStarted = false;
    const harness = launchHarness({
      cachedHistory: CACHED_HISTORY,
      begin: () => begin.promise,
      run: async (runOptions) => {
        modelStarted = true;
        runOptions.callbacks.onEnd({
          runId: RUN_ID,
          agentType: "general",
          seq: 1,
          userMessageId: "message-1",
          finalText: "Done",
          persisted: true,
        });
      },
    });

    await waitFor(() => modelStarted);
    expect(harness.terminalEvents).toEqual([]);
    begin.resolve(beginAck());
    await harness.waitUntilSettled();

    expect(harness.finishes).toHaveLength(1);
    expect(harness.finishes[0]?.leaseToken).toBe("lease-1");
    expect(harness.finishes[0]?.phase).toBe("completed");
    expect(harness.events.slice(0, 2)).toEqual(["finish", "end"]);
  });

  test("aborts the optimistic model run and surfaces a begin rejection", async () => {
    const begin = deferred<CloudTranscriptBeginAck>();
    let modelStarted = false;
    let modelAborted = false;
    const harness = launchHarness({
      cachedHistory: CACHED_HISTORY,
      begin: () => begin.promise,
      run: async (runOptions) => {
        modelStarted = true;
        await new Promise<void>((resolve) => {
          runOptions.abortSignal?.addEventListener(
            "abort",
            () => {
              modelAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    const beginError = new Error("Cloud begin failed.");

    await waitFor(() => modelStarted);
    begin.reject(beginError);
    await harness.waitUntilSettled();

    expect(modelAborted).toBe(true);
    expect(harness.captureIsActive()).toBe(false);
    expect(harness.finishes).toEqual([]);
    expect(harness.fatalErrors).toEqual([beginError]);
    expect(harness.events).toEqual(["cleanup", "fatal"]);
  });

  test("fails and finishes without partial output when the cached sequence is stale", async () => {
    const begin = deferred<CloudTranscriptBeginAck>();
    let modelStarted = false;
    const harness = launchHarness({
      cachedHistory: CACHED_HISTORY,
      begin: () => begin.promise,
      run: async (runOptions) => {
        modelStarted = true;
        await new Promise<void>((resolve) => {
          runOptions.abortSignal?.addEventListener(
            "abort",
            () => {
              runOptions.callbacks.onInterrupted?.({
                runId: RUN_ID,
                agentType: "general",
                seq: 1,
                userMessageId: "message-1",
                reason: "aborted",
              });
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    await waitFor(() => modelStarted);
    begin.resolve(beginAck(CACHED_HISTORY.contextEndSeq + 1));
    await harness.waitUntilSettled();

    expect(harness.finishes).toHaveLength(1);
    expect(harness.finishes[0]).toMatchObject({
      leaseToken: "lease-1",
      records: [],
      phase: "failed",
      notice: "The local turn did not finish.",
    });
    expect(harness.terminalEvents).toEqual([]);
    expect(harness.fatalErrors).toHaveLength(1);
    const fatalError = harness.fatalErrors[0];
    if (!(fatalError instanceof Error)) {
      throw new Error("Expected the stale-window failure to be an Error.");
    }
    expect(fatalError.message).toBe(
      "This conversation changed on another device. Send that again.",
    );
    expect(harness.events).toEqual(["finish", "cleanup", "fatal"]);
  });

  test("waits for begin on a cache miss and refreshes history for the next turn", async () => {
    const begin = deferred<CloudTranscriptBeginAck>();
    let modelStarts = 0;
    const harness = launchHarness({
      cachedHistory: null,
      begin: () => begin.promise,
      run: async (runOptions) => {
        modelStarts += 1;
        runOptions.callbacks.onEnd({
          runId: RUN_ID,
          agentType: "general",
          seq: 1,
          userMessageId: "message-1",
          finalText: "Done",
          persisted: true,
        });
      },
    });

    await waitFor(() => harness.refreshCount() === 1);
    expect(modelStarts).toBe(0);
    begin.resolve(beginAck());
    await harness.waitUntilSettled();

    expect(modelStarts).toBe(1);
    expect(harness.finishes[0]?.phase).toBe("completed");
  });
});
