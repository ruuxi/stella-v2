import { describe, expect, mock, test } from "bun:test";
import { nativeHistoryCursorFromRows } from "../src/native-state-checkpoint.js";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";
import { fakeOutbox } from "./helpers/turn-plane-fakes.js";

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
const {
  BuildSession,
  bindObservedBrowserSuspensionToCanonicalCodeCall,
} = await import("../src/index.js");
mock.restore();

const mapStorage = (values = new Map<string, unknown>()) => {
  let alarm: number | null = null;
  const { sql } = openSqlStorageFake();
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
    sql,
    get,
    put,
    delete: remove,
    getAlarm: async () => alarm,
    list: async <T>({ prefix = "", limit = 1_000 } = {}) =>
      new Map(
        [...values.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit),
      ) as Map<string, T>,
    transaction: async <T>(operation: (transaction: unknown) => Promise<T>) =>
      await operation({
        get,
        put,
        delete: remove,
        setAlarm: async (value: number) => {
          alarm = value;
        },
        deleteAlarm: async () => {
          alarm = null;
        },
      }),
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
  conversationId: "conversation-1",
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  appId: "agent",
  turnId: "turn-1",
  prompt: "make the change",
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
    env: { TURN_OUTBOX: fakeOutbox().queue },
    agentTurnExecutions: new Map(),
    builderFallbackRecoveries: new Set(),
    turnStateCheckpointRuns: new Map(),
    assertTurnWritable: async () => undefined,
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

const browserRows = [
  {
    turnId: "turn-1",
    ordinal: 0,
    role: "user",
    payloadJson: JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "sign in" }],
    }),
  },
  {
    turnId: "turn-1",
    ordinal: 1,
    role: "assistant",
    payloadJson: JSON.stringify({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "outer-code-call",
          name: "code",
          arguments: { code: "await browser.requestLoginTakeover({})" },
        },
      ],
    }),
  },
];

const browserSuspension = (expiresAt = Date.now() + 60_000) => ({
  schemaVersion: 1 as const,
  outcome: "waiting_for_user" as const,
  interactionId: "interaction-1",
  interactionRevision: 1,
  interactionKind: "login_takeover" as const,
  toolCallId: "inner-gateway-request",
  requestDigest: "4".repeat(64),
  profileId: "default" as const,
  profileEpoch: 2,
  displayOrigin: "https://example.test",
  displayTitle: "Example",
  expiresAt,
});

const observedBrowserSuspension = (expiresAt = Date.now() + 60_000) => ({
  schemaVersion: 1 as const,
  turnId: "turn-1",
  attemptGeneration: 1,
  brokerRequestId: "broker-request-1",
  requestBodySha256: "5".repeat(64),
  responseBodySha256: "6".repeat(64),
  suspension: browserSuspension(expiresAt),
  observedAt: 1,
});

