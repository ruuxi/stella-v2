import { describe, expect, mock, test } from "bun:test";
import type {
  ThreadCompletedEvent,
  ThreadSpawnedEvent,
  TurnStartedEvent,
} from "@stella/contracts/turn-plane/outbox";
import type { CloudTurnStartRequest } from "@stella/contracts/turn-plane/turn-start";
import { ExactTurnCancellationLedger } from "../src/execution-placement-turn-cancellation.js";
import { HEADER_GATE_ADMITTED } from "../src/turn-start-request.js";
import { readThreadHistory } from "../src/thread-transcript.js";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";
import {
  capabilitySignerEnv,
  fakeOutbox,
  fakeOwnerGates,
  sampleOwnerSnapshot,
} from "./helpers/turn-plane-fakes.js";

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

/**
 * The BuildSession half of an agent turn: who admits it through the owner
 * gate, what authority it runs under, what Convex learns about it, and when
 * the owner gets its agent slot back.
 */

const THREAD_ID = "thread-1";
const BROKER_ENDPOINT = `https://builder.example/sessions/${THREAD_ID}/turn-broker`;

const agentDispatch = (overrides: Record<string, unknown> = {}) => ({
  protocol: 1,
  kind: "agent",
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  conversationId: "conversation-1",
  threadId: THREAD_ID,
  attemptGeneration: 1,
  turnId: "turn-1",
  clientMsgId: "turn-1-client",
  prompt: "do the thing",
  description: "the thing",
  execution: {
    engine: "stella",
    provider: "stella",
    model: "stella/default",
    reasoningEffort: "default",
  },
  // Deliberately richer than the owner's allowance: the snapshot must win.
  audience: "pro",
  budgetMicroCents: 999_999_999,
  source: "agent-thread",
  parentTurnId: "parent-turn-1",
  ...overrides,
});

const harness = async (
  options: {
    gates?: ReturnType<typeof fakeOwnerGates>;
    orchestrator?: (request: Request) => Promise<Response>;
  } = {},
) => {
  const values = new Map<string, unknown>();
  const sqlFake = openSqlStorageFake();
  let alarm: number | null = null;
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
    for (const entry of Array.isArray(key) ? key : [key]) values.delete(entry);
    return true;
  };
  const get = async <T>(key: string) => values.get(key) as T | undefined;
  const storage = {
    sql: sqlFake.sql,
    get,
    put,
    delete: remove,
    list: async <T>({ prefix = "" }: { prefix?: string } = {}) =>
      new Map(
        [...values.entries()].filter(([key]) => key.startsWith(prefix)),
      ) as Map<string, T>,
    transaction: async <T>(operation: (txn: unknown) => Promise<T>) =>
      await operation({
        get,
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
  const gates = options.gates ?? fakeOwnerGates();
  const outbox = fakeOutbox();
  const orchestratorCalls: Array<{ request: Request; body: unknown }> = [];
  const instance = Object.create(BuildSession.prototype) as InstanceType<
    typeof BuildSession
  > &
    Record<string, unknown>;
  const started: string[] = [];
  Object.assign(instance, {
    ctx: {
      storage,
      id: { name: THREAD_ID, toString: () => THREAD_ID },
      waitUntil: () => undefined,
      blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
        await operation(),
    },
    env: {
      ...(await capabilitySignerEnv()),
      BUILDER_SERVICE_SECRET: "builder-secret",
      STELLA_CONVEX_SITE_URL: "https://convex.example",
      OWNER_GATES: gates.namespace,
      TURN_OUTBOX: outbox.queue,
      ORCHESTRATOR_SESSIONS: {
        getByName: () => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input as string, init);
            const body = await request.clone().json();
            orchestratorCalls.push({ request, body });
            return options.orchestrator
              ? await options.orchestrator(request)
              : Response.json({ accepted: true }, { status: 202 });
          },
        }),
      },
    },
    // Class fields are not initialized by Object.create.
    controlPlaneCapabilities: new Map(),
    exactTurnCancellations: new ExactTurnCancellationLedger(storage),
    runningTurns: new Map(),
    agentTurnExecutions: new Map(),
    appTurnExecutions: new Map(),
    residentAgentAborts: new Map(),
    builderFallbackRecoveries: new Set(),
    turnStateCheckpointRuns: new Map(),
    registerTurn: async (target: Record<string, unknown>) => {
      target.ownerPurgeLeaseId = `lease:${String(target.turnId)}`;
      return "purge-generation-1";
    },
    assertTurnWritable: async () => undefined,
    unregisterTurn: async () => undefined,
    unregisterTurnLease: async () => true,
    startAgentTurn: async (target: { turnId: string }) => {
      started.push(target.turnId);
    },
    terminateCurrentAgentSandbox: async () => undefined,
    settleAgentTransientBackup: async () => true,
    scheduleDurabilityAlarm: async () => undefined,
  });
  return {
    instance,
    values,
    storage,
    sql: sqlFake.sql,
    close: () => sqlFake.close(),
    gates,
    outbox,
    started,
    orchestratorCalls,
    /**
     * A second Durable Object over the same durable storage: what an eviction
     * and a later wake actually produce. Nothing in-memory carries over.
     */
    restart: () => {
      const replacement = Object.create(BuildSession.prototype) as InstanceType<
        typeof BuildSession
      > &
        Record<string, unknown>;
      Object.assign(replacement, instance, {
        controlPlaneCapabilities: new Map(),
        agentTurnExecutions: new Map(),
        runningTurns: new Map(),
      });
      return replacement;
    },
  };
};

