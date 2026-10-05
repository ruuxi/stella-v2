import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { METHOD_NAMES } from "@stella/contracts/protocol";
import { JsonRpcPeer } from "@stella/contracts/protocol/rpc-peer";

const bridgeOptions = vi.hoisted(() => ({
  current: null as null | {
    runExecution: (args: unknown) => Promise<{ status: string; finalText?: string; error?: string }>;
  },
}));

vi.mock("../../host/execution-placement-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../host/execution-placement-bridge.js")>()),
  createExecutionPlacementBridge: (options: NonNullable<typeof bridgeOptions.current>) => {
    bridgeOptions.current = options;
    return { start: async () => {}, stop: async () => {}, isRunning: true };
  },
}));

vi.mock("../../host/execution-placement-eligibility.js", () => ({
  isExecutionPlacementEligible: () => true,
}));

const { StellaRuntimeHost } = await import("../../host/index.js");
const { AGENT_RUN_UNRESPONSIVE_MS } = await import("../../host/agent-run-request.js");

const MINUTE = 60_000;

type Worker = {
  answerHealth: boolean;
  runs: Array<{ params: unknown; finish: (value: unknown) => void }>;
};

const connect = () => {
  const worker: Worker = { answerHealth: true, runs: [] };
  let hostPeer: JsonRpcPeer;
  const workerPeer = new JsonRpcPeer((message) => {
    queueMicrotask(() => void hostPeer.handleMessage(message));
  });
  hostPeer = new JsonRpcPeer((message) => {
    queueMicrotask(() => void workerPeer.handleMessage(message));
  });
  workerPeer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_HEALTH, () =>
    worker.answerHealth ? { pid: 1 } : new Promise(() => {}),
  );
  workerPeer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_AGENT,
    (params) =>
      new Promise((resolve) => {
        worker.runs.push({ params, finish: resolve });
      }),
  );
  const host = Object.assign(Object.create(StellaRuntimeHost.prototype), {
    started: true,
    hostReady: true,
    hostDatabase: {},
    deviceIdentity: { deviceId: "omarchy" },
    configCache: { hasConnectedAccount: true, cloudSyncEnabled: true },
    options: { hostHandlers: { signDeviceInput: async () => ({ signature: "sig" }) } },
    hostExecutionPlacementBridge: null,
    workerHealthCache: null,
    ensureHostBackendClient: () => ({ call: async () => ({}) }),
    getConfiguredHostAuthToken: () => "token",
    getConfiguredHostBackendUrl: () => "https://backend.test",
    workerController: {
      request: async (execute: (peer: JsonRpcPeer) => Promise<unknown>) =>
        await execute(hostPeer),
    },
  });
  return { host, worker, hostPeer, workerPeer };
};

const placeAgent = async (host: object) => {
  await StellaRuntimeHost.prototype.syncHostExecutionPlacementNow.call(host);
  const options = bridgeOptions.current;
  if (!options) throw new Error("The placement bridge was not created.");
  let outcome: unknown = "pending";
  void options
    .runExecution({
      dispatch: {
        dispatchId: "dispatch-1",
        kind: "agent",
        conversationId: "conversation-1",
      },
      payload: {
        prompt: "Clean up the disk and report what was freed.",
        description: "Disk cleanup",
        threadId: "thr-disk",
      },
      ownerGeneration: "generation-1",
    })
    .then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error : new Error(String(error));
      },
    );
  return () => outcome;
};

describe("an agent handed to this computer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridgeOptions.current = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps running past 30 minutes and reports its own result", async () => {
    const { host, worker } = connect();
    const outcome = await placeAgent(host);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.runs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    expect(outcome()).toBe("pending");

    worker.runs[0]!.finish({ status: "ok", finalText: "Freed 42 GB." });
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome()).toEqual({ status: "ok", finalText: "Freed 42 GB." });
  });

  it("is failed once the local runtime stops answering, instead of hanging forever", async () => {
    const { host, worker } = connect();
    const outcome = await placeAgent(host);
    await vi.advanceTimersByTimeAsync(45 * MINUTE);
    expect(outcome()).toBe("pending");

    worker.answerHealth = false;
    await vi.advanceTimersByTimeAsync(AGENT_RUN_UNRESPONSIVE_MS + 2 * MINUTE);
    const failed = outcome();
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain(
      "RPC peer stopped responding during internal.worker.runBlockingAgent",
    );
    expect(worker.runs).toHaveLength(1);
  });

  it("is not failed by the computer sleeping while it runs", async () => {
    const { host, worker } = connect();
    const outcome = await placeAgent(host);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    vi.setSystemTime(Date.now() + 2 * 60 * MINUTE);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(outcome()).toBe("pending");

    worker.runs[0]!.finish({ status: "ok", finalText: "Done after the lid opened." });
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome()).toEqual({ status: "ok", finalText: "Done after the lid opened." });
  });

  it("is failed at once when the local runtime exits", async () => {
    const { host, hostPeer } = connect();
    const outcome = await placeAgent(host);
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    expect(outcome()).toBe("pending");

    hostPeer.dispose(new Error("Runtime worker exited."));
    await vi.advanceTimersByTimeAsync(1);
    expect((outcome() as Error).message).toBe("Runtime worker exited.");
  });

  it("keeps a chat turn handed from another device running past 30 minutes too", async () => {
    const { host, worker, workerPeer } = connect();
    const chatRuns: Array<{ finish: (value: unknown) => void }> = [];
    workerPeer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
      () =>
        new Promise((resolve) => {
          chatRuns.push({ finish: resolve });
        }),
    );
    Object.assign(host, {
      appendLocalChatEvent: async () => {},
    });
    await StellaRuntimeHost.prototype.syncHostExecutionPlacementNow.call(host);
    const options = bridgeOptions.current;
    if (!options) throw new Error("The placement bridge was not created.");
    let outcome: unknown = "pending";
    void options
      .runExecution({
        dispatch: {
          dispatchId: "dispatch-chat-1",
          kind: "chat",
          conversationId: "conversation-1",
        },
        payload: { prompt: "Summarise today's releases." },
        ownerGeneration: "generation-1",
      })
      .then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error instanceof Error ? error : new Error(String(error));
        },
      );
    await vi.advanceTimersByTimeAsync(1);
    expect(chatRuns).toHaveLength(1);
    expect(worker.runs).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    expect(outcome).toBe("pending");

    chatRuns[0]!.finish({ status: "ok", finalText: "Three releases shipped." });
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ status: "ok" });
  });

  it("leaves the 30-minute deadline on ordinary worker requests", async () => {
    const { host, workerPeer } = connect();
    workerPeer.registerRequestHandler("internal.worker.slow", () => new Promise(() => {}));
    let outcome: unknown = "pending";
    void StellaRuntimeHost.prototype.requestWorker
      .call(host, "internal.worker.slow", {}, { ensureWorker: true, recordActivity: false })
      .catch((error: Error) => {
        outcome = error.message;
      });
    await vi.advanceTimersByTimeAsync(30 * MINUTE + 1);
    expect(outcome).toBe("RPC request timed out: internal.worker.slow");
  });
});
