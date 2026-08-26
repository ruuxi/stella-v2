import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDesktopDatabase } from "../../kernel/storage/database-init.js";
import { SessionStore } from "../../kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../kernel/storage/shared.js";
import { VoiceRuntimeService } from "./service.js";

const makeVoiceToolReceiptMethods = () => {
  const receipts = new Map<
    string,
    {
      requestFingerprint: string;
      operationId: string;
      startedAt: number;
      completionJson?: string;
    }
  >();
  return {
    beginVoiceToolCallReceipt: (args: {
      conversationId: string;
      callId: string;
      requestFingerprint: string;
      operationId: string;
      startedAt: number;
    }) => {
      const key = `${args.conversationId}\u0000${args.callId}`;
      const existing = receipts.get(key);
      if (existing) {
        if (existing.requestFingerprint !== args.requestFingerprint) {
          throw new Error("Voice tool call id was reused.");
        }
        return existing.completionJson
          ? ({
              status: "completed",
              operationId: existing.operationId,
              startedAt: existing.startedAt,
              completionJson: existing.completionJson,
            } as const)
          : ({
              status: "pending",
              operationId: existing.operationId,
              startedAt: existing.startedAt,
            } as const);
      }
      receipts.set(key, {
        requestFingerprint: args.requestFingerprint,
        operationId: args.operationId,
        startedAt: args.startedAt,
      });
      return {
        status: "started",
        operationId: args.operationId,
        startedAt: args.startedAt,
      } as const;
    },
    completeVoiceToolCallReceipt: (args: {
      conversationId: string;
      callId: string;
      requestFingerprint: string;
      completionJson: string;
    }) => {
      const key = `${args.conversationId}\u0000${args.callId}`;
      const existing = receipts.get(key);
      if (
        !existing ||
        existing.requestFingerprint !== args.requestFingerprint
      ) {
        throw new Error("Voice tool receipt mismatch.");
      }
      existing.completionJson = args.completionJson;
    },
  };
};

const makeService = () => {
  const appended: Array<{
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }> = [];
  const historyChanges: string[] = [];
  const localChatCalls: Array<Record<string, unknown>> = [];
  const cloudAppends: Array<{
    conversationId: string;
    appendId: string;
    records: Array<{
      kind: "message";
      role: "user" | "assistant" | "toolResult";
      payloadJson: string;
      hidden?: boolean;
    }>;
  }> = [];
  const receiptMethods = makeVoiceToolReceiptMethods();
  const runner = {
    ...receiptMethods,
    appendThreadMessage: (entry: (typeof appended)[number]) => {
      appended.push(entry);
    },
    notifyOrchestratorHistoryChanged: (conversationId: string) => {
      historyChanges.push(conversationId);
    },
    appendCloudJournal: async (request: (typeof cloudAppends)[number]) => {
      cloudAppends.push(request);
      return { queued: true as const, replayed: false };
    },
    getVoiceOrchestratorConfig: async () => ({
      instructions: "Use tools.",
      tools: [
        {
          name: "lookup",
          description: "Look something up.",
          parameters: {},
        },
      ],
    }),
    executeTool: async () => ({ result: { answer: 42 } }),
    handleLocalChat: async (
      payload: Record<string, unknown>,
      callbacks: {
        onEnd: (event: {
          runId: string;
          seq: number;
          finalText: string;
        }) => void;
      },
    ) => {
      localChatCalls.push(payload);
      callbacks.onEnd({ runId: "voice-run", seq: 1, finalText: "Done" });
      return { runId: "voice-run" };
    },
  };
  const service = new VoiceRuntimeService({
    getRunner: () => runner as never,
    getDeviceId: () => "device-1",
    emitAgentEvent: () => undefined,
  });
  return {
    service,
    appended,
    historyChanges,
    localChatCalls,
    cloudAppends,
  };
};