/** Call a private BuildSession method with the harness instance as `this`. */
const invoke = <T>(
  instance: Record<string, unknown>,
  name: string,
  ...args: unknown[]
): T =>
  (instance[name] as (...rest: unknown[]) => T).call(instance, ...args) as T;

const dispatch = async (
  instance: Record<string, unknown>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  await (instance.fetch as (request: Request) => Promise<Response>)(
    new Request("https://build-session/turn", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stella-build-session-name": THREAD_ID,
        "x-stella-turn-broker-endpoint": BROKER_ENDPOINT,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

describe("BuildSession agent-turn admission", () => {
  test("the public service route admits through the owner gate itself", async () => {
    const h = await harness();

    const response = await dispatch(h.instance, agentDispatch());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      protocol: 1,
      threadId: THREAD_ID,
      turnId: "turn-1",
      attemptGeneration: 1,
      accepted: true,
      replayed: false,
    });
    expect(h.gates.admits).toHaveLength(1);
    expect(h.gates.admits[0]).toMatchObject({
      ownerId: "owner-1",
      input: {
        lane: "agent",
        turnId: "turn-1",
        conversationId: "conversation-1",
        workspace: "world",
        expectedGeneration: "generation-1",
      },
    });
    expect(h.started).toEqual(["turn-1"]);
    h.close();
  });

  test("an orchestrator dispatch is not admitted a second time", async () => {
    const h = await harness();

    const response = await dispatch(h.instance, agentDispatch(), {
      [HEADER_GATE_ADMITTED]: "1",
    });

    expect(response.status).toBe(202);
    expect(h.gates.admits).toEqual([]);
    // It still needs the snapshot: the allowance is the gate's, not the
    // dispatcher's.
    expect(h.gates.snapshots).toEqual(["owner-1"]);
    h.close();
  });

  test("the snapshot overrides the dispatcher's audience and budget hints", async () => {
    const h = await harness({
      gates: fakeOwnerGates({
        snapshot: sampleOwnerSnapshot({
          allowance: { audience: "free", budgetMicroCents: 1_000 },
        }),
      }),
    });

    await dispatch(h.instance, agentDispatch());

    expect(h.values.get("turn")).toMatchObject({
      audience: "free",
      budgetMicroCents: 1_000,
    });
    h.close();
  });

  test("projects the turn and, for a first attempt it admitted, the thread", async () => {
    const h = await harness();

    await dispatch(h.instance, agentDispatch());

    const started = h.outbox.events.find(
      (event): event is TurnStartedEvent => event.kind === "turn.started",
    );
    expect(started).toMatchObject({
      turnId: "turn-1",
      turnKind: "agent",
      lane: "agent",
      threadId: THREAD_ID,
      attemptGeneration: 1,
      conversationId: "conversation-1",
      sessionId: THREAD_ID,
      agentType: "general",
      source: "agent-thread",
      clientMsgId: "turn-1-client",
      prompt: "do the thing",
    });
    const spawned = h.outbox.events.find(
      (event): event is ThreadSpawnedEvent => event.kind === "thread.spawned",
    );
    expect(spawned).toMatchObject({
      threadId: THREAD_ID,
      conversationId: "conversation-1",
      parentTurnId: "parent-turn-1",
      attemptGeneration: 1,
      description: "the thing",
      placement: "cloud",
      workspace: "world",
    });
    h.close();
  });

  test("the orchestrator's own spawn projects only the turn", async () => {
    const h = await harness();

    await dispatch(h.instance, agentDispatch(), {
      [HEADER_GATE_ADMITTED]: "1",
    });

    // The orchestrator emits `thread.spawned` for the spawns it dispatches;
    // two would race for the same idempotency key.
    expect(h.outbox.events.map((event) => event.kind)).toEqual([
      "turn.started",
    ]);
    h.close();
  });

  test("a continuation projects the turn without respawning the thread", async () => {
    const h = await harness();

    await dispatch(
      h.instance,
      agentDispatch({ attemptGeneration: 2, turnId: "turn-2" }),
    );

    expect(h.outbox.events.map((event) => event.kind)).toEqual([
      "turn.started",
    ]);
    h.close();
  });

  test("a quota refusal answers the gate's code and never starts the turn", async () => {
    const h = await harness({
      gates: fakeOwnerGates({
        admit: () => ({
          ok: false,
          code: "quota_concurrency",
          message: "Your plan's agents are all busy. Wait for one to finish.",
          retryable: true,
          retryAfterMs: 5_000,
        }),
      }),
    });

    const response = await dispatch(h.instance, agentDispatch());

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: "quota_concurrency",
      retryable: true,
      retryAfterMs: 5_000,
    });
    expect(h.started).toEqual([]);
    expect(h.outbox.events).toEqual([]);
    h.close();
  });

  test("an execution the owner cannot honour is refused and gives the slot back", async () => {
    const h = await harness();

    const response = await dispatch(
      h.instance,
      agentDispatch({
        execution: {
          engine: "anthropic",
          provider: "anthropic",
          model: "claude",
          reasoningEffort: "default",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Connect Claude before using that cloud execution route.",
    });
    expect(h.gates.releases).toEqual([
      { ownerId: "owner-1", turnId: "turn-1" },
    ]);
    h.close();
  });

  test("a malformed dispatch is refused before the gate is consulted", async () => {
    const h = await harness();

    const response = await dispatch(
      h.instance,
      agentDispatch({ description: "" }),
    );

    expect(response.status).toBe(400);
    expect(h.gates.admits).toEqual([]);
    h.close();
  });

  test("a replayed dispatch of a running attempt answers replayed, not a second run", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    (h.instance.agentTurnExecutions as Map<string, unknown>).set("turn-1", {});

    const replay = await dispatch(h.instance, agentDispatch());

    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      accepted: true,
      replayed: true,
      inProgress: true,
      turnId: "turn-1",
      attemptGeneration: 1,
    });
    expect(h.started).toEqual(["turn-1"]);
    expect(
      h.outbox.events.filter((event) => event.kind === "turn.started"),
    ).toHaveLength(1);
    h.close();
  });
});

