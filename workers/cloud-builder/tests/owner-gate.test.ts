import { afterEach, describe, expect, mock, test } from "bun:test";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";
import { sampleOwnerSnapshot } from "./helpers/turn-plane-fakes.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
const {
  OWNER_GATE_RUNNING_GRACE_MS,
  OwnerGate,
  snapshotAllowsExecutionEngine,
} = await import("../src/owner-gate.js");
mock.restore();

/**
 * The owner gate decides admission from its own SQLite. These tests drive the
 * real class with an in-memory SQLite seeded from a fixture snapshot: the
 * replay registry, write fence, generation check and enforcement.
 */

const NOW = 1_800_000_000_000;
const TURN_TIMEOUT_MS = 900_000;

const gateHarness = (
  options: {
    snapshot?: ReturnType<typeof sampleOwnerSnapshot>;
    values?: Map<string, unknown>;
  } = {},
) => {
  const values = options.values ?? new Map<string, unknown>();
  const sqlFake = openSqlStorageFake();
  const storage = {
    sql: sqlFake.sql,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
  };
  const instance = Object.create(OwnerGate.prototype) as InstanceType<
    typeof OwnerGate
  > &
    Record<string, unknown>;
  const snapshot = options.snapshot ?? sampleOwnerSnapshot();
  Object.assign(instance, {
    ctx: { storage, id: { name: "owner-1", toString: () => "owner-1" } },
    env: {
      BUILDER_SERVICE_SECRET: "secret",
      TURN_TIMEOUT_MS: String(TURN_TIMEOUT_MS),
    },
  });
  const store = (instance as unknown as {
    ownerStore(): { context(caller: null): { db: { run(sql: string, ...args: unknown[]): void } } };
  }).ownerStore();
  const { db } = store.context(null);
  db.run(
    `INSERT INTO owner_state (id, generation, writable, closed, is_anonymous, identity_level, min_iat_ms)
     VALUES (1, ?, ?, 0, ?, ?, 0)`,
    snapshot.ownerGeneration,
    snapshot.writable ? 1 : 0,
    snapshot.isAnonymous ? 1 : 0,
    snapshot.identityLevel,
  );
  if (snapshot.enforcement) {
    db.run(
      `INSERT INTO abuse_state (id, status, until_at, reason, actor, updated_at) VALUES (1, ?, NULL, ?, 'test', 0)`,
      snapshot.enforcement.status,
      snapshot.enforcement.reason ?? "",
    );
  }
  return {
    instance,
    values,
    close: () => sqlFake.close(),
  };
};

const chat = (turnId: string, now = NOW, extra: Record<string, unknown> = {}) =>
  ({
    lane: "chat" as const,
    turnId,
    conversationId: "conversation-1",
    now,
    ...extra,
  }) as const;

const harnesses: Array<{ close: () => void }> = [];
const open = (...args: Parameters<typeof gateHarness>) => {
  const harness = gateHarness(...args);
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("OwnerGate admission", () => {
  test("registers the run and replays the same turn id", async () => {
    const { instance } = open();
    const first = await instance.admit(chat("turn-1"));
    expect(first).toMatchObject({ ok: true, replayed: false });
    if (!first.ok) return;
    // Billing is unconfigured here, so the allowance fails closed.
    expect(first.snapshot.allowance.audience).toBe("free");
    const replay = await instance.admit(chat("turn-1"));
    expect(replay).toMatchObject({ ok: true, replayed: true });
    const status = await instance.status(NOW);
    expect(status.running).toHaveLength(1);
    await instance.release({ turnId: "turn-1" });
    expect((await instance.status(NOW)).running).toHaveLength(0);
    // Releasing again, or an unknown turn, is a no-op.
    await instance.release({ turnId: "turn-1" });
    await instance.release({ turnId: "never-admitted" });
  });

  test("admits concurrent turns and prunes stale running rows", async () => {
    const { instance } = open();
    expect((await instance.admit(chat("concurrent-1"))).ok).toBe(true);
    expect((await instance.admit(chat("concurrent-2"))).ok).toBe(true);
    expect((await instance.status(NOW)).running).toHaveLength(2);
    const stale = NOW + TURN_TIMEOUT_MS + OWNER_GATE_RUNNING_GRACE_MS + 1;
    expect((await instance.status(stale)).running).toHaveLength(0);
  });

  test("anonymous owners may chat but cannot enter the agent lane", async () => {
    const { instance } = open({
      snapshot: sampleOwnerSnapshot({ isAnonymous: true, identityLevel: 0 }),
    });
    expect((await instance.admit(chat("anonymous-chat"))).ok).toBe(true);
    await instance.release({ turnId: "anonymous-chat" });
    await expect(
      instance.admit({
        lane: "agent",
        turnId: "anonymous-agent",
        conversationId: "conversation-1",
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "sign_in_required",
      retryable: false,
    });
  });

  test("maps a suspended owner to owner_suspended for turns and dispatches", async () => {
    const snapshot = sampleOwnerSnapshot({
      writable: false,
      enforcement: { status: "suspended", reason: "manual review" },
    });
    const { instance } = open({ snapshot });
    await expect(instance.admit(chat("suspended-chat"))).resolves.toMatchObject(
      {
        ok: false,
        code: "owner_suspended",
        retryable: false,
      },
    );
    await expect(
      instance.submit({
        request: {
          protocol: 1,
          idempotencyKey: "suspended-dispatch",
          kind: "chat",
          ingress: "browser",
          subject: "cloud",
          conversationId: "conversation-1",
          requiredCapabilities: ["chat"],
          payload: {
            schemaVersion: 1,
            prompt: "hello",
            conversationId: "conversation-1",
            clientMsgId: "suspended-dispatch",
          },
        },
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "owner_suspended", retryable: false },
    });
  });

  test("refuses a non-writable owner", async () => {
    const fenced = open({ snapshot: sampleOwnerSnapshot({ writable: false }) });
    expect(await fenced.instance.admit(chat("f1"))).toMatchObject({
      ok: false,
      code: "owner_purged",
      retryable: false,
    });
  });

  test("a stale service generation is refused", async () => {
    const { instance } = open();
    expect((await instance.admit(chat("s1", NOW, { expectedGeneration: "generation-1" }))).ok).toBe(true);
    const stale = await instance.admit(chat("s2", NOW, { expectedGeneration: "generation-0" }));
    expect(stale).toMatchObject({ ok: false, code: "generation_stale" });
  });
});

describe("owner snapshot", () => {
  test("execution availability follows the connected engines list", () => {
    expect(snapshotAllowsExecutionEngine({}, "stella")).toBe(true);
    expect(snapshotAllowsExecutionEngine({}, "anthropic")).toBe(false);
    expect(
      snapshotAllowsExecutionEngine(
        { connectedEngines: ["anthropic"] },
        "anthropic",
      ),
    ).toBe(true);
    expect(
      snapshotAllowsExecutionEngine(
        { connectedEngines: ["anthropic"] },
        "chatgpt",
      ),
    ).toBe(false);
  });
});
