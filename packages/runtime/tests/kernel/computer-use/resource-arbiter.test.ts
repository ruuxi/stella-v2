import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  type ComputerUseAction,
  type ComputerUseRequest,
  type ComputerUseResponse,
  type ComputerUseTarget,
} from "@stella/runtime/kernel/computer-use/contract";
import {
  ComputerUseResourceStaleError,
  ComputerUseResourceArbiter,
} from "@stella/runtime/kernel/computer-use/resource-arbiter";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const envelope = (request: ComputerUseRequest) => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: request.requestId,
  sessionId: request.sessionId,
});

const target = (app: string): ComputerUseTarget => ({ type: "app", app });

const stateRequest = (
  sessionId: string,
  requestTarget: ComputerUseTarget,
): Extract<ComputerUseRequest, { type: "get_app_state" }> => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: `${sessionId}-state`,
  sessionId,
  type: "get_app_state",
  target: requestTarget,
  screenshotPolicy: "never",
  disableDiff: false,
});

const waitRequest = (
  sessionId: string,
  requestTarget: ComputerUseTarget,
): Extract<ComputerUseRequest, { type: "wait_for_change" }> => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: `${sessionId}-wait`,
  sessionId,
  type: "wait_for_change",
  target: requestTarget,
  afterStateId: "state_baseline",
  timeoutMs: 1_000,
  screenshotPolicy: "never",
  disableDiff: false,
});

const actionRequest = (
  sessionId: string,
  requestTarget: ComputerUseTarget,
  action: ComputerUseAction = {
    type: "click_element",
    elementId: "42",
    mouseButton: "left",
    clickCount: 1,
  },
): Extract<ComputerUseRequest, { type: "action" }> => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: `${sessionId}-request`,
  sessionId,
  type: "action",
  execution: "background",
  command: {
    target: requestTarget,
    action,
    observedStateId: `${sessionId}-state-observed`,
  },
});

const batchRequest = (
  sessionId: string,
  targets: readonly ComputerUseTarget[],
): Extract<ComputerUseRequest, { type: "batch" }> => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: `${sessionId}-request`,
  sessionId,
  type: "batch",
  execution: "background",
  commands: targets.map((requestTarget, index) => ({
    target: requestTarget,
    observedStateId: `${sessionId}-state-observed`,
    action: {
      type: "click_element",
      elementId: String(index + 1),
      mouseButton: "left",
      clickCount: 1,
    },
  })),
});

const responseFor = (request: ComputerUseRequest): ComputerUseResponse => {
  if (request.type === "resolve_target") {
    return {
      ...envelope(request),
      type: "target_policy",
      policy: {
        bundleIdentifier: "com.brave.Browser",
        displayName: "Brave Browser",
        decision: "allowed",
        allowPersistentApproval: true,
      },
    };
  }
  if (request.type === "batch") {
    return {
      ...envelope(request),
      type: "batch",
      receipt: {
        type: "batch",
        receipts: request.commands.map((command) => ({
          type: "action",
          action: command.action.type,
          target: command.target,
          status: "completed",
          deferred: false,
        })),
      },
    };
  }
  if (request.type === "get_app_state") {
    return {
      ...envelope(request),
      type: "app_state",
      state: {
        app: request.target.type === "app" ? request.target.app : "test-app",
        text: "test state",
        screenshot: null,
      },
    };
  }
  if (request.type === "wait_for_change") {
    return {
      ...envelope(request),
      type: "wait_for_change",
      state: {
        app: request.target.type === "app" ? request.target.app : "test-app",
        text: "changed state",
        screenshot: null,
        semanticStateId: "state_changed",
        wait: {
          afterStateId: request.afterStateId,
          timeoutMs: request.timeoutMs,
          elapsedMs: 1,
          pollCount: 1,
          changeKinds: ["semantic"],
        },
      },
    };
  }
  if (request.type !== "action") {
    throw new Error(`Unexpected test request: ${request.type}`);
  }
  return {
    ...envelope(request),
    type: "action",
    receipt: {
      type: "action",
      action: request.command.action.type,
      target: request.command.target,
      status: "completed",
      deferred: false,
    },
  };
};

const failureFor = (
  request: ComputerUseRequest,
): Extract<ComputerUseResponse, { type: "error" }> => ({
  ...envelope(request),
  type: "error",
  error: { code: "test_failure", message: "test failure", retryable: false },
});

const observe = async (
  arbiter: ComputerUseResourceArbiter,
  sessionId: string,
  requestTarget: ComputerUseTarget,
) => {
  const request = stateRequest(sessionId, requestTarget);
  await arbiter.runRequest(request, undefined, async () =>
    responseFor(request),
  );
};

