import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDesktopDatabase } from "../storage/database-init.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import type {
  PersistedRuntimeThreadPayload,
  SqliteDatabase,
} from "../storage/shared.js";
import {
  CloudTranscriptAlreadyAdmittedError,
  createCloudTranscriptWriter as createCloudTranscriptWriterImpl,
  type CloudTranscriptWriter,
} from "./cloud-transcript-write.js";

const OWNER_GENERATION = "owner-generation-1";
const writers: CloudTranscriptWriter[] = [];
const createCloudTranscriptWriter = (
  options: Parameters<typeof createCloudTranscriptWriterImpl>[0],
): CloudTranscriptWriter => {
  const writer = createCloudTranscriptWriterImpl(options);
  writers.push(writer);
  return writer;
};

const seedAdmittedBegin = (
  store: RuntimeStore,
  conversationId: string,
  localTurnId: string,
  ownerGeneration = OWNER_GENERATION,
): void => {
  store.putCloudTranscriptOutbox({
    id: `cloud-transcript:${JSON.stringify([
      "begin",
      "device-1",
      conversationId,
      localTurnId,
    ])}`,
    kind: "begin",
    conversationId,
    deviceId: "device-1",
    ownerGeneration,
    localTurnId,
    payloadJson: JSON.stringify({
      deviceId: "device-1",
      expectedOwnerGeneration: ownerGeneration,
      localTurnId,
      clientMsgId: "message-seeded",
      userMessageJson: '{"role":"user","content":[]}',
    }),
    recoveryJson: null,
  });
};

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
  while (writers.length) writers.pop()?.stop();
  while (stores.length) stores.pop()?.database.close();
});

