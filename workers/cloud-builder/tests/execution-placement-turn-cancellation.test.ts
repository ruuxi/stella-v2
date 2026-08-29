import { describe, expect, mock, test } from "bun:test";
import {
  EXACT_TURN_CANCELLATIONS_KEY,
  ExactTurnCancellationLedger,
  parseExactTurnCancellationRequest,
  type ExactTurnCancellationRequest,
} from "../src/execution-placement-turn-cancellation.js";
import { agentComputeKey } from "../src/agent-compute-ladder.js";
import {
  turnComputePlan,
  turnComputePlanKey,
} from "../src/general-agent-turn.js";
import { sha256Hex } from "../src/hash.js";
import { localClientMessageFingerprintSource } from "../src/local-turn-protocol.js";
import {
  startTurnExecution,
  type TurnExecutionContext,
} from "../src/turn-cancellation.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
}));
const { OrchestratorSession } = await import("../src/orchestrator-session.js");
const { BuildSession } = await import("../src/index.js");
mock.restore();

const request = (
  turnId: string,
  overrides: Partial<ExactTurnCancellationRequest> = {},
): ExactTurnCancellationRequest => ({
  turnId,
  cancelRequestId: `cancel:${turnId}`,
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  attemptGeneration: 1,
  ...overrides,
});

const storageHarness = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
  };
};

const turn = (turnId: string, ownerGeneration = "generation-1") => ({
  kind: "chat" as const,
  ownerId: "owner-1",
  ownerGeneration,
  conversationId: "conversation-1",
  turnId,
  sessionId: `session:${turnId}`,
  prompt: `prompt:${turnId}`,
  turnToken: `token:${turnId}`,
  convexCallbackBase: "https://convex.example",
});

const sessionHarness = (values = new Map<string, unknown>()) => {
  let alarm: number | null = null;
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, structuredClone(value));
      else {
        for (const [entryKey, entryValue] of Object.entries(key)) {
          values.set(entryKey, structuredClone(entryValue));
        }
      }
    },
    delete: async (key: string) => values.delete(key),
    list: async <T>({ prefix = "" }: { prefix?: string } = {}) =>
      new Map(
        [...values.entries()].filter(([key]) => key.startsWith(prefix)),
      ) as Map<string, T>,
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
    id: { name: "conversation-1", toString: () => "conversation-1" },
    waitUntil: () => undefined,
    blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
      await operation(),
  };
  const instance = Object.create(
    OrchestratorSession.prototype,
  ) as OrchestratorSession & Record<string, unknown>;
  const journalTerminal = new Map<string, string>();
  Object.assign(instance, {
    ctx,
    env: {},
    exactTurnCancellations: new ExactTurnCancellationLedger(storage),
    turnExecutions: new Map<string, unknown>(),
    ownerFencedAppends: new Map<string, unknown>(),
    activeTurnId: null,
    currentTurnAbort: undefined,
    currentAgent: undefined,
    journal: {
      turnState: (turnId: string) =>
        journalTerminal.has(turnId)
          ? {
              state: "terminal",
              terminal_kind: journalTerminal.get(turnId),
            }
          : null,
      isDeleted: () => false,
      upsertTurn: () => undefined,
      appendMessage: () => ({ seq: 0, record: undefined }),
      setTurnSpan: () => undefined,
    },
    activeConversationEditLock: async () => null,
    purged: () => false,
    bindConversation: () => undefined,
    publish: () => undefined,
    registerOwnerTurn: async () => "purge-generation-1",
    assertOwnerTurn: async () => undefined,
    assertOwnerFenceLeaseReceiptActive: async () => undefined,
    unregisterOwnerTurn: async () => undefined,
    recordTerminal: (target: { turnId: string }, phase: string) => {
      journalTerminal.set(target.turnId, phase);
    },
    event: async () => undefined,
    afterTerminal: async () => undefined,
    finalizeTerminalTurn: async () => undefined,
  });
  return {
    instance,
    values,
    storage,
    ledger: instance["exactTurnCancellations"] as ExactTurnCancellationLedger,
  };
};

type ExecutableCloudTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  }>;
};

