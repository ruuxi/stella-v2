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
  parseCanonicalCloudHistory,
  type PreparedOrchestratorRun,
} from "./orchestrator-launch.js";
import { createExecutionContextSnapshot } from "@stella/contracts/execution-context";
import { buildResidentContextMessages } from "../agent-runtime/resident-context.js";

test("cloud history restores execution context for a device turn without replaying unchanged blocks", () => {
  const cloud = createExecutionContextSnapshot({
    devices: [],
    destination: { kind: "cloud" },
  });
  const history = parseCanonicalCloudHistory([
    JSON.stringify({
      role: "user",
      content: "Hello",
      timestamp: 1,
      executionContext: cloud,
    }),
  ]);
  expect(history).toHaveLength(3);
  expect(history[0].role).toBe("runtimeInternal");
  expect(history[0].customMessage.display).toBe(false);
  expect(history[2].content).toBe("Hello");
  expect(
    buildResidentContextMessages({
      executionContext: cloud,
      threadHistory: history,
    }),
  ).toEqual([]);
  const device = createExecutionContextSnapshot({
    devices: [],
    destination: { kind: "device", deviceId: "desktop", label: "Desktop" },
  });
  const updates = buildResidentContextMessages({
    executionContext: device,
    threadHistory: history,
  });
  expect(updates).toHaveLength(2);
  expect(updates[1].text).toContain("The execution destination changed.");
});

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
  test("waits for admission before model execution even with cached history", async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(modelStarted).toBe(false);
    expect(harness.terminalEvents).toEqual([]);
    begin.resolve(beginAck());
    await harness.waitUntilSettled();

    expect(harness.finishes).toHaveLength(1);
    expect(harness.finishes[0]?.leaseToken).toBe("lease-1");
    expect(harness.finishes[0]?.phase).toBe("completed");
    expect(harness.events.slice(0, 2)).toEqual(["finish", "end"]);
  });

  test("does not start the provider or tools when admission rejects", async () => {
    const begin = deferred<CloudTranscriptBeginAck>();
    let modelStarts = 0;
    const harness = launchHarness({
      cachedHistory: CACHED_HISTORY,
      begin: () => begin.promise,
      run: async () => {
        modelStarts += 1;
      },
    });
    const beginError = new Error("Cloud begin failed.");
    begin.reject(beginError);
    await harness.waitUntilSettled();
    expect(modelStarts).toBe(0);
    expect(harness.captureIsActive()).toBe(false);
    expect(harness.finishes).toEqual([]);
    expect(harness.fatalErrors).toEqual([beginError]);
    expect(harness.events).toEqual(["cleanup", "fatal"]);
  });

  test("uses newly admitted history when another device advanced the cached sequence", async () => {
    const begin = deferred<CloudTranscriptBeginAck>();
    let modelStarts = 0;
    let suppliedHistory: unknown;
    const authoritative = JSON.stringify({
      role: "user",
      content: "New message from phone",
      timestamp: 2,
    });
    const harness = launchHarness({
      cachedHistory: CACHED_HISTORY,
      begin: () => begin.promise,
      run: async (runOptions) => {
        modelStarts += 1;
        suppliedHistory = runOptions.agentContext.threadHistory;
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
    begin.resolve({
      ...beginAck(CACHED_HISTORY.contextEndSeq + 1),
      history: [authoritative],
    });
    await harness.waitUntilSettled();
    expect(modelStarts).toBe(1);
    expect(suppliedHistory).toEqual(
      parseCanonicalCloudHistory([authoritative]),
    );
    expect(harness.finishes).toHaveLength(1);
    expect(harness.finishes[0]).toMatchObject({
      leaseToken: "lease-1",
      phase: "completed",
    });
    expect(harness.fatalErrors).toEqual([]);
    expect(harness.terminalEvents).toEqual(["end"]);
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
