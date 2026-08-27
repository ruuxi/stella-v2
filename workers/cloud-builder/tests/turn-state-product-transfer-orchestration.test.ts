import { describe, expect, test } from "bun:test";
import { advanceDurableTurnStateWorkspaceTransfer } from "../src/turn-state-product-transfer.js";
import type {
  DurableTurnStateTransferManifest,
  DurableWorkspaceTransferPlan,
} from "../src/owner-transfer-coordinator.js";

const hash = (character: string): string => character.repeat(64);

describe("product transfer atomic workspace orchestration", () => {
  test("copies one bounded page per pass and activates only after the durable final cursor", async () => {
    const manifest: DurableTurnStateTransferManifest = {
      schemaVersion: 1,
      transferOperationId: hash("a"),
      sourceOwnerHash: hash("b"),
      sourceOwnerGeneration: "source-generation",
      sourceWorkspaceHash: hash("c"),
      destinationOwnerHash: hash("d"),
      destinationOwnerGeneration: "destination-generation",
      destinationWorkspaceHash: hash("e"),
      count: 17,
      fingerprint: hash("f"),
    };
    const plan: DurableWorkspaceTransferPlan = {
      workspacePlanId: hash("1"),
      resolution: {
        from: "project:source",
        requestedTo: "project:destination",
        resolvedTo: "project:destination",
        imported: false,
      },
      sourceStateMarker: "sha256:source",
      initialResolvedDestinationMarker: "absent",
      expectedResolvedDestinationMarker: "sha256:destination",
      state: "planned",
    };
    const exportedCursors: number[] = [];
    const staged: number[] = [];
    let activated = 0;
    const operations = {
      exportPage: async (cursor: number, limit: number) => {
        exportedCursors.push(cursor);
        const count = Math.min(limit, manifest.count - cursor);
        return {
          manifest,
          entries: Array.from({ length: count }, (_, offset) => ({
            ordinal: cursor + offset,
          })),
          ...(cursor + count < manifest.count
            ? { nextCursor: cursor + count }
            : {}),
        };
      },
      stageEntry: async (_manifest: unknown, entry: { ordinal: number }) => {
        staged.push(entry.ordinal);
      },
      activate: async () => {
        activated += 1;
        return {
          manifestFingerprint: manifest.fingerprint,
          count: manifest.count,
          activationReceipt: hash("2"),
        };
      },
      persistExported: async () => ({
        manifest,
        cursor: 0,
        phase: "staging" as const,
      }),
      persistStaged: async ({ nextCursor }: { nextCursor: number }) => ({
        manifest,
        cursor: nextCursor,
        phase: "staging" as const,
      }),
      persistActivated: async ({
        activationReceipt,
      }: {
        activationReceipt: string;
      }) => ({
        manifest,
        cursor: manifest.count,
        phase: "activated" as const,
        activationReceipt,
      }),
    };

    const first = await advanceDurableTurnStateWorkspaceTransfer({
      plan,
      sourcePresent: true,
      operations: operations as never,
    });
    expect(first.complete).toBe(false);
    expect(first.plan.turnState?.cursor).toBe(16);
    expect(activated).toBe(0);

    const second = await advanceDurableTurnStateWorkspaceTransfer({
      plan,
      sourcePresent: true,
      operations: operations as never,
    });
    expect(second.complete).toBe(true);
    expect(second.plan.turnState?.phase).toBe("activated");
    expect(exportedCursors).toEqual([0, 16]);
    expect(staged).toEqual(Array.from({ length: 17 }, (_, index) => index));
    expect(activated).toBe(1);
  });

  test("retries activation after the final staged cursor and a lost activation response", async () => {
    const manifest: DurableTurnStateTransferManifest = {
      schemaVersion: 1,
      transferOperationId: hash("1"),
      sourceOwnerHash: hash("2"),
      sourceOwnerGeneration: "source-owner-generation",
      sourceWorkspaceHash: hash("3"),
      destinationOwnerHash: hash("4"),
      destinationOwnerGeneration: "destination-owner-generation",
      destinationWorkspaceHash: hash("5"),
      count: 2,
      fingerprint: hash("6"),
    };
    const plan: DurableWorkspaceTransferPlan = {
      workspacePlanId: hash("7"),
      resolution: {
        from: "project:source",
        requestedTo: "project:destination",
        resolvedTo: "project:destination",
        imported: false,
      },
      sourceStateMarker: "sha256:source",
      initialResolvedDestinationMarker: "absent",
      expectedResolvedDestinationMarker: "sha256:destination",
      state: "planned",
      turnState: { manifest, cursor: manifest.count, phase: "staging" },
    };

    let destinationActivated = false;
    let loseFirstActivationResponse = true;
    let activationCalls = 0;
    let exportCalls = 0;
    let stageCalls = 0;
    const operations = {
      exportPage: async () => {
        exportCalls += 1;
        throw new Error("a complete staging cursor must not export again");
      },
      stageEntry: async () => {
        stageCalls += 1;
      },
      activate: async () => {
        activationCalls += 1;
        destinationActivated = true;
        if (loseFirstActivationResponse) {
          loseFirstActivationResponse = false;
          throw new Error("simulated lost activation response");
        }
        return {
          manifestFingerprint: manifest.fingerprint,
          count: manifest.count,
          activationReceipt: hash("8"),
        };
      },
      persistExported: async () => {
        throw new Error("already exported");
      },
      persistStaged: async () => {
        throw new Error("already staged");
      },
      persistActivated: async ({
        activationReceipt,
      }: {
        activationReceipt: string;
      }) => {
        if (!destinationActivated) throw new Error("destination not activated");
        return {
          manifest,
          cursor: manifest.count,
          phase: "activated" as const,
          activationReceipt,
        };
      },
    };

    await expect(
      advanceDurableTurnStateWorkspaceTransfer({
        plan,
        sourcePresent: true,
        operations: operations as never,
      }),
    ).rejects.toThrow("simulated lost activation response");
    expect(plan.turnState).toMatchObject({
      phase: "staging",
      cursor: manifest.count,
    });

    const recovered = await advanceDurableTurnStateWorkspaceTransfer({
      plan,
      sourcePresent: true,
      operations: operations as never,
    });
    expect(recovered.complete).toBe(true);
    expect(recovered.plan.turnState).toMatchObject({
      phase: "activated",
      cursor: manifest.count,
      activationReceipt: hash("8"),
    });
    expect(activationCalls).toBe(2);
    expect(exportCalls).toBe(0);
    expect(stageCalls).toBe(0);
  });
});
