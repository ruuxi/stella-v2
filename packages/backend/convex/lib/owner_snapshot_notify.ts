import { makeFunctionReference } from "convex/server";
import type { OwnerSnapshotChangedRequest } from "@stella/contracts/turn-plane/owner-snapshot";

export type OwnerSnapshotChangeReason = OwnerSnapshotChangedRequest["reason"];

const notifyOwnerSnapshotChangedRef = makeFunctionReference<
  "action",
  { ownerId: string; reason: OwnerSnapshotChangeReason },
  null
>("owner_snapshot:notifyOwnerSnapshotChanged");

/**
 * Schedules a best-effort push of the cloud-builder owner-gate snapshot from
 * the mutation that changed it. The action computes the replacement after the
 * write is durable; if that fails, it sends a stale marker instead. The gate
 * still refreshes on its own TTL, so losing a push only costs staleness.
 */
export const scheduleOwnerSnapshotChanged = async (
  ctx: {
    scheduler: {
      runAfter: (
        delayMs: number,
        ref: typeof notifyOwnerSnapshotChangedRef,
        args: { ownerId: string; reason: OwnerSnapshotChangeReason },
      ) => Promise<unknown>;
    };
  },
  ownerId: string,
  reason: OwnerSnapshotChangeReason,
): Promise<void> => {
  await ctx.scheduler.runAfter(0, notifyOwnerSnapshotChangedRef, {
    ownerId,
    reason,
  });
};
