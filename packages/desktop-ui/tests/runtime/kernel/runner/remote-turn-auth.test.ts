import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { StellaRuntimeHost } from "@stella/runtime/host";
import { remoteTurnWorkerRunId } from "@stella/runtime/kernel/remote-turn-attempt";
import {
  createRemoteTurnBridge,
  type RemoteTurnAttemptHeartbeat,
  type RemoteTurnAttemptReceipt,
  type RemoteTurnRequestEvent,
} from "@stella/runtime/kernel/remote-turn-bridge";
import {
  getConvexErrorCode,
  getConvexErrorMessage,
  isConvexDeviceKeyMismatchError,
  isConvexUnauthenticatedError,
  shouldStopRemoteTurnForAuthFailure,
} from "@stella/runtime/kernel/runner";

const OWNER_GENERATION = "owner-generation-1";

const attemptReceipt = (
  attemptId: string,
  overrides: Partial<RemoteTurnAttemptReceipt> = {},
): RemoteTurnAttemptReceipt => {
  const now = Date.now();
  return {
    acquired: true,
    status: "reserved",
    attemptId,
    leaseExpiresAt: now + 2_000,
    hardExpiresAt: now + 10_000,
    quiescentAfterAt: now + 3_000,
    ...overrides,
  };
};

const allowedHeartbeat = (
  overrides: Partial<RemoteTurnAttemptHeartbeat> = {},
): RemoteTurnAttemptHeartbeat => {
  const now = Date.now();
  return {
    allowed: true,
    cancelRequested: false,
    leaseExpiresAt: now + 2_000,
    hardExpiresAt: now + 10_000,
    quiescentAfterAt: now + 3_000,
    ...overrides,
  };
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for remote-turn bridge state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const connectorRequest = (requestId = "request-1"): RemoteTurnRequestEvent => ({
  _id: `event:${requestId}`,
  timestamp: Date.now(),
  type: "remote_turn_request",
  requestId,
  ownerGeneration: OWNER_GENERATION,
  payload: {
    conversationId: "conversation-1",
    text: "Please handle this request.",
    provider: "stella_app",
  },
});

describe("remote-turn auth failure handling", () => {
  it("detects Convex unauthenticated errors from nested error data", () => {
    const error = {
      data: {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      },
    };

    expect(getConvexErrorCode(error)).toBe("UNAUTHENTICATED");
    expect(isConvexUnauthenticatedError(error)).toBe(true);
  });

  it("detects device key mismatch errors from nested Convex error data", () => {
    const error = {
      data: {
        code: "UNAUTHORIZED",
        message: "Device key mismatch for this machine.",
      },
    };

    expect(getConvexErrorCode(error)).toBe("UNAUTHORIZED");
    expect(getConvexErrorMessage(error)).toBe(
      "Device key mismatch for this machine.",
    );
    expect(isConvexDeviceKeyMismatchError(error)).toBe(true);
  });

  it("ignores the first two unauthenticated failures inside the auth grace window", () => {
    const authWindowStartedAt = 1_000;
    const nowMs = authWindowStartedAt + 5_000;

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt,
        failureCount: 1,
        nowMs,
      }),
    ).toBe(false);

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt,
        failureCount: 2,
        nowMs,
      }),
    ).toBe(false);
  });

  it("stops remote-turn sync after repeated or late unauthenticated failures", () => {
    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt: 1_000,
        failureCount: 3,
        nowMs: 6_000,
      }),
    ).toBe(true);

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt: 1_000,
        failureCount: 1,
        nowMs: 17_000,
      }),
    ).toBe(true);
  });
});