describe("ComputerUseResourceArbiter", () => {
  it("serializes the same target across sessions", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const gate = deferred();
    const started: string[] = [];
    const firstRequest = stateRequest("agent-a", target("Brave"));
    const secondRequest = stateRequest("agent-b", target("Brave"));

    const first = arbiter.runRequest(firstRequest, undefined, async () => {
      started.push("a");
      await gate.promise;
      return failureFor(firstRequest);
    });
    const second = arbiter.runRequest(secondRequest, undefined, async () => {
      started.push("b");
      return failureFor(secondRequest);
    });

    await vi.waitFor(() => expect(started).toEqual(["a"]));
    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(["a", "b"]);
  });

  it("allows unrelated applications to run concurrently", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const gate = deferred();
    let active = 0;
    let maxActive = 0;
    const run = (request: Extract<ComputerUseRequest, { type: "action" }>) =>
      arbiter.runRequest(request, undefined, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
        return responseFor(request);
      });

    await observe(arbiter, "agent-a", target("Notes"));
    await observe(arbiter, "agent-b", target("Spotify"));

    const first = run(actionRequest("agent-a", target("Notes")));
    const second = run(actionRequest("agent-b", target("Spotify")));
    await vi.waitFor(() => expect(maxActive).toBe(2));
    gate.resolve();
    await Promise.all([first, second]);
  });

  it("serializes global HID actions even when applications differ", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const gate = deferred();
    const started: string[] = [];
    const firstRequest = actionRequest("agent-a", target("Notes"), {
      type: "press_key",
      key: "Enter",
    });
    const secondRequest = actionRequest("agent-b", target("Spotify"), {
      type: "type_text",
      text: "query",
    });
    await observe(arbiter, "agent-a", target("Notes"));
    await observe(arbiter, "agent-b", target("Spotify"));

    const first = arbiter.runRequest(firstRequest, undefined, async () => {
      started.push("a");
      await gate.promise;
      return failureFor(firstRequest);
    });
    const second = arbiter.runRequest(secondRequest, undefined, async () => {
      started.push("b");
      return failureFor(secondRequest);
    });

    await vi.waitFor(() => expect(started).toEqual(["a"]));
    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(["a", "b"]);
  });

  it("acquires batch resources in a stable order and rejects the queued stale batch", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const gate = deferred();
    const started: string[] = [];
    const firstRequest = batchRequest("agent-a", [
      target("Notes"),
      target("Brave"),
    ]);
    const secondRequest = batchRequest("agent-b", [
      target("Brave"),
      target("Notes"),
    ]);
    await observe(arbiter, "agent-a", target("Notes"));
    await observe(arbiter, "agent-a", target("Brave"));
    await observe(arbiter, "agent-b", target("Notes"));
    await observe(arbiter, "agent-b", target("Brave"));

    const first = arbiter.runRequest(firstRequest, undefined, async () => {
      started.push("a");
      await gate.promise;
      return failureFor(firstRequest);
    });
    const second = arbiter.runRequest(secondRequest, undefined, async () => {
      started.push("b");
      return failureFor(secondRequest);
    });

    await vi.waitFor(() => expect(started).toEqual(["a"]));
    gate.resolve();
    await first;
    await expect(second).rejects.toMatchObject({
      code: "stale_observation",
      currentResourceGeneration: 1,
    });
    expect(started).toEqual(["a"]);
  });

  it("removes an aborted waiter without leaking the resource lock", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const gate = deferred();
    const started: string[] = [];
    const controller = new AbortController();

    const first = arbiter.run(["app:brave"], undefined, async () => {
      started.push("a");
      await gate.promise;
    });
    const aborted = arbiter.run(["app:brave"], controller.signal, async () => {
      started.push("b");
    });
    const final = arbiter.run(["app:brave"], undefined, async () => {
      started.push("c");
    });

    await vi.waitFor(() => expect(started).toEqual(["a"]));
    controller.abort(new Error("agent-b canceled"));
    await expect(aborted).rejects.toThrow("agent-b canceled");
    gate.resolve();
    await Promise.all([first, final]);
    expect(started).toEqual(["a", "c"]);
  });

  it("uses resolved bundle identities to unify app-name aliases", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const resolveName = {
      schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
      protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
      requestId: "resolve-name",
      sessionId: "agent-a",
      type: "resolve_target",
      selector: target("Brave"),
    } as const satisfies ComputerUseRequest;
    const resolveBundle = {
      ...resolveName,
      requestId: "resolve-bundle",
      sessionId: "agent-b",
      selector: target("com.brave.Browser"),
    } as const satisfies ComputerUseRequest;
    await arbiter.runRequest(resolveName, undefined, async () =>
      responseFor(resolveName),
    );
    await arbiter.runRequest(resolveBundle, undefined, async () =>
      responseFor(resolveBundle),
    );

    const gate = deferred();
    const started: string[] = [];
    const firstRequest = stateRequest("agent-a", target("Brave"));
    const secondRequest = stateRequest("agent-b", target("com.brave.Browser"));
    const first = arbiter.runRequest(firstRequest, undefined, async () => {
      started.push("a");
      await gate.promise;
      return responseFor(firstRequest);
    });
    const second = arbiter.runRequest(secondRequest, undefined, async () => {
      started.push("b");
      return responseFor(secondRequest);
    });

    await vi.waitFor(() => expect(started).toEqual(["a"]));
    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(["a", "b"]);
  });

  it("rejects a session whose cross-session resource generation is stale", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const brave = target("Brave");
    await observe(arbiter, "agent-a", brave);
    await observe(arbiter, "agent-b", brave);

    const mutation = actionRequest("agent-b", brave);
    await arbiter.runRequest(mutation, undefined, async () =>
      responseFor(mutation),
    );

    const staleAction = actionRequest("agent-a", brave);
    await expect(
      arbiter.runRequest(staleAction, undefined, async () =>
        responseFor(staleAction),
      ),
    ).rejects.toMatchObject({
      code: "stale_observation",
      observedStateId: "agent-a-state-observed",
      currentResourceGeneration: 1,
      resourceKeys: ["app:brave"],
    });
  });

  it("invalidates the mutating session's explicit pre-action generation", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const brave = target("Brave");
    await observe(arbiter, "agent-a", brave);

    const first = actionRequest("agent-a", brave);
    const second = {
      ...actionRequest("agent-a", brave),
      requestId: "second",
      command: {
        ...actionRequest("agent-a", brave).command,
        observedResourceGeneration: 0,
      },
    };
    await arbiter.runRequest(first, undefined, async () => responseFor(first));
    await expect(
      arbiter.runRequest(second, undefined, async () => responseFor(second)),
    ).rejects.toMatchObject({
      code: "stale_observation",
      observedResourceGeneration: 0,
      currentResourceGeneration: 1,
    });
  });

  it("invalidates prior observations when mutation dispatch throws", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const brave = target("Brave");
    await observe(arbiter, "agent-a", brave);

    const dispatched = actionRequest("agent-a", brave);
    await expect(
      arbiter.runRequest(dispatched, undefined, async () => {
        throw new Error("transport failed after dispatch");
      }),
    ).rejects.toThrow("transport failed after dispatch");

    let retryDispatched = false;
    const retry = { ...actionRequest("agent-a", brave), requestId: "retry" };
    await expect(
      arbiter.runRequest(retry, undefined, async () => {
        retryDispatched = true;
        return responseFor(retry);
      }),
    ).rejects.toMatchObject({
      code: "stale_observation",
      currentResourceGeneration: 1,
    });
    expect(retryDispatched).toBe(false);
  });

  it("invalidates prior observations when mutation dispatch returns an error", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const brave = target("Brave");
    await observe(arbiter, "agent-a", brave);

    const dispatched = actionRequest("agent-a", brave);
    const failure: ComputerUseResponse = {
      ...envelope(dispatched),
      type: "error",
      error: {
        code: "native_dispatch_failed",
        message: "the mutation outcome is unknown",
        retryable: true,
      },
    };
    await expect(
      arbiter.runRequest(dispatched, undefined, async () => failure),
    ).resolves.toBe(failure);

    const retry = { ...actionRequest("agent-a", brave), requestId: "retry" };
    await expect(
      arbiter.runRequest(retry, undefined, async () => responseFor(retry)),
    ).rejects.toMatchObject({
      code: "stale_observation",
      currentResourceGeneration: 1,
    });
  });

  it("rejects a wait result when the resource changes while polling unlocked", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const brave = target("Brave");
    await observe(arbiter, "agent-a", brave);
    await observe(arbiter, "agent-b", brave);

    const wait = waitRequest("agent-a", brave);
    const started = deferred();
    const release = deferred();
    const waiting = arbiter.runRequest(wait, undefined, async () => {
      started.resolve();
      await release.promise;
      return responseFor(wait);
    });
    await started.promise;

    const mutation = actionRequest("agent-b", brave);
    await arbiter.runRequest(mutation, undefined, async () =>
      responseFor(mutation),
    );
    release.resolve();

    await expect(waiting).rejects.toMatchObject({
      code: "stale_observation",
      observedStateId: "state_baseline",
      observedResourceGeneration: 0,
      currentResourceGeneration: 1,
      resourceKeys: ["app:brave"],
    });
  });

  it("reports explicit stale state ids with the current replacement", () => {
    const error = new ComputerUseResourceStaleError("state_old", "state_new");
    expect(error).toMatchObject({
      code: "stale_observation",
      retryable: true,
      observedStateId: "state_old",
      currentStateId: "state_new",
      message: expect.stringContaining("current_state_id=state_new"),
    });
  });
});
