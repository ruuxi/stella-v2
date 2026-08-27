import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type {
  TtsDispatchUsageEnvelope,
  TtsDispatchUsageSettlement,
  TtsProviderDispatchOutcome,
} from "../tts_dispatch";

export type TtsProviderDispatchKind =
  | "buffered"
  | "desktop_stream"
  | "hls"
  | "oneshot_inworld"
  | "oneshot_openai";

const DISPATCH_POLL_MS = 2_000;

export type TtsProviderDispatchGuard = {
  dispatchId: string;
  attemptId: string;
  leaseId: string;
  hardExpiresAt: number;
  quiescentAfterAt: number;
  signal: AbortSignal;
  markMayHaveDispatched: () => Promise<void>;
  checkAllowed: () => Promise<boolean>;
  race: <T>(
    operation: Promise<T>,
    onAbort?: (reason: unknown) => void | Promise<void>,
  ) => Promise<T>;
  release: (options: {
    outcome: TtsProviderDispatchOutcome;
    settlement?: TtsDispatchUsageSettlement;
    abort?: boolean;
  }) => Promise<void>;
};

/**
 * Reserve one exact provider attempt and keep it cooperatively cancelable.
 * Purge flips the durable row to `cancel_requested`; this monitor observes it,
 * aborts the provider request, and releases the exact row before purge may
 * report quiescence. The independent hard timer is the crash safety bound.
 */
