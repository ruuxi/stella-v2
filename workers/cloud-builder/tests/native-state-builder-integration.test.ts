import { createHmac } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import {
  TURN_BROKER_HEADERS,
  TURN_BROKER_RESPONSE_HEADERS,
} from "@stella/contracts/turn-credential-broker";
import { ExactTurnCancellationLedger } from "../src/execution-placement-turn-cancellation.js";
import { sha256Hex } from "../src/hash.js";
import {
  nativeStateBackupName,
  nativeStateCheckpointKey,
} from "../src/native-state-checkpoint.js";
import {
  issueTurnBrokerCredential,
  turnBrokerStorageKey,
} from "../src/turn-credential-broker.js";
import { checkpointKey } from "../src/workspace.js";
import { issuePreviewAccessCapability } from "../src/vite-preview-access.js";
import {
  TurnCredentialBrokerClient,
  type TurnBrokerFetch,
} from "../../../packages/executor-cloud/src/turn-credential-broker.js";

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
const indexModule = await import("../src/index.js");
const { BuildSession, purgeNativeStateForWorkspace } = indexModule;
const worker = indexModule.default;
mock.restore();

const ownerId = "owner-1";
const ownerGeneration = "generation-1";
const turnId = "turn-1";
const threadId = "thread-1";
const attemptGeneration = 1;
const sessionId = "session-route";
const builderSecret = "builder-secret";
const backupId = "00000000-0000-4000-8000-000000000001";

const mapStorage = (values = new Map<string, unknown>()) => {
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
  };
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put,
    delete: remove,
    transaction: async <T>(operation: (txn: unknown) => Promise<T>) =>
      await operation({ get: storage.get, put, delete: remove }),
  };
  return { values, storage };
};

const kvHarness = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    kv: {
      get: async <T>(key: string, type?: string) => {
        const value = values.get(key);
        if (value === undefined) return null;
        if (type === "json" && typeof value === "string") {
          return JSON.parse(value) as T;
        }
        return structuredClone(value) as T;
      },
      put: async (key: string, value: string) => values.set(key, value),
      delete: async (key: string) => values.delete(key),
      list: async ({ prefix = "" }: { prefix?: string }) => ({
        keys: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }),
    },
  };
};

const checkpointFor = async () => {
  const integrityKey = await sha256Hex(
    [
      "stella-native-state-v2",
      builderSecret,
      ownerId,
      ownerGeneration,
      threadId,
    ].join("\u0000"),
  );
  const checkpoint = {
    engine: "anthropic" as const,
    sessionId: "native-session-1",
    cursor: `v1:${"c".repeat(64)}`,
    tree: {
      algorithm: "sha256" as const,
      digest: "d".repeat(64),
      entries: 4,
      bytes: 128,
    },
    mac: "",
  };
  checkpoint.mac = createHmac("sha256", integrityKey)
    .update(
      JSON.stringify([
        2,
        checkpoint.engine,
        threadId,
        checkpoint.sessionId,
        checkpoint.cursor,
        checkpoint.tree.algorithm,
        checkpoint.tree.digest,
        checkpoint.tree.entries,
        checkpoint.tree.bytes,
      ]),
    )
    .digest("hex");
  return checkpoint;
};