describe("Builder fallback recovery", () => {
  test("binds an observed Gateway wait only to one canonical unresolved Code call", async () => {
    const cursor = await nativeHistoryCursorFromRows(browserRows);
    const checkpoint = receipt(cursor);
    const bound =
      await bindObservedBrowserSuspensionToCanonicalCodeCall({
        observation: observedBrowserSuspension(),
        turnId: "turn-1",
        attemptGeneration: 1,
        checkpoint,
        rows: browserRows,
      });
    expect(bound).toMatchObject({
      interactionId: "interaction-1",
      toolCallId: "outer-code-call",
    });

    const ambiguousRows = structuredClone(browserRows);
    const assistant = JSON.parse(ambiguousRows[1]!.payloadJson) as {
      content: unknown[];
    };
    assistant.content.push({
      type: "toolCall",
      id: "second-unresolved-call",
      name: "code",
      arguments: {},
    });
    ambiguousRows[1]!.payloadJson = JSON.stringify({
      role: "assistant",
      content: assistant.content,
    });
    expect(
      await bindObservedBrowserSuspensionToCanonicalCodeCall({
        observation: observedBrowserSuspension(),
        turnId: "turn-1",
        attemptGeneration: 1,
        checkpoint: receipt(
          await nativeHistoryCursorFromRows(ambiguousRows),
        ),
        rows: ambiguousRows,
      }),
    ).toBeNull();
    expect(
      await bindObservedBrowserSuspensionToCanonicalCodeCall({
        observation: observedBrowserSuspension(1),
        turnId: "turn-1",
        attemptGeneration: 1,
        checkpoint,
        rows: browserRows,
        now: 2,
      }),
    ).toBeNull();
  });

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
    instance["fetchCanonicalAgentHistory"] = () => rows;
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

  test("replays a suspended checkpoint transcript before synthesizing fallback", async () => {
    const { instance, state, current } = harness();
    const cursor = await nativeHistoryCursorFromRows(browserRows);
    const accepted = receipt(cursor);
    const messages = browserRows.map(({ ordinal, role, payloadJson }) => ({
      ordinal,
      role,
      payloadJson,
    }));
    state.values.set("observedBrowserSuspension", observedBrowserSuspension());
    state.values.set("turnStateCheckpointOperation:req-browser", {
      state: "succeeded",
      turnId: current.turnId,
      attemptGeneration: 1,
      requestId: "req-browser",
      requestFingerprint: "8".repeat(64),
      createdAt: 1,
      baseWorkspaceRevision: 0,
      payload: {
        schemaVersion: 1,
        historyCursor: cursor,
        suspensionTranscript: messages,
      },
      operationId: accepted.operationId,
      receipt: accepted,
    });
    const canonical: typeof browserRows = [];
    instance["fetchCanonicalAgentHistory"] = () => canonical;
    const calls: string[] = [];
    instance["publishAgentTurnWorkspace"] = async () => {
      calls.push("publish-original");
      return {};
    };
    instance["abortUnpublishedTurnStateOperation"] = async () => {
      throw new Error("original suspension checkpoint must not be aborted");
    };
    instance["appendThreadTranscript"] = async (
      _turn: unknown,
      appended: typeof messages,
    ) => {
      canonical.push(
        ...appended.map((message) => ({
          ...message,
          turnId: current.turnId,
        })),
      );
      calls.push("append-suspension-transcript");
    };
    const result = await instance["reconcileAgentCheckpointAfterQuiescence"](
      current,
      marker,
      "executor lost after checkpoint",
    );
    expect(result).toEqual(accepted);

    expect(calls).toEqual([
      "append-suspension-transcript",
      "publish-original",
    ]);
    expect(canonical).toEqual(browserRows);
    expect(
      state.values.get("builderFallbackTranscript:turn-1:1"),
    ).toMatchObject({
      requestId: "req-browser",
      transcriptCommitted: true,
      workspacePublished: true,
      checkpointReceipt: accepted,
    });
    expect(
      [...state.values.keys()].filter((key) =>
        key.startsWith("turnStateCheckpointOperation:"),
      ),
    ).toEqual(["turnStateCheckpointOperation:req-browser"]);
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
    instance["fetchCanonicalAgentHistory"] = () => rows;
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

  test("alarm recovery promotes a canonical observed wait instead of executor_recovered", async () => {
    const { instance, state, current } = harness();
    const cursor = await nativeHistoryCursorFromRows(browserRows);
    const accepted = receipt(cursor);
    state.values.set("agentExecutionMarker:turn-1:1", marker);
    state.values.set(
      "observedBrowserSuspension",
      observedBrowserSuspension(),
    );
    instance["recoverAgentTurnAfterExecutorLoss"] = async () => accepted;
    instance["fetchCanonicalAgentHistory"] = () => browserRows;
    instance["ownsExactTurn"] = async () => true;
    const calls: string[] = [];
    instance["terminateCurrentAgentSandbox"] = async () => {
      calls.push("terminate");
    };
    let delivered: Record<string, unknown> | undefined;
    instance["deliverBrowserSuspension"] = async (
      _turn: unknown,
      pending: Record<string, unknown>,
    ) => {
      calls.push("deliver-wait");
      delivered = pending;
      return true;
    };
    instance["settleAgentTransientBackup"] = async () => true;
    instance["deleteTurnStoragePreservingExactCancellations"] = async () => {
      calls.push("cleanup");
    };
    instance["claimTerminalDecision"] = async () => {
      throw new Error("generic terminal recovery must not run");
    };

    await instance["runAlarm"](current);

    expect(calls).toEqual(["terminate", "deliver-wait", "cleanup"]);
    expect(delivered).toMatchObject({
      suspension: {
        interactionId: "interaction-1",
        toolCallId: "outer-code-call",
      },
    });
    expect(state.values.has("observedBrowserSuspension")).toBe(false);
    expect(state.values.has("agentExecutionMarker:turn-1:1")).toBe(false);
    expect(state.values.get("pendingBrowserSuspension")).toMatchObject({
      turnId: "turn-1",
      suspension: { toolCallId: "outer-code-call" },
    });
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
    instance["fetchCanonicalAgentHistory"] = () => canonicalJournal;
    let publishCalls = 0;
    const publishedOperations = new Set<string>();
    let publicationCommits = 0;
    instance["publishAgentTurnWorkspace"] = async (
      _turn: unknown,
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

    // The transcript is committed to the thread's own table now, so the lost
    // response this journal exists for is a failed local commit rather than a
    // failed Convex callback. The rows still land exactly once.
    let transcriptCalls = 0;
    instance["appendThreadTranscript"] = async () => {
      transcriptCalls += 1;
      if (canonicalJournal.length === 0) {
        canonicalJournal.push(...structuredClone(rows));
        transcriptCommits += 1;
      }
      if (transcriptCalls === 1) throw new Error("transcript ACK lost");
    };
    await expect(
      instance["advanceBuilderFallback"](current, fallback),
    ).rejects.toThrow("transcript ACK lost");
    await expect(
      instance["advanceBuilderFallback"](current, fallback),
    ).rejects.toThrow("publish ACK lost");
    expect(
      (state.values.get(fallbackKey) as { transcriptCommitted: boolean })
        .transcriptCommitted,
    ).toBe(true);
    await instance["advanceBuilderFallback"](current, fallback);

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