describe("cloud transcript writer", () => {
  test("reads authenticated canonical history without opening a turn", async () => {
    const opened = openStore();
    stores.push(opened);
    let requestedMethod = "";
    let requestedUrl = "";
    let requestedAuthorization = "";
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        requestedMethod =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        requestedUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requestedAuthorization =
          new Headers(init?.headers).get("authorization") ??
          (input instanceof Request
            ? input.headers.get("authorization")
            : null) ??
          "";
        return Response.json({
          history: ['{"role":"user","content":[],"timestamp":1}'],
          contextStartSeq: 1,
          contextEndSeq: 1,
        });
      }) as unknown as typeof fetch,
    });

    await expect(writer.history("conversation-1")).resolves.toEqual({
      history: ['{"role":"user","content":[],"timestamp":1}'],
      contextStartSeq: 1,
      contextEndSeq: 1,
    });
    expect(requestedMethod).toBe("GET");
    expect(requestedUrl).toBe(
      "https://builder.example/conversations/conversation-1/history",
    );
    expect(requestedAuthorization).toBe("Bearer token");
    writer.stop();
  });

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
      ownerGeneration: OWNER_GENERATION,
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

    const expiresAt = Date.now() + 60_000;
    responseGate.resolve(
      Response.json({
        turnId: "turn-1",
        leaseToken: "lease-1",
        expiresAt,
        history: ['{"role":"user","content":"older","timestamp":0}'],
      }),
    );
    await expect(beginPromise).resolves.toEqual({
      turnId: "turn-1",
      leaseToken: "lease-1",
      expiresAt,
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
          expiresAt: Date.now() + 60_000,
          history: [],
        });
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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
        ownerGeneration: OWNER_GENERATION,
        localTurnId: "local-turn-1",
        clientMsgId: "message-1",
        userMessageJson: '{"role":"user","content":[],"timestamp":1}',
      }),
    ).rejects.toThrow("rejected as malformed");
    expect(requests).toBe(1);
    expect(writer.pending()).toBe(0);
    writer.stop();
  });

  test("client message conflicts terminate instead of retrying forever", async () => {
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
        return Response.json({ code: "idempotency_conflict" }, { status: 409 });
      }) as unknown as typeof fetch,
    });

    await expect(
      writer.begin({
        conversationId: "conversation-1",
        ownerGeneration: OWNER_GENERATION,
        localTurnId: "replacement-local-turn",
        clientMsgId: "message-1",
        userMessageJson: '{"role":"user","content":[],"timestamp":2}',
      }),
    ).rejects.toThrow("no longer owns");
    expect(requests).toBe(1);
    expect(writer.pending()).toBe(0);
    writer.stop();
  });

  test("an already-admitted message stops a replacement run quietly", async () => {
    const opened = openStore();
    stores.push(opened);
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () =>
        Response.json(
          { code: "turn_finished" },
          { status: 409 },
        )) as unknown as typeof fetch,
    });

    const result = writer.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "replacement-local-turn",
      clientMsgId: "message-1",
      userMessageJson: '{"role":"user","content":[],"timestamp":2}',
    });
    await expect(result).rejects.toBeInstanceOf(
      CloudTranscriptAlreadyAdmittedError,
    );
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
            expiresAt: Date.now() + 60_000,
            history: [],
          });
        }
        deliveryStarted = true;
        return await responseGate.promise;
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: '{"role":"user","content":[],"timestamp":1}',
    });
    expect(writer.pending()).toBe(1);
    await writer.finish({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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
            expiresAt: Date.now() + 60_000,
            history: [],
          });
        }
        finishRequests += 1;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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
        expectedOwnerGeneration: OWNER_GENERATION,
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
      ownerGeneration: OWNER_GENERATION,
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
              expiresAt: Date.now() + 60_000,
              history: [],
            })
          : Response.json({ code: "turn_finished" }, { status: 409 });
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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

  test("renewal silence revokes local authority before a hung request can overlap a replacement", async () => {
    const opened = openStore();
    stores.push(opened);
    const hungRenewal = deferred<Response>();
    let beginRequests = 0;
    const leaseLostReasons: string[] = [];
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      heartbeatIntervalMs: 10,
      authoritySilenceMs: 35,
      authorityExpiryMarginMs: 0,
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/finish")) {
          return new Response(null, { status: 204 });
        }
        beginRequests += 1;
        if (beginRequests === 1) {
          return Response.json({
            turnId: "turn-1",
            leaseToken: "lease-1",
            expiresAt: Date.now() + 60_000,
            history: [],
          });
        }
        // Deliberately ignores AbortSignal to prove the authority watchdog is
        // independent of the renewal request and its transport timeout.
        return await hungRenewal.promise;
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: '{"role":"user","content":[]}',
      onLeaseLost: (reason) => leaseLostReasons.push(reason),
    });
    await waitFor(() => beginRequests === 2);
    await waitFor(() => leaseLostReasons.length === 1);
    expect(leaseLostReasons).toEqual(["lease_renewal_silence"]);
    expect(writer.pending()).toBe(1);

    hungRenewal.resolve(
      Response.json({
        turnId: "turn-1",
        leaseToken: "lease-1",
        expiresAt: Date.now() + 60_000,
        history: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(leaseLostReasons).toEqual(["lease_renewal_silence"]);
    expect(beginRequests).toBe(2);

    await writer.finish({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-1",
      leaseToken: "lease-1",
      records: [],
      phase: "canceled",
    });
    await waitFor(() => writer.pending() === 0);
  });

  test("a delayed renewal ACK cannot restart the purge-grace clock from response receipt", async () => {
    const opened = openStore();
    stores.push(opened);
    const delayedRenewal = deferred<Response>();
    let beginRequests = 0;
    let renewalStartedAt = 0;
    let leaseLostAt = 0;
    let leaseLosses = 0;
    const silenceMs = 120;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      heartbeatIntervalMs: 10,
      authoritySilenceMs: silenceMs,
      authorityExpiryMarginMs: 0,
      fetchImpl: (async () => {
        beginRequests += 1;
        if (beginRequests === 1) {
          return Response.json({
            turnId: "turn-1",
            leaseToken: "lease-1",
            expiresAt: Date.now() + 60_000,
            history: [],
          });
        }
        if (beginRequests === 2) {
          renewalStartedAt = Date.now();
          return await delayedRenewal.promise;
        }
        // A partition immediately after the delayed ACK: no later request may
        // accidentally refresh the deadline under test.
        return await new Promise<Response>(() => undefined);
      }) as unknown as typeof fetch,
    });

    await writer.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-delayed-ack",
      clientMsgId: "message-delayed-ack",
      userMessageJson: '{"role":"user","content":[]}',
      onLeaseLost: () => {
        leaseLosses += 1;
        leaseLostAt = Date.now();
      },
    });
    await waitFor(() => renewalStartedAt > 0);
    await new Promise((resolve) => setTimeout(resolve, 75));
    delayedRenewal.resolve(
      Response.json({
        turnId: "turn-1",
        leaseToken: "lease-1",
        expiresAt: Date.now() + 60_000,
        history: [],
      }),
    );
    await waitFor(() => leaseLostAt > 0);
    expect(leaseLostAt).toBeLessThanOrEqual(
      renewalStartedAt + silenceMs + 30,
    );
    expect(beginRequests).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(leaseLosses).toBe(1);
  });

  test("finish and stop cancel the independent authority watchdog", async () => {
    const finishOpened = openStore();
    const stopOpened = openStore();
    stores.push(finishOpened, stopOpened);
    const lostAfterFinish: string[] = [];
    const lostAfterStop: string[] = [];
    const createWriter = (store: RuntimeStore) =>
      createCloudTranscriptWriter({
        deviceId: "device-1",
        store,
        getAuthToken: () => "token",
        getBaseUrl: async () => "https://builder.example",
        heartbeatIntervalMs: 1_000,
        authoritySilenceMs: 35,
        authorityExpiryMarginMs: 0,
        fetchImpl: (async (input: string | URL | Request) =>
          String(input).endsWith("/finish")
            ? new Response(null, { status: 204 })
            : Response.json({
                turnId: "turn-1",
                leaseToken: "lease-1",
                expiresAt: Date.now() + 60_000,
                history: [],
              })) as unknown as typeof fetch,
      });

    const finishWriter = createWriter(finishOpened.store);
    await finishWriter.begin({
      conversationId: "conversation-finish",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-finish",
      clientMsgId: "message-finish",
      userMessageJson: '{"role":"user","content":[]}',
      onLeaseLost: (reason) => lostAfterFinish.push(reason),
    });
    await finishWriter.finish({
      conversationId: "conversation-finish",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-finish",
      leaseToken: "lease-1",
      records: [],
      phase: "completed",
    });
    await waitFor(() => finishWriter.pending() === 0);

    const stopWriter = createWriter(stopOpened.store);
    await stopWriter.begin({
      conversationId: "conversation-stop",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-stop",
      clientMsgId: "message-stop",
      userMessageJson: '{"role":"user","content":[]}',
      onLeaseLost: (reason) => lostAfterStop.push(reason),
    });
    stopWriter.stop();

    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(lostAfterFinish).toEqual([]);
    expect(lostAfterStop).toEqual([]);
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
          expiresAt: Date.now() + 60_000,
          history: [],
        });
      }) as unknown as typeof fetch,
    });
    await firstWriter.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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
            expiresAt: Date.now() + 60_000,
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
        expectedOwnerGeneration: OWNER_GENERATION,
        localTurnId: "local-turn-1",
        leaseToken: "lease-1",
        records: [],
        phase: "canceled",
        notice: "The local turn was interrupted before it could finish.",
      },
    ]);
    recoveredWriter.stop();
  });

  test("recovers a historical import with its exact precomputed finish", async () => {
    const opened = openStore();
    stores.push(opened);
    const records = [
      {
        ordinal: 0,
        role: "assistant" as const,
        payloadJson: JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "Historical answer" }],
          timestamp: 2,
        }),
      },
    ];
    const firstWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () =>
        Response.json({
          turnId: "turn-1",
          leaseToken: "lease-1",
          expiresAt: Date.now() + 60_000,
          history: [],
        })) as unknown as typeof fetch,
    });
    await firstWriter.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "legacy-turn-1",
      clientMsgId: "legacy-message-1",
      userMessageJson: '{"role":"user","content":[],"timestamp":1}',
      recovery: {
        kind: "precomputed-finish",
        records,
        phase: "completed",
      },
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
            expiresAt: Date.now() + 60_000,
            history: [],
          });
        }
        finishBodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await waitFor(() => recoveredWriter.pending() === 0);
    expect(finishBodies).toEqual([
      {
        deviceId: "device-1",
        expectedOwnerGeneration: OWNER_GENERATION,
        localTurnId: "legacy-turn-1",
        leaseToken: "lease-1",
        records,
        phase: "completed",
      },
    ]);
    recoveredWriter.stop();
  });

  test("post-output crash recovery never rereads local transcript rows", async () => {
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
    const firstWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () =>
        Response.json({
          turnId: "turn-1",
          leaseToken: "lease-1",
          expiresAt: Date.now() + 60_000,
          history: [],
        })) as unknown as typeof fetch,
    });
    await firstWriter.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-1",
      clientMsgId: "message-1",
      userMessageJson: '{"role":"user","content":[],"timestamp":2}',
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
      .get() as { recoveryJson: string | null };
    expect(recoveryRow.recoveryJson).toBeNull();

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
            expiresAt: Date.now() + 60_000,
            history: [],
          });
        }
        finishBodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await waitFor(() => recoveredWriter.pending() === 0);
    expect(finishBodies[0]?.records).toEqual([]);
    expect(finishBodies[0]).toMatchObject({
      phase: "canceled",
      notice: "The local turn was interrupted before it could finish.",
    });
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
        ownerGeneration: OWNER_GENERATION,
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
            expiresAt: Date.now() + 60_000,
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
        expectedOwnerGeneration: OWNER_GENERATION,
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

    seedAdmittedBegin(opened.store, "deleted-conversation", "local-turn-1");
    await writer.finish({
      conversationId: "deleted-conversation",
      ownerGeneration: OWNER_GENERATION,
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

    seedAdmittedBegin(opened.store, "conversation-1", "local-turn-1");
    await writer.finish({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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

    seedAdmittedBegin(opened.store, "conversation-1", "local-turn-1");
    const status = await writer.finish({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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

    seedAdmittedBegin(opened.store, "conversation-1", "local-turn-1");
    const status = await writer.finish({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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
    seedAdmittedBegin(opened.store, "conversation-1", "local-turn-1");
    const status = await firstWriter.finish({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
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

  test("keeps journal appends FIFO per conversation across a busy text turn", async () => {
    const opened = openStore();
    stores.push(opened);
    const delivered: string[] = [];
    let busy = true;
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
          localTurnId: string;
        };
        delivered.push(body.localTurnId);
        if (busy) {
          return Response.json(
            { code: "turn_in_progress", retryAfterMs: 3_000 },
            { status: 409 },
          );
        }
        return Response.json({ firstSeq: 1, lastSeq: 1, epoch: 1 });
      }) as unknown as typeof fetch,
    });

    await writer.append({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      appendId: "voice-event-1",
      records: [
        {
          kind: "message",
          role: "user",
          payloadJson: '{"role":"user","content":"one","timestamp":1}',
        },
      ],
    });
    await writer.append({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      appendId: "voice-event-2",
      records: [
        {
          kind: "message",
          role: "assistant",
          payloadJson: '{"role":"assistant","content":[],"timestamp":2}',
        },
      ],
    });

    await waitFor(() => delivered.length === 1);
    expect(delivered).toEqual(["voice-event-1"]);
    expect(writer.pending()).toBe(2);

    busy = false;
    writer.resume();
    await waitFor(() => writer.pending() === 0);
    expect(delivered).toEqual([
      "voice-event-1",
      "voice-event-1",
      "voice-event-2",
    ]);
    writer.stop();
  });

  test("recovers a durable journal append after worker restart", async () => {
    const opened = openStore();
    stores.push(opened);
    let generationCaptures = 0;
    const firstWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => null,
      getBaseUrl: async () => "https://builder.example",
      getOwnerGeneration: async () => {
        generationCaptures += 1;
        return OWNER_GENERATION;
      },
    });
    await firstWriter.append({
      conversationId: "conversation-1",
      appendId: "voice-event-1",
      records: [
        {
          kind: "message",
          role: "user",
          payloadJson: '{"role":"user","content":"hello","timestamp":1}',
        },
      ],
    });
    expect(firstWriter.pending()).toBe(1);
    firstWriter.stop();

    const payloads: Array<Record<string, unknown>> = [];
    const recoveredWriter = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      getOwnerGeneration: async () => {
        throw new Error("restart must use the persisted generation");
      },
      fetchImpl: (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        payloads.push(JSON.parse(String(init?.body)));
        return Response.json({ firstSeq: 1, lastSeq: 1, epoch: 1 });
      }) as unknown as typeof fetch,
    });

    await waitFor(() => recoveredWriter.pending() === 0);
    expect(payloads).toEqual([
      expect.objectContaining({
        deviceId: "device-1",
        expectedOwnerGeneration: OWNER_GENERATION,
        localTurnId: "voice-event-1",
        source: "voice",
      }),
    ]);
    expect(generationCaptures).toBe(1);
    recoveredWriter.stop();
  });

  test("deduplicates identical journal enqueue and rejects payload reuse", async () => {
    const opened = openStore();
    stores.push(opened);
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => null,
      getBaseUrl: async () => "https://builder.example",
    });
    const request = {
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      appendId: "voice-event-1",
      records: [
        {
          kind: "message" as const,
          role: "user" as const,
          payloadJson: '{"role":"user","content":"hello","timestamp":1}',
        },
      ],
    };

    await expect(writer.append(request)).resolves.toEqual({
      queued: true,
      replayed: false,
    });
    await expect(writer.append(request)).resolves.toEqual({
      queued: true,
      replayed: true,
    });
    expect(writer.pending()).toBe(1);
    await expect(
      writer.append({
        ...request,
        records: [
          {
            ...request.records[0]!,
            payloadJson: '{"role":"user","content":"different","timestamp":1}',
          },
        ],
      }),
    ).rejects.toThrow("reused with new payload");
    writer.stop();
  });

  test("retains local admission identity after successful delivery", async () => {
    const opened = openStore();
    stores.push(opened);
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () =>
        Response.json({
          firstSeq: 1,
          lastSeq: 1,
          epoch: 1,
        })) as unknown as typeof fetch,
    });
    const request = {
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      appendId: "voice-event-after-ack",
      records: [
        {
          kind: "message" as const,
          role: "assistant" as const,
          payloadJson: '{"role":"assistant","content":"hello","timestamp":1}',
        },
      ],
    };

    await expect(writer.append(request)).resolves.toEqual({
      queued: true,
      replayed: false,
    });
    await waitFor(() => writer.pending() === 0);
    await expect(writer.append(request)).resolves.toEqual({
      queued: true,
      replayed: true,
    });
    expect(writer.pending()).toBe(0);
    writer.stop();
  });

  test("dead-letters a server idempotency conflict without retrying", async () => {
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
        return Response.json({ code: "idempotency_conflict" }, { status: 409 });
      }) as unknown as typeof fetch,
    });

    await writer.append({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      appendId: "voice-event-1",
      records: [
        {
          kind: "message",
          role: "user",
          payloadJson: '{"role":"user","content":"hello","timestamp":1}',
        },
      ],
    });
    await waitFor(() => writer.pending() === 0);
    expect(requests).toBe(1);
    expect(
      opened.database
        .query(
          `SELECT payload_json AS payloadJson, last_error AS lastError
             FROM cloud_journal_outbox LIMIT 1`,
        )
        .get(),
    ).toEqual({
      payloadJson: "{}",
      lastError: "idempotency_conflict",
    });
    writer.stop();
  });

  test("rejects generation ABA before a delayed begin can be rebound", async () => {
    const opened = openStore();
    stores.push(opened);
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => null,
      getBaseUrl: async () => "https://builder.example",
    });
    const first = writer.begin({
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-aba",
      clientMsgId: "message-aba",
      userMessageJson: '{"role":"user","content":[]}',
    });
    void first.catch(() => undefined);
    await waitFor(() => writer.pending() === 1);

    expect(() =>
      writer.begin({
        conversationId: "conversation-1",
        ownerGeneration: "owner-generation-2",
        localTurnId: "local-turn-aba",
        clientMsgId: "message-aba",
        userMessageJson: '{"role":"user","content":[]}',
      }),
    ).toThrow("different authority or payload");
    expect(opened.store.listCloudTranscriptOutbox()[0]).toMatchObject({
      ownerGeneration: OWNER_GENERATION,
    });
    expect(
      JSON.parse(opened.store.listCloudTranscriptOutbox()[0]!.payloadJson),
    ).toMatchObject({ expectedOwnerGeneration: OWNER_GENERATION });
    writer.stop();
    await expect(first).rejects.toThrow("stopped");
  });

  test("an acknowledged begin replays only for the exact immutable payload", async () => {
    const opened = openStore();
    stores.push(opened);
    let requests = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      heartbeatIntervalMs: 60_000,
      fetchImpl: (async () => {
        requests += 1;
        return Response.json({
          turnId: "desktop:device-1:local-turn-active",
          leaseToken: "lease-active",
          expiresAt: Date.now() + 60_000,
          history: [],
        });
      }) as unknown as typeof fetch,
    });
    const exact = {
      conversationId: "conversation-1",
      ownerGeneration: OWNER_GENERATION,
      localTurnId: "local-turn-active",
      clientMsgId: "message-active",
      userMessageJson: '{"role":"user","content":[]}',
    };
    const ack = await writer.begin(exact);
    await expect(writer.begin(exact)).resolves.toEqual(ack);
    await expect(
      writer.begin({ ...exact, clientMsgId: "message-replacement" }),
    ).rejects.toThrow("different authority or payload");
    await expect(
      writer.begin({
        ...exact,
        recovery: {
          kind: "precomputed-finish",
          records: [],
          phase: "completed",
        },
      }),
    ).rejects.toThrow("different authority or payload");
    expect(requests).toBe(1);
  });

  test("stale begin admission cannot start provider work", async () => {
    const opened = openStore();
    stores.push(opened);
    let requests = 0;
    let providerCalls = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () => {
        requests += 1;
        return Response.json(
          { code: "OWNER_DATA_GENERATION_STALE" },
          { status: 409 },
        );
      }) as unknown as typeof fetch,
    });
    const run = (async () => {
      await writer.begin({
        conversationId: "conversation-1",
        ownerGeneration: OWNER_GENERATION,
        localTurnId: "local-turn-stale",
        clientMsgId: "message-stale",
        userMessageJson: '{"role":"user","content":[]}',
      });
      providerCalls += 1;
    })();

    await expect(run).rejects.toThrow("no longer owns");
    expect(requests).toBe(1);
    expect(providerCalls).toBe(0);
    expect(writer.pending()).toBe(0);
  });

  test("migrated NULL-generation outbox rows are tombstoned without network", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE cloud_transcript_outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        local_turn_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        recovery_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        dead_lettered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO cloud_transcript_outbox VALUES (
        'legacy-transcript', 'begin', 'conversation-1', 'device-1',
        'legacy-turn', '{}', NULL, 0, NULL, NULL, 1, 1
      );
      CREATE TABLE cloud_journal_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        append_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        dead_lettered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO cloud_journal_outbox (
        id, conversation_id, device_id, append_id, payload_json,
        attempts, last_error, dead_lettered_at, created_at, updated_at
      ) VALUES (
        'legacy-journal', 'conversation-1', 'device-1', 'legacy-append',
        '{}', 0, NULL, NULL, 1, 1
      );
    `);
    initializeDesktopDatabase(database as unknown as SqliteDatabase);
    const store = new RuntimeStore(database as unknown as SqliteDatabase);
    stores.push({ database, store });
    let requests = 0;
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      fetchImpl: (async () => {
        requests += 1;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await waitFor(() => writer.pending() === 0);
    expect(requests).toBe(0);
    expect(
      database
        .query(
          `SELECT owner_generation AS ownerGeneration,
                  payload_json AS payloadJson,
                  last_error AS lastError
             FROM cloud_transcript_outbox`,
        )
        .get(),
    ).toEqual({
      ownerGeneration: null,
      payloadJson: "{}",
      lastError: "owner_generation_missing",
    });
    expect(
      database
        .query(
          `SELECT owner_generation AS ownerGeneration,
                  payload_json AS payloadJson,
                  last_error AS lastError
             FROM cloud_journal_outbox`,
        )
        .get(),
    ).toEqual({
      ownerGeneration: null,
      payloadJson: "{}",
      lastError: "owner_generation_missing",
    });
  });

  test("journal generation is captured once and stale reset replay is permanent", async () => {
    const opened = openStore();
    stores.push(opened);
    let generationCaptures = 0;
    const payloads: Array<Record<string, unknown>> = [];
    const writer = createCloudTranscriptWriter({
      deviceId: "device-1",
      store: opened.store,
      getAuthToken: () => "token",
      getBaseUrl: async () => "https://builder.example",
      getOwnerGeneration: async () => {
        generationCaptures += 1;
        return OWNER_GENERATION;
      },
      fetchImpl: (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        payloads.push(JSON.parse(String(init?.body)));
        return Response.json(
          { code: "owner_generation_stale" },
          { status: 409 },
        );
      }) as unknown as typeof fetch,
    });

    await writer.append({
      conversationId: "conversation-1",
      appendId: "voice-reset-stale",
      records: [
        {
          kind: "message",
          role: "user",
          payloadJson: '{"role":"user","content":"hello"}',
        },
      ],
    });
    await waitFor(() => writer.pending() === 0);
    expect(generationCaptures).toBe(1);
    expect(payloads).toEqual([
      expect.objectContaining({
        expectedOwnerGeneration: OWNER_GENERATION,
        localTurnId: "voice-reset-stale",
      }),
    ]);
    expect(
      opened.database
        .query(
          `SELECT owner_generation AS ownerGeneration,
                  payload_json AS payloadJson,
                  last_error AS lastError
             FROM cloud_journal_outbox LIMIT 1`,
        )
        .get(),
    ).toEqual({
      ownerGeneration: OWNER_GENERATION,
      payloadJson: "{}",
      lastError: "owner_generation_stale",
    });
  });
});
