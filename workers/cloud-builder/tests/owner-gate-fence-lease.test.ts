import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";
import { sampleOwnerSnapshot } from "./helpers/turn-plane-fakes.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
const { OwnerGate, OwnerGateSnapshotError } = await import(
  "../src/owner-gate.js"
);
const { OwnerFenceStore } = await import("../src/owner-fence-store.js");
mock.restore();

/**
 * `snapshotWithFenceLease` is the one gate round trip a new local turn makes:
 * the cached owner snapshot plus, when that snapshot still authorizes the
 * caller, the colocated fence's `register`. These tests drive the real class
 * with in-memory SQLite and a scripted snapshot transport, and read the fence
 * back through the production `OwnerFenceStore` so what the combined call
 * stores is exactly what `POST /owner-fence/register` would have.
 */

const NOW = 1_800_000_000_000;

const gateHarness = (
  options: {
    snapshot?: OwnerSnapshot;
    fetch?: () => Promise<OwnerSnapshot>;
  } = {},
) => {
  const values = new Map<string, unknown>();
  const sqlFake = openSqlStorageFake();
  let alarm: number | null = null;
  const storage = {
    sql: sqlFake.sql,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    transaction: async <T>(work: (txn: unknown) => Promise<T>) =>
      await work(storage),
  };
  const instance = Object.create(OwnerGate.prototype) as InstanceType<
    typeof OwnerGate
  >;
  let fetches = 0;
  Object.assign(instance, {
    ctx: { storage, id: { name: "owner-1", toString: () => "owner-1" } },
    env: {
      STELLA_CONVEX_SITE_URL: "https://convex.example",
      BUILDER_SERVICE_SECRET: "secret",
      TURN_TIMEOUT_MS: "900000",
    },
    fetchSnapshot: async () => {
      fetches += 1;
      if (options.fetch) return await options.fetch();
      return options.snapshot ?? sampleOwnerSnapshot();
    },
  });
  return {
    instance,
    values,
    fetches: () => fetches,
    alarm: () => alarm,
    // The fence host stamps leases with the wall clock, so read them with it.
    activeLeaseIds: () => {
      const store = new OwnerFenceStore(sqlFake.sql);
      store.initialize();
      return store.activeLeases().map((lease) => lease.leaseId);
    },
    close: () => sqlFake.close(),
  };
};

