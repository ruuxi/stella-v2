import { describe, expect, test } from "bun:test";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";
import { GATEWAY_UPSTREAM_MAX_DURATION_MS } from "@stella/contracts/gateway/api";
import {
  OwnerModelGrantError,
  OwnerModelGrantStore,
  type OwnerModelGrantIdentity,
} from "../src/owner-model-grants.js";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";

const policy: MemoryPolicy = {
  ownerGeneration: "owner-generation",
  memoryEpoch: "epoch-1",
  memoryEnabled: true,
  revision: 3,
  updatedAt: 10,
};

const state = () => {
  const sql = openSqlStorageFake();
  let alarm: number | null = null;
  const ctx = {
    storage: {
      sql: sql.sql,
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
    },
  } as unknown as DurableObjectState;
  let now = 1_000;
  return {
    ctx,
    close: sql.close,
    alarm: () => alarm,
    advance: (ms: number) => {
      now += ms;
    },
    store: () => new OwnerModelGrantStore(ctx, "owner-1", () => now),
  };
};

const identity = (
  overrides: Partial<OwnerModelGrantIdentity> = {},
): OwnerModelGrantIdentity => ({
  ownerId: "owner-1",
  ownerGeneration: policy.ownerGeneration,
  conversationId: "conversation-1",
  turnId: "turn-1",
  leaseId: "lease-1",
  fenceGeneration: "fence-1",
  memoryPolicy: policy,
  readerId: "reader-a",
  grantId: "grant-1",
  expiresAt: 10_000,
  ...overrides,
});

describe("owner model grant store", () => {
  test("retains expired dispatch grants through the maximum active provider lifetime", async () => {
    const f = state();
    try {
      const store = f.store();
      await store.registerReader({ conversationId: "conversation-1", readerId: "reader-a" });
      await store.issueGrant(identity());
      f.advance(10_000);
      expect((await store.issueGrant(identity())).status).toBe("expired");
      const frozen: string[] = [];
      await store.revokeAll({ operationId: "after-expiry", reason: "memory_policy_change",
        freeze: async request => { frozen.push(...request.grants.map(grant => grant.grantId)); },
      });
      expect(frozen).toEqual(["grant-1"]);
      f.advance(GATEWAY_UPSTREAM_MAX_DURATION_MS);
      expect((await store.retireExactTurnLease({ ownerGeneration: policy.ownerGeneration,
        turnId: "turn-1", leaseId: "lease-1" })).retiredGrantIds).toEqual([]);
    } finally { f.close(); }
  });
  test("issues only to the latest registered reader nonce and replays the exact grant", async () => {
    const f = state();
    try {
      const store = f.store();
      await store.registerReader({
        conversationId: "conversation-1",
        readerId: "reader-a",
      });
      expect(
        (await store.issueGrant(identity({ readerId: "reader-old" }))).status,
      ).toBe("stale_reader");

      const issued = await store.issueGrant(identity());
      expect(issued.status).toBe("issued");
      if (issued.status !== "issued") throw new Error("expected issued");
      expect(issued.grant.readerId).toBe("reader-a");

      expect((await f.store().issueGrant(identity())).status).toBe("replayed");
      expect(
        (await store.issueGrant(identity({ leaseId: "different" }))).status,
      ).toBe("conflict");
    } finally {
      f.close();
    }
  });

  test("fence barrier persists replay body, closes issuance, rejects credential-shaped bodies, and arms retry", async () => {
    const f = state();
    try {
      const store = f.store();
      await store.registerReader({
        conversationId: "conversation-1",
        readerId: "reader-a",
      });
      const marker = await store.beginFenceBarrier({
        operationId: "op-1",
        path: "begin",
        body: { ownerId: "owner-1", requestId: "purge-1" },
      });
      expect(marker.body).toEqual({ ownerId: "owner-1", requestId: "purge-1" });
      expect(f.alarm()).toBe(6_000);
      expect(await store.issuanceOpen()).toBe(false);
      expect((await store.issueGrant(identity())).status).toBe("closed");
      await expect(
        store.beginFenceBarrier({
          operationId: "op-2",
          path: "begin",
          body: { authorization: "Bearer nope" },
        }),
      ).rejects.toMatchObject({ code: "FENCE_BARRIER_CREDENTIAL_FIELD" });
      expect(await store.completeFenceBarrier("op-1")).toBe(true);
      expect(await store.issuanceOpen()).toBe(true);
    } finally {
      f.close();
    }
  });

  test("revokeAll freezes each reader generation group and retains revoked rows until exact lease retirement", async () => {
    const f = state();
    try {
      const store = f.store();
      await store.registerReader({
        conversationId: "conversation-1",
        readerId: "reader-a",
      });
      await store.registerReader({
        conversationId: "conversation-2",
        readerId: "reader-b",
      });
      await store.issueGrant(
        identity({
          grantId: "grant-a",
          readerId: "reader-a",
          conversationId: "conversation-1",
        }),
      );
      await store.issueGrant(
        identity({
          grantId: "grant-b",
          readerId: "reader-b",
          conversationId: "conversation-2",
          turnId: "turn-2",
          leaseId: "lease-2",
        }),
      );
      const freezes: unknown[] = [];

      const revoked = await store.revokeAll({
        operationId: "change-1",
        reason: "memory_policy_change",
        ownerGeneration: policy.ownerGeneration,
        freeze: async (request) => {
          freezes.push(request);
        },
      });

      expect(revoked.revokedGrantIds.sort()).toEqual(["grant-a", "grant-b"]);
      expect(freezes).toEqual([
        {
          ownerId: "owner-1",
          ownerGeneration: policy.ownerGeneration,
          conversationId: "conversation-1",
          readerId: "reader-a",
          grants: [{ grantId: "grant-a", expiresAt: 10_000 }],
        },
        {
          ownerId: "owner-1",
          ownerGeneration: policy.ownerGeneration,
          conversationId: "conversation-2",
          readerId: "reader-b",
          grants: [{ grantId: "grant-b", expiresAt: 10_000 }],
        },
      ]);
      expect(
        (await store.issueGrant(identity({ grantId: "grant-a" }))).status,
      ).toBe("revoked");
      expect(
        await store.retireExactTurnLease({
          ownerGeneration: policy.ownerGeneration,
          turnId: "turn-1",
          leaseId: "lease-1",
        }),
      ).toEqual({ retiredGrantIds: ["grant-a"] });
      expect(
        (await store.issueGrant(identity({ grantId: "grant-a" }))).status,
      ).toBe("issued");
    } finally {
      f.close();
    }
  });

  test("lost freeze response leaves revoking grants for alarm retry", async () => {
    const f = state();
    try {
      const store = f.store();
      await store.registerReader({
        conversationId: "conversation-1",
        readerId: "reader-a",
      });
      await store.issueGrant(identity());
      let attempts = 0;
      await expect(
        store.revokeAll({
          operationId: "change-1",
          reason: "memory_policy_change",
          freeze: async () => {
            attempts += 1;
            throw new Error("lost response");
          },
        }),
      ).rejects.toBeInstanceOf(OwnerModelGrantError);
      expect(attempts).toBe(1);
      expect(f.alarm()).toBe(6_000);
      const retried = await store.revokeAll({
        operationId: "change-1",
        reason: "memory_policy_change",
        freeze: async () => {
          attempts += 1;
        },
      });
      expect(attempts).toBe(2);
      expect(retried.revokedGrantIds).toEqual(["grant-1"]);
    } finally {
      f.close();
    }
  });
});