const builderHarness = async (
  options: {
    runCheckpoint?: () => Promise<void>;
    running?: boolean;
    engine?: "anthropic" | "stella";
    browserGateway?: {
      fetch(input: string | Request, init?: RequestInit): Promise<Response>;
    };
  } = {},
) => {
  const { values, storage } = mapStorage();
  const { values: routes, kv } = kvHarness();
  const identity = {
    sessionId,
    ownerId,
    ownerGeneration,
    turnId,
    attemptGeneration,
  };
  const issued = await issueTurnBrokerCredential({
    identity,
    endpoint: `https://builder.example/sessions/${sessionId}/turn-broker`,
    now: Date.now(),
    ttlMs: 60_000,
    randomBytes: (bytes) => bytes.fill(9),
  });
  const turn = {
    kind: "agent",
    conversationId: "conversation-1",
    ownerId,
    ownerGeneration,
    appId: "",
    turnId,
    prompt: "continue",
    threadId,
    workspace: "cloud",
    attemptGeneration,
    execution: {
      engine: options.engine ?? "anthropic",
      provider: options.engine === "stella" ? "crof" : "anthropic",
      model: options.engine === "stella" ? "crof/stella" : "claude-sonnet-4-6",
      reasoningEffort: "medium",
    },
    turnBrokerRoute: {
      sessionId,
      endpoint: `https://builder.example/sessions/${sessionId}/turn-broker`,
    },
    ownerPurgeGeneration: "purge-generation-1",
    ownerPurgeLeaseId: "lease-1",
  };
  values.set("turn", turn);
  values.set("sandboxId", sessionId);
  values.set(
    `turnStateBaseWorkspaceRevision:${turnId}:${attemptGeneration}`,
    0,
  );
  values.set(turnBrokerStorageKey(identity), issued.record);
  values.set("terminal", false);
  const executionAbort = new AbortController();
  let checkpointRuns = 0;
  const runCheckpoint = options.runCheckpoint ?? (async () => undefined);
  const instance = Object.create(BuildSession.prototype) as InstanceType<
    typeof BuildSession
  > &
    Record<string, unknown>;
  const ledger = new ExactTurnCancellationLedger(storage);
  Object.assign(instance, {
    ctx: {
      storage,
      id: { toString: () => sessionId },
      blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
        await operation(),
    },
    env: {
      BUILDER_SERVICE_SECRET: builderSecret,
      STELLA_CONVEX_SITE_URL: "https://convex.example",
      APP_ROUTES: kv,
      BACKUP_BUCKET: {
        list: async () => ({ objects: [], truncated: false }),
        delete: async () => undefined,
      },
      ...(options.browserGateway
        ? { BROWSER_GATEWAY: options.browserGateway }
        : {}),
    },
    // The one route a sandbox still reaches through Convex authenticates with
    // this turn's control-plane capability; signing it is covered elsewhere.
    controlPlaneCapability: async () => "control-plane-capability",
    exactTurnCancellations: ledger,
    agentTurnExecutions:
      options.running === false
        ? new Map()
        : new Map([
            [
              turnId,
              {
                cancellation: { aborted: false },
                signal: executionAbort.signal,
              },
            ],
          ]),
    turnStateCheckpointRuns: new Map(),
    assertTurnWritable: async () => undefined,
    executeTurnStateCheckpoint: async (args: {
      operationKey: string;
      operation: {
        turnId: string;
        attemptGeneration: number;
        requestId: string;
        requestFingerprint: string;
        createdAt: number;
        payload: { historyCursor: string; nativeCheckpoint?: unknown };
      };
    }) => {
      checkpointRuns += 1;
      await runCheckpoint();
      const receipt = {
        operationId: "a".repeat(64),
        historyCursor: args.operation.payload.historyCursor,
        manifestId: "b".repeat(64),
      };
      await storage.put(args.operationKey, {
        ...args.operation,
        state: "succeeded",
        operationId: receipt.operationId,
        receipt,
      });
      return receipt;
    },
  });
  return {
    instance,
    values,
    routes,
    identity,
    handoff: issued.handoff,
    executionAbort,
    checkpointRuns: () => checkpointRuns,
  };
};

const brokerFetch =
  (
    instance: { fetch(request: Request): Promise<Response> },
    intercept?: (
      request: Request,
      run: () => Promise<Response>,
    ) => Promise<Response>,
  ): TurnBrokerFetch =>
  async (_input, init) => {
    const request = new Request("https://build-session/turn-broker", init);
    const run = () => instance.fetch(request);
    return intercept ? await intercept(request, run) : await run();
  };

const gatewaySuspensionResponse = (
  toolCallId: string,
  interactionId = "interaction-1",
) => ({
  schemaVersion: 1 as const,
  outcome: "suspended" as const,
  suspension: {
    schemaVersion: 1 as const,
    outcome: "waiting_for_user" as const,
    interactionId,
    interactionRevision: 1,
    interactionKind: "login_takeover" as const,
    toolCallId,
    requestDigest: "7".repeat(64),
    profileId: "default" as const,
    profileEpoch: 2,
    displayOrigin: "https://example.test",
    displayTitle: "Example",
    expiresAt: Date.now() + 5 * 60_000,
  },
});

