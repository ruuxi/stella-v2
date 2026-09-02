import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { agentComputeKey } from "../src/agent-compute-ladder.js";
import {
  AgentTurnJournal,
  INTERRUPTED_TOOL_RESULT_TEXT,
} from "../src/agent-turn-journal.js";
import { ExactTurnCancellationLedger } from "../src/execution-placement-turn-cancellation.js";
import {
  turnComputePlan,
  turnComputePlanKey,
} from "../src/general-agent-turn.js";
import {
  openSqlStorageFake,
  type SqlStorageFake,
} from "./fixtures/sql-storage.js";
import { readThreadHistory } from "../src/thread-transcript.js";
import { fakeOutbox } from "./helpers/turn-plane-fakes.js";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";

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

const TURN_ID = "agent-evicted";
const THREAD_ID = "thread-1";

const residentTurn = () => ({
  kind: "agent",
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  appId: "agent",
  turnId: TURN_ID,
  threadId: THREAD_ID,
  attemptGeneration: 1,
  prompt: "ship it",
  execution: STELLA,
  turnBrokerRoute: {
    sessionId: "broker:agent-evicted",
    endpoint: "https://broker.example",
  },
});

const assistantWithCall = (id: string): AgentMessage =>
  ({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "exec_command",
        arguments: { command: "bun test" },
      },
    ],
    api: "stella-cloud",
    provider: "stella",
    model: "stella/default",
    timestamp: 1_700_000_000_000,
  }) as unknown as AgentMessage;

const opened: SqlStorageFake[] = [];
afterEach(() => {
  while (opened.length) opened.pop()?.close();
});

/**
 * The transcript is this session's own table now, so the cursor check inside
 * the control plane is exercised against the same rows a continuation would
 * read back: a recovery that committed different rows than it hashed fails
 * here rather than being asserted around.
 */
const committedTranscript = (
  harness: ReturnType<typeof recoveryHarness>,
): AgentHistoryRow[] => readThreadHistory(harness.storage.sql, {});

