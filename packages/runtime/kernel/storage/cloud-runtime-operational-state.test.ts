import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDesktopDatabase } from "./database-init.js";
import { SessionStore } from "./session-store.js";
import type {
  PersistedRuntimeThreadPayload,
  SqliteDatabase,
} from "./shared.js";

const openStore = () => {
  const database = new Database(":memory:");
  initializeDesktopDatabase(database as unknown as SqliteDatabase);
  return {
    database,
    store: new SessionStore(database as unknown as SqliteDatabase),
  };
};

describe("cloud runtime operational state", () => {
  test("keeps cloud turn payloads in a seeded in-memory capture", () => {
    const { database, store } = openStore();
    const seed = {
      role: "user",
      content: [{ type: "text", text: "canonical history" }],
      timestamp: 1,
    } as PersistedRuntimeThreadPayload;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "cloud-only response" }],
      api: "openai-completions",
      provider: "stella",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    } as PersistedRuntimeThreadPayload;

    store.beginEphemeralThreadCapture({
      threadKey: "conversation-1",
      captureId: "run-1",
      seedMessages: [
        {
          timestamp: 1,
          role: "user",
          content: "canonical history",
          payload: seed,
        },
      ],
    });
    store.appendThreadMessage({
      threadKey: "conversation-1",
      timestamp: 2,
      role: "assistant",
      content: "cloud-only response",
      payload: assistant,
    });

    expect(
      store.loadThreadMessages("conversation-1").map((row) => row.content),
    ).toEqual(["canonical history", "cloud-only response"]);
    expect(
      store
        .readEphemeralThreadCapture({
          threadKey: "conversation-1",
          captureId: "run-1",
        })
        .map((row) => row.payload),
    ).toEqual([assistant]);
    store.compactThread({
      threadKey: "conversation-1",
      summary: "must remain ephemeral",
      fromEntryId: "ephemeral:run-1:seed:0",
      toEntryId: "ephemeral:run-1:0",
      tokensBefore: 100,
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM thread_entry")
        .get(),
    ).toEqual({ count: 0 });

    store.endEphemeralThreadCapture({
      threadKey: "conversation-1",
      captureId: "run-1",
    });
    expect(store.loadThreadMessages("conversation-1")).toEqual([]);
    database.close();
  });

  test("persists cloud ownership with operational agent rows", () => {
    const { database, store } = openStore();
    store.saveAgentRecord({
      threadId: "thread-cloud",
      conversationId: "conversation-1",
      storageMode: "cloud",
      agentType: "general",
      description: "Build the report",
      agentDepth: 1,
      status: "running",
      attemptGeneration: 1,
      cloudTerminalReceiptGeneration: 1,
      terminalLifecycleReceiptGeneration: 1,
      descendantBoundaryState: {
        consumedEventIds: ["child:1:agent-completed"],
        wakePending: true,
      },
      startedAt: 100,
      completedAt: null,
      updatedAt: 101,
    });

    expect(store.getAgentRecord("thread-cloud")?.storageMode).toBe("cloud");
    expect(
      store.getAgentRecord("thread-cloud")?.cloudTerminalReceiptGeneration,
    ).toBe(1);
    expect(
      store.getAgentRecord("thread-cloud")
        ?.terminalLifecycleReceiptGeneration,
    ).toBe(1);
    expect(
      store.getAgentRecord("thread-cloud")?.descendantBoundaryState,
    ).toEqual({
      consumedEventIds: ["child:1:agent-completed"],
      wakePending: true,
    });
    expect(store.listAgentRecordsByStatus("running")[0]?.storageMode).toBe(
      "cloud",
    );
    expect(
      store.listAgentRecordsByStatus("running")[0]
        ?.cloudTerminalReceiptGeneration,
    ).toBe(1);
    database.close();
  });

  test("voice tool receipts survive a store restart and fail closed pending", () => {
    const { database, store } = openStore();
    const identity = {
      conversationId: "conversation-1",
      callId: "call-1",
      requestFingerprint: "fingerprint-1",
      operationId: "operation-1",
      startedAt: 1_000,
    };
    expect(store.beginVoiceToolCallReceipt(identity)).toEqual({
      status: "started",
      operationId: "operation-1",
      startedAt: 1_000,
    });

    const restarted = new SessionStore(database as unknown as SqliteDatabase);
    expect(restarted.beginVoiceToolCallReceipt(identity)).toEqual({
      status: "pending",
      operationId: "operation-1",
      startedAt: 1_000,
    });
    restarted.completeVoiceToolCallReceipt({
      conversationId: identity.conversationId,
      callId: identity.callId,
      requestFingerprint: identity.requestFingerprint,
      completionJson: '{"response":{"output":"done"},"records":[]}',
    });
    expect(restarted.beginVoiceToolCallReceipt(identity)).toEqual({
      status: "completed",
      operationId: "operation-1",
      startedAt: 1_000,
      completionJson: '{"response":{"output":"done"},"records":[]}',
    });
    expect(() =>
      restarted.beginVoiceToolCallReceipt({
        ...identity,
        requestFingerprint: "different",
      }),
    ).toThrow("different arguments");
    database.close();
  });
});