describe("owner gate release", () => {
  test("a delivered terminal gives the slot back", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    const turn = h.values.get("turn") as Record<string, unknown>;
    const delivered = await invoke<Promise<boolean>>(
      h.instance,
      "deliverTerminal",
      turn,
      {
        turnId: "turn-1",
        attemptGeneration: 1,
        kind: "completed",
        payload: { finalText: "done" },
      },
    );

    expect(delivered).toBe(true);
    expect(h.gates.releases).toEqual([
      { ownerId: "owner-1", turnId: "turn-1" },
    ]);
    const completed = h.outbox.events.find(
      (event): event is ThreadCompletedEvent =>
        event.kind === "thread.completed",
    );
    expect(completed).toMatchObject({
      threadId: THREAD_ID,
      turnId: "turn-1",
      attemptGeneration: 1,
      status: "completed",
      resultJson: JSON.stringify({ finalText: "done" }),
    });
    h.close();
  });

  test("a redelivered terminal repeats one event ordinal and one wake", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    const turn = h.values.get("turn") as Record<string, unknown>;
    const pending = {
      turnId: "turn-1",
      attemptGeneration: 1,
      kind: "completed" as const,
      payload: { finalText: "done" },
    };
    const deliver = (
      value: unknown,
      options: Record<string, unknown>,
    ): Promise<boolean> =>
      invoke<Promise<boolean>>(
        h.instance,
        "deliverTerminal",
        turn,
        value,
        options,
      );

    await deliver(pending, { preservePendingTerminal: true });
    const decided = h.values.get("pendingTerminal") as {
      eventSeq: number;
      completedAt: number;
    };
    await deliver(decided, { preservePendingTerminal: true });

    const events = h.outbox.events.filter(
      (event) => event.kind === "turn.event",
    ) as Array<{ eventSeq: number }>;
    expect(events.map((event) => event.eventSeq)).toEqual([
      decided.eventSeq,
      decided.eventSeq,
    ]);
    const wakes = h.orchestratorCalls.map(
      (call) => (call.body as CloudTurnStartRequest).agentThreadControl,
    );
    expect(wakes).toHaveLength(2);
    expect(wakes[0]).toEqual(wakes[1]!);
    h.close();
  });

  test("a pre-canceled admission gives the slot back without running", async () => {
    const h = await harness();
    await (
      h.instance.exactTurnCancellations as ExactTurnCancellationLedger
    ).stage({
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      turnId: "turn-1",
      attemptGeneration: 1,
      cancelRequestId: "00000000-0000-4000-8000-000000000001",
    });
    h.instance.deliverTerminal = async () => true;
    h.instance.deleteTurnStoragePreservingExactCancellations = async () => true;
    h.instance.ownsExactTurn = async () => true;
    h.instance.acknowledgeExactAgentTurnCancellation = async () => true;

    const response = await dispatch(h.instance, agentDispatch());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      canceled: true,
      preAdmission: true,
    });
    expect(h.gates.releases).toEqual([
      { ownerId: "owner-1", turnId: "turn-1" },
    ]);
    expect(h.started).toEqual([]);
    h.close();
  });
});