const cloudAgentTool = (
  instance: OrchestratorSession & Record<string, unknown>,
  targetTurn: ReturnType<typeof turn>,
  name: "spawn_agent" | "send_input" | "pause_agent",
): ExecutableCloudTool => {
  const tools = (
    instance["createTools"] as (
      turn: ReturnType<typeof turn>,
      agentHome: { available: boolean },
      skillCatalog: Record<string, never>,
      memoryEnabled: boolean,
    ) => ExecutableCloudTool[]
  )(targetTurn, { available: false }, {}, false);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing cloud agent tool: ${name}`);
  return tool;
};

const agentTurn = (turnId: string, ownerGeneration = "generation-1") => ({
  kind: "agent",
  ownerId: "owner-1",
  ownerGeneration,
  appId: "agent",
  turnId,
  prompt: `prompt:${turnId}`,
  turnToken: `token:${turnId}`,
  convexCallbackBase: "https://convex.example",
  threadId: "thread-1",
  attemptGeneration: 1,
});

const appTurn = (turnId: string, ownerGeneration = "generation-1") => ({
  ownerId: "owner-1",
  ownerGeneration,
  conversationId: "conversation-1",
  appId: "app-1",
  turnId,
  sessionId: `session:${turnId}`,
  prompt: `prompt:${turnId}`,
  turnToken: `token:${turnId}`,
  convexCallbackBase: "https://convex.example",
});

const buildSessionHarness = (values = new Map<string, unknown>()) => {
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
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put,
    delete: remove,
    deleteAll: async () => values.clear(),
    list: async <T>({ prefix = "" }: { prefix?: string } = {}) =>
      new Map(
        [...values.entries()].filter(([key]) => key.startsWith(prefix)),
      ) as Map<string, T>,
    transaction: async <T>(operation: (txn: unknown) => Promise<T>) =>
      await operation({
        get: async <T>(key: string) => values.get(key) as T | undefined,
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
  const waited: Promise<unknown>[] = [];
  const ctx = {
    storage,
    id: { name: "thread-1", toString: () => "thread-1" },
    waitUntil: (work: Promise<unknown>) => waited.push(work),
    blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
      await operation(),
  };
  const instance = Object.create(BuildSession.prototype) as BuildSession &
    Record<string, unknown>;
  const ledger = new ExactTurnCancellationLedger(storage);
  const terminated: string[] = [];
  const delivered: string[] = [];
  const unregistered: string[] = [];
  let runAgentTurnCalls = 0;
  Object.assign(instance, {
    ctx,
    env: { BUILDER_SERVICE_SECRET: "builder-secret" },
    exactTurnCancellations: ledger,
    runningTurns: new Map<string, Set<Promise<unknown>>>(),
    appTurnExecutions: new Map<string, unknown>(),
    agentTurnExecutions: new Map<string, unknown>(),
    terminateCurrentAgentSandbox: async (target: { turnId: string }) => {
      terminated.push(target.turnId);
    },
    registerTurn: async (target: Record<string, unknown>) => {
      target.ownerPurgeLeaseId = `lease:${String(target.turnId)}`;
      return "purge-generation-1";
    },
    assertTurnWritable: async () => undefined,
    assertConvexAgentTurnAuthority: async () => undefined,
    assertConvexAppTurnAuthority: async () => undefined,
    unregisterTurnLease: async () => undefined,
    unregisterTurn: async (target: { turnId: string }) => {
      unregistered.push(target.turnId);
    },
    deliverTerminal: async (
      target: { turnId: string },
      pending: Record<string, unknown>,
      options: { preservePendingTerminal?: boolean } = {},
    ) => {
      delivered.push(target.turnId);
      await storage.put("terminalDelivered", true);
      if (!options.preservePendingTerminal) {
        await storage.delete("pendingTerminal");
      }
      expect(pending).toMatchObject({
        turnId: target.turnId,
        kind: "canceled",
      });
      return true;
    },
    runAgentTurn: async () => {
      runAgentTurnCalls += 1;
    },
    settleTerminalTransientWrites: async () => true,
    residentAgentAborts: new Map<string, () => void>(),
    builderFallbackRecoveries: new Set<string>(),
  });
  return {
    instance,
    values,
    storage,
    ledger,
    waited,
    terminated,
    delivered,
    unregistered,
    runAgentTurnCalls: () => runAgentTurnCalls,
  };
};

const terminateCurrentAgentSandbox = async (
  instance: BuildSession & Record<string, unknown>,
  target: ReturnType<typeof agentTurn>,
): Promise<void> => {
  const terminate = (
    BuildSession.prototype as unknown as Record<string, unknown>
  )["terminateCurrentAgentSandbox"] as (
    this: BuildSession & Record<string, unknown>,
    turn: ReturnType<typeof agentTurn>,
  ) => Promise<void>;
  await terminate.call(instance, target);
};

describe("BuildSession sandbox termination", () => {
  test("does not resolve the process RPC before an executor is admitted", async () => {
    const harness = buildSessionHarness();
    const current = { ...agentTurn("agent-provisioning"), workspace: "stella" };
    const sandboxId = `agent-${current.turnId}`;
    harness.values.set("turn", current);
    harness.values.set("sandboxId", sandboxId);
    harness.values.set("sandboxSize", "large");
    let processKills = 0;
    let destroys = 0;
    harness.instance["sandbox"] = () => ({
      killAllProcesses: async () => {
        processKills += 1;
      },
      destroy: async () => {
        destroys += 1;
      },
    });

    await terminateCurrentAgentSandbox(harness.instance, current);

    expect(processKills).toBe(0);
    expect(destroys).toBe(1);
  });

  test("kills the exact process session after executor admission", async () => {
    const harness = buildSessionHarness();
    const current = { ...agentTurn("agent-admitted"), workspace: "stella" };
    const sandboxId = `agent-${current.turnId}`;
    harness.values.set("turn", current);
    harness.values.set("sandboxId", sandboxId);
    harness.values.set("sandboxSize", "large");
    harness.values.set(`agentExecutionMarker:${current.turnId}:1`, {
      schemaVersion: 1,
      turnId: current.turnId,
      attemptGeneration: 1,
      sandboxId,
      size: "large",
      workspace: "stella",
      workspaceRoot: "/workspace/stella",
      startedAt: Date.now(),
    });
    let processKills = 0;
    let destroys = 0;
    harness.instance["sandbox"] = () => ({
      killAllProcesses: async () => {
        processKills += 1;
      },
      destroy: async () => {
        destroys += 1;
      },
    });

    await terminateCurrentAgentSandbox(harness.instance, current);

    expect(processKills).toBe(1);
    expect(destroys).toBe(1);
  });
});

const cancelRequest = (body: unknown) =>
  new Request("https://orchestrator-session/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const turnRequest = (body: unknown) =>
  new Request("https://build-session/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ownerPurgeRequest = (body: unknown) =>
  new Request("https://orchestrator-session/owner-purge-cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const enableDurableOwnerFenceLifecycle = (
  instance: OrchestratorSession & Record<string, unknown>,
): void => {
  delete instance["registerOwnerTurn"];
  delete instance["assertOwnerTurn"];
  delete instance["assertOwnerFenceLeaseReceiptActive"];
  delete instance["unregisterOwnerTurn"];
};

const ownerFenceLeaseReceipts = (
  values: Map<string, unknown>,
): Array<Record<string, unknown>> =>
  [...values.entries()]
    .filter(([key]) => key.startsWith("ownerFenceLeaseReceipt:"))
    .map(([, value]) => value as Record<string, unknown>);

const controlledExecution = <T>(
  settled: Promise<T>,
  onInterrupt: () => void | Promise<void>,
) => {
  let interruption: Promise<void> | undefined;
  return {
    settled,
    cancellation: {
      aborted: false,
      reason: undefined,
      abort: () => undefined,
      sleep: async () => undefined,
    },
    interrupt: () => {
      interruption ??= (async () => {
        await onInterrupt();
        await settled.then(
          () => undefined,
          () => undefined,
        );
      })();
      return interruption;
    },
    join: async () => {
      await settled.then(
        () => undefined,
        () => undefined,
      );
    },
  };
};

describe("execution-placement exact cloud turn cancellation", () => {
  test("scopes orchestrator owner-fence calls to the exact owner", async () => {
    const { instance } = sessionHarness();
    let observedName = "";
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    instance["env"] = {
      BUILD_SESSIONS: {
        getByName: (name: string) => {
          observedName = name;
          return {
            fetch: async (url: string, init: RequestInit) => {
              observedUrl = url;
              observedInit = init;
              return Response.json({ generation: "fence-generation-1" });
            },
          };
        },
      },
    };

    const response = await (
      instance["callOwnerFence"] as (
        ownerId: string,
        path: string,
        body: Record<string, unknown>,
      ) => Promise<Response>
    )("owner-1", "register", {
      ownerGeneration: "generation-1",
      leaseId: "lease-1",
      sessionId: "conversation-1",
      turnId: "turn-1",
    });

    expect(response.status).toBe(200);
    expect(observedName).toBe(`owner-purge-${await sha256Hex("owner-1")}`);
    expect(observedUrl).toBe("https://build-session/owner-fence/register");
    expect(
      new Headers(observedInit?.headers).get("x-stella-owner-fence-id"),
    ).toBe("owner-1");
    expect(JSON.parse(String(observedInit?.body))).toMatchObject({
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      leaseId: "lease-1",
      sessionId: "conversation-1",
      turnId: "turn-1",
    });
  });

  test("persists a pre-admission tombstone across an isolate restart", async () => {
    const { storage } = storageHarness();
    const first = new ExactTurnCancellationLedger(storage);
    expect(
      await first.stage(request("turn-before-admission"), 10),
    ).toMatchObject({
      status: "staged",
      cancellation: { state: "pending", persistedAt: 10 },
    });

    const restarted = new ExactTurnCancellationLedger(storage);
    expect(
      await restarted.matching({
        turnId: "turn-before-admission",
        ownerId: "owner-1",
        ownerGeneration: "generation-1",
      }),
    ).toMatchObject({
      turnId: "turn-before-admission",
      cancelRequestId: "cancel:turn-before-admission",
      state: "pending",
    });
  });

  test("replays the same cancellation identity and rejects ABA replacement", async () => {
    const { storage } = storageHarness();
    const ledger = new ExactTurnCancellationLedger(storage);
    const exact = request("turn-aba");
    expect((await ledger.stage(exact)).status).toBe("staged");
    expect((await ledger.stage(exact)).status).toBe("replayed");
    expect(
      (
        await ledger.stage(
          request("turn-aba", { cancelRequestId: "cancel:different" }),
        )
      ).status,
    ).toBe("conflict");
    expect(
      (
        await ledger.stage(
          request("turn-newer", { cancelRequestId: exact.cancelRequestId }),
        )
      ).status,
    ).toBe("conflict");
    expect(await ledger.acknowledge(exact, 20)).toBe(true);
    expect((await ledger.stage(exact)).status).toBe("replayed");
    expect((await ledger.entriesForTest())[0]).toMatchObject({
      state: "acknowledged",
      acknowledgedAt: 20,
    });
  });

  test("does not apply a stale owner generation to a replacement turn", async () => {
    const { storage } = storageHarness();
    const ledger = new ExactTurnCancellationLedger(storage);
    await ledger.stage(request("turn-generation"));
    expect(
      await ledger.matching({
        turnId: "turn-generation",
        ownerId: "owner-1",
        ownerGeneration: "generation-2",
      }),
    ).toBeNull();
  });

  test("fails closed at its pending bound instead of evicting a live tombstone", async () => {
    const { storage, values } = storageHarness();
    const ledger = new ExactTurnCancellationLedger(storage);
    for (let index = 0; index < 128; index += 1) {
      expect((await ledger.stage(request(`turn-${index}`), index)).status).toBe(
        "staged",
      );
    }
    expect((await ledger.stage(request("turn-overflow"), 129)).status).toBe(
      "saturated",
    );
    expect((values.get(EXACT_TURN_CANCELLATIONS_KEY) as unknown[]).length).toBe(
      128,
    );
    expect(
      await ledger.matching({
        turnId: "turn-0",
        ownerId: "owner-1",
        ownerGeneration: "generation-1",
      }),
    ).not.toBeNull();
  });

  test("rejects legacy or unbounded conversation-wide cancellation bodies", () => {
    expect(parseExactTurnCancellationRequest({})).toBeNull();
    expect(
      parseExactTurnCancellationRequest({
        ...request("turn-1"),
        turnId: "x".repeat(129),
      }),
    ).toBeNull();
    expect(parseExactTurnCancellationRequest(request("turn-1"))).toEqual(
      request("turn-1"),
    );
  });

  test("the DO keeps a newer current turn alive when canceling an exact queued turn", async () => {
    const { instance, values } = sessionHarness();
    values.set("turn", turn("turn-newer"));
    values.set("terminal", false);
    values.set("queued:turn-target", turn("turn-target"));
    let aborts = 0;
    instance["currentTurnAbort"] = { abort: () => aborts++ } as AbortController;
    instance["currentAgent"] = { abort: () => aborts++ };

    const response = await instance.fetch(
      cancelRequest(request("turn-target")),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: "turn-target",
      pending: true,
      durable: true,
    });
    expect(aborts).toBe(0);
    expect((values.get("turn") as { turnId: string }).turnId).toBe(
      "turn-newer",
    );
    expect(values.get("terminal")).toBe(false);
    expect(values.has("queued:turn-target")).toBe(true);
  });

  test("the DO withholds a current-turn ACK until the exact run joins", async () => {
    const { instance, values, ledger } = sessionHarness();
    values.set("turn", turn("turn-current"));
    values.set("terminal", false);
    let release!: (value: Response) => void;
    const running = new Promise<Response>((resolve) => {
      release = resolve;
    });
    (instance["turnExecutions"] as Map<string, unknown>).set(
      "turn-current",
      controlledExecution(running, () => {
        (
          instance["currentTurnCancellation"] as
            | { abort?: () => void }
            | undefined
        )?.abort?.();
      }),
    );
    instance["activeTurnId"] = "turn-current";
    let aborted = false;
    let observeAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    instance["currentTurnCancellation"] = {
      aborted: false,
      reason: undefined,
      abort: () => {
        aborted = true;
        observeAbort();
      },
      sleep: async () => undefined,
    };

    let settled = false;
    const responsePromise = instance
      .fetch(cancelRequest(request("turn-current")))
      .then((response) => {
        settled = true;
        return response;
      });
    await abortObserved;
    expect(aborted).toBe(true);
    expect(settled).toBe(false);
    release(Response.json({ ok: false, canceled: true }));

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: "turn-current",
      joined: true,
    });
    expect(await ledger.matching(request("turn-current"))).toMatchObject({
      state: "acknowledged",
    });
  });

  test("an idempotent current-turn retry also waits for the same join", async () => {
    const { instance, values } = sessionHarness();
    values.set("turn", turn("turn-current-retry"));
    values.set("terminal", false);
    let release!: (value: Response) => void;
    const running = new Promise<Response>((resolve) => {
      release = resolve;
    });
    (instance["turnExecutions"] as Map<string, unknown>).set(
      "turn-current-retry",
      controlledExecution(running, () => {
        (
          instance["currentTurnCancellation"] as
            | { abort?: () => void }
            | undefined
        )?.abort?.();
      }),
    );
    instance["activeTurnId"] = "turn-current-retry";
    let observeAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    instance["currentTurnCancellation"] = {
      aborted: false,
      reason: undefined,
      abort: observeAbort,
      sleep: async () => undefined,
    };

    let firstSettled = false;
    let retrySettled = false;
    const exact = request("turn-current-retry");
    const first = instance.fetch(cancelRequest(exact)).then((response) => {
      firstSettled = true;
      return response;
    });
    await abortObserved;
    const retry = instance.fetch(cancelRequest(exact)).then((response) => {
      retrySettled = true;
      return response;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(retrySettled).toBe(false);

    release(Response.json({ ok: false, canceled: true }));
    const [firstResponse, retryResponse] = await Promise.all([first, retry]);
    expect(firstResponse.status).toBe(200);
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({
      canceled: true,
      turnId: "turn-current-retry",
      replayed: true,
    });
  });

  test("a lost owner-fence register response replays the exact durable intent", async () => {
    const values = new Map<string, unknown>();
    const remoteLeases = new Map<string, Record<string, unknown>>();
    const registeredLeaseIds: string[] = [];
    let loseFirstResponse = true;
    const installFence = (harness: ReturnType<typeof sessionHarness>) => {
      enableDurableOwnerFenceLifecycle(harness.instance);
      harness.instance["enqueue"] = () => undefined;
      harness.instance["callOwnerFence"] = async (
        _ownerId: string,
        path: string,
        body: Record<string, unknown>,
      ) => {
        const leaseId = String(body.leaseId ?? "");
        if (path === "register") {
          registeredLeaseIds.push(leaseId);
          remoteLeases.set(leaseId, structuredClone(body));
          if (loseFirstResponse) {
            loseFirstResponse = false;
            throw new Error("register response lost");
          }
          return Response.json({ generation: "fence-generation-1" });
        }
        if (path === "assert") {
          return remoteLeases.has(leaseId)
            ? Response.json({ ok: true })
            : Response.json({ error: "missing" }, { status: 409 });
        }
        if (path === "unregister") {
          remoteLeases.delete(leaseId);
          return Response.json({ ok: true });
        }
        throw new Error(`Unexpected owner-fence path: ${path}`);
      };
    };

    const original = sessionHarness(values);
    installFence(original);
    const exact = turn("turn-register-response-lost");
    const first = await original.instance.fetch(turnRequest(exact));
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      code: "owner_fence_registration_uncertain",
    });
    expect(values.has(`queued:${exact.turnId}`)).toBe(false);
    expect(ownerFenceLeaseReceipts(values)).toHaveLength(1);
    expect(ownerFenceLeaseReceipts(values)[0]).toMatchObject({
      turnId: exact.turnId,
      phase: "registering",
    });
    expect(values.get(`chatTurnAdmission:${exact.turnId}`)).toMatchObject({
      schemaVersion: 1,
      ownerId: exact.ownerId,
      ownerGeneration: exact.ownerGeneration,
      turnId: exact.turnId,
      leaseId: ownerFenceLeaseReceipts(values)[0]?.leaseId,
      phase: "registering",
    });

    const conflicting = await original.instance.fetch(
      turnRequest({ ...exact, prompt: "different payload" }),
    );
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({
      code: "idempotency_conflict",
    });
    expect(registeredLeaseIds).toHaveLength(1);
    const changedGeneration = await original.instance.fetch(
      turnRequest({ ...exact, ownerGeneration: "generation-2" }),
    );
    expect(changedGeneration.status).toBe(409);
    expect(await changedGeneration.json()).toMatchObject({
      code: "idempotency_conflict",
    });
    expect(registeredLeaseIds).toHaveLength(1);

    const replacement = sessionHarness(values);
    installFence(replacement);
    const replay = await replacement.instance.fetch(turnRequest(exact));
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      accepted: true,
      replayed: false,
    });
    expect(registeredLeaseIds).toHaveLength(2);
    expect(new Set(registeredLeaseIds).size).toBe(1);
    expect(remoteLeases.size).toBe(1);
    expect(values.get(`queued:${exact.turnId}`)).toMatchObject({
      turnId: exact.turnId,
      ownerPurgeLeaseId: registeredLeaseIds[0],
      ownerPurgeGeneration: "fence-generation-1",
    });
    expect(ownerFenceLeaseReceipts(values)[0]).toMatchObject({
      leaseId: registeredLeaseIds[0],
      phase: "registered",
      registrationGeneration: "fence-generation-1",
    });
    expect(values.get(`chatTurnAdmission:${exact.turnId}`)).toMatchObject({
      ownerGeneration: exact.ownerGeneration,
      leaseId: registeredLeaseIds[0],
      phase: "accepted",
    });
  });

  test("a restart after register but before queue commit reuses the registered receipt", async () => {
    const values = new Map<string, unknown>();
    const remoteLeases = new Map<string, Record<string, unknown>>();
    const registeredLeaseIds: string[] = [];
    const installFence = (harness: ReturnType<typeof sessionHarness>) => {
      enableDurableOwnerFenceLifecycle(harness.instance);
      harness.instance["enqueue"] = () => undefined;
      harness.instance["callOwnerFence"] = async (
        _ownerId: string,
        path: string,
        body: Record<string, unknown>,
      ) => {
        const leaseId = String(body.leaseId ?? "");
        if (path === "register") {
          registeredLeaseIds.push(leaseId);
          remoteLeases.set(leaseId, structuredClone(body));
          return Response.json({ generation: "fence-generation-1" });
        }
        if (path === "assert") {
          return remoteLeases.has(leaseId)
            ? Response.json({ ok: true })
            : Response.json({ error: "missing" }, { status: 409 });
        }
        if (path === "unregister") {
          remoteLeases.delete(leaseId);
          return Response.json({ ok: true });
        }
        throw new Error(`Unexpected owner-fence path: ${path}`);
      };
    };
    const exact = turn("turn-register-before-queue-crash");
    const original = sessionHarness(values);
    installFence(original);
    const durablePut = original.storage.put;
    let failQueueCommit = true;
    original.storage.put = async (
      key: string | Record<string, unknown>,
      value?: unknown,
    ) => {
      if (
        failQueueCommit &&
        typeof key !== "string" &&
        Object.hasOwn(key, `queued:${exact.turnId}`)
      ) {
        failQueueCommit = false;
        throw new Error("queue commit interrupted");
      }
      await durablePut(key, value);
    };

    await expect(original.instance.fetch(turnRequest(exact))).rejects.toThrow(
      "queue commit interrupted",
    );
    expect(values.has(`queued:${exact.turnId}`)).toBe(false);
    expect(ownerFenceLeaseReceipts(values)[0]).toMatchObject({
      phase: "registered",
      registrationGeneration: "fence-generation-1",
    });
    expect(values.get(`chatTurnAdmission:${exact.turnId}`)).toMatchObject({
      schemaVersion: 1,
      ownerGeneration: exact.ownerGeneration,
      leaseId: registeredLeaseIds[0],
      phase: "registering",
    });

    const replacement = sessionHarness(values);
    installFence(replacement);
    const changedGeneration = await replacement.instance.fetch(
      turnRequest({ ...exact, ownerGeneration: "generation-2" }),
    );
    expect(changedGeneration.status).toBe(409);
    expect(await changedGeneration.json()).toMatchObject({
      code: "idempotency_conflict",
    });
    expect(registeredLeaseIds).toHaveLength(1);
    expect(remoteLeases.size).toBe(1);
    const replay = await replacement.instance.fetch(turnRequest(exact));
    expect(replay.status).toBe(202);
    expect(registeredLeaseIds).toHaveLength(1);
    expect(remoteLeases.size).toBe(1);
    expect(values.get(`queued:${exact.turnId}`)).toMatchObject({
      ownerGeneration: exact.ownerGeneration,
      ownerPurgeLeaseId: registeredLeaseIds[0],
    });
    expect(values.get(`chatTurnAdmission:${exact.turnId}`)).toMatchObject({
      ownerGeneration: exact.ownerGeneration,
      leaseId: registeredLeaseIds[0],
      phase: "accepted",
    });
  });

  test("a lost unregister response leaves durable debt that a replacement retries", async () => {
    const values = new Map<string, unknown>();
    const remoteLeases = new Map<string, Record<string, unknown>>();
    let unregisterCalls = 0;
    let loseUnregisterResponse = true;
    const installFence = (harness: ReturnType<typeof sessionHarness>) => {
      enableDurableOwnerFenceLifecycle(harness.instance);
      harness.instance["callOwnerFence"] = async (
        _ownerId: string,
        path: string,
        body: Record<string, unknown>,
      ) => {
        const leaseId = String(body.leaseId ?? "");
        if (path === "register") {
          remoteLeases.set(leaseId, structuredClone(body));
          return Response.json({ generation: "fence-generation-1" });
        }
        if (path === "unregister") {
          unregisterCalls += 1;
          remoteLeases.delete(leaseId);
          if (loseUnregisterResponse) {
            loseUnregisterResponse = false;
            throw new Error("unregister response lost");
          }
          return Response.json({ ok: true, alreadyUnregistered: true });
        }
        return Response.json({ ok: true });
      };
    };

    const original = sessionHarness(values);
    installFence(original);
    const target = turn("turn-unregister-response-lost") as ReturnType<
      typeof turn
    > & {
      ownerPurgeGeneration?: string;
      ownerPurgeLeaseId?: string;
    };
    target.ownerPurgeGeneration = await (
      original.instance["registerOwnerTurn"] as (
        value: typeof target,
      ) => Promise<string>
    )(target);
    const retired = await (
      original.instance["unregisterOwnerTurn"] as (
        value: typeof target,
      ) => Promise<boolean>
    )(target);
    expect(retired).toBe(false);
    expect(remoteLeases.size).toBe(0);
    expect(ownerFenceLeaseReceipts(values)[0]).toMatchObject({
      phase: "unregister_pending",
      leaseId: target.ownerPurgeLeaseId,
    });
    expect(await original.storage.getAlarm()).not.toBeNull();

    const replacement = sessionHarness(values);
    installFence(replacement);
    await (
      replacement.instance[
        "retryOwnerFenceLeaseRetirements"
      ] as () => Promise<void>
    )();
    expect(unregisterCalls).toBe(2);
    expect(ownerFenceLeaseReceipts(values)).toHaveLength(0);
    expect(
      [...values.keys()].some((key) => key.startsWith("ownerFenceRunSlot:")),
    ).toBe(false);
  });

  test("owner purge retires an exact receipt-only registration orphan", async () => {
    const harness = sessionHarness();
    enableDurableOwnerFenceLifecycle(harness.instance);
    const remoteLeases = new Map<string, Record<string, unknown>>();
    harness.instance["callOwnerFence"] = async (
      _ownerId: string,
      path: string,
      body: Record<string, unknown>,
    ) => {
      const leaseId = String(body.leaseId ?? "");
      if (path === "register") {
        remoteLeases.set(leaseId, structuredClone(body));
        return Response.json({ generation: "registration-generation" });
      }
      if (path === "unregister") {
        remoteLeases.delete(leaseId);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    };
    const target = turn("turn-pre-persistence-orphan") as ReturnType<
      typeof turn
    > & {
      ownerPurgeGeneration?: string;
      ownerPurgeLeaseId?: string;
    };
    target.ownerPurgeGeneration = await (
      harness.instance["registerOwnerTurn"] as (
        value: typeof target,
      ) => Promise<string>
    )(target);
    const leaseId = target.ownerPurgeLeaseId!;
    expect(harness.values.has("turn")).toBe(false);
    expect(harness.values.has(`queued:${target.turnId}`)).toBe(false);

    const mismatch = await harness.instance.fetch(
      ownerPurgeRequest({
        ownerId: target.ownerId,
        ownerGeneration: "different-generation",
        turnId: target.turnId,
        generation: "blocked-generation",
        leaseId,
      }),
    );
    expect(mismatch.status).toBe(409);
    expect(remoteLeases.has(leaseId)).toBe(true);

    const response = await harness.instance.fetch(
      ownerPurgeRequest({
        ownerId: target.ownerId,
        ownerGeneration: target.ownerGeneration,
        turnId: target.turnId,
        generation: "blocked-generation",
        leaseId,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      orphan: true,
      unregistered: true,
    });
    expect(remoteLeases.has(leaseId)).toBe(false);
    expect(ownerFenceLeaseReceipts(harness.values)).toHaveLength(0);
    expect(harness.values.has("terminal")).toBe(false);
  });

  test("an exact old receipt retires without touching an ABA successor", async () => {
    const harness = sessionHarness();
    enableDurableOwnerFenceLifecycle(harness.instance);
    const remoteLeases = new Map<string, Record<string, unknown>>();
    harness.instance["callOwnerFence"] = async (
      _ownerId: string,
      path: string,
      body: Record<string, unknown>,
    ) => {
      const leaseId = String(body.leaseId ?? "");
      if (path === "register") {
        remoteLeases.set(leaseId, structuredClone(body));
        return Response.json({ generation: "registration-generation" });
      }
      if (path === "unregister") {
        remoteLeases.delete(leaseId);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    };
    const old = turn("turn-owner-fence-aba", "generation-1") as ReturnType<
      typeof turn
    > & {
      ownerPurgeGeneration?: string;
      ownerPurgeLeaseId?: string;
    };
    old.ownerPurgeGeneration = await (
      harness.instance["registerOwnerTurn"] as (
        value: typeof old,
      ) => Promise<string>
    )(old);
    const oldLeaseId = old.ownerPurgeLeaseId!;
    const successor = {
      ...turn(old.turnId, "generation-2"),
      ownerPurgeGeneration: "successor-registration-generation",
      ownerPurgeLeaseId: "successor-lease",
    };
    harness.values.set("turn", structuredClone(successor));
    harness.values.set("terminal", false);
    await harness.storage.setAlarm(987_654_321);
    let aborts = 0;
    harness.instance["currentTurnCancellation"] = { abort: () => aborts++ };
    harness.instance["currentAgent"] = { abort: () => aborts++ };

    const response = await harness.instance.fetch(
      ownerPurgeRequest({
        ownerId: old.ownerId,
        ownerGeneration: old.ownerGeneration,
        turnId: old.turnId,
        generation: "blocked-generation",
        leaseId: oldLeaseId,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: false,
      reason: "stale_owner_purge_identity",
      unregistered: true,
    });
    expect(remoteLeases.has(oldLeaseId)).toBe(false);
    expect(ownerFenceLeaseReceipts(harness.values)).toHaveLength(0);
    expect(harness.values.get("turn")).toEqual(successor);
    expect(harness.values.get("terminal")).toBe(false);
    expect(await harness.storage.getAlarm()).toBe(987_654_321);
    expect(aborts).toBe(0);
  });

  test("unknown pre-admission cancellation is retryable and survives a DO replacement", async () => {
    const values = new Map<string, unknown>();
    const first = sessionHarness(values);
    const exact = request("turn-delayed");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await first.instance.fetch(cancelRequest(exact));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        canceled: true,
        pending: true,
        durable: true,
      });
    }
    expect(await first.ledger.entriesForTest()).toHaveLength(1);

    const replacement = sessionHarness(values);
    expect(await replacement.ledger.matching(exact)).toMatchObject({
      turnId: "turn-delayed",
      state: "pending",
    });

    const delayedTurn = turn("turn-delayed");
    values.set("queued:turn-delayed", delayedTurn);
    const result = await (
      replacement.instance["runTurn"] as (
        input: ReturnType<typeof turn>,
      ) => Promise<Response>
    )(delayedTurn);
    expect(await result.json()).toMatchObject({
      ok: false,
      canceled: true,
      preAdmission: true,
    });
    expect(values.has("queued:turn-delayed")).toBe(false);
    expect(await replacement.ledger.matching(exact)).toMatchObject({
      state: "acknowledged",
    });
  });

  test("stale-generation and legacy requests fail closed without aborting current work", async () => {
    const { instance, values, ledger } = sessionHarness();
    values.set("turn", turn("turn-current", "generation-2"));
    values.set("terminal", false);
    let aborts = 0;
    instance["currentTurnAbort"] = { abort: () => aborts++ } as AbortController;

    const stale = await instance.fetch(
      cancelRequest(
        request("turn-current", { ownerGeneration: "generation-1" }),
      ),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      canceled: false,
      reason: "stale_owner_generation",
    });
    const legacy = await instance.fetch(cancelRequest({}));
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toMatchObject({
      canceled: false,
      reason: "exact_turn_identity_required",
    });
    expect(aborts).toBe(0);
    expect(await ledger.entriesForTest()).toHaveLength(0);
  });

  test("the agent DO joins the exact current run before ACK and blocks an ABA successor", async () => {
    const harness = buildSessionHarness();
    const current = agentTurn("agent-current");
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    (harness.instance["agentTurnExecutions"] as Map<string, unknown>).set(
      current.turnId,
      controlledExecution(running, async () => {
        await (
          harness.instance["terminateCurrentAgentSandbox"] as (
            target: ReturnType<typeof agentTurn>,
          ) => Promise<void>
        )(current);
      }),
    );

    let settled = false;
    const cancellation = harness.instance
      .fetch(cancelRequest(request(current.turnId)))
      .then((response) => {
        settled = true;
        return response;
      });
    while (harness.terminated.length === 0) await Promise.resolve();
    expect(settled).toBe(false);
    expect(harness.values.get("pendingTerminal")).toMatchObject({
      turnId: current.turnId,
      kind: "canceled",
      terminateSandbox: true,
    });

    const successor = agentTurn("agent-successor");
    const successorResponse = await (
      harness.instance["acceptAgentTurn"] as (
        target: ReturnType<typeof agentTurn>,
      ) => Promise<Response>
    )(successor);
    expect(successorResponse.status).toBe(409);
    expect(await successorResponse.json()).toMatchObject({
      accepted: false,
      reason: "cancellation_join_pending",
      currentTurnId: current.turnId,
    });
    expect((harness.values.get("turn") as { turnId: string }).turnId).toBe(
      current.turnId,
    );

    release();
    const response = await cancellation;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: current.turnId,
      joined: true,
    });
    expect(harness.values.get("pendingTerminal")).toBeUndefined();
    expect(
      await harness.ledger.matching(request(current.turnId)),
    ).toMatchObject({ state: "acknowledged" });
    expect(harness.values.has("pendingTerminal")).toBe(false);
  });

  test("a joined live cancel retires its execution marker and original workspace run lease", async () => {
    const harness = buildSessionHarness();
    const current = {
      ...agentTurn("agent-live-cancel-cleanup"),
      workspace: "stella",
      ownerPurgeLeaseId: "run-lease:original",
      ownerPurgeGeneration: "purge-generation-1",
    };
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);
    harness.values.set(`agentExecutionMarker:${current.turnId}:1`, {
      schemaVersion: 1,
      turnId: current.turnId,
      attemptGeneration: 1,
      sandboxId: `agent-${current.turnId}`,
      size: "large",
      workspace: "stella",
      workspaceRoot: "/workspace/stella",
      startedAt: Date.now(),
    });

    const activeWorkspaceRuns = new Map([
      [current.ownerPurgeLeaseId, current.workspace],
    ]);
    const unregisteredLeaseIds: string[] = [];
    harness.instance["registerTurn"] = async (
      target: Record<string, unknown>,
      freshLease = false,
    ) => {
      if (freshLease) {
        target.ownerPurgeLeaseId = `aux-lease:${String(target.turnId)}`;
        return "purge-generation-1";
      }
      const leaseId =
        typeof target.ownerPurgeLeaseId === "string"
          ? target.ownerPurgeLeaseId
          : `run-lease:${String(target.turnId)}`;
      const workspace = String(target.workspace ?? "");
      if (
        [...activeWorkspaceRuns].some(
          ([activeLeaseId, activeWorkspace]) =>
            activeLeaseId !== leaseId && activeWorkspace === workspace,
        )
      ) {
        throw new Error("workspace_busy");
      }
      target.ownerPurgeLeaseId = leaseId;
      activeWorkspaceRuns.set(leaseId, workspace);
      return "purge-generation-1";
    };
    harness.instance["unregisterTurnLease"] = async (
      _target: Record<string, unknown>,
      leaseId: string,
    ) => {
      unregisteredLeaseIds.push(leaseId);
      activeWorkspaceRuns.delete(leaseId);
    };

    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    (harness.instance["agentTurnExecutions"] as Map<string, unknown>).set(
      current.turnId,
      controlledExecution(running, async () => {
        await (
          harness.instance["terminateCurrentAgentSandbox"] as (
            target: ReturnType<typeof agentTurn>,
          ) => Promise<void>
        )(current);
      }),
    );

    const cancellation = harness.instance.fetch(
      cancelRequest(request(current.turnId)),
    );
    while (harness.terminated.length === 0) await Promise.resolve();
    release();

    const response = await cancellation;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: current.turnId,
      joined: true,
    });
    expect(harness.values.has("turn")).toBe(false);
    expect(
      harness.values.has(`agentExecutionMarker:${current.turnId}:1`),
    ).toBe(false);
    expect(unregisteredLeaseIds).toEqual(
      expect.arrayContaining([
        `aux-lease:${current.turnId}`,
        "run-lease:original",
      ]),
    );
    expect(activeWorkspaceRuns.size).toBe(0);
    expect(await harness.ledger.matching(request(current.turnId))).toMatchObject(
      { state: "acknowledged" },
    );

    const successor = {
      ...agentTurn("agent-after-live-cancel"),
      workspace: "stella",
    };
    await expect(
      (
        harness.instance["registerTurn"] as (
          target: Record<string, unknown>,
        ) => Promise<string>
      )(successor),
    ).resolves.toBe("purge-generation-1");
  });

  test("a session created after Stop cannot admit executor work", async () => {
    const harness = buildSessionHarness();
    const current = agentTurn("agent-late-session");
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);
    let releaseSession!: (session: Record<string, unknown>) => void;
    let observeCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      observeCreate = resolve;
    });
    const sessionGate = new Promise<Record<string, unknown>>((resolve) => {
      releaseSession = resolve;
    });
    let executorCalls = 0;
    const session = {
      exec: async () => {
        executorCalls += 1;
        return { success: true, stdout: "{}", stderr: "", exitCode: 0 };
      },
    };
    const sandbox = {
      createSession: async () => {
        observeCreate();
        return await sessionGate;
      },
    };
    const stopped = new Error("exact Stop closed admission");
    let active = true;
    const execution = {
      cancellation: {
        aborted: false,
        reason: undefined,
        abort: () => undefined,
        sleep: async () => undefined,
      },
      signal: new AbortController().signal,
      assertActive: () => {
        if (!active) throw stopped;
      },
    };

    const attempt = (
      harness.instance["runAgentAttempt"] as (args: {
        turn: ReturnType<typeof agentTurn>;
        execution: typeof execution;
        sandbox: typeof sandbox;
        size: "large";
        workspaceRoot: string;
        descriptor: null;
        history: unknown[];
        commandTimeoutMs: number;
      }) => Promise<unknown>
    )({
      turn: current,
      execution,
      sandbox,
      size: "large",
      workspaceRoot: "/workspace/project",
      descriptor: null,
      history: [],
      commandTimeoutMs: 1_000,
    });
    await createStarted;
    active = false;
    releaseSession(session);

    await expect(attempt).rejects.toBe(stopped);
    expect(executorCalls).toBe(0);
  });

  test("owner purge closes agent admission and joins a late session before ACK", async () => {
    const harness = buildSessionHarness();
    const current = {
      ...agentTurn("agent-owner-purge-late-session"),
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "lease:agent-owner-purge-late-session",
    };
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);
    let releaseSession!: () => void;
    let observeCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      observeCreate = resolve;
    });
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let executorCalls = 0;
    let sessionLive = false;
    let teardownCalls = 0;
    let observeTeardown!: () => void;
    const teardownStarted = new Promise<void>((resolve) => {
      observeTeardown = resolve;
    });
    const execution = startTurnExecution({
      work: async ({ assertActive }) => {
        observeCreate();
        await sessionGate;
        // A platform createSession may ignore cancellation and materialize
        // after the first destroy; the post-settlement sweep must remove it.
        sessionLive = true;
        assertActive();
        executorCalls += 1;
      },
      onInterrupt: () => {
        teardownCalls += 1;
        sessionLive = false;
        observeTeardown();
      },
      afterInterrupt: () => {
        teardownCalls += 1;
        sessionLive = false;
      },
      cleanupTimeoutMs: 1_000,
    });
    (harness.instance["agentTurnExecutions"] as Map<string, unknown>).set(
      current.turnId,
      execution,
    );
    harness.instance["cleanupTransientWrites"] = async () => undefined;
    harness.instance["callOwnerFence"] = async () =>
      Response.json({ ok: true });

    await createStarted;
    let acknowledged = false;
    const purge = harness.instance
      .fetch(
        new Request("https://build-session/owner-purge-cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerId: current.ownerId,
            ownerGeneration: current.ownerGeneration,
            turnId: current.turnId,
            generation: current.ownerPurgeGeneration,
            leaseId: current.ownerPurgeLeaseId,
          }),
        }),
      )
      .then((response) => {
        acknowledged = true;
        return response;
      });
    await teardownStarted;
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    releaseSession();

    const response = await purge;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: current.turnId,
      unregistered: true,
    });
    expect(teardownCalls).toBe(2);
    expect(sessionLive).toBe(false);
    expect(executorCalls).toBe(0);
  });

  test("a delayed owner-purge callback cannot erase an ABA successor", async () => {
    const harness = buildSessionHarness();
    const successor = {
      ...agentTurn("agent-owner-purge-aba", "owner-generation-2"),
      ownerPurgeGeneration: "purge-generation-2",
      ownerPurgeLeaseId: "lease:owner-generation-2",
    };
    harness.values.set("turn", successor);
    harness.values.set("turnId", successor.turnId);
    harness.values.set("terminal", false);
    harness.values.set("sandboxId", "sandbox-successor");
    let destroys = 0;
    let cleanups = 0;
    let unregisters = 0;
    harness.instance["currentSandbox"] = async () => ({
      destroy: async () => {
        destroys += 1;
      },
    });
    harness.instance["cleanupTransientWrites"] = async () => {
      cleanups += 1;
    };
    harness.instance["callOwnerFence"] = async () => {
      unregisters += 1;
      return Response.json({ ok: true });
    };

    const response = await harness.instance.fetch(
      new Request("https://build-session/owner-purge-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerId: successor.ownerId,
          ownerGeneration: "owner-generation-1",
          turnId: successor.turnId,
          generation: "purge-generation-1",
          leaseId: "lease:owner-generation-1",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: false,
      reason: "stale_owner_purge_identity",
      turnId: successor.turnId,
      unregistered: true,
    });
    expect(harness.values.get("turn")).toEqual(successor);
    expect(harness.values.get("terminal")).toBe(false);
    expect(harness.values.get("sandboxId")).toBe("sandbox-successor");
    expect(destroys).toBe(0);
    expect(cleanups).toBe(0);
    expect(unregisters).toBe(1);
  });

  test("rejects a delayed stale app dispatch before durable admission", async () => {
    const harness = buildSessionHarness();
    delete harness.instance["assertConvexAppTurnAuthority"];
    let startCalls = 0;
    harness.instance["startAppTurn"] = async () => {
      startCalls += 1;
      return Response.json({ ok: true });
    };
    const stale = appTurn("app-stale-after-purge", "owner-generation-old");
    const originalFetch = globalThis.fetch;
    let authorityBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      authorityBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ authoritative: false }, { status: 409 });
    }) as typeof fetch;
    try {
      const response = await harness.instance.fetch(turnRequest(stale));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "Cloud app attempt is no longer active.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(authorityBody).toMatchObject({
      ownerId: stale.ownerId,
      ownerGeneration: stale.ownerGeneration,
      conversationId: stale.conversationId,
      appId: stale.appId,
      turnId: stale.turnId,
      sessionId: stale.sessionId,
      tokenHash: await sha256Hex(stale.turnToken),
    });
    expect(startCalls).toBe(0);
    expect(harness.values.has("turn")).toBe(false);
    expect(harness.values.has("turnId")).toBe(false);
  });

  test("a paused stale app replay cannot replace its successor watchdog", async () => {
    const harness = buildSessionHarness();
    const previous = {
      ...appTurn("app-replay-a", "owner-generation-a"),
      ownerPurgeGeneration: "purge-generation-a",
      ownerPurgeLeaseId: "lease-a",
    };
    harness.values.set("turn", previous);
    harness.values.set("turnId", previous.turnId);
    harness.values.set("terminal", false);
    let releaseAuthority!: () => void;
    let authorityStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authorityStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    harness.instance["assertConvexAppTurnAuthority"] = async () => {
      authorityStarted();
      await gate;
    };
    const dispatch = { ...previous } as Partial<typeof previous>;
    delete dispatch.ownerPurgeGeneration;
    delete dispatch.ownerPurgeLeaseId;
    const replay = harness.instance.fetch(turnRequest(dispatch));
    await started;

    const successor = {
      ...appTurn("app-replay-b", "owner-generation-b"),
      ownerPurgeGeneration: "purge-generation-b",
      ownerPurgeLeaseId: "lease-b",
    };
    harness.values.clear();
    await harness.storage.put({
      turn: successor,
      turnId: successor.turnId,
      terminal: false,
      terminalDelivered: false,
      sandboxId: "sandbox-b",
    });
    const successorAlarm = Date.now() + 600_000;
    await harness.storage.setAlarm(successorAlarm);
    releaseAuthority();

    const response = await replay;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      accepted: false,
      replayed: true,
      reason: "superseded",
    });
    expect(harness.values.get("turn")).toEqual(successor);
    expect(harness.values.get("terminal")).toBe(false);
    expect(harness.values.has("pendingTerminal")).toBe(false);
    expect(await harness.storage.getAlarm()).toBe(successorAlarm);
  });

  test("a fired predecessor alarm cannot delete successor state", async () => {
    const harness = buildSessionHarness();
    const previous = appTurn("app-alarm-a", "owner-generation-a");
    harness.values.set("turn", previous);
    harness.values.set("turnId", previous.turnId);
    harness.values.set("terminal", true);
    harness.values.set("terminalDelivered", true);
    let releaseCleanup!: () => void;
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    harness.instance["settleTerminalTransientWrites"] = async () => {
      cleanupStarted();
      await gate;
      return true;
    };
    const staleAlarm = (
      harness.instance["runAlarm"] as (target: typeof previous) => Promise<void>
    )(previous);
    await started;

    const successor = appTurn("app-alarm-b", "owner-generation-b");
    harness.values.clear();
    await harness.storage.put({
      turn: successor,
      turnId: successor.turnId,
      terminal: false,
      terminalDelivered: false,
      sandboxId: "sandbox-b",
    });
    const successorAlarm = Date.now() + 600_000;
    await harness.storage.setAlarm(successorAlarm);
    releaseCleanup();
    await staleAlarm;

    expect(harness.values.get("turn")).toEqual(successor);
    expect(harness.values.get("sandboxId")).toBe("sandbox-b");
    expect(harness.values.get("terminal")).toBe(false);
    expect(await harness.storage.getAlarm()).toBe(successorAlarm);
  });

  test("watchdog timeout uses one failed terminal contract", async () => {
    const harness = buildSessionHarness();
    const current = agentTurn("agent-watchdog-timeout");
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);
    delete harness.instance["deliverTerminal"];
    const receipts: Array<Record<string, unknown>> = [];
    harness.instance["event"] = async (
      _turn: unknown,
      _seq: unknown,
      kind: string,
      payload: Record<string, unknown>,
      terminal: boolean,
    ) => {
      receipts.push({ surface: "event", kind, payload, terminal });
    };
    harness.instance["callback"] = async (
      _turn: unknown,
      path: string,
      body: Record<string, unknown>,
    ) => {
      receipts.push({ surface: path, ...body });
      return {};
    };

    await (
      harness.instance["runAlarm"] as (target: typeof current) => Promise<void>
    )(current);

    expect(receipts).toEqual([
      {
        surface: "event",
        kind: "failed",
        payload: {
          message:
            "This took longer than expected, so Stella stopped. Try again.",
          reason: "timeout",
        },
        terminal: true,
      },
      expect.objectContaining({
        surface: "/api/cloud/threads/complete",
        threadId: current.threadId,
        turnId: current.turnId,
        attemptGeneration: current.attemptGeneration,
        status: "failed",
      }),
    ]);
  });

  test("an already-fired stale alarm cannot recover a newly admitted live agent", async () => {
    const harness = buildSessionHarness();
    const current = agentTurn("agent-stale-alarm-live-successor");
    const watchdogDeadlineAt = Date.now() + 600_000;
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);
    harness.values.set("agentWatchdogDeadlineAt", watchdogDeadlineAt);
    (
      harness.instance["agentTurnExecutions"] as Map<string, unknown>
    ).set(current.turnId, {});
    let alarmRecoveryCalls = 0;
    harness.instance["runAlarmWithLease"] = async () => {
      alarmRecoveryCalls += 1;
    };

    await harness.instance.alarm();

    expect(alarmRecoveryCalls).toBe(0);
    expect(await harness.storage.getAlarm()).toBe(watchdogDeadlineAt);
    expect(harness.values.get("turn")).toEqual(current);
    expect(harness.values.get("terminal")).toBe(false);
  });

  test("an intentional recovery alarm is not hidden by the live-fiber fence", async () => {
    const harness = buildSessionHarness();
    const current = agentTurn("agent-explicit-recovery-alarm");
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);
    harness.values.set("agentWatchdogDeadlineAt", Date.now() + 600_000);
    harness.values.set(
      "agentRecoveryPending",
      `${current.turnId}:${current.attemptGeneration}`,
    );
    (
      harness.instance["agentTurnExecutions"] as Map<string, unknown>
    ).set(current.turnId, {});
    let alarmRecoveryCalls = 0;
    harness.instance["runAlarmWithLease"] = async () => {
      alarmRecoveryCalls += 1;
    };

    await harness.instance.alarm();

    expect(alarmRecoveryCalls).toBe(1);
  });

  test("a replacement agent DO fences an orphan exact replay and rejects conflicting input", async () => {
    const harness = buildSessionHarness();
    const persisted = {
      ...agentTurn("agent-dispatch-lost-response"),
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "lease:agent-dispatch-lost-response",
      turnBrokerRoute: {
        sessionId: "thread-1",
        endpoint: "https://broker.example/sessions/thread-1/turn-broker",
      },
    };
    harness.values.set("turn", persisted);
    harness.values.set("turnId", persisted.turnId);
    let registrations = 0;
    harness.instance["registerTurn"] = async () => {
      registrations += 1;
      return "unexpected-generation";
    };
    const dispatch: Partial<typeof persisted> = { ...persisted };
    delete dispatch.ownerPurgeGeneration;
    delete dispatch.ownerPurgeLeaseId;
    const turnRequest = (body: unknown) =>
      new Request("https://build-session/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-build-session-name": "thread-1",
          "x-stella-turn-broker-endpoint":
            "https://broker.example/sessions/thread-1/turn-broker",
        },
        body: JSON.stringify(body),
      });

    const replay = await harness.instance.fetch(turnRequest(dispatch));
    expect(replay.status).toBe(425);
    expect(await replay.json()).toMatchObject({
      accepted: false,
      replayed: true,
      recoveryPending: true,
    });
    expect(registrations).toBe(0);
    expect(harness.values.get("turn")).toEqual(persisted);
    expect(harness.values.get("terminal")).toBe(true);
    expect(harness.values.get("pendingTerminal")).toMatchObject({
      turnId: persisted.turnId,
      kind: "failed",
      terminateSandbox: true,
    });
    expect(await harness.storage.getAlarm()).not.toBeNull();

    const conflict = await harness.instance.fetch(
      turnRequest({ ...dispatch, prompt: "different prompt" }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "Turn dispatch was replayed with different input.",
      turnId: persisted.turnId,
    });
    expect(registrations).toBe(0);
    expect(harness.values.get("turn")).toEqual(persisted);
  });

  test("owner purge does not acknowledge a running normal cloud turn before it joins", async () => {
    const harness = buildSessionHarness();
    const current = {
      ...turn("app-owner-purge-running"),
      appId: "app-1",
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "lease:app-owner-purge-running",
    };
    harness.values.set("turn", current);
    harness.values.set("terminal", false);
    let releaseSetup!: () => void;
    let observeSetup!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      observeSetup = resolve;
    });
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let lateWork = 0;
    harness.instance["runTurn"] = async (
      _turn: unknown,
      execution: { assertActive: () => void },
    ) => {
      observeSetup();
      await setupGate;
      execution.assertActive();
      lateWork += 1;
      return Response.json({ ok: true });
    };
    let observeDestroy!: () => void;
    const destroyed = new Promise<void>((resolve) => {
      observeDestroy = resolve;
    });
    let destroyCalls = 0;
    harness.instance["terminateCurrentAgentSandbox"] = async () => {
      destroyCalls += 1;
      observeDestroy();
    };
    harness.instance["cleanupTransientWrites"] = async () => undefined;
    harness.instance["callOwnerFence"] = async () =>
      Response.json({ ok: true });
    const appTurn = (
      harness.instance["startAppTurn"] as (
        turn: typeof current,
      ) => Promise<Response>
    )(current);
    const appOutcome = appTurn.then(
      () => null,
      (error: unknown) => error,
    );
    await setupStarted;

    let acknowledged = false;
    const purge = harness.instance
      .fetch(
        new Request("https://build-session/owner-purge-cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerId: current.ownerId,
            ownerGeneration: current.ownerGeneration,
            turnId: current.turnId,
            generation: current.ownerPurgeGeneration,
            leaseId: current.ownerPurgeLeaseId,
          }),
        }),
      )
      .then((response) => {
        acknowledged = true;
        return response;
      });
    await destroyed;
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    releaseSetup();

    const response = await purge;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: current.turnId,
      unregistered: true,
    });
    expect(await appOutcome).toBeInstanceOf(Error);
    expect(destroyCalls).toBe(2);
    expect(lateWork).toBe(0);
  });

  test("owner purge interrupts and joins orchestrator setup before unregistering", async () => {
    const harness = sessionHarness();
    const current = {
      ...turn("chat-owner-purge-setup"),
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "lease:chat-owner-purge-setup",
    };
    harness.values.set("turn", current);
    harness.values.set("terminal", false);
    harness.values.set(`ownerPurgeCancelAt:${current.ownerPurgeLeaseId}`, 0);
    let releaseSetup!: () => void;
    let observeSetup!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      observeSetup = resolve;
    });
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let lateProviderCalls = 0;
    let observeInterrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      observeInterrupt = resolve;
    });
    const execution = startTurnExecution({
      work: async ({ assertActive }) => {
        observeSetup();
        await setupGate;
        assertActive();
        lateProviderCalls += 1;
      },
      onInterrupt: observeInterrupt,
      cleanupTimeoutMs: 1_000,
    });
    (harness.instance["turnExecutions"] as Map<string, unknown>).set(
      current.turnId,
      execution,
    );
    harness.instance["callOwnerFence"] = async () =>
      Response.json({ ok: true });

    await setupStarted;
    let acknowledged = false;
    const purge = harness.instance
      .fetch(
        new Request("https://orchestrator-session/owner-purge-cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerId: current.ownerId,
            ownerGeneration: current.ownerGeneration,
            turnId: current.turnId,
            generation: current.ownerPurgeGeneration,
            leaseId: current.ownerPurgeLeaseId,
          }),
        }),
      )
      .then((response) => {
        acknowledged = true;
        return response;
      });
    await interrupted;
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    releaseSetup();

    const response = await purge;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: current.turnId,
      unregistered: true,
    });
    expect(lateProviderCalls).toBe(0);
  });

  test("the agent DO replays an acknowledged cancel without touching a newer turn", async () => {
    const harness = buildSessionHarness();
    const exact = request("agent-old");
    await harness.ledger.stage(exact);
    await harness.ledger.acknowledge(exact);
    const newer = agentTurn("agent-newer");
    harness.values.set("turn", newer);
    harness.values.set("turnId", newer.turnId);
    harness.values.set("terminal", false);

    const response = await harness.instance.fetch(cancelRequest(exact));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: exact.turnId,
      replayed: true,
    });
    expect(harness.terminated).toEqual([]);
    expect((harness.values.get("turn") as { turnId: string }).turnId).toBe(
      newer.turnId,
    );
  });

  test("a replacement agent DO reconciles a stopped current turn before acknowledging it", async () => {
    const values = new Map<string, unknown>();
    const beforeCrash = buildSessionHarness(values);
    const current = agentTurn("agent-crash-recovery");
    const exact = request(current.turnId);
    await beforeCrash.ledger.stage(exact);
    values.set("turn", current);
    values.set("turnId", current.turnId);
    values.set("terminal", true);
    values.set("terminalDelivered", true);
    values.set("pendingTerminal", {
      turnId: current.turnId,
      kind: "canceled",
      payload: { message: "Stopped. Nothing was changed." },
      threadError: "The agent was stopped.",
      terminateSandbox: false,
    });

    const replacement = buildSessionHarness(values);
    const response = await replacement.instance.fetch(cancelRequest(exact));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: current.turnId,
      joined: true,
    });
    expect(replacement.terminated).toEqual([]);
    expect(await replacement.ledger.matching(exact)).toMatchObject({
      state: "acknowledged",
    });
    expect(values.has("pendingTerminal")).toBe(false);
  });

  test("a joined agent cancel retains terminal delivery debt when its callback fails", async () => {
    const harness = buildSessionHarness();
    const current = agentTurn("agent-delivery-debt");
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);
    harness.instance["deliverTerminal"] = async () => false;

    const response = await harness.instance.fetch(
      cancelRequest(request(current.turnId)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      joined: true,
    });
    expect(
      await harness.ledger.matching(request(current.turnId)),
    ).toMatchObject({ state: "acknowledged" });
    expect(harness.values.get("pendingTerminal")).toMatchObject({
      turnId: current.turnId,
      kind: "canceled",
      terminateSandbox: false,
    });
  });

  test("a conflicting pause wakes an immutable pending terminal delivery", async () => {
    const harness = buildSessionHarness();
    const current = agentTurn("agent-terminal-delivery-wake");
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", true);
    harness.values.set("pendingTerminal", {
      turnId: current.turnId,
      attemptGeneration: current.attemptGeneration,
      kind: "failed",
      payload: { message: "Already failed." },
      threadError: "Already failed.",
    });
    const before = Date.now();

    const response = await harness.instance.fetch(
      cancelRequest(request(current.turnId)),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      canceled: false,
      reason: "terminal_already_decided",
      turnId: current.turnId,
    });
    const alarm = await harness.storage.getAlarm();
    expect(alarm).toBeGreaterThanOrEqual(before);
    expect(alarm).toBeLessThanOrEqual(Date.now());
    expect(harness.values.get("pendingTerminal")).toMatchObject({
      turnId: current.turnId,
      kind: "failed",
    });
  });

  test("a replacement alarm acknowledges delivered pre-cancel debt without aging it out", async () => {
    const values = new Map<string, unknown>();
    const beforeRestart = buildSessionHarness(values);
    const current = agentTurn("agent-alarm-reconcile");
    const exact = request(current.turnId);
    await beforeRestart.ledger.stage(exact);
    values.set("turn", current);
    values.set("turnId", current.turnId);
    values.set("terminal", true);
    values.set("terminalDelivered", false);
    values.set("pendingTerminal", {
      turnId: current.turnId,
      kind: "canceled",
      payload: { message: "Stopped. Nothing was changed." },
      threadError: "The agent was stopped.",
      terminateSandbox: false,
    });

    const replacement = buildSessionHarness(values);
    await (
      replacement.instance["runAlarm"] as (
        target: ReturnType<typeof agentTurn>,
      ) => Promise<void>
    )(current);
    expect(replacement.delivered).toEqual([current.turnId]);
    expect(await replacement.ledger.matching(exact)).toMatchObject({
      state: "acknowledged",
    });
    expect([...values.keys()]).toEqual([EXACT_TURN_CANCELLATIONS_KEY]);
  });

  test("an alarm cannot acknowledge while another exact run promise is live", async () => {
    const harness = buildSessionHarness();
    const exact = request("agent-alarm-live-run");
    const current = agentTurn(exact.turnId);
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    const staged = await harness.ledger.stage(exact);
    expect(staged).toMatchObject({ status: "staged" });
    if (!("cancellation" in staged)) throw new Error("stage failed");
    (
      harness.instance["runningTurns"] as Map<string, Set<Promise<unknown>>>
    ).set(exact.turnId, new Set([Promise.resolve(), Promise.resolve()]));

    expect(
      await (
        harness.instance["acknowledgeExactCancellationFromAlarm"] as (
          turn: typeof current,
          cancellation: typeof staged.cancellation,
        ) => Promise<boolean>
      )(current, staged.cancellation),
    ).toBe(false);
    expect(await harness.ledger.matching(exact)).toMatchObject({
      state: "pending",
    });
  });

  test("the agent DO consumes a durable pre-admission tombstone after restart", async () => {
    const values = new Map<string, unknown>();
    const beforeRestart = buildSessionHarness(values);
    const exact = request("agent-delayed");
    const staged = await beforeRestart.instance.fetch(cancelRequest(exact));
    expect(staged.status).toBe(202);
    expect(await staged.json()).toMatchObject({
      canceled: true,
      pending: true,
      durable: true,
    });

    const replacement = buildSessionHarness(values);
    const delayed = agentTurn(exact.turnId);
    const response = await (
      replacement.instance["acceptAgentTurn"] as (
        target: ReturnType<typeof agentTurn>,
      ) => Promise<Response>
    )(delayed);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      canceled: true,
      preAdmission: true,
      durable: true,
    });
    expect(replacement.runAgentTurnCalls()).toBe(0);
    expect(replacement.terminated).toEqual([]);
    expect(await replacement.ledger.matching(exact)).toMatchObject({
      state: "acknowledged",
    });
  });

  test("normal agent cleanup retains exact cancellation receipts across restart", async () => {
    const values = new Map<string, unknown>();
    const harness = buildSessionHarness(values);
    const exact = request("agent-cleanup");
    await harness.ledger.stage(exact);
    await harness.ledger.acknowledge(exact);
    values.set("turn", agentTurn("agent-cleanup"));
    values.set("turnId", "agent-cleanup");
    values.set("terminal", true);

    await (
      harness.instance[
        "deleteTurnStoragePreservingExactCancellations"
      ] as () => Promise<void>
    )();
    expect([...values.keys()]).toEqual([EXACT_TURN_CANCELLATIONS_KEY]);
    const replacement = buildSessionHarness(values);
    expect(await replacement.ledger.matching(exact)).toMatchObject({
      state: "acknowledged",
    });
  });

  test("the agent DO rejects stale generation and legacy Stop without side effects", async () => {
    const harness = buildSessionHarness();
    const current = agentTurn("agent-current", "generation-2");
    harness.values.set("turn", current);
    harness.values.set("turnId", current.turnId);
    harness.values.set("terminal", false);

    const stale = await harness.instance.fetch(
      cancelRequest(
        request(current.turnId, { ownerGeneration: "generation-1" }),
      ),
    );
    const legacy = await harness.instance.fetch(cancelRequest({}));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      canceled: false,
      reason: "stale_owner_generation",
    });
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toMatchObject({
      canceled: false,
      reason: "exact_turn_identity_required",
    });
    expect(harness.terminated).toEqual([]);
    expect(await harness.ledger.entriesForTest()).toEqual([]);
  });

  test("a stale local-turn generation is rejected before lease or journal admission", async () => {
    const harness = sessionHarness();
    const forcedLookups: boolean[] = [];
    let ownerRegistrations = 0;
    let journalWrites = 0;
    harness.instance["lookupOwner"] = async (force = false) => {
      forcedLookups.push(force);
      return {
        ownerId: "owner-1",
        ownerGeneration: "generation-2",
        createdAt: 1,
        title: "",
      };
    };
    harness.instance["ownerGeneration"] = "generation-2";
    harness.instance["journal"] = {
      ownerId: () => "owner-1",
      turnState: () => null,
      storedBytes: () => 0,
      upsertTurn: () => {
        journalWrites += 1;
      },
      appendMessage: () => {
        journalWrites += 1;
        return { seq: 1, inserted: true };
      },
      setTurnSpan: () => {
        journalWrites += 1;
      },
    };
    harness.instance["registerOwnerTurn"] = async () => {
      ownerRegistrations += 1;
      return "purge-generation-1";
    };

    const response = await (
      harness.instance["handleLocalTurnBegin"] as (
        request: Request,
      ) => Promise<Response>
    )(
      new Request("https://orchestrator-session/local-turns/begin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-owner": "owner-1",
          "x-stella-subject": "subject-1",
          "x-stella-token-exp": String(Date.now() + 60_000),
        },
        body: JSON.stringify({
          deviceId: "device-1",
          expectedOwnerGeneration: "generation-1",
          localTurnId: "turn-1",
          userMessageJson: JSON.stringify({
            role: "user",
            content: [{ type: "text", text: "must not be admitted" }],
            timestamp: Date.now(),
          }),
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "OWNER_DATA_GENERATION_STALE",
    });
    expect(forcedLookups).toEqual([true]);
    expect(ownerRegistrations).toBe(0);
    expect(journalWrites).toBe(0);
    expect(harness.values.has("localTurnLease")).toBe(false);
  });

  test("a stale voice generation is rejected before receipt replay or append work", async () => {
    const harness = sessionHarness();
    const forcedLookups: boolean[] = [];
    let receiptReads = 0;
    let appendWork = 0;
    harness.instance["lookupOwner"] = async (force = false) => {
      forcedLookups.push(force);
      return {
        ownerId: "owner-1",
        ownerGeneration: "generation-2",
        createdAt: 1,
        title: "",
      };
    };
    harness.instance["ownerGeneration"] = "generation-2";
    harness.instance["journal"] = {
      ownerId: () => "owner-1",
      appendReceipt: () => {
        receiptReads += 1;
        return null;
      },
      storedBytes: () => {
        appendWork += 1;
        return 0;
      },
      appendBudget: () => {
        appendWork += 1;
        return { allowed: true };
      },
    };

    const response = await (
      harness.instance["handleJournalAppend"] as (
        request: Request,
      ) => Promise<Response>
    )(
      new Request("https://orchestrator-session/journal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-owner": "owner-1",
        },
        body: JSON.stringify({
          deviceId: "device-1",
          expectedOwnerGeneration: "generation-1",
          localTurnId: "voice-1",
          source: "voice",
          records: [{ role: "user", payloadJson: "{}" }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "owner_generation_stale",
    });
    expect(forcedLookups).toEqual([true]);
    expect(receiptReads).toBe(0);
    expect(appendWork).toBe(0);
  });

  test("a null forced owner refresh cannot fall back to cached local or voice authority", async () => {
    const localHarness = sessionHarness();
    let localRegistrations = 0;
    localHarness.instance["lookupOwner"] = async () => null;
    localHarness.instance["ownerGeneration"] = "generation-1";
    localHarness.instance["journal"] = {
      ownerId: () => "owner-1",
    };
    localHarness.instance["registerOwnerTurn"] = async () => {
      localRegistrations += 1;
      return "purge-generation-1";
    };
    const localResponse = await (
      localHarness.instance["handleLocalTurnBegin"] as (
        request: Request,
      ) => Promise<Response>
    )(
      new Request("https://orchestrator-session/local-turns/begin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-owner": "owner-1",
          "x-stella-subject": "subject-1",
          "x-stella-token-exp": String(Date.now() + 60_000),
        },
        body: JSON.stringify({
          deviceId: "device-1",
          expectedOwnerGeneration: "generation-1",
          localTurnId: "turn-1",
          userMessageJson: JSON.stringify({ role: "user", content: [] }),
        }),
      }),
    );
    expect(localResponse.status).toBe(404);
    expect(localRegistrations).toBe(0);
    expect(localHarness.values.has("localTurnLease")).toBe(false);

    const voiceHarness = sessionHarness();
    let voiceReceiptReads = 0;
    voiceHarness.instance["lookupOwner"] = async () => null;
    voiceHarness.instance["ownerGeneration"] = "generation-1";
    voiceHarness.instance["journal"] = {
      ownerId: () => "owner-1",
      appendReceipt: () => {
        voiceReceiptReads += 1;
        return null;
      },
    };
    const voiceResponse = await (
      voiceHarness.instance["handleJournalAppend"] as (
        request: Request,
      ) => Promise<Response>
    )(
      new Request("https://orchestrator-session/journal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-owner": "owner-1",
        },
        body: JSON.stringify({
          deviceId: "device-1",
          expectedOwnerGeneration: "generation-1",
          localTurnId: "voice-1",
          source: "voice",
          records: [{ role: "user", payloadJson: "{}" }],
        }),
      }),
    );
    expect(voiceResponse.status).toBe(404);
    expect(voiceReceiptReads).toBe(0);
  });

  test("voice append holds and reasserts an owner fence before commit", async () => {
    const harness = sessionHarness();
    let registrations = 0;
    let assertions = 0;
    let unregisters = 0;
    let transactionCalls = 0;
    let oversizePrepared = false;
    harness.instance["lookupOwner"] = async () => ({
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      createdAt: 1,
      title: "",
    });
    harness.instance["journal"] = {
      ownerId: () => "owner-1",
      appendReceipt: () => null,
      storedBytes: () => 0,
      appendBudget: () => ({ allowed: true }),
      transactionSync: () => {
        transactionCalls += 1;
      },
    };
    harness.instance["turnRunning"] = async () => false;
    harness.instance["prepareOversize"] = async (
      _role: string,
      message: unknown,
      payloadJson: string,
    ) => {
      oversizePrepared = true;
      return { message, payloadJson };
    };
    harness.instance["registerOwnerTurn"] = async (
      lease: Record<string, unknown>,
    ) => {
      registrations += 1;
      lease.ownerPurgeLeaseId = "voice-lease-1";
      return "purge-generation-1";
    };
    harness.instance["assertOwnerTurn"] = async () => {
      assertions += 1;
      throw new Error("owner purge raced append preparation");
    };
    harness.instance["unregisterOwnerTurn"] = async () => {
      unregisters += 1;
    };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "openai-completions",
      provider: "stella",
      model: "voice",
      usage: {},
      stopReason: "stop",
      timestamp: 1,
    };

    const response = await (
      harness.instance["handleJournalAppend"] as (
        request: Request,
      ) => Promise<Response>
    )(
      new Request("https://orchestrator-session/journal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-owner": "owner-1",
        },
        body: JSON.stringify({
          deviceId: "device-1",
          expectedOwnerGeneration: "generation-1",
          localTurnId: "voice-fenced-1",
          source: "voice",
          records: [
            {
              kind: "message",
              role: "assistant",
              payloadJson: JSON.stringify(assistant),
            },
          ],
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "owner_purge" });
    expect(registrations).toBe(1);
    expect(oversizePrepared).toBe(true);
    expect(assertions).toBe(1);
    expect(transactionCalls).toBe(0);
    expect(unregisters).toBe(1);
  });

  test("owner purge joins an exact in-flight voice append before quiescence", async () => {
    const harness = sessionHarness();
    const lease = {
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      turnId: "voice:device-1:append-1",
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "voice-lease-1",
    };
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    (
      harness.instance["ownerFencedAppends"] as Map<
        string,
        { lease: typeof lease; settled: Promise<void> }
      >
    ).set(lease.ownerPurgeLeaseId, { lease, settled });
    let fenceUnregisters = 0;
    harness.instance["callOwnerFence"] = async () => {
      fenceUnregisters += 1;
      return Response.json({ ok: true });
    };
    let acknowledged = false;
    const responsePromise = harness.instance
      .fetch(
        new Request("https://orchestrator-session/owner-purge-cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerId: lease.ownerId,
            ownerGeneration: lease.ownerGeneration,
            turnId: lease.turnId,
            generation: lease.ownerPurgeGeneration,
            leaseId: lease.ownerPurgeLeaseId,
          }),
        }),
      )
      .then((response) => {
        acknowledged = true;
        return response;
      });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(fenceUnregisters).toBe(0);

    settle();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: lease.turnId,
      unregistered: true,
      voice: true,
    });
    expect(fenceUnregisters).toBe(1);
  });

  test("overlapping voice retries remain independently joinable by exact lease id", async () => {
    const harness = sessionHarness();
    const firstLease = {
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      turnId: "voice:device-1:append-retry",
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "voice-lease-first",
    };
    const secondLease = {
      ...firstLease,
      ownerPurgeLeaseId: "voice-lease-second",
    };
    let settleFirst!: () => void;
    let settleSecond!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      settleFirst = resolve;
    });
    const secondSettled = new Promise<void>((resolve) => {
      settleSecond = resolve;
    });
    const active = harness.instance["ownerFencedAppends"] as Map<
      string,
      { lease: typeof firstLease; settled: Promise<void> }
    >;
    active.set(firstLease.ownerPurgeLeaseId, {
      lease: firstLease,
      settled: firstSettled,
    });
    active.set(secondLease.ownerPurgeLeaseId, {
      lease: secondLease,
      settled: secondSettled,
    });
    const unregisteredLeaseIds: string[] = [];
    harness.instance["callOwnerFence"] = async (
      _ownerId: string,
      path: string,
      body: { leaseId?: string },
    ) => {
      if (path === "unregister" && body.leaseId) {
        unregisteredLeaseIds.push(body.leaseId);
      }
      return Response.json({ ok: true });
    };
    const purge = (lease: typeof firstLease) =>
      harness.instance.fetch(
        new Request("https://orchestrator-session/owner-purge-cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerId: lease.ownerId,
            ownerGeneration: lease.ownerGeneration,
            turnId: lease.turnId,
            generation: lease.ownerPurgeGeneration,
            leaseId: lease.ownerPurgeLeaseId,
          }),
        }),
      );

    let firstAcknowledged = false;
    const firstPurge = purge(firstLease).then((response) => {
      firstAcknowledged = true;
      return response;
    });
    await Promise.resolve();
    settleSecond();
    await Promise.resolve();
    await Promise.resolve();
    expect(firstAcknowledged).toBe(false);
    expect(unregisteredLeaseIds).toEqual([]);

    settleFirst();
    const firstResponse = await firstPurge;
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toMatchObject({
      canceled: true,
      voice: true,
      unregistered: true,
    });
    expect(unregisteredLeaseIds).toEqual([firstLease.ownerPurgeLeaseId]);
  });

  test("owner purge retains a local lease until heartbeat ACK or the bounded grace retires it", async () => {
    const harness = sessionHarness();
    const turnId = "desktop:device-1:local-turn-1";
    const lease = {
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      turnId,
      deviceId: "device-1",
      localTurnId: "local-turn-1",
      leaseToken: "a".repeat(64),
      expiresAt: Date.now() + 30 * 60_000,
      beginFingerprint: "begin-fingerprint-1",
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "purge-lease-1",
    };
    harness.values.set("localTurnLease", lease);
    let unregisterCalls = 0;
    let ownerFenceUnregisters = 0;
    let terminalPhase: string | null = null;
    harness.instance["journal"] = {
      ownerId: () => lease.ownerId,
      turnState: () =>
        terminalPhase
          ? { state: "terminal", terminal_kind: terminalPhase }
          : null,
      head: () => ({ headSeq: 0 }),
      appendTurn: () => ({ seq: 1, record: undefined }),
      setTurnSpan: () => undefined,
      setTurnTerminal: (_turnId: string, phase: string) => {
        terminalPhase = phase;
      },
      meta: () => ({ epoch: 1 }),
      isDeleted: () => false,
    };
    harness.instance["lookupOwner"] = async () => ({
      ownerId: lease.ownerId,
      ownerGeneration: lease.ownerGeneration,
      createdAt: 1,
      title: "",
    });
    harness.instance["hub"] = { endTurn: () => undefined };
    harness.instance["index"] = { flush: async () => undefined };
    harness.instance["archive"] = { maybeRollover: async () => undefined };
    harness.instance["recordExcerpt"] = () => undefined;
    harness.instance["drainInbox"] = () => undefined;
    harness.instance["unregisterOwnerTurn"] = async () => {
      unregisterCalls += 1;
    };
    harness.instance["callOwnerFence"] = async () => {
      ownerFenceUnregisters += 1;
      return Response.json({ ok: true });
    };
    const purgeRequest = () =>
      new Request("https://orchestrator-session/owner-purge-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerId: lease.ownerId,
          ownerGeneration: lease.ownerGeneration,
          turnId: lease.turnId,
          generation: lease.ownerPurgeGeneration,
          leaseId: lease.ownerPurgeLeaseId,
        }),
      });

    const beforeCancel = Date.now();
    const waiting = await harness.instance.fetch(purgeRequest());
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toMatchObject({ retryAfterMs: 1_000 });
    expect(harness.values.get("localTurnLease")).toMatchObject({
      turnId,
      leaseToken: lease.leaseToken,
      cancelRequested: true,
    });
    expect(await harness.storage.getAlarm()).toBeGreaterThanOrEqual(
      beforeCancel + 44_000,
    );
    expect(unregisterCalls).toBe(0);
    expect(ownerFenceUnregisters).toBe(0);

    const lateHeartbeat = await (
      harness.instance["handleLocalTurnBegin"] as (
        request: Request,
      ) => Promise<Response>
    )(
      new Request("https://orchestrator-session/local-turns/begin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-owner": lease.ownerId,
          "x-stella-subject": "subject-1",
          "x-stella-token-exp": String(Date.now() + 60_000),
        },
        body: JSON.stringify({
          deviceId: lease.deviceId,
          expectedOwnerGeneration: lease.ownerGeneration,
          localTurnId: lease.localTurnId,
          leaseToken: lease.leaseToken,
          renewOnly: true,
        }),
      }),
    );
    expect(lateHeartbeat.status).toBe(409);
    expect(await lateHeartbeat.json()).toMatchObject({
      code: "turn_finished",
      phase: "canceled",
    });
    expect(harness.values.has("localTurnLease")).toBe(true);

    // An unrelated/pre-existing early alarm cannot shorten the persisted
    // 45-second desktop heartbeat/finish-ACK deadline.
    await harness.instance.alarm();
    expect(harness.values.has("localTurnLease")).toBe(true);
    expect(unregisterCalls).toBe(0);

    // Simulate the persisted deadline elapsing, then fire the alarm again.
    // Only this post-deadline firing may force-retire the lease.
    const canceledLease = harness.values.get(
      "localTurnLease",
    ) as typeof lease & {
      cancelRequested: true;
      cancelDeadlineAt: number;
    };
    harness.values.set("localTurnLease", {
      ...canceledLease,
      cancelDeadlineAt: Date.now() - 1,
    });
    await harness.instance.alarm();
    expect(harness.values.has("localTurnLease")).toBe(false);
    expect(unregisterCalls).toBe(1);

    // If the first successful response is lost, an exact retry uses the
    // durable canceled receipt and does not touch a replacement turn.
    const replay = await harness.instance.fetch(purgeRequest());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      canceled: true,
      turnId,
      unregistered: true,
      local: true,
    });
    expect(ownerFenceUnregisters).toBe(1);
  });

  test("a stale owner-purge ABA request cannot abort or delete newer work", async () => {
    const harness = sessionHarness();
    const replacement = {
      ...turn("same-turn-id", "generation-2"),
      ownerPurgeGeneration: "purge-generation-2",
      ownerPurgeLeaseId: "purge-lease-2",
    };
    const queued = {
      ...turn("queued-new", "generation-2"),
      ownerPurgeGeneration: "purge-generation-2",
      ownerPurgeLeaseId: "queued-lease-2",
    };
    harness.values.set("turn", replacement);
    harness.values.set("terminal", false);
    harness.values.set(`queued:${queued.turnId}`, queued);
    let turnAborts = 0;
    let agentAborts = 0;
    let unregisters = 0;
    harness.instance["currentTurnCancellation"] = {
      abort: () => {
        turnAborts += 1;
      },
    };
    harness.instance["currentAgent"] = {
      abort: () => {
        agentAborts += 1;
      },
    };
    harness.instance["unregisterOwnerTurn"] = async () => {
      unregisters += 1;
    };

    const stale = await harness.instance.fetch(
      new Request("https://orchestrator-session/owner-purge-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerId: replacement.ownerId,
          ownerGeneration: "generation-1",
          turnId: replacement.turnId,
          generation: "purge-generation-1",
          leaseId: "purge-lease-1",
        }),
      }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "Owner purge lease identity is stale.",
    });
    expect(turnAborts).toBe(0);
    expect(agentAborts).toBe(0);
    expect(unregisters).toBe(0);
    expect(harness.values.get("terminal")).toBe(false);
    expect(harness.values.get(`queued:${queued.turnId}`)).toEqual(queued);
    expect(harness.values.get("turn")).toEqual(replacement);
  });

  test("cold restore preserves the cancellation deadline instead of the older provider expiry", async () => {
    const harness = sessionHarness();
    const now = Date.now();
    const canceledLease = {
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      turnId: "desktop:device-1:local-1",
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "purge-lease-1",
      deviceId: "device-1",
      localTurnId: "local-1",
      leaseToken: "a".repeat(64),
      expiresAt: now + 30 * 60_000,
      beginFingerprint: "begin-1",
      cancelRequested: true,
      cancelDeadlineAt: now + 45_000,
    };
    harness.values.set("localTurnLease", canceledLease);
    await harness.storage.setAlarm(canceledLease.expiresAt);

    await (
      harness.instance["restoreLocalLease"] as (
        lease: typeof canceledLease,
      ) => Promise<void>
    )(structuredClone(canceledLease));

    expect(await harness.storage.getAlarm()).toBe(
      canceledLease.cancelDeadlineAt,
    );
    expect(harness.values.get("localTurnLease")).toEqual(canceledLease);

    const migrated = {
      ...canceledLease,
      turnId: "desktop:device-1:legacy",
      localTurnId: "legacy",
      cancelDeadlineAt: undefined,
    };
    harness.values.set("localTurnLease", migrated);
    await harness.storage.setAlarm(migrated.expiresAt);
    const beforeRestore = Date.now();
    await (
      harness.instance["restoreLocalLease"] as (
        lease: typeof migrated,
      ) => Promise<void>
    )(structuredClone(migrated));
    const restored = harness.values.get("localTurnLease") as typeof migrated & {
      cancelDeadlineAt: number;
    };
    expect(restored.cancelDeadlineAt).toBeGreaterThanOrEqual(
      beforeRestore + 44_000,
    );
    expect(await harness.storage.getAlarm()).toBe(restored.cancelDeadlineAt);
  });

  test("renewal and exact begin replay cannot retire a canceled lease before its grace deadline", async () => {
    const harness = sessionHarness();
    const userMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "same message" }],
      timestamp: Date.now(),
    };
    const lease = {
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      turnId: "desktop:device-1:local-1",
      ownerPurgeGeneration: "purge-generation-1",
      ownerPurgeLeaseId: "purge-lease-1",
      deviceId: "device-1",
      localTurnId: "local-1",
      leaseToken: "b".repeat(64),
      expiresAt: Date.now() - 1,
      beginFingerprint: await sha256Hex(
        localClientMessageFingerprintSource("", userMessage),
      ),
      cancelRequested: true,
      cancelDeadlineAt: Date.now() + 45_000,
    };
    harness.values.set("localTurnLease", lease);
    let retirements = 0;
    let unregisters = 0;
    harness.instance["lookupOwner"] = async () => ({
      ownerId: lease.ownerId,
      ownerGeneration: lease.ownerGeneration,
      createdAt: 1,
      title: "",
    });
    harness.instance["ownerGeneration"] = lease.ownerGeneration;
    harness.instance["journal"] = {
      ownerId: () => lease.ownerId,
      turnState: () => null,
    };
    harness.instance["expireLocalLease"] = async () => {
      retirements += 1;
    };
    harness.instance["cancelLocalTurn"] = async () => {
      retirements += 1;
      return true;
    };
    harness.instance["unregisterOwnerTurn"] = async () => {
      unregisters += 1;
    };

    const renewal = await (
      harness.instance["handleLocalTurnRenewal"] as (
        renewal: {
          deviceId: string;
          expectedOwnerGeneration: string;
          localTurnId: string;
          leaseToken: string;
        },
        ownerId: string,
      ) => Promise<Response>
    )(
      {
        deviceId: lease.deviceId,
        expectedOwnerGeneration: lease.ownerGeneration,
        localTurnId: lease.localTurnId,
        leaseToken: lease.leaseToken,
      },
      lease.ownerId,
    );
    expect(renewal.status).toBe(409);
    expect(await renewal.json()).toMatchObject({ code: "turn_finished" });

    const replay = await (
      harness.instance["handleLocalTurnBegin"] as (
        request: Request,
      ) => Promise<Response>
    )(
      new Request("https://orchestrator-session/local-turns/begin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-owner": lease.ownerId,
          "x-stella-subject": "subject-1",
          "x-stella-token-exp": String(Date.now() + 60_000),
        },
        body: JSON.stringify({
          deviceId: lease.deviceId,
          expectedOwnerGeneration: lease.ownerGeneration,
          localTurnId: lease.localTurnId,
          userMessageJson: JSON.stringify(userMessage),
        }),
      }),
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "turn_finished" });
    expect(retirements).toBe(0);
    expect(unregisters).toBe(0);
    expect(harness.values.get("localTurnLease")).toEqual(lease);
  });

  test("lost turn admission responses replay exact durable identity without a second owner lease", async () => {
    const values = new Map<string, unknown>();
    const original = turn("turn-lost-response");
    let registrations = 0;
    let enqueues = 0;
    const configure = (harness: ReturnType<typeof sessionHarness>) => {
      harness.instance["registerOwnerTurn"] = async (target: {
        ownerPurgeLeaseId?: string;
      }) => {
        registrations += 1;
        target.ownerPurgeLeaseId ??= `lease-${registrations}`;
        return `purge-generation-${registrations}`;
      };
      harness.instance["enqueue"] = () => {
        enqueues += 1;
      };
    };
    const dispatch = (body: unknown) =>
      new Request("https://orchestrator-session/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const first = sessionHarness(values);
    configure(first);
    const accepted = await first.instance.fetch(dispatch(original));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      accepted: true,
      replayed: false,
    });
    expect(registrations).toBe(1);
    expect(enqueues).toBe(1);
    const queuedKey = `queued:${original.turnId}`;
    const queued = structuredClone(values.get(queuedKey));

    const replacement = sessionHarness(values);
    configure(replacement);
    const replay = await replacement.instance.fetch(dispatch(original));
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ accepted: true, replayed: true });
    expect(registrations).toBe(1);
    expect(enqueues).toBe(1);
    expect(values.get(queuedKey)).toEqual(queued);

    const conflict = await replacement.instance.fetch(
      dispatch({ ...original, prompt: "changed payload" }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "idempotency_conflict",
    });
    expect(registrations).toBe(1);
    expect(values.get(queuedKey)).toEqual(queued);

    // Rolling-deploy/lost-response recovery also classifies an exact request
    // after the durable queue row has moved to the current-turn slot.
    values.set("turn", queued);
    values.delete(queuedKey);
    values.delete(`chatTurnAdmission:${original.turnId}`);
    const currentReplacement = sessionHarness(values);
    configure(currentReplacement);
    const currentReplay = await currentReplacement.instance.fetch(
      dispatch(original),
    );
    expect(currentReplay.status).toBe(202);
    expect(await currentReplay.json()).toEqual({
      accepted: true,
      replayed: true,
    });
    expect(registrations).toBe(1);
    expect(enqueues).toBe(1);
    expect(values.get("turn")).toEqual(queued);
  });

  test("agent lifecycle wake receipts are validated and bound into exact turn replay", async () => {
    const values = new Map<string, unknown>();
    const lifecycleTurn = {
      ...turn("turn-agent-lifecycle-receipt"),
      source: "agent-thread",
      agentThreadControl: {
        threadId: "thread-control-1",
        attemptGeneration: 3,
        threadUpdatedAt: 300,
        status: "completed" as const,
      },
    };
    const dispatch = (body: unknown) =>
      new Request("https://orchestrator-session/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = sessionHarness(values);
    first.instance["enqueue"] = () => undefined;
    const accepted = await first.instance.fetch(dispatch(lifecycleTurn));
    expect(accepted.status).toBe(202);

    const restarted = sessionHarness(values);
    restarted.instance["enqueue"] = () => undefined;
    const replay = await restarted.instance.fetch(dispatch(lifecycleTurn));
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ accepted: true, replayed: true });

    const changedReceipt = await restarted.instance.fetch(
      dispatch({
        ...lifecycleTurn,
        agentThreadControl: {
          ...lifecycleTurn.agentThreadControl,
          threadUpdatedAt: 301,
        },
      }),
    );
    expect(changedReceipt.status).toBe(409);
    expect(await changedReceipt.json()).toMatchObject({
      code: "idempotency_conflict",
    });

    const wrongSource = sessionHarness();
    wrongSource.instance["enqueue"] = () => undefined;
    const rejected = await wrongSource.instance.fetch(
      dispatch({ ...lifecycleTurn, source: "user" }),
    );
    expect(rejected.status).toBe(400);
  });

  test("server-issued terminal receipts survive restart and fence send_input ABA", async () => {
    const values = new Map<string, unknown>();
    const first = sessionHarness(values);
    await (
      first.instance["rememberCloudAgentControlReceipt"] as (
        value: unknown,
      ) => Promise<unknown>
    )({
      threadId: "thread-control-1",
      attemptGeneration: 3,
      threadUpdatedAt: 300,
      status: "completed",
    });

    const restarted = sessionHarness(values);
    const requests: Array<Record<string, unknown>> = [];
    restarted.instance["convexPost"] = async (
      _base: string,
      _path: string,
      body: Record<string, unknown>,
    ) => {
      requests.push(structuredClone(body));
      return Response.json({
        ok: true,
        threadId: "thread-control-1",
        turnId: "agent-turn-4",
        attemptGeneration: 4,
        threadUpdatedAt: 400,
        status: "running",
      });
    };
    const parentTurn = turn("turn-send-input-control");
    const sendInput = cloudAgentTool(
      restarted.instance,
      parentTurn,
      "send_input",
    );
    const delivered = await sendInput.execute("tool-send-normal", {
      thread_id: "thread-control-1",
      description: "Continue the audit",
      message: "Continue from the last result.",
    });
    expect(requests[0]).toMatchObject({
      action: "spawn",
      threadId: "thread-control-1",
      expectedAttemptGeneration: 3,
      expectedThreadUpdatedAt: 300,
    });
    expect(delivered.details).toMatchObject({
      thread_id: "thread-control-1",
      attempt_generation: 4,
      thread_updated_at: 400,
    });
    expect(values.get("cloudAgentControl:thread-control-1")).toEqual({
      threadId: "thread-control-1",
      attemptGeneration: 4,
      threadUpdatedAt: 400,
      status: "running",
    });

    const responseLostRestart = sessionHarness(values);
    responseLostRestart.instance["convexPost"] = async () => {
      throw new Error("an acknowledged tool outcome must not hit the network");
    };
    const replayedSendInput = cloudAgentTool(
      responseLostRestart.instance,
      parentTurn,
      "send_input",
    );
    const replayedDelivery = await replayedSendInput.execute(
      "tool-send-normal",
      {
        thread_id: "thread-control-1",
        description: "Continue the audit",
        message: "Continue from the last result.",
      },
    );
    expect(replayedDelivery.details).toEqual(delivered.details);

    await (
      restarted.instance["rememberCloudAgentControlReceipt"] as (
        value: unknown,
      ) => Promise<unknown>
    )({
      threadId: "thread-control-1",
      attemptGeneration: 4,
      threadUpdatedAt: 450,
      status: "completed",
    });
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let requestObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      requestObserved = resolve;
    });
    restarted.instance["convexPost"] = async (
      _base: string,
      _path: string,
      body: Record<string, unknown>,
    ) => {
      requests.push(structuredClone(body));
      requestObserved();
      await responseGate;
      return Response.json(
        { ok: false, error: "That cloud thread changed." },
        { status: 409 },
      );
    };
    const staleContinuation = sendInput.execute("tool-send-stale", {
      thread_id: "thread-control-1",
      description: "Stale continuation",
      message: "This must not bind to the successor.",
    });
    await observed;
    await (
      restarted.instance["rememberCloudAgentControlReceipt"] as (
        value: unknown,
      ) => Promise<unknown>
    )({
      threadId: "thread-control-1",
      attemptGeneration: 5,
      threadUpdatedAt: 500,
      status: "running",
    });
    releaseResponse();
    await expect(staleContinuation).rejects.toThrow(
      "That cloud thread changed.",
    );
    expect(requests[1]).toMatchObject({
      action: "spawn",
      threadId: "thread-control-1",
      expectedAttemptGeneration: 4,
      expectedThreadUpdatedAt: 450,
    });
    expect(values.get("cloudAgentControl:thread-control-1")).toEqual({
      threadId: "thread-control-1",
      attemptGeneration: 5,
      threadUpdatedAt: 500,
      status: "running",
    });
  });

  test("spawn_agent replays its durable tool outcome without a second admission", async () => {
    const values = new Map<string, unknown>();
    const parentTurn = turn("turn-spawn-outcome");
    const first = sessionHarness(values);
    let admissions = 0;
    first.instance["convexPost"] = async () => {
      admissions += 1;
      return Response.json({
        ok: true,
        threadId: "thread-spawn-outcome",
        turnId: "agent-turn-spawn-outcome",
        attemptGeneration: 1,
        threadUpdatedAt: 100,
        status: "running",
      });
    };
    const spawn = cloudAgentTool(first.instance, parentTurn, "spawn_agent");
    const params = {
      description: "Audit the boundary",
      prompt: "Inspect it carefully.",
      workspace: "cloud",
    };
    const original = await spawn.execute("tool-spawn-outcome", params);
    expect(admissions).toBe(1);

    const restarted = sessionHarness(values);
    restarted.instance["convexPost"] = async () => {
      throw new Error("durable spawn replay must not hit the network");
    };
    const replay = cloudAgentTool(
      restarted.instance,
      parentTurn,
      "spawn_agent",
    );
    expect(await replay.execute("tool-spawn-outcome", params)).toEqual(
      original,
    );
    await expect(
      replay.execute("tool-spawn-outcome", {
        ...params,
        prompt: "Changed after the fact.",
      }),
    ).rejects.toThrow("replayed differently");
    expect(admissions).toBe(1);
  });

  test("an equal-clock terminal receipt advances running state and enables continuation", async () => {
    const harness = sessionHarness();
    const remember = (
      harness.instance["rememberCloudAgentControlReceipt"] as (
        value: unknown,
      ) => Promise<unknown>
    ).bind(harness.instance);
    await remember({
      threadId: "thread-equal-clock",
      attemptGeneration: 1,
      threadUpdatedAt: 100,
      status: "running",
    });
    await remember({
      threadId: "thread-equal-clock",
      attemptGeneration: 1,
      threadUpdatedAt: 100,
      status: "completed",
    });
    // A delayed running receipt, even with a later wall-clock value, cannot
    // resurrect the already-terminal logical attempt.
    await remember({
      threadId: "thread-equal-clock",
      attemptGeneration: 1,
      threadUpdatedAt: 101,
      status: "running",
    });
    let continuationBody: Record<string, unknown> | undefined;
    harness.instance["convexPost"] = async (
      _base: string,
      _path: string,
      body: Record<string, unknown>,
    ) => {
      continuationBody = structuredClone(body);
      return Response.json({
        ok: true,
        threadId: "thread-equal-clock",
        turnId: "agent-turn-equal-clock-2",
        attemptGeneration: 2,
        threadUpdatedAt: 200,
        status: "running",
      });
    };
    const sendInput = cloudAgentTool(
      harness.instance,
      turn("turn-equal-clock"),
      "send_input",
    );
    await sendInput.execute("tool-equal-clock", {
      thread_id: "thread-equal-clock",
      description: "Continue after completion",
      message: "Continue.",
    });
    expect(continuationBody).toMatchObject({
      expectedAttemptGeneration: 1,
      expectedThreadUpdatedAt: 100,
    });
  });

  test("pause uses one exact receipt through builder teardown and cancel ACK", async () => {
    const harness = sessionHarness();
    await (
      harness.instance["rememberCloudAgentControlReceipt"] as (
        value: unknown,
      ) => Promise<unknown>
    )({
      threadId: "thread-pause-1",
      attemptGeneration: 7,
      threadUpdatedAt: 700,
      status: "running",
    });
    const controlBodies: Array<Record<string, unknown>> = [];
    const teardownBodies: Array<Record<string, unknown>> = [];
    let cancelCalls = 0;
    harness.instance["env"] = {
      BUILD_SESSIONS: {
        getByName: (threadId: string) => ({
          fetch: async (_url: string, init: RequestInit) => {
            expect(threadId).toBe("thread-pause-1");
            teardownBodies.push(JSON.parse(String(init.body)));
            return Response.json({ canceled: true, joined: true });
          },
        }),
      },
    };
    harness.instance["convexPost"] = async (
      _base: string,
      _path: string,
      body: Record<string, unknown>,
    ) => {
      controlBodies.push(structuredClone(body));
      if (body.action === "cancel") {
        cancelCalls += 1;
        if (cancelCalls > 1) {
          return Response.json({
            ok: true,
            threadId: "thread-pause-1",
            status: "canceled",
            attemptGeneration: 7,
            threadUpdatedAt: 800,
            alreadyCanceled: true,
            currentControl: {
              threadId: "thread-pause-1",
              status: "canceled",
              attemptGeneration: 7,
              threadUpdatedAt: 800,
            },
          });
        }
        return Response.json({
          ok: true,
          threadId: "thread-pause-1",
          status: "running",
          turnId: "agent-turn-7",
          attemptGeneration: 7,
          threadUpdatedAt: 700,
          alreadyCanceled: false,
          currentControl: {
            threadId: "thread-pause-1",
            status: "running",
            attemptGeneration: 7,
            threadUpdatedAt: 700,
          },
        });
      }
      return Response.json({
        ok: true,
        canceled: true,
        threadId: "thread-pause-1",
        status: "canceled",
        attemptGeneration: 7,
        threadUpdatedAt: 750,
        currentControl: {
          threadId: "thread-pause-1",
          status: "canceled",
          attemptGeneration: 7,
          threadUpdatedAt: 800,
        },
      });
    };
    const pause = cloudAgentTool(
      harness.instance,
      turn("turn-pause-control"),
      "pause_agent",
    );
    const result = await pause.execute("tool-pause-normal", {
      thread_id: "thread-pause-1",
    });
    expect(controlBodies[0]).toMatchObject({
      action: "cancel",
      threadId: "thread-pause-1",
      expectedAttemptGeneration: 7,
      expectedThreadUpdatedAt: 700,
    });
    expect(teardownBodies[0]).toMatchObject({
      turnId: "agent-turn-7",
      attemptGeneration: 7,
    });
    expect(controlBodies[1]).toMatchObject({
      action: "cancel_ack",
      threadId: "thread-pause-1",
      turnId: "agent-turn-7",
      attemptGeneration: 7,
    });
    expect(result.details).toMatchObject({
      thread_id: "thread-pause-1",
      attempt_generation: 7,
      thread_updated_at: 800,
    });
    expect(harness.values.get("cloudAgentControl:thread-pause-1")).toEqual({
      threadId: "thread-pause-1",
      attemptGeneration: 7,
      threadUpdatedAt: 800,
      status: "canceled",
    });

    const replayed = await pause.execute("tool-pause-normal", {
      thread_id: "thread-pause-1",
    });
    expect(replayed.details).toEqual(result.details);
    expect(teardownBodies).toHaveLength(1);
    expect(controlBodies).toHaveLength(2);

    await (
      harness.instance["rememberCloudAgentControlReceipt"] as (
        value: unknown,
      ) => Promise<unknown>
    )({
      threadId: "thread-pause-1",
      attemptGeneration: 8,
      threadUpdatedAt: 900,
      status: "running",
    });
    let staleTeardownCalls = 0;
    harness.instance["env"] = {
      BUILD_SESSIONS: {
        getByName: () => ({
          fetch: async () => {
            staleTeardownCalls += 1;
            return Response.json({ canceled: true });
          },
        }),
      },
    };
    const staleBodies: Array<Record<string, unknown>> = [];
    harness.instance["convexPost"] = async (
      _base: string,
      _path: string,
      body: Record<string, unknown>,
    ) => {
      staleBodies.push(structuredClone(body));
      return Response.json({
        ok: true,
        threadId: "thread-pause-1",
        status: "running",
        attemptGeneration: 9,
        threadUpdatedAt: 1_000,
        alreadyCanceled: true,
        currentControl: {
          threadId: "thread-pause-1",
          status: "running",
          attemptGeneration: 9,
          threadUpdatedAt: 1_000,
        },
      });
    };
    await expect(
      pause.execute("tool-pause-stale", {
        thread_id: "thread-pause-1",
      }),
    ).rejects.toThrow("was continued while it was being paused");
    expect(staleBodies).toHaveLength(1);
    expect(staleBodies[0]).toMatchObject({
      action: "cancel",
      expectedAttemptGeneration: 8,
      expectedThreadUpdatedAt: 900,
    });
    expect(staleTeardownCalls).toBe(0);
    expect(harness.values.get("cloudAgentControl:thread-pause-1")).toEqual({
      threadId: "thread-pause-1",
      attemptGeneration: 9,
      threadUpdatedAt: 1_000,
      status: "running",
    });

    let ackRaceTeardowns = 0;
    harness.instance["env"] = {
      BUILD_SESSIONS: {
        getByName: () => ({
          fetch: async (_url: string, init: RequestInit) => {
            ackRaceTeardowns += 1;
            expect(JSON.parse(String(init.body))).toMatchObject({
              turnId: "agent-turn-9",
              attemptGeneration: 9,
            });
            return Response.json({ canceled: true, joined: true });
          },
        }),
      },
    };
    const ackRaceBodies: Array<Record<string, unknown>> = [];
    harness.instance["convexPost"] = async (
      _base: string,
      _path: string,
      body: Record<string, unknown>,
    ) => {
      ackRaceBodies.push(structuredClone(body));
      if (body.action === "cancel") {
        return Response.json({
          ok: true,
          threadId: "thread-pause-1",
          status: "running",
          turnId: "agent-turn-9",
          attemptGeneration: 9,
          threadUpdatedAt: 1_000,
          alreadyCanceled: false,
          currentControl: {
            threadId: "thread-pause-1",
            status: "running",
            attemptGeneration: 9,
            threadUpdatedAt: 1_000,
          },
        });
      }
      return Response.json({
        ok: true,
        canceled: true,
        threadId: "thread-pause-1",
        status: "canceled",
        attemptGeneration: 9,
        threadUpdatedAt: 1_050,
        currentControl: {
          threadId: "thread-pause-1",
          status: "running",
          attemptGeneration: 10,
          threadUpdatedAt: 1_100,
        },
      });
    };
    await expect(
      pause.execute("tool-pause-ack-race", {
        thread_id: "thread-pause-1",
      }),
    ).rejects.toThrow("was continued while it was being paused");
    expect(ackRaceTeardowns).toBe(1);
    expect(ackRaceBodies).toHaveLength(2);
    expect(ackRaceBodies[1]).toMatchObject({
      action: "cancel_ack",
      turnId: "agent-turn-9",
      attemptGeneration: 9,
    });
    expect(harness.values.get("cloudAgentControl:thread-pause-1")).toEqual({
      threadId: "thread-pause-1",
      attemptGeneration: 10,
      threadUpdatedAt: 1_100,
      status: "running",
    });
  });

  test("chat event replay and restart bind service auth to the immutable turn-token hash", async () => {
    const originalFetch = globalThis.fetch;
    const callbackBodies: Array<Record<string, unknown>> = [];
    let loseFirstResponse = true;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      callbackBodies.push(JSON.parse(String(init?.body)));
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("response lost");
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const immutableTurn = turn("turn-token-rotation");
      immutableTurn.turnToken = "turn-token-generation-1";
      const first = sessionHarness();
      delete first.instance["event"];
      await expect(
        (
          first.instance["event"] as (
            target: typeof immutableTurn,
            seq: number,
            kind: string,
            payload: unknown,
            terminal: boolean,
          ) => Promise<void>
        )(immutableTurn, 1, "started", { ok: true }, false),
      ).rejects.toThrow("response lost");

      const restarted = sessionHarness();
      delete restarted.instance["event"];
      await (
        restarted.instance["event"] as (
          target: typeof immutableTurn,
          seq: number,
          kind: string,
          payload: unknown,
          terminal: boolean,
        ) => Promise<void>
      )(immutableTurn, 1, "started", { ok: true }, false);

      const rotated = {
        ...immutableTurn,
        turnToken: "turn-token-generation-2",
      };
      await (
        restarted.instance["event"] as (
          target: typeof rotated,
          seq: number,
          kind: string,
          payload: unknown,
          terminal: boolean,
        ) => Promise<void>
      )(rotated, 2, "completed", { ok: true }, true);

      const generationOneHash = await sha256Hex(immutableTurn.turnToken);
      const generationTwoHash = await sha256Hex(rotated.turnToken);
      expect(callbackBodies).toHaveLength(3);
      expect(callbackBodies[0]?.tokenHash).toBe(generationOneHash);
      expect(callbackBodies[1]?.tokenHash).toBe(generationOneHash);
      expect(callbackBodies[2]?.tokenHash).toBe(generationTwoHash);
      expect(generationTwoHash).not.toBe(generationOneHash);
      expect(callbackBodies.every((body) => body.turnToken === undefined)).toBe(
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const STELLA_EXECUTION = {
  engine: "stella",
  provider: "stella",
  model: "stella/default",
  reasoningEffort: "default",
} as const;

const ladderTurn = (turnId: string) => ({
  ...agentTurn(turnId),
  execution: STELLA_EXECUTION,
  turnBrokerRoute: {
    sessionId: `broker:${turnId}`,
    endpoint: "https://broker.example",
  },
});

const residentPlanRecord = (turnId: string) =>
  turnComputePlan({
    turnId,
    attemptGeneration: 1,
    execution: STELLA_EXECUTION,
    browserResume: false,
    residentDisabled: false,
    now: 1_700_000_000_000,
  });

type SandboxCall = { sandboxId: string; size: string };

/**
 * Drive one exact Stop against a real `startAgentTurn`, with a resident loop
 * that can only unwind because the resident abort ran. A hook that forgot to
 * abort the Agent would hang here rather than pass.
 */
const residentStopHarness = (turnId: string) => {
  const harness = buildSessionHarness();
  const current = ladderTurn(turnId);
  harness.values.set("turn", current);
  harness.values.set("turnId", current.turnId);
  harness.values.set("terminal", false);
  harness.values.set(
    turnComputePlanKey(current.turnId, 1),
    residentPlanRecord(current.turnId),
  );
  delete harness.instance["terminateCurrentAgentSandbox"];
  const order: string[] = [];
  const destroyed: SandboxCall[] = [];
  const killed: string[] = [];
  let sandboxCalls = 0;
  harness.instance["sandbox"] = (sandboxId: string, size: string) => {
    sandboxCalls += 1;
    return {
      killAllProcesses: async (sessionId: string) => {
        killed.push(sessionId);
      },
      destroy: async () => {
        destroyed.push({ sandboxId, size });
      },
    };
  };
  harness.instance["runAgentTurn"] = async (
    _turn: unknown,
    _sandboxId: unknown,
    context: TurnExecutionContext,
  ) => {
    let unwind!: () => void;
    const aborted = new Promise<void>((resolve) => {
      unwind = resolve;
    });
    (harness.instance["residentAgentAborts"] as Map<string, () => void>).set(
      current.turnId,
      () => {
        order.push("resident_abort");
        unwind();
      },
    );
    context.assertActive();
    await aborted;
    order.push("loop_unwound");
  };
  const running = (
    harness.instance["startAgentTurn"] as (
      turn: unknown,
      sandboxId: string | undefined,
    ) => Promise<void>
  )(current, undefined);
  return {
    harness,
    current,
    order,
    destroyed,
    killed,
    running,
    sandboxCalls: () => sandboxCalls,
  };
};

describe("resident placement exact Stop", () => {
  test("a resident Stop touches no container and still ACKs truthfully", async () => {
    const driven = residentStopHarness("agent-resident-stop");
    driven.harness.values.set(agentComputeKey(driven.current.turnId, 1), {
      schemaVersion: 1,
      turnId: driven.current.turnId,
      attemptGeneration: 1,
      phase: "resident",
      instanceSize: "large",
    });

    const response = await driven.harness.instance.fetch(
      cancelRequest(request(driven.current.turnId)),
    );
    await driven.running.catch(() => undefined);

    expect(driven.sandboxCalls()).toBe(0);
    expect(driven.destroyed).toEqual([]);
    expect(driven.killed).toEqual([]);
    expect(driven.order).toEqual([
      "resident_abort",
      "loop_unwound",
      "resident_abort",
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: driven.current.turnId,
      joined: true,
    });
    expect(
      await driven.harness.ledger.matching(request(driven.current.turnId)),
    ).toMatchObject({ state: "acknowledged" });
    expect(driven.harness.values.has("pendingTerminal")).toBe(false);
  });

  test("a Stop during attach destroys the exact reserved instance", async () => {
    const driven = residentStopHarness("agent-resident-attaching");
    // The ladder records the reservation before the platform has an instance to
    // name, so the shared `sandboxId` key is deliberately absent here.
    driven.harness.values.set(agentComputeKey(driven.current.turnId, 1), {
      schemaVersion: 1,
      turnId: driven.current.turnId,
      attemptGeneration: 1,
      phase: "attaching",
      instanceSize: "small",
      sandboxId: `agent-${driven.current.turnId}`,
    });

    const response = await driven.harness.instance.fetch(
      cancelRequest(request(driven.current.turnId)),
    );
    await driven.running.catch(() => undefined);

    expect(driven.destroyed).toEqual([
      { sandboxId: `agent-${driven.current.turnId}`, size: "small" },
      { sandboxId: `agent-${driven.current.turnId}`, size: "small" },
    ]);
    expect(driven.killed).toEqual([]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: driven.current.turnId,
      joined: true,
    });
    expect(
      await driven.harness.ledger.matching(request(driven.current.turnId)),
    ).toMatchObject({ state: "acknowledged" });
  });

  test("an attached Stop keeps the exact two-sweep ACK contract", async () => {
    const driven = residentStopHarness("agent-resident-attached");
    const sandboxId = `agent-${driven.current.turnId}`;
    driven.harness.values.set("sandboxId", sandboxId);
    driven.harness.values.set("sandboxSize", "large");
    driven.harness.values.set(
      `agentExecutionMarker:${driven.current.turnId}:1`,
      {
        schemaVersion: 1,
        turnId: driven.current.turnId,
        attemptGeneration: 1,
        sandboxId,
        size: "large",
        startedAt: 1_700_000_000_000,
      },
    );
    driven.harness.values.set(agentComputeKey(driven.current.turnId, 1), {
      schemaVersion: 1,
      turnId: driven.current.turnId,
      attemptGeneration: 1,
      phase: "attached",
      instanceSize: "large",
      sandboxId,
    });

    let settled = false;
    const cancellation = driven.harness.instance
      .fetch(cancelRequest(request(driven.current.turnId)))
      .then((response) => {
        settled = true;
        return response;
      });
    while (driven.destroyed.length === 0) await Promise.resolve();
    expect(settled).toBe(false);
    expect(driven.harness.values.get("pendingTerminal")).toMatchObject({
      turnId: driven.current.turnId,
      kind: "canceled",
      terminateSandbox: true,
    });

    const response = await cancellation;
    await driven.running.catch(() => undefined);

    expect(driven.destroyed).toEqual([
      { sandboxId, size: "large" },
      { sandboxId, size: "large" },
    ]);
    expect(driven.killed).toEqual([
      `agent-run-${driven.current.turnId}-large`,
      `agent-run-${driven.current.turnId}-large`,
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canceled: true,
      turnId: driven.current.turnId,
      joined: true,
    });
    expect(driven.harness.values.has("pendingTerminal")).toBe(false);
  });
});
