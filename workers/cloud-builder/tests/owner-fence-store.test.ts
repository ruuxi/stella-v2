import { afterEach, describe, expect, test } from "bun:test";
import {
  OWNER_FENCE_LEGACY_GRACE_MS,
  OwnerFenceLeaseValidationError,
  OwnerFenceStore,
  ownerFenceLeaseToLegacyLease,
  type LegacyOwnerFenceActiveMirror,
  type OwnerFenceLeaseIdentity,
  type OwnerFenceLeaseRegistration,
} from "../src/owner-fence-store.js";
import {
  openSqlStorageFake,
  type SqlStorageFake,
} from "./fixtures/sql-storage.js";

const NOW = 1_800_000_000_000;
const opened: SqlStorageFake[] = [];

afterEach(() => {
  while (opened.length) opened.pop()?.close();
});

const openStore = (
  options?: ConstructorParameters<typeof OwnerFenceStore>[1],
) => {
  const fake = openSqlStorageFake();
  opened.push(fake);
  const store = new OwnerFenceStore(fake.sql, options);
  store.initialize(NOW);
  return store;
};

const registration = (
  leaseId: string,
  overrides: Partial<OwnerFenceLeaseRegistration> = {},
): OwnerFenceLeaseRegistration => ({
  leaseId,
  ownerId: "owner-1",
  ownerGeneration: "owner-generation-1",
  reservationGeneration: "fence-generation-1",
  sessionId: "session-1",
  turnId: "turn-1",
  namespace: "build",
  role: "run",
  expiresAt: NOW + 60_000,
  ...overrides,
});

const identityOf = (
  value: OwnerFenceLeaseRegistration,
): OwnerFenceLeaseIdentity => ({
  leaseId: value.leaseId,
  ownerId: value.ownerId,
  ownerGeneration: value.ownerGeneration,
  reservationGeneration: value.reservationGeneration,
  sessionId: value.sessionId,
  turnId: value.turnId,
  namespace: value.namespace,
  role: value.role,
});