describe("the parent conversation wake", () => {
  const completedTurn = {
    kind: "agent",
    ownerId: "owner-1",
    ownerGeneration: "generation-1",
    conversationId: "conversation-1",
    threadId: THREAD_ID,
    turnId: "turn-1",
    attemptGeneration: 1,
    appId: "agent",
    prompt: "do the thing",
    description: "the thing",
    audience: "pro",
    budgetMicroCents: 1,
  };

  test("carries the report as a hidden wake turn with the thread's receipt", async () => {
    const h = await harness();

    await invoke<Promise<void>>(
      h.instance,
      "wakeParentConversation",
      completedTurn,
      {
        status: "completed",
        threadUpdatedAt: 1_800_000_000_000,
        resultJson: JSON.stringify({ finalText: "the report" }),
      },
    );

    expect(h.orchestratorCalls).toHaveLength(1);
    const call = h.orchestratorCalls[0]!;
    expect(call.request.url).toBe("https://orchestrator-session/turn");
    expect(call.request.headers.get("x-stella-owner")).toBe("owner-1");
    expect(call.request.headers.get("x-stella-turn-auth")).toBe("service");
    expect(call.request.headers.get("x-stella-conversation-id")).toBe(
      "conversation-1",
    );
    expect(call.request.headers.get("x-stella-owner-generation")).toBe(
      "generation-1",
    );
    expect(call.body).toEqual({
      protocol: 1,
      clientMsgId: `wake:${THREAD_ID}:1`,
      prompt: `[Agent completed] the thing (thread ${THREAD_ID})\n\nthe report`,
      lane: "wake",
      source: "agent-thread",
      hiddenMessage: true,
      agentThreadControl: {
        threadId: THREAD_ID,
        attemptGeneration: 1,
        threadUpdatedAt: 1_800_000_000_000,
        status: "completed",
      },
    });
    h.close();
  });

  test("labels a failure and falls back to its error message", async () => {
    const h = await harness();

    await invoke<Promise<void>>(
      h.instance,
      "wakeParentConversation",
      completedTurn,
      {
        status: "failed",
        threadUpdatedAt: 1,
        errorMessage: "the agent stopped",
      },
    );

    expect((h.orchestratorCalls[0]!.body as CloudTurnStartRequest).prompt).toBe(
      `[Agent failed] the thing (thread ${THREAD_ID})\n\nthe agent stopped`,
    );
    h.close();
  });

  test("says so plainly when the thread reported nothing", async () => {
    const h = await harness();

    await invoke<Promise<void>>(
      h.instance,
      "wakeParentConversation",
      completedTurn,
      { status: "canceled", threadUpdatedAt: 1 },
    );

    expect((h.orchestratorCalls[0]!.body as CloudTurnStartRequest).prompt).toBe(
      `[Agent canceled] the thing (thread ${THREAD_ID})\n\nNo result was reported.`,
    );
    h.close();
  });

  test("a desktop-origin thread is delivered by its device, not woken here", async () => {
    const h = await harness();

    await invoke<Promise<void>>(
      h.instance,
      "wakeParentConversation",
      {
        ...completedTurn,
        originDeviceId: "device-1",
        originConversationId: "desktop-conversation-1",
      },
      { status: "completed", threadUpdatedAt: 1 },
    );

    expect(h.orchestratorCalls).toEqual([]);
    h.close();
  });

  test("a refused wake surfaces so the terminal is retried", async () => {
    const h = await harness({
      orchestrator: async () =>
        Response.json({ error: "nope" }, { status: 503 }),
    });

    await expect(
      invoke<Promise<void>>(
        h.instance,
        "wakeParentConversation",
        completedTurn,
        {
          status: "completed",
          threadUpdatedAt: 1,
        },
      ),
    ).rejects.toThrow(/refused \(503\)/u);
    h.close();
  });
});