describe("remote-turn mobile model override", () => {
  it("passes the mobile-selected model into the local automation turn", async () => {
    let onUpdate:
      | ((
          events: Array<{
            _id: string;
            timestamp: number;
            type: string;
            requestId?: string;
            payload?: Record<string, unknown>;
          }>,
        ) => void)
      | null = null;
    let capturedModelOverride: string | undefined;
    let completed = false;

    const bridge = createRemoteTurnBridge({
      deviceId: "desktop-1",
      isEnabled: () => true,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
        onUpdate = nextOnUpdate;
        return () => {};
      },
      claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
      heartbeatRemoteTurn: async () => allowedHeartbeat(),
      runLocalTurn: async ({ modelOverride }) => {
        capturedModelOverride = modelOverride;
        return { status: "ok", finalText: "done" };
      },
      completeConnectorTurn: async () => {
        completed = true;
      },
      finishRemoteTurnAttempt: async () => {},
    });

    bridge.start();
    onUpdate?.([
      {
        _id: "event-1",
        timestamp: Date.now(),
        type: "remote_turn_request",
        requestId: "request-1",
        ownerGeneration: OWNER_GENERATION,
        payload: {
          conversationId: "conversation-1",
          text: "Use the model I picked on my phone.",
          provider: "stella_app",
          deliveryMeta: { mobileModel: "stella/designer" },
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedModelOverride).toBe("stella/designer");
    expect(completed).toBe(true);
    bridge.stop();
  });

  it("uses transient audio transcripts as the local turn prompt", async () => {
    let onUpdate:
      | ((
          events: Array<{
            _id: string;
            timestamp: number;
            type: string;
            requestId?: string;
            payload?: Record<string, unknown>;
          }>,
        ) => void)
      | null = null;
    let capturedPrompt = "";

    const bridge = createRemoteTurnBridge({
      deviceId: "desktop-1",
      isEnabled: () => true,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
        onUpdate = nextOnUpdate;
        return () => {};
      },
      claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
      heartbeatRemoteTurn: async () => allowedHeartbeat(),
      runLocalTurn: async ({ userPrompt }) => {
        capturedPrompt = userPrompt;
        return { status: "ok", finalText: "done" };
      },
      completeConnectorTurn: async () => {},
      finishRemoteTurnAttempt: async () => {},
    });

    bridge.start();
    onUpdate?.([
      {
        _id: "event-1",
        timestamp: Date.now(),
        type: "remote_turn_request",
        requestId: "request-1",
        ownerGeneration: OWNER_GENERATION,
        payload: {
          conversationId: "conversation-1",
          text: "[Audio]",
          provider: "stella_app",
          deliveryMeta: {},
          mediaRefs: [
            {
              url: "https://example.test/audio.m4a",
              kind: "audio",
              mimeType: "audio/mp4",
              transcript: "Please bring coffee on your way home.",
            },
          ],
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedPrompt).toBe(
      "Voice message transcript:\nPlease bring coffee on your way home.",
    );
    bridge.stop();
  });

  it("adds transient extracted file text to the local turn prompt", async () => {
    let onUpdate:
      | ((
          events: Array<{
            _id: string;
            timestamp: number;
            type: string;
            requestId?: string;
            payload?: Record<string, unknown>;
          }>,
        ) => void)
      | null = null;
    let capturedPrompt = "";

    const bridge = createRemoteTurnBridge({
      deviceId: "desktop-1",
      isEnabled: () => true,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
        onUpdate = nextOnUpdate;
        return () => {};
      },
      claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
      heartbeatRemoteTurn: async () => allowedHeartbeat(),
      runLocalTurn: async ({ userPrompt }) => {
        capturedPrompt = userPrompt;
        return { status: "ok", finalText: "done" };
      },
      completeConnectorTurn: async () => {},
      finishRemoteTurnAttempt: async () => {},
    });

    bridge.start();
    onUpdate?.([
      {
        _id: "event-1",
        timestamp: Date.now(),
        type: "remote_turn_request",
        requestId: "request-1",
        ownerGeneration: OWNER_GENERATION,
        payload: {
          conversationId: "conversation-1",
          text: "[Attachment]",
          provider: "stella_app",
          deliveryMeta: {},
          mediaRefs: [
            {
              url: "https://example.test/report.pdf",
              kind: "file",
              mimeType: "application/pdf",
              name: "report.pdf",
              extractedText: "Quarterly revenue was $42.",
            },
          ],
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedPrompt).toBe("report.pdf:\nQuarterly revenue was $42.");
    bridge.stop();
  });
});

describe("remote-turn attempt leases", () => {
  it("fails closed when the claim is not positively acquired", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    let runCalls = 0;
    let heartbeatCalls = 0;
    let completionCalls = 0;

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) =>
          attemptReceipt(attemptId, {
            acquired: false,
            status: "busy",
            leaseExpiresAt: 0,
            hardExpiresAt: 0,
            quiescentAfterAt: 0,
          }),
        heartbeatRemoteTurn: async () => {
          heartbeatCalls += 1;
          return allowedHeartbeat();
        },
        runLocalTurn: async () => {
          runCalls += 1;
          return { status: "ok", finalText: "must not run" };
        },
        completeConnectorTurn: async () => {
          completionCalls += 1;
        },
        finishRemoteTurnAttempt: async () => {},
      },
      { createAttemptId: () => "attempt-denied" },
    );

    bridge.start();
    onUpdate?.([connectorRequest()]);
    await waitFor(() => bridge.getPendingRequestIds().length === 0);

    expect(runCalls).toBe(0);
    expect(heartbeatCalls).toBe(0);
    expect(completionCalls).toBe(0);
    bridge.stop();
  });

  it("uses one stable attempt id for claim, heartbeats, run, and completion", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const claimAttempts: string[] = [];
    const heartbeatAttempts: string[] = [];
    const runAttempts: string[] = [];
    const completionAttempts: string[] = [];
    const hardExpiresAt = Date.now() + 5_000;
    let releaseRun: (() => void) | null = null;

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) => {
          claimAttempts.push(attemptId);
          return attemptReceipt(attemptId, { hardExpiresAt });
        },
        heartbeatRemoteTurn: async ({ attemptId }) => {
          heartbeatAttempts.push(attemptId);
          return allowedHeartbeat({ hardExpiresAt });
        },
        runLocalTurn: async ({ attemptId, signal, confirmDispatchLease }) => {
          runAttempts.push(attemptId);
          expect(signal.aborted).toBe(false);
          await confirmDispatchLease();
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          return { status: "ok", finalText: "done" };
        },
        completeConnectorTurn: async ({ attemptId }) => {
          completionAttempts.push(attemptId);
        },
        finishRemoteTurnAttempt: async () => {},
      },
      {
        createAttemptId: () => "attempt-stable",
        heartbeatIntervalMs: 10,
      },
    );

    bridge.start();
    onUpdate?.([connectorRequest()]);
    await waitFor(() => heartbeatAttempts.length > 0);
    releaseRun?.();
    await waitFor(() => completionAttempts.length === 1);

    expect(claimAttempts).toEqual(["attempt-stable"]);
    expect(runAttempts).toEqual(["attempt-stable"]);
    expect(new Set(heartbeatAttempts)).toEqual(new Set(["attempt-stable"]));
    expect(completionAttempts).toEqual(["attempt-stable"]);
    bridge.stop();
  });

  it("joins a lease-denied run before sending its terminal ACK", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const order: string[] = [];
    const finished: Array<{ attemptId: string; outcome: string }> = [];
    let heartbeatCalls = 0;

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
        heartbeatRemoteTurn: async () => {
          heartbeatCalls += 1;
          return heartbeatCalls === 1
            ? allowedHeartbeat()
            : {
                allowed: false,
                cancelRequested: true,
                leaseExpiresAt: null,
                hardExpiresAt: null,
                quiescentAfterAt: null,
              };
        },
        runLocalTurn: async ({ signal, confirmDispatchLease }) => {
          await confirmDispatchLease();
          return await new Promise((resolve) => {
            const join = () => {
              order.push("abort-observed");
              setTimeout(() => {
                order.push("run-joined");
                resolve({
                  status: "error" as const,
                  finalText: "" as const,
                  error: "cancelled",
                });
              }, 10);
            };
            if (signal.aborted) join();
            else signal.addEventListener("abort", join, { once: true });
          });
        },
        completeConnectorTurn: async () => {
          order.push("unexpected-completion");
        },
        finishRemoteTurnAttempt: async ({ attemptId, outcome }) => {
          order.push("terminal-ack");
          finished.push({ attemptId, outcome });
        },
      },
      {
        createAttemptId: () => "attempt-cancelled",
        heartbeatIntervalMs: 10,
      },
    );

    bridge.start();
    onUpdate?.([connectorRequest()]);
    await waitFor(() => finished.length === 1);

    expect(order).toEqual(["abort-observed", "run-joined", "terminal-ack"]);
    expect(finished).toEqual([
      { attemptId: "attempt-cancelled", outcome: "aborted" },
    ]);
    bridge.stop();
  });

  it("times out an attempt at the last acknowledged deadline even if a heartbeat hangs", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const outcomes: string[] = [];
    let completionCalls = 0;
    let heartbeatCalls = 0;

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) => {
          const now = Date.now();
          return attemptReceipt(attemptId, {
            leaseExpiresAt: now + 40,
            hardExpiresAt: now + 1_000,
            quiescentAfterAt: now + 100,
          });
        },
        heartbeatRemoteTurn: async () => {
          heartbeatCalls += 1;
          return await new Promise<RemoteTurnAttemptHeartbeat>(() => {});
        },
        runLocalTurn: async ({ confirmDispatchLease }) => {
          // Let the scheduled pulse enter flight during local preparation.
          // Confirmation must still unblock when the last ACK expires.
          await new Promise((resolve) => setTimeout(resolve, 15));
          await confirmDispatchLease();
          return { status: "ok", finalText: "must not dispatch" };
        },
        completeConnectorTurn: async () => {
          completionCalls += 1;
        },
        finishRemoteTurnAttempt: async ({ outcome }) => {
          outcomes.push(outcome);
        },
      },
      {
        createAttemptId: () => "attempt-deadline",
        heartbeatIntervalMs: 10,
      },
    );

    bridge.start();
    onUpdate?.([connectorRequest()]);
    await waitFor(() => outcomes.length === 1);

    expect(outcomes).toEqual(["timed_out"]);
    expect(heartbeatCalls).toBe(1);
    expect(completionCalls).toBe(0);
    bridge.stop();
  });

  it("refuses physical dispatch when the final lifecycle pulse is denied", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    let physicalDispatches = 0;
    const outcomes: string[] = [];

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
        heartbeatRemoteTurn: async () => ({
          allowed: false,
          cancelRequested: true,
          leaseExpiresAt: null,
          hardExpiresAt: null,
          quiescentAfterAt: null,
        }),
        runLocalTurn: async ({ confirmDispatchLease }) => {
          await confirmDispatchLease();
          physicalDispatches += 1;
          return { status: "ok", finalText: "must not run" };
        },
        completeConnectorTurn: async () => {},
        finishRemoteTurnAttempt: async ({ outcome }) => {
          outcomes.push(outcome);
        },
      },
      { createAttemptId: () => "attempt-pre-dispatch" },
    );

    bridge.start();
    onUpdate?.([connectorRequest()]);
    await waitFor(() => outcomes.length === 1);

    expect(physicalDispatches).toBe(0);
    expect(outcomes).toEqual(["aborted"]);
    bridge.stop();
  });

  it("does not start after stop wins a claim race", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    let resolveClaim: ((receipt: RemoteTurnAttemptReceipt) => void) | undefined;
    let runCalls = 0;
    const finished: Array<{ attemptId: string; outcome: string }> = [];

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async () =>
          await new Promise<RemoteTurnAttemptReceipt>((resolve) => {
            resolveClaim = resolve;
          }),
        heartbeatRemoteTurn: async () => allowedHeartbeat(),
        runLocalTurn: async () => {
          runCalls += 1;
          return { status: "ok", finalText: "must not run" };
        },
        completeConnectorTurn: async () => {},
        finishRemoteTurnAttempt: async ({ attemptId, outcome }) => {
          finished.push({ attemptId, outcome });
        },
      },
      { createAttemptId: () => "attempt-stop-race" },
    );

    bridge.start();
    onUpdate?.([connectorRequest()]);
    await waitFor(() => resolveClaim !== undefined);
    bridge.stop();
    resolveClaim?.(attemptReceipt("attempt-stop-race"));
    await waitFor(() => finished.length === 1);

    expect(runCalls).toBe(0);
    expect(finished).toEqual([
      { attemptId: "attempt-stop-race", outcome: "aborted" },
    ]);
  });

  it("withholds terminal ACK after an ambiguous worker transport result", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    let completionCalls = 0;
    let finishCalls = 0;

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
        heartbeatRemoteTurn: async () => allowedHeartbeat(),
        runLocalTurn: async ({ confirmDispatchLease }) => {
          await confirmDispatchLease();
          return {
            status: "uncertain",
            finalText: "",
            error: "worker connection lost",
          };
        },
        completeConnectorTurn: async () => {
          completionCalls += 1;
        },
        finishRemoteTurnAttempt: async () => {
          finishCalls += 1;
        },
      },
      { createAttemptId: () => "attempt-uncertain" },
    );

    bridge.start();
    onUpdate?.([connectorRequest()]);
    await waitFor(() => bridge.getPendingRequestIds().length === 0);

    expect(completionCalls).toBe(0);
    expect(finishCalls).toBe(0);
    bridge.stop();
  });

  it("bounds a hung completion mutation and continues with the next request", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const completed: string[] = [];
    let attemptNumber = 0;

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
        heartbeatRemoteTurn: async () => allowedHeartbeat(),
        runLocalTurn: async () => ({ status: "ok", finalText: "done" }),
        completeConnectorTurn: async ({ requestId }) => {
          completed.push(requestId);
          if (requestId === "request-hung-complete") {
            return await new Promise<void>(() => {});
          }
        },
        finishRemoteTurnAttempt: async () => {},
      },
      {
        createAttemptId: () => `attempt-${++attemptNumber}`,
        terminalRetryAttempts: 1,
        terminalRpcTimeoutMs: 20,
      },
    );

    bridge.start();
    const firstRequest = connectorRequest("request-hung-complete");
    onUpdate?.([
      firstRequest,
      {
        ...connectorRequest("request-after-complete"),
        timestamp: firstRequest.timestamp + 1,
      },
    ]);
    await waitFor(() => completed.includes("request-after-complete"));

    expect(completed).toEqual([
      "request-hung-complete",
      "request-after-complete",
    ]);
    bridge.stop();
  });

  it("bounds a hung failure ACK and continues with the next request", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const finished: string[] = [];
    const completed: string[] = [];
    let attemptNumber = 0;

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
        heartbeatRemoteTurn: async () => allowedHeartbeat(),
        runLocalTurn: async ({ requestId }) =>
          requestId === "request-hung-finish"
            ? { status: "error", finalText: "", error: "failed" }
            : { status: "ok", finalText: "done" },
        completeConnectorTurn: async ({ requestId }) => {
          completed.push(requestId);
        },
        finishRemoteTurnAttempt: async ({ requestId }) => {
          finished.push(requestId);
          return await new Promise<void>(() => {});
        },
      },
      {
        createAttemptId: () => `attempt-${++attemptNumber}`,
        terminalRetryAttempts: 1,
        terminalRpcTimeoutMs: 20,
      },
    );

    bridge.start();
    const firstRequest = connectorRequest("request-hung-finish");
    onUpdate?.([
      firstRequest,
      {
        ...connectorRequest("request-after-finish"),
        timestamp: firstRequest.timestamp + 1,
      },
    ]);
    await waitFor(() => completed.includes("request-after-finish"));

    expect(finished).toEqual(["request-hung-finish"]);
    expect(completed).toEqual(["request-after-finish"]);
    bridge.stop();
  });

  it("interrupts a hung completion on stop and can process after restart", async () => {
    let onUpdate: ((events: RemoteTurnRequestEvent[]) => void) | null = null;
    const completed: string[] = [];
    let attemptNumber = 0;

    const bridge = createRemoteTurnBridge(
      {
        deviceId: "desktop-1",
        isEnabled: () => true,
        isRunnerBusy: () => false,
        subscribeRemoteTurnRequests: ({ onUpdate: nextOnUpdate }) => {
          onUpdate = nextOnUpdate;
          return () => {};
        },
        claimRemoteTurn: async ({ attemptId }) => attemptReceipt(attemptId),
        heartbeatRemoteTurn: async () => allowedHeartbeat(),
        runLocalTurn: async () => ({ status: "ok", finalText: "done" }),
        completeConnectorTurn: async ({ requestId }) => {
          completed.push(requestId);
          if (requestId === "request-stop-hung") {
            return await new Promise<void>(() => {});
          }
        },
        finishRemoteTurnAttempt: async () => {},
      },
      {
        createAttemptId: () => `attempt-${++attemptNumber}`,
        terminalRetryAttempts: 1,
        terminalRpcTimeoutMs: 5_000,
      },
    );

    bridge.start();
    onUpdate?.([connectorRequest("request-stop-hung")]);
    await waitFor(() => completed.includes("request-stop-hung"));
    bridge.stop();
    bridge.start();
    onUpdate?.([connectorRequest("request-after-stop")]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    bridge.kick();
    await waitFor(() => completed.includes("request-after-stop"));

    expect(completed).toEqual(["request-stop-hung", "request-after-stop"]);
    bridge.stop();
  });
});

