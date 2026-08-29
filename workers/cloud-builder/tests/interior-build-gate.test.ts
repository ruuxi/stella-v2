import { describe, expect, mock, test } from "bun:test";
import { interiorBuildRequestKey } from "../src/interior-build-request.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
}));
const { BuildSession } = await import("../src/index.js");
mock.restore();

type InteriorOutcome = {
  outcome: "not_requested" | "abandoned" | "failed" | "published";
  error?: string;
  candidate?: { buildId: string };
};

const turn = {
  kind: "agent" as const,
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  turnId: "turn-1",
  attemptGeneration: 1,
  threadId: "thread-1",
  workspace: "stella",
  prompt: "prompt",
  turnToken: "token",
  convexCallbackBase: "https://convex.example",
};

const gateHarness = (
  options: {
    requested?: boolean;
    storedRecord?: unknown;
    publish?: () => Promise<{ buildId: string }>;
    ownsExactTurn?: boolean;
    terminal?: boolean;
  } = {},
) => {
  const values = new Map<string, unknown>();
  if (options.requested || options.storedRecord !== undefined) {
    values.set(
      interiorBuildRequestKey(turn.turnId, turn.attemptGeneration),
      options.storedRecord ?? {
        schemaVersion: 1,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration,
        requestedAt: 1,
      },
    );
  }
  if (options.terminal) values.set("terminal", true);
  const events: string[] = [];
  let publishCalls = 0;
  const instance = Object.create(BuildSession.prototype) as Record<
    string,
    unknown
  >;
  Object.assign(instance, {
    ctx: {
      storage: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
      },
    },
    env: {},
    event: async (
      _turn: unknown,
      _seq: string,
      kind: string,
    ): Promise<void> => {
      events.push(kind);
    },
    ownsExactTurn: async () => options.ownsExactTurn ?? true,
    publishInteriorCandidate: async () => {
      publishCalls += 1;
      return await (options.publish?.() ??
        Promise.resolve({ buildId: "build-1" }));
    },
  });
  const run = async (): Promise<InteriorOutcome> => {
    const gate = (
      BuildSession.prototype as unknown as Record<string, unknown>
    )["publishRequestedInteriorCandidate"] as (
      this: Record<string, unknown>,
      args: Record<string, unknown>,
    ) => Promise<InteriorOutcome>;
    return await gate.call(instance, {
      turn,
      sandbox: {},
      sourceWorkspace: "stella",
      workspaceRoot: "/workspace/stella",
      commandTimeoutMs: 120_000,
      turnExecution: {
        signal: new AbortController().signal,
        assertActive: () => undefined,
      },
    });
  };
  return { run, events, publishCalls: () => publishCalls };
};

describe("stella interior build gate", () => {
  test("a successful turn without the broker request publishes nothing", async () => {
    const harness = gateHarness();
    expect(await harness.run()).toEqual({ outcome: "not_requested" });
    expect(harness.publishCalls()).toBe(0);
    expect(harness.events).toEqual([]);
  });

  test("the broker request is what makes the candidate build run", async () => {
    const harness = gateHarness({ requested: true });
    expect(await harness.run()).toEqual({
      outcome: "published",
      candidate: { buildId: "build-1" },
    });
    expect(harness.publishCalls()).toBe(1);
    expect(harness.events).toEqual([
      "interior_build_started",
      "interior_candidate_created",
    ]);
  });

  test("a record left by another attempt does not publish", async () => {
    const harness = gateHarness({
      storedRecord: {
        schemaVersion: 1,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration + 1,
        requestedAt: 1,
      },
    });
    expect(await harness.run()).toEqual({ outcome: "not_requested" });
    expect(harness.publishCalls()).toBe(0);
  });

  test("a failed requested build reports the failure and keeps the source", async () => {
    const harness = gateHarness({
      requested: true,
      publish: () => Promise.reject(new Error("vite exploded")),
    });
    const result = await harness.run();
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("source changes were kept");
    expect(harness.events).toEqual([
      "interior_build_started",
      "interior_build_failed",
    ]);
  });

  test("a superseded turn abandons the sandbox instead of reporting", async () => {
    const harness = gateHarness({
      requested: true,
      publish: () => Promise.reject(new Error("aborted")),
      ownsExactTurn: false,
    });
    expect(await harness.run()).toEqual({ outcome: "abandoned" });
    expect(harness.events).toEqual(["interior_build_started"]);
  });
});