describe("voice conversation ownership", () => {
  test("queues realtime transcripts in canonical cloud history", async () => {
    const { service, appended, historyChanges, cloudAppends } = makeService();

    await expect(
      service.persistTranscript({
        conversationId: "cloud-conversation",
        eventId: "voice-session:1",
        timestamp: 1_234,
        role: "user",
        text: "Hello from voice",
        uiVisibility: "hidden",
      }),
    ).resolves.toEqual({ ok: true });
    expect(appended).toEqual([]);
    expect(historyChanges).toEqual([]);
    expect(cloudAppends).toHaveLength(1);
    expect(cloudAppends[0]).toMatchObject({
      conversationId: "cloud-conversation",
      records: [{ kind: "message", role: "user", hidden: true }],
    });
    expect(JSON.parse(cloudAppends[0]!.records[0]!.payloadJson)).toMatchObject({
      role: "user",
      source: "voice",
      content: [{ type: "text", text: "Hello from voice" }],
    });
  });

  test("replays a lost ACK with the original timestamp and no duplicate mirror", async () => {
    const appended: Array<{
      threadKey: string;
      role: "user" | "assistant";
      content: string;
    }> = [];
    const admissions = new Map<string, string>();
    const journalPayloads: string[] = [];
    const service = new VoiceRuntimeService({
      getRunner: () =>
        ({
          appendThreadMessage: (entry: (typeof appended)[number]) => {
            appended.push(entry);
          },
          notifyOrchestratorHistoryChanged: () => undefined,
          appendCloudJournal: async (request: {
            appendId: string;
            records: Array<{ payloadJson: string }>;
          }) => {
            const payloadJson = request.records[0]!.payloadJson;
            journalPayloads.push(payloadJson);
            const prior = admissions.get(request.appendId);
            if (prior !== undefined && prior !== payloadJson) {
              throw new Error(
                "Cloud journal append id was reused with new payload.",
              );
            }
            admissions.set(request.appendId, payloadJson);
            return {
              queued: true as const,
              replayed: prior !== undefined,
            };
          },
        }) as never,
      getDeviceId: () => "device-1",
      emitAgentEvent: () => undefined,
    });

    const transcript = {
      conversationId: "cloud-conversation",
      eventId: "voice-session:lost-ack",
      timestamp: 2_345,
      role: "assistant" as const,
      text: "Already queued",
    };
    const originalNow = Date.now;
    try {
      Date.now = () => 10_000;
      await expect(service.persistTranscript(transcript)).resolves.toEqual({
        ok: true,
      });
      // Simulate the renderer retrying after the first invoke response was
      // lost, at a later wall-clock value, with the same captured payload.
      Date.now = () => 99_000;
      await expect(service.persistTranscript(transcript)).resolves.toEqual({
        ok: true,
      });
    } finally {
      Date.now = originalNow;
    }

    expect(journalPayloads).toHaveLength(2);
    expect(journalPayloads[1]).toBe(journalPayloads[0]);
    expect(JSON.parse(journalPayloads[0]!)).toMatchObject({
      timestamp: 2_345,
      role: "assistant",
    });
    expect(appended).toEqual([]);
  });

  test("queues a tool call and result as one atomic cloud append", async () => {
    const { service, cloudAppends } = makeService();

    await service.executeTool({
      requestId: "voice-request",
      conversationId: "cloud-conversation",
      callId: "call-1",
      name: "lookup",
      args: { query: "answer" },
    });

    expect(cloudAppends).toHaveLength(1);
    expect(cloudAppends[0]!.records.map((record) => record.role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    expect(
      JSON.parse(cloudAppends[0]!.records[0]!.payloadJson).content,
    ).toEqual([
      {
        type: "toolCall",
        id: "call-1",
        name: "lookup",
        arguments: { query: "answer" },
      },
    ]);
  });

  test("never writes transcript or tool content to runtime_thread_entries", async () => {
    const database = new Database(":memory:");
    initializeDesktopDatabase(database as unknown as SqliteDatabase);
    const store = new SessionStore(database as unknown as SqliteDatabase);
    const service = new VoiceRuntimeService({
      getRunner: () =>
        ({
          // This compatibility trap writes the exact forbidden table if voice
          // ever regresses to the old persistent thread mirror.
          appendThreadMessage: (entry: {
            threadKey: string;
            role: "user" | "assistant";
            content: string;
          }) =>
            store.appendThreadMessage({
              ...entry,
              timestamp: Date.now(),
            }),
          notifyOrchestratorHistoryChanged: () => undefined,
          appendCloudJournal: async () => ({
            queued: true as const,
            replayed: false,
          }),
          ...makeVoiceToolReceiptMethods(),
          getVoiceOrchestratorConfig: async () => ({
            instructions: "Use tools.",
            tools: [
              {
                name: "lookup",
                description: "Look something up.",
                parameters: {},
              },
            ],
          }),
          executeTool: async () => ({ result: { answer: 42 } }),
        }) as never,
      getDeviceId: () => "device-1",
      emitAgentEvent: () => undefined,
    });

    await service.persistTranscript({
      conversationId: "cloud-conversation",
      eventId: "voice-session:sqlite-proof",
      timestamp: 3_456,
      role: "user",
      text: "Never store me locally",
    });
    await service.executeTool({
      requestId: "voice-request",
      conversationId: "cloud-conversation",
      callId: "call-sqlite-proof",
      name: "lookup",
      args: { query: "private voice content" },
    });

    const row = database
      .prepare("SELECT COUNT(*) AS count FROM runtime_thread_entries")
      .get() as { count: number };
    expect(row.count).toBe(0);
    database.close();
  });

  test("routes voice orchestrator chat through the cloud turn outbox", async () => {
    const { service, localChatCalls } = makeService();

    await expect(
      service.orchestratorChat({
        requestId: "voice-request",
        conversationId: "cloud-conversation",
        message: "Check my files",
      }),
    ).resolves.toBe("Done");

    expect(localChatCalls).toHaveLength(1);
    expect(localChatCalls[0]).toMatchObject({
      conversationId: "cloud-conversation",
      userPrompt: "Check my files",
      storageMode: "cloud",
    });
  });

  test("replays a completed tool call without repeating its side effect", async () => {
    const receiptMethods = makeVoiceToolReceiptMethods();
    const appends: Array<{
      appendId: string;
      records: Array<{ payloadJson: string }>;
    }> = [];
    let executions = 0;
    const service = new VoiceRuntimeService({
      getRunner: () =>
        ({
          ...receiptMethods,
          appendCloudJournal: async (request: (typeof appends)[number]) => {
            appends.push(request);
            return {
              queued: true as const,
              replayed: appends.length > 1,
            };
          },
          getVoiceOrchestratorConfig: async () => ({
            instructions: "Use tools.",
            tools: [{ name: "lookup", description: "Lookup", parameters: {} }],
          }),
          executeTool: async () => {
            executions += 1;
            return { result: { answer: 42 } };
          },
        }) as never,
      getDeviceId: () => "device-1",
      emitAgentEvent: () => undefined,
    });
    const call = {
      requestId: "voice-request",
      conversationId: "cloud-conversation",
      callId: "stable-call",
      name: "lookup",
      args: { b: 2, a: 1 },
    };
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      const first = await service.executeTool(call);
      Date.now = () => 99_000;
      const replay = await service.executeTool({
        ...call,
        args: { a: 1, b: 2 },
      });
      expect(replay).toEqual(first);
    } finally {
      Date.now = originalNow;
    }
    expect(executions).toBe(1);
    expect(appends).toHaveLength(2);
    expect(appends[1]).toEqual(appends[0]);
  });

  test("fails closed when a prior tool execution is still pending", async () => {
    let executions = 0;
    const service = new VoiceRuntimeService({
      getRunner: () =>
        ({
          beginVoiceToolCallReceipt: () => ({
            status: "pending" as const,
            operationId: "voice-operation",
            startedAt: 1_000,
          }),
          completeVoiceToolCallReceipt: () => undefined,
          appendCloudJournal: async () => ({
            queued: true as const,
            replayed: false,
          }),
          getVoiceOrchestratorConfig: async () => ({
            instructions: "Use tools.",
            tools: [{ name: "lookup", description: "Lookup", parameters: {} }],
          }),
          executeTool: async () => {
            executions += 1;
            return { result: "unsafe duplicate" };
          },
        }) as never,
      getDeviceId: () => "device-1",
      emitAgentEvent: () => undefined,
    });
    await expect(
      service.executeTool({
        requestId: "voice-request",
        conversationId: "cloud-conversation",
        callId: "pending-call",
        name: "lookup",
        args: {},
      }),
    ).rejects.toThrow("cannot be repeated safely");
    expect(executions).toBe(0);
  });
});