export const acquireTtsProviderDispatchGuard = async (
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    kind: TtsProviderDispatchKind;
    usage: TtsDispatchUsageEnvelope;
  },
): Promise<TtsProviderDispatchGuard | null> => {
  const attemptId = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const reserved: {
    acquired: boolean;
    hardExpiresAt: number;
    quiescentAfterAt: number;
  } = await ctx.runMutation(
    internal.tts_dispatch.reserveTtsProviderDispatchInternal,
    {
      ...args,
      attemptId,
      leaseId,
      now: Date.now(),
    },
  );
  if (!reserved.acquired) return null;

  const controller = new AbortController();
  let released = false;
  let closing = false;
  let markedMayHaveDispatched = false;
  let releasePromise: Promise<void> | undefined;
  let releaseOutcome: TtsProviderDispatchOutcome | undefined;
  let wakeMonitor: (() => void) | undefined;
  const hardTimer = setTimeout(
    () => controller.abort(new Error("TTS provider dispatch expired.")),
    Math.max(1, reserved.hardExpiresAt - Date.now()),
  );
  const monitor = (async () => {
    while (!released && !closing && !controller.signal.aborted) {
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_POLL_MS)),
        new Promise<void>((resolve) => {
          wakeMonitor = resolve;
        }),
      ]);
      wakeMonitor = undefined;
      if (released || closing || controller.signal.aborted) break;
      const pulse: { allowed: boolean } | null = await ctx
        .runMutation(
          internal.tts_dispatch.heartbeatTtsProviderDispatchInternal,
          {
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            dispatchId: args.dispatchId,
            attemptId,
            leaseId,
            now: Date.now(),
          },
        )
        .catch(() => null);
      if (!pulse?.allowed) {
        controller.abort(new Error("TTS provider dispatch was canceled."));
        break;
      }
    }
  })();

  return {
    dispatchId: args.dispatchId,
    attemptId,
    leaseId,
    hardExpiresAt: reserved.hardExpiresAt,
    quiescentAfterAt: reserved.quiescentAfterAt,
    signal: controller.signal,
    markMayHaveDispatched: async () => {
      if (released || closing || controller.signal.aborted) {
        throw new Error("TTS provider dispatch is no longer active.");
      }
      if (markedMayHaveDispatched) return;
      const marked = await ctx.runMutation(
        internal.tts_dispatch.markTtsProviderDispatchMayHaveStartedInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          dispatchId: args.dispatchId,
          attemptId,
          leaseId,
          now: Date.now(),
        },
      );
      if (!marked) {
        throw new Error("TTS provider dispatch marker disappeared.");
      }
      markedMayHaveDispatched = true;
    },
    checkAllowed: async () => {
      if (released || closing || controller.signal.aborted) return false;
      const pulse: { allowed: boolean } | null = await ctx
        .runMutation(
          internal.tts_dispatch.heartbeatTtsProviderDispatchInternal,
          {
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            dispatchId: args.dispatchId,
            attemptId,
            leaseId,
            now: Date.now(),
          },
        )
        .catch(() => null);
      if (!pulse?.allowed && !controller.signal.aborted) {
        controller.abort(new Error("TTS provider dispatch was canceled."));
      }
      return pulse?.allowed === true;
    },
    race: async <T>(
      operation: Promise<T>,
      onAbort?: (reason: unknown) => void | Promise<void>,
    ): Promise<T> => {
      if (closing || controller.signal.aborted) {
        const reason =
          controller.signal.reason ??
          new Error("TTS provider dispatch was canceled.");
        void Promise.resolve(onAbort?.(reason)).catch(() => undefined);
        throw reason;
      }
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          const reason =
            controller.signal.reason ??
            new Error("TTS provider dispatch was canceled.");
          reject(reason);
          // Reject the authority race before canceling the transport. Some
          // readers resolve a pending read as clean EOF when cancel() runs;
          // giving the abort rejection precedence prevents that synthetic EOF
          // from being misclassified as settled provider completion.
          void Promise.resolve(onAbort?.(reason)).catch(() => undefined);
        };
        controller.signal.addEventListener("abort", abortListener, {
          once: true,
        });
      });
      try {
        return await Promise.race([operation, aborted]);
      } finally {
        if (abortListener) {
          controller.signal.removeEventListener("abort", abortListener);
        }
      }
    },
    release: async (options) => {
      if (released) return;
      if (releaseOutcome && releaseOutcome !== options.outcome) {
        throw new Error("A TTS dispatch cannot change terminal outcome.");
      }
      if (releasePromise) return await releasePromise;
      releaseOutcome = options.outcome;
      const currentRelease = (async () => {
        if (options.outcome === "not_dispatched" && markedMayHaveDispatched) {
          throw new Error("A marked TTS dispatch cannot be not-dispatched.");
        }
        if (options.outcome !== "not_dispatched" && !markedMayHaveDispatched) {
          throw new Error("TTS provider work was never marked dispatched.");
        }
        closing = true;
        clearTimeout(hardTimer);
        if (
          (options.abort || options.outcome === "may_have_dispatched") &&
          !controller.signal.aborted
        ) {
          controller.abort(new Error("TTS provider dispatch ended."));
        }
        wakeMonitor?.();
        await monitor.catch(() => undefined);

        const now = Date.now();
        const closed =
          options.outcome === "may_have_dispatched"
            ? await ctx.runMutation(
                internal.tts_dispatch.abandonTtsProviderDispatchInternal,
                {
                  ownerId: args.ownerId,
                  ownerGeneration: args.ownerGeneration,
                  dispatchId: args.dispatchId,
                  attemptId,
                  leaseId,
                  ...(options.settlement
                    ? { settlement: options.settlement }
                    : {}),
                  now,
                },
              )
            : await ctx.runMutation(
                internal.tts_dispatch.settleTtsProviderDispatchInternal,
                {
                  ownerId: args.ownerId,
                  ownerGeneration: args.ownerGeneration,
                  dispatchId: args.dispatchId,
                  attemptId,
                  leaseId,
                  outcome: options.outcome,
                  ...(options.settlement
                    ? { settlement: options.settlement }
                    : {}),
                  now,
                },
              );
        if (!closed && now < reserved.quiescentAfterAt) {
          throw new Error("TTS provider dispatch locator disappeared early.");
        }
        released = true;
      })();
      releasePromise = currentRelease;
      try {
        await currentRelease;
      } finally {
        if (releasePromise === currentRelease) releasePromise = undefined;
      }
    },
  };
};
