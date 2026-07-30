import { describe, expect, test } from "bun:test";
import {
  OWNER_PRODUCT_TRANSFER_LEASE_MS,
  OWNER_TRANSFER_OBJECT_LIMIT,
  collectCheckpointRecoveryReferences,
  createOwnerTransferBudget,
  importedCheckpointDescriptor,
  ownerTransferLeaseConflicts,
  parseOwnerProductTransferRequest,
  replaceOwnerPrefix,
  resolveWorkspaceTransfer,
  takeOwnerTransferBatch,
  transferredBackupId,
} from "../src/owner-product-transfer.js";

describe("owner product transfer", () => {
  test("accepts bounded same-kind workspace moves", () => {
    expect(
      parseOwnerProductTransferRequest({
        fromOwnerId: " anonymous-owner ",
        toOwnerId: "connected-owner",
        agentHome: true,
        interiors: false,
        workspaces: [
          { from: "cloud", to: "drive" },
          {
            from: "project:old",
            to: "project:imported",
            importedTo: "project:imported-recovery",
          },
        ],
        appSlugs: ["notes"],
      }),
    ).toEqual({
      fromOwnerId: "anonymous-owner",
      toOwnerId: "connected-owner",
      agentHome: true,
      interiors: false,
      workspaces: [
        { from: "drive", to: "drive" },
        {
          from: "project:old",
          to: "project:imported",
          importedTo: "project:imported-recovery",
        },
      ],
      appSlugs: ["notes"],
    });
  });

  test("routes a colliding checkpoint to a normal project workspace", () => {
    const transfer = {
      from: "stella",
      to: "stella",
      importedTo: "project:stella-imported-abc123",
    };
    expect(resolveWorkspaceTransfer(transfer, false)).toEqual({
      from: "stella",
      requestedTo: "stella",
      resolvedTo: "stella",
      imported: false,
    });
    expect(resolveWorkspaceTransfer(transfer, true)).toEqual({
      from: "stella",
      requestedTo: "stella",
      resolvedTo: "project:stella-imported-abc123",
      imported: true,
    });
    expect(
      resolveWorkspaceTransfer({ from: "drive", to: "drive" }, true),
    ).toBeNull();
  });

  test("rejects cross-kind moves and unbounded manifests", () => {
    expect(
      parseOwnerProductTransferRequest({
        fromOwnerId: "anonymous-owner",
        toOwnerId: "connected-owner",
        agentHome: false,
        interiors: false,
        workspaces: [{ from: "drive", to: "project:drive" }],
        appSlugs: [],
      }),
    ).toBeNull();
    expect(
      parseOwnerProductTransferRequest({
        fromOwnerId: "anonymous-owner",
        toOwnerId: "connected-owner",
        agentHome: false,
        interiors: false,
        workspaces: [],
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
});
