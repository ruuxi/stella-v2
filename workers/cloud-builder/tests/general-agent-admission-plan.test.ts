import { describe, expect, mock, test } from "bun:test";
import { ExactTurnCancellationLedger } from "../src/execution-placement-turn-cancellation.js";
import {
  parseTurnComputePlan,
  turnComputePlanKey,
} from "../src/general-agent-turn.js";
import { worldSandboxId } from "../src/workspace.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
  ContainerProxy: class {},
}));
const { BuildSession } = await import("../src/index.js");
mock.restore();

const STELLA = {
  engine: "stella",
  provider: "stella",
  model: "stella/default",
  reasoningEffort: "default",
} as const;

const ANTHROPIC = {
  engine: "anthropic",
  provider: "anthropic",
  model: "claude/sonnet",
  reasoningEffort: "default",
} as const;

const agentTurn = (overrides: Record<string, unknown> = {}) => ({
  kind: "agent",
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  appId: "agent",
  turnId: "turn-1",
  threadId: "thread-1",
  attemptGeneration: 1,
  prompt: "hello",
  execution: STELLA,
  turnBrokerRoute: {
    sessionId: "session-1",
    endpoint: "https://broker.example",
  },
  ...overrides,
});

const admissionHarness = (env: Record<string, unknown> = {}) => {
  let alarm: number | null = null;
  const values = new Map<string, unknown>();
  const put = async (
    key: string | Record<string, unknown>,
    value?: unknown,
  ) => {
    if (typeof key === "string") {
      values.set(key, structuredClone(value));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      values.set(entryKey, structuredClone(entryValue));
    }
  };
  const remove = async (key: string | string[]) => {
    if (Array.isArray(key)) {
      for (const entry of key) values.delete(entry);
      return true;
    }
    return values.delete(key);
  };
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put,
    delete: remove,
    deleteAll: async () => values.clear(),
    list: async <T>({ prefix = "" }: { prefix?: string } = {}) =>
      new Map(
        [...values.entries()].filter(([key]) => key.startsWith(prefix)),
      ) as Map<string, T>,
    transaction: async <T>(operation: (txn: unknown) => Promise<T>) =>
      await operation({
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put,
        delete: remove,
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => {
          alarm = at;
        },
        deleteAlarm: async () => {
          alarm = null;
        },
      }),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const started: Array<string | undefined> = [];
  const instance = Object.create(BuildSession.prototype) as BuildSession &
    Record<string, unknown>;
  Object.assign(instance, {
    ctx: {
      storage,
      id: { name: "thread-1", toString: () => "thread-1" },
      waitUntil: () => undefined,
      blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
        await operation(),
    },
    env: { BUILDER_SERVICE_SECRET: "builder-secret", ...env },
    exactTurnCancellations: new ExactTurnCancellationLedger(storage),
    runningTurns: new Map<string, Set<Promise<unknown>>>(),
    agentTurnExecutions: new Map<string, unknown>(),
    unregisterTurn: async () => undefined,
    startAgentTurn: async (_turn: unknown, sandboxId?: string) => {
      started.push(sandboxId);
    },
  });
  return { instance, values, started };
};

const admit = async (
  harness: ReturnType<typeof admissionHarness>,
  turn: Record<string, unknown>,
): Promise<Response> => {
  const accept = (BuildSession.prototype as unknown as Record<string, unknown>)[
    "acceptAgentTurn"
  ] as (
    this: BuildSession & Record<string, unknown>,
    turn: Record<string, unknown>,
  ) => Promise<Response>;
  return await accept.call(harness.instance, turn);
};

const expectedSandboxId = async (
  turn: ReturnType<typeof agentTurn>,
): Promise<string> => await worldSandboxId(turn.ownerId);

const storedPlan = (
  harness: ReturnType<typeof admissionHarness>,
  turnId: string,
  attemptGeneration: number,
) =>
  parseTurnComputePlan(
    harness.values.get(turnComputePlanKey(turnId, attemptGeneration)),
    { turnId, attemptGeneration },
  );

describe("agent turn admission records its placement", () => {
  test("the kill switch defaults on, so a stella turn is admitted resident", async () => {
    const harness = admissionHarness();

    const response = await admit(harness, agentTurn());

    expect(response.status).toBe(202);
    expect(storedPlan(harness, "turn-1", 1)).toMatchObject({
      plan: { kind: "resident_stella" },
      engine: "stella",
      residentDisabled: false,
      browserResume: false,
    });
  });

  test("the kill switch demotes a stella turn to the container path", async () => {
    const harness = admissionHarness({ RESIDENT_GENERAL_AGENT_TURNS: "0" });
    const turn = agentTurn();

    await admit(harness, turn);

    expect(harness.values.get("sandboxId")).toBe(await expectedSandboxId(turn));
    expect(storedPlan(harness, "turn-1", 1)).toMatchObject({
      plan: { kind: "native_sandbox", reason: "resident_disabled" },
      residentDisabled: true,
    });
  });

  test("a native engine records native placement whatever the switch says", async () => {
    const harness = admissionHarness({ RESIDENT_GENERAL_AGENT_TURNS: "1" });
    const turn = agentTurn({ execution: ANTHROPIC });

    await admit(harness, turn);

    expect(storedPlan(harness, "turn-1", 1)).toMatchObject({
      plan: { kind: "native_sandbox", reason: "native_engine" },
      engine: "anthropic",
      residentDisabled: false,
    });
    expect(harness.values.get("sandboxId")).toBe(await expectedSandboxId(turn));
  });

  test("a resident placement reserves no container at admission", async () => {
    const harness = admissionHarness({ RESIDENT_GENERAL_AGENT_TURNS: "1" });

    await admit(harness, agentTurn());

    expect(storedPlan(harness, "turn-1", 1)).toMatchObject({
      plan: { kind: "resident_stella" },
      residentDisabled: false,
    });
    // Both cancellation sweeps destroy by this key. Its absence is what makes
    // a Stop on a chat-only turn a true no-op instead of a lookup that boots a
    // container to kill it.
    expect(harness.values.has("sandboxId")).toBe(false);
    expect(harness.started).toEqual([undefined]);
  });

  test("a turn dispatched without an engine selection records no plan", async () => {
    const harness = admissionHarness();
    const turn = agentTurn();
    delete (turn as Record<string, unknown>).execution;

    await admit(harness, turn);

    expect(harness.values.get(turnComputePlanKey("turn-1", 1))).toBeUndefined();
    expect(harness.values.get("sandboxId")).toBe(await expectedSandboxId(turn));
  });

  test("a stored plan pairing stella with native_engine is not trusted", async () => {
    const harness = admissionHarness();

    await admit(harness, agentTurn());
    const key = turnComputePlanKey("turn-1", 1);
    const stored = harness.values.get(key) as Record<string, unknown>;
    harness.values.set(key, {
      ...stored,
      plan: {
        kind: "native_sandbox",
        execution: STELLA,
        reason: "native_engine",
      },
    });

    expect(storedPlan(harness, "turn-1", 1)).toBeNull();
  });

  test("a plan from another attempt is never read as this attempt's", async () => {
    const harness = admissionHarness();

    await admit(harness, agentTurn());

    expect(storedPlan(harness, "turn-1", 2)).toBeNull();
    expect(storedPlan(harness, "turn-2", 1)).toBeNull();
  });
});
