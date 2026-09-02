import { makeFunctionReference } from "convex/server";
import type { OwnerSnapshotChangedRequest } from "@stella/contracts/turn-plane/owner-snapshot";

export type OwnerSnapshotChangeReason = OwnerSnapshotChangedRequest["reason"];

const notifyOwnerSnapshotChangedRef = makeFunctionReference<
  "action",
  { ownerId: string; reason: OwnerSnapshotChangeReason },
  null
>("owner_snapshot:notifyOwnerSnapshotChanged");

/**
 * Best-effort push invalidation of the cloud-builder's owner-gate snapshot.
 * Scheduled from the mutation that changed the fact (plan, engine, owner
 * generation, pairing) so the push only fires once the change is durable. The
 * gate re-pulls on its own TTL regardless; losing a push costs staleness, not
 * correctness.
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
