import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { getFunctionName } from "convex/server";
import type { SqliteDatabase } from "../kernel/storage/shared";
import {
  ExecutionPlacementBridge,
  ExecutionPlacementInbox,
  placementLocalAgentThreadId,
  placementLocalChatRunId,
  type ExecutionPlacementClient,
} from "./execution-placement-bridge";

const deviceIdentity = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    deviceId: "desktop-placement-runtime",
    publicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
};

describe("execution placement durable inbox", () => {
  test("derives one stable local-agent owner from the dispatch identity", () => {
    expect(placementLocalAgentThreadId("exec:stable")).toBe(
      placementLocalAgentThreadId("exec:stable"),
    );
    expect(placementLocalAgentThreadId("exec:stable")).not.toBe(
      placementLocalAgentThreadId("exec:other"),
    );
    expect(placementLocalAgentThreadId("exec:stable")).toMatch(
      /^placement-agent:[a-f0-9]{32}$/,
    );
  });

  test("derives separate stable chat and agent owners from one dispatch", () => {
    expect(placementLocalChatRunId("exec:stable")).toBe(
      placementLocalChatRunId("exec:stable"),
    );
    expect(placementLocalChatRunId("exec:stable")).toMatch(
      /^placement-chat:[a-f0-9]{32}$/,
    );
    expect(placementLocalChatRunId("exec:stable")).not.toBe(
      placementLocalAgentThreadId("exec:stable"),
    );
  });

  test("reuses a proof session and durably fences old-generation work before orphaning it", () => {
    const database = new Database(":memory:");
    const inbox = new ExecutionPlacementInbox(
      database as unknown as SqliteDatabase,
    );
    const first = inbox.openSession({
      ownerId: "owner-a",
      ownerGeneration: "generation-a",
      now: 1,
    });
    expect(first.reused).toBe(false);
    expect(inbox.nextProofSequence(2)).toBe(1);
    expect(
      inbox.openSession({
        ownerId: "owner-a",
        ownerGeneration: "generation-a",
        now: 3,
      }),
    ).toEqual({
      presenceSessionId: first.presenceSessionId,
      proofSeq: 1,
      reused: true,
    });

    inbox.persistClaim({
      ownerId: "owner-a",
      ownerGeneration: "generation-a",
      presenceSessionId: first.presenceSessionId,
      claimToken: "claim-token",
      claimed: {
        dispatch: {
          dispatchId: "exec:one",
          kind: "chat",
          conversationId: "conv:one",
          state: "computer_claimed",
        },
        payloadJson: '{"prompt":"hello"}',
        payloadHash: "hash",
        claimExpiresAt: 10,
      },
      now: 4,
    });
    const rotated = inbox.openSession({
      ownerId: "owner-a",
      ownerGeneration: "generation-b",
      now: 5,
    });
    expect(rotated.presenceSessionId).not.toBe(first.presenceSessionId);
    expect(inbox.get("exec:one")).toMatchObject({
      state: "claimed",
      cancelRpcPending: true,
      cancelOrphanOnAck: true,
    });
    inbox.acknowledgeCancellation("exec:one", 6);
    expect(inbox.get("exec:one")?.state).toBe("orphaned");
    database.close();
  });

  test("persists exact claim bytes idempotently and rejects conflicting replay", () => {
    const database = new Database(":memory:");
    const inbox = new ExecutionPlacementInbox(
      database as unknown as SqliteDatabase,
    );
    const session = inbox.openSession({
      ownerId: "owner",
      ownerGeneration: "generation",
      now: 1,
    });
    const input = {
      ownerId: "owner",
      ownerGeneration: "generation",
      presenceSessionId: session.presenceSessionId,
      claimToken: "token",
      claimed: {
        dispatch: {
          dispatchId: "exec:exact",
          kind: "chat" as const,
          conversationId: "conv:exact",
          state: "computer_claimed",
        },
        payloadJson: '{"prompt":"hello"}',
        payloadHash: "hash-one",
        claimExpiresAt: 10,
      },
      now: 2,
    };
    expect(inbox.persistClaim(input)).toEqual({ replayed: false });
    expect(inbox.persistClaim(input)).toEqual({ replayed: true });
    expect(() =>
      inbox.persistClaim({
        ...input,
        claimed: { ...input.claimed, payloadJson: '{"prompt":"other"}' },
      }),
    ).toThrow("different claim bytes");
    database.close();
  });

  test("lets an exact Stop override an unacknowledged local terminal receipt", () => {
    const database = new Database(":memory:");
    const inbox = new ExecutionPlacementInbox(
      database as unknown as SqliteDatabase,
    );
    const session = inbox.openSession({
      ownerId: "owner",
      ownerGeneration: "generation",
      now: 1,
    });
    const dispatch = {
      dispatchId: "exec:terminal-stop-race",
      kind: "chat" as const,
      conversationId: "conv:terminal-stop-race",
      state: "computer_accepted",
      placement: "computer" as const,
    };
    inbox.persistClaim({
      ownerId: "owner",
      ownerGeneration: "generation",
      presenceSessionId: session.presenceSessionId,
      claimToken: "terminal-stop-token",
      claimed: {
        dispatch,
        payloadJson: '{"prompt":"race"}',
        payloadHash: "terminal-stop-hash",
        claimExpiresAt: 10_000,
      },
      now: 2,
    });
    inbox.markAccepted(dispatch.dispatchId, dispatch, 3);
    inbox.markTerminalPending(dispatch.dispatchId, {
      outcome: "completed",
      resultJson: '{"finalText":"too late"}',
      now: 4,
    });
    inbox.stageCancellation(dispatch.dispatchId, {
      outcome: "canceled",
      errorMessage: "Canceled by the user.",
      now: 5,
    });
    expect(inbox.get(dispatch.dispatchId)).toMatchObject({
      state: "terminal_pending",
      terminalOutcome: "canceled",
      cancelRpcPending: true,
    });
    expect(inbox.get(dispatch.dispatchId)?.resultJson).toBeUndefined();
    database.close();
  });
});