describe("the thread transcript a continuation reads", () => {
  test("appends commit locally without a Convex message projection", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    const turn = h.values.get("turn") as Record<string, unknown>;
    const outboxCount = h.outbox.events.length;

    await invoke<Promise<void>>(h.instance, "appendThreadTranscript", turn, [
      { ordinal: 0, role: "user", payloadJson: '{"role":"user"}' },
      {
        ordinal: 1,
        role: "assistant",
        payloadJson: '{"role":"assistant","content":[]}',
      },
    ]);

    expect(
      readThreadHistory(h.sql, {}).map((row) => [row.turnId, row.role]),
    ).toEqual([
      ["turn-1", "user"],
      ["turn-1", "assistant"],
    ]);
    expect(h.outbox.events).toHaveLength(outboxCount);
    h.close();
  });

  test("a continuation loads the prior turns and excludes its own", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    const first = h.values.get("turn") as Record<string, unknown>;
    const append = (target: unknown, messages: unknown): Promise<void> =>
      invoke<Promise<void>>(
        h.instance,
        "appendThreadTranscript",
        target,
        messages,
      );
    await append(first, [
      { ordinal: 0, role: "user", payloadJson: '{"role":"user"}' },
    ]);
    await dispatch(
      h.instance,
      agentDispatch({ attemptGeneration: 2, turnId: "turn-2" }),
    );
    const second = h.values.get("turn") as Record<string, unknown>;
    await append(second, [
      { ordinal: 0, role: "user", payloadJson: '{"role":"user"}' },
    ]);

    const history = invoke<Array<{ turnId: string }>>(
      h.instance,
      "fetchCanonicalAgentHistory",
      second,
      { excludeCurrentTurn: true },
    );

    expect(history.map((row) => row.turnId)).toEqual(["turn-1"]);
    h.close();
  });
});

