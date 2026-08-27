import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { linkedSourcePurgeOperationId } from "./auth_migration_paths";
import { purgeOwnerMigrationSourceDependencies } from "./owner_migration_purge";

const fence = {
  ownerId: "destination-owner",
  operationId: "destination-operation",
  generation: "destination-generation",
  leaseId: "destination-lease",
  mode: "reset" as const,
};

describe("linked auth-migration source purge orchestration", () => {
  it("permanently purges an open source, then requires exact dependency readback", async () => {
    const sourceOwnerId = "source-owner";
    const childOperationId = await linkedSourcePurgeOperationId(
      fence.operationId,
      sourceOwnerId,
    );
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        sourceOwnerIds: [sourceOwnerId],
        sourceDependencies: [{ ownerId: sourceOwnerId }],
        waitingSourceOwnerIds: [],
        hasMore: false,
      })
      .mockResolvedValueOnce(Date.now() + 60_000)
      .mockResolvedValueOnce({
        operationId: childOperationId,
        generation: "source-generation",
        mode: "delete",
        stage: "core",
      })
      .mockResolvedValueOnce({
        sourceOwnerIds: [],
        sourceDependencies: [],
        waitingSourceOwnerIds: [],
        hasMore: false,
      });
    const runAction = vi.fn().mockResolvedValue(null);
    const ctx = { runMutation, runAction } as unknown as ActionCtx;

    await expect(
      purgeOwnerMigrationSourceDependencies(ctx, fence),
    ).resolves.toBeUndefined();

    expect(runMutation).toHaveBeenCalledTimes(4);
    expect(runMutation.mock.calls[0]?.[1]).toEqual(fence);
    expect(runMutation.mock.calls[1]?.[1]).toMatchObject({
      ...fence,
      stage: "core",
    });
    expect(runMutation.mock.calls[2]?.[1]).toEqual({
      ownerId: sourceOwnerId,
      operationId: childOperationId,
      mode: "delete",
      now: expect.any(Number),
    });
    expect(runMutation.mock.calls[3]?.[1]).toEqual(fence);
    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction.mock.calls[0]?.[1]).toEqual({
      ownerId: sourceOwnerId,
      operationId: childOperationId,
      generation: "source-generation",
    });
  });

  it("fails closed without joining a source purge that is already active", async () => {
    const runMutation = vi.fn().mockResolvedValue({
      sourceOwnerIds: [],
      sourceDependencies: [],
      waitingSourceOwnerIds: ["source-owner"],
      hasMore: false,
    });
    const runAction = vi.fn();
    const ctx = { runMutation, runAction } as unknown as ActionCtx;

    await expect(
      purgeOwnerMigrationSourceDependencies(ctx, fence),
    ).rejects.toThrow(/waiting for a linked source-owner purge/i);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("propagates child failure so the destination mapping remains retry debt", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        sourceOwnerIds: ["source-owner"],
        sourceDependencies: [{ ownerId: "source-owner" }],
        waitingSourceOwnerIds: [],
        hasMore: false,
      })
      .mockResolvedValueOnce(Date.now() + 60_000)
      .mockResolvedValueOnce({
        operationId: "existing-source-delete",
        generation: "source-generation",
        mode: "delete",
        stage: "cloud",
      });
    const runAction = vi.fn().mockRejectedValue(new Error("source failed"));
    const ctx = { runMutation, runAction } as unknown as ActionCtx;

    await expect(
      purgeOwnerMigrationSourceDependencies(ctx, fence),
    ).rejects.toThrow("source failed");
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(runAction).toHaveBeenCalledOnce();
  });
});