describe("execution placement runtime bridge", () => {
  test("routes anonymous cloud chat through the restricted browser admission", () => {
    const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
    const start = source.indexOf("async startPlacedChat(payload, target) {");
    const end = source.indexOf("async healthCheck()", start);
    const placedChatSource = source.slice(start, end);

    expect(placedChatSource).toContain(
      'target.mode === "cloud" && !this.configCache.hasConnectedAccount',
    );
    expect(placedChatSource).toContain(
      "anyApi.execution_placement.submitMyBrowserExecution",
    );
    expect(placedChatSource).toContain('subject: "cloud"');
    expect(placedChatSource).toContain('requiredCapabilities: ["chat"]');
    expect(placedChatSource).toContain(
      "this.hostExecutionPlacementBridge.submitDesktopExecution",
    );
  });

  test("host routes placement agents through one exact run/cancel owner", () => {
    const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
    const bridgeStart = source.indexOf("async syncHostExecutionPlacement() {");
    const bridgeEnd = source.indexOf(
      "async sendConnectorFollowup(args)",
      bridgeStart,
    );
    const placementSource = source.slice(bridgeStart, bridgeEnd);
    expect(placementSource).toContain(
      "threadId: placementLocalAgentThreadId(dispatch.dispatchId)",
    );
    expect(placementSource).toContain(
      "this.cancelBlockingLocalAgent(placementLocalAgentThreadId(dispatchId)",
    );
    expect(placementSource).toContain(
      'throw new Error("The exact local-agent cancellation was not acknowledged.")',
    );
    expect(placementSource).toContain(
      "executionPlacementRunId: placementLocalChatRunId(dispatch.dispatchId)",
    );
    expect(placementSource).toContain(
      "this.cancelPlacementAutomation(placementLocalChatRunId(dispatchId)",
    );
    expect(placementSource).not.toContain(
      "this.cancelChatByConversation(conversationId)",
    );
  });

  test("preserves a source message id and otherwise uses the dispatch id", () => {
    const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
    const bridgeStart = source.indexOf("async syncHostExecutionPlacement() {");
    const bridgeEnd = source.indexOf(
      "async sendConnectorFollowup(args)",
      bridgeStart,
    );
    const placementSource = source.slice(bridgeStart, bridgeEnd);
    expect(placementSource).toContain(
      'typeof payload.userMessageEventId === "string"',
    );
    expect(placementSource).toContain(": dispatch.dispatchId;");
    expect(placementSource).not.toContain("`placement-user:${");
    expect(placementSource).toContain("userMessageEventId,");
  });

  test("joins a crash-owned exact run before signing a restarted presence", async () => {
    const database = new Database(":memory:");
    const sql = database as unknown as SqliteDatabase;
    const inbox = new ExecutionPlacementInbox(sql);
    const session = inbox.openSession({
      ownerId: "owner",
      ownerGeneration: "generation",
      now: 1,
    });
    const dispatch = {
      dispatchId: "exec:crash-order",
      kind: "chat" as const,
      conversationId: "conv:crash-order",
      state: "computer_running",
      placement: "computer" as const,
    };
    inbox.persistClaim({
      ownerId: "owner",
      ownerGeneration: "generation",
      presenceSessionId: session.presenceSessionId,
      claimToken: "crash-claim-token",
      claimed: {
        dispatch,
        payloadJson: '{"prompt":"do not replay"}',
        payloadHash: "crash-payload-hash",
        claimExpiresAt: 30_000,
      },
      now: 2,
    });
    inbox.markAccepted("exec:crash-order", dispatch, 3);
    inbox.markRunning("exec:crash-order", 4);

    const order: string[] = [];
    const client: ExecutionPlacementClient = {
      query: async (reference) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        if (name === "getMyExecutionPlacementIdentity") {
          return {
            ownerId: "owner",
            ownerGeneration: "generation",
            protocolVersion: 1,
            serverTime: 5,
          };
        }
        if (name === "getMyExecutionDispatchStatus") {
          return dispatch;
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference, args) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        order.push(name);
        if (name === "completeMyExecutionDispatch") {
          expect(args.outcome).toBe("failed");
          return { ...dispatch, state: "failed" };
        }
        return { ok: true };
      },
      onUpdate: () => ({ unsubscribe: () => undefined }),
    };
    const bridge = new ExecutionPlacementBridge({
      client,
      database: sql,
      deviceIdentity: deviceIdentity(),
      appVersion: "test",
      getAvailability: () => ({
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: ["chat", "agent"],
      }),
      runExecution: async () => {
        throw new Error("A crash-owned execution must never replay.");
      },
      cancelExecution: async ({ dispatchId }) => {
        expect(dispatchId).toBe("exec:crash-order");
        order.push("localCancelJoined");
      },
      now: () => 5,
    });

    await bridge.start();
    expect(order.indexOf("localCancelJoined")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("localCancelJoined")).toBeLessThan(
      order.indexOf("registerMyExecutionPresence"),
    );
    expect(order.indexOf("completeMyExecutionDispatch")).toBeLessThan(
      order.indexOf("registerMyExecutionPresence"),
    );
    expect(inbox.get("exec:crash-order")).toMatchObject({
      state: "terminal",
      cancelRpcPending: false,
      terminalOutcome: "failed",
    });
    await bridge.stop();
    database.close();
  });

  test("commits SQLite then ACKs before any local effect and reports one terminal outcome", async () => {
    const database = new Database(":memory:");
    const sql = database as unknown as SqliteDatabase;
    const mutationOrder: string[] = [];
    const subscriptions = new Map<string, (value: unknown) => void>();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const dispatch = {
      dispatchId: "exec:runtime",
      kind: "chat" as const,
      conversationId: "conv:runtime",
      state: "offering",
    };
    const client: ExecutionPlacementClient = {
      query: async (reference, args) => {
        const name = getFunctionName(reference as never);
        if (name.endsWith("getMyExecutionPlacementIdentity")) {
          return {
            ownerId: "owner",
            ownerGeneration: "generation",
            protocolVersion: 1,
            serverTime: 1,
          };
        }
        if (name.endsWith("getMyExecutionDispatchStatus")) {
          return {
            ...dispatch,
            dispatchId: String(args.dispatchId),
            state: "computer_accepted",
            placement: "computer",
          };
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference, args) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        mutationOrder.push(name);
        if (name === "claimMyExecutionOffer") {
          return {
            dispatch: { ...dispatch, state: "computer_claimed" },
            payloadJson: '{"prompt":"hello"}',
            payloadHash: "payload-hash",
            claimExpiresAt: 10_000,
            replayed: false,
          };
        }
        if (name === "ackMyExecutionClaim") {
          const local = database
            .prepare(
              "SELECT state, payload_json FROM execution_placement_inbox WHERE dispatch_id = ?",
            )
            .get(args.dispatchId) as
            | { state: string; payload_json: string }
            | undefined;
          expect(local).toEqual({
            state: "claimed",
            payload_json: '{"prompt":"hello"}',
          });
          return {
            ...dispatch,
            state: "computer_accepted",
            placement: "computer",
          };
        }
        if (name === "markMyExecutionRunning") {
          return {
            ...dispatch,
            state: "computer_running",
            placement: "computer",
          };
        }
        if (name === "completeMyExecutionDispatch") {
          expect(args.outcome).toBe("completed");
          finish();
          return {
            ...dispatch,
            state: "completed",
            placement: "computer",
          };
        }
        return { ok: true };
      },
      onUpdate: (reference, _args, onValue) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        subscriptions.set(name, onValue);
        return { unsubscribe: () => subscriptions.delete(name) };
      },
    };
    const bridge = new ExecutionPlacementBridge({
      client,
      database: sql,
      deviceIdentity: deviceIdentity(),
      appVersion: "test",
      getAvailability: () => ({
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: [
          "chat",
          "agent",
          "computer-use",
          "local-files",
          "local-apps",
        ],
      }),
      runExecution: async ({ payload }) => {
        expect(payload).toEqual({ prompt: "hello" });
        expect(mutationOrder.indexOf("ackMyExecutionClaim")).toBeGreaterThan(
          -1,
        );
        expect(mutationOrder.indexOf("ackMyExecutionClaim")).toBeLessThan(
          mutationOrder.indexOf("markMyExecutionRunning"),
        );
        const local = database
          .prepare(
            "SELECT state FROM execution_placement_inbox WHERE dispatch_id = ?",
          )
          .get(dispatch.dispatchId) as { state: string };
        expect(local.state).toBe("running");
        return { status: "ok", finalText: "done" };
      },
      cancelExecution: async () => undefined,
    });
    await bridge.start();
    subscriptions.get("listMyExecutionOffers")?.([
      { dispatch, requiredCapabilities: ["chat"], expiresAt: 10_000 },
    ]);
    await finished;
    // The fake completion resolves while the mutation is in flight; let the
    // bridge consume its response and commit the terminal receipt.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutationOrder).toContain("claimMyExecutionOffer");
    expect(mutationOrder).toContain("completeMyExecutionDispatch");
    const terminal = database
      .prepare(
        "SELECT state, terminal_outcome FROM execution_placement_inbox WHERE dispatch_id = ?",
      )
      .get(dispatch.dispatchId) as {
      state: string;
      terminal_outcome: string;
    };
    expect(terminal).toEqual({
      state: "terminal",
      terminal_outcome: "completed",
    });
    await bridge.stop();
    database.close();
  });

  test("honors a remote cancellation before classifying a restarted local run as interrupted", async () => {
    const database = new Database(":memory:");
    const sql = database as unknown as SqliteDatabase;
    const inbox = new ExecutionPlacementInbox(sql);
    const session = inbox.openSession({
      ownerId: "owner",
      ownerGeneration: "generation",
      now: 1,
    });
    const dispatch = {
      dispatchId: "exec:restart-cancel",
      kind: "chat" as const,
      conversationId: "conv:restart-cancel",
      state: "computer_claimed",
    };
    inbox.persistClaim({
      ownerId: "owner",
      ownerGeneration: "generation",
      presenceSessionId: session.presenceSessionId,
      claimToken: "restart-claim-token",
      claimed: {
        dispatch,
        payloadJson: '{"prompt":"cancel after crash"}',
        payloadHash: "restart-payload-hash",
        claimExpiresAt: 30_000,
      },
      now: 2,
    });
    inbox.markAccepted(
      dispatch.dispatchId,
      { ...dispatch, state: "computer_accepted", placement: "computer" },
      3,
    );
    inbox.markRunning(dispatch.dispatchId, 4);

    let cancelCalls = 0;
    let executionCalls = 0;
    const completionOutcomes: unknown[] = [];
    const client: ExecutionPlacementClient = {
      query: async (reference) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        if (name === "getMyExecutionPlacementIdentity") {
          return {
            ownerId: "owner",
            ownerGeneration: "generation",
            protocolVersion: 1,
            serverTime: 5,
          };
        }
        if (name === "getMyExecutionDispatchStatus") {
          return {
            ...dispatch,
            state: "cancel_pending",
            placement: "computer",
          };
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference, args) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        if (name === "completeMyExecutionDispatch") {
          completionOutcomes.push(args.outcome);
          return { ...dispatch, state: "canceled", placement: "computer" };
        }
        return { ok: true };
      },
      onUpdate: () => ({ unsubscribe: () => undefined }),
    };
    const bridge = new ExecutionPlacementBridge({
      client,
      database: sql,
      deviceIdentity: deviceIdentity(),
      appVersion: "test",
      getAvailability: () => ({
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: ["chat", "agent"],
      }),
      runExecution: async () => {
        executionCalls += 1;
        return { status: "ok", finalText: "must not replay" };
      },
      cancelExecution: async () => {
        cancelCalls += 1;
      },
      now: () => 10,
    });

    await bridge.start();
    expect(cancelCalls).toBe(1);
    expect(executionCalls).toBe(0);
    expect(completionOutcomes).toEqual(["canceled"]);
    expect(
      database
        .prepare(
          "SELECT state, terminal_outcome FROM execution_placement_inbox WHERE dispatch_id = ?",
        )
        .get(dispatch.dispatchId),
    ).toEqual({ state: "terminal", terminal_outcome: "canceled" });
    await bridge.stop();
    database.close();
  });

  test("keeps restart cancellation durable and unsigned until the local RPC is acknowledged", async () => {
    const database = new Database(":memory:");
    const sql = database as unknown as SqliteDatabase;
    const inbox = new ExecutionPlacementInbox(sql);
    const session = inbox.openSession({
      ownerId: "owner",
      ownerGeneration: "generation",
      now: 1,
    });
    const dispatch = {
      dispatchId: "exec:restart-cancel-retry",
      kind: "agent" as const,
      conversationId: "conv:restart-cancel-retry",
      state: "computer_claimed",
    };
    inbox.persistClaim({
      ownerId: "owner",
      ownerGeneration: "generation",
      presenceSessionId: session.presenceSessionId,
      claimToken: "restart-retry-token",
      claimed: {
        dispatch,
        payloadJson: '{"prompt":"cancel after crash"}',
        payloadHash: "restart-retry-hash",
        claimExpiresAt: 30_000,
      },
      now: 2,
    });
    inbox.markAccepted(
      dispatch.dispatchId,
      { ...dispatch, state: "computer_accepted", placement: "computer" },
      3,
    );
    inbox.markRunning(dispatch.dispatchId, 4);

    let allowCancellation = false;
    const cancellationTargets: Array<{
      dispatchId: string;
      kind: string;
      conversationId: string;
    }> = [];
    const completionOutcomes: unknown[] = [];
    const client: ExecutionPlacementClient = {
      query: async (reference) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        if (name === "getMyExecutionPlacementIdentity") {
          return {
            ownerId: "owner",
            ownerGeneration: "generation",
            protocolVersion: 1,
            serverTime: 5,
          };
        }
        if (name === "getMyExecutionDispatchStatus") {
          return {
            ...dispatch,
            state: "cancel_pending",
            placement: "computer",
          };
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference, args) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        if (name === "completeMyExecutionDispatch") {
          completionOutcomes.push(args.outcome);
          return { ...dispatch, state: "canceled", placement: "computer" };
        }
        return { ok: true };
      },
      onUpdate: () => ({ unsubscribe: () => undefined }),
    };
    const bridge = new ExecutionPlacementBridge({
      client,
      database: sql,
      deviceIdentity: deviceIdentity(),
      appVersion: "test",
      getAvailability: () => ({
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: ["chat", "agent"],
      }),
      runExecution: async () => {
        throw new Error("A restarted local effect must never replay.");
      },
      cancelExecution: async (target) => {
        cancellationTargets.push(target);
        if (!allowCancellation) throw new Error("worker unavailable");
      },
      now: () => 10,
    });

    await bridge.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancellationTargets[0]).toEqual({
      dispatchId: dispatch.dispatchId,
      kind: "agent",
      conversationId: dispatch.conversationId,
    });
    expect(completionOutcomes).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT state, cancel_rpc_pending, terminal_outcome
           FROM execution_placement_inbox WHERE dispatch_id = ?`,
        )
        .get(dispatch.dispatchId),
    ).toEqual({
      state: "running",
      cancel_rpc_pending: 1,
      terminal_outcome: "canceled",
    });

    allowCancellation = true;
    await (bridge as unknown as { heartbeat(): Promise<void> }).heartbeat();
    expect(completionOutcomes).toEqual(["canceled"]);
    expect(
      database
        .prepare(
          `SELECT state, cancel_rpc_pending, terminal_outcome
           FROM execution_placement_inbox WHERE dispatch_id = ?`,
        )
        .get(dispatch.dispatchId),
    ).toEqual({
      state: "terminal",
      cancel_rpc_pending: 0,
      terminal_outcome: "canceled",
    });
    await bridge.stop();
    database.close();
  });

  test("does not sign an interrupted restart failure before exact local cancellation succeeds", async () => {
    const database = new Database(":memory:");
    const sql = database as unknown as SqliteDatabase;
    const inbox = new ExecutionPlacementInbox(sql);
    const session = inbox.openSession({
      ownerId: "owner",
      ownerGeneration: "generation",
      now: 1,
    });
    const dispatch = {
      dispatchId: "exec:restart-interrupted-retry",
      kind: "agent" as const,
      conversationId: "conv:restart-interrupted-retry",
      state: "computer_claimed",
    };
    inbox.persistClaim({
      ownerId: "owner",
      ownerGeneration: "generation",
      presenceSessionId: session.presenceSessionId,
      claimToken: "interrupted-retry-token",
      claimed: {
        dispatch,
        payloadJson: '{"prompt":"do not replay"}',
        payloadHash: "interrupted-retry-hash",
        claimExpiresAt: 30_000,
      },
      now: 2,
    });
    inbox.markAccepted(
      dispatch.dispatchId,
      { ...dispatch, state: "computer_accepted", placement: "computer" },
      3,
    );
    inbox.markRunning(dispatch.dispatchId, 4);

    let allowCancellation = false;
    const completionOutcomes: unknown[] = [];
    const client: ExecutionPlacementClient = {
      query: async (reference) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        if (name === "getMyExecutionPlacementIdentity") {
          return {
            ownerId: "owner",
            ownerGeneration: "generation",
            protocolVersion: 1,
            serverTime: 5,
          };
        }
        if (name === "getMyExecutionDispatchStatus") {
          return {
            ...dispatch,
            state: "computer_running",
            placement: "computer",
          };
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference, args) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        if (name === "completeMyExecutionDispatch") {
          completionOutcomes.push(args.outcome);
          return { ...dispatch, state: "failed", placement: "computer" };
        }
        return { ok: true };
      },
      onUpdate: () => ({ unsubscribe: () => undefined }),
    };
    const bridge = new ExecutionPlacementBridge({
      client,
      database: sql,
      deviceIdentity: deviceIdentity(),
      appVersion: "test",
      getAvailability: () => ({
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: ["chat", "agent"],
      }),
      runExecution: async () => {
        throw new Error("A restarted local effect must never replay.");
      },
      cancelExecution: async () => {
        if (!allowCancellation) throw new Error("worker unavailable");
      },
      now: () => 10,
    });

    await bridge.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completionOutcomes).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT state, cancel_rpc_pending, terminal_outcome, error_code
           FROM execution_placement_inbox WHERE dispatch_id = ?`,
        )
        .get(dispatch.dispatchId),
    ).toEqual({
      state: "running",
      cancel_rpc_pending: 1,
      terminal_outcome: "failed",
      error_code: "LOCAL_EXECUTION_INTERRUPTED",
    });

    allowCancellation = true;
    await (bridge as unknown as { heartbeat(): Promise<void> }).heartbeat();
    expect(completionOutcomes).toEqual(["failed"]);
    expect(
      database
        .prepare(
          `SELECT state, cancel_rpc_pending, terminal_outcome, error_code
           FROM execution_placement_inbox WHERE dispatch_id = ?`,
        )
        .get(dispatch.dispatchId),
    ).toEqual({
      state: "terminal",
      cancel_rpc_pending: 0,
      terminal_outcome: "failed",
      error_code: "LOCAL_EXECUTION_INTERRUPTED",
    });
    await bridge.stop();
    database.close();
  });

  test("retries a persisted claim ACK in the same process without re-executing", async () => {
    const database = new Database(":memory:");
    const subscriptions = new Map<string, (value: unknown) => void>();
    let now = 100;
    let ackCalls = 0;
    let executionCalls = 0;
    let completedResolve!: () => void;
    const completed = new Promise<void>((resolve) => {
      completedResolve = resolve;
    });
    const dispatch = {
      dispatchId: "exec:ack-retry",
      kind: "chat" as const,
      conversationId: "conv:ack-retry",
      state: "offering",
    };
    const client: ExecutionPlacementClient = {
      query: async (reference) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        if (name === "getMyExecutionPlacementIdentity") {
          return {
            ownerId: "owner",
            ownerGeneration: "generation",
            protocolVersion: 1,
            serverTime: now,
          };
        }
        if (name === "getMyExecutionDispatchStatus") {
          return {
            ...dispatch,
            state: "computer_claimed",
            placement: "computer",
          };
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        if (name === "claimMyExecutionOffer") {
          return {
            dispatch: { ...dispatch, state: "computer_claimed" },
            payloadJson: '{"prompt":"retry once"}',
            payloadHash: "retry-payload-hash",
            claimExpiresAt: now + 30_000,
          };
        }
        if (name === "ackMyExecutionClaim") {
          ackCalls += 1;
          if (ackCalls === 1) throw new Error("transient ACK transport loss");
          return {
            ...dispatch,
            state: "computer_accepted",
            placement: "computer",
          };
        }
        if (name === "markMyExecutionRunning") {
          return {
            ...dispatch,
            state: "computer_running",
            placement: "computer",
          };
        }
        if (name === "completeMyExecutionDispatch") {
          completedResolve();
          return { ...dispatch, state: "completed", placement: "computer" };
        }
        return { ok: true };
      },
      onUpdate: (reference, _args, onValue) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        subscriptions.set(name, onValue);
        return { unsubscribe: () => subscriptions.delete(name) };
      },
    };
    const bridge = new ExecutionPlacementBridge({
      client,
      database: database as unknown as SqliteDatabase,
      deviceIdentity: deviceIdentity(),
      appVersion: "test",
      getAvailability: () => ({
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: ["chat", "agent"],
      }),
      runExecution: async () => {
        executionCalls += 1;
        return { status: "ok", finalText: "done" };
      },
      cancelExecution: async () => undefined,
      now: () => now,
      claimAckRetryBaseMs: 1,
    });

    await bridge.start();
    subscriptions.get("listMyExecutionOffers")?.([
      { dispatch, requiredCapabilities: ["chat"], expiresAt: now + 10_000 },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ackCalls).toBe(1);
    expect(executionCalls).toBe(0);
    expect(
      database
        .prepare(
          "SELECT state FROM execution_placement_inbox WHERE dispatch_id = ?",
        )
        .get(dispatch.dispatchId),
    ).toEqual({ state: "claimed" });

    now += 2;
    await (bridge as unknown as { heartbeat(): Promise<void> }).heartbeat();
    await completed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ackCalls).toBe(2);
    expect(executionCalls).toBe(1);
    expect(
      database
        .prepare(
          "SELECT state FROM execution_placement_inbox WHERE dispatch_id = ?",
        )
        .get(dispatch.dispatchId),
    ).toEqual({ state: "terminal" });
    await bridge.stop();
    database.close();
  });

  test("joins a stopped offer before a replacement proof session starts", async () => {
    const database = new Database(":memory:");
    const subscriptions = new Map<string, (value: unknown) => void>();
    const mutationOrder: string[] = [];
    const proofSequences: number[] = [];
    let releaseClaim!: (value: unknown) => void;
    const claim = new Promise<unknown>((resolve) => {
      releaseClaim = resolve;
    });
    let cancelCalls = 0;
    let executionCalls = 0;
    const dispatch = {
      dispatchId: "exec:stop-claim",
      kind: "chat" as const,
      conversationId: "conv:stop-claim",
      state: "offering",
    };
    const client: ExecutionPlacementClient = {
      query: async (reference) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        if (name === "getMyExecutionPlacementIdentity") {
          return {
            ownerId: "owner",
            ownerGeneration: "generation",
            protocolVersion: 1,
            serverTime: 1,
          };
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference, args) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        mutationOrder.push(name);
        if (typeof args.sequence === "number") proofSequences.push(args.sequence);
        if (name === "claimMyExecutionOffer") return await claim;
        if (name === "releaseMyExecutionClaim") {
          return { ...dispatch, state: "offering" };
        }
        return { ok: true };
      },
      onUpdate: (reference, _args, onValue) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        subscriptions.set(name, onValue);
        return { unsubscribe: () => subscriptions.delete(name) };
      },
    };
    const makeBridge = () =>
      new ExecutionPlacementBridge({
        client,
        database: database as unknown as SqliteDatabase,
        deviceIdentity: deviceIdentity(),
        appVersion: "test",
        getAvailability: () => ({
          ready: true,
          chatSlots: 1,
          agentSlots: 1,
          capabilities: ["chat", "agent"],
        }),
        runExecution: async () => {
          executionCalls += 1;
          return { status: "ok", finalText: "must not run" };
        },
        cancelExecution: async () => {
          cancelCalls += 1;
        },
      });

    const first = makeBridge();
    await first.start();
    subscriptions.get("listMyExecutionOffers")?.([
      { dispatch, requiredCapabilities: ["chat"], expiresAt: 10_000 },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutationOrder).toContain("claimMyExecutionOffer");

    let replacementStarted = false;
    const second = makeBridge();
    const replacement = first.stop().then(async () => {
      await second.start();
      replacementStarted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replacementStarted).toBe(false);
    expect(
      mutationOrder.filter((name) => name === "registerMyExecutionPresence"),
    ).toHaveLength(1);

    releaseClaim({
      dispatch: { ...dispatch, state: "computer_claimed" },
      payloadJson: '{"prompt":"must be canceled"}',
      payloadHash: "stop-payload-hash",
      claimExpiresAt: 30_000,
    });
    await replacement;
    expect(executionCalls).toBe(0);
    expect(cancelCalls).toBe(1);
    expect(mutationOrder).toEqual([
      "registerMyExecutionPresence",
      "claimMyExecutionOffer",
      "releaseMyExecutionClaim",
      "drainMyExecutionPresence",
      "registerMyExecutionPresence",
    ]);
    expect(proofSequences).toEqual([...proofSequences].sort((a, b) => a - b));
    expect(new Set(proofSequences).size).toBe(proofSequences.length);
    await second.stop();
    database.close();
  });

  test("keeps stop retryable and never signs canceled while local cancellation is unacknowledged", async () => {
    const database = new Database(":memory:");
    const subscriptions = new Map<string, (value: unknown) => void>();
    let allowCancellation = false;
    let finishExecution!: () => void;
    const executionFinished = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    let runningResolve!: () => void;
    const running = new Promise<void>((resolve) => {
      runningResolve = resolve;
    });
    const completionOutcomes: unknown[] = [];
    const dispatch = {
      dispatchId: "exec:stop-cancel-retry",
      kind: "agent" as const,
      conversationId: "conv:stop-cancel-retry",
      state: "offering",
    };
    const client: ExecutionPlacementClient = {
      query: async (reference) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        if (name === "getMyExecutionPlacementIdentity") {
          return {
            ownerId: "owner",
            ownerGeneration: "generation",
            protocolVersion: 1,
            serverTime: 1,
          };
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference, args) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        if (name === "claimMyExecutionOffer") {
          return {
            dispatch: { ...dispatch, state: "computer_claimed" },
            payloadJson: '{"prompt":"stop me"}',
            payloadHash: "stop-cancel-hash",
            claimExpiresAt: 30_000,
          };
        }
        if (name === "ackMyExecutionClaim") {
          return {
            ...dispatch,
            state: "computer_accepted",
            placement: "computer",
          };
        }
        if (name === "markMyExecutionRunning") {
          runningResolve();
          return {
            ...dispatch,
            state: "computer_running",
            placement: "computer",
          };
        }
        if (name === "completeMyExecutionDispatch") {
          completionOutcomes.push(args.outcome);
          return { ...dispatch, state: "canceled", placement: "computer" };
        }
        return { ok: true };
      },
      onUpdate: (reference, _args, onValue) => {
        const name = getFunctionName(reference as never).split(":").at(-1)!;
        subscriptions.set(name, onValue);
        return { unsubscribe: () => subscriptions.delete(name) };
      },
    };
    const bridge = new ExecutionPlacementBridge({
      client,
      database: database as unknown as SqliteDatabase,
      deviceIdentity: deviceIdentity(),
      appVersion: "test",
      getAvailability: () => ({
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: ["chat", "agent"],
      }),
      runExecution: async () => {
        await executionFinished;
        return { status: "canceled" };
      },
      cancelExecution: async () => {
        if (!allowCancellation) throw new Error("worker cancellation unavailable");
        finishExecution();
      },
    });

    await bridge.start();
    subscriptions.get("listMyExecutionOffers")?.([
      { dispatch, requiredCapabilities: ["agent"], expiresAt: 10_000 },
    ]);
    await running;
    await expect(bridge.stop()).rejects.toThrow(
      "unacknowledged local cancellation",
    );
    expect(completionOutcomes).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT state, cancel_rpc_pending, terminal_outcome
           FROM execution_placement_inbox WHERE dispatch_id = ?`,
        )
        .get(dispatch.dispatchId),
    ).toEqual({
      state: "running",
      cancel_rpc_pending: 1,
      terminal_outcome: "canceled",
    });

    allowCancellation = true;
    await bridge.stop();
    expect(completionOutcomes).toEqual(["canceled"]);
    expect(
      database
        .prepare(
          "SELECT state, cancel_rpc_pending FROM execution_placement_inbox WHERE dispatch_id = ?",
        )
        .get(dispatch.dispatchId),
    ).toEqual({ state: "terminal", cancel_rpc_pending: 0 });
    database.close();
  });

  test("fails closed on a lost lease and rebinds after a web-triggered reset rotates generation", async () => {
    const database = new Database(":memory:");
    const subscriptions = new Map<string, (value: unknown) => void>();
    const registrationGenerations: string[] = [];
    let now = 1_000;
    let currentGeneration = "generation-one";
    let purgeActive = false;
    let cancelCalls = 0;
    let runningResolve!: () => void;
    const running = new Promise<void>((resolve) => {
      runningResolve = resolve;
    });
    let finishExecution!: () => void;
    const executionFinished = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    let completeResolve!: () => void;
    const completed = new Promise<void>((resolve) => {
      completeResolve = resolve;
    });
    const dispatch = {
      dispatchId: "exec:reset-fence",
      kind: "chat" as const,
      conversationId: "conv:reset-fence",
      state: "offering",
    };
    const client: ExecutionPlacementClient = {
      query: async (reference) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        if (name === "getMyExecutionPlacementIdentity") {
          if (purgeActive) throw new Error("OWNER_DATA_PURGE_ACTIVE");
          return {
            ownerId: "owner",
            ownerGeneration: currentGeneration,
            protocolVersion: 1,
            serverTime: now,
          };
        }
        if (name === "getMyExecutionDispatchStatus") {
          return {
            ...dispatch,
            state: "computer_accepted",
            placement: "computer",
          };
        }
        throw new Error(`Unexpected query: ${name}`);
      },
      mutation: async (reference, args) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        if (name === "registerMyExecutionPresence") {
          registrationGenerations.push(String(args.ownerGeneration));
          return { ok: true };
        }
        if (name === "heartbeatMyExecutionPresence") {
          if (purgeActive || args.ownerGeneration !== currentGeneration) {
            throw new Error("OWNER_DATA_GENERATION_STALE");
          }
          return { ok: true };
        }
        if (name === "claimMyExecutionOffer") {
          return {
            dispatch: { ...dispatch, state: "computer_claimed" },
            payloadJson: '{"prompt":"reset me"}',
            payloadHash: "payload-hash",
            claimExpiresAt: now + 30_000,
            replayed: false,
          };
        }
        if (name === "ackMyExecutionClaim") {
          return {
            ...dispatch,
            state: "computer_accepted",
            placement: "computer",
          };
        }
        if (name === "markMyExecutionRunning") {
          runningResolve();
          return {
            ...dispatch,
            state: "computer_running",
            placement: "computer",
          };
        }
        if (name === "renewMyExecutionClaim") {
          if (purgeActive || args.ownerGeneration !== currentGeneration) {
            throw new Error("OWNER_DATA_PURGE_ACTIVE");
          }
          return {
            ...dispatch,
            state: "computer_running",
            placement: "computer",
          };
        }
        if (name === "completeMyExecutionDispatch") {
          expect(args.outcome).toBe("canceled");
          completeResolve();
          return {
            ...dispatch,
            state: "canceled",
            placement: "computer",
          };
        }
        return { ok: true };
      },
      onUpdate: (reference, _args, onValue) => {
        const name = getFunctionName(reference as never)
          .split(":")
          .at(-1)!;
        subscriptions.set(name, onValue);
        return { unsubscribe: () => subscriptions.delete(name) };
      },
    };
    const bridge = new ExecutionPlacementBridge({
      client,
      database: database as unknown as SqliteDatabase,
      deviceIdentity: deviceIdentity(),
      appVersion: "test",
      getAvailability: () => ({
        ready: true,
        chatSlots: 1,
        agentSlots: 1,
        capabilities: ["chat", "agent"],
      }),
      runExecution: async () => {
        await executionFinished;
        return { status: "canceled" };
      },
      cancelExecution: async () => {
        cancelCalls += 1;
        finishExecution();
      },
      now: () => now,
      leaseRenewalGraceMs: 10,
    });
    await bridge.start();
    const firstSession = database
      .prepare(
        "SELECT presence_session_id FROM execution_placement_runtime_state WHERE id = 1",
      )
      .get() as { presence_session_id: string };
    subscriptions.get("listMyExecutionOffers")?.([
      { dispatch, requiredCapabilities: ["chat"], expiresAt: now + 10_000 },
    ]);
    await running;

    purgeActive = true;
    await (bridge as unknown as { heartbeat(): Promise<void> }).heartbeat();
    now += 11;
    await (bridge as unknown as { heartbeat(): Promise<void> }).heartbeat();
    await completed;
    expect(cancelCalls).toBeGreaterThanOrEqual(1);
    expect(
      database
        .prepare(
          "SELECT state, terminal_outcome FROM execution_placement_inbox WHERE dispatch_id = ?",
        )
        .get(dispatch.dispatchId),
    ).toEqual({ state: "terminal", terminal_outcome: "canceled" });

    purgeActive = false;
    currentGeneration = "generation-two";
    now += 1;
    await (bridge as unknown as { heartbeat(): Promise<void> }).heartbeat();
    const rebound = database
      .prepare(
        "SELECT owner_generation, presence_session_id FROM execution_placement_runtime_state WHERE id = 1",
      )
      .get() as { owner_generation: string; presence_session_id: string };
    expect(rebound.owner_generation).toBe("generation-two");
    expect(rebound.presence_session_id).not.toBe(
      firstSession.presence_session_id,
    );
    expect(registrationGenerations).toEqual([
      "generation-one",
      "generation-two",
    ]);
    await bridge.stop();
    database.close();
  });
});
