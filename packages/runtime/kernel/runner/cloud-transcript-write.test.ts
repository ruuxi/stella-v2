import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDesktopDatabase } from "../storage/database-init.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import type {
  PersistedRuntimeThreadPayload,
  SqliteDatabase,
} from "../storage/shared.js";
import { createCloudTranscriptWriter } from "./cloud-transcript-write.js";

const openStore = () => {
  const database = new Database(":memory:");
  initializeDesktopDatabase(database as unknown as SqliteDatabase);
  return {
    database,
    store: new RuntimeStore(database as unknown as SqliteDatabase),
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const stores: Array<ReturnType<typeof openStore>> = [];

afterEach(() => {
  while (stores.length) stores.pop()?.database.close();
});

describe("cloud transcript writer", () => {
  test("persists begin before delivery and resolves only after lease ACK", async () => {
    const opened = openStore();
    stores.push(opened);
    const responseGate = deferred<Response>();
    let postedBody: Record<string, unknown> | null = null;
    let requests = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        requests += 1;
        postedBody = JSON.parse(String(init?.body));
        return await responseGate.promise;
      }) as unknown as typeof fetch,
    });

    const beginPromise = writer.begin({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      }),
    });
    await waitFor(() => postedBody !== null);
    expect(writer.pending()).toBe(1);
    expect(postedBody).toMatchObject({
      deviceId: "device-1",
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
    });

    responseGate.resolve(
      Response.json({
        turnId: "turn-1",
        leaseToken: "lease-1",
        history: ['{"role":"user","content":"older","timestamp":0}'],
      }),
    );
    await expect(beginPromise).resolves.toEqual({
      turnId: "turn-1",
      leaseToken: "lease-1",
      history: ['{"role":"user","content":"older","timestamp":0}'],
    });
    // The acknowledged begin remains as the in-flight crash marker, but the
    // current writer must not redeliver it while the provider is running.
    expect(writer.pending()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(requests).toBe(1);
    writer.stop();
  });

  test("begin carries attachment messages larger than one MiB without local rejection", async () => {
    const opened = openStore();
    stores.push(opened);
    const imageData = "a".repeat(1024 * 1024 + 32);
    let receivedUserMessageBytes = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = JSON.parse(String(init?.body)) as {
          userMessageJson: string;
        };
        receivedUserMessageBytes = new TextEncoder().encode(
          body.userMessageJson,
        ).length;
        return Response.json({
          turnId: "turn-1",
          leaseToken: "lease-1",
          history: [],
        });
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: JSON.stringify({
        role: "user",
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: imageData,
          },
        ],
        timestamp: 1,
      }),
    });
    expect(receivedUserMessageBytes).toBeGreaterThan(1024 * 1024);
    expect(writer.pending()).toBe(1);
    writer.stop();
  });

  test("deterministic malformed begin is dead-lettered and rejected once", async () => {
    const opened = openStore();
    stores.push(opened);
    let requests = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () => {
        requests += 1;
        return Response.json({ code: "bad_request" }, { status: 400 });
      }) as unknown as typeof fetch,
    });

    await expect(
      writer.begin({
        conversationId: "conversation-1",
        localTurnId: "local-turn-1",
        clientMsgId: "message-1",
        userMessageJson: '{"role":"user","content":[],"timestamp":1}',
      }),
    ).rejects.toThrow("rejected as malformed");
    expect(requests).toBe(1);
    expect(writer.pending()).toBe(0);
    writer.stop();
  });

  test("finish atomically replaces the active begin and deletes only after ACK", async () => {
    const opened = openStore();
    stores.push(opened);
    const responseGate = deferred<Response>();
    let deliveryStarted = false;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/begin")) {
          return Response.json({
            turnId: "turn-1",
            leaseToken: "lease-1",
            history: [],
          });
        }
        deliveryStarted = true;
        return await responseGate.promise;
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: '{"role":"user","content":[],"timestamp":1}',
    });
    expect(writer.pending()).toBe(1);
    await writer.finish({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      leaseToken: "lease-1",
      records: [
        {
          ordinal: 0,
          role: "assistant",
          payloadJson: '{"role":"assistant","content":[]}',
        },
      ],
      phase: "completed",
    });
    expect(writer.pending()).toBe(1);
    await waitFor(() => deliveryStarted);
    expect(writer.pending()).toBe(1);

    responseGate.resolve(new Response(null, { status: 204 }));
    await waitFor(() => writer.pending() === 0);
    writer.stop();
  });

  test("renews an active lease and stops heartbeats after finish", async () => {
    const opened = openStore();
    stores.push(opened);
    let beginRequests = 0;
    let finishRequests = 0;
    const beginBodies: Array<Record<string, unknown>> = [];
    const beginBodyBytes: number[] = [];
    const largePrompt = "a".repeat(1024 * 1024 + 32);
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      heartbeatIntervalMs: 15,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/begin")) {
          beginRequests += 1;
          const body = String(init?.body);
          beginBodyBytes.push(new TextEncoder().encode(body).length);
          beginBodies.push(JSON.parse(body));
          return Response.json({
            turnId: "turn-1",
            leaseToken: "lease-1",
            history: [],
          });
        }
        finishRequests += 1;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: largePrompt }],
        timestamp: 1,
      }),
    });
    await waitFor(() => beginRequests >= 3);
    expect(beginBodies[0]?.renewOnly).toBeUndefined();
    expect(beginBodyBytes[0]).toBeGreaterThan(1024 * 1024);
    for (const [index, body] of beginBodies.slice(1).entries()) {
      expect(body).toEqual({
        deviceId: "device-1",
        localTurnId: "local-turn-1",
        leaseToken: "lease-1",
        renewOnly: true,
      });
      expect(beginBodyBytes[index + 1]).toBeLessThan(256);
      expect(body.userMessageJson).toBeUndefined();
      expect(body.clientMsgId).toBeUndefined();
    }

    await writer.finish({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      leaseToken: "lease-1",
      records: [],
      phase: "completed",
    });
    await waitFor(() => writer.pending() === 0);
    expect(finishRequests).toBe(1);
    const stoppedAt = beginRequests;
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(beginRequests).toBe(stoppedAt);
    writer.stop();
  });

  test("heartbeat lease loss aborts the provider independently of renderer state", async () => {
    const opened = openStore();
    stores.push(opened);
    let beginRequests = 0;
    const leaseLostReasons: string[] = [];
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      heartbeatIntervalMs: 15,
      fetchImpl: (async () => {
        beginRequests += 1;
        return beginRequests === 1
          ? Response.json({
              turnId: "turn-1",
              leaseToken: "lease-1",
              history: [],
            })
          : Response.json({ code: "turn_finished" }, { status: 409 });
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: '{"role":"user","content":[],"timestamp":1}',
      onLeaseLost: (reason) => {
        leaseLostReasons.push(reason);
      },
    });
    await waitFor(() => leaseLostReasons.length > 0);
    expect(leaseLostReasons).toEqual(["turn_finished"]);
    expect(beginRequests).toBe(2);
    expect(writer.pending()).toBe(0);
    writer.stop();
  });

  test("recovers a crash after begin ACK by canceling the retained marker", async () => {
    const opened = openStore();
    stores.push(opened);
    let firstWriterRequests = 0;
    const firstWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () => {
        firstWriterRequests += 1;
        return Response.json({
          turnId: "turn-1",
          leaseToken: "lease-1",
          history: [],
        });
      }) as unknown as typeof fetch,
    });
    await firstWriter.begin({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: '{"role":"user","content":[],"timestamp":1}',
    });
    expect(firstWriter.pending()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(firstWriterRequests).toBe(1);
    firstWriter.stop();

    const endpoints: string[] = [];
    const recoveredFinishBodies: Array<Record<string, unknown>> = [];
    const recoveredWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        endpoints.push(url);
        if (url.endsWith("/begin")) {
          return Response.json({
            turnId: "turn-1",
            leaseToken: "lease-1",
            history: [],
          });
        }
        recoveredFinishBodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await waitFor(() => recoveredWriter.pending() === 0);
    expect(endpoints.map((url) => url.split("/").at(-1))).toEqual([
      "begin",
      "finish",
    ]);
    expect(recoveredFinishBodies).toEqual([
      {
        deviceId: "device-1",
        localTurnId: "local-turn-1",
        leaseToken: "lease-1",
        records: [],
        phase: "canceled",
        notice: "The local turn was interrupted before it could finish.",
      },
    ]);
    recoveredWriter.stop();
  });

  test("post-output crash recovery includes exact persisted assistant and tool rows", async () => {
    const opened = openStore();
    stores.push(opened);
    const threadKey = "conversation-1";
    const historical: PersistedRuntimeThreadPayload = {
      role: "user",
      content: [{ type: "text", text: "before" }],
      timestamp: 1,
    };
    opened.store.appendThreadMessage({
      threadKey,
      role: "user",
      content: "before",
      timestamp: historical.timestamp,
      payload: historical,
    });
    const afterInsertionSequence =
      opened.store.getThreadEntryInsertionSequenceWatermark(threadKey);

    const firstWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () =>
        Response.json({
          turnId: "turn-1",
          leaseToken: "lease-1",
          history: [],
        })) as unknown as typeof fetch,
    });
    await firstWriter.begin({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: '{"role":"user","content":[],"timestamp":2}',
      recovery: { threadKey, afterInsertionSequence },
    });
    const recoveryRow = opened.database
      .query(
        `
        SELECT recovery_json AS recoveryJson
        FROM cloud_transcript_outbox
        WHERE kind = 'begin'
        LIMIT 1
      `,
      )
      .get() as { recoveryJson: string };
    expect(JSON.parse(recoveryRow.recoveryJson)).toEqual({
      threadKey,
      afterInsertionSequence,
    });

    const assistant: PersistedRuntimeThreadPayload = {
      role: "assistant",
      content: [{ type: "text", text: "Partial answer" }],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: 3,
    };
    const toolResult: PersistedRuntimeThreadPayload = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "lookup",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 4,
    };
    opened.store.appendThreadMessage({
      threadKey,
      role: "assistant",
      content: "Partial answer",
      timestamp: assistant.timestamp,
      payload: assistant,
    });
    opened.store.appendThreadMessage({
      threadKey,
      role: "toolResult",
      content: "result",
      toolCallId: toolResult.toolCallId,
      timestamp: toolResult.timestamp,
      payload: toolResult,
    });
    firstWriter.stop();

    const finishBodies: Array<Record<string, unknown>> = [];
    const recoveredWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/begin")) {
          return Response.json({
            turnId: "turn-1",
            leaseToken: "lease-1",
            history: [],
          });
        }
        finishBodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await waitFor(() => recoveredWriter.pending() === 0);
    const records = finishBodies[0]?.records as Array<{
      ordinal: number;
      role: string;
      payloadJson: string;
    }>;
    expect(records.map(({ ordinal, role }) => ({ ordinal, role }))).toEqual([
      { ordinal: 0, role: "assistant" },
      { ordinal: 1, role: "toolResult" },
    ]);
    expect(records.map((record) => JSON.parse(record.payloadJson))).toEqual([
      assistant,
      toolResult,
    ]);
    recoveredWriter.stop();
  });

  test("restarts by reacquiring an orphaned begin and canceling its lease", async () => {
    const opened = openStore();
    stores.push(opened);
    const firstWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => null,
      getBaseUrl: async () => "https://builder.example",
    });
    const abandonedBegin = firstWriter
      .begin({
        conversationId: "conversation-1",
        localTurnId: "local-turn-1",
        clientMsgId: "message-1",
        userMessageJson: '{"role":"user","content":"hello","timestamp":1}',
      })
      .catch(() => undefined);
    expect(firstWriter.pending()).toBe(1);
    firstWriter.stop();
    await abandonedBegin;

    const endpoints: string[] = [];
    const finishBodies: Array<Record<string, unknown>> = [];
    const recoveredWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        endpoints.push(url);
        if (url.endsWith("/begin")) {
          return Response.json({
            turnId: "turn-1",
            leaseToken: "lease-1",
            history: [],
          });
        }
        finishBodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await waitFor(() => recoveredWriter.pending() === 0);
    expect(endpoints.map((url) => url.split("/").at(-1))).toEqual([
      "begin",
      "finish",
    ]);
    expect(finishBodies).toEqual([
      {
        deviceId: "device-1",
        localTurnId: "local-turn-1",
        leaseToken: "lease-1",
        records: [],
        phase: "canceled",
        notice: "The local turn was interrupted before it could finish.",
      },
    ]);
    recoveredWriter.stop();
  });

  test("410 terminalizes a deleted conversation instead of retrying forever", async () => {
    const opened = openStore();
    stores.push(opened);
    let requests = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () => {
        requests += 1;
        return new Response(null, { status: 410 });
      }) as unknown as typeof fetch,
    });

    await writer.finish({
      conversationId: "deleted-conversation",
      localTurnId: "local-turn-1",
      leaseToken: "lease-1",
      records: [],
      phase: "canceled",
    });
    await waitFor(() => writer.pending() === 0);
    expect(requests).toBe(1);
    writer.stop();
  });

  test("turn_canceled is terminal instead of retrying a losing finish", async () => {
    const opened = openStore();
    stores.push(opened);
    let requests = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () => {
        requests += 1;
        return Response.json({ code: "turn_canceled" }, { status: 409 });
      }) as unknown as typeof fetch,
    });

    await writer.finish({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      leaseToken: "lease-1",
      records: [],
      phase: "canceled",
    });
    await waitFor(() => writer.pending() === 0);
    expect(requests).toBe(1);
    writer.stop();
  });

  test("oversized finishes are durable dead letters instead of retry loops", async () => {
    const opened = openStore();
    stores.push(opened);
    let requests = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () => {
        requests += 1;
        return new Response(null, { status: 413 });
      }) as unknown as typeof fetch,
    });

    const status = await writer.finish({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      leaseToken: "lease-1",
      records: Array.from({ length: 1025 }, (_, ordinal) => ({
        ordinal,
        role: "assistant" as const,
        payloadJson: '{"role":"assistant","content":[]}',
      })),
      phase: "completed",
    });
    expect(status).toEqual({
      queued: false,
      reason: "finish_record_limit_exceeded",
    });
    expect(writer.pending()).toBe(0);
    expect(requests).toBe(0);
    const deadLetter = opened.database
      .query(
        `
        SELECT
          payload_json AS payloadJson,
          recovery_json AS recoveryJson,
          last_error AS lastError,
          dead_lettered_at AS deadLetteredAt
        FROM cloud_transcript_outbox
        LIMIT 1
      `,
      )
      .get() as {
      payloadJson: string;
      recoveryJson: string | null;
      lastError: string;
      deadLetteredAt: number;
    };
    expect(deadLetter.payloadJson).toBe("{}");
    expect(deadLetter.recoveryJson).toBeNull();
    expect(deadLetter.lastError).toBe("finish_record_limit_exceeded");
    expect(deadLetter.deadLetteredAt).toBeNumber();
    writer.stop();
  });

  test("surfaces a bounded server rejection after finish was queued", async () => {
    const opened = openStore();
    stores.push(opened);
    const deliveryFailures: string[] = [];
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () =>
        Response.json(
          {
            code: "conversation_full",
            message:
              "This conversation has reached its size limit. Start a new conversation to keep going.",
          },
          { status: 413 },
        )) as unknown as typeof fetch,
    });

    const status = await writer.finish({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      leaseToken: "lease-1",
      records: [],
      phase: "completed",
      onDeliveryFailure: (message) => deliveryFailures.push(message),
    });
    expect(status).toEqual({ queued: true });
    await waitFor(() => deliveryFailures.length === 1);
    expect(deliveryFailures).toEqual([
      "This conversation has reached its size limit. Start a new conversation to keep going.",
    ]);
    const deadLetter = opened.database
      .query(
        `
        SELECT payload_json AS payloadJson, last_error AS lastError
        FROM cloud_transcript_outbox
        LIMIT 1
      `,
      )
      .get() as { payloadJson: string; lastError: string };
    expect(deadLetter).toEqual({
      payloadJson: "{}",
      lastError: "conversation_full",
    });
    writer.stop();
  });

  test("persists server rejection guidance when queued finish resumes after restart", async () => {
    const opened = openStore();
    stores.push(opened);
    const firstWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => null,
      getBaseUrl: async () => "https://builder.example",
    });
    const status = await firstWriter.finish({
      conversationId: "conversation-1",
      localTurnId: "local-turn-1",
      leaseToken: "lease-1",
      records: [],
      phase: "completed",
      failureNotificationUserMessageId: "message-1",
    });
    expect(status).toEqual({ queued: true });
    firstWriter.stop();

    const durableFailures: Array<Record<string, string>> = [];
    const recoveredWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      onDurableDeliveryFailure: (failure) => {
        durableFailures.push({ ...failure });
        // Simulate the process dying before the best-effort renderer notify.
        // The notice itself must already be in the same SQLite transaction as
        // the redaction.
        throw new Error("notification transport unavailable");
      },
      fetchImpl: (async () =>
        Response.json(
          {
            code: "conversation_full",
            message:
              "This conversation has reached its size limit. Start a new conversation to keep going.",
          },
          { status: 413 },
        )) as unknown as typeof fetch,
    });

    await waitFor(() => durableFailures.length === 1);
    expect(durableFailures).toEqual([
      {
        conversationId: "conversation-1",
        localTurnId: "local-turn-1",
        userMessageId: "message-1",
        message:
          "This conversation has reached its size limit. Start a new conversation to keep going.",
      },
    ]);
    const deadLetter = opened.database
      .query(
        `
        SELECT payload_json AS payloadJson, recovery_json AS recoveryJson
        FROM cloud_transcript_outbox
        LIMIT 1
      `,
      )
      .get() as { payloadJson: string; recoveryJson: string | null };
    expect(deadLetter).toEqual({
      payloadJson: "{}",
      recoveryJson: null,
    });
    expect(opened.store.listEvents("conversation-1")).toContainEqual(
      expect.objectContaining({
        _id: "cloud-sync-error:device-1:local-turn-1",
        type: "assistant_message",
        requestId: "message-1",
        payload: {
          text: "This conversation has reached its size limit. Start a new conversation to keep going.",
          userMessageId: "message-1",
          source: "cloud-sync-error",
        },
      }),
    );
    recoveredWriter.stop();
  });
});
