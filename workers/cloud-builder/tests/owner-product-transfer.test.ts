import { describe, expect, test } from "bun:test";
import {
  OWNER_PRODUCT_TRANSFER_LEASE_MS,
  OWNER_TRANSFER_OBJECT_LIMIT,
  assertOwnerTransferReservation,
  collectCheckpointRecoveryReferences,
  createOwnerTransferBudget,
  importedCheckpointDescriptor,
  isValidOwnerTransferPrefixPair,
  missingOwnerProductTransferBinding,
  ownerTransferLeaseConflicts,
  parseOwnerProductTransferRequest,
  replaceOwnerPrefix,
  takeOwnerTransferBatch,
  transferredBackupId,
} from "../src/owner-product-transfer.js";

const control = {
  migrationId: "migration-1",
  leaseId: "lease-1",
  leaseGeneration: 0,
  stage: "product-transfer",
  planRevision: 1,
  fromOwnerGeneration: "from-generation-1",
  toOwnerGeneration: "to-generation-1",
};

describe("owner product transfer", () => {
  test("accepts a bounded move of the one world", () => {
    expect(
      parseOwnerProductTransferRequest({
        ...control,
        fromOwnerId: " anonymous-owner ",
        toOwnerId: "connected-owner",
        agentHome: true,
        world: true,
        appSlugs: ["notes"],
      }),
    ).toEqual({
      ...control,
      fromOwnerId: "anonymous-owner",
      toOwnerId: "connected-owner",
      agentHome: true,
      world: true,
      appSlugs: ["notes"],
    });
  });

  test("rejects an absent world flag and unbounded manifests", () => {
    expect(
      parseOwnerProductTransferRequest({
        ...control,
        fromOwnerId: "anonymous-owner",
        toOwnerId: "connected-owner",
        agentHome: false,
        appSlugs: [],
      }),
    ).toBeNull();
    expect(
      parseOwnerProductTransferRequest({
        ...control,
        fromOwnerId: "anonymous-owner",
        toOwnerId: "connected-owner",
        agentHome: false,
        world: false,
        appSlugs: ["a", "b", "c", "d", "e"],
      }),
    ).toBeNull();
  });

  test("derives stable distinct backup ids and owner-prefixed keys", async () => {
    const first = await transferredBackupId(
      "ws:source",
      "ws:destination",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    const retry = await transferredBackupId(
      "ws:source",
      "ws:destination",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    const other = await transferredBackupId(
      "ws:source",
      "ws:destination",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
    expect(first).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
    expect(
      replaceOwnerPrefix(
        "agent-home/source/memories/MEMORY.md",
        "agent-home/source/",
        "agent-home/destination/",
      ),
    ).toBe("agent-home/destination/memories/MEMORY.md");
    expect(
      replaceOwnerPrefix("other/source", "agent-home/source/", "next/"),
    ).toBeNull();
  });

  test("bounds the exclusive lease beyond one control-plane request", () => {
    expect(OWNER_PRODUCT_TRANSFER_LEASE_MS).toBeGreaterThan(150_000);
    expect(OWNER_PRODUCT_TRANSFER_LEASE_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  test("rejects every distinct transfer lease but permits exact replay", () => {
    const active = {
      leaseId: "lease-a",
      sessionId: "transfer-a",
      turnId: "owner-product-transfer:a",
    };
    expect(ownerTransferLeaseConflicts(active, { ...active })).toBe(false);
    expect(
      ownerTransferLeaseConflicts(active, {
        ...active,
        leaseId: "lease-b",
      }),
    ).toBe(true);
    expect(
      ownerTransferLeaseConflicts(active, {
        ...active,
        sessionId: "transfer-b",
      }),
    ).toBe(true);
    expect(
      ownerTransferLeaseConflicts(active, {
        ...active,
        turnId: "owner-product-transfer:b",
      }),
    ).toBe(true);
  });

  test("preserves a colliding source checkpoint under a recoverable descriptor", () => {
    const connectedCheckpoint = {
      id: "11111111-1111-1111-1111-111111111111",
      name: "stella-connected",
    };
    const anonymousCheckpoint = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "stella-anonymous",
      metadata: { workspace: "project:notes" },
    };
    const imported = importedCheckpointDescriptor(
      anonymousCheckpoint,
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      connectedCheckpoint.name,
    );
    expect(connectedCheckpoint).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      name: "stella-connected",
    });
    expect(imported).toEqual({
      ...anonymousCheckpoint,
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      name: "stella-connected-import-bbbbbbbb",
    });

    expect(
      collectCheckpointRecoveryReferences({
        descriptorId: connectedCheckpoint.id,
        debtBackupIds: ["22222222-2222-2222-2222-222222222222"],
        historicalBackupName: "stella-connected",
        imports: [
          {
            descriptorId: imported!.id,
            backupIds: [imported!.id, "cccccccc-cccc-cccc-cccc-cccccccccccc"],
            historicalBackupName: "stella-anonymous",
          },
        ],
      }),
    ).toEqual({
      backupIds: [
        connectedCheckpoint.id,
        "22222222-2222-2222-2222-222222222222",
        imported!.id,
        "cccccccc-cccc-cccc-cccc-cccccccccccc",
      ],
      historicalBackupNames: ["stella-connected", "stella-anonymous"],
    });
  });

  test("advances more than 200 objects in bounded retry batches", () => {
    const pending = Array.from({ length: 451 }, (_, index) => index);
    const firstBudget = createOwnerTransferBudget();
    const first = takeOwnerTransferBatch(pending, firstBudget);
    expect(first).toHaveLength(OWNER_TRANSFER_OBJECT_LIMIT);
    expect(firstBudget.remaining).toBe(0);
    expect(
      takeOwnerTransferBatch(pending.slice(first.length), firstBudget),
    ).toEqual([]);

    const secondBudget = createOwnerTransferBudget();
    const second = takeOwnerTransferBatch(
      pending.slice(first.length),
      secondBudget,
    );
    expect(second).toHaveLength(OWNER_TRANSFER_OBJECT_LIMIT);
    expect(second[0]).toBe(200);

    const thirdBudget = createOwnerTransferBudget();
    const third = takeOwnerTransferBatch(
      pending.slice(first.length + second.length),
      thirdBudget,
    );
    expect(third).toHaveLength(51);
    expect(thirdBudget.remaining).toBe(149);
  });

  test("requires AGENT_HOME exactly when requested", () => {
    expect(
      missingOwnerProductTransferBinding(
        { agentHome: true },
        { agentHome: false },
      ),
    ).toBe("AGENT_HOME");
    expect(
      missingOwnerProductTransferBinding(
        { agentHome: false },
        { agentHome: false },
      ),
    ).toBeNull();
  });

  test("reset/delete waits for an exact reservation but rejects impostors", () => {
    const reservation = {
      role: "transfer",
      leaseId: "reservation-1",
      sessionId: "coordinator-1",
      turnId: "owner-transfer:operation-1",
      ownerGeneration: "owner-generation-1",
    };
    expect(
      assertOwnerTransferReservation(reservation, reservation, {
        state: "blocked",
        mode: "permanent",
      }),
    ).toEqual({ ok: true });
    expect(
      assertOwnerTransferReservation(
        reservation,
        { ...reservation, ownerGeneration: "stale-generation" },
        { state: "blocked", mode: "permanent" },
      ),
    ).toEqual({ ok: false, code: "owner_purge_permanent" });
    expect(
      assertOwnerTransferReservation(undefined, reservation, {
        state: "blocked",
        mode: "temporary",
      }),
    ).toEqual({ ok: false, code: "owner_purge_temporary" });
  });

  test("accepts only exact owner namespace mappings", () => {
    const from = "a".repeat(64);
    const to = "b".repeat(64);
    expect(
      isValidOwnerTransferPrefixPair(`builds/${from}/`, `builds/${to}/`),
    ).toBe(true);
    expect(
      isValidOwnerTransferPrefixPair(
        `builds/${from}/app/`,
        `builds/${to}/app/`,
      ),
    ).toBe(false);
  });
});