const recoveryHarness = () => {
  const values = new Map<string, unknown>();
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
    if (Array.isArray(key)) {
      for (const entry of key) values.delete(entry);
      return true;
    }
    return values.delete(key);
  };
  const fake = openSqlStorageFake();
  opened.push(fake);
  const storage = {
    sql: fake.sql,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put,
    delete: remove,
    list: async <T>({ prefix = "" }: { prefix?: string } = {}) =>
      new Map(
        [...values.entries()].filter(([key]) => key.startsWith(prefix)),
      ) as Map<string, T>,
    transaction: async <T>(operation: (txn: unknown) => Promise<T>) =>
      await operation({
        get: storage.get,
        put,
        delete: remove,
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => {
          alarm = at;
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
  const ctx = {
    storage,
    id: { name: THREAD_ID, toString: () => THREAD_ID },
    waitUntil: () => undefined,
    blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
      await operation(),
  };
  const instance = Object.create(BuildSession.prototype) as BuildSession &
    Record<string, unknown>;
  const delivered: Array<Record<string, unknown>> = [];
  const claimed: Array<Record<string, unknown>> = [];
  const fallbackInputs: Array<Record<string, unknown>> = [];
  const destroyed: Array<Record<string, unknown>> = [];
  const ownerFenceCalls: Array<Record<string, unknown>> = [];
  let destroyFailures = 0;
  Object.assign(instance, {
    ctx,
    env: {
      BUILDER_SERVICE_SECRET: "builder-secret",
      STELLA_CONVEX_SITE_URL: "https://convex.example",
      TURN_OUTBOX: fakeOutbox().queue,
    },
    exactTurnCancellations: new ExactTurnCancellationLedger(storage),
    runningTurns: new Map<string, Set<Promise<unknown>>>(),
    agentTurnExecutions: new Map<string, unknown>(),
    appTurnExecutions: new Map<string, unknown>(),
    residentAgentAborts: new Map<string, () => void>(),
    builderFallbackRecoveries: new Set<string>(),
    claimTerminalDecision: async (
      _turn: unknown,
      pending: Record<string, unknown>,
    ) => {
      claimed.push(pending);
      await put("pendingTerminal", pending);
      return true;
    },
    deliverTerminal: async (
      _turn: unknown,
      pending: Record<string, unknown>,
    ) => {
      delivered.push(pending);
      return true;
    },
    deleteTurnStoragePreservingExactCancellations: async () => true,
    settleAgentTransientBackup: async () => true,
    assertTurnWritable: async () => undefined,
    ownsExactTurn: async () => true,
    interruptAgentForBuilderFallback: async () => undefined,
    reconcileAgentCheckpointAfterQuiescence: async (
      _turn: unknown,
      _marker: unknown,
      _error: string,
      input: Record<string, unknown>,
    ) => {
      fallbackInputs.push(input);
      return { historyCursor: "v1:recovered", nativeCheckpoint: undefined };
    },
    recoverObservedBrowserSuspension: async () => null,
    terminateCurrentAgentSandbox: async () => undefined,
    destroySandboxDurably: async (target: Record<string, unknown>) => {
      destroyed.push(structuredClone(target));
      if (destroyFailures > 0) {
        destroyFailures -= 1;
        throw new Error("injected destroy failure");
      }
    },
    callOwnerFence: async (
      _ownerId: string,
      path: string,
      body: Record<string, unknown>,
    ) => {
      ownerFenceCalls.push({ path, ...structuredClone(body) });
      return Response.json({});
    },
  });
  return {
    instance,
    values,
    storage,
    delivered,
    claimed,
    fallbackInputs,
    destroyed,
    ownerFenceCalls,
    failNextDestroy: () => {
      destroyFailures += 1;
    },
  };
};

const runAlarm = async (
  instance: BuildSession & Record<string, unknown>,
  turn: unknown,
): Promise<void> => {
  await (
    (BuildSession.prototype as unknown as Record<string, unknown>)[
      "runAlarm"
    ] as (this: unknown, turn: unknown) => Promise<void>
  ).call(instance, turn);
};

const seedResidentTurn = (
  harness: ReturnType<typeof recoveryHarness>,
  turn: ReturnType<typeof residentTurn>,
): AgentTurnJournal => {
  harness.values.set("turn", turn);
  harness.values.set("turnId", turn.turnId);
  harness.values.set("terminal", false);
  harness.values.set(
    turnComputePlanKey(turn.turnId, 1),
    turnComputePlan({
      turnId: turn.turnId,
      attemptGeneration: 1,
      execution: STELLA,
      browserResume: false,
      residentDisabled: false,
      now: 1_700_000_000_000,
    }),
  );
  const journal = AgentTurnJournal.open({
    sql: harness.storage.sql,
    identity: { turnId: turn.turnId, attemptGeneration: 1 },
    terminal: {
      prompt: turn.prompt,
      provider: "stella",
      model: "stella/default",
      finalText: "",
      timestamp: 1_700_000_000_000,
    },
    now: 1_700_000_000_000,
  });
  journal.append({
    role: "user",
    content: [{ type: "text", text: turn.prompt }],
    timestamp: 1_700_000_000_000,
  } as AgentMessage);
  journal.append(assistantWithCall("call-1"));
  return journal;
};

describe("resident agent turn recovery", () => {
  test("an evicted resident turn commits its repaired journal and fails the turn", async () => {
    const harness = recoveryHarness();
    const turn = residentTurn();
    seedResidentTurn(harness, turn);
    harness.values.set(agentComputeKey(turn.turnId, 1), {
      schemaVersion: 1,
      turnId: turn.turnId,
      attemptGeneration: 1,
      phase: "resident",
      instanceSize: "large",
    });
    await runAlarm(harness.instance, turn);

    const committed = committedTranscript(harness);
    expect(committed.map((row) => row.turnId)).toEqual([
      turn.turnId,
      turn.turnId,
      turn.turnId,
      turn.turnId,
    ]);
    expect(committed.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(committed[2]!.payloadJson).toContain(INTERRUPTED_TOOL_RESULT_TEXT);
    expect(JSON.parse(committed[2]!.payloadJson)).toMatchObject({
      toolCallId: "call-1",
      isError: true,
    });
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]).toMatchObject({
      turnId: turn.turnId,
      attemptGeneration: 1,
      kind: "failed",
      payload: { reason: "resident_recovered" },
    });
  });

  test("an admitted attach without an execution marker destroys and retires before resident recovery", async () => {
    const harness = recoveryHarness();
    const turn = residentTurn();
    seedResidentTurn(harness, turn);
    const sandboxId = `agent:${turn.turnId}:attempt:1`;
    const leaseId = "world:orphaned-attach";
    harness.values.set("sandboxId", "stale-predecessor");
    harness.values.set("sandboxSize", "large");
    harness.values.set(agentComputeKey(turn.turnId, 1), {
      schemaVersion: 2,
      turnId: turn.turnId,
      attemptGeneration: 1,
      phase: "attaching",
      instanceSize: "small",
      sandboxId,
      attachReason: "filesystem_tool",
      worldLease: { leaseId, phase: "registering" },
    });
    harness.values.set(`ownerFenceLeaseReceipt:${leaseId}`, {
      schemaVersion: 1,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      leaseId,
      kind: "world",
      phase: "registering",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    await runAlarm(harness.instance, turn);

    expect(harness.destroyed).toEqual([
      {
        sandboxId,
        size: "small",
        workload: "resident-attachment",
      },
    ]);
    expect(harness.ownerFenceCalls).toHaveLength(1);
    expect(harness.ownerFenceCalls[0]).toMatchObject({
      path: "unregister",
      leaseId,
      turnId: turn.turnId,
    });
    expect(harness.values.has(agentComputeKey(turn.turnId, 1))).toBe(false);
    expect(harness.values.has(`ownerFenceLeaseReceipt:${leaseId}`)).toBe(false);
    expect(harness.values.get("sandboxId")).toBe("stale-predecessor");
    expect(committedTranscript(harness)).toHaveLength(4);
  });

  test("destroy failure retains exact compute and world slot until the retry succeeds", async () => {
    const harness = recoveryHarness();
    const turn = residentTurn();
    seedResidentTurn(harness, turn);
    const sandboxId = `agent:${turn.turnId}:attempt:1`;
    const leaseId = "world:destroy-retry";
    harness.values.set(agentComputeKey(turn.turnId, 1), {
      schemaVersion: 2,
      turnId: turn.turnId,
      attemptGeneration: 1,
      phase: "attached",
      instanceSize: "large",
      sandboxId,
      attachReason: "process_tool",
      worldLease: {
        leaseId,
        phase: "registered",
        generation: "lease-generation",
        expiresAt: Date.now() + 60_000,
      },
    });
    harness.values.set(`ownerFenceLeaseReceipt:${leaseId}`, {
      schemaVersion: 1,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      leaseId,
      kind: "world",
      phase: "registered",
      registrationGeneration: "lease-generation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    harness.failNextDestroy();

    await runAlarm(harness.instance, turn);
    expect(harness.values.has(agentComputeKey(turn.turnId, 1))).toBe(true);
    expect(
      harness.values.get(`ownerFenceLeaseReceipt:${leaseId}`),
    ).toMatchObject({ phase: "registered" });
    expect(harness.ownerFenceCalls).toEqual([]);

    await runAlarm(harness.instance, turn);
    expect(harness.destroyed).toHaveLength(2);
    expect(harness.ownerFenceCalls.at(-1)).toMatchObject({
      path: "unregister",
      leaseId,
      generation: "lease-generation",
    });
    expect(harness.values.has(agentComputeKey(turn.turnId, 1))).toBe(false);
    expect(harness.values.has(`ownerFenceLeaseReceipt:${leaseId}`)).toBe(false);
  });

  test("malformed admitted compute fails closed instead of entering resident recovery", async () => {
    const harness = recoveryHarness();
    const turn = residentTurn();
    seedResidentTurn(harness, turn);
    harness.values.set(agentComputeKey(turn.turnId, 1), {
      schemaVersion: 2,
      turnId: turn.turnId,
      attemptGeneration: 1,
      phase: "attaching",
      instanceSize: "large",
    });

    await runAlarm(harness.instance, turn);

    expect(harness.destroyed).toEqual([]);
    expect(harness.delivered).toEqual([]);
    expect(harness.values.has(agentComputeKey(turn.turnId, 1))).toBe(true);
  });

  test("shared owner-purge cleanup preserves deferred destroy and world-unregister debt", async () => {
    const harness = recoveryHarness();
    const turn = residentTurn();
    harness.values.set("turn", turn);
    const leaseId = "world:owner-purge-debt";
    const receiptKey = `ownerFenceLeaseReceipt:${leaseId}`;
    const retirementKey =
      "ownerFenceSandboxWorldRetirement:resident-attachment:small:sandbox-owner-purge";
    const destroyKey =
      "sandbox-lifecycle:v1:destroy-pending:resident-attachment:small:sandbox-owner-purge";
    harness.values.set(receiptKey, {
      schemaVersion: 1,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      leaseId,
      kind: "world",
      phase: "unregister_pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    harness.values.set(retirementKey, {
      schemaVersion: 1,
      phase: "unregister_pending",
    });
    harness.values.set(destroyKey, { schemaVersion: 1 });
    delete harness.instance["deleteTurnStoragePreservingExactCancellations"];

    const cleaned = await (
      (BuildSession.prototype as unknown as Record<string, unknown>)[
        "cleanupOwnerPurgedTurnStorage"
      ] as (this: unknown, turn: unknown) => Promise<boolean>
    ).call(harness.instance, turn);

    expect(cleaned).toBe(true);
    expect(harness.values.has("turn")).toBe(false);
    expect(harness.values.has(receiptKey)).toBe(true);
    expect(harness.values.has(retirementKey)).toBe(true);
    expect(harness.values.has(destroyKey)).toBe(true);
  });

  test("resident admission clears a stale shared sandbox tuple", async () => {
    const harness = recoveryHarness();
    const turn = residentTurn();
    harness.values.set("turn", turn);
    harness.values.set("sandboxId", "stale-predecessor");
    harness.values.set("sandboxSize", "small");
    harness.values.set(agentComputeKey(turn.turnId, 1), {
      schemaVersion: 2,
      turnId: turn.turnId,
      attemptGeneration: 1,
      phase: "resident",
      instanceSize: "large",
    });

    await (
      (BuildSession.prototype as unknown as Record<string, unknown>)[
        "clearLegacySandboxTupleForResidentAdmission"
      ] as (this: unknown, turn: unknown) => Promise<void>
    ).call(harness.instance, turn);

    expect(harness.values.has("sandboxId")).toBe(false);
    expect(harness.values.has("sandboxSize")).toBe(false);
  });

  test("an evicted attached turn feeds the journal into the builder fallback", async () => {
    const harness = recoveryHarness();
    const turn = residentTurn();
    seedResidentTurn(harness, turn);
    const sandboxId = `agent-${turn.turnId}`;
    harness.values.set("sandboxId", sandboxId);
    harness.values.set("sandboxSize", "large");
    harness.values.set(`agentExecutionMarker:${turn.turnId}:1`, {
      schemaVersion: 1,
      turnId: turn.turnId,
      attemptGeneration: 1,
      sandboxId,
      size: "large",
      startedAt: 1_700_000_000_000,
    });
    harness.values.set(agentComputeKey(turn.turnId, 1), {
      schemaVersion: 1,
      turnId: turn.turnId,
      attemptGeneration: 1,
      phase: "attached",
      instanceSize: "large",
      sandboxId,
    });

    await runAlarm(harness.instance, turn);

    expect(harness.fallbackInputs).toHaveLength(1);
    const input = harness.fallbackInputs[0] as {
      historyCursor: string;
      messages: Array<{ role: string; payloadJson: string }>;
    };
    expect(input.historyCursor).toMatch(/^v1:[0-9a-f]{64}$/u);
    expect(input.messages.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(input.messages[2]!.payloadJson).toContain(
      INTERRUPTED_TOOL_RESULT_TEXT,
    );
    expect(harness.delivered[0]).toMatchObject({
      kind: "failed",
      payload: { reason: "executor_recovered" },
    });
  });

  test("a native turn's fallback is never fed a journal it did not write", async () => {
    const harness = recoveryHarness();
    const turn = { ...residentTurn(), execution: undefined };
    harness.values.set("turn", turn);
    harness.values.set("turnId", turn.turnId);
    harness.values.set("terminal", false);
    const sandboxId = `agent-${turn.turnId}`;
    harness.values.set("sandboxId", sandboxId);
    harness.values.set("sandboxSize", "large");
    harness.values.set(`agentExecutionMarker:${turn.turnId}:1`, {
      schemaVersion: 1,
      turnId: turn.turnId,
      attemptGeneration: 1,
      sandboxId,
      size: "large",
      startedAt: 1_700_000_000_000,
    });

    await runAlarm(harness.instance, turn);

    expect(harness.fallbackInputs).toEqual([undefined]);
  });
});
