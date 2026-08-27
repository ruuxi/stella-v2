import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  VOICE_PROVIDER_TRANSPORT_TIMEOUT_MS,
  type VoiceProviderDispatchKind,
  voiceProviderDispatchId,
} from "../voice_dispatch";

const DISPATCH_POLL_MS = 1_000;

export type VoiceProviderDispatchGuard = {
  dispatchId: string;
  attemptId: string;
  providerDeadlineAt: number;
  leaseExpiresAt: number;
  signal: AbortSignal;
  checkAllowed: () => Promise<boolean>;
  release: (options: {
    outcome: "settled" | "ambiguous";
    abort?: boolean;
  }) => Promise<void>;
};

/**
 * Reserve one exact realtime-voice provider attempt. Every acquisition gets a
 * fresh attempt id, while the stable dispatch id serializes retries for the
 * same session/operation. The transport AbortSignal expires strictly before
 * the durable lease; cancellation or an ambiguous network outcome leaves
 * durable debt until the later crash-safety deadline.
 */
export const acquireVoiceProviderDispatchGuard = async (
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    ownerId: string;
    ownerGeneration: string;
    stellaSessionId: string;
    kind: VoiceProviderDispatchKind;
    /** Pre-issued usage tuple for managed OpenAI's two-step SDP flow. */
    attemptId?: string;
  },
): Promise<VoiceProviderDispatchGuard | null> => {
  const dispatchId = voiceProviderDispatchId(args.kind, args.stellaSessionId);
  const attemptId = args.attemptId ?? crypto.randomUUID();
  const reserved: {
    acquired: boolean;
    providerDeadlineAt: number;
    leaseExpiresAt: number;
  } = await ctx.runMutation(
    internal.voice_dispatch.reserveVoiceProviderDispatchInternal,
    {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      stellaSessionId: args.stellaSessionId,
      kind: args.kind,
      dispatchId,
      attemptId,
      now: Date.now(),
    },
  );
  if (!reserved.acquired) return null;
  if (
    reserved.providerDeadlineAt >= reserved.leaseExpiresAt ||
    reserved.providerDeadlineAt - Date.now() >
      VOICE_PROVIDER_TRANSPORT_TIMEOUT_MS
  ) {
    await ctx
      .runMutation(
        internal.voice_dispatch.abandonVoiceProviderDispatchInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          dispatchId,
          attemptId,
          now: Date.now(),
        },
      )
      .catch(() => false);
    throw new Error("Invalid realtime voice provider dispatch deadline.");
  }

  const controller = new AbortController();
  let released = false;
  let wakeMonitor: (() => void) | undefined;
  const providerTimer = setTimeout(
    () =>
      controller.abort(new Error("Realtime voice provider request expired.")),
    Math.max(1, reserved.providerDeadlineAt - Date.now()),
  );
  const monitor = (async () => {
    while (!released && !controller.signal.aborted) {
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_POLL_MS)),
        new Promise<void>((resolve) => {
          wakeMonitor = resolve;
        }),
      ]);
      wakeMonitor = undefined;
      if (released || controller.signal.aborted) break;
      const pulse: { allowed: boolean } | null = await ctx
        .runMutation(
          internal.voice_dispatch.heartbeatVoiceProviderDispatchInternal,
          {
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            dispatchId,
            attemptId,
            now: Date.now(),
          },
        )
        .catch(() => null);
      if (!pulse?.allowed) {
        controller.abort(
          new Error("Realtime voice provider dispatch was canceled."),
        );
        break;
      }
    }
  })();

  return {
    dispatchId,
    attemptId,
    providerDeadlineAt: reserved.providerDeadlineAt,
    leaseExpiresAt: reserved.leaseExpiresAt,
    signal: controller.signal,
    checkAllowed: async () => {
      if (released || controller.signal.aborted) return false;
      const pulse: { allowed: boolean } | null = await ctx
        .runMutation(
          internal.voice_dispatch.heartbeatVoiceProviderDispatchInternal,
          {
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            dispatchId,
            attemptId,
            now: Date.now(),
          },
        )
        .catch(() => null);
      if (!pulse?.allowed && !controller.signal.aborted) {
        controller.abort(
          new Error("Realtime voice provider dispatch was canceled."),
        );
      }
      return pulse?.allowed === true;
    },
    release: async (options) => {
      if (released) return;
      released = true;
      clearTimeout(providerTimer);
      if (options.abort && !controller.signal.aborted) {
        controller.abort(new Error("Realtime voice provider dispatch ended."));
      }
      wakeMonitor?.();
      await monitor.catch(() => undefined);
      if (options.outcome === "settled") {
        await ctx
          .runMutation(
            internal.voice_dispatch.settleVoiceProviderDispatchInternal,
            {
              ownerId: args.ownerId,
              ownerGeneration: args.ownerGeneration,
              dispatchId,
              attemptId,
            },
          )
          .catch(() => false);
        return;
      }
      await ctx
        .runMutation(
          internal.voice_dispatch.abandonVoiceProviderDispatchInternal,
          {
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            dispatchId,
            attemptId,
            now: Date.now(),
          },
        )
        .catch(() => false);
    },
  };
};
