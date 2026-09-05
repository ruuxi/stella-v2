import { describe, expect, mock, test } from "bun:test";
import type {
  ConversationCreatedEvent,
  TurnEventEvent,
  TurnStartedEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
} from "@stella/contracts/turn-plane/turn-start";
import { ExactTurnCancellationLedger } from "../src/execution-placement-turn-cancellation.js";
import { chatTurnFingerprintSource, type AdmittedCloudChat } from "../src/cloud-chat-admission.js";
import { sha256Hex } from "@stella/contracts/turn-plane/pairing-proof";
import { HEADER_TURN_AUTH_KIND } from "../src/turn-start-request.js";
import {
  fakeOutbox,
  fakeOwnerGates,
  sampleOwnerSnapshot,
} from "./helpers/turn-plane-fakes.js";

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
const { OrchestratorSession } = await import("../src/orchestrator-session.js");
mock.restore();

/**
 * The Durable Object half of a turn start: adoption, ownership, idempotency
 * on `clientMsgId`, the owner gate, the execution, the projections, and the
 * per-turn event ordinal. The Worker's trusted headers are supplied
 * directly; nothing here trusts a body-supplied owner.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const storageFake = (values = new Map<string, unknown>()) => {
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
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put,
    delete: async (key: string) => values.delete(key),
    deleteAll: async () => values.clear(),
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
  return { values, storage, alarm: () => alarm };
};

const journalFake = (initial: { ownerId?: string; title?: string } = {}) => {
  const meta = {
    schema_version: 1,
    epoch: 1,
    owner_id: initial.ownerId ?? "",
    conversation_id: "conversation-1",
    created_at: initial.ownerId ? 5 : 0,
    title: initial.title ?? "",
    next_seq: 0,
    hot_min_seq: 0,
    index_synced_seq: -1,
    deleted_at: null as number | null,
  };
  const binds: Array<Record<string, unknown>> = [];
  return {
    binds,
    meta: () => ({ ...meta }),
    ownerId: () => meta.owner_id,
    bindOwner: (record: {
      ownerId: string;
      createdAt: number;
      title: string;
    }) => {
      if (meta.owner_id && meta.owner_id !== record.ownerId) {
        throw new Error("Conversation is already bound to a different owner.");
      }
      binds.push({ ...record });
      meta.owner_id = record.ownerId;
      if (meta.created_at <= 0) meta.created_at = record.createdAt;
      meta.title = record.title;
    },
    setTitle: (title: string) => {
      if (!meta.title) meta.title = title;
    },
    isDeleted: () => meta.deleted_at !== null,
    turnState: () => null,
    upsertTurn: () => undefined,
    appendMessage: () => ({ seq: 0, record: undefined }),
    setTurnSpan: () => undefined,
  };
};

const harness = (
  options: {
    values?: Map<string, unknown>;
    journal?: ReturnType<typeof journalFake>;
    gates?: ReturnType<typeof fakeOwnerGates>;
    outbox?: ReturnType<typeof fakeOutbox>;
    editLock?: unknown;
  } = {},
) => {
  const { values, storage, alarm } = storageFake(options.values);
  const journal = options.journal ?? journalFake();
  const gates = options.gates ?? fakeOwnerGates();
  const outbox = options.outbox ?? fakeOutbox();
  const instance = Object.create(OrchestratorSession.prototype) as InstanceType<
    typeof OrchestratorSession
  > &
    Record<string, unknown>;
  let registrations = 0;
  let unregistrations = 0;
  let enqueues = 0;
  Object.assign(instance, {
    ctx: {
      storage,
      id: { name: "conversation-1", toString: () => "conversation-1" },
      waitUntil: () => undefined,
      blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
        await operation(),
    },
    env: {
      OWNER_GATES: gates.namespace,
      TURN_OUTBOX: outbox.queue,
      STELLA_CONVEX_SITE_URL: "https://convex.example",
    },
    exactTurnCancellations: new ExactTurnCancellationLedger(storage),
    turnExecutions: new Map<string, unknown>(),
    ownerFencedAppends: new Map<string, unknown>(),
    activeTurnId: null,
    journal,
    activeConversationEditLock: async () => options.editLock ?? null,
    bindConversation: () => undefined,
    publish: () => undefined,
    registerOwnerTurn: async (target: { ownerPurgeLeaseId?: string }) => {
      registrations += 1;
      target.ownerPurgeLeaseId ??= `lease-${registrations}`;
      return `purge-generation-${registrations}`;
    },
    assertOwnerTurn: async () => undefined,
    assertOwnerFenceLeaseReceiptActive: async () => undefined,
    unregisterOwnerTurn: async () => {
      unregistrations += 1;
    },
    enqueue: () => {
      enqueues += 1;
    },
    ensureQueueAlarm: async () => undefined,
  });
  const dispatch = (
    body: unknown,
    auth:
      | { kind: "user"; ownerId: string }
      | { kind: "service"; ownerId: string; generation?: string }
      | { headers: Record<string, string> },
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if ("headers" in auth) {
      Object.assign(headers, auth.headers);
    } else {
      headers["x-stella-owner"] = auth.ownerId;
      headers[HEADER_TURN_AUTH_KIND] = auth.kind;
      if (auth.kind === "service" && auth.generation) {
        headers[TURN_OWNER_GENERATION_HEADER] = auth.generation;
      }
    }
    return instance.fetch(
      new Request("https://orchestrator-session/turn", {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  };
  return {
    instance,
    values,
    journal,
    gates,
    outbox,
    dispatch,
    alarm,
    registrations: () => registrations,
    unregistrations: () => unregistrations,
    enqueues: () => enqueues,
  };
};

const start = (overrides: Record<string, unknown> = {}) => ({
  protocol: TURN_PLANE_PROTOCOL,
  clientMsgId: "client-msg-0001",
  prompt: "Plan my week around the launch",
  ...overrides,
});

const USER = { kind: "user" as const, ownerId: "owner-1" };

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: Record<string, unknown> }).error;

describe("OrchestratorSession turn admission", () => {
  test("adopts a fresh conversation for its first verified caller and projects it", async () => {
    const h = harness();
    const response = await h.dispatch(start(), USER);
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      protocol: 1,
      conversationId: "conversation-1",
      accepted: true,
      replayed: false,
      createdConversation: true,
    });
    const turnId = body.turnId as string;
    expect(turnId).toMatch(UUID);

    expect(h.journal.binds).toHaveLength(1);
    expect(h.journal.binds[0]).toMatchObject({
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      title: "Plan my week around the launch",
    });
    expect(h.gates.admits).toEqual([
      {
        ownerId: "owner-1",
        input: {
          lane: "chat",
          turnId,
          conversationId: "conversation-1",
        },
      },
    ]);
    expect(h.registrations()).toBe(1);
    expect(h.enqueues()).toBe(1);

    const queued = h.values.get(`queued:${turnId}`) as Record<string, unknown>;
    expect(queued).toMatchObject({
      kind: "chat",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      conversationId: "conversation-1",
      turnId,
      sessionId: "chat-conversa",
      prompt: "Plan my week around the launch",
      execution: { engine: "stella", model: "stella/default" },
      audience: "pro",
      budgetMicroCents: 250_000_000,
      lane: "chat",
      clientMsgId: "client-msg-0001",
      ownerPurgeGeneration: "purge-generation-1",
    });
    expect(queued.hiddenMessage).toBeUndefined();
    // The owner-fence lease id is minted here, never by a caller.
    expect(queued.ownerPurgeLeaseId).toMatch(UUID);
    expect(h.values.get("chatTurnAdmission:client-msg-0001")).toMatchObject({
      schemaVersion: 2,
      ownerId: "owner-1",
      turnId,
      leaseId: queued.ownerPurgeLeaseId,
      phase: "accepted",
      createdConversation: true,
    });
    expect(h.values.get("ownerDataGeneration")).toBe("generation-1");

    expect(h.outbox.events.map((event) => event.kind)).toEqual([
      "conversation.created",
      "turn.started",
    ]);
    const created = h.outbox.events[0] as ConversationCreatedEvent;
    expect(created).toMatchObject({
      v: 1,
      key: "conversation-1",
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      conversationId: "conversation-1",
      title: "Plan my week around the launch",
      execution: { engine: "stella" },
    });
    const started = h.outbox.events[1] as TurnStartedEvent;
    expect(started).toMatchObject({
      key: turnId,
      turnId,
      turnKind: "chat",
      conversationId: "conversation-1",
      sessionId: "chat-conversa",
      lane: "chat",
      clientMsgId: "client-msg-0001",
      agentType: "orchestrator",
      execution: { engine: "stella", model: "stella/default" },
      prompt: "Plan my week around the launch",
    });
    expect(started.hidden).toBeUndefined();
  });

  test("a conversation adopted by its socket before any turn is still projected by the first turn", async () => {
    const h = harness();
    // The desktop subscribes with a client-minted id before it sends; the
    // hub resolves (and adopts) the verified connector through this seam.
    const adopted = await (
      h.instance["resolveOwnerForCaller"] as (caller: {
        ownerId: string;
      }) => Promise<{
        ownerId: string;
        ownerGeneration: string;
        title: string;
      } | null>
    ).call(h.instance, { ownerId: "owner-1" });
    expect(adopted).toMatchObject({
      ownerId: "owner-1",
      ownerGeneration: "generation-1",
      title: "",
    });
    expect(h.journal.meta().owner_id).toBe("owner-1");
    expect(h.gates.snapshots).toEqual(["owner-1"]);
    // A different verified connector is refused, never adopted.
    expect(
      await (
        h.instance["resolveOwnerForCaller"] as (caller: {
          ownerId: string;
        }) => Promise<unknown>
      ).call(h.instance, { ownerId: "owner-2" }),
    ).toBeNull();

    const response = await h.dispatch(start(), USER);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ createdConversation: true });
    expect(h.journal.meta().title).toBe("Plan my week around the launch");
    expect(h.outbox.events.map((event) => event.kind)).toEqual([
      "conversation.created",
      "turn.started",
    ]);
    expect(h.values.get("conversationProjected")).toBe(true);
    expect(h.journal.binds).toHaveLength(1);

    // The second turn is not a creation.
    const second = await h.dispatch(
      start({ clientMsgId: "client-msg-0002" }),
      USER,
    );
    expect(await second.json()).toMatchObject({ createdConversation: false });
    expect(
      h.outbox.events.filter((event) => event.kind === "conversation.created"),
    ).toHaveLength(1);
  });

  test("uses the request's title and pinned execution, and a long prompt is trimmed into a title", async () => {
    const h = harness();
    const execution = {
      engine: "stella",
      provider: "stella",
      model: "stella/light",
      reasoningEffort: "low",
    };
    const response = await h.dispatch(
      start({ title: "  Launch plan  ", execution, source: "desktop" }),
      USER,
    );
    expect(response.status).toBe(202);
    expect(h.journal.meta().title).toBe("Launch plan");
    const turnId = ((await response.json()) as { turnId: string }).turnId;
    expect(h.values.get(`queued:${turnId}`)).toMatchObject({
      execution,
      source: "desktop",
      title: "Launch plan",
    });

    const long = harness();
    await long.dispatch(start({ prompt: "word ".repeat(40) }), USER);
    const title = long.journal.meta().title;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });

  test("a bound conversation refuses another owner before any side effect", async () => {
    const h = harness({
      journal: journalFake({ ownerId: "owner-2", title: "Theirs" }),
    });
    const response = await h.dispatch(start(), USER);
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: "owner_mismatch",
      retryable: false,
    });
    expect(h.gates.admits).toHaveLength(0);
    expect(h.values.size).toBe(0);
    expect(h.outbox.events).toHaveLength(0);
  });

  test("replays pre-echo admission receipts when a retried placement carries its original renderer id", async () => {
    const h = harness();
    const accepted = await h.dispatch(start(), USER);
    const original = await accepted.json();
    const replay = await h.dispatch(start({ originUserMessageId: "local-original-echo" }), USER);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ turnId: original.turnId, replayed: true });
  });

  test("replays the same clientMsgId with the same turn id and conflicts on a different message", async () => {
    const values = new Map<string, unknown>();
    const journal = journalFake();
    const gates = fakeOwnerGates();
    const outbox = fakeOutbox();
    const first = harness({ values, journal, gates, outbox });
    const accepted = await first.dispatch(start(), USER);
    const { turnId } = (await accepted.json()) as { turnId: string };

    const restarted = harness({ values, journal, gates, outbox });
    const replay = await restarted.dispatch(start(), USER);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      turnId,
      replayed: true,
      createdConversation: true,
    });
    expect(gates.admits).toHaveLength(1);
    expect(outbox.events).toHaveLength(2);
    expect(restarted.enqueues()).toBe(0);

    const conflict = await restarted.dispatch(
      start({ prompt: "a different message" }),
      USER,
    );
    expect(conflict.status).toBe(409);
    expect(await errorOf(conflict)).toMatchObject({
      code: "idempotency_conflict",
    });
    const otherOwner = await restarted.dispatch(start(), {
      kind: "user",
      ownerId: "owner-2",
    });
    expect(otherOwner.status).toBe(403);
    expect(gates.admits).toHaveLength(1);
  });

  test("maps every owner-gate refusal to the turn-start contract without persisting anything", async () => {
    const cases = [
      [{ code: "owner_purged", retryable: false }, 410],
      [{ code: "generation_stale", retryable: false }, 403],
      [{ code: "internal", retryable: true }, 503],
    ] as const;
    for (const [refusal, status] of cases) {
      const h = harness({
        gates: fakeOwnerGates({
          admit: () => ({ ok: false, message: "refused", ...refusal }),
        }),
      });
      const response = await h.dispatch(start(), USER);
      expect(response.status).toBe(status);
      const error = await errorOf(response);
      expect(error).toMatchObject({
        code: refusal.code,
        message: "refused",
        retryable: refusal.retryable,
      });
      if ("retryAfterMs" in refusal) {
        expect(error.retryAfterMs).toBe(refusal.retryAfterMs);
        expect(response.headers.get("retry-after")).toBe(
          String(Math.ceil(refusal.retryAfterMs / 1000)),
        );
      }
      expect(h.values.size).toBe(0);
      expect(h.registrations()).toBe(0);
      expect(h.outbox.events).toHaveLength(0);
      expect(h.journal.binds).toHaveLength(0);
    }
  });

  test("refuses an execution whose engine is not connected and releases the gate", async () => {
    const anthropic = {
      engine: "anthropic",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      reasoningEffort: "default",
    };
    const refused = harness();
    const response = await refused.dispatch(
      start({ execution: anthropic }),
      USER,
    );
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "execution_unavailable",
      retryable: false,
    });
    expect(refused.gates.releases).toHaveLength(1);
    expect(refused.gates.releases[0]?.turnId).toBe(
      refused.gates.admits[0]?.input.turnId,
    );
    expect(refused.values.size).toBe(0);

    const connected = harness({
      gates: fakeOwnerGates({
        snapshot: sampleOwnerSnapshot({ connectedEngines: ["anthropic"] }),
      }),
    });
    const ok = await connected.dispatch(start({ execution: anthropic }), USER);
    expect(ok.status).toBe(202);
    const { turnId } = (await ok.json()) as { turnId: string };
    expect(connected.values.get(`queued:${turnId}`)).toMatchObject({
      execution: anthropic,
    });
    expect(connected.gates.releases).toHaveLength(0);
  });

  test("a user caller cannot use service-only lanes or fields, even at the object", async () => {
    const h = harness();
    for (const overrides of [
      { lane: "wake" },
      { hiddenMessage: true },
      { source: "schedule" },
    ]) {
      const response = await h.dispatch(start(overrides), USER);
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toMatchObject({ code: "forbidden" });
    }
    expect(h.gates.admits).toHaveLength(0);
  });

  test("a service caller runs a wake turn with its control receipt", async () => {
    const values = new Map<string, unknown>([["conversationProjected", true]]);
    const h = harness({
      values,
      journal: journalFake({ ownerId: "owner-1", title: "Bound" }),
    });
    const control = {
      threadId: "thread-1",
      attemptGeneration: 2,
      threadUpdatedAt: 400,
      status: "completed",
      lifecycleReport: "The structured report.",
    };
    const response = await h.dispatch(
      start({
        clientMsgId: "wake-thread-1-2",
        lane: "wake",
        source: "agent-thread",
        hiddenMessage: true,
        prompt: "[Agent completed] thread-1: done.",
        agentThreadControl: control,
      }),
      { kind: "service", ownerId: "owner-1", generation: "generation-1" },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ createdConversation: false });
    expect(h.gates.admits[0]?.input).toMatchObject({
      lane: "chat",
      expectedGeneration: "generation-1",
    });
    const started = h.outbox.events.find(
      (event) => event.kind === "turn.started",
    ) as TurnStartedEvent;
    expect(started).toMatchObject({
      lane: "wake",
      source: "agent-thread",
      hidden: true,
      threadId: "thread-1",
      attemptGeneration: 2,
    });
    expect(
      h.outbox.events.some((event) => event.kind === "conversation.created"),
    ).toBe(false);
    const queued = [...h.values.entries()].find(([key]) =>
      key.startsWith("queued:"),
    )?.[1] as Record<string, unknown>;
    expect(queued).toMatchObject({
      lane: "wake",
      hiddenMessage: true,
      agentThreadControl: control,
    });

    const stale = await h.dispatch(
      start({ clientMsgId: "stale-generation-1" }),
      { kind: "service", ownerId: "owner-1", generation: "generation-0" },
    );
    expect(stale.status).toBe(403);
    expect(await errorOf(stale)).toMatchObject({ code: "generation_stale" });
    const noGeneration = await h.dispatch(
      start({ clientMsgId: "no-generation-1" }),
      {
        kind: "service",
        ownerId: "owner-1",
      },
    );
    expect(noGeneration.status).toBe(400);

    const wakeWithoutControl = await h.dispatch(
      start({ clientMsgId: "wake-no-control-1", lane: "wake" }),
      { kind: "service", ownerId: "owner-1", generation: "generation-1" },
    );
    expect(wakeWithoutControl.status).toBe(400);
  });

  test("refuses a request that did not come through the Worker's verification", async () => {
    const h = harness();
    for (const headers of [
      {},
      { "x-stella-owner": "owner-1" },
      { [HEADER_TURN_AUTH_KIND]: "user" },
      { "x-stella-owner": "owner-1", [HEADER_TURN_AUTH_KIND]: "admin" },
    ]) {
      const response = await h.dispatch(start(), { headers });
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toMatchObject({ code: "unauthorized" });
    }
    const malformed = await h.dispatch("{oops", USER);
    expect(malformed.status).toBe(400);
    const noPrompt = await h.dispatch(start({ prompt: "   " }), USER);
    expect(noPrompt.status).toBe(400);
    expect(h.gates.admits).toHaveLength(0);
  });

  test("a conversation under edit is locked: 423, fence unregistered, gate released", async () => {
    const h = harness({ editLock: { operationId: "edit-1" } });
    const response = await h.dispatch(start(), USER);
    expect(response.status).toBe(423);
    expect(await errorOf(response)).toMatchObject({
      code: "conversation_locked",
      retryable: true,
      retryAfterMs: 1_000,
    });
    expect(h.unregistrations()).toBe(1);
    expect(h.gates.releases).toHaveLength(1);
    expect([...h.values.keys()].some((key) => key.startsWith("queued:"))).toBe(
      false,
    );
  });

  test("admission completes while queue delivery is stalled, and a restart retries the persisted batch", async () => {
    const outbox = fakeOutbox();
    const pending = Promise.withResolvers<void>();
    outbox.queue.sendBatch = async () => pending.promise;
    const h = harness({ outbox });
    try {
      const response = await Promise.race([
        h.dispatch(start(), USER),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("admission waited for queue")),
            250,
          ),
        ),
      ]);
      expect(response.status).toBe(202);
      const batchKeys = [...h.values.keys()].filter((key) =>
        key.startsWith("outboxBatch:"),
      );
      expect(batchKeys).toHaveLength(1);
      expect(h.alarm()).not.toBeNull();
      const restarted = harness({ values: h.values });
      await (restarted.instance["retryOutboxDebt"] as () => Promise<void>)();
      expect(restarted.outbox.events.map((event) => event.kind)).toEqual([
        "conversation.created",
        "turn.started",
      ]);
      expect(h.values.has(batchKeys[0]!)).toBe(false);
    } finally {
      pending.resolve();
    }
  });

  test("a completing batch cannot erase a second batch appended while it was in flight", async () => {
    const outbox = fakeOutbox();
    const pending = Promise.withResolvers<void>();
    outbox.queue.sendBatch = async () => pending.promise;
    const h = harness({ outbox });
    try {
      await h.dispatch(start(), USER);
      const first = [...h.values.keys()].find((key) =>
        key.startsWith("outboxBatch:"),
      )!;
      outbox.queue.sendBatch = async () => {
        throw new Error("queue unavailable");
      };
      await h.dispatch(start({ clientMsgId: "client-msg-0002" }), USER);
      pending.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.values.has(first)).toBe(false);
      expect(
        [...h.values.keys()].filter((key) => key.startsWith("outboxBatch:")),
      ).toHaveLength(1);
    } finally {
      pending.resolve();
    }
  });

  test("a refused outbox at admission becomes durable debt the alarm retries", async () => {
    const outbox = fakeOutbox();
    outbox.failNext(1);
    const h = harness({ outbox });
    const response = await h.dispatch(start(), USER);
    expect(response.status).toBe(202);
    const debt = [...h.values]
      .filter(([key]) => key.startsWith("outboxBatch:"))
      .flatMap(([, value]) => value as Array<{ kind: string }>);
    expect(debt.map((event) => event.kind)).toEqual([
      "conversation.created",
      "turn.started",
    ]);
    expect(h.alarm()).not.toBeNull();
    expect(outbox.events).toHaveLength(0);

    await (h.instance["retryOutboxDebt"] as () => Promise<void>)();
    expect(outbox.events.map((event) => event.kind)).toEqual([
      "conversation.created",
      "turn.started",
    ]);
    expect(
      [...h.values.keys()].some((key) => key.startsWith("outboxBatch:")),
    ).toBe(false);
  });
});

describe("projection retry alarms", () => {
  test("an early maintenance alarm does not terminate a turn before its persisted watchdog", async () => {
    const h = harness();
    const watchdogAt = Date.now() + 60_000;
    h.values.set("turnWatchdogAt", watchdogAt);
    h.instance["owedTerminal"] = async () => null;
    h.instance["currentTurnCancellation"] = {
      abort: () => {
        throw new Error("premature timeout");
      },
    };
    await (h.instance["runAlarm"] as (turn: unknown) => Promise<void>)({
      turnId: "turn-1",
    });
    expect(h.alarm()).toBe(watchdogAt);
    expect(h.values.has("terminal")).toBe(false);
  });
});

describe("turn.event ordinals", () => {
  const turn = (turnId: string) => ({
    kind: "chat" as const,
    ownerId: "owner-1",
    ownerGeneration: "generation-1",
    conversationId: "conversation-1",
    turnId,
    sessionId: "chat-conversa",
    prompt: "hello",
    execution: {
      engine: "stella" as const,
      provider: "stella" as const,
      model: "stella/default",
      reasoningEffort: "default" as const,
    },
    audience: "pro" as const,
    budgetMicroCents: 1,
    lane: "chat" as const,
    clientMsgId: "client-msg-0001",
  });
  type Emit = (
    turn: ReturnType<typeof turn>,
    eventKind: string,
    payload: unknown,
    options?: {
      terminal?: boolean;
      eventSeq?: number;
      errorMessage?: string;
      resultJson?: string;
    },
  ) => Promise<number>;

  test("terminal delivery survives a new turn and restart while the queue is unavailable", async () => {
    const values = new Map<string, unknown>();
    const outbox = fakeOutbox();
    outbox.failNext(1);
    const first = harness({ values, outbox });
    const emit = first.instance["emitTurnEvent"] as Emit;
    await emit.call(first.instance, turn("old-turn"), "completed", { text: "done" }, {
      terminal: true, eventSeq: 7, resultJson: '{"finalText":"done"}',
    });
    expect([...values.keys()].some((key) => key.startsWith("outboxBatch:"))).toBe(true);
    expect(first.alarm()).not.toBeNull();
    values.set("turn", turn("new-turn"));
    values.set("terminalOwed", null);
    const restarted = harness({ values, outbox });
    await (restarted.instance["retryOutboxDebt"] as () => Promise<void>).call(restarted.instance);
    expect(outbox.events).toContainEqual(expect.objectContaining({
      kind: "turn.event", turnId: "old-turn", eventSeq: 7, terminal: true,
    }));
    expect(values.get("turn")).toEqual(turn("new-turn"));
    expect([...values.keys()].some((key) => key.startsWith("outboxBatch:"))).toBe(false);
  });

  test("are monotonic per turn, survive an isolate restart, and a retried terminal reuses its ordinal", async () => {
    const values = new Map<string, unknown>();
    const outbox = fakeOutbox();
    const first = harness({ values, outbox });
    const emit = first.instance["emitTurnEvent"] as Emit;
    const t = turn("turn-1");
    expect(await emit.call(first.instance, t, "started", {})).toBe(1);
    // Concurrent emits of one turn never share an ordinal.
    const [a, b] = await Promise.all([
      emit.call(first.instance, t, "tool", { name: "web" }),
      emit.call(first.instance, t, "tool", { name: "recall" }),
    ]);
    expect(new Set([a, b])).toEqual(new Set([2, 3]));
    // Another turn has its own counter.
    expect(await emit.call(first.instance, turn("turn-2"), "started", {})).toBe(
      1,
    );

    const restarted = harness({ values, outbox });
    const emitAgain = restarted.instance["emitTurnEvent"] as Emit;
    expect(await emitAgain.call(restarted.instance, t, "assistant", {})).toBe(
      4,
    );

    const terminalSeq = await (
      restarted.instance["nextTurnEventSeq"] as (
        turnId: string,
      ) => Promise<number>
    ).call(restarted.instance, "turn-1");
    expect(terminalSeq).toBe(5);
    const send = () =>
      emitAgain.call(
        restarted.instance,
        t,
        "completed",
        { text: "done", wallClockMs: 10 },
        {
          terminal: true,
          eventSeq: terminalSeq,
          resultJson: JSON.stringify({ finalText: "done" }),
        },
      );
    expect(await send()).toBe(5);
    expect(await send()).toBe(5);
    const terminals = outbox.events.filter(
      (event): event is TurnEventEvent =>
        event.kind === "turn.event" && event.terminal,
    );
    expect(terminals).toHaveLength(2);
    expect(terminals[0]).toMatchObject({
      key: "turn-1:5",
      turnId: "turn-1",
      sessionId: "chat-conversa",
      eventSeq: 5,
      eventKind: "completed",
      terminal: true,
      terminalStatus: "completed",
      resultJson: JSON.stringify({ finalText: "done" }),
    });
    expect(terminals[1]?.key).toBe("turn-1:5");
    expect(values.get("turnEventSeq:turn-1")).toBe(5);
    expect(values.get("turnEventSeq:turn-2")).toBe(1);

    const timeout = await emitAgain.call(
      restarted.instance,
      t,
      "timeout",
      { message: "took too long" },
      { terminal: true, errorMessage: "took too long" },
    );
    expect(timeout).toBe(6);
    const last = outbox.events.at(-1) as TurnEventEvent;
    expect(last).toMatchObject({
      eventSeq: 6,
      eventKind: "timeout",
      terminalStatus: "failed",
      errorMessage: "took too long",
    });
  });

  test("a refused enqueue leaves the ordinal consumed so a retry never reuses a seq for different content", async () => {
    const outbox = fakeOutbox();
    const h = harness({ outbox });
    const emit = h.instance["emitTurnEvent"] as Emit;
    outbox.failNext(1);
    await expect(
      emit.call(h.instance, turn("turn-x"), "started", {}),
    ).rejects.toThrow("queue unavailable");
    expect(await emit.call(h.instance, turn("turn-x"), "started", {})).toBe(2);
    expect(outbox.events).toHaveLength(1);
  });
});

describe("combined warm admission", () => {
  const warm = (options: Parameters<typeof harness>[0] = {}) => {
    const h = harness({
      journal: journalFake({ ownerId: "owner-1" }),
      ...options,
    });
    h.instance.ownerGeneration = "generation-1";
    delete h.instance.registerOwnerTurn;
    h.instance.callOwnerFence = async () =>
      new Response(JSON.stringify({ generation: "fence-fallback" }));
    return h;
  };
  test("one gate call durably binds a warm turn; a lost acceptance replays the same turn", async () => {
    const h = warm();
    const first = await h.dispatch(start(), {
      kind: "user",
      ownerId: "owner-1",
    });
    expect(first.status).toBe(202);
    const accepted = await first.json();
    expect(h.gates.admits).toHaveLength(1);
    expect(h.gates.fenceLeases).toHaveLength(1);
    const queued = h.values.get(`queued:${accepted.turnId}`);
    expect(queued).toMatchObject({
      ownerGeneration: "generation-1",
      ownerPurgeLeaseId: h.gates.fenceLeases[0].lease.leaseId,
    });
    const replay = await h.dispatch(start(), {
      kind: "user",
      ownerId: "owner-1",
    });
    expect(await replay.json()).toMatchObject({
      turnId: accepted.turnId,
      replayed: true,
    });
    expect(h.gates.admits).toHaveLength(1);
  });
  test("a rotated generation skips registration and resumes discovery with the current snapshot", async () => {
    const h = warm({
      gates: fakeOwnerGates({
        snapshot: sampleOwnerSnapshot({ ownerGeneration: "generation-2" }),
      }),
    });
    const response = await h.dispatch(start(), {
      kind: "user",
      ownerId: "owner-1",
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    expect(h.gates.admits).toHaveLength(1);
    expect(h.gates.fenceLeases[0].outcome.status).toBe("skipped");
    expect(h.values.get(`queued:${accepted.turnId}`)).toMatchObject({
      ownerGeneration: "generation-2",
    });
  });
  test("a lost combined response retains the exact identity for reconciliation", async () => {
    const h = warm();
    const gate = h.gates.namespace.getByName("owner-1");
    let attemptedLease = "";
    h.gates.namespace.getByName = () => ({
      ...gate,
      admitWithFenceLease: async (input) => {
        attemptedLease = input.lease.leaseId;
        await gate.admitWithFenceLease(input);
        throw new Error("response lost after commit");
      },
    });
    const failed = await h.dispatch(start(), {
      kind: "user",
      ownerId: "owner-1",
    });
    expect(failed.status).toBe(503);
    expect(
      [...h.values.values()].some(
        (v) =>
          typeof v === "object" &&
          v !== null &&
          "leaseId" in v &&
          v.leaseId === attemptedLease,
      ),
    ).toBe(true);
    h.gates.namespace.getByName = () => gate;
    const retried = await h.dispatch(start(), {
      kind: "user",
      ownerId: "owner-1",
    });
    expect(retried.status).toBe(202);
    const accepted = await retried.json();
    expect(h.values.get(`queued:${accepted.turnId}`)).toMatchObject({
      ownerPurgeLeaseId: attemptedLease,
    });
  });
});

describe("owner-created chat admission", () => {
  const setup = async () => {
    const h = harness();
    delete h.instance.registerOwnerTurn;
    const body = start();
    const authority: AdmittedCloudChat = {
      version: 1, ownerId: "owner-1", ownerGeneration: "generation-1", conversationId: "conversation-1",
      clientMsgId: body.clientMsgId, fingerprint: await sha256Hex(chatTurnFingerprintSource("owner-1", "conversation-1", body)),
      turnId: "admitted-turn", leaseId: "admitted-lease", fenceGeneration: "fence-1", admittedAt: Date.now(),
      snapshot: sampleOwnerSnapshot(),
    };
    return { h, body, authority };
  };
  test("imports exact durable authority without a return admission RPC, then replays after restart", async () => {
    const { h, body, authority } = await setup();
    const accepted = await h.instance.startAdmittedChat(body, authority, {});
    expect(accepted.status).toBe(202);
    expect(h.gates.admits).toHaveLength(0);
    expect(h.gates.fenceLeases).toHaveLength(0);
    expect(h.values.get("queued:admitted-turn")).toMatchObject({ turnId: "admitted-turn", ownerPurgeLeaseId: "admitted-lease", ownerPurgeGeneration: "fence-1" });
    const restarted = harness({ values: h.values, journal: h.journal });
    const replay = await restarted.instance.startAdmittedChat(body, authority, {});
    expect(await replay.json()).toMatchObject({ turnId: "admitted-turn", replayed: true });
    expect(restarted.enqueues()).toBe(0);
  });
  test("rejects changed message bytes, owner, conversation, generation, or lease identity", async () => {
    const { h, body, authority } = await setup();
    for (const changed of [{ ...authority, ownerId: "owner-2" }, { ...authority, conversationId: "conversation-2" },
      { ...authority, ownerGeneration: "generation-2" }, { ...authority, fingerprint: "wrong" }]) {
      expect((await h.instance.startAdmittedChat(body, changed, {})).status).not.toBe(202);
    }
    expect((await h.instance.startAdmittedChat(body, authority, {})).status).toBe(202);
    expect((await h.instance.startAdmittedChat(body, { ...authority, leaseId: "other-lease" }, {})).status).not.toBe(202);
    expect(h.enqueues()).toBe(1);
  });
  test("a purge received before the handoff permanently rejects its delayed lease", async () => {
    const { h, body, authority } = await setup();
    h.values.set("ownerPurgeImportedLease:admitted-lease", { ownerId: authority.ownerId, ownerGeneration: authority.ownerGeneration, turnId: authority.turnId });
    const response = await h.instance.startAdmittedChat(body, authority, {});
    expect(response.status).not.toBe(202);
    expect(h.enqueues()).toBe(0);
    expect(h.gates.admits).toHaveLength(0);
  });
});
