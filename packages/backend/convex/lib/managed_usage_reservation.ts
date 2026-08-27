import type { MutationCtx } from "../_generated/server";

/**
 * OCC-serialized aggregate shared by every managed-usage reservation source.
 * The caller must already hold exact owner/generation authority and update its
 * source row in the same mutation transaction.
 */
export const adjustManagedUsageReservationAuthorized = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    deltaMicroCents: number;
    now: number;
  },
): Promise<number> => {
  if (!Number.isFinite(args.deltaMicroCents)) {
    throw new Error("Managed usage reservation delta must be finite.");
  }
  const deltaMicroCents = Math.trunc(args.deltaMicroCents);
  const usage = await ctx.db
    .query("billing_usage_windows")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
    .unique();
  if (!usage) {
    throw new Error("Managed usage reservation has no billing window.");
  }
  const current = activeManagedUsageReservationMicroCents(usage);
  const next = current + deltaMicroCents;
  if (next < 0 || !Number.isSafeInteger(next)) {
    throw new Error("Managed usage reservation accounting is inconsistent.");
  }
  if (next !== current) {
    await ctx.db.patch(usage._id, {
      activeReservedMicroCents: next,
      updatedAt: args.now,
    });
  }
  return next;
};

export const activeManagedUsageReservationMicroCents = (usage: {
  activeReservedMicroCents?: number;
}): number => {
  const value = usage.activeReservedMicroCents;
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Managed usage reservation aggregate is invalid.");
  }
  const normalized = Math.floor(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new Error("Managed usage reservation aggregate is outside the safe range.");
  }
  return normalized;
};
