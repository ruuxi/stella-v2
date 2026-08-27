import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { MediaProviderDispatchKind } from "../media_jobs";
import { createManagedUsageDispatchGuard } from "./managed_billing";
import { runManagedDispatchAttempt } from "../runtime_ai/managed";

type MediaDispatchCtx = Pick<ActionCtx, "runMutation">;

/**
 * Composes the generic managed-billing physical-attempt lease with media's
 * longer exact owner/job authority. The generic lease supplies a live
 * AbortSignal and transport deadline; the media lease survives the response
 * until the caller durably publishes its locator/output or explicitly marks
 * an ambiguous outcome.
 */
export const createMediaProviderDispatch = (
  ctx: MediaDispatchCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    kind: MediaProviderDispatchKind;
    jobId?: string;
    attemptId?: string;
    /** claimImageSubmission already reserved the exact row transactionally. */
    exactAttemptPreReserved?: boolean;
  },
) => {
  const attemptId = args.attemptId ?? crypto.randomUUID();
  let exactReserved = args.exactAttemptPreReserved === true;
  let providerMayHaveStarted = false;

  const dispatchGuard = createManagedUsageDispatchGuard(ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    beforeDispatch: async () => {
      if (!exactReserved) {
        const reservation = await ctx.runMutation(
          internal.media_jobs.reserveMediaProviderDispatchInternal,
          {
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            dispatchId: args.dispatchId,
            attemptId,
            kind: args.kind,
            ...(args.jobId ? { jobId: args.jobId } : {}),
            now: Date.now(),
          },
        );
        if (!reservation.acquired) {
          throw new Error(
            `Media provider dispatch is ${reservation.status}; provider I/O was not started.`,
          );
        }
        exactReserved = true;
      }

      const pulse = await ctx.runMutation(
        internal.media_jobs.heartbeatMediaProviderDispatchInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          dispatchId: args.dispatchId,
          attemptId,
          now: Date.now(),
        },
      );
      if (!pulse.allowed) {
        throw new Error(
          "Media provider dispatch lost exact owner-generation authority.",
        );
      }
    },
  });

  return {
    attemptId,
    dispatchId: args.dispatchId,
    run: async <T>(providerCall: (signal: AbortSignal) => Promise<T>) =>
      await runManagedDispatchAttempt({
        dispatchGuard,
        run: async (signal) => {
          providerMayHaveStarted = true;
          return await providerCall(signal);
        },
      }),
    providerMayHaveStarted: () => providerMayHaveStarted,
    settle: async () => {
      if (!exactReserved) return false;
      return await ctx.runMutation(
        internal.media_jobs.settleMediaProviderDispatchInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          dispatchId: args.dispatchId,
          attemptId,
          providerStarted: providerMayHaveStarted,
        },
      );
    },
    abandon: async () => {
      if (!exactReserved) return false;
      return await ctx.runMutation(
        internal.media_jobs.abandonMediaProviderDispatchInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          dispatchId: args.dispatchId,
          attemptId,
          now: Date.now(),
        },
      );
    },
  };
};