describe("owner fence SQLite store", () => {
  test("initializes idempotently and registers one exact replay", () => {
    const store = openStore();
    store.initialize(NOW + 1);
    const input = registration("lease-1");

    const first = store.registerLeaseExact(input, NOW);
    const replay = store.registerLeaseExact(input, NOW + 1);
    const conflict = store.registerLeaseExact(
      { ...input, turnId: "successor-turn" },
      NOW + 2,
    );

    expect(first.status).toBe("registered");
    expect(replay.status).toBe("replayed");
    expect(conflict).toMatchObject({
      status: "conflict",
      code: "lease_id_conflict",
    });
    expect(store.activeLeaseCount(NOW + 2)).toBe(1);
    expect(store.activeLease("lease-1", NOW + 2)).toMatchObject({
      leaseId: "lease-1",
      state: "active",
      expiresAt: NOW + 60_000,
    });
  });

  test("enforces one active world slot and frees it through expiry", () => {
    const store = openStore();
    const first = registration("world-1", {
      namespace: "build",
      role: "world",
      worldSlot: 1,
      expiresAt: NOW + 1_000,
    });
    const second = registration("world-2", {
      namespace: "build",
      role: "world",
      worldSlot: 1,
      sessionId: "session-2",
      turnId: "turn-2",
      expiresAt: NOW + 60_000,
    });

    expect(store.registerLeaseExact(first, NOW).status).toBe("registered");
    expect(store.registerLeaseExact(second, NOW)).toMatchObject({
      status: "conflict",
      code: "world_busy",
      existing: { leaseId: "world-1" },
    });
    expect(store.nextExpiry()).toBe(NOW + 1_000);

    expect(store.registerLeaseExact(second, NOW + 1_001).status).toBe(
      "registered",
    );
    expect(store.lease("world-1")).toMatchObject({
      state: "retired",
      retiredAt: NOW + 1_001,
    });
    expect(
      store.activeLeases(NOW + 1_001).map((lease) => lease.leaseId),
    ).toEqual(["world-2"]);
  });

  test("backs world exclusivity with a partial SQLite unique index", () => {
    const fake = openSqlStorageFake();
    opened.push(fake);
    const store = new OwnerFenceStore(fake.sql);
    store.initialize(NOW);
    store.registerLeaseExact(
      registration("world-index-1", {
        namespace: "activity",
        role: "world",
        worldSlot: 1,
      }),
      NOW,
    );

    expect(() =>
      fake.sql.exec(
        `INSERT INTO owner_fence_leases (
           lease_id, owner_id, owner_generation, reservation_generation,
           session_id, turn_id, namespace, role, state, expires_at,
           world_slot, created_at, renewed_at, retired_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'activity', 'world', 'active', ?, 1, ?, ?, NULL)`,
        "world-index-2",
        "owner-1",
        "owner-generation-1",
        "fence-generation-1",
        "session-2",
        "turn-2",
        NOW + 60_000,
        NOW,
        NOW,
      ),
    ).toThrow();
  });

  test("requires world role and slot to agree", () => {
    const store = openStore();
    expect(() =>
      store.registerLeaseExact(
        registration("bad-world", {
          namespace: "activity",
          role: "world",
        }),
        NOW,
      ),
    ).toThrow(OwnerFenceLeaseValidationError);
    expect(() =>
      store.registerLeaseExact(registration("bad-run", { worldSlot: 1 }), NOW),
    ).toThrow(OwnerFenceLeaseValidationError);
  });

  test("renews only an exact live identity and never resurrects expiry", () => {
    const store = openStore();
    const input = registration("lease-renew", { expiresAt: NOW + 1_000 });
    store.registerLeaseExact(input, NOW);

    expect(
      store.renewLeaseExact(
        { ...identityOf(input), turnId: "wrong-turn" },
        NOW + 20_000,
        NOW + 100,
      ),
    ).toMatchObject({ status: "identity_mismatch" });
    expect(
      store.renewLeaseExact(identityOf(input), NOW + 30_000, NOW + 200),
    ).toMatchObject({
      status: "renewed",
      lease: { expiresAt: NOW + 30_000, renewedAt: NOW + 200 },
    });

    expect(
      store.renewLeaseExact(identityOf(input), NOW + 80_000, NOW + 30_001),
    ).toMatchObject({
      status: "expired",
      existing: { state: "retired", retiredAt: NOW + 30_001 },
    });
    expect(store.activeLease("lease-renew", NOW + 30_001)).toBeNull();
  });

  test("retires exact identities idempotently without retiring a successor", () => {
    const store = openStore();
    const input = registration("lease-retire");
    store.registerLeaseExact(input, NOW);

    expect(
      store.retireLeaseExact(
        { ...identityOf(input), ownerGeneration: "successor-generation" },
        NOW + 1,
      ),
    ).toMatchObject({ status: "identity_mismatch" });
    expect(store.activeLease("lease-retire", NOW + 1)).not.toBeNull();

    expect(store.retireLeaseExact(identityOf(input), NOW + 2)).toMatchObject({
      status: "retired",
      lease: { state: "retired", retiredAt: NOW + 2 },
    });
    expect(store.retireLeaseExact(identityOf(input), NOW + 3)).toMatchObject({
      status: "already_retired",
    });
    expect(store.registerLeaseExact(input, NOW + 4)).toMatchObject({
      status: "conflict",
      code: "lease_retired",
    });
  });

  test("migrates a legacy active mirror with bounded expiries and exact replay", () => {
    const store = openStore();
    const active: LegacyOwnerFenceActiveMirror = {
      "legacy-live": {
        leaseId: "legacy-live",
        sessionId: "legacy-session",
        turnId: "legacy-turn",
        namespace: "build",
        role: "run",
        ownerGeneration: "owner-generation-1",
      },
      "legacy-expired": {
        leaseId: "legacy-expired",
        sessionId: "expired-session",
        turnId: "expired-turn",
        namespace: "activity",
        role: "activity",
        ownerGeneration: "owner-generation-1",
        expiresAt: NOW - 1,
      },
      "legacy-invalid": {
        leaseId: "legacy-invalid",
        sessionId: "invalid-session",
        turnId: "invalid-turn",
        namespace: "build",
        role: "aux",
      },
    };

    expect(
      store.migrateLegacyActiveMirror({
        ownerId: "owner-1",
        fenceGeneration: "fence-generation-1",
        active,
        now: NOW,
      }),
    ).toEqual({
      inserted: 1,
      replayed: 0,
      expired: 1,
      invalid: ["legacy-invalid"],
      conflicts: [],
    });
    expect(store.lease("legacy-live")).toMatchObject({
      reservationGeneration: "fence-generation-1",
      expiresAt: NOW + OWNER_FENCE_LEGACY_GRACE_MS,
    });
    expect(
      store.migrateLegacyActiveMirror({
        ownerId: "owner-1",
        fenceGeneration: "fence-generation-1",
        active: { "legacy-live": active["legacy-live"]! },
        now: NOW + 1,
      }),
    ).toMatchObject({ inserted: 0, replayed: 1, conflicts: [] });
  });

  test("builds rollback mirrors without truncating and maps world to build/run", () => {
    const store = openStore();
    const world = registration("world-mirror", {
      namespace: "build",
      role: "world",
      worldSlot: 1,
    });
    store.registerLeaseExact(world, NOW);
    store.registerLeaseExact(registration("ordinary-mirror"), NOW);

    expect(ownerFenceLeaseToLegacyLease(store.lease("world-mirror")!)).toEqual({
      leaseId: "world-mirror",
      sessionId: "session-1",
      turnId: "turn-1",
      namespace: "build",
      role: "run",
      ownerGeneration: "owner-generation-1",
      reservationGeneration: "fence-generation-1",
      expiresAt: NOW + 60_000,
    });
    expect(store.boundedLegacyActiveMirror(NOW, 1)).toEqual({
      status: "too_many_active_leases",
      activeLeaseCount: 2,
      maxEntries: 1,
    });
    const complete = store.boundedLegacyActiveMirror(NOW, 2);
    expect(complete.status).toBe("complete");
    if (complete.status === "complete") {
      expect(Object.keys(complete.active).sort()).toEqual([
        "ordinary-mirror",
        "world-mirror",
      ]);
    }
  });

  test("rejects lease expiries beyond the configured bound", () => {
    const store = openStore({ maxLeaseMs: 5_000 });
    expect(() =>
      store.registerLeaseExact(
        registration("too-long", { expiresAt: NOW + 5_001 }),
        NOW,
      ),
    ).toThrow("expiresAt is out of bounds");
  });
});
