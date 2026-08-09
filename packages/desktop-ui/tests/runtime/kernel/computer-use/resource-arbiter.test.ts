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
  ComputerUseResourceArbiter,
  macComputerUseResourceArbiter,
} from "@stella/runtime/kernel/computer-use/resource-arbiter";
import { createMacComputerUseSession } from "@stella/runtime/kernel/computer-use/stella-computer-executor";

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
  command: { target: requestTarget, action },
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

  it("acquires batch resources in a stable order and keeps the batch atomic", async () => {
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
    await Promise.all([first, second]);
    expect(started).toEqual(["a", "b"]);
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

  it("rejects an action when another session mutated its observed target", async () => {
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
      retryable: true,
      message: expect.stringContaining("get_app_state"),
    });
  });

  it("advances the mutating session so its own action sequence stays fresh", async () => {
    const arbiter = new ComputerUseResourceArbiter();
    const brave = target("Brave");
    await observe(arbiter, "agent-a", brave);

    const first = actionRequest("agent-a", brave);
    const second = { ...actionRequest("agent-a", brave), requestId: "second" };
    await arbiter.runRequest(first, undefined, async () => responseFor(first));
    await expect(
      arbiter.runRequest(second, undefined, async () => responseFor(second)),
    ).resolves.toMatchObject({ type: "action" });
  });

  it("maps stale observations to a retryable Computer Use response", async () => {
    const firstSessionId = "arbiter-response-agent-a";
    const secondSessionId = "arbiter-response-agent-b";
    const requestTarget = target("Arbiter Response Test App");
    try {
      await observe(
        macComputerUseResourceArbiter,
        firstSessionId,
        requestTarget,
      );
      await observe(
        macComputerUseResourceArbiter,
        secondSessionId,
        requestTarget,
      );
      const mutation = actionRequest(secondSessionId, requestTarget);
      await macComputerUseResourceArbiter.runRequest(
        mutation,
        undefined,
        async () => responseFor(mutation),
      );

      const staleAction = actionRequest(firstSessionId, requestTarget);
      const response = await createMacComputerUseSession({
        sessionId: firstSessionId,
      }).request(staleAction);
      expect(response).toMatchObject({
        type: "error",
        error: {
          code: "stale_observation",
          retryable: true,
          message: expect.stringContaining("get_app_state"),
        },
      });
    } finally {
      macComputerUseResourceArbiter.forgetSession(firstSessionId);
      macComputerUseResourceArbiter.forgetSession(secondSessionId);
    }
  });
});
