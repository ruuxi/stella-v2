import { afterEach, describe, expect, test } from "bun:test";
import {
  createOwnerFenceHost,
  type OwnerFenceAuthorityChangeHook,
  type OwnerPurgeFence,
} from "../src/owner-fence-do.js";
import { OwnerFenceStore } from "../src/owner-fence-store.js";
import { openSqlStorageFake, type SqlStorageFake } from "./fixtures/sql-storage.js";

const NOW = 1_800_000_000_000;
const OWNER_ID = "owner-1";
const GENERATION = "fence-generation-1";

type Harness = ReturnType<typeof open>;
const opened: Harness[] = [];

const fence = (): OwnerPurgeFence => ({
  ownerId: OWNER_ID,
  generation: GENERATION,
  state: "open",
  leaseStorageVersion: 2,
  active: {},
});

const open = (beforeAuthorityChange?: OwnerFenceAuthorityChangeHook) => {
  const sqlFake = openSqlStorageFake();
  const values = new Map<string, unknown>([["ownerPurgeFence", fence()]]);
  let alarm: number | null = null;
  const storage = {
    sql: sqlFake.sql,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    transaction: async <T>(work: (txn: typeof storage) => Promise<T>) =>
      await work(storage),
  };
  const host = createOwnerFenceHost({
    ctx: { storage } as unknown as DurableObjectState,
    env: {} as never,
    beforeAuthorityChange,
  });
  return {
    host,
    values,
    store: () => new OwnerFenceStore(sqlFake.sql),
    close: () => sqlFake.close(),
  };
};

const readFence = async (harness: Harness) =>
  (await (Reflect.get(harness, "values") as Map<string, unknown>)
    .get("ownerPurgeFence")) as OwnerPurgeFence;

const request = (body: Record<string, unknown>) =>
  new Request("https://owner-gate/owner-fence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: OWNER_ID, ...body }),
  });

afterEach(() => {
  while (opened.length) opened.pop()?.close();
});

describe("OwnerFenceHost authority-change barrier", () => {
  test("keeps the fence open until a valid begin hook completes", async () => {
    const held = Promise.withResolvers<void>();
    let calls = 0;
    const harness = open(async ({ path, body }) => {
      calls += 1;
      expect(path).toBe("begin");
      expect(body).toEqual({ ownerId: OWNER_ID, requestId: "purge-1" });
      await held.promise;
    });
    opened.push(harness);

    const pending = harness.host.fetch("begin", request({ requestId: "purge-1" }));
    await Promise.resolve();
    expect((await readFence(harness)).state).toBe("open");
    expect(calls).toBe(1);

    held.resolve();
    expect((await pending).status).toBe(200);
    expect((await readFence(harness)).state).toBe("blocked");
  });

  test("does not invoke the hook for invalid begin or transfer registration", async () => {
    let calls = 0;
    const harness = open(async () => {
      calls += 1;
    });
    opened.push(harness);

    expect((await harness.host.fetch("begin", request({ requestId: "purge-1", expectedGeneration: "wrong" }))).status).toBe(409);
    expect((await harness.host.fetch("register", request({
      generation: GENERATION,
      leaseId: "transfer-1",
      sessionId: "transfer-session",
      turnId: "owner-transfer:1",
      ownerGeneration: "owner-generation-1",
      namespace: "activity",
      role: "transfer",
    }))).status).toBe(400);
    expect(calls).toBe(0);
  });

  test("does not write a valid transfer lease until its hook completes", async () => {
    const held = Promise.withResolvers<void>();
    const harness = open(async ({ path, body }) => {
      expect(path).toBe("register");
      expect(body.role).toBe("transfer");
      await held.promise;
    });
    opened.push(harness);
    const pending = harness.host.fetch("register", request({
      generation: GENERATION,
      leaseId: "transfer-1",
      sessionId: "transfer-session",
      turnId: "owner-transfer:1",
      ownerGeneration: "owner-generation-1",
      namespace: "activity",
      role: "transfer",
      expiresAt: Date.now() + 60_000,
    }));
    await Promise.resolve();
    const before = harness.store();
    before.initialize();
    expect(before.activeLease("transfer-1")).toBeNull();

    held.resolve();
    expect((await pending).status).toBe(200);
    expect(before.activeLease("transfer-1")).toMatchObject({
      role: "transfer",
      state: "active",
    });
  });

  test("leaves begin and transfer state unchanged when the hook fails", async () => {
    const harness = open(async () => {
      throw new Error("grant revocation failed");
    });
    opened.push(harness);

    await expect(harness.host.fetch("begin", request({ requestId: "purge-1" }))).rejects.toThrow("grant revocation failed");
    expect((await readFence(harness)).state).toBe("open");

    await expect(harness.host.fetch("register", request({
      generation: GENERATION,
      leaseId: "transfer-1",
      sessionId: "transfer-session",
      turnId: "owner-transfer:1",
      ownerGeneration: "owner-generation-1",
      namespace: "activity",
      role: "transfer",
      expiresAt: Date.now() + 60_000,
    }))).rejects.toThrow("grant revocation failed");
    const store = harness.store();
    store.initialize();
    expect(store.activeLease("transfer-1")).toBeNull();
  });
});
