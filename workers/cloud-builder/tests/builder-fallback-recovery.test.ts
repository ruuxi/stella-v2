import { describe, expect, mock, test } from "bun:test";
import { nativeHistoryCursorFromRows } from "../src/native-state-checkpoint.js";

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

const mapStorage = (values = new Map<string, unknown>()) => {
  let alarm: number | null = null;
  const get = async <T>(key: string): Promise<T | undefined> =>
    values.get(key) as T | undefined;
  const put = async (
    key: string | Record<string, unknown>,
    value?: unknown,
  ): Promise<void> => {
    if (typeof key === "string") values.set(key, structuredClone(value));
    else {
      for (const [entryKey, entryValue] of Object.entries(key)) {
        values.set(entryKey, structuredClone(entryValue));
      }
    }
  };
  const remove = async (key: string | string[]): Promise<void> => {
    for (const entry of Array.isArray(key) ? key : [key]) values.delete(entry);
  };
  const storage = {
    get,
    put,
    delete: remove,
    list: async <T>({ prefix = "", limit = 1_000 } = {}) =>
      new Map(
        [...values.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit),
      ) as Map<string, T>,
    transaction: async <T>(operation: (transaction: unknown) => Promise<T>) =>
      await operation({ get, put, delete: remove }),
    setAlarm: async (value: number) => {
      alarm = value;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  return { values, storage, alarm: () => alarm };
};

const turn = () => ({
  kind: "agent" as const,
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  appId: "agent",
  turnId: "turn-1",
  prompt: "make the change",
  turnToken: "turn-token",
  convexCallbackBase: "https://convex.example",
  threadId: "thread-1",
  workspace: "cloud",
  attemptGeneration: 1,
  ownerPurgeGeneration: "purge-generation-1",
  ownerPurgeLeaseId: "run-lease-1",
  execution: {
    engine: "codex" as const,
    provider: "openai",
    model: "gpt-5",
    reasoningEffort: "medium",
  },
});

const marker = {
  schemaVersion: 1 as const,
  turnId: "turn-1",
  attemptGeneration: 1,
  sandboxId: "sandbox-1",
  size: "large" as const,
  workspace: "cloud",
  workspaceRoot: "/workspace/drive" as const,
  startedAt: 1,
};

const receipt = (historyCursor: string, operationId = "a".repeat(64)) => ({
  schemaVersion: 1 as const,
  operationId,
  historyCursor,
  workspaceSha256: "b".repeat(64),
  receipt: "c".repeat(64),
  replayed: false,
});

const harness = () => {
  const state = mapStorage();
  const current = turn();
  state.values.set("turn", current);
  const instance = Object.create(BuildSession.prototype) as InstanceType<
    typeof BuildSession
  > &
    Record<string, unknown>;
  Object.assign(instance, {
    ctx: {
      storage: state.storage,
      id: { toString: () => "session-1" },
      blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
        await operation(),
    },
    env: {},
    agentTurnExecutions: new Map(),
    builderFallbackRecoveries: new Set(),
    turnStateCheckpointRuns: new Map(),
    assertTurnWritable: async () => undefined,
    assertConvexAgentTurnAuthority: async () => undefined,
    quiesceCurrentAgentSession: async () => undefined,
  });
  return { instance, state, current };
};

const rows = [
  {
    turnId: "turn-1",
    ordinal: 0,
    role: "assistant",
    payloadJson: JSON.stringify({ role: "assistant", content: [] }),
  },
];

describe("Builder fallback recovery", () => {
  test("reuses an already accepted broker checkpoint after stdout loss", async () => {
    const { instance, state, current } = harness();
    const cursor = await nativeHistoryCursorFromRows(rows);
    const accepted = receipt(cursor);
    state.values.set("turnStateCheckpointOperation:req-1", {
      state: "succeeded",
      turnId: current.turnId,
      attemptGeneration: 1,
      requestId: "req-1",
      requestFingerprint: "d".repeat(64),
      createdAt: 1,
      baseWorkspaceRevision: 0,
      payload: { schemaVersion: 1, historyCursor: cursor },
      operationId: accepted.operationId,
      receipt: accepted,
    });
    const calls: string[] = [];
    instance["fetchCanonicalAgentHistory"] = async () => rows;
    instance["publishAgentTurnWorkspace"] = async () => {
      calls.push("publish");
      return {};
    };
    instance["ensureBuilderFallbackTranscript"] = async () => {
      calls.push("prepare-fallback");
      return {};
    };

    const result = await instance["reconcileAgentCheckpointAfterQuiescence"](
      current,
      marker,
      "stdout lost",
    );

    expect(result).toEqual(accepted);
    expect(calls).toEqual(["publish"]);
    expect(
      [...state.values.keys()].filter((key) =>
        key.startsWith("builderFallbackTranscript:"),
      ),
    ).toEqual([]);
  });

  test("finishes a pending checkpoint before aborting its noncanonical candidate", async () => {
    const { instance, state, current } = harness();
    const canonicalCursor = await nativeHistoryCursorFromRows(rows);
    const candidateCursor = `v1:${"e".repeat(64)}`;
    const pending = {
      state: "pending" as const,
      turnId: current.turnId,
      attemptGeneration: 1,
      requestId: "req-pending",
      requestFingerprint: "f".repeat(64),
      createdAt: 1,
      baseWorkspaceRevision: 0,
      operationId: "1".repeat(64),
      payload: { schemaVersion: 1 as const, historyCursor: candidateCursor },
    };
    state.values.set("turnStateCheckpointOperation:req-pending", pending);
    const calls: string[] = [];
    instance["fetchCanonicalAgentHistory"] = async () => rows;
    instance["executeTurnStateCheckpoint"] = async () => {
      calls.push("finish-checkpoint");
      const committed = receipt(candidateCursor, pending.operationId);
      state.values.set("turnStateCheckpointOperation:req-pending", {
        ...pending,
        state: "succeeded",
        receipt: committed,
      });
      return committed;
    };
    instance["abortUnpublishedTurnStateOperation"] = async () => {
      calls.push("abort-noncanonical");
    };
    instance["ensureBuilderFallbackTranscript"] = async () => {
      calls.push("prepare-fallback");
      return { requestId: "fallback" };
    };
    const fallbackReceipt = receipt(canonicalCursor, "2".repeat(64));
    instance["advanceBuilderFallback"] = async () => {
      calls.push("commit-fallback");
      return fallbackReceipt;
    };

    const result = await instance["reconcileAgentCheckpointAfterQuiescence"](
      current,
      marker,
      "executor lost",
    );

    expect(result).toEqual(fallbackReceipt);
    expect(calls).toEqual([
      "finish-checkpoint",
      "abort-noncanonical",
      "prepare-fallback",
      "commit-fallback",
    ]);
  });

  test("restart recovery renews the exact run lease rather than an auxiliary lease", async () => {
    const { instance, state, current } = harness();
    state.values.set("agentExecutionMarker:turn-1:1", marker);
    const registrations: boolean[] = [];
    instance["registerTurn"] = async (
      target: typeof current,
      freshLease = false,
    ) => {
      registrations.push(freshLease);
      if (freshLease) target.ownerPurgeLeaseId = "aux-lease";
      return "purge-generation-1";
    };
    instance["runAlarm"] = async () => undefined;
    instance["unregisterTurnLease"] = async () => undefined;

    await instance["runAlarmWithLease"]({ ...current });

    expect(registrations).toEqual([false]);
  });

  test("transcript and publication lost responses resume one durable journal", async () => {
    const { instance, state, current } = harness();
    const historyCursor = await nativeHistoryCursorFromRows(rows);
    const checkpointReceipt = receipt(historyCursor);
    const fallbackKey = "builderFallbackTranscript:turn-1:1";
    const operationKey = "turnStateCheckpointOperation:req-fallback";
    const fallback = {
      schemaVersion: 1 as const,
      turnId: current.turnId,
      attemptGeneration: 1,
      requestId: "req-fallback",
      requestFingerprint: "3".repeat(64),
      createdAt: 1,
      payload: { schemaVersion: 1 as const, historyCursor },
      messages: rows.map(({ ordinal, role, payloadJson }) => ({
        ordinal,
        role,
        payloadJson,
      })),
      checkpointReceipt,
      transcriptCommitted: false,
      workspacePublished: false,
    };
    state.values.set(fallbackKey, fallback);
    state.values.set(operationKey, {
      state: "succeeded",
      turnId: current.turnId,
      attemptGeneration: 1,
      requestId: fallback.requestId,
      requestFingerprint: fallback.requestFingerprint,
      createdAt: 1,
      baseWorkspaceRevision: 0,
      payload: fallback.payload,
      operationId: checkpointReceipt.operationId,
      receipt: checkpointReceipt,
    });
    const canonicalJournal: typeof rows = [];
    let transcriptCommits = 0;
    instance["fetchCanonicalAgentHistory"] = async () => canonicalJournal;
    let publishCalls = 0;
    const publishedOperations = new Set<string>();
    let publicationCommits = 0;
    instance["publishAgentTurnWorkspace"] = async (
      _turn: unknown,
      _workspace: unknown,
      _cursor: unknown,
      operationId: string,
    ) => {
      publishCalls += 1;
      if (!publishedOperations.has(operationId)) {
        publishedOperations.add(operationId);
        publicationCommits += 1;
      }
      if (publishCalls === 1) throw new Error("publish ACK lost");
      return {};
    };

    const originalFetch = globalThis.fetch;
    let transcriptCalls = 0;
    globalThis.fetch = (async () => {
      transcriptCalls += 1;
      if (canonicalJournal.length === 0) {
        canonicalJournal.push(...structuredClone(rows));
        transcriptCommits += 1;
      }
      if (transcriptCalls === 1) throw new Error("transcript ACK lost");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        instance["advanceBuilderFallback"](
          current,
          marker.workspace,
          marker.workspaceRoot,
          fallback,
        ),
      ).rejects.toThrow("transcript ACK lost");
      await expect(
        instance["advanceBuilderFallback"](
          current,
          marker.workspace,
          marker.workspaceRoot,
          fallback,
        ),
      ).rejects.toThrow("publish ACK lost");
      expect(
        (state.values.get(fallbackKey) as { transcriptCommitted: boolean })
          .transcriptCommitted,
      ).toBe(true);
      await instance["advanceBuilderFallback"](
        current,
        marker.workspace,
        marker.workspaceRoot,
        fallback,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(transcriptCalls).toBe(2);
    expect(transcriptCommits).toBe(1);
    expect(canonicalJournal).toEqual(rows);
    expect(publishCalls).toBe(2);
    expect(publicationCommits).toBe(1);
    expect([...publishedOperations]).toEqual([checkpointReceipt.operationId]);
    expect(state.values.get(fallbackKey)).toMatchObject({
      checkpointReceipt,
      transcriptCommitted: true,
      workspacePublished: true,
    });
  });
});