describe("native state Builder integration", () => {
  test("rejects a fabricated preview capability before resolving a named DO and redacts its log", async () => {
    const fabricated = `pv1.AA.${"A".repeat(43)}`;
    let resolutions = 0;
    const captured: string[] = [];
    const previousInfo = console.info;
    console.info = (...parts: unknown[]) => captured.push(parts.join(" "));
    try {
      const response = await worker.fetch(
        new Request(
          `https://builder.example/internal/previews/attacker-session/${fabricated}//attacker.invalid/`,
        ),
        {
          BUILDER_SERVICE_SECRET:
            "builder-preview-secret-with-at-least-thirty-two-bytes",
          BUILD_SESSIONS: {
            getByName: () => {
              resolutions += 1;
              return { fetch: async () => new Response("must not run") };
            },
          },
        } as never,
      );
      expect(response.status).toBe(403);
    } finally {
      console.info = previousInfo;
    }
    expect(resolutions).toBe(0);
    const logs = captured.join("\n");
    expect(logs).toContain("/internal/previews/:session/:capability");
    expect(logs).not.toContain(fabricated);
    expect(logs).not.toContain("attacker.invalid");
  });

  test("routes a valid preview HMAC only to its bound BuildSession", async () => {
    const secret = "builder-preview-secret-with-at-least-thirty-two-bytes";
    const issued = await issuePreviewAccessCapability({
      identity: {
        buildSessionName: sessionId,
        turnId,
        sandboxId: "app-0123456789abcdef0123456789abcdef01234567",
      },
      tunnelUrl: "https://not-returned.trycloudflare.com/",
      secret,
      now: Date.now(),
      ttlMs: 60_000,
      randomBytes: (bytes) => bytes.fill(11),
    });
    const calls: string[] = [];
    const response = await worker.fetch(
      new Request(
        `https://builder.example/internal/previews/${sessionId}/${issued.capability}/src/main.tsx`,
      ),
      {
        BUILDER_SERVICE_SECRET: secret,
        BUILD_SESSIONS: {
          getByName: (name: string) => {
            calls.push(name);
            return { fetch: async () => new Response("verified-route") };
          },
        },
      } as never,
    );
    expect(await response.text()).toBe("verified-route");
    expect(calls).toEqual([sessionId]);
  });

  test("routes a public broker capability to only its exact named BuildSession", async () => {
    const calls: Array<{ name: string; request: Request }> = [];
    const env = {
      BUILDER_SERVICE_SECRET: builderSecret,
      BUILD_SESSIONS: {
        getByName: (name: string) => ({
          fetch: async (request: Request) => {
            calls.push({ name, request });
            return new Response("forwarded");
          },
        }),
      },
    };
    const response = await worker.fetch(
      new Request(`https://builder.example/sessions/${sessionId}/turn-broker`, {
        method: "GET",
        headers: { authorization: "opaque" },
      }),
      env as never,
    );
    expect(await response.text()).toBe("forwarded");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(sessionId);
    expect(calls[0]?.request.url).toBe("https://build-session/turn-broker");
    expect(calls[0]?.request.method).toBe("GET");
  });

  test("stamps the broker origin/session at the authenticated turn gateway", async () => {
    let forwarded: Request | undefined;
    const env = {
      BUILDER_SERVICE_SECRET: builderSecret,
      BUILD_SESSIONS: {
        getByName: () => ({
          fetch: async (input: string | Request, init?: RequestInit) => {
            forwarded =
              input instanceof Request ? input : new Request(input, init);
            return new Response("accepted");
          },
        }),
      },
    };
    const response = await worker.fetch(
      new Request(`https://builder.example/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${builderSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ turnBrokerRoute: { endpoint: "https://evil" } }),
      }),
      env as never,
    );
    expect(response.status).toBe(200);
    expect(forwarded).toBeDefined();
    expect(forwarded?.headers.get("x-stella-build-session-name")).toBe(
      sessionId,
    );
    expect(forwarded?.headers.get("x-stella-turn-broker-endpoint")).toBe(
      `https://builder.example/sessions/${sessionId}/turn-broker`,
    );
  });

  test("durably observes an exact Browser Gateway wait before returning it", async () => {
    const responses = new Map<
      string,
      ReturnType<typeof gatewaySuspensionResponse>
    >();
    let gatewayCalls = 0;
    const harness = await builderHarness({
      engine: "stella",
      browserGateway: {
        fetch: async (input, init) => {
          gatewayCalls += 1;
          const forwarded =
            input instanceof Request ? input : new Request(input, init);
          const envelope = (await forwarded.json()) as {
            command: { requestId: string };
          };
          let response = responses.get(envelope.command.requestId);
          if (!response) {
            response = gatewaySuspensionResponse(
              envelope.command.requestId,
              `interaction-${responses.size + 1}`,
            );
            responses.set(envelope.command.requestId, response);
          }
          return Response.json(response);
        },
      },
    });
    let replayResponse: Response | undefined;
    const client = new TurnCredentialBrokerClient(
      harness.handoff,
      brokerFetch(harness.instance, async (request, run) => {
        const duplicate = request.clone();
        const first = await run();
        expect(harness.values.get("observedBrowserSuspension")).toMatchObject({
          schemaVersion: 1,
          turnId,
          attemptGeneration,
          suspension: {
            interactionId: "interaction-1",
            toolCallId: "00000000-0000-4000-8000-000000000021",
          },
        });
        replayResponse = await harness.instance.fetch(duplicate);
        return first;
      }),
    );
    const firstResponse = await client.postJson("/api/cloud/browser/command", {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000021",
      action: "browser.observe",
      params: {},
    });
    expect(firstResponse.status).toBe(200);
    expect(replayResponse?.status).toBe(200);
    expect(gatewayCalls).toBe(2);
    expect(
      [...harness.values.keys()].filter(
        (key) => key === "observedBrowserSuspension",
      ),
    ).toHaveLength(1);

    const conflict = await client.postJson("/api/cloud/browser/command", {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000022",
      action: "browser.observe",
      params: {},
    });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get(TURN_BROKER_RESPONSE_HEADERS.denial)).toBe("1");
    expect(harness.values.get("observedBrowserSuspension")).toMatchObject({
      suspension: { interactionId: "interaction-1" },
    });
  });

  test("rejects malformed and oversized Browser Gateway wait responses", async () => {
    const command = {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000031",
      action: "browser.observe",
      params: {},
    };
    const malformed = await builderHarness({
      engine: "stella",
      browserGateway: {
        fetch: async () =>
          Response.json({
            schemaVersion: 1,
            outcome: "suspended",
            suspension: { interactionId: "incomplete" },
          }),
      },
    });
    const malformedResponse = await new TurnCredentialBrokerClient(
      malformed.handoff,
      brokerFetch(malformed.instance),
    ).postJson("/api/cloud/browser/command", command);
    expect(malformedResponse.status).toBe(502);
    expect(malformed.values.has("observedBrowserSuspension")).toBe(false);

    const oversized = await builderHarness({
      engine: "stella",
      browserGateway: {
        fetch: async () => new Response("x".repeat(64 * 1024 + 1)),
      },
    });
    const oversizedResponse = await new TurnCredentialBrokerClient(
      oversized.handoff,
      brokerFetch(oversized.instance),
    ).postJson("/api/cloud/browser/command", {
      ...command,
      requestId: "00000000-0000-4000-8000-000000000032",
    });
    expect(oversizedResponse.status).toBe(502);
    expect(oversized.values.has("observedBrowserSuspension")).toBe(false);
  });

  test("returns the atomic checkpoint receipt after a lost response without a second archive", async () => {
    const harness = await builderHarness();
    let calls = 0;
    const client = new TurnCredentialBrokerClient(
      harness.handoff,
      brokerFetch(harness.instance, async (_request, run) => {
        calls += 1;
        const response = await run();
        if (calls === 1) throw new Error("response lost");
        return response;
      }),
    );
    const checkpoint = await checkpointFor();
    const receipt = await client.commitNativeStateCheckpoint(checkpoint);
    expect(receipt).toMatchObject({
      operationId: "a".repeat(64),
      historyCursor: checkpoint.cursor,
      manifestId: "b".repeat(64),
    });
    expect(harness.checkpointRuns()).toBe(1);
    const operations = [...harness.values.entries()].filter(([key]) =>
      key.startsWith("turnStateCheckpointOperation:"),
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]?.[1]).toMatchObject({
      state: "succeeded",
      operationId: "a".repeat(64),
      receipt: {
        operationId: "a".repeat(64),
        historyCursor: checkpoint.cursor,
        manifestId: "b".repeat(64),
      },
    });
  });

  test("joins an exact concurrent replay to the same unresolved atomic checkpoint", async () => {
    let resolveCheckpoint!: () => void;
    let checkpointStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      checkpointStarted = resolve;
    });
    const checkpointRun = new Promise<void>((resolve) => {
      resolveCheckpoint = resolve;
    });
    const harness = await builderHarness({
      runCheckpoint: async () => {
        checkpointStarted();
        await checkpointRun;
      },
    });
    let replayReceipt: Record<string, unknown> | undefined;
    const client = new TurnCredentialBrokerClient(
      harness.handoff,
      brokerFetch(harness.instance, async (request, run) => {
        const duplicate = request.clone();
        const first = run();
        await started;
        let replaySettled = false;
        const replay = harness.instance.fetch(duplicate).then((response) => {
          replaySettled = true;
          return response;
        });
        await Promise.resolve();
        expect(replaySettled).toBe(false);
        resolveCheckpoint();
        const [firstResponse, replayResponse] = await Promise.all([
          first,
          replay,
        ]);
        expect(replayResponse.status).toBe(200);
        expect(
          replayResponse.headers.get(
            TURN_BROKER_RESPONSE_HEADERS.replayPending,
          ),
        ).toBeNull();
        replayReceipt = (await replayResponse.json()) as Record<
          string,
          unknown
        >;
        return firstResponse;
      }),
    );
    const receipt = await client.commitNativeStateCheckpoint(
      await checkpointFor(),
    );
    expect(replayReceipt).toEqual(receipt);
    expect(harness.checkpointRuns()).toBe(1);
  });

  test("forwards callback authority only inside Builder and scrubs the sandbox response", async () => {
    const harness = await builderHarness();
    const client = new TurnCredentialBrokerClient(
      harness.handoff,
      brokerFetch(harness.instance),
    );
    const originalFetch = globalThis.fetch;
    let upstreamUrl = "";
    let upstreamHeaders = new Headers();
    globalThis.fetch = (async (input, init) => {
      upstreamUrl = String(input);
      upstreamHeaders = new Headers(init?.headers);
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('{"accepted":true}', {
        headers: {
          "content-type": "application/json",
          "set-cookie": "convex-session=secret",
          "x-stella-broker-private": "secret",
          "x-stella-response-id": "response-1",
        },
      });
    }) as typeof fetch;
    try {
      const response = await client.postJson("/api/cloud/web-search", {
        turnId,
        query: "progress",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("x-stella-broker-private")).toBeNull();
      // Every x-stella-* response header is Builder/backend-private now that
      // no model relay answers through the broker.
      expect(response.headers.get("x-stella-response-id")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      client.close();
    }

    expect(upstreamUrl).toBe("https://convex.example/api/cloud/web-search");
    expect(upstreamHeaders.get("authorization")).toBe(
      "Bearer control-plane-capability",
    );
    expect(upstreamHeaders.get(TURN_BROKER_HEADERS.ownerId)).toBeNull();
    expect(
      harness.values.get(turnBrokerStorageKey(harness.identity)),
    ).toMatchObject({
      nextSequence: 2,
      requestCount: 1,
    });
  });

  test("aborts an in-flight forwarded request with the exact turn execution", async () => {
    const harness = await builderHarness();
    const client = new TurnCredentialBrokerClient(
      harness.handoff,
      brokerFetch(harness.instance),
    );
    const originalFetch = globalThis.fetch;
    let observeUpstream!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      observeUpstream = resolve;
    });
    globalThis.fetch = (async (_input, init) => {
      observeUpstream();
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing exact turn signal"));
          return;
        }
        const onAbort = () =>
          reject(signal.reason ?? new Error("forwarding aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      throw new Error("unreachable");
    }) as typeof fetch;
    try {
      const pending = client.postJson("/api/cloud/web-search", {
        turnId,
        query: "progress",
      });
      await upstreamStarted;
      harness.executionAbort.abort(new Error("exact turn stopped"));
      const response = await pending;
      expect(response.status).toBe(410);
      expect(response.headers.get(TURN_BROKER_RESPONSE_HEADERS.denial)).toBe(
        "1",
      );
      expect(client.closed).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      client.close();
    }
  });

  test("rejects a valid capability after isolate restart leaves no live execution", async () => {
    const harness = await builderHarness({ running: false });
    const client = new TurnCredentialBrokerClient(
      harness.handoff,
      brokerFetch(harness.instance),
    );
    await expect(
      client.commitNativeStateCheckpoint(await checkpointFor()),
    ).rejects.toThrow();
    expect(harness.checkpointRuns()).toBe(0);
  });

  test("native cleanup debt never sweeps a descriptor still referenced by KV", async () => {
    const harness = await builderHarness();
    const workspaceKey = await checkpointKey(ownerId, "drive");
    const nativeKey = await nativeStateCheckpointKey(workspaceKey, threadId);
    const referencedId = backupId;
    const retiredId = "00000000-0000-4000-8000-000000000002";
    const checkpoint = await checkpointFor();
    harness.routes.set(
      nativeKey,
      JSON.stringify({
        schemaVersion: 1,
        committed: {
          checkpoint,
          descriptor: {
            id: referencedId,
            dir: "/home/stella-native-state/anthropic",
            localBucket: true,
          },
          requestFingerprint: "a".repeat(64),
          receipt: "b".repeat(64),
          createdAt: 1,
        },
        candidates: [],
      }),
    );
    const debtKey = `${workspaceKey}:native-backup-debt`;
    harness.routes.set(
      debtKey,
      JSON.stringify({ backupIds: [referencedId, retiredId] }),
    );
    const objects = new Set([
      `backups/${referencedId}/archive.tar.zst`,
      `backups/${retiredId}/archive.tar.zst`,
    ]);
    (harness.instance as unknown as { env: Record<string, unknown> }).env[
      "BACKUP_BUCKET"
    ] = {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          objects.delete(key);
        }
      },
    };
    await (
      harness.instance as unknown as {
        sweepNativeBackupDebt(workspaceKey: string): Promise<void>;
      }
    ).sweepNativeBackupDebt(workspaceKey);

    expect(objects.has(`backups/${referencedId}/archive.tar.zst`)).toBe(true);
    expect(objects.has(`backups/${retiredId}/archive.tar.zst`)).toBe(false);
    expect(JSON.parse(String(harness.routes.get(debtKey)))).toEqual({
      backupIds: [referencedId],
    });
  });

  test("purges descriptor backups and deterministic-name crash orphans before KV", async () => {
    const { values, kv } = kvHarness();
    const workspaceKey = "ws:" + "a".repeat(64);
    const nativeKey = await nativeStateCheckpointKey(workspaceKey, threadId);
    const historicalName = await nativeStateBackupName(nativeKey);
    const orphanId = "00000000-0000-4000-8000-000000000002";
    values.set(nativeKey, JSON.stringify({ schemaVersion: 1, candidates: [] }));
    const objects = new Map<string, string>([
      [
        `backups/${orphanId}/meta.json`,
        JSON.stringify({ name: historicalName }),
      ],
      [`backups/${orphanId}/archive.tar.zst`, "bytes"],
    ]);
    const bucket = {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
      get: async (key: string) => {
        const value = objects.get(key);
        return value === undefined
          ? null
          : { json: async () => JSON.parse(value) };
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          objects.delete(key);
        }
      },
    };
    const result = await purgeNativeStateForWorkspace(
      { APP_ROUTES: kv, BACKUP_BUCKET: bucket } as never,
      workspaceKey,
    );
    expect(result.keys).toBe(1);
    expect(objects.size).toBe(0);
    expect(values.has(nativeKey)).toBe(false);
  });

  test("owner-transfer retirement keeps the source pointer when native byte purge fails", async () => {
    const { values, kv } = kvHarness();
    const workspaceKey = "ws:" + "b".repeat(64);
    const nativeKey = await nativeStateCheckpointKey(workspaceKey, threadId);
    const historicalName = await nativeStateBackupName(nativeKey);
    const orphanId = "00000000-0000-4000-8000-000000000003";
    const sourceRecord = JSON.stringify({
      schemaVersion: 1,
      candidates: [],
    });
    values.set(nativeKey, sourceRecord);
    const objects = new Map<string, string>([
      [
        `backups/${orphanId}/meta.json`,
        JSON.stringify({ name: historicalName }),
      ],
      [`backups/${orphanId}/archive.tar.zst`, "bytes"],
    ]);
    const bucket = {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
      get: async (key: string) => {
        const value = objects.get(key);
        return value === undefined
          ? null
          : { json: async () => JSON.parse(value) };
      },
      delete: async () => {
        throw new Error("injected R2 retirement failure");
      },
    };

    await expect(
      purgeNativeStateForWorkspace(
        { APP_ROUTES: kv, BACKUP_BUCKET: bucket } as never,
        workspaceKey,
      ),
    ).rejects.toThrow("injected R2 retirement failure");
    // moveWorkspaceCheckpoint awaits this exact bytes-first primitive before
    // deleting any source-owner checkpoint keys, so a transfer retry retains
    // an attributable pointer instead of orphaning resumable authority.
    expect(values.get(nativeKey)).toBe(sourceRecord);
    expect(objects.size).toBe(2);
  });
});