describe("remote-turn host dispatch contract", () => {
  const makeHostHarness = () => {
    const host = Object.create(StellaRuntimeHost.prototype) as any;
    host.started = true;
    host.hostReady = true;
    host.connectorTargetsByLocalConversation = new Map();
    host.localConversationByRequestId = new Map();
    host.remoteTurnAttemptsByRequestId = new Map();
    host.pendingRemoteTurnCancelsByRequestId = new Map();
    host.cancelledRequestIds = new Set();
    host.connectorFollowupOutbox = null;
    host.remoteTurnWorkerRetirementPromise = null;
    host.workerController = {
      stop: vi.fn().mockResolvedValue(undefined),
      ensureStarted: vi.fn().mockResolvedValue(undefined),
    };
    return host;
  };

  const makeBinding = (overrides: Record<string, unknown> = {}) => ({
    requestId: "request-b",
    attemptId: "attempt-b",
    conversationId: "backend-conversation",
    localConversationId: "local-conversation",
    runId: remoteTurnWorkerRunId("attempt-b"),
    signal: { aborted: false },
    previousConnectorTarget: {
      requestId: "request-a",
      backendConversationId: "backend-a",
      initialTurnCompleted: true,
      attemptId: "attempt-a",
    },
    published: false,
    admitted: false,
    admissionDenied: false,
    cancelRequested: false,
    cancelJoined: false,
    cancelJoinPromise: null,
    workerRequestSent: true,
    workerSettled: false,
    workerRetired: false,
    transportAmbiguous: false,
    ...overrides,
  });

  it("keeps the prior route on busy/pre-dispatch failure and replaces it only after exact admission", () => {
    const host = makeHostHarness();
    const binding = makeBinding();
    host.connectorTargetsByLocalConversation.set(
      binding.localConversationId,
      binding.previousConnectorTarget,
    );
    host.localConversationByRequestId.set(
      binding.previousConnectorTarget.requestId,
      binding.localConversationId,
    );
    host.remoteTurnAttemptsByRequestId.set(binding.requestId, binding);

    // Busy and pre-dispatch failures never receive the worker admission call.
    host.rollbackRemoteTurnConnectorTarget(binding);
    expect(
      host.connectorTargetsByLocalConversation.get(binding.localConversationId)
        ?.requestId,
    ).toBe("request-a");
    expect(host.localConversationByRequestId.has("request-b")).toBe(false);

    const receipt = host.admitRemoteTurnAttempt({
      requestId: binding.requestId,
      attemptId: binding.attemptId,
      conversationId: binding.localConversationId,
      runId: binding.runId,
    });
    expect(receipt).toEqual({
      accepted: true,
      attemptId: "attempt-b",
      runId: remoteTurnWorkerRunId("attempt-b"),
    });
    expect(
      host.connectorTargetsByLocalConversation.get(binding.localConversationId),
    ).toMatchObject({ requestId: "request-b", attemptId: "attempt-b" });

    host.rollbackRemoteTurnConnectorTarget(binding);
    expect(
      host.connectorTargetsByLocalConversation.get(binding.localConversationId),
    ).toMatchObject({ requestId: "request-a", attemptId: "attempt-a" });
    expect(host.localConversationByRequestId.has("request-b")).toBe(false);
  });

  it("denies admission after a cancel arrives before worker registration", () => {
    const host = makeHostHarness();
    const binding = makeBinding({ cancelRequested: true });
    host.connectorTargetsByLocalConversation.set(
      binding.localConversationId,
      binding.previousConnectorTarget,
    );
    host.remoteTurnAttemptsByRequestId.set(binding.requestId, binding);

    expect(
      host.admitRemoteTurnAttempt({
        requestId: binding.requestId,
        attemptId: binding.attemptId,
        conversationId: binding.localConversationId,
        runId: binding.runId,
      }),
    ).toMatchObject({ accepted: false, attemptId: "attempt-b" });
    expect(
      host.connectorTargetsByLocalConversation.get(binding.localConversationId)
        ?.requestId,
    ).toBe("request-a");
  });

  it("retries a false exact cancel until the worker positively joins it", async () => {
    const host = makeHostHarness();
    const binding = makeBinding();
    host.remoteTurnAttemptsByRequestId.set(binding.requestId, binding);
    host.cancelChat = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, cancelled: false })
      .mockResolvedValueOnce({ ok: true, cancelled: false })
      .mockResolvedValueOnce({ ok: true, cancelled: true });

    await expect(host.requestRemoteTurnCancellation(binding)).resolves.toBe(
      true,
    );
    expect(host.cancelChat).toHaveBeenCalledTimes(3);
    expect(host.cancelChat).toHaveBeenCalledWith(binding.runId);
    expect(binding.cancelJoined).toBe(true);
    expect(host.workerController.stop).not.toHaveBeenCalled();
  });

  it("retires and restarts the worker when exact cancellation is ambiguous", async () => {
    const host = makeHostHarness();
    const binding = makeBinding();
    const order: string[] = [];
    host.remoteTurnAttemptsByRequestId.set(binding.requestId, binding);
    host.cancelChat = vi.fn().mockRejectedValue(new Error("peer disconnected"));
    host.workerController.stop = vi.fn().mockImplementation(async () => {
      order.push("worker-stopped");
    });
    host.workerController.ensureStarted = vi.fn().mockImplementation(async () => {
      order.push("worker-restarted");
    });

    await expect(host.requestRemoteTurnCancellation(binding)).resolves.toBe(
      true,
    );
    order.push("terminal-safe");

    expect(order).toEqual([
      "worker-stopped",
      "worker-restarted",
      "terminal-safe",
    ]);
    expect(binding.workerRetired).toBe(true);
    expect(binding.cancelJoined).toBe(true);
  });

  it("keeps worker startup and the final lease fence adjacent to exact dispatch", () => {
    const source = readFileSync(
      new URL("../../../../../runtime/host/index.js", import.meta.url),
      "utf8",
    );
    const bridgeStart = source.indexOf("ensureHostRemoteTurnBridge() {");
    const bridgeEnd = source.indexOf(
      "async syncHostExecutionPlacement()",
      bridgeStart,
    );
    const bridgeSource = source.slice(bridgeStart, bridgeEnd);
    const confirmationIndex = bridgeSource.indexOf(
      "await confirmDispatchLease();",
    );
    const workerStartupIndex = bridgeSource.indexOf(
      "await this.ensureWorkerStarted();",
    );
    const dispatchIndex = bridgeSource.indexOf(
      "const workerRunPromise = this.requestWorker",
    );

    expect(workerStartupIndex).toBeGreaterThan(0);
    expect(confirmationIndex).toBeGreaterThan(workerStartupIndex);
    expect(dispatchIndex).toBeGreaterThan(confirmationIndex);
    expect(bridgeSource).toContain("rejectIfBusy: true");
    expect(bridgeSource).toContain("retryOnceOnDisconnect: false");
    expect(bridgeSource).toContain("ensureWorker: false");
    expect(bridgeSource).toContain("remoteTurnAttemptId: attemptId");
    expect(bridgeSource).toContain('status: "uncertain"');
    expect(bridgeSource).toContain("requestRemoteTurnCancellation(binding)");
  });
});