describe("turn event ordinals", () => {
  test("continue across an eviction instead of restarting at one", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    const turn = h.values.get("turn") as Record<string, unknown>;
    const emit = (
      instance: Record<string, unknown>,
      kind: string,
    ): Promise<number> =>
      invoke<Promise<number>>(instance, "emitTurnEvent", turn, kind, {}, {});

    expect(await emit(h.instance, "started")).toBe(1);
    expect(await emit(h.instance, "progress")).toBe(2);

    const revived = h.restart();
    expect(await emit(revived, "progress")).toBe(3);

    const ordinals = h.outbox.events
      .filter((event) => event.kind === "turn.event")
      .map((event) => (event as { eventSeq: number }).eventSeq);
    expect(ordinals).toEqual([1, 2, 3]);
    expect(new Set(h.outbox.events.map((event) => event.key)).size).toBe(
      h.outbox.events.length,
    );
    h.close();
  });

  test("a caller-chosen ordinal is never handed out again by the counter", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    const turn = h.values.get("turn") as Record<string, unknown>;

    await invoke<Promise<number>>(
      h.instance,
      "emitTurnEvent",
      turn,
      "sandbox_ready",
      {},
      { eventSeq: 7 },
    );

    expect(
      await invoke<Promise<number>>(
        h.instance,
        "emitTurnEvent",
        turn,
        "progress",
        {},
        {},
      ),
    ).toBe(8);
    h.close();
  });
});

describe("deferred projections", () => {
  test("a refused queue becomes durable debt with a wake, and drains later", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    const turn = h.values.get("turn") as Record<string, unknown>;
    const projected = h.outbox.events.length;
    h.outbox.failNext(1);

    await invoke<Promise<number>>(
      h.instance,
      "emitTurnEvent",
      turn,
      "progress",
      { step: 1 },
      {},
    );

    const debt = h.values.get("outboxDebt") as Array<{ kind: string }>;
    expect(debt.map((event) => event.kind)).toEqual(["turn.event"]);
    expect(await h.storage.getAlarm()).not.toBeNull();
    expect(h.outbox.events).toHaveLength(projected);

    await invoke<Promise<void>>(h.instance, "retryOutboxDebt");

    expect(h.values.has("outboxDebt")).toBe(false);
    expect(h.outbox.events).toHaveLength(projected + 1);
    h.close();
  });

  test("turn storage cleanup keeps debt Convex has not seen", async () => {
    const h = await harness();
    await dispatch(h.instance, agentDispatch());
    const turn = h.values.get("turn") as Record<string, unknown>;
    h.outbox.failNext(1);
    await invoke<Promise<number>>(
      h.instance,
      "emitTurnEvent",
      turn,
      "progress",
      {},
      {},
    );

    await invoke<Promise<boolean>>(
      h.instance,
      "deleteTurnStoragePreservingExactCancellations",
      turn,
      true,
    );

    expect(h.values.has("turn")).toBe(false);
    expect(h.values.has("outboxDebt")).toBe(true);
    // The debt keeps its own wake: dropping the alarm would strand it.
    expect(await h.storage.getAlarm()).not.toBeNull();
    h.close();
  });
});