const harnesses: Array<{ close: () => void }> = [];
const open = (...args: Parameters<typeof gateHarness>) => {
  const harness = gateHarness(...args);
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

const lease = (
  overrides: Partial<{
    leaseId: string;
    ownerGeneration: string;
    generation: string;
  }> = {},
) => ({
  leaseId: "lease-1",
  sessionId: "conversation-1",
  turnId: "desktop:device-1:turn-1",
  ownerGeneration: "generation-1",
  namespace: "orchestrator" as const,
  role: "orchestrator" as const,
  ...overrides,
});

describe("OwnerGate.snapshotWithFenceLease", () => {
  test("serves the snapshot and registers the lease through the colocated fence", async () => {
    const harness = open();
    const result = await harness.instance.snapshotWithFenceLease({
      lease: lease(),
      now: NOW,
    });
    expect(result.snapshot?.ownerGeneration).toBe("generation-1");
    expect(result.lease.status).toBe("registered");
    if (result.lease.status !== "registered") return;
    const { generation, expiresAt } = result.lease;
    expect(typeof generation).toBe("string");
    expect(typeof expiresAt).toBe("number");
    // The fence bound itself to this owner and holds exactly this lease.
    expect(harness.values.get("ownerPurgeFence")).toMatchObject({
      ownerId: "owner-1",
      state: "open",
      generation,
      leaseStorageVersion: 2,
    });
    expect(harness.activeLeaseIds()).toEqual(["lease-1"]);
    expect(harness.alarm()).toBe(expiresAt);
    expect(harness.fetches()).toBe(1);

    // An exact replay of the same lease is idempotent and reads the cached
    // snapshot: no second Convex fetch, no second lease.
    const replay = await harness.instance.snapshotWithFenceLease({
      lease: lease({ generation }),
      now: NOW + 1_000,
    });
    expect(replay.lease).toMatchObject({ status: "registered", generation });
    expect(harness.activeLeaseIds()).toEqual(["lease-1"]);
    expect(harness.fetches()).toBe(1);
  });

  test("skips the register when the snapshot does not authorize the caller", async () => {
    const stale = open();
    const staleResult = await stale.instance.snapshotWithFenceLease({
      lease: lease({ ownerGeneration: "generation-0" }),
      now: NOW,
    });
    expect(staleResult.snapshot?.ownerGeneration).toBe("generation-1");
    expect(staleResult.lease).toEqual({
      status: "skipped",
      reason: "generation_stale",
    });
    expect(stale.activeLeaseIds()).toEqual([]);
    expect(stale.values.has("ownerPurgeFence")).toBe(false);

    const fenced = open({
      snapshot: sampleOwnerSnapshot({ writable: false }),
    });
    const fencedResult = await fenced.instance.snapshotWithFenceLease({
      lease: lease(),
      now: NOW,
    });
    expect(fencedResult.snapshot?.writable).toBe(false);
    expect(fencedResult.lease).toEqual({
      status: "skipped",
      reason: "not_writable",
    });
    expect(fenced.activeLeaseIds()).toEqual([]);
  });

  test("passes a fence refusal through with the fence's own status and code", async () => {
    const harness = open();
    harness.values.set("ownerPurgeFence", {
      ownerId: "owner-1",
      generation: "fence-generation-blocked",
      state: "blocked",
      mode: "temporary",
      leaseStorageVersion: 2,
      active: {},
    });
    const result = await harness.instance.snapshotWithFenceLease({
      lease: lease(),
      now: NOW,
    });
    expect(result.snapshot?.ownerGeneration).toBe("generation-1");
    expect(result.lease).toEqual({
      status: "refused",
      httpStatus: 409,
      code: "owner_purge_temporary",
      error: "Owner purge is active.",
    });
    expect(harness.activeLeaseIds()).toEqual([]);
  });

  test("returns a snapshot failure as a value and registers nothing", async () => {
    const unavailable = open({
      fetch: async () => {
        throw new OwnerGateSnapshotError("internal", "convex is down", true);
      },
    });
    const failed = await unavailable.instance.snapshotWithFenceLease({
      lease: lease(),
      now: NOW,
    });
    expect(failed).toEqual({
      snapshot: null,
      snapshotError: {
        code: "internal",
        message: "convex is down",
        retryable: true,
      },
      lease: { status: "skipped", reason: "snapshot_unavailable" },
    });
    expect(unavailable.activeLeaseIds()).toEqual([]);
    expect(unavailable.values.has("ownerPurgeFence")).toBe(false);

    const purged = open({
      fetch: async () => {
        throw new OwnerGateSnapshotError("owner_purged", "gone", false);
      },
    });
    const gone = await purged.instance.snapshotWithFenceLease({
      lease: lease(),
      now: NOW,
    });
    expect(gone.snapshot).toBeNull();
    expect(gone.snapshotError).toEqual({
      code: "owner_purged",
      message: "gone",
      retryable: false,
    });
  });
});

describe("OwnerGate.admitWithFenceLease", () => {
  const input = () => ({
    admission: {
      lane: "chat" as const,
      turnId: lease().turnId,
      conversationId: "conversation-1",
      now: NOW,
    },
    lease: lease(),
  });
  test("admits and registers once, replay preserves the exact lease", async () => {
    const h = open();
    const first = await h.instance.admitWithFenceLease(input());
    expect(first.admission.ok).toBe(true);
    expect(first.lease.status).toBe("registered");
    const replay = await h.instance.admitWithFenceLease(input());
    expect(replay.admission).toMatchObject({ ok: true, replayed: true });
    expect(h.activeLeaseIds()).toEqual(["lease-1"]);
  });
  test("suspension and service generation mismatch never register", async () => {
    const suspended = open({
      snapshot: sampleOwnerSnapshot({ enforcement: { status: "suspended" } }),
    });
    expect(
      (await suspended.instance.admitWithFenceLease(input())).admission,
    ).toMatchObject({ ok: false, code: "owner_suspended" });
    expect(suspended.activeLeaseIds()).toEqual([]);
    const h = open();
    const args = input();
    const result = await h.instance.admitWithFenceLease({
      ...args,
      admission: { ...args.admission, expectedGeneration: "old" },
    });
    expect(result.admission).toMatchObject({
      ok: false,
      code: "generation_stale",
    });
    expect(h.activeLeaseIds()).toEqual([]);
  });
  test("user generation rotation returns a current snapshot but never registers the old lease", async () => {
    const h = open({
      snapshot: sampleOwnerSnapshot({ ownerGeneration: "generation-2" }),
    });
    const result = await h.instance.admitWithFenceLease(input());
    expect(result.admission).toMatchObject({
      ok: true,
      snapshot: { ownerGeneration: "generation-2" },
    });
    expect(result.lease).toEqual({
      status: "skipped",
      reason: "generation_stale",
    });
    expect(h.activeLeaseIds()).toEqual([]);
  });
});
